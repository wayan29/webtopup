import { FastifyReply, FastifyRequest } from 'fastify';
import { getRequestClientIp } from '../utils/requestIp';

type RateLimitBucket = {
    hits: number[];
    blockedUntil?: number;
};

type PublicRateLimitOptions = {
    name: string;
    windowMs: number;
    max: number;
    blockMs?: number;
    keyParts?: Array<(request: FastifyRequest) => string | undefined>;
};

const buckets = new Map<string, RateLimitBucket>();

const pruneBucket = (bucket: RateLimitBucket, now: number, windowMs: number) => {
    bucket.hits = bucket.hits.filter((timestamp) => now - timestamp < windowMs);

    if (bucket.blockedUntil && bucket.blockedUntil <= now) {
        delete bucket.blockedUntil;
    }
};

const hitBucket = (key: string, now: number, options: PublicRateLimitOptions) => {
    const bucket = buckets.get(key) || { hits: [] };

    pruneBucket(bucket, now, options.windowMs);

    if (bucket.blockedUntil && bucket.blockedUntil > now) {
        buckets.set(key, bucket);
        return bucket.blockedUntil;
    }

    bucket.hits.push(now);

    if (bucket.hits.length > options.max) {
        bucket.blockedUntil = now + (options.blockMs ?? options.windowMs);
        buckets.set(key, bucket);
        return bucket.blockedUntil;
    }

    buckets.set(key, bucket);
    return null;
};

const bodyValue = (request: FastifyRequest, field: string) => {
    const body = request.body as Record<string, unknown> | undefined;
    const value = body?.[field];
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
};

const routeKey = (request: FastifyRequest) => request.routerPath || request.url.split('?')[0];

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

    const now = Date.now();

    for (const key of keys) {
        const blockedUntil = hitBucket(key, now, options);
        if (blockedUntil && blockedUntil > now) {
            const retryAfterSeconds = Math.ceil((blockedUntil - now) / 1000);
            reply.header('Retry-After', String(retryAfterSeconds));
            return reply.status(429).send({
                message: 'Terlalu banyak request. Coba lagi beberapa menit lagi.'
            });
        }
    }
};

export const publicValidateRateLimit = createPublicRateLimit({
    name: 'public-validate',
    windowMs: 60 * 1000,
    max: 20,
    blockMs: 5 * 60 * 1000
});

export const publicGameValidateRateLimit = createPublicRateLimit({
    name: 'public-game-validate',
    windowMs: 60 * 1000,
    max: 8,
    blockMs: 10 * 60 * 1000,
    keyParts: [
        (request) => bodyValue(request, 'userId'),
        (request) => bodyValue(request, 'zoneId')
    ]
});

export const guestTransactionRateLimit = createPublicRateLimit({
    name: 'guest-transaction',
    windowMs: 60 * 1000,
    max: 10,
    blockMs: 10 * 60 * 1000
});

export const voucherRedeemRateLimit = createPublicRateLimit({
    name: 'voucher-redeem',
    windowMs: 60 * 1000,
    max: 8,
    blockMs: 10 * 60 * 1000
});

export const webhookRateLimit = createPublicRateLimit({
    name: 'vendor-webhook',
    windowMs: 60 * 1000,
    max: 120,
    blockMs: 5 * 60 * 1000
});
