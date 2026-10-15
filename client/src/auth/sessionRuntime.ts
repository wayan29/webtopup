import type { AxiosInstance } from 'axios';
import { accessTokenStore } from './accessToken.ts';
import { createBrowserAuthChannel, type AuthChannel } from './channel.ts';
import { createAuthCoordinator } from './coordinator.ts';
import type { AuthPhase, RefreshResponse, SessionPolicy } from './types.ts';

const CSRF_COOKIE = 'wb_csrf';
const CANONICAL_SID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
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
    user: Record<string, unknown>,
): SessionPolicy {
    const payload = decodeJwtPayload(accessToken);
    const sid = typeof session?.sid === 'string' ? session.sid : typeof session?.sessionId === 'string' ? session.sessionId : '';
    if (!payload || payload.tokenType !== 'access'
        || typeof payload.sid !== 'string' || !CANONICAL_SID.test(payload.sid)
        || typeof payload.sub !== 'string' || !CANONICAL_SID.test(payload.sub)
        || payload.sub !== user.id || payload.role !== user.role
        || !CANONICAL_SID.test(sid) || sid !== payload.sid) {
        throw new Error('Invalid auth credential identity binding');
    }
    if (typeof payload.exp !== 'number' || !Number.isSafeInteger(payload.exp)
        || typeof payload.iat !== 'number' || !Number.isSafeInteger(payload.iat)
        || payload.exp <= payload.iat) throw new Error('Invalid auth access expiry');
    const expiry = new Date(payload.exp * 1000);
    if (!Number.isFinite(expiry.getTime())) throw new Error('Invalid auth access expiry');
    const accessExpiresAt = session?.accessExpiresAt;
    if (typeof accessExpiresAt !== 'string' || !Number.isFinite(Date.parse(accessExpiresAt))
        || Math.floor(Date.parse(accessExpiresAt) / 1000) !== payload.exp) {
        throw new Error('Auth access expiry mismatch');
    }
    if (session?.roleClass !== roleClass) throw new Error('Auth role class mismatch');
    return { sid, roleClass, accessExpiresAt };
}

export function parseValidatedRefreshResponse(data: Record<string, unknown>): RefreshResponse {
    const accessToken = typeof data.accessToken === 'string' ? data.accessToken : '';
    if (!accessToken) throw new Error('Missing access token in auth response');
    const roleClass = authoritativeRoleClass(data.user);
    const user = data.user as Record<string, unknown>;
    if (typeof user.id !== 'string' || !CANONICAL_SID.test(user.id)) throw new Error('Invalid auth user id');
    const session = data.session;
    if (!session || typeof session !== 'object' || Array.isArray(session)) throw new Error('Missing auth session');
    return {
        accessToken,
        policy: parseSessionPolicy(session as Record<string, unknown>, accessToken, roleClass, user),
        user,
    };
}

export function parseValidatedUnlockResponse(data: Record<string, unknown>): RefreshResponse & { user: SessionUser } {
    const result = parseValidatedRefreshResponse(data);
    const user = result.user as Record<string, unknown>;
    if (result.policy.roleClass !== 'staff' || !STAFF_ROLES.has(String(user.role))) throw new Error('Invalid unlock user role');
    if (typeof user.name !== 'string' || !user.name.trim() || typeof user.email !== 'string' || !user.email.trim()) {
        throw new Error('Invalid unlock user identity');
    }
    // Shared response validation establishes UUID identity and the role union before installation.
    return { ...result, user: user as SessionUser };
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
        refresh: async () => {
            const res = await api.post('/auth/refresh', {}, { _skipAuthRefresh: true } as never);
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