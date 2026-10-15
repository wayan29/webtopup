import { createHmac } from 'crypto';
import { FastifyReply, FastifyRequest } from 'fastify';
import { RECOVERY_COOKIE, REFRESH_COOKIE } from '../utils/authCookies';
import { getRequestClientIp } from '../utils/requestIp';
import { countRedisRateLimitBuckets, hitRedisRateLimit, resetRedisRateLimits } from '../utils/redisRateLimit';

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

const RATE_LIMIT_BLOCKED_MESSAGE = 'Terlalu banyak percobaan. Coba lagi beberapa menit lagi.';
const RATE_LIMIT_UNAVAILABLE_MESSAGE = 'Layanan autentikasi sedang tidak tersedia. Coba lagi beberapa saat lagi.';

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
                profile: 'refresh-credential'
            };
        }
        return {
            maxAttempts: REFRESH_IP_MAX_ATTEMPTS,
            windowMs: WINDOW_MS,
            blockMs: BLOCK_MS,
            profile: 'refresh-ip'
        };
    }

    return {
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
        windowMs: WINDOW_MS,
        blockMs: BLOCK_MS,
        profile: 'default'
    };
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

/**
 * Deterministic harness hooks backed by the shared Redis rate-limit namespace.
 * Resetting also clears the active warm-up marker.
 */
export const resetAuthRateLimitBuckets = resetRedisRateLimits;

export const getAuthRateLimitBucketCount = countRedisRateLimitBuckets;

export const authRateLimit = async (request: FastifyRequest, reply: FastifyReply) => {
    const route = normalizeRoutePath(request.routeOptions.url || request.url);
    const ip = getClientIp(request);
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

    try {
        for (const { key, policy } of keyedPolicies) {
            const outcome = await hitRedisRateLimit({
                bucket: key,
                windowMs: policy.windowMs,
                max: policy.maxAttempts,
                blockMs: policy.blockMs
            });
            if (outcome.blocked) {
                reply.header('Retry-After', String(outcome.retryAfterSeconds));
                return reply.status(429).send({ message: RATE_LIMIT_BLOCKED_MESSAGE });
            }
        }
    } catch (error) {
        // Fail closed: login/OTP/refresh admission must never run unthrottled just because
        // Redis is unreachable; clients receive a bounded 503 instead of an open bucket.
        request.log.error({ err: error }, 'auth rate limiter unavailable; failing closed');
        return reply.status(503).send({ message: RATE_LIMIT_UNAVAILABLE_MESSAGE });
    }
};
