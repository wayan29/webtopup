import { randomBytes, timingSafeEqual } from 'crypto';
import { FastifyReply, FastifyRequest } from 'fastify';
import { getConfiguredCorsOrigins } from './cors';

export const REFRESH_COOKIE = process.env.NODE_ENV === 'production'
    ? '__Secure-wb_refresh'
    : 'wb_refresh';
export const RECOVERY_COOKIE = process.env.NODE_ENV === 'production'
    ? '__Secure-wb_rotation_recovery'
    : 'wb_rotation_recovery';
export const CSRF_COOKIE = 'wb_csrf';
export const REFRESH_COOKIE_PATH = '/api/v2/auth';
export const RECOVERY_COOKIE_PATH = '/api/v2/auth';
export const CSRF_COOKIE_PATH = '/';
// Credential cookies outlive the browser session, so a session-scoped CSRF cookie would
// disappear first and orphan them. Match the staff absolute session ceiling (8h).
export const CSRF_COOKIE_MAX_AGE_SECONDS = 8 * 60 * 60;

const secureCookies = () => process.env.NODE_ENV === 'production';

export const setRefreshCookie = (reply: FastifyReply, token: string, maxAgeSeconds?: number) => {
    reply.setCookie(REFRESH_COOKIE, token, {
        httpOnly: true,
        secure: secureCookies(),
        sameSite: 'lax',
        path: REFRESH_COOKIE_PATH,
        ...(maxAgeSeconds === undefined ? {} : { maxAge: maxAgeSeconds }),
    });
};

export const clearRefreshCookie = (reply: FastifyReply) => {
    reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH, secure: secureCookies() });
};

export const setRecoveryCookie = (reply: FastifyReply, token: string, maxAgeSeconds?: number) => {
    reply.setCookie(RECOVERY_COOKIE, token, {
        httpOnly: true,
        secure: secureCookies(),
        sameSite: 'lax',
        path: RECOVERY_COOKIE_PATH,
        ...(maxAgeSeconds === undefined ? {} : { maxAge: maxAgeSeconds }),
    });
};

export const clearRecoveryCookie = (reply: FastifyReply) => {
    reply.clearCookie(RECOVERY_COOKIE, { path: RECOVERY_COOKIE_PATH, secure: secureCookies() });
};

export const clearAuthCookies = (reply: FastifyReply) => {
    clearRefreshCookie(reply);
    clearRecoveryCookie(reply);
    reply.clearCookie(CSRF_COOKIE, { path: CSRF_COOKIE_PATH, secure: secureCookies() });
};

export const ensureCsrfCookie = (reply: FastifyReply) => {
    const value = randomBytes(32).toString('base64url');
    reply.setCookie(CSRF_COOKIE, value, {
        httpOnly: false,
        secure: secureCookies(),
        sameSite: 'lax',
        path: CSRF_COOKIE_PATH,
        maxAge: CSRF_COOKIE_MAX_AGE_SECONDS,
    });
    return value;
};

const headerValue = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;

const hasTrustedOrigin = (request: FastifyRequest) => {
    const origin = headerValue(request.headers.origin);
    return Boolean(origin && getConfiguredCorsOrigins().has(origin.toLowerCase()));
};

const hasJsonContentType = (request: FastifyRequest) => {
    const contentType = headerValue(request.headers['content-type']);
    return Boolean(contentType && /^application\/json(?:\s*;|$)/i.test(contentType));
};

const equalTokens = (left: string | undefined, right: string | undefined) => {
    if (!left || !right) return false;
    const leftBytes = Buffer.from(left);
    const rightBytes = Buffer.from(right);
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
};

export const requireTrustedAuthRequest = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!hasTrustedOrigin(request)) {
        return reply.status(403).send({ message: 'Forbidden origin' });
    }
    if (!hasJsonContentType(request)) {
        return reply.status(415).send({ message: 'Content-Type must be application/json' });
    }
};

export const requiresCsrfProof = (cookies: Record<string, string | undefined>) =>
    Boolean(cookies[REFRESH_COOKIE] || cookies[RECOVERY_COOKIE]);

export const requireTrustedAuthMutation = async (request: FastifyRequest, reply: FastifyReply) => {
    await requireTrustedAuthRequest(request, reply);
    if (reply.sent) return reply;

    // An anonymous bootstrap has no credential to protect. Let the route return its
    // typed missing-session outcome; any credential-bearing request still requires CSRF.
    if (!requiresCsrfProof(request.cookies)) return;
    const csrfHeader = headerValue(request.headers['x-csrf-token']);
    // Credentials present with no CSRF cookie at all cannot be recovered by the client: it has
    // no value to echo back, so retrying always fails and bootstrap never settles. Treat it as
    // an orphaned session, tombstone the stale credentials, and emit the terminal code the
    // client already routes to login. A present-but-mismatched cookie still fails closed as 403.
    if (request.cookies[CSRF_COOKIE] === undefined) {
        clearAuthCookies(reply);
        return reply.status(401).send({
            error: { code: 'AUTH_TOKEN_INVALID', message: 'Invalid refresh token' },
        });
    }
    if (!equalTokens(csrfHeader, request.cookies[CSRF_COOKIE])) {
        return reply.status(403).send({ message: 'Invalid CSRF token' });
    }
};
