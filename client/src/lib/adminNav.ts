import type { LucideIcon } from 'lucide-react';
import {
    CheckCircle,
    CreditCard,
    Gift,
    History,
    LayoutDashboard,
    ListChecks,
    Package,
    Puzzle,
    Settings2,
    ShieldCheck,
    Signal,
    SlidersHorizontal,
    Ticket,
    TrendingUp,
    UserRound
} from 'lucide-react';

export type AdminBadgeKey =
    | 'payment'
    | 'deposits'
    | 'transactions'
    | 'transactionsManual'
    | 'transactionsGuest'
    | 'notifications';

export type AdminPermissionKey =
    | 'viewDashboard'
    | 'viewReports'
    | 'viewDeposits'
    | 'viewProducts'
    | 'manageProducts'
    | 'manageVouchers'
    | 'viewPayment'
    | 'managePayment'
    | 'manageSettings'
    | 'manageVendors'
    | 'viewTransactions'
    | 'processManualTransaction'
    | 'viewUsers'
    | 'manageUsers'
    | 'viewTeam'
    | 'manageTeam';

export type AdminNavBlueprintSubItem = {
    name: string;
    path: string;
    permission?: AdminPermissionKey;
    subtitle?: string;
    badgeKey?: AdminBadgeKey;
};

export type AdminNavBlueprintItem = {
    name: string;
    path?: string;
    icon: LucideIcon;
    permission?: AdminPermissionKey;
    id?: string;
    subtitle?: string;
    section?: string;
    badgeKey?: AdminBadgeKey;
    submenu?: AdminNavBlueprintSubItem[];
};

export type AdminRoutePermissionRule = {
    /** Stable identity used to prove the declared route and actual location resolve identically. */
    id: string;
    match: (pathname: string) => boolean;
    permission?: AdminPermissionKey;
    /** When true, any authenticated team member may access (e.g. security self-service). */
    teamMemberOnly?: boolean;
};

