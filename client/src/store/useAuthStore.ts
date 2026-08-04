import { create } from 'zustand';
import { apiV2 } from '../api/index.ts';
import { accessTokenStore } from '../auth/accessToken.ts';
import {
    parseAuthError,
    resolveUnlockFailurePhase,
    sanitizeInternalReturnTo,
    shouldAttemptUnlockResponseRecovery,
    shouldPreserveSessionOnBootstrapFailure,
    shouldTerminateSession,
    type ParsedAuthError,
} from '../auth/authErrors.ts';
import { setBootstrapRetryState } from '../auth/authIntent.ts';
import { publicBootstrapFailureView } from '../auth/publicRouteIntent.ts';
import {
    allowsRememberMe,
    audienceForRole,
    loginEndpointForAudience,
    loginPathForAudience,
    type LoginAudience,
} from '../auth/loginIntent.ts';
import { buildUnlockPayload } from '../auth/unlockPayload.ts';
import type { AuthChannel } from '../auth/channel.ts';
import { computeServerTimeOffsetMs } from '../auth/twoFactorEnrollmentClock.ts';
import { applyValidatedLoginResponse, getAuthCoordinator, initAuthSessionRuntime, parseValidatedLoginResponse, parseValidatedUnlockResponse } from '../auth/sessionRuntime.ts';
import type { AuthPhase as CoordinatorPhase } from '../auth/types.ts';

interface Permissions {
    viewDashboard?: boolean;
    viewReports?: boolean;
    viewTransactions?: boolean;
    processManualTransaction?: boolean;
    viewDeposits?: boolean;
    approveDeposits?: boolean;
    viewProducts?: boolean;
    manageProducts?: boolean;
    manageVouchers?: boolean;
    viewPayment?: boolean;
    managePayment?: boolean;
    viewUsers?: boolean;
    manageUsers?: boolean;
    viewTeam?: boolean;
    manageTeam?: boolean;
    viewSettings?: boolean;
    manageSettings?: boolean;
    viewVendors?: boolean;
    manageVendors?: boolean;
}

export interface User {
    id: string;
    name: string;
    email: string;
    avatarUrl?: string;
    phone?: string;
    address?: string;
    role: 'owner' | 'admin' | 'cs' | 'member';
    level: string;
    balance: number;
    points: number;
    active?: boolean;
    twoFactorEnabled?: boolean;
    twoFactorEnrollmentRequiredAt?: string | null;
    twoFactorEnrollmentCompletedAt?: string | null;
    serverTime?: string;
    createdAt?: string;
    preferences?: {
        emailNotifications: boolean;
        smsNotifications: boolean;
        showBalance: boolean;
        uiTheme: 'ember-premium' | 'ember-premium-light' | 'forest-trusted' | 'forest-trusted-light' | 'royal-plum-luxury' | 'royal-plum-luxury-light' | 'graphite-operational' | 'graphite-operational-light' | 'horizon-clean' | 'midnight-elegant' | 'neobrutal-bold';
    };
    permissions?: Permissions;
}

export type AuthPhase =
    | CoordinatorPhase
    | 'rate-limited'
    | 'bootstrap-retry';

export type DeviceLimitChallenge = {
    challengeToken: string;
    sessions: import('../components/auth/DeviceLimitDialog').DeviceSession[];
};

export type LoginResult = { requiresTwoFactor: true; challengeToken: string } | { deviceLimit: DeviceLimitChallenge } | void;

