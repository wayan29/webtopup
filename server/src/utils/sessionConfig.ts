/** Bounded forced-login reasons (low cardinality; never credentials). */
export type ForcedLoginReason =
    | 'session_expired'
    | 'session_revoked'
    | 'refresh_reused'
    | 'account_disabled'
    | 'token_invalid'
    | 'recovery_expired';

const FORCED_LOGIN_REASONS: Record<ForcedLoginReason, true> = {
    session_expired: true,
    session_revoked: true,
    refresh_reused: true,
    account_disabled: true,
    token_invalid: true,
    recovery_expired: true,
};

export const forcedLoginReasonFromAuthCode = (code: string | undefined): ForcedLoginReason | null => {
    switch (code) {
        case 'AUTH_SESSION_EXPIRED':
            return 'session_expired';
        case 'AUTH_SESSION_REVOKED':
            return 'session_revoked';
        case 'AUTH_REFRESH_REUSED':
            return 'refresh_reused';
        case 'AUTH_ACCOUNT_DISABLED':
            return 'account_disabled';
        case 'AUTH_REFRESH_RECOVERY_EXPIRED':
            return 'recovery_expired';
        case 'AUTH_TOKEN_INVALID':
            return 'token_invalid';
        default:
            return null;
    }
};

export const recordForcedLoginMetric = (reason: string, log?: { info: (obj: object, msg?: string) => void }) => {
    const bounded = reason in FORCED_LOGIN_REASONS ? reason : 'token_invalid';
    // Low-cardinality counter label only — never user IDs, tokens, or bodies.
    log?.info?.(
        { metric: 'auth_forced_login', reason: bounded },
        'security metric',
    );
};
