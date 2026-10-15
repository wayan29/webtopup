import type { FastifyReply } from 'fastify';
import type { AuthRequest, ITeamPermissions } from './authMiddleware';
import { isCanonicalUuid } from '../utils/jwt';

export type AdmissionCredential = { token: string } | { refreshToken: string; recoveryToken: string };
const PERMISSIONS: readonly (keyof ITeamPermissions)[] = [
    'viewDashboard', 'viewReports', 'viewTransactions', 'processManualTransaction',
    'viewDeposits', 'approveDeposits', 'viewProducts', 'manageProducts', 'manageVouchers',
    'viewPayment', 'managePayment', 'viewUsers', 'manageUsers', 'viewTeam', 'manageTeam',
    'viewSettings', 'manageSettings', 'viewVendors', 'manageVendors',
];

/** Parse the private service response before installing its authoritative identity. */
function parseAdmission(value: unknown, cookieUnlock: boolean): NonNullable<AuthRequest['user']> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid admission response');
    const record = value as Record<string, unknown>;
    const rawUser = record.user;
    if (!rawUser || typeof rawUser !== 'object' || Array.isArray(rawUser)) throw new Error('Invalid admission user');
    const user = rawUser as Record<string, unknown>;
    if (!isCanonicalUuid(user.id) || !isCanonicalUuid(record.sessionId)
        || typeof user.email !== 'string' || !user.email
        || !['owner', 'admin', 'cs', 'member'].includes(String(user.role))
        || !Array.isArray(user.permissions) || !user.permissions.every(permission => typeof permission === 'string')
        || !['ordinary', 'unlock', 'securityChangeRecovery', 'revokeAllRecovery'].includes(String(record.admissionKind))
        || (cookieUnlock && (record.admissionKind !== 'unlock' || user.role === 'member'))) {
        throw new Error('Invalid admission binding');
    }
    const permissions = Object.fromEntries(PERMISSIONS.map(name => [name, user.permissions instanceof Array && user.permissions.includes(name)])) as unknown as ITeamPermissions;
    // The role allowlist above establishes this union at the external boundary.
    const role = user.role as NonNullable<AuthRequest['user']>['role'];
    return { id: user.id, email: user.email, role, permissions, sessionId: record.sessionId, authMode: 'refresh-session' };
}

export async function authenticatePostgresSession(request: AuthRequest, reply: FastifyReply, credential: AdmissionCredential) {
    const cookieUnlock = !('token' in credential);
    const path = request.url.split('?')[0]?.replace(/^\/api\/v2(?=\/|$)/, '') || '/';
    if (cookieUnlock && (request.method !== 'POST' || path !== '/auth/unlock')) {
        return reply.status(401).send({ error: { code: 'AUTH_TOKEN_INVALID', message: 'Unauthorized: Invalid session' } });
    }
    try {
        const secret = process.env.API_V2_PROXY_SECRET?.trim();
        if (!secret || secret.length < 32) throw new Error('Proxy secret unavailable');
        const upstream = (process.env.API_V2_UPSTREAM_URL?.trim() || 'http://127.0.0.1:9010').replace(/\/+$/, '');
        const headers: Record<string, string> = { 'content-type': 'application/json', 'x-api-v2-proxy-secret': secret };
        if ('token' in credential) headers.authorization = `Bearer ${credential.token}`;
        const response = await fetch(`${upstream}/v2/internal/auth/admit`, {
            method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(5000),
            body: JSON.stringify({ method: request.method, path, ...(cookieUnlock ? credential : {}) }),
        });
        if (response.status >= 500) throw new Error('Admission service unavailable');
        const data: unknown = await response.json();
        if (!response.ok) {
            if (data && typeof data === 'object' && 'error' in data && data.error && typeof data.error === 'object'
                && 'code' in data.error && typeof data.error.code === 'string'
                && 'message' in data.error && typeof data.error.message === 'string'
                && [401, 403, 409].includes(response.status)) {
                return reply.status(response.status).send({ error: { code: data.error.code, message: data.error.message } });
            }
            return reply.status(502).send({ error: { code: 'AUTH_UPSTREAM_INVALID', message: 'Invalid authentication service response' } });
        }
        try {
            request.user = parseAdmission(data, cookieUnlock);
        } catch {
            return reply.status(502).send({ error: { code: 'AUTH_UPSTREAM_INVALID', message: 'Invalid authentication service response' } });
        }
    } catch {
        // No identity lookup or admission fallback is permitted when Rust/SQL is unavailable.
        request.log.error('SQL authentication admission unavailable');
        return reply.status(503).send({ error: { code: 'AUTH_STORE_UNAVAILABLE', message: 'Authentication service unavailable' } });
    }
}
