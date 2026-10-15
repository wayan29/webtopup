import net from 'net';
import tls from 'tls';
import { URL } from 'url';

/**
 * Bounded native RESP (Redis Serialization Protocol) client for the gateway.
 *
 * The Node gateway deliberately carries no third-party Redis dependency: this module
 * speaks RESP2 directly over `net`/`tls` with a single pipelined connection, an
 * incremental reply parser, per-command bounded timeouts, connect backoff with a
 * fail-fast cooldown, and lazy reconnection. Redis is authoritative for cross-instance
 * gateway state (rate limiting), so callers decide their own fail-open/fail-closed
 * policy based on the `RedisClientError.code` they receive.
 *
 * Environment:
 * - REDIS_URL          redis://[username:password@]host:port/db or rediss:// for TLS. Required.
 * - REDIS_NAMESPACE    Key namespace shared by all gateway Redis keys. Defaults to
 *                      `webtopup-gateway-${NODE_ENV || 'development'}` so distinct
 *                      environments cannot read or evict each other's state.
 * - REDIS_TIMEOUT_MS   Per-command bound (connect + reply), clamped to 250..15000.
 *                      Defaults to 3000ms.
 */

export type RedisReply = string | number | null | RedisReply[];

export type RedisErrorCode = 'UNCONFIGURED' | 'UNAVAILABLE' | 'TIMEOUT' | 'PROTOCOL' | 'COMMAND';

export class RedisClientError extends Error {
    readonly code: RedisErrorCode;

    constructor(message: string, code: RedisErrorCode) {
        super(message);
        this.name = 'RedisClientError';
        this.code = code;
    }
}

type RedisEndpoint = {
    host: string;
    port: number;
    username: string;
    password: string;
    database: number;
    secure: boolean;
};

type PendingCommand = {
    encoded: Buffer;
    sent: boolean;
    settled: boolean;
    critical: boolean;
    settleTimer: NodeJS.Timeout | null;
    resolve: (reply: RedisReply) => void;
    reject: (error: RedisClientError) => void;
};

type ParsedReply = {
    value: RedisReply;
    error: string | null;
    offset: number;
};

const DEFAULT_COMMAND_TIMEOUT_MS = 3000;
const MIN_COMMAND_TIMEOUT_MS = 250;
const MAX_COMMAND_TIMEOUT_MS = 15000;
const RECONNECT_BACKOFF_BASE_MS = 100;
const RECONNECT_BACKOFF_MAX_MS = 5000;

/**
 * Warm-up window applied after detected Redis state loss (server restart or flush).
 * It matches the longest rate-limit block TTL (15 minutes) so every counter that
 * could have existed before the loss has expired by the time full thresholds return.
 */
export const RATE_LIMIT_WARMUP_MS = 15 * 60 * 1000;

export const redisNamespace = (): string => (
    process.env.REDIS_NAMESPACE?.trim()
    || `webtopup-gateway-${process.env.NODE_ENV?.trim() || 'development'}`
);

const commandTimeoutMs = (): number => {
    const raw = Number(process.env.REDIS_TIMEOUT_MS);
    if (!Number.isFinite(raw) || raw <= 0) {
        return DEFAULT_COMMAND_TIMEOUT_MS;
    }
    return Math.min(MAX_COMMAND_TIMEOUT_MS, Math.max(MIN_COMMAND_TIMEOUT_MS, Math.floor(raw)));
};