interface AuthState {
    user: User | null;
    token: string | null;
    isAuthenticated: boolean;
    isAdmin: boolean;
    isOwner: boolean;
    isTeamMember: boolean;
    isAuthLoading: boolean;
    authPhase: AuthPhase;
    offlineReturnTo: string;
    authFailureMessage: string | null;
    /** Memory-only opaque signal for authoritative credential installation. */
    authSessionEpoch: number;
    /** Memory-only: parsed serverTime - Date.now() at last authoritative envelope. Never persisted. */
    serverTimeOffsetMs: number | null;
    login: (audience: LoginAudience, email: string, password: string, rememberMe?: boolean) => Promise<LoginResult>;
    verifyTwoFactorLogin: (audience: LoginAudience, challengeToken: string, code: string, rememberMe?: boolean) => Promise<LoginResult>;
    completeDeviceSelection: (audience: LoginAudience, challengeToken: string, sessionId: string) => Promise<void>;
    register: (name: string, email: string, password: string) => Promise<void>;
    logout: () => Promise<void>;
    checkAuth: (returnTo?: string) => Promise<void>;
    retryBootstrap: () => Promise<void>;
    syncProfile: () => Promise<void>;
    lockForIdle: () => void;
    unlockIdleSession: (password: string, otp?: string) => Promise<void>;
    hasPermission: (permission: keyof Permissions) => boolean;
}

const hasResolvedPermission = (permissions: Permissions | undefined, permission: keyof Permissions) => {
    if (!permissions) return false;
    if (permissions[permission]) return true;

    if (permission === 'viewTeam' && permissions.manageTeam) {
        return true;
    }

    if (permission === 'viewVendors' && permissions.manageVendors) {
        return true;
    }

    if (permission === 'viewProducts' && permissions.manageProducts) {
        return true;
    }

    if (permission === 'manageVouchers' && permissions.manageProducts) {
        return true;
    }

    if (permission === 'viewPayment' && permissions.managePayment) {
        return true;
    }

    if (permission === 'viewUsers' && permissions.manageUsers) {
        return true;
    }

    if (permission === 'viewSettings' && permissions.manageSettings) {
        return true;
    }

    return false;
};

/**
 * Authoritative install/bootstrap/profile/session replacement offset resolver.
 * Missing/blank/malformed serverTime ALWAYS fails closed to null.
 * Never inherits a prior session/user offset — callers must use the explicit
 * partial-unlock path when same lifecycle/SID/user is proven.
 */
export function resolveAuthoritativeServerTimeOffsetMs(options: {
    user: User;
    clientNowMs: number;
}): number | null {
    const { user, clientNowMs } = options;
    const raw = user.serverTime;
    if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
        return null;
    }
    return computeServerTimeOffsetMs(raw, clientNowMs);
}

/**
 * Explicit partial-unlock merge only. Preservation requires proven same user
 * identity and same coordinator SID; otherwise fails closed to null / fresh compute.
 */
export function resolvePartialUnlockServerTimeOffsetMs(options: {
    user: User;
    clientNowMs: number;
    previousUser: User | null | undefined;
    previousOffsetMs: number | null | undefined;
    previousSid: string | null | undefined;
    nextSid: string | null | undefined;
}): number | null {
    const { user, clientNowMs, previousUser, previousOffsetMs, previousSid, nextSid } = options;
    const sameUser = Boolean(previousUser && previousUser.id === user.id);
    const sameSid = Boolean(
        previousSid
        && nextSid
        && previousSid === nextSid,
    );
    const canPreserveLifecycle = sameUser && sameSid;

    const raw = user.serverTime;
    if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
        if (!canPreserveLifecycle) return null;
        return typeof previousOffsetMs === 'number' && Number.isFinite(previousOffsetMs)
            ? previousOffsetMs
            : null;
    }

    const computed = computeServerTimeOffsetMs(raw, clientNowMs);
    if (computed === null) return null;

    // Same serialized serverTime on the proven same lifecycle → keep prior offset so
    // unlock merges do not drift by re-subtracting Date.now() from a frozen snapshot.
    if (
        canPreserveLifecycle
        && previousUser
        && previousUser.serverTime === raw
        && typeof previousOffsetMs === 'number'
        && Number.isFinite(previousOffsetMs)
    ) {
        return previousOffsetMs;
    }

    return computed;
}

export function nextAuthSessionEpoch(current: number): number {
    return Number.isSafeInteger(current) && current >= 0 && current < Number.MAX_SAFE_INTEGER ? current + 1 : 0;
}

export function shouldApplyBootstrapResult(startEpoch: number, currentEpoch: number): boolean {
    return startEpoch === currentEpoch;
}

