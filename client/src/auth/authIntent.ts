export type GuardAuthPhase =
    | 'initializing'
    | 'authenticated'
    | 'refreshing'
    | 'locked'
    | 'offline-stale'
    | 'rate-limited'
    | 'bootstrap-retry'
    | 'unauthenticated'
    | 'revoked';

export type GuardAuthSnapshot = {
    token: string | null;
    isAuthenticated: boolean;
    isAuthLoading: boolean;
    authPhase: GuardAuthPhase;
};

/** Active bootstrap request only; not used after a recoverable failure. */
export function shouldHoldProtectedRoute(snapshot: GuardAuthSnapshot): boolean {
    return snapshot.isAuthLoading || snapshot.authPhase === 'initializing' || snapshot.authPhase === 'refreshing';
}

/**
 * Whether regaining focus (or connectivity) should trigger a session refresh.
 *
 * Refreshing unconditionally breaks the login page: leaving /login to fetch a 2FA code
 * backgrounds the tab, and on return the refresh drives the phase to "refreshing", which the
 * guards render as the blocking "Memuat sesi..." screen. A guest has no session to refresh, so
 * there is nothing to gain and a stuck screen to lose.
 *
 * Requires a surviving token: that is what a refresh actually consumes. Phases that already have
 * work in flight are left alone so focus events cannot stack refreshes.
 */
export function shouldRefreshOnVisibility(snapshot: GuardAuthSnapshot): boolean {
    if (!snapshot.token) return false;
    if (shouldHoldProtectedRoute(snapshot)) return false;
    return (
        snapshot.authPhase !== 'unauthenticated'
        && snapshot.authPhase !== 'revoked'
        && snapshot.authPhase !== 'locked'
        && snapshot.authPhase !== 'rate-limited'
    );
}

export function shouldRedirectProtectedRouteToLogin(snapshot: GuardAuthSnapshot): boolean {
    if (snapshot.token && snapshot.authPhase === 'bootstrap-retry') {
        return false;
    }
    return !shouldHoldProtectedRoute(snapshot) && !snapshot.isAuthenticated;
}

export type ProtectedRouteView = 'loading' | 'login' | 'content';

export function resolveProtectedRouteView(snapshot: GuardAuthSnapshot): ProtectedRouteView {
    if (shouldHoldProtectedRoute(snapshot)) {
        return 'loading';
    }
    if (snapshot.token && snapshot.authPhase === 'bootstrap-retry') {
        return 'content';
    }
    if (!snapshot.isAuthenticated) {
        return 'login';
    }
    return 'content';
}

export type AppBootstrapScreen = 'offline-stale' | 'rate-limited' | 'bootstrap-retry';

export function bootstrapScreenAllowsRetry(screen: AppBootstrapScreen): boolean {
    return screen !== 'rate-limited';
}

/**
 * A cold-bootstrap 423 arrives before the user payload is restored, so undefined means unknown,
 * not unenrolled. Offering OTP is safe for unenrolled staff (they can leave it blank) and is the
 * only way an enrolled staff member can recover the locked session.
 */
export function lockedSessionMayRequireOtp(twoFactorEnabled: boolean | undefined): boolean {
    return twoFactorEnabled !== false;
}

export function resolveAppBootstrapScreen(authPhase: GuardAuthPhase): AppBootstrapScreen | null {
    if (authPhase === 'offline-stale') {
        return 'offline-stale';
    }
    if (authPhase === 'rate-limited') {
        return 'rate-limited';
    }
    if (authPhase === 'bootstrap-retry') {
        return 'bootstrap-retry';
    }
    return null;
}

/** Store transition after non-terminal, non-offline bootstrap failure while token remains. */
export function setBootstrapRetryState(returnTo: string, message: string | null = null) {
    return {
        isAuthLoading: false,
        isAuthenticated: false,
        authPhase: 'bootstrap-retry' as const,
        offlineReturnTo: returnTo,
        authFailureMessage: message,
    };
}