export const ADMIN_NAV_BLUEPRINT: AdminNavBlueprintItem[] = [
    {
        name: 'Dashboard',
        path: '/admin/dashboard',
        icon: LayoutDashboard,
        permission: 'viewDashboard',
        section: 'Overview',
        subtitle: 'Ringkasan cepat operasional'
    },
    {
        name: 'Laporan Penjualan',
        path: '/admin/sales-report',
        icon: TrendingUp,
        permission: 'viewReports',
        section: 'Overview',
        subtitle: 'Analitik omset dan performa'
    },
    {
        name: 'Laporan Promo',
        path: '/admin/promo-report',
        icon: Gift,
        permission: 'viewReports',
        section: 'Overview',
        subtitle: 'Biaya voucher, giveaway, flash sale'
    },
    {
        name: 'Kampanye',
        icon: Ticket,
        id: 'kampanye',
        section: 'Overview',
        subtitle: 'Flash sale, voucher, giveaway',
        submenu: [
            { name: 'Flash Sale', path: '/admin/flash-sales', permission: 'manageProducts', subtitle: 'Promo berbatas waktu' },
            { name: 'Voucher & Giveaway', path: '/admin/vouchers', permission: 'manageVouchers', subtitle: 'Kode saldo, diskon, undian' },
            { name: 'Laporan Promo', path: '/admin/promo-report', permission: 'viewReports', subtitle: 'Biaya kampanye' },
        ],
    },
    {
        name: 'Transaksi',
        icon: History,
        permission: 'viewTransactions',
        id: 'transactions',
        section: 'Transaksi',
        subtitle: 'Monitor transaksi dan antrian tindakan',
        badgeKey: 'transactions',
        submenu: [
            {
                name: 'Transaksi Manual',
                path: '/admin/transactions/manual',
                permission: 'processManualTransaction',
                subtitle: 'Antrean transaksi yang butuh tindakan',
                badgeKey: 'transactionsManual'
            },
            {
                name: 'Transaksi Guest',
                path: '/admin/transactions/guest',
                permission: 'viewTransactions',
                subtitle: 'Kelola pembayaran dan fulfillment guest',
                badgeKey: 'transactionsGuest'
            },
            {
                name: 'Semua Transaksi',
                path: '/admin/transactions',
                permission: 'viewTransactions',
                subtitle: 'Seluruh transaksi saldo'
            }
        ]
    },
    {
        name: 'Pembayaran',
        icon: CreditCard,
        permission: 'viewPayment',
        id: 'payment',
        section: 'Pembayaran',
        subtitle: 'Kategori, metode, dan verifikasi',
        badgeKey: 'payment',
        submenu: [
            // Setup order: kategori dulu (induk metode), lalu metode, baru deposit operasional.
            {
                name: '1. Kategori',
                path: '/admin/payment-categories',
                permission: 'managePayment',
                subtitle: 'Buat dulu — induk metode'
            },
            {
                name: '2. Metode',
                path: '/admin/payment-methods',
                permission: 'managePayment',
                subtitle: 'Setelah kategori — kanal bayar'
            },
            {
                name: '3. Deposit',
                path: '/admin/deposits',
                permission: 'viewDeposits',
                subtitle: 'Operasional — verifikasi deposit member',
                badgeKey: 'deposits'
            }
        ]
    },
    {
        name: 'Produk',
        icon: Package,
        permission: 'viewProducts',
        id: 'produk',
        section: 'Catalog',
        subtitle: 'Struktur kategori, operator, dan item',
        submenu: [
            // Setup order: master data first, then sellable items, promo, then integrity check.
            { name: '1. Kategori Produk', path: '/admin/product-categories', permission: 'manageProducts', subtitle: 'Buat dulu — induk katalog' },
            { name: '2. Operator Produk', path: '/admin/product-operators', permission: 'manageProducts', subtitle: 'Setelah kategori — brand/operator' },
            { name: '3. Jenis Produk', path: '/admin/product-types', permission: 'manageProducts', subtitle: 'Setelah operator — tipe item' },
            { name: '4. List Produk', path: '/admin/products', permission: 'viewProducts', subtitle: 'Setelah master lengkap — SKU jual' },
            { name: '5. Flash Sale', path: '/admin/flash-sales', permission: 'manageProducts', subtitle: 'Opsional — promo di atas produk' },
            { name: '6. Audit Katalog', path: '/admin/catalog-audit', permission: 'manageProducts', subtitle: 'Cek relasi & master kosong' },
        ]
    },
    {
        name: 'Poin & Hadiah',
        path: '/admin/rewards',
        icon: Gift,
        permission: 'manageProducts',
        section: 'Catalog',
        subtitle: 'Kelola loyalty dan redeem'
    },
    {
        name: 'Vouchers',
        path: '/admin/vouchers',
        icon: Ticket,
        permission: 'manageVouchers',
        section: 'Catalog',
        subtitle: 'Voucher saldo dan redeem'
    },
    {
        name: 'Margin',
        path: '/admin/margins',
        icon: TrendingUp,
        permission: 'manageProducts',
        section: 'Catalog',
        subtitle: 'Atur margin global produk'
    },
    {
        name: 'Pengguna',
        path: '/admin/users',
        icon: UserRound,
        permission: 'viewUsers',
        section: 'Operasional',
        subtitle: 'Kelola member dan saldo'
    },
    {
        name: 'Tim',
        path: '/admin/teams',
        icon: ShieldCheck,
        permission: 'viewTeam',
        section: 'Operasional',
        subtitle: 'Kelola admin, CS, dan audit tim'
    },
    {
        name: 'Log Audit',
        path: '/admin/audit-logs',
        icon: ListChecks,
        permission: 'viewTeam',
        section: 'Operasional',
        subtitle: 'Jejak perubahan panel admin'
    },
    {
        name: 'Konfigurasi Situs',
        path: '/admin/site-config',
        icon: Settings2,
        permission: 'manageSettings',
        section: 'Sistem',
        subtitle: 'Konfigurasi brand dan runtime'
    },
    {
        name: 'Add Ons',
        icon: Puzzle,
        permission: 'manageVendors',
        id: 'addons',
        section: 'Sistem',
        subtitle: 'Integrasi vendor dan ekstensi',
        submenu: [
            { name: 'Ringkasan Add Ons', path: '/admin/addons', permission: 'manageVendors', subtitle: 'Ringkasan integrasi aktif' },
            { name: 'Digiflazz', path: '/admin/addons/digiflazz', permission: 'manageVendors', subtitle: 'Provider Digiflazz' },
            { name: 'Digiflazz Seller', path: '/admin/addons/digiflazz-seller', permission: 'manageVendors', subtitle: 'Seller API Digiflazz' },
            { name: 'IRS Seller', path: '/admin/addons/irs-seller', permission: 'manageVendors', subtitle: 'Seller channel IRS' },
            { name: 'Tokovoucher', path: '/admin/addons/tokovoucher', permission: 'manageVendors', subtitle: 'Provider Tokovoucher' }
        ]
    },
    {
        name: 'Kesehatan Vendor',
        path: '/admin/vendor-health',
        icon: Signal,
        permission: 'manageVendors',
        section: 'Sistem',
        subtitle: 'Monitoring vendor'
    },
    {
        name: 'Slider',
        path: '/admin/sliders',
        icon: SlidersHorizontal,
        permission: 'manageSettings',
        section: 'Sistem',
        subtitle: 'Kelola banner dan slider'
    },
    {
        name: 'Validasi',
        path: '/admin/validation',
        icon: CheckCircle,
        permission: 'manageSettings',
        section: 'Sistem',
        subtitle: 'Validasi akun game dan utilitas'
    }
];