type SurvivingAuthSnapshot = Pick<
    AuthState,
    'authPhase' | 'authSessionEpoch' | 'isAuthenticated' | 'token' | 'user'
>;

/**
 * A bootstrap throttle cannot invalidate an already installed memory credential. Survival is
 * proven by one internally consistent snapshot: authenticated flag + user + exact token-store
 * match + unchanged epoch. The phase is intentionally not authority because coordinator phase
 * callbacks can move a valid session through initializing/refreshing/offline-stale.
 */
export function hasSurvivingAuthenticatedSession(
    snapshot: SurvivingAuthSnapshot,
    memoryAccessToken: string | null,
    expectedEpoch: number,
): boolean {
    return Boolean(
        snapshot.authSessionEpoch === expectedEpoch
        && snapshot.isAuthenticated
        && snapshot.user
        && snapshot.token
        && snapshot.token === memoryAccessToken,
    );
}

const buildAuthStateFromUser = (
    user: User,
    token: string,
    options?: {
        clientNowMs?: number;
        /** When set, uses the explicit partial-unlock resolver; otherwise fail-closed authoritative install. */
        partialUnlock?: {
            previousUser: User | null | undefined;
            previousOffsetMs: number | null | undefined;
            previousSid: string | null | undefined;
            nextSid: string | null | undefined;
        };
    },
) => ({
    token,
    user,
    isAuthenticated: true,
    isAdmin: ['owner', 'admin'].includes(user.role),
    isOwner: user.role === 'owner',
    isTeamMember: ['owner', 'admin', 'cs'].includes(user.role),
    isAuthLoading: false,
    authPhase: 'authenticated' as AuthPhase,
    authFailureMessage: null,
    serverTimeOffsetMs: options?.partialUnlock
        ? resolvePartialUnlockServerTimeOffsetMs({
            user,
            clientNowMs: options.clientNowMs ?? Date.now(),
            previousUser: options.partialUnlock.previousUser,
            previousOffsetMs: options.partialUnlock.previousOffsetMs,
            previousSid: options.partialUnlock.previousSid,
            nextSid: options.partialUnlock.nextSid,
        })
        : resolveAuthoritativeServerTimeOffsetMs({
            user,
            clientNowMs: options?.clientNowMs ?? Date.now(),
        }),
});

const clearedAuthState = {
    token: null as string | null,
    user: null as User | null,
    isAuthenticated: false,
    isAdmin: false,
    isOwner: false,
    isTeamMember: false,
    isAuthLoading: false,
    authFailureMessage: null as string | null,
    serverTimeOffsetMs: null as number | null,
};

export function coordinatorPhaseTransition(phase: CoordinatorPhase) {
    if (phase === 'unauthenticated') {
        return { ...clearedAuthState, authPhase: 'unauthenticated' as AuthPhase, offlineReturnTo: '/' };
    }
    return {
        authPhase: phase as AuthPhase,
        isAuthLoading: phase === 'initializing' || phase === 'refreshing',
    };
}

const transitionToTerminal = (parsed: ParsedAuthError, returnTo: string) => ({
    ...clearedAuthState,
    authPhase: 'revoked' as AuthPhase,
    authFailureMessage: parsed.message,
    offlineReturnTo: returnTo,
});

const setOfflineStale = (returnTo: string) => ({
    isAuthLoading: false,
    authPhase: 'offline-stale' as AuthPhase,
    offlineReturnTo: returnTo,
    authFailureMessage: null,
});

const setRateLimited = (returnTo: string, message: string) => ({
    isAuthLoading: false,
    isAuthenticated: false,
    authPhase: 'rate-limited' as AuthPhase,
    offlineReturnTo: returnTo,
    authFailureMessage: message,
});

const normalizeEmail = (value: string) => value.trim().toLowerCase();
const normalizeName = (value: string) => value.trim();

function userFromRefresh(user: unknown): User | null {
    if (!user || typeof user !== 'object') return null;
    const record = user as User;
    if (typeof record.id !== 'string' || typeof record.role !== 'string') return null;
    return record;
}

let disposeRuntime: (() => void) | null = null;
let runtimeCallbacks: Parameters<typeof initAuthSessionRuntime>[1] | null = null;

