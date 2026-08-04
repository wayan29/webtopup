/**
 * Login audience routing for the browser.
 *
 * The gateway and Rust own enforcement: each audience has its own fixed endpoint pair, and a
 * wrong-channel credential is rejected upstream with the generic credential message. These
 * helpers only decide which fixed surface the browser should use, so nothing here may derive
 * an audience from user-controlled input.
 */
export type LoginAudience = 'member' | 'staff';

export const MEMBER_LOGIN_PATH = '/login';
export const STAFF_LOGIN_PATH = '/staff/login';

const MEMBER_LANDING_PATH = '/dashboard';
const STAFF_LANDING_PATH = '/admin/dashboard';

const LOGIN_ENDPOINTS: Record<LoginAudience, string> = {
    member: '/auth/member/login',
    staff: '/auth/staff/login',
};

const LOGIN_PATHS: Record<LoginAudience, string> = {
    member: MEMBER_LOGIN_PATH,
    staff: STAFF_LOGIN_PATH,
};

const LANDING_PATHS: Record<LoginAudience, string> = {
    member: MEMBER_LANDING_PATH,
    staff: STAFF_LANDING_PATH,
};

export const loginEndpointForAudience = (audience: LoginAudience) => LOGIN_ENDPOINTS[audience];

export const loginPathForAudience = (audience: LoginAudience) => LOGIN_PATHS[audience];

export const loginLandingPath = (audience: LoginAudience) => LANDING_PATHS[audience];

const STAFF_ROLES = new Set(['owner', 'admin', 'cs']);

/**
 * Map a session role to its channel. Only the exact staff roles are promoted; the literal
 * string 'staff' is not a role and must not grant the staff channel.
 */
export const audienceForRole = (role: string | null | undefined): LoginAudience =>
    role && STAFF_ROLES.has(role) ? 'staff' : 'member';

/** Staff sessions have a fixed 8h ceiling upstream, so the option is member-only. */
export const allowsRememberMe = (audience: LoginAudience) => audience === 'member';

const pathnameOf = (candidate: string) => candidate.split(/[?#]/, 1)[0];

/**
 * Reject anything whose routed pathname could differ from the literal text we classify.
 *
 * The browser normalizes percent-encoded dot segments before routing, so a raw-substring check
 * on `/%2e%2e/admin` would classify it as a member path while the router lands on `/admin`.
 * Rather than trying to out-guess normalization, refuse encoded structural characters and any
 * candidate that is not already canonical.
 */
const hasSafeCanonicalPath = (candidate: string): boolean => {
    const pathname = pathnameOf(candidate);
    // Percent-encoded separators, dots, backslashes and NULs are the traversal primitives here.
    if (/%(?:2e|2f|5c|00)/i.test(pathname)) return false;
    // Malformed or partial escapes normalize inconsistently across browsers.
    if (/%(?![0-9a-f]{2})/i.test(pathname)) return false;
    if (pathname.split('/').some((segment) => segment === '.' || segment === '..')) return false;

    let routed: URL;
    try {
        routed = new URL(candidate, 'https://internal.invalid');
    } catch {
        return false;
    }
    // Only a candidate that survives normalization unchanged can be classified from its text.
    return routed.pathname === pathname;
};

/** Admin surfaces are staff-only; everything else belongs to the member channel. */
export const audienceForProtectedPath = (candidate: string): LoginAudience => {
    const pathname = pathnameOf(candidate);
    return pathname === '/admin' || pathname.startsWith('/admin/') ? 'staff' : 'member';
};

/**
 * Accept only a same-site path that belongs to the requesting audience. Anything else returns
 * null so callers fall back to the audience landing page instead of following a hostile or
 * cross-channel destination.
 */
export const sanitizeLoginReturnTo = (audience: LoginAudience, candidate: string | null | undefined): string | null => {
    if (!candidate) return null;
    if (!candidate.startsWith('/') || candidate.startsWith('//')) return null;
    // Backslashes and control characters are normalized differently across browsers, and a
    // protocol-like prefix must never survive; refuse instead of trying to rewrite them.
    if (/[\\\u0000-\u001f\u007f]/.test(candidate)) return null;
    if (/^\/+[a-z][a-z0-9+.-]*:/i.test(candidate)) return null;
    if (!hasSafeCanonicalPath(candidate)) return null;

    const pathname = pathnameOf(candidate);
    if (pathname === MEMBER_LOGIN_PATH || pathname === STAFF_LOGIN_PATH || pathname === '/register') return null;
    if (audienceForProtectedPath(pathname) !== audience) return null;

    return candidate;
};

export const postLoginPath = (audience: LoginAudience, candidate: string | null | undefined) =>
    sanitizeLoginReturnTo(audience, candidate) ?? loginLandingPath(audience);

const RETURN_TO_PARAM = 'returnTo';

/**
 * Build the login URL a guard should redirect to, preserving the attempted destination only
 * when it is same-site and belongs to the same audience. The landing page is omitted because
 * it is already the fallback.
 */
export const loginPathWithReturnTo = (audience: LoginAudience, candidate: string | null | undefined) => {
    const loginPath = loginPathForAudience(audience);
    const safe = sanitizeLoginReturnTo(audience, candidate);
    if (!safe || safe === loginLandingPath(audience)) return loginPath;
    return `${loginPath}?${RETURN_TO_PARAM}=${encodeURIComponent(safe)}`;
};

/** Read a returnTo value from a login URL, re-sanitizing it after decoding. */
export const readReturnTo = (audience: LoginAudience, search: string): string | null => {
    let params: URLSearchParams;
    try {
        params = new URLSearchParams(search);
    } catch {
        return null;
    }
    // The decoded value is untrusted input like any other: sanitize it again before use.
    return sanitizeLoginReturnTo(audience, params.get(RETURN_TO_PARAM));
};
