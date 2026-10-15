import { FastifyReply, FastifyRequest } from 'fastify';
import { getRequestClientIp } from '../utils/requestIp';
import { hitRedisRateLimit, type RateLimitOutcome } from '../utils/redisRateLimit';

/**
 * Redis-backed public rate-limit factory. Thresholds, key derivation
 * (route + IP + body identity parts) and the 429/Retry-After contract match the
 * previous per-process limiter, but the counters are shared by every gateway
 * instance through the atomic Lua evaluation in utils/redisRateLimit.
 *
 * `failureMode` selects the outage policy:
 * - 'closed': Redis unavailability answers 503. Used for buckets that guard
 *   credential or financial mutations, which must not run unthrottled.
 * - 'open': Redis unavailability only loses cross-instance throttling while the
 *   endpoint stays available. Used for read-only validation and for provider
 *   webhooks, which providers redeliver and the reconciler applies idempotently.
 */

type PublicRateLimitOptions = {
    name: string;
    windowMs: number;
    max: number;
    blockMs?: number;
    keyParts?: Array<(request: FastifyRequest) => string | undefined>;
    failureMode?: 'open' | 'closed';
};

const RATE_LIMIT_BLOCKED_MESSAGE = 'Terlalu banyak request. Coba lagi beberapa menit lagi.';
const RATE_LIMIT_UNAVAILABLE_MESSAGE = 'Layanan sedang tidak tersedia. Coba lagi beberapa saat lagi.';

const bodyValue = (request: FastifyRequest, field: string) => {
    const body = request.body as Record<string, unknown> | undefined;
    const value = body?.[field];
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
};

const routeKey = (request: FastifyRequest) => request.routeOptions.url || request.url.split('?')[0];

export const createPublicRateLimit = (options: PublicRateLimitOptions) => async (request: FastifyRequest, reply: FastifyReply) => {
    const ip = getRequestClientIp(request);
    const route = routeKey(request);
    const keys = [`${options.name}:${route}:${ip}`];
    const whatsapp = bodyValue(request, 'whatsapp');
    const customerNo = bodyValue(request, 'customerNo');
    const userId = bodyValue(request, 'userId');

    if (whatsapp) {
        keys.push(`${options.name}:whatsapp:${whatsapp}`);
    }

    if (customerNo) {
        keys.push(`${options.name}:customer:${customerNo}`);
    }

    if (userId) {
        keys.push(`${options.name}:user:${userId}`);
    }

    for (const getKeyPart of options.keyParts || []) {
        const keyPart = getKeyPart(request)?.trim();
        if (keyPart) {
            keys.push(`${options.name}:custom:${keyPart}`);
        }
    }

    for (const key of keys) {
        let outcome: RateLimitOutcome;
        try {
            outcome = await hitRedisRateLimit({
                bucket: key,
                windowMs: options.windowMs,
                max: options.max,
                blockMs: options.blockMs ?? options.windowMs
            });
        } catch (error) {
            if (options.failureMode === 'closed') {
                request.log.error({ err: error, limiter: options.name }, 'Redis rate limiter unavailable; failing closed');
                return reply.status(503).send({ message: RATE_LIMIT_UNAVAILABLE_MESSAGE });
            }
            request.log.warn({ err: error, limiter: options.name }, 'Redis rate limiter unavailable; failing open');
            return;
        }

        if (outcome.blocked) {
            reply.header('Retry-After', String(outcome.retryAfterSeconds));
            return reply.status(429).send({ message: RATE_LIMIT_BLOCKED_MESSAGE });
        }
    }
};

export const publicValidateRateLimit = createPublicRateLimit({
    name: 'public-validate',
    windowMs: 60 * 1000,
    max: 20,
    blockMs: 5 * 60 * 1000,
    failureMode: 'open'
});

export const publicGameValidateRateLimit = createPublicRateLimit({
    name: 'public-game-validate',
    windowMs: 60 * 1000,
    max: 8,
    blockMs: 10 * 60 * 1000,
    keyParts: [
        (request) => bodyValue(request, 'userId'),
        (request) => bodyValue(request, 'zoneId')
    ],
    failureMode: 'open'
});

export const guestTransactionRateLimit = createPublicRateLimit({
    name: 'guest-transaction',
    windowMs: 60 * 1000,
    max: 10,
    blockMs: 10 * 60 * 1000,
    failureMode: 'closed'
});

export const voucherRedeemRateLimit = createPublicRateLimit({
    name: 'voucher-redeem',
    windowMs: 60 * 1000,
    max: 8,
    blockMs: 10 * 60 * 1000,
    failureMode: 'closed'
});

export const webhookRateLimit = createPublicRateLimit({
    name: 'vendor-webhook',
    windowMs: 60 * 1000,
    max: 120,
    blockMs: 5 * 60 * 1000,
    failureMode: 'open'
});
