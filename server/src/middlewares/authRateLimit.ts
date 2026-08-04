import { createHmac } from 'crypto';
import { FastifyReply, FastifyRequest } from 'fastify';
import { RECOVERY_COOKIE, REFRESH_COOKIE } from '../utils/authCookies';
import { getRequestClientIp } from '../utils/requestIp';

type RateLimitBucket = {
    hits: number[];
    blockedUntil?: number;
};

export type AuthRateLimitPolicy = {
    maxAttempts: number;
    windowMs: number;
    blockMs: number;
    profile: 'default' | 'refresh-ip' | 'refresh-credential';
};

type ResolveAuthRateLimitPolicyInput = {
    route: string;
    tier?: 'ip' | 'credential';
};

const WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 10;
const REFRESH_IP_MAX_ATTEMPTS = 300;
export const REFRESH_CREDENTIAL_MAX_ATTEMPTS = 30;
const BLOCK_MS = 15 * 60 * 1000;
const CREDENTIAL_DIGEST_LENGTH = 32;

const buckets = new Map<string, RateLimitBucket>();

const getClientIp = (request: FastifyRequest) => getRequestClientIp(request);

const getBodyEmail = (request: FastifyRequest) => {
    const body = request.body as { email?: unknown } | undefined;
    return typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
};

const normalizeRoutePath = (route: string) => {
    const withoutQuery = (route || '').split('?')[0];
    if (withoutQuery.length > 1 && withoutQuery.endsWith('/')) {
        return withoutQuery.slice(0, -1);
    }
    return withoutQuery;
};

/** Exact auth refresh path only (optional /api/v2 prefix, optional trailing slash/query). */
export const isAuthRefreshRoute = (route: string) => {
    const path = normalizeRoutePath(route);
    return path === '/auth/refresh' || path === '/api/v2/auth/refresh';
};

/** Pure policy resolver. Refresh always uses the exact two production tiers. */
export const resolveAuthRateLimitPolicy = (
    input: ResolveAuthRateLimitPolicyInput
): AuthRateLimitPolicy => {
    if (isAuthRefreshRoute(input.route)) {
        if (input.tier === 'credential') {
            return {
                maxAttempts: REFRESH_CREDENTIAL_MAX_ATTEMPTS,
                windowMs: WINDOW_MS,
                blockMs: BLOCK_MS,
                profile: 'refresh-credential',
            };
        }
        return {
            maxAttempts: REFRESH_IP_MAX_ATTEMPTS,
            windowMs: WINDOW_MS,
            blockMs: BLOCK_MS,
            profile: 'refresh-ip',
        };
    }

    return {
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
        windowMs: WINDOW_MS,
        blockMs: BLOCK_MS,
        profile: 'default',
    };
};

const pruneBucket = (bucket: RateLimitBucket, now: number, windowMs: number) => {
    bucket.hits = bucket.hits.filter((timestamp) => now - timestamp < windowMs);

    if (bucket.blockedUntil && bucket.blockedUntil <= now) {
        delete bucket.blockedUntil;
    }
};

const hitBucket = (key: string, now: number, policy: AuthRateLimitPolicy) => {
    const bucket = buckets.get(key) || { hits: [] };

    pruneBucket(bucket, now, policy.windowMs);

    if (bucket.blockedUntil && bucket.blockedUntil > now) {
        buckets.set(key, bucket);
        return bucket.blockedUntil;
    }

    bucket.hits.push(now);

    if (bucket.hits.length > policy.maxAttempts) {
        bucket.blockedUntil = now + policy.blockMs;
        buckets.set(key, bucket);
        return bucket.blockedUntil;
    }

    buckets.set(key, bucket);
    return null;
};

const refreshCredentialDigest = (request: FastifyRequest) => {
    const refreshToken = request.cookies?.[REFRESH_COOKIE];
    const recoveryToken = request.cookies?.[RECOVERY_COOKIE];
    if (!refreshToken || !recoveryToken) return null;

    const secret = process.env.API_V2_PROXY_SECRET?.trim();
    if (!secret || secret.length < 32) {
        throw new Error('API_V2_PROXY_SECRET must be configured with at least 32 characters');
    }
    return createHmac('sha256', secret)
        .update(refreshToken)
        .update('\0')
        .update(recoveryToken)
        .digest('hex')
        .slice(0, CREDENTIAL_DIGEST_LENGTH);
};

/** Test-only / deterministic harness hooks. */
export const resetAuthRateLimitBuckets = () => {
    buckets.clear();
};

export const getAuthRateLimitBucketCount = () => buckets.size;

export const authRateLimit = async (request: FastifyRequest, reply: FastifyReply) => {
    const route = normalizeRoutePath(request.routeOptions.url || request.url);
    const ip = getClientIp(request);
    const now = Date.now();
    let keyedPolicies: Array<{ key: string; policy: AuthRateLimitPolicy }>;

    if (isAuthRefreshRoute(route)) {
        const digest = refreshCredentialDigest(request);
        if (!digest) {
            // Refresh route admission owns the typed 401 before this middleware. Fail closed if
            // another caller accidentally invokes the limiter without an admitted credential.
            return;
        }
        keyedPolicies = [
            { key: `${route}:${ip}:global`, policy: resolveAuthRateLimitPolicy({ route, tier: 'ip' }) },
            { key: `${route}:credential:${digest}`, policy: resolveAuthRateLimitPolicy({ route, tier: 'credential' }) },
        ];
    } else {
        const email = getBodyEmail(request);
        const policy = resolveAuthRateLimitPolicy({ route });
        keyedPolicies = [
            { key: `${route}:${ip}:global`, policy },
            { key: `${route}:${ip}:${email || 'anonymous'}`, policy },
        ];
    }

    for (const { key, policy } of keyedPolicies) {
        const blockedUntil = hitBucket(key, now, policy);
        if (blockedUntil && blockedUntil > now) {
            const retryAfterSeconds = Math.ceil((blockedUntil - now) / 1000);
            reply.header('Retry-After', String(retryAfterSeconds));
            return reply.status(429).send({
                message: 'Terlalu banyak percobaan. Coba lagi beberapa menit lagi.'
            });
        }
    }
};