export const useAuthStore = create<AuthState>((set, get) => {
    /**
     * Refuse a session that came back on the wrong channel, before it is installed.
     *
     * 2FA verification and device selection share one route pair, so a challenge started on one
     * login screen can be completed from the other. Rust binds the audience into the signed
     * challenge and fails closed, but the browser must not install a mismatched session either.
     * This runs before `applyValidatedLoginResponse`, so no access token is stored, no refresh is
     * scheduled and nothing is broadcast to other tabs when the audience does not match.
     */
    const assertAudienceMatches = async (audience: LoginAudience, user: User) => {
        if (audienceForRole(user.role) === audience) return;
        // Cookies were installed by the gateway before the browser could vet the envelope, so ask
        // the server to revoke them. Retry once: a single lost request would otherwise leave
        // HttpOnly credentials able to restore the refused session on reload.
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                await apiV2.post('/auth/logout', {}, { _skipAuthRefresh: true } as never);
                break;
            } catch {
                /* fall through to the local refusal below */
            }
        }
        getAuthCoordinator()?.clearSession('login-audience-mismatch');
        set({ ...clearedAuthState, authPhase: 'unauthenticated', offlineReturnTo: '/' });
        throw new Error('Login gagal. Periksa email dan password Anda.');
    };

    runtimeCallbacks = {
        setPhase: (phase) => {
            if (phase === 'unauthenticated') {
                set((state) => ({
                    ...coordinatorPhaseTransition(phase),
                    authSessionEpoch: nextAuthSessionEpoch(state.authSessionEpoch),
                }));
                return;
            }
            set(coordinatorPhaseTransition(phase));
        },
        acceptRemote: (result) => {
            const state = get();
            return Boolean(
                state.isAuthenticated
                && state.user
                && state.token
                && state.token === accessTokenStore.get()
                && audienceForRole(state.user.role) === result.policy.roleClass,
            );
        },
        onAuthenticated: (result, source) => {
            const refreshedUser = userFromRefresh(result.user);
            const state = get();
            // Broadcast ACCESS_UPDATED intentionally carries no user. It may retain only the
            // already-authoritative user bound to the same coordinator lifecycle/role class;
            // never fabricate identity from the token or channel message.
            const existingUserMatchesPolicy = Boolean(
                state.isAuthenticated
                && state.user
                && audienceForRole(state.user.role) === result.policy.roleClass,
            );
            const user = refreshedUser ?? (source === 'remote' && existingUserMatchesPolicy ? state.user : null);
            if (!user) return;
            const nextSid = result.policy?.sid ?? null;
            // SID replacement / re-auth: drop foreign grants and cancel any pending step-up action.
            void import('../auth/stepUp.ts').then(({ retainStepUpGrantsForSid }) => {
                retainStepUpGrantsForSid(nextSid);
            });
            void import('../auth/withStepUp.ts').then(({ cancelSharedStepUp }) => {
                cancelSharedStepUp('sid-replacement');
            });
            // A full authoritative envelope replaces clock state. A userless same-lifecycle
            // channel rotation preserves the existing authoritative user/clock while atomically
            // updating the token and epoch so stale bootstrap completions are fenced.
            set((current) => refreshedUser
                ? {
                    ...buildAuthStateFromUser(refreshedUser, result.accessToken),
                    authSessionEpoch: nextAuthSessionEpoch(current.authSessionEpoch),
                }
                : {
                    token: result.accessToken,
                    user,
                    isAuthenticated: true,
                    isAdmin: ['owner', 'admin'].includes(user.role),
                    isOwner: user.role === 'owner',
                    isTeamMember: ['owner', 'admin', 'cs'].includes(user.role),
                    isAuthLoading: false,
                    authPhase: 'authenticated',
                    authFailureMessage: null,
                    authSessionEpoch: nextAuthSessionEpoch(current.authSessionEpoch),
                });
        },
        onTerminal: (code) => {
            void import('../auth/stepUp.ts').then(({ clearAllStepUpGrants }) => clearAllStepUpGrants());
            void import('../auth/withStepUp.ts').then(({ cancelSharedStepUp }) => {
                cancelSharedStepUp('terminal');
            });
            set((state) => ({
                ...transitionToTerminal({ code: code as ParsedAuthError['code'], message: code }, state.offlineReturnTo),
                authSessionEpoch: nextAuthSessionEpoch(state.authSessionEpoch),
            }));
        },
    };

    return {
        user: null,
        token: null,
        isAuthenticated: false,
        isAdmin: false,
        isOwner: false,
        isTeamMember: false,
        isAuthLoading: true,
        authPhase: 'initializing',
        offlineReturnTo: '/',
        authFailureMessage: null,
        authSessionEpoch: 0,
        serverTimeOffsetMs: null,

        login: async (audience, email, password, rememberMe = false) => {
            const payload = {
                email: normalizeEmail(email),
                password,
                // Rust forces staff sessions to a non-persistent ceiling; never ask for more.
                rememberMe: allowsRememberMe(audience) ? rememberMe : false,
            };
            const res = await apiV2.post(loginEndpointForAudience(audience), payload).catch((error) => {
                if (error.response?.data?.code === 'AUTH_DEVICE_LIMIT_REACHED') return error.response;
                throw error;
            });
            if (res.data.code === 'AUTH_DEVICE_LIMIT_REACHED') return { deviceLimit: res.data as DeviceLimitChallenge };
            if (res.data.requiresTwoFactor) {
                return {
                    requiresTwoFactor: true,
                    challengeToken: res.data.challengeToken,
                };
            }

            // Parse and vet the envelope before installation, so a wrong-channel session is never
            // stored, scheduled for refresh, or broadcast to other tabs.
            const parsed = parseValidatedLoginResponse(res.data as Record<string, unknown>);
            const user = userFromRefresh(parsed.user);
            if (!user) throw new Error('Invalid login response');
            await assertAudienceMatches(audience, user);
            const applied = applyValidatedLoginResponse(parsed);
            // Fresh login envelope always replaces offset (no previous session).
            set(buildAuthStateFromUser(user, applied.accessToken));
        },

        verifyTwoFactorLogin: async (audience, challengeToken, code, rememberMe = false) => {
            // The challenge itself is audience-bound upstream; a mismatch fails closed there.
            const res = await apiV2.post('/auth/2fa/login-verify', {
                challengeToken,
                code,
                rememberMe: allowsRememberMe(audience) ? rememberMe : false,
            }).catch((error) => {
                if (error.response?.data?.code === 'AUTH_DEVICE_LIMIT_REACHED') return error.response;
                throw error;
            });
            if (res.data.code === 'AUTH_DEVICE_LIMIT_REACHED') return { deviceLimit: res.data as DeviceLimitChallenge };
            const parsed = parseValidatedLoginResponse(res.data as Record<string, unknown>);
            const user = userFromRefresh(parsed.user);
            if (!user) throw new Error('Invalid login response');
            await assertAudienceMatches(audience, user);
            set(buildAuthStateFromUser(user, applyValidatedLoginResponse(parsed).accessToken));
        },

        completeDeviceSelection: async (audience, challengeToken, sessionId) => {
            const res = await apiV2.post('/auth/device-selection', { challengeToken, revokeSessionId: sessionId });
            const parsed = parseValidatedLoginResponse(res.data as Record<string, unknown>);
            const user = userFromRefresh(parsed.user);
            if (!user) throw new Error('Invalid device selection response');
            await assertAudienceMatches(audience, user);
            set(buildAuthStateFromUser(user, applyValidatedLoginResponse(parsed).accessToken));
        },

        register: async (name, email, password) => {
            const payload = {
                name: normalizeName(name),
                email: normalizeEmail(email),
                password,
            };
            const res = await apiV2.post('/auth/register', payload);
            const parsed = parseValidatedLoginResponse(res.data as Record<string, unknown>);
            const user = userFromRefresh(parsed.user);
            if (!user) throw new Error('Invalid register response');
            // Registration only ever mints member accounts; a staff role here is an anomaly.
            await assertAudienceMatches('member', user);
            set(buildAuthStateFromUser(user, applyValidatedLoginResponse(parsed).accessToken));
        },

        logout: async () => {
            // Resolve the surface before the session is cleared, so staff land back on staff login.
            const loginPath = loginPathForAudience(audienceForRole(get().user?.role));
            const coordinator = getAuthCoordinator();
            try {
                await apiV2.post('/auth/logout', {}, { _skipAuthRefresh: true } as never);
            } catch {
                /* idempotent */
            }
            coordinator?.clearSession('user-logout');
            const { clearAllStepUpGrants } = await import('../auth/stepUp.ts');
            clearAllStepUpGrants();
            const { cancelSharedStepUp } = await import('../auth/withStepUp.ts');
            cancelSharedStepUp('logout');
            if (coordinator) {
                // clearSession already advanced the epoch through the unauthenticated phase callback.
                set({ ...clearedAuthState, authPhase: 'unauthenticated', offlineReturnTo: '/' });
            } else {
                set((state) => ({
                    ...clearedAuthState,
                    authPhase: 'unauthenticated',
                    offlineReturnTo: '/',
                    authSessionEpoch: nextAuthSessionEpoch(state.authSessionEpoch),
                }));
            }
            if (window.location.pathname !== loginPath) {
                window.location.href = loginPath;
            }
        },

        checkAuth: async (returnTo) => {
            const sanitizedReturnTo = sanitizeInternalReturnTo(
                window.location.pathname,
                window.location.search,
                window.location.hash,
            );
            const effectiveReturnTo = returnTo ?? sanitizedReturnTo;
            const coordinator = getAuthCoordinator();
            if (!coordinator) {
                set({ ...clearedAuthState, authPhase: 'unauthenticated', offlineReturnTo: effectiveReturnTo });
                return;
            }

            const bootstrapEpoch = get().authSessionEpoch;
            set({ isAuthLoading: true, authPhase: 'initializing' });

            try {
                const result = await coordinator.bootstrapSession();
                if (!shouldApplyBootstrapResult(bootstrapEpoch, get().authSessionEpoch)) return;
                let user = userFromRefresh(result.user);
                if (!user) {
                    const res = await apiV2.get('/auth/me');
                    user = res.data.user as User;
                }
                set({
                    ...buildAuthStateFromUser(user, result.accessToken),
                    offlineReturnTo: effectiveReturnTo,
                });
            } catch (error: unknown) {
                if (!shouldApplyBootstrapResult(bootstrapEpoch, get().authSessionEpoch)) return;
                const parsed = parseAuthError(error);
                if (parsed.code && shouldTerminateSession(parsed.code)) {
                    set(transitionToTerminal(parsed, effectiveReturnTo));
                } else if (parsed.code === 'AUTH_IDLE_LOCKED') {
                    // A locked session is recoverable, but only through the password/OTP unlock
                    // form. Falling through to bootstrap-retry hides that form behind a Coba lagi
                    // button that repeats the same 423 and then trips the 429 rate limit.
                    set({ authPhase: 'locked', isAuthLoading: false, isAuthenticated: false, offlineReturnTo: effectiveReturnTo, authFailureMessage: null });
                } else if (parsed.status === 429) {
                    // Suppress manual, visibility-based, and already-scheduled proactive retries
                    // until the cooldown elapses. Public cold loads have no session to protect and
                    // must remain usable as anonymous; a surviving valid memory session is kept.
                    getAuthCoordinator()?.cancelProactive();
                    const survivingAuthenticatedSession = hasSurvivingAuthenticatedSession(
                        get(),
                        accessTokenStore.get(),
                        bootstrapEpoch,
                    );
                    const failureView = publicBootstrapFailureView(
                        window.location.pathname,
                        parsed.status,
                        survivingAuthenticatedSession,
                    );
                    if (failureView === 'anonymous') {
                        accessTokenStore.clear();
                        set({
                            ...clearedAuthState,
                            authPhase: 'unauthenticated',
                            offlineReturnTo: effectiveReturnTo,
                        });
                    } else if (failureView === 'preserve-session') {
                        set(setOfflineStale(effectiveReturnTo));
                    } else {
                        set(setRateLimited(effectiveReturnTo, parsed.message));
                    }
                } else if (shouldPreserveSessionOnBootstrapFailure(parsed)) {
                    set(setOfflineStale(effectiveReturnTo));
                } else {
                    set(setBootstrapRetryState(effectiveReturnTo, parsed.message));
                }
            }
        },

        retryBootstrap: async () => {
            const { offlineReturnTo, checkAuth } = get();
            set({ isAuthLoading: true, authPhase: 'initializing' });
            const coordinator = getAuthCoordinator();
            if (!coordinator) {
                await checkAuth(offlineReturnTo);
                return;
            }
            try {
                await coordinator.refreshOnce('bootstrap-retry');
                await checkAuth(offlineReturnTo);
            } catch {
                await checkAuth(offlineReturnTo);
            }
        },

        lockForIdle: () => {
            const coordinator = getAuthCoordinator();
            if (coordinator) coordinator.lockSession();
            else set({ authPhase: 'locked', isAuthLoading: false, authFailureMessage: null });
        },

        unlockIdleSession: async (password, otp) => {
            try {
                const res = await apiV2.post('/auth/unlock', buildUnlockPayload(password, otp), { _skipAuthRefresh: true } as never);
                let validated;
                try {
                    validated = parseValidatedUnlockResponse(res.data as Record<string, unknown>);
                } catch {
                    throw new Error('Invalid unlock envelope');
                }
                const priorState = get();
                const prior = priorState.user;
                const previousSid = getAuthCoordinator()?.getSessionSid() ?? null;
                const applied = applyValidatedLoginResponse(validated);
                const nextSid = applied.policy?.sid ?? getAuthCoordinator()?.getSessionSid() ?? null;
                const refreshed = userFromRefresh(validated.user);
                const unlockedUser = (prior && refreshed
                    ? { ...prior, id: validated.user.id, name: validated.user.name, email: validated.user.email, role: validated.user.role }
                    : refreshed ?? (prior
                        ? { ...prior, id: validated.user.id, name: validated.user.name, email: validated.user.email, role: validated.user.role }
                        : null)) as User | null;
                if (!unlockedUser) throw new Error('Invalid unlock response');
                // Explicit partial-unlock merge: preserve offset only when same user+SID proven.
                set({
                    ...buildAuthStateFromUser(unlockedUser, applied.accessToken, {
                        partialUnlock: {
                            previousUser: prior,
                            previousOffsetMs: priorState.serverTimeOffsetMs,
                            previousSid,
                            nextSid,
                        },
                    }),
                });
            } catch (error: unknown) {
                if (error instanceof Error && error.message === 'Invalid unlock envelope') throw error;
                let effectiveError = error;
                let parsed = parseAuthError(effectiveError);

                // The server may have committed the unlock while its response was lost. Never ask
                // the user to submit password/OTP again in that ambiguous state: one refresh lets
                // the established predecessor protocol recover the rotated credential pair.
                if (shouldAttemptUnlockResponseRecovery(parsed)) {
                    const coordinator = getAuthCoordinator();
                    if (coordinator) {
                        try {
                            await coordinator.refreshOnce('unlock-response-recovery');
                            return;
                        } catch (recoveryError: unknown) {
                            effectiveError = recoveryError;
                            parsed = parseAuthError(recoveryError);
                        }
                    }
                }

                const responseCode = (effectiveError as { response?: { data?: { error?: { code?: string }; code?: string } } })?.response?.data;
                const code = responseCode?.error?.code ?? responseCode?.code ?? parsed.code;
                if (
                    code === 'AUTH_IDLE_LOCKED'
                    || code === 'REAUTH_PASSWORD_INVALID'
                    || code === 'REAUTH_OTP_INVALID'
                    || code === 'AUTH_REFRESH_RACE'
                    || code === 'AUTH_REFRESH_RECOVERY_UNAVAILABLE'
                    || parsed.status === 429
                ) {
                    const phase = resolveUnlockFailurePhase(parsed);
                    if (phase === 'rate-limited') getAuthCoordinator()?.cancelProactive();
                    set({
                        authPhase: phase,
                        isAuthenticated: false,
                        isAuthLoading: false,
                        authFailureMessage: parsed.message,
                    });
                } else if (parsed.code && shouldTerminateSession(parsed.code)) {
                    getAuthCoordinator()?.clearSession(parsed.code);
                    set(transitionToTerminal(parsed, get().offlineReturnTo));
                } else {
                    set({ authPhase: 'locked', isAuthLoading: false, authFailureMessage: parsed.message });
                }
                throw effectiveError;
            }
        },

        syncProfile: async () => {
            const token = accessTokenStore.get();

            if (!token) {
                set({ ...clearedAuthState, authPhase: 'unauthenticated' });
                return;
            }

            try {
                const res = await apiV2.get('/auth/me');
                const { user } = res.data;
                // Profile/bootstrap-style authoritative replacement: fail closed, never inherit.
                set(buildAuthStateFromUser(user, token));
            } catch (error: unknown) {
                const parsed = parseAuthError(error);
                if (parsed.code && shouldTerminateSession(parsed.code)) {
                    set(transitionToTerminal(parsed, get().offlineReturnTo));
                } else {
                    throw error;
                }
            }
        },

        hasPermission: (permission) => {
            const { user } = get();
            if (!user) return false;
            if (user.role === 'owner') return true;
            return hasResolvedPermission(user.permissions, permission);
        },
    };
});

