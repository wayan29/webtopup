const production = () => process.env.NODE_ENV === 'production';

const requiredInProduction = (name: string, allowExplicitEmpty = false): string | undefined => {
    const present = Object.prototype.hasOwnProperty.call(process.env, name);
    const value = process.env[name]?.trim();
    if ((!present || (!value && !allowExplicitEmpty)) && production()) {
        throw new Error(`${name} must be configured in production`);
    }
    return value || undefined;
};

const parseUtcInstant = (raw: string | undefined): number | null => {
    if (!raw) return null;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(raw)) {
        throw new Error('LEGACY_ACCESS_TOKEN_ACCEPT_UNTIL must be an explicit UTC instant');
    }
    const ms = Date.parse(raw);
    const canonical = new Date(ms).toISOString();
    const expected = raw.includes('.') ? raw : raw.replace('Z', '.000Z');
    if (!Number.isFinite(ms) || canonical !== expected) {
        throw new Error('LEGACY_ACCESS_TOKEN_ACCEPT_UNTIL must be a canonical Gregorian UTC instant');
    }
    return ms;
};

const parseBoolStrict = (name: string, raw: string | undefined): boolean => {
    if (!raw) return false;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    throw new Error(`${name} must be true or false`);
};

const parseCohortPercent = (name: string, raw: string | undefined): number => {
    if (!raw) return 0;
    if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer from 0 to 100`);
    const parsed = Number(raw);
    if (parsed < 0 || parsed > 100) throw new Error(`${name} must be an integer from 0 to 100`);
    return parsed;
};

export const isSessionRefreshEnabled = () => {
    const raw = requiredInProduction('SESSION_REFRESH_ENABLED');
    return parseBoolStrict('SESSION_REFRESH_ENABLED', raw);
};

export const getSessionRefreshMemberCohortPercent = () =>
    parseCohortPercent(
        'SESSION_REFRESH_MEMBER_COHORT_PERCENT',
        requiredInProduction('SESSION_REFRESH_MEMBER_COHORT_PERCENT'),
    );

export const getSessionRefreshCsCohortPercent = () =>
    parseCohortPercent(
        'SESSION_REFRESH_CS_COHORT_PERCENT',
        requiredInProduction('SESSION_REFRESH_CS_COHORT_PERCENT'),
    );

export const getSessionRefreshAdminCohortPercent = () =>
    parseCohortPercent(
        'SESSION_REFRESH_ADMIN_COHORT_PERCENT',
        requiredInProduction('SESSION_REFRESH_ADMIN_COHORT_PERCENT'),
    );

export const getSessionRefreshOwnerCohortPercent = () =>
    parseCohortPercent(
        'SESSION_REFRESH_OWNER_COHORT_PERCENT',
        requiredInProduction('SESSION_REFRESH_OWNER_COHORT_PERCENT'),
    );

export const getLegacyAccessTokenAcceptUntilMs = () =>
    parseUtcInstant(requiredInProduction('LEGACY_ACCESS_TOKEN_ACCEPT_UNTIL', true));

export const isLegacyAccessTokenCutoffPassed = (nowMs = Date.now()) => {
    const until = getLegacyAccessTokenAcceptUntilMs();
    // No cutoff means no legacy compatibility, rather than indefinite acceptance.
    return until === null || nowMs >= until;
};

/** Deterministic 0–99 bucket; shared with Rust `member_in_refresh_cohort`. */
export const memberInRefreshCohort = (userId: string, percent = getSessionRefreshMemberCohortPercent()) => {
    if (percent >= 100) return true;
    if (percent <= 0) return false;
    let hash = 0;
    for (let i = 0; i < userId.length; i += 1) {
        hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
    }
    return (hash % 100) < percent;
};

export const roleInRefreshCohort = (role: string, userId: string) => {
    if (!isSessionRefreshEnabled()) return false;
    switch (role) {
        case 'member':
            return memberInRefreshCohort(userId, getSessionRefreshMemberCohortPercent());
        case 'cs':
        case 'staff':
            return memberInRefreshCohort(userId, getSessionRefreshCsCohortPercent());
        case 'admin':
            return memberInRefreshCohort(userId, getSessionRefreshAdminCohortPercent());
        case 'owner':
            return memberInRefreshCohort(userId, getSessionRefreshOwnerCohortPercent());
        default:
            return false;
    }
};

/** Bounded forced-login reasons (low cardinality; never credentials). */
export type ForcedLoginReason =
    | 'session_expired'
    | 'session_revoked'
    | 'refresh_reused'
    | 'account_disabled'
    | 'token_invalid'
    | 'recovery_expired';

const FORCED_LOGIN_REASONS = new Set<ForcedLoginReason>([
    'session_expired',
    'session_revoked',
    'refresh_reused',
    'account_disabled',
    'token_invalid',
    'recovery_expired',
]);

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
    const bounded = FORCED_LOGIN_REASONS.has(reason as ForcedLoginReason)
        ? reason
        : 'token_invalid';
    // Low-cardinality counter label only — never user IDs, tokens, or bodies.
    log?.info?.(
        { metric: 'auth_forced_login', reason: bounded },
        'security metric',
    );
};
