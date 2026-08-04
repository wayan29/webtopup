export type GuestAuthEntry = 'pending' | 'authenticated-on-entry' | 'guest-on-entry';

/**
 * Capture the first settled authentication state observed by a guest-only route.
 * Once captured, the entry classification is immutable for that route mount.
 */
export const captureGuestAuthEntry = (
    previous: GuestAuthEntry,
    isAuthLoading: boolean,
    isAuthenticated: boolean,
): GuestAuthEntry => {
    if (previous !== 'pending' || isAuthLoading) return previous;
    return isAuthenticated ? 'authenticated-on-entry' : 'guest-on-entry';
};

/**
 * Only a session that existed when the route settled belongs to the route guard.
 * A session created later belongs to the mounted login screen's continuation effect.
 */
export const guestRouteShouldRedirect = (
    entry: GuestAuthEntry,
    isAuthenticated: boolean,
): boolean => entry === 'authenticated-on-entry' && isAuthenticated;
