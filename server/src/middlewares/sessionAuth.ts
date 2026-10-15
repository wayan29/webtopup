import type { FastifyReply } from 'fastify';
import type { AuthRequest } from './authMiddleware';
import { authenticatePostgresSession } from './postgresSessionAuth';
import { sendAuthError } from '../utils/authErrors';
import { RECOVERY_COOKIE, REFRESH_COOKIE } from '../utils/authCookies';

export const stripUntrustedSessionHeader = (request: AuthRequest) => {
    delete request.headers['x-webtopup-session-id'];
    delete request.headers['x-user-id'];
    delete request.headers['x-user-role'];
    delete request.headers['x-user-permissions'];
    delete request.user;
};

export const resolveBearerToken = (request: AuthRequest): string | null => {
    const header = request.headers.authorization;
    if (typeof header !== 'string') return null;
    const match = /^Bearer ([^\s]+)$/.exec(header);
    return match?.[1] ?? null;
};

export const authenticateSession = async (request: AuthRequest, reply: FastifyReply) => {
    stripUntrustedSessionHeader(request);
    const token = resolveBearerToken(request);
    if (!token) return sendAuthError(reply, 401, 'AUTH_TOKEN_INVALID', 'Unauthorized: No token provided');
    return authenticatePostgresSession(request, reply, { token });
};

export const authenticateUnlockSession = async (request: AuthRequest, reply: FastifyReply) => {
    stripUntrustedSessionHeader(request);
    // Cookie-based candidate admission is limited to the original unlock endpoint. Rust still
    // verifies credential secrets, password and OTP before it rotates or unlocks the session.
    if (request.method !== 'POST' || request.url.split('?')[0] !== '/api/v2/auth/unlock') {
        return sendAuthError(reply, 401, 'AUTH_TOKEN_INVALID', 'Unauthorized: Invalid session');
    }
    const token = resolveBearerToken(request);
    if (token) return authenticatePostgresSession(request, reply, { token });
    // A malformed bearer must not silently downgrade to cookie authentication.
    if (request.headers.authorization !== undefined) {
        return sendAuthError(reply, 401, 'AUTH_TOKEN_INVALID', 'Unauthorized: Invalid token');
    }
    const refreshToken = request.cookies?.[REFRESH_COOKIE];
    const recoveryToken = request.cookies?.[RECOVERY_COOKIE];
    if (!refreshToken || !recoveryToken) {
        return sendAuthError(reply, 401, 'AUTH_TOKEN_INVALID', 'Unauthorized: Invalid session');
    }
    return authenticatePostgresSession(request, reply, { refreshToken, recoveryToken });
};