export const ADMIN_DEFAULT_MENU_ORDER = ADMIN_NAV_BLUEPRINT.map((item) => item.name);

export const ADMIN_LEGACY_DEFAULT_MENU_ORDER = [
    'Dashboard',
    'Laporan Penjualan',
    'Poin & Hadiah',
    'Produk',
    'Pembayaran',
    'Payment',
    'Slider',
    'Add Ons',
    'Margin',
    'Konfigurasi Situs',
    'Site Config',
    'Transaksi',
    'Transactions',
    'Vouchers',
    'Pengguna',
    'Users',
    'Tim',
    'Validasi'
];

export const ADMIN_MENU_NAME_ALIASES: Record<string, string> = {
    Transactions: 'Transaksi',
    Payment: 'Pembayaran',
    Users: 'Pengguna',
    'Audit Logs': 'Log Audit',
    Security: 'Keamanan',
    'Site Config': 'Konfigurasi Situs',
    'Vendor Health': 'Kesehatan Vendor',
    Deposits: 'Deposit'
};

export const ADMIN_DEFAULT_EXPANDED_MENUS: Record<string, boolean> = {
    produk: true,
    payment: true,
    transactions: true,
    addons: true,
    kampanye: true,
};

/**
 * Single source of truth for admin route permission expectations.
 * Keep this aligned with client/src/App.tsx AdminPermissionRoute wrappers.
 */
const isExactOrDescendant = (pathname: string, basePath: string) => (
    pathname === basePath || pathname.startsWith(`${basePath}/`)
);

export const normalizeAdminBadgeCount = (value: unknown) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
};

/**
 * Header route metadata for admin routes that intentionally have no sidebar entry.
 * Kept separate from ADMIN_NAV_BLUEPRINT so a header-only route (notifications)
 * does not fall back to generated English titles once it leaves the sidebar.
 */
export type AdminRoutePresentation = {
    eyebrow: string;
    title: string;
    subtitle: string;
};

const ADMIN_ROUTE_PRESENTATIONS: Array<{
    id: string;
    match: (pathname: string) => boolean;
    meta: AdminRoutePresentation;
}> = [
    {
        id: 'notifications',
        match: (pathname) => isExactOrDescendant(pathname, '/admin/notifications'),
        meta: {
            eyebrow: 'Overview',
            title: 'Notifikasi',
            subtitle: 'Alert aktif operasional'
        }
    },
    {
        id: 'profile',
        match: (pathname) => isExactOrDescendant(pathname, '/admin/profile'),
        meta: {
            eyebrow: 'Operasional',
            title: 'Akun Saya',
            subtitle: 'Profil, password, dan 2FA'
        }
    }
];

export const getAdminRoutePresentation = (pathname: string): AdminRoutePresentation | undefined => (
    ADMIN_ROUTE_PRESENTATIONS.find((rule) => rule.match(pathname))?.meta
);

/** Visual badge text; counts above 99 collapse so header width stays stable. */
export const formatAdminBadgeCount = (count: number) => (count > 99 ? '99+' : `${count}`);

export const getAdminNotificationLabel = (count: number) => (
    count > 0
        ? `Notifikasi admin, ${count} belum dibaca`
        : 'Notifikasi admin, tidak ada yang belum dibaca'
);