let idleInterceptor: number | null = null;
let runtimeGeneration = 0;

function handleIdleLockedInterceptor(error: unknown, boundGeneration: number): void {
    const data = (error as { response?: { data?: { error?: { code?: string }; code?: string } } })?.response?.data;
    const code = data?.error?.code ?? data?.code;
    if (boundGeneration === runtimeGeneration && code === 'AUTH_IDLE_LOCKED') useAuthStore.getState().lockForIdle();
}

export function initAuthStoreRuntime(options?: { channel?: AuthChannel | null }): void {
    const generation = ++runtimeGeneration;
    if (!disposeRuntime && runtimeCallbacks) disposeRuntime = initAuthSessionRuntime(apiV2, runtimeCallbacks, options);
    if (idleInterceptor === null) {
        idleInterceptor = apiV2.interceptors.response.use(undefined, (error) => {
            handleIdleLockedInterceptor(error, generation);
            return Promise.reject(error);
        });
    }
}

export function disposeAuthStoreRuntime(): void {
    runtimeGeneration++;
    if (idleInterceptor !== null) apiV2.interceptors.response.eject(idleInterceptor);
    idleInterceptor = null;
    disposeRuntime?.();
    disposeRuntime = null;
}

/**
 * Install an authoritative user envelope into the auth store (login/bootstrap/sync/session replacement).
 * Recomputes memory-only serverTimeOffsetMs; missing/malformed server time fails closed to null.
 * Never inherits a prior offset — use applyPartialUnlockUserEnvelope for proven same-lifecycle unlock.
 * Exported for deterministic clock harnesses — not a public app API.
 */
export function applyAuthoritativeUserEnvelope(user: User, token: string, clientNowMs: number = Date.now()): void {
    useAuthStore.setState(buildAuthStateFromUser(user, token, { clientNowMs }));
}

/**
 * Explicit partial-unlock merge into the auth store.
 * Offset preservation requires proven same user id + same SID; otherwise fail closed.
 * Exported for deterministic clock harnesses — not a public app API.
 */
export function applyPartialUnlockUserEnvelope(
    user: User,
    token: string,
    options: {
        clientNowMs?: number;
        previousUser: User | null | undefined;
        previousOffsetMs: number | null | undefined;
        previousSid: string | null | undefined;
        nextSid: string | null | undefined;
    },
): void {
    useAuthStore.setState(buildAuthStateFromUser(user, token, {
        clientNowMs: options.clientNowMs ?? Date.now(),
        partialUnlock: {
            previousUser: options.previousUser,
            previousOffsetMs: options.previousOffsetMs,
            previousSid: options.previousSid,
            nextSid: options.nextSid,
        },
    }));
}