const EXACT_PUBLIC_PATHS = new Set([
    '/',
    '/products',
    '/order',
    '/check-transaction',
    '/leaderboard',
    '/articles',
    '/login',
    '/register',
    '/staff/login',
]);

const SEGMENT_PUBLIC_PREFIXES = ['/order', '/articles'];

/**
 * Normalize only a browser pathname, not an arbitrary URL. Ambiguous or encoded separators fail
 * closed so near-misses cannot inherit public bootstrap behavior.
 */
function normalizeAppPathname(pathname: string): string | null {
    if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.startsWith('//')) {
        return null;
    }
    if (pathname.includes('?') || pathname.includes('#') || pathname.includes('\\')) {
        return null;
    }
    let decoded: string;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        return null;
    }
    if (decoded.includes('\\') || decoded.includes('//')) return null;

    const rawSegments = decoded.split('/').slice(1);
    if (rawSegments.some((segment) => segment === '.' || segment === '..')) return null;
    const normalized = `/${rawSegments.filter(Boolean).join('/')}`;
    return normalized === '/' ? '/' : normalized.replace(/\/$/, '');
}

export function isPublicAppPath(pathname: string): boolean {
    const normalized = normalizeAppPathname(pathname);
    if (!normalized) return false;
    if (EXACT_PUBLIC_PATHS.has(normalized)) return true;
    return SEGMENT_PUBLIC_PREFIXES.some((prefix) => normalized.startsWith(`${prefix}/`));
}

export function publicBootstrapFailureView(
    pathname: string,
    status: number | undefined,
    hasSurvivingSession = false,
): 'anonymous' | 'rate-limited' | 'preserve-session' {
    if (status === 429 && hasSurvivingSession) return 'preserve-session';
    return status === 429 && isPublicAppPath(pathname) ? 'anonymous' : 'rate-limited';
}