export const ADMIN_ROUTE_PERMISSIONS: AdminRoutePermissionRule[] = [
    { id: 'dashboard', match: (pathname) => pathname === '/admin' || isExactOrDescendant(pathname, '/admin/dashboard'), permission: 'viewDashboard' },
    { id: 'sales-report', match: (pathname) => isExactOrDescendant(pathname, '/admin/sales-report'), permission: 'viewReports' },
    { id: 'promo-report', match: (pathname) => isExactOrDescendant(pathname, '/admin/promo-report'), permission: 'viewReports' },
    { id: 'notifications', match: (pathname) => isExactOrDescendant(pathname, '/admin/notifications'), permission: 'viewDashboard' },
    { id: 'transactions-manual', match: (pathname) => isExactOrDescendant(pathname, '/admin/transactions/manual'), permission: 'processManualTransaction' },
    { id: 'transactions-guest', match: (pathname) => isExactOrDescendant(pathname, '/admin/transactions/guest'), permission: 'viewTransactions' },
    { id: 'transactions', match: (pathname) => isExactOrDescendant(pathname, '/admin/transactions'), permission: 'viewTransactions' },
    { id: 'deposits', match: (pathname) => isExactOrDescendant(pathname, '/admin/deposits'), permission: 'viewDeposits' },
    { id: 'payment-methods', match: (pathname) => isExactOrDescendant(pathname, '/admin/payment-methods'), permission: 'managePayment' },
    { id: 'payment-categories', match: (pathname) => isExactOrDescendant(pathname, '/admin/payment-categories'), permission: 'managePayment' },
    { id: 'products', match: (pathname) => isExactOrDescendant(pathname, '/admin/products'), permission: 'viewProducts' },
    { id: 'flash-sales', match: (pathname) => isExactOrDescendant(pathname, '/admin/flash-sales'), permission: 'manageProducts' },
    { id: 'product-categories', match: (pathname) => isExactOrDescendant(pathname, '/admin/product-categories'), permission: 'manageProducts' },
    { id: 'product-operators', match: (pathname) => isExactOrDescendant(pathname, '/admin/product-operators'), permission: 'manageProducts' },
    { id: 'product-types', match: (pathname) => isExactOrDescendant(pathname, '/admin/product-types'), permission: 'manageProducts' },
    { id: 'catalog-audit', match: (pathname) => isExactOrDescendant(pathname, '/admin/catalog-audit'), permission: 'manageProducts' },
    { id: 'rewards', match: (pathname) => isExactOrDescendant(pathname, '/admin/rewards'), permission: 'manageProducts' },
    { id: 'margins', match: (pathname) => isExactOrDescendant(pathname, '/admin/margins'), permission: 'manageProducts' },
    { id: 'vouchers', match: (pathname) => isExactOrDescendant(pathname, '/admin/vouchers'), permission: 'manageVouchers' },
    { id: 'users', match: (pathname) => isExactOrDescendant(pathname, '/admin/users'), permission: 'viewUsers' },
    { id: 'teams', match: (pathname) => isExactOrDescendant(pathname, '/admin/teams'), permission: 'viewTeam' },
    { id: 'audit-logs', match: (pathname) => isExactOrDescendant(pathname, '/admin/audit-logs'), permission: 'viewTeam' },
    { id: 'security', match: (pathname) => isExactOrDescendant(pathname, '/admin/security'), teamMemberOnly: true },
    { id: 'profile', match: (pathname) => isExactOrDescendant(pathname, '/admin/profile'), teamMemberOnly: true },
    { id: 'site-config', match: (pathname) => isExactOrDescendant(pathname, '/admin/site-config'), permission: 'manageSettings' },
    { id: 'sliders', match: (pathname) => isExactOrDescendant(pathname, '/admin/sliders'), permission: 'manageSettings' },
    { id: 'validation', match: (pathname) => isExactOrDescendant(pathname, '/admin/validation'), permission: 'manageSettings' },
    { id: 'addons', match: (pathname) => isExactOrDescendant(pathname, '/admin/addons'), permission: 'manageVendors' },
    { id: 'vendor-health', match: (pathname) => isExactOrDescendant(pathname, '/admin/vendor-health'), permission: 'manageVendors' },
    { id: 'vendors', match: (pathname) => isExactOrDescendant(pathname, '/admin/vendors'), permission: 'manageVendors' }
];

export const getAdminRoutePermission = (pathname: string) => {
    // Keep ADMIN_ROUTE_PERMISSIONS ordered from specific paths to general prefixes.
    return ADMIN_ROUTE_PERMISSIONS.find((rule) => rule.match(pathname));
};

export const isAdminRoutePathActive = (pathname: string, routePath?: string) => {
    if (!routePath) return false;
    return pathname === routePath || pathname.startsWith(`${routePath}/`);
};


export const getPreferredAdminLandingPath = (
    canAccess: (permission?: AdminPermissionKey) => boolean
) => {
    // Prefer dashboard when allowed, otherwise first permitted menu path, else security.
    if (canAccess('viewDashboard')) {
        return '/admin/dashboard';
    }

    for (const item of ADMIN_NAV_BLUEPRINT) {
        if (item.path && canAccess(item.permission)) {
            return item.path;
        }
        for (const subItem of item.submenu || []) {
            if (canAccess(subItem.permission)) {
                return subItem.path;
            }
        }
    }

    // Every staff member can reach their own profile, so this is a safe universal fallback.
    return '/admin/profile';
};
