import { randomBytes } from 'crypto';
import { execRedis, RedisClientError, redisNamespace, type RedisReply } from './redisClient';

/**
 * Shared Redis-backed sliding-window rate-limit evaluation used by every gateway
 * limiter middleware. One Lua script performs the whole decision atomically
 * (block check, window pruning, warm-up policy, hit record and block write), so
 * two gateway instances sharing one Redis see exactly one shared counter.
 *
 * Key layout (all under the environment namespace from redisClient):
 *   {ns}:rl:hits:{bucket}   sorted set of hit timestamps (sliding window)
 *   {ns}:rl:block:{bucket}  absolute unblock timestamp in ms
 *   {ns}:rl:warmup          absolute timestamp until which tightened thresholds apply
 */

export type RateLimitOutcome =
    | { blocked: false }
    | { blocked: true; retryAfterSeconds: number };

export type RedisRateLimitInput = {
    bucket: string;
    windowMs: number;
    max: number;
    blockMs: number;
};

/**
 * Startup-loss warm-up policy: while the warm-up marker set by the Redis client
 * (after a detected Redis restart or flush) is live, each bucket allows only half
 * of its normal burst, so state that was wiped mid-block cannot be replayed at
 * full threshold until every pre-loss TTL has elapsed.
 */
const warmupAdjustedMax = (max: number): number => Math.max(1, Math.floor(max / 2));

const RATE_LIMIT_SCRIPT = `
local now = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local normal_limit = tonumber(ARGV[3])
local warmup_limit = tonumber(ARGV[4])
local block_ms = tonumber(ARGV[5])

local blocked_until = redis.call('GET', KEYS[2])
if blocked_until and tonumber(blocked_until) > now then
    return blocked_until
end

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window_ms)
local hits = redis.call('ZCARD', KEYS[1])

local limit = normal_limit
local warmup_until = redis.call('GET', KEYS[3])
if warmup_until and tonumber(warmup_until) > now then
    limit = warmup_limit
end

if hits >= limit then
    local block_until = now + block_ms
    redis.call('SET', KEYS[2], tostring(block_until), 'PX', block_ms)
    redis.call('PEXPIRE', KEYS[1], block_ms)
    return block_until
end

redis.call('ZADD', KEYS[1], now, ARGV[6])
redis.call('PEXPIRE', KEYS[1], window_ms)
return 0
`;

export const hitRedisRateLimit = async (input: RedisRateLimitInput): Promise<RateLimitOutcome> => {
    const namespace = redisNamespace();
    const now = Date.now();
    const reply = await execRedis([
        'EVAL',
        RATE_LIMIT_SCRIPT,
        '3',
        `${namespace}:rl:hits:${input.bucket}`,
        `${namespace}:rl:block:${input.bucket}`,
        `${namespace}:rl:warmup`,
        String(now),
        String(input.windowMs),
        String(input.max),
        String(warmupAdjustedMax(input.max)),
        String(input.blockMs),
        `${now}:${randomBytes(8).toString('hex')}`
    ]);

    const blockedUntil = typeof reply === 'number' ? reply : Number.parseInt(String(reply ?? ''), 10);
    if (Number.isFinite(blockedUntil) && blockedUntil > now) {
        return { blocked: true, retryAfterSeconds: Math.ceil((blockedUntil - now) / 1000) };
    }
    return { blocked: false };
};

const parseScanReply = (reply: RedisReply): { cursor: string; keys: string[] } => {
    if (Array.isArray(reply) && typeof reply[0] === 'string' && Array.isArray(reply[1])) {
        return {
            cursor: reply[0],
            keys: reply[1].filter((key): key is string => typeof key === 'string')
        };
    }
    throw new RedisClientError('Unexpected SCAN reply shape', 'PROTOCOL');
};

const scanRateLimitBatches = async (): Promise<string[][]> => {
    const namespace = redisNamespace();
    const pattern = `${namespace}:rl:*`;
    const batches: string[][] = [];
    let cursor = '0';
    let scans = 0;

    do {
        const scanned = parseScanReply(await execRedis(['SCAN', cursor, 'MATCH', pattern, 'COUNT', '200']));
        cursor = scanned.cursor;
        if (scanned.keys.length > 0) {
            batches.push(scanned.keys);
        }
        scans += 1;
    } while (cursor !== '0' && scans < 10_000);

    return batches;
};

/** Deterministic harness hook: removes this namespace's gateway rate-limit state. */
export const resetRedisRateLimits = async (): Promise<number> => {
    const batches = await scanRateLimitBatches();
    let removed = 0;
    for (const keys of batches) {
        const unlinked = await execRedis(['UNLINK', ...keys]);
        removed += typeof unlinked === 'number' ? unlinked : 0;
    }
    return removed;
};

/** Deterministic harness hook: counts live rate-limit keys for this namespace. */
export const countRedisRateLimitBuckets = async (): Promise<number> => {
    const batches = await scanRateLimitBatches();
    return batches.reduce((total, keys) => total + keys.length, 0);
};
