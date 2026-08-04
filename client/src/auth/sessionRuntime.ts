import type { AxiosInstance } from 'axios';
import { accessTokenStore } from './accessToken.ts';
import { createBrowserAuthChannel, type AuthChannel } from './channel.ts';
import { createAuthCoordinator } from './coordinator.ts';
import type { AuthPhase, RefreshResponse, SessionPolicy } from './types.ts';

const LEGACY_TOKEN_KEY = 'token';
const CSRF_COOKIE = 'wb_csrf';
const CANONICAL_SID = /^[0-9a-f]{24}$/;
const STAFF_ROLES = new Set(['owner', 'admin', 'cs']);

export type SessionUser = {
    id: string;
    name: string;
    email: string;
    role: 'owner' | 'admin' | 'cs' | 'member';
    [key: string]: unknown;
};

export function readCsrfCookie(): string | null {
    if (typeof document === 'undefined') return null;
    const match = document.cookie.match(new RegExp(`(?:^|; )${CSRF_COOKIE}=([^;]*)`));
    return match ? decodeURIComponent(match[1]!) : null;
}

function decodeJwtPayload(accessToken: string): Record<string, unknown> | null {
    try {
        const segment = accessToken.split('.')[1];
        if (!segment) return null;
        return JSON.parse(atob(segment.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
    } catch {
        return null;
    }
}

function authoritativeRoleClass(user: unknown): SessionPolicy['roleClass'] {
    if (!user || typeof user !== 'object' || Array.isArray(user)) {
        throw new Error('Invalid authoritative refresh user');
    }
    const role = (user as { role?: unknown }).role;
    if (role === 'member') return 'member';
    if (role === 'owner' || role === 'admin' || role === 'cs') return 'staff';
    throw new Error('Invalid authoritative refresh user role');
}

function parseSessionPolicy(
    session: Record<string, unknown> | undefined,
    accessToken: string,
    roleClass: SessionPolicy['roleClass'],
): SessionPolicy {
    const sid = typeof session?.sid === 'string' ? session.sid : typeof session?.sessionId === 'string' ? session.sessionId : '';
    let accessExpiresAt = typeof session?.accessExpiresAt === 'string' ? session.accessExpiresAt : '';
    if (!accessExpiresAt) {
        const payload = decodeJwtPayload(accessToken);
        if (typeof payload?.exp === 'number' && Number.isFinite(payload.exp)) {
            accessExpiresAt = new Date(payload.exp * 1000).toISOString();
        } else {
            accessExpiresAt = new Date(Date.now() + 300_000).toISOString();
        }
    }
    let sidFinal = sid;
    if (!sidFinal) {
        const payload = decodeJwtPayload(accessToken);
        sidFinal = typeof payload?.sid === 'string' ? payload.sid : '';
    }
    return { sid: sidFinal, roleClass, accessExpiresAt };
}

export function parseValidatedRefreshResponse(data: Record<string, unknown>): RefreshResponse {
    const accessToken = typeof data.accessToken === 'string' ? data.accessToken : typeof data.token === 'string' ? data.token : '';
    if (!accessToken) throw new Error('Missing access token in auth response');
    const roleClass = authoritativeRoleClass(data.user);
    return {
        accessToken,
        policy: parseSessionPolicy(data.session as Record<string, unknown> | undefined, accessToken, roleClass),
        user: data.user,
    };
}

function parseUnlockUser(user: unknown): SessionUser {
    if (!user || typeof user !== 'object') throw new Error('Invalid unlock user');
    const record = user as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    const email = typeof record.email === 'string' ? record.email.trim() : '';
    const role = record.role;
    if (!id || !name || !email) throw new Error('Invalid unlock user identity');
    if (role !== 'owner' && role !== 'admin' && role !== 'cs') throw new Error('Invalid unlock user role');
    return { ...record, id, name, email, role } as SessionUser;
}

export function parseValidatedUnlockResponse(data: Record<string, unknown>): RefreshResponse & { user: SessionUser } {
    const accessToken = typeof data.accessToken === 'string' ? data.accessToken : typeof data.token === 'string' ? data.token : '';
    if (!accessToken) throw new Error('Missing access token in unlock response');

    const session = data.session as Record<string, unknown> | undefined;
    let sid = typeof session?.sid === 'string' ? session.sid : typeof session?.sessionId === 'string' ? session.sessionId : '';
    let accessExpiresAt = typeof session?.accessExpiresAt === 'string' ? session.accessExpiresAt : '';
    const roleClassRaw = session?.roleClass;

    const payload = decodeJwtPayload(accessToken);
    const jwtSid = typeof payload?.sid === 'string' && CANONICAL_SID.test(payload.sid) ? payload.sid : '';

    if (!CANONICAL_SID.test(sid) || !accessExpiresAt || !Number.isFinite(Date.parse(accessExpiresAt))) {
        if (!CANONICAL_SID.test(sid) && jwtSid) sid = jwtSid;
        if ((!accessExpiresAt || !Number.isFinite(Date.parse(accessExpiresAt))) && typeof payload?.exp === 'number' && Number.isFinite(payload.exp)) {
            accessExpiresAt = new Date(payload.exp * 1000).toISOString();
        }
    }

    if (jwtSid && CANONICAL_SID.test(sid) && jwtSid !== sid) throw new Error('Unlock session id mismatch');
    if (!CANONICAL_SID.test(sid)) throw new Error('Invalid unlock session id');
    if (!accessExpiresAt || !Number.isFinite(Date.parse(accessExpiresAt))) throw new Error('Invalid unlock access expiry');

    const roleClass: SessionPolicy['roleClass'] =
        roleClassRaw === 'staff'
            ? 'staff'
            : roleClassRaw === 'member'
                ? 'member'
                : typeof session?.role === 'string' && STAFF_ROLES.has(session.role)
                    ? 'staff'
                    : 'member';
    if (roleClass !== 'staff') throw new Error('Invalid unlock role class');

    const user = parseUnlockUser(data.user);
    if (!STAFF_ROLES.has(user.role)) throw new Error('Unlock user role mismatch');

    return {
        accessToken,
        policy: { sid, roleClass, accessExpiresAt },
        user,
    };
}

type RuntimeCallbacks = {
    setPhase: (phase: AuthPhase) => void;
    acceptRemote: (result: RefreshResponse) => boolean;
    onAuthenticated: (result: RefreshResponse, source: 'local' | 'remote') => void;
    onTerminal: (code: string) => void;
};

let coordinator: ReturnType<typeof createAuthCoordinator> | null = null;

export function initAuthSessionRuntime(
    api: AxiosInstance,
    callbacks: RuntimeCallbacks,
    options?: { channel?: AuthChannel | null },
): () => void {
    coordinator?.dispose();
    const channel = options && 'channel' in options ? options.channel ?? null : createBrowserAuthChannel();
    if (!channel) throw new Error('Auth channel is required');
    const instance = createAuthCoordinator({
        tokenStore: accessTokenStore,
        channel,
        setPhase: callbacks.setPhase,
        acceptRemote: callbacks.acceptRemote,
        onAuthenticated: callbacks.onAuthenticated,
        onTerminal: callbacks.onTerminal,
        delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: () => Date.now(),
        legacyStorage: {
            readOnce: () => {
                try {
                    return localStorage.getItem(LEGACY_TOKEN_KEY);
                } catch {
                    return null;
                }
            },
            remove: () => {
                try {
                    localStorage.removeItem(LEGACY_TOKEN_KEY);
                } catch {
                    /* ignore */
                }
            },
        },
        refresh: async () => {
            const res = await api.post('/auth/refresh', {}, { _skipAuthRefresh: true } as never);
            return parseValidatedRefreshResponse(res.data as Record<string, unknown>);
        },
        migrate: async (legacyToken) => {
            const res = await api.post('/auth/session/migrate', {}, {
                headers: { Authorization: `Bearer ${legacyToken}` },
                _skipAuthRefresh: true,
            } as never);
            return parseValidatedRefreshResponse(res.data as Record<string, unknown>);
        },
    });
    coordinator = instance;
    return () => {
        instance.dispose();
        if (coordinator === instance) coordinator = null;
    };
}

export function getAuthCoordinator() {
    return coordinator;
}

export function applyValidatedLoginResponse(validated: RefreshResponse): RefreshResponse {
    try {
        localStorage.removeItem(LEGACY_TOKEN_KEY);
    } catch {
        /* ignore */
    }
    const active = coordinator;
    if (!active) throw new Error('Auth session runtime is not initialized');
    return active.installLocalCredential(validated);
}

/**
 * Parse a login envelope without installing anything.
 *
 * Installation has observable side effects: the access token is stored, the coordinator becomes
 * authenticated, refresh is scheduled and the credential is broadcast to other tabs. Callers that
 * must vet the envelope first (for example a login-audience check) parse here, decide, and only
 * then call `applyValidatedLoginResponse`.
 */
export function parseValidatedLoginResponse(data: Record<string, unknown>): RefreshResponse {
    return parseValidatedRefreshResponse(data);
}

export function applyLoginResponse(data: Record<string, unknown>): RefreshResponse {
    return applyValidatedLoginResponse(parseValidatedRefreshResponse(data));
}