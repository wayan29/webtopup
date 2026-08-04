export type PublicBottomTabId = 'home' | 'products' | 'check' | 'account';

export type PublicBottomTab = {
    id: PublicBottomTabId;
    label: string;
    /** Path used for navigation. Account is resolved separately for guest/member. */
    path?: string;
};

export const PUBLIC_BOTTOM_TABS: readonly PublicBottomTab[] = [
    { id: 'home', label: 'Beranda', path: '/' },
    { id: 'products', label: 'Produk', path: '/products' },
    { id: 'check', label: 'Cek', path: '/check-transaction' },
    { id: 'account', label: 'Akun' },
] as const;

/** Account destination depends on whether a member session is present. */
export const accountPathForAuth = (isAuthenticated: boolean) =>
    isAuthenticated ? '/dashboard' : '/login';

/**
 * Path-based active tab for the public mobile bottom nav.
 * Account covers login/register and the main member destinations under MainLayout.
 */
export const activePublicBottomTab = (pathname: string): PublicBottomTabId => {
    if (pathname === '/') return 'home';
    if (pathname === '/products' || pathname.startsWith('/products/')) return 'products';
    if (pathname === '/check-transaction' || pathname.startsWith('/check-transaction/')) return 'check';
    if (
        pathname === '/login' ||
        pathname === '/register' ||
        pathname === '/dashboard' ||
        pathname.startsWith('/dashboard/') ||
        pathname === '/deposit' ||
        pathname === '/redeem-voucher' ||
        pathname === '/credits' ||
        pathname === '/transactions' ||
        pathname === '/mutations' ||
        pathname === '/reports' ||
        pathname === '/settings' ||
        pathname === '/account' ||
        pathname.startsWith('/security/')
    ) {
        return 'account';
    }
    return 'home';
};

export const pathForPublicBottomTab = (
    tab: PublicBottomTabId,
    isAuthenticated: boolean,
): string => {
    switch (tab) {
        case 'home':
            return '/';
        case 'products':
            return '/products';
        case 'check':
            return '/check-transaction';
        case 'account':
            return accountPathForAuth(isAuthenticated);
    }
};