const parseRedisUrl = (rawUrl: string): RedisEndpoint => {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new RedisClientError('REDIS_URL is not a valid URL', 'UNCONFIGURED');
    }

    if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
        throw new RedisClientError('REDIS_URL must use the redis:// or rediss:// scheme', 'UNCONFIGURED');
    }

    const database = Number.parseInt(parsed.pathname.replace(/^\//, ''), 10);

    return {
        host: parsed.hostname || '127.0.0.1',
        port: parsed.port ? Number.parseInt(parsed.port, 10) : 6379,
        username: decodeURIComponent(parsed.username || ''),
        password: decodeURIComponent(parsed.password || ''),
        database: Number.isFinite(database) && database >= 0 ? database : 0,
        secure: parsed.protocol === 'rediss:'
    };
};

const encodeCommand = (args: Array<string | number>): Buffer => {
    const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`, 'utf8')];
    for (const arg of args) {
        const value = Buffer.from(String(arg), 'utf8');
        parts.push(Buffer.from(`$${value.length}\r\n`, 'utf8'), value, Buffer.from('\r\n', 'utf8'));
    }
    return Buffer.concat(parts);
};

const parseReply = (buffer: Buffer, offset: number): ParsedReply | null => {
    if (offset >= buffer.length) {
        return null;
    }

    const type = String.fromCharCode(buffer[offset]);
    const lineEnd = buffer.indexOf('\r\n', offset);
    if (lineEnd === -1) {
        return null;
    }
    const header = buffer.toString('utf8', offset + 1, lineEnd);

    switch (type) {
        case '+':
            return { value: header, error: null, offset: lineEnd + 2 };
        case '-':
            return { value: null, error: header, offset: lineEnd + 2 };
        case ':': {
            const parsed = Number.parseInt(header, 10);
            if (!Number.isFinite(parsed)) {
                throw new RedisClientError(`Malformed RESP integer reply: ${header}`, 'PROTOCOL');
            }
            return { value: parsed, error: null, offset: lineEnd + 2 };
        }
        case '$': {
            const length = Number.parseInt(header, 10);
            if (!Number.isFinite(length)) {
                throw new RedisClientError(`Malformed RESP bulk header: ${header}`, 'PROTOCOL');
            }
            if (length === -1) {
                return { value: null, error: null, offset: lineEnd + 2 };
            }
            if (length < -1) {
                throw new RedisClientError(`Malformed RESP bulk length: ${header}`, 'PROTOCOL');
            }
            const bodyStart = lineEnd + 2;
            const bodyEnd = bodyStart + length;
            if (buffer.length < bodyEnd + 2) {
                return null;
            }
            if (buffer[bodyEnd] !== 0x0d || buffer[bodyEnd + 1] !== 0x0a) {
                throw new RedisClientError('Malformed RESP bulk terminator', 'PROTOCOL');
            }
            return { value: buffer.toString('utf8', bodyStart, bodyEnd), error: null, offset: bodyEnd + 2 };
        }
        case '*': {
            const count = Number.parseInt(header, 10);
            if (!Number.isFinite(count)) {
                throw new RedisClientError(`Malformed RESP array header: ${header}`, 'PROTOCOL');
            }
            if (count === -1) {
                return { value: null, error: null, offset: lineEnd + 2 };
            }
            let cursor = lineEnd + 2;
            const items: RedisReply[] = [];
            for (let index = 0; index < count; index += 1) {
                const item = parseReply(buffer, cursor);
                if (!item) {
                    return null;
                }
                if (item.error !== null) {
                    throw new RedisClientError(`Error inside RESP array: ${item.error}`, 'PROTOCOL');
                }
                items.push(item.value);
                cursor = item.offset;
            }
            return { value: items, error: null, offset: cursor };
        }
        default:
            throw new RedisClientError(`Unsupported RESP type byte: ${type}`, 'PROTOCOL');
    }
};

class RedisGatewayClient {
    private endpoint: RedisEndpoint | null = null;
    private endpointError: RedisClientError | null = null;
    private warnedUnconfigured = false;
    private socket: net.Socket | null = null;
    private connecting: Promise<void> | null = null;
    private ready: Promise<void> = Promise.resolve();
    private pending: PendingCommand[] = [];
    private receiveBuffer: Buffer = Buffer.alloc(0);
    private consecutiveFailures = 0;
    private retryNotBefore = 0;
    private closed = false;

    constructor() {
        const rawUrl = process.env.REDIS_URL?.trim();
        if (!rawUrl) {
            this.endpointError = new RedisClientError('REDIS_URL is not configured', 'UNCONFIGURED');
            return;
        }
        try {
            this.endpoint = parseRedisUrl(rawUrl);
        } catch (error) {
            this.endpointError = error instanceof RedisClientError
                ? error
                : new RedisClientError('REDIS_URL is not usable', 'UNCONFIGURED');
        }
    }

    get configured(): boolean {
        return this.endpoint !== null;
    }

    public exec = async (args: Array<string | number>): Promise<RedisReply> => {
        const timeoutMs = commandTimeoutMs();

        if (this.closed) {
            throw new RedisClientError('Redis client closed', 'UNAVAILABLE');
        }

        if (!this.endpoint) {
            if (!this.warnedUnconfigured) {
                this.warnedUnconfigured = true;
                console.error(`[redis] ${this.endpointError?.message ?? 'REDIS_URL is not configured'}`);
            }
            throw this.endpointError ?? new RedisClientError('REDIS_URL is not configured', 'UNCONFIGURED');
        }

        if (!this.socket && Date.now() < this.retryNotBefore) {
            throw new RedisClientError('Redis connection is in reconnect cooldown', 'UNAVAILABLE');
        }

        await this.ensureConnected(timeoutMs);
        await this.ready;

        if (!this.socket) {
            throw new RedisClientError('Redis connection dropped before the command was queued', 'UNAVAILABLE');
        }

        return new Promise<RedisReply>((resolve, reject) => {
            const command: PendingCommand = {
                encoded: encodeCommand(args),
                sent: false,
                settled: false,
                critical: false,
                settleTimer: null,
                resolve,
                reject
            };
            command.settleTimer = setTimeout(() => this.expireCommand(command, timeoutMs), timeoutMs);
            this.pending.push(command);
            this.flush();
        });
    };

    public close = (): void => {
        this.closed = true;
        const socket = this.socket;
        this.socket = null;
        if (socket) {
            socket.destroy();
        }
        this.failPending(new RedisClientError('Redis client closed', 'UNAVAILABLE'));
    };

    private ensureConnected = (timeoutMs: number): Promise<void> => {
        if (this.socket) {
            return Promise.resolve();
        }
        if (this.connecting) {
            return this.connecting;
        }
        const attempt = this.connect(timeoutMs);
        this.connecting = attempt;
        const clear = () => {
            if (this.connecting === attempt) {
                this.connecting = null;
            }
        };
        attempt.then(clear, clear);
        return attempt;
    };

    private connect = (timeoutMs: number): Promise<void> => new Promise((resolve, reject) => {
        const endpoint = this.endpoint;
        if (!endpoint) {
            reject(new RedisClientError('REDIS_URL is not configured', 'UNCONFIGURED'));
            return;
        }

        let settled = false;
        let connectTimer: NodeJS.Timeout;
        const socket: net.Socket = endpoint.secure
            ? tls.connect({ host: endpoint.host, port: endpoint.port })
            : net.connect({ host: endpoint.host, port: endpoint.port });

        const failConnect = (error: RedisClientError) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(connectTimer);
            socket.removeAllListeners();
            socket.destroy();
            this.recordFailure();
            reject(error);
        };

        const finishConnect = () => {
            if (settled) {
                return;
            }
            if (this.closed) {
                settled = true;
                clearTimeout(connectTimer);
                socket.removeAllListeners();
                socket.destroy();
                reject(new RedisClientError('Redis client closed during connect', 'UNAVAILABLE'));
                return;
            }
            settled = true;
            clearTimeout(connectTimer);
            socket.removeAllListeners();
            this.socket = socket;
            this.consecutiveFailures = 0;
            this.receiveBuffer = Buffer.alloc(0);
            socket.on('data', this.consume);
            socket.on('drain', this.flush);
            socket.on('error', () => {
                // The close event performs the teardown; errors alone carry no state.
            });
            socket.on('close', () => this.handleDisconnect(socket));
            this.queueHandshake();
            resolve();
        };

        connectTimer = setTimeout(() => {
            failConnect(new RedisClientError(`Redis connect timed out after ${timeoutMs}ms`, 'TIMEOUT'));
        }, timeoutMs);

        socket.once('error', (error) => {
            failConnect(new RedisClientError(`Redis connection error: ${error.message}`, 'UNAVAILABLE'));
        });
        socket.once('close', () => {
            failConnect(new RedisClientError('Redis connection closed before handshake', 'UNAVAILABLE'));
        });

        if (endpoint.secure) {
            (socket as tls.TLSSocket).once('secureConnect', finishConnect);
        } else {
            socket.once('connect', finishConnect);
        }
    });

    private queueHandshake = (): void => {
        const endpoint = this.endpoint;
        if (!endpoint) {
            this.ready = Promise.resolve();
            return;
        }

        const timeoutMs = commandTimeoutMs();
        const handshake: PendingCommand[] = [];
        let remaining = 0;
        let settled = false;
        let resolveReady: () => void = () => undefined;
        let rejectReady: (error: RedisClientError) => void = () => undefined;
        this.ready = new Promise<void>((resolve, reject) => {
            resolveReady = resolve;
            rejectReady = reject;
        });

        const finishReady = (error?: RedisClientError) => {
            if (settled) {
                return;
            }
            settled = true;
            if (error) {
                rejectReady(error);
                return;
            }
            resolveReady();
        };

        const criticalCommand = (args: Array<string | number>): PendingCommand => {
            remaining += 1;
            const command: PendingCommand = {
                encoded: encodeCommand(args),
                sent: false,
                settled: false,
                critical: true,
                settleTimer: null,
                resolve: () => {
                    remaining -= 1;
                    if (remaining === 0) {
                        finishReady();
                    }
                },
                reject: (error) => {
                    console.error(`[redis] handshake rejected: ${error.message}`);
                    finishReady(error instanceof RedisClientError
                        ? error
                        : new RedisClientError('Redis handshake failed', 'COMMAND'));
                }
            };
            command.settleTimer = setTimeout(() => this.expireCommand(command, timeoutMs), timeoutMs);
            return command;
        };

        if (endpoint.password) {
            handshake.push(criticalCommand(
                endpoint.username && endpoint.username !== 'default'
                    ? ['AUTH', endpoint.username, endpoint.password]
                    : ['AUTH', endpoint.password]
            ));
        }
        if (endpoint.database > 0) {
            handshake.push(criticalCommand(['SELECT', String(endpoint.database)]));
        }

        if (handshake.length === 0) {
            finishReady();
        } else {
            this.pending.unshift(...handshake);
        }

        this.flush();
        void this.ready.then(() => this.verifyRedisEpoch(), () => undefined);
    };

    private send = (args: Array<string | number>): Promise<RedisReply> => {
        const timeoutMs = commandTimeoutMs();
        return new Promise<RedisReply>((resolve, reject) => {
            const command: PendingCommand = {
                encoded: encodeCommand(args),
                sent: false,
                settled: false,
                critical: false,
                settleTimer: null,
                resolve,
                reject
            };
            command.settleTimer = setTimeout(() => this.expireCommand(command, timeoutMs), timeoutMs);
            this.pending.push(command);
            this.flush();
        });
    };

    /**
     * Startup-loss warm-up: every fresh connection (process start and every reconnect)
     * compares the Redis server run_id with the last observed one. A changed or missing
     * run_id means Redis restarted or was flushed, so all rate-limit counters and blocks
     * are gone; the warm-up marker then tightens thresholds until every pre-loss TTL
     * would have elapsed.
     */
    private verifyRedisEpoch = async (): Promise<void> => {
        try {
            const info = await this.send(['INFO', 'server']);
            const runId = /^run_id:(\S+)/m.exec(typeof info === 'string' ? info : '')?.[1];
            if (!runId) {
                return;
            }

            const namespace = redisNamespace();
            const runIdKey = `${namespace}:rl:epoch:runid`;
            const stored = await this.send(['GET', runIdKey]);
            if (stored === runId) {
                return;
            }

            const warmupUntil = Date.now() + RATE_LIMIT_WARMUP_MS;
            await this.send(['SET', runIdKey, runId]);
            await this.send(['SET', `${namespace}:rl:warmup`, String(warmupUntil), 'PX', String(RATE_LIMIT_WARMUP_MS)]);
            console.error(
                `[redis] Redis state loss detected (run_id changed); rate-limit warm-up active for ${Math.ceil(RATE_LIMIT_WARMUP_MS / 60000)} minutes`
            );
        } catch (error) {
            console.error(`[redis] epoch verification skipped: ${(error as Error).message}`);
        }
    };

    private consume = (chunk: Buffer): void => {
        this.receiveBuffer = this.receiveBuffer.length
            ? Buffer.concat([this.receiveBuffer, chunk])
            : chunk;

        let offset = 0;
        try {
            for (;;) {
                const parsed = parseReply(this.receiveBuffer, offset);
                if (!parsed) {
                    break;
                }
                offset = parsed.offset;

                const command = this.pending.shift();
                if (!command) {
                    throw new RedisClientError('Redis reply arrived without a pending command', 'PROTOCOL');
                }

                if (parsed.error !== null) {
                    this.settleCommand(command, () => command.reject(
                        new RedisClientError(`Redis command error: ${parsed.error}`, 'COMMAND')
                    ));
                    if (command.critical) {
                        // AUTH/SELECT failed: every queued command would fail the same way.
                        this.teardown(new RedisClientError(`Redis handshake failed: ${parsed.error}`, 'COMMAND'));
                        return;
                    }
                } else {
                    this.settleCommand(command, () => command.resolve(parsed.value));
                }
            }
            this.receiveBuffer = offset > 0 ? this.receiveBuffer.subarray(offset) : this.receiveBuffer;
        } catch (error) {
            const protocolError = error instanceof RedisClientError
                ? error
                : new RedisClientError('Redis protocol parsing failed', 'PROTOCOL');
            console.error(`[redis] ${protocolError.message}`);
            this.teardown(protocolError);
        }
    };

    private settleCommand = (command: PendingCommand, settle: () => void): void => {
        if (command.settled) {
            return;
        }
        command.settled = true;
        if (command.settleTimer !== null) {
            clearTimeout(command.settleTimer);
            command.settleTimer = null;
        }
        settle();
    };

    private expireCommand = (command: PendingCommand, timeoutMs: number): void => {
        if (command.settled) {
            return;
        }
        this.settleCommand(command, () => command.reject(
            new RedisClientError(`Redis command timed out after ${timeoutMs}ms`, 'TIMEOUT')
        ));
        // A timed-out command means reply alignment can no longer be trusted; reset the pipeline.
        this.teardown(new RedisClientError(`Redis command timed out after ${timeoutMs}ms`, 'TIMEOUT'));
    };

    private handleDisconnect = (socket: net.Socket): void => {
        if (this.socket !== socket) {
            return;
        }
        this.socket = null;
        socket.removeAllListeners();
        this.failPending(new RedisClientError('Redis connection lost', 'UNAVAILABLE'));
        this.recordFailure();
    };

    private teardown = (error: RedisClientError): void => {
        const socket = this.socket;
        this.socket = null;
        if (socket) {
            socket.removeAllListeners();
            socket.destroy();
        }
        this.failPending(error);
        this.recordFailure();
    };

    private failPending = (error: RedisClientError): void => {
        const pending = this.pending;
        this.pending = [];
        for (const command of pending) {
            this.settleCommand(command, () => command.reject(error));
        }
    };

    private recordFailure = (): void => {
        this.consecutiveFailures += 1;
        const backoff = Math.min(
            RECONNECT_BACKOFF_MAX_MS,
            RECONNECT_BACKOFF_BASE_MS * 2 ** (this.consecutiveFailures - 1)
        );
        this.retryNotBefore = Date.now() + backoff;
    };

    private flush = (): void => {
        const socket = this.socket;
        if (!socket || socket.destroyed || !socket.writable) {
            return;
        }
        for (let index = 0; index < this.pending.length; index += 1) {
            const command = this.pending[index];
            if (command.sent) {
                continue;
            }
            command.sent = true;
            if (!socket.write(command.encoded)) {
                break;
            }
        }
    };
}

const sharedClient = new RedisGatewayClient();

export const execRedis = (args: Array<string | number>): Promise<RedisReply> => sharedClient.exec(args);

export const isRedisConfigured = (): boolean => sharedClient.configured;

export const closeRedis = (): void => sharedClient.close();
