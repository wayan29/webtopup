export const TEAM_PERMISSION_KEYS = [
    'viewDashboard',
    'viewReports',
    'viewTransactions',
    'processManualTransaction',
    'viewDeposits',
    'approveDeposits',
    'viewProducts',
    'manageProducts',
    'manageVouchers',
    'viewPayment',
    'managePayment',
    'viewUsers',
    'manageUsers',
    'viewTeam',
    'manageTeam',
    'viewSettings',
    'manageSettings',
    'viewVendors',
    'manageVendors',
] as const;

export type TeamPermissionKey = typeof TEAM_PERMISSION_KEYS[number];
export type TeamPermissionInput =
    | Readonly<Partial<Record<TeamPermissionKey, unknown>>>
    | null
    | undefined;
export type TeamPermissions = Record<TeamPermissionKey, boolean>;
export type TeamRole = 'owner' | 'admin' | 'cs';

export type TeamAccessAudience = 'permission' | 'team-member' | 'owner';
export type TeamAccessLevel = 'view' | 'manage' | 'action';
export type TeamAccessStatus =
    | 'available'
    | 'step-up'
    | 'owner-only'
    | 'role-limited'
    | 'suspended'
    | 'unavailable';

export type TeamAccessGroupId =
    | 'dashboard-reports'
    | 'transactions'
    | 'deposits'
    | 'catalog'
    | 'payments'
    | 'members'
    | 'team-audit'
    | 'settings-vendors'
    | 'self';

export type TeamAccessGroup = {
    id: TeamAccessGroupId;
    label: string;
};

export const TEAM_ACCESS_GROUPS: readonly TeamAccessGroup[] = [
    { id: 'dashboard-reports', label: 'Dashboard & Laporan' },
    { id: 'transactions', label: 'Transaksi' },
    { id: 'deposits', label: 'Deposit' },
    { id: 'catalog', label: 'Produk & Kampanye' },
    { id: 'payments', label: 'Pembayaran' },
    { id: 'members', label: 'Member' },
    { id: 'team-audit', label: 'Tim & Audit' },
    { id: 'settings-vendors', label: 'Settings & Vendor' },
    { id: 'self', label: 'Keamanan pribadi' },
];

export type TeamAccessMember = {
    role: TeamRole;
    active: boolean;
    permissions: TeamPermissionInput;
};

export type EffectiveTeamAccess = {
    id: string;
    groupId: TeamAccessGroupId;
    label: string;
    detail: string;
    audience: TeamAccessAudience;
    level: TeamAccessLevel;
    status: TeamAccessStatus;
    permission?: TeamPermissionKey;
    route?: string;
    requiresStepUp: boolean;
};

const IMPLICATIONS: Partial<Record<TeamPermissionKey, readonly TeamPermissionKey[]>> = {
    approveDeposits: ['viewDeposits'],
    manageProducts: ['viewProducts', 'manageVouchers'],
    managePayment: ['viewPayment'],
    manageUsers: ['viewUsers'],
    manageTeam: ['viewTeam'],
    manageSettings: ['viewSettings'],
    manageVendors: ['viewVendors'],
};

const emptyTeamPermissions = (): TeamPermissions => Object.fromEntries(
    TEAM_PERMISSION_KEYS.map((key) => [key, false]),
) as TeamPermissions;

export function normalizeTeamPermissions(input: TeamPermissionInput): TeamPermissions {
    const permissions = emptyTeamPermissions();
    if (input && typeof input === 'object') {
        for (const key of TEAM_PERMISSION_KEYS) {
            permissions[key] = input[key] === true;
        }
    }

    let changed = true;
    while (changed) {
        changed = false;
        for (const source of TEAM_PERMISSION_KEYS) {
            if (!permissions[source]) continue;
            for (const implied of IMPLICATIONS[source] ?? []) {
                if (!permissions[implied]) {
                    permissions[implied] = true;
                    changed = true;
                }
            }
        }
    }

    return permissions;
}

export function resolveEffectiveTeamPermissions(
    role: TeamRole,
    input: TeamPermissionInput,
): TeamPermissions {
    if (role === 'owner') {
        return Object.fromEntries(TEAM_PERMISSION_KEYS.map((key) => [key, true])) as TeamPermissions;
    }
    return normalizeTeamPermissions(input);
}

type AccessDefinition = Omit<EffectiveTeamAccess, 'status'> & {
    ownerOnly?: boolean;
    enabledBy?: TeamPermissionKey;
};

const permissionDefinition = (
    definition: Omit<AccessDefinition, 'audience' | 'permission' | 'ownerOnly'> & {
        permission: TeamPermissionKey;
    },
): AccessDefinition => ({
    ...definition,
    audience: 'permission',
    permission: definition.permission,
    enabledBy: definition.permission,
});

const ownerDefinition = (
    definition: Omit<AccessDefinition, 'audience' | 'ownerOnly'>,
): AccessDefinition => ({
    ...definition,
    audience: 'owner',
    ownerOnly: true,
});

const selfDefinition = (
    definition: Omit<AccessDefinition, 'audience'>,
): AccessDefinition => ({
    ...definition,
    audience: 'team-member',
});

const ACCESS_DEFINITIONS: readonly AccessDefinition[] = [
    permissionDefinition({
        id: 'dashboard.view', groupId: 'dashboard-reports', label: 'Dashboard',
        detail: 'Melihat ringkasan operasional', level: 'view', permission: 'viewDashboard',
        route: '/admin/dashboard', requiresStepUp: false,
    }),
    permissionDefinition({
        id: 'notifications.view', groupId: 'dashboard-reports', label: 'Notifikasi',
        detail: 'Melihat notifikasi admin', level: 'view', permission: 'viewDashboard',
        route: '/admin/notifications', requiresStepUp: false,
    }),
    permissionDefinition({
        id: 'reports.sales', groupId: 'dashboard-reports', label: 'Laporan penjualan',
        detail: 'Melihat laporan penjualan', level: 'view', permission: 'viewReports',
        route: '/admin/sales-report', requiresStepUp: false,
    }),
    permissionDefinition({
        id: 'reports.promo', groupId: 'dashboard-reports', label: 'Laporan promo',
        detail: 'Melihat biaya dan performa kampanye', level: 'view', permission: 'viewReports',
        route: '/admin/promo-report', requiresStepUp: false,
    }),
    permissionDefinition({
        id: 'transactions.view', groupId: 'transactions', label: 'Lihat transaksi',
        detail: 'Melihat daftar dan detail transaksi', level: 'view', permission: 'viewTransactions',
        route: '/admin/transactions', requiresStepUp: false,
    }),
    permissionDefinition({
        id: 'transactions.guest-view', groupId: 'transactions', label: 'Lihat transaksi guest',
        detail: 'Melihat transaksi guest', level: 'view', permission: 'viewTransactions',
        route: '/admin/transactions/guest', requiresStepUp: false,
    }),
    permissionDefinition({
        id: 'transactions.manual', groupId: 'transactions', label: 'Transaksi manual',
        detail: 'Memproses transaksi manual', level: 'action', permission: 'processManualTransaction',
        route: '/admin/transactions/manual', requiresStepUp: false,
    }),
    permissionDefinition({
        id: 'transactions.status', groupId: 'transactions', label: 'Status transaksi',
        detail: 'Menjalankan recheck/status action', level: 'action', permission: 'processManualTransaction',
        requiresStepUp: true,
    }),
    permissionDefinition({
        id: 'transactions.refund', groupId: 'transactions', label: 'Refund transaksi',
        detail: 'Menjalankan refund transaksi', level: 'action', permission: 'processManualTransaction',
        requiresStepUp: true,
    }),
    permissionDefinition({
        id: 'deposits.view', groupId: 'deposits', label: 'Lihat deposit',
        detail: 'Melihat daftar dan detail deposit', level: 'view', permission: 'viewDeposits',
        route: '/admin/deposits', requiresStepUp: false,
    }),
    permissionDefinition({
        id: 'deposits.claim', groupId: 'deposits', label: 'Klaim deposit',
        detail: 'Mengambil atau melepas antrean deposit', level: 'action', permission: 'approveDeposits',
        requiresStepUp: false,
    }),
    permissionDefinition({
        id: 'deposits.approve', groupId: 'deposits', label: 'Approve/reject deposit',
        detail: 'Menyetujui atau menolak deposit', level: 'action', permission: 'approveDeposits',
        requiresStepUp: true,
    }),
    permissionDefinition({
        id: 'catalog.read', groupId: 'catalog', label: 'Lihat katalog',
        detail: 'Membaca produk dan master katalog', level: 'view', permission: 'viewProducts',
        route: '/admin/products', requiresStepUp: false,
    }),
    permissionDefinition({
        id: 'catalog.manage', groupId: 'catalog', label: 'Kelola katalog',
        detail: 'Membuat, mengubah, menghapus, dan mengurutkan katalog', level: 'manage', permission: 'manageProducts',
        requiresStepUp: false,
    }),
    permissionDefinition({
        id: 'catalog.flash-sales', groupId: 'catalog', label: 'Kelola flash sale',
        detail: 'Mengelola kampanye flash sale', level: 'manage', permission: 'manageProducts',
        route: '/admin/flash-sales', requiresStepUp: false,
    }),
    permissionDefinition({
        id: 'catalog.rewards', groupId: 'catalog', label: 'Kelola hadiah',
        detail: 'Mengelola loyalty dan hadiah', level: 'manage', permission: 'manageProducts',
        route: '/admin/rewards', requiresStepUp: false,
    }),
    permissionDefinition({
        id: 'catalog.margin-data', groupId: 'catalog', label: 'Lihat data margin',
        detail: 'Membaca data margin untuk permukaan produk', level: 'view', permission: 'viewProducts',
        requiresStepUp: false,
    }),
    permissionDefinition({
        id: 'catalog.margin-manage', groupId: 'catalog', label: 'Kelola margin',
        detail: 'Membuka dan mengubah pengaturan margin', level: 'manage', permission: 'manageProducts',
        route: '/admin/margins', requiresStepUp: false,
    }),
    permissionDefinition({
        id: 'campaigns.vouchers', groupId: 'catalog', label: 'Kelola voucher',
        detail: 'Mengelola voucher saldo dan giveaway', level: 'manage', permission: 'manageVouchers',
        route: '/admin/vouchers', requiresStepUp: false,
    }),
    permissionDefinition({
        id: 'campaigns.giveaway-execute', groupId: 'catalog', label: 'Eksekusi giveaway',
        detail: 'Menjalankan kredit giveaway dengan transaksi atomik', level: 'action', permission: 'manageVouchers',
        requiresStepUp: true,
    }),
    permissionDefinition({
        id: 'payments.view', groupId: 'payments', label: 'Lihat pembayaran',
        detail: 'Melihat metode dan kategori pembayaran', level: 'view', permission: 'viewPayment',
        requiresStepUp: false,
    }),
    permissionDefinition({
        id: 'payments.manage', groupId: 'payments', label: 'Kelola pembayaran',
        detail: 'Mengelola metode dan kategori pembayaran', level: 'manage', permission: 'managePayment',
        requiresStepUp: false,
    }),
    permissionDefinition({
        id: 'payments.credentials', groupId: 'payments', label: 'Kredensial pembayaran',
        detail: 'Mengubah kredensial/payment settings sensitif', level: 'action', permission: 'managePayment',
        requiresStepUp: true,
    }),
    permissionDefinition({
        id: 'members.view', groupId: 'members', label: 'Lihat member',
        detail: 'Melihat profil dan riwayat member', level: 'view', permission: 'viewUsers',
        route: '/admin/users', requiresStepUp: false,
    }),
    permissionDefinition({
        id: 'members.manage', groupId: 'members', label: 'Kelola member',
        detail: 'Mengubah status dan data member', level: 'manage', permission: 'manageUsers',
        requiresStepUp: false,
    }),
    permissionDefinition({
        id: 'members.balance-adjust', groupId: 'members', label: 'Penyesuaian saldo member',
        detail: 'Mengubah saldo dengan idempotensi dan rate limit', level: 'action', permission: 'manageUsers',
        requiresStepUp: true,
    }),
    permissionDefinition({
        id: 'team.view', groupId: 'team-audit', label: 'Lihat tim',
        detail: 'Melihat anggota tim dan statusnya', level: 'view', permission: 'viewTeam',
        route: '/admin/teams', requiresStepUp: false,
    }),
    permissionDefinition({
        id: 'team.manage-cs', groupId: 'team-audit', label: 'Kelola akun CS',
        detail: 'Mengelola anggota tim dengan scope CS', level: 'manage', permission: 'manageTeam',
        requiresStepUp: false,
    }),
    ownerDefinition({
        id: 'team.manage-admin', groupId: 'team-audit', label: 'Kelola akun admin',
        detail: 'Membuat dan mengelola akun admin', level: 'manage',
        requiresStepUp: false,
    }),
    permissionDefinition({
        id: 'team.login-logs-cs', groupId: 'team-audit', label: 'Log login CS',
        detail: 'Melihat log login anggota CS', level: 'view', permission: 'manageTeam',
        requiresStepUp: false,
    }),
    ownerDefinition({
        id: 'team.login-logs-admin', groupId: 'team-audit', label: 'Log login admin',
        detail: 'Melihat log login akun admin', level: 'view',
        requiresStepUp: false,
    }),
    ownerDefinition({
        id: 'team.reset-2fa', groupId: 'team-audit', label: 'Reset 2FA anggota',
        detail: 'Mereset 2FA anggota tim lain', level: 'action',
        requiresStepUp: true,
    }),
    permissionDefinition({
        id: 'audit.view', groupId: 'team-audit', label: 'Lihat audit',
        detail: 'Melihat jejak perubahan admin', level: 'view', permission: 'viewTeam',
        route: '/admin/audit-logs', requiresStepUp: false,
    }),
    permissionDefinition({
        id: 'audit.export', groupId: 'team-audit', label: 'Export audit',
        detail: 'Mengekspor audit sensitif dengan step-up', level: 'action', permission: 'manageTeam',
        requiresStepUp: true,
    }),
    permissionDefinition({
        id: 'settings.manage', groupId: 'settings-vendors', label: 'Kelola settings',
        detail: 'Mengelola konfigurasi situs dan settings', level: 'manage', permission: 'manageSettings',
        route: '/admin/site-config', requiresStepUp: false,
    }),
    permissionDefinition({
        id: 'settings.validation', groupId: 'settings-vendors', label: 'Validasi produk',
        detail: 'Mengelola utilitas validasi dan taxonomy settings', level: 'manage', permission: 'manageSettings',
        route: '/admin/validation', requiresStepUp: false,
    }),
    permissionDefinition({
        id: 'vendors.manage', groupId: 'settings-vendors', label: 'Kelola vendor',
        detail: 'Mengelola integrasi dan pengaturan vendor', level: 'manage', permission: 'manageVendors',
        route: '/admin/addons', requiresStepUp: false,
    }),
    permissionDefinition({
        id: 'vendors.credentials', groupId: 'settings-vendors', label: 'Kredensial vendor',
        detail: 'Mengubah kredensial vendor', level: 'action', permission: 'manageVendors',
        requiresStepUp: true,
    }),
    permissionDefinition({
        id: 'vendors.internal-purchase', groupId: 'settings-vendors', label: 'Pembelian internal vendor',
        detail: 'Menjalankan operasi pembelian melalui vendor', level: 'action', permission: 'manageVendors',
        requiresStepUp: false,
    }),
    selfDefinition({
        id: 'self.profile-view', groupId: 'self', label: 'Lihat profil sendiri',
        detail: 'Melihat identitas akun staff sendiri', level: 'view',
        route: '/admin/profile', requiresStepUp: false,
    }),
    selfDefinition({
        id: 'self.profile-update', groupId: 'self', label: 'Ubah profil sendiri',
        detail: 'Mengubah identitas akun dengan verifikasi ulang', level: 'action',
        route: '/admin/profile', requiresStepUp: true,
    }),
    selfDefinition({
        id: 'self.password', groupId: 'self', label: 'Ubah password',
        detail: 'Mengubah password dengan verifikasi ulang', level: 'action',
        route: '/admin/profile', requiresStepUp: true,
    }),
    selfDefinition({
        id: 'self.sessions-view', groupId: 'self', label: 'Lihat sesi sendiri',
        detail: 'Melihat perangkat dan sesi aktif', level: 'view',
        route: '/admin/security', requiresStepUp: false,
    }),
    selfDefinition({
        id: 'self.sessions-revoke-one', groupId: 'self', label: 'Cabut satu sesi',
        detail: 'Mencabut satu sesi perangkat', level: 'action',
        route: '/admin/security', requiresStepUp: false,
    }),
    selfDefinition({
        id: 'self.sessions-revoke-all', groupId: 'self', label: 'Cabut semua sesi',
        detail: 'Mencabut semua sesi dengan verifikasi ulang', level: 'action',
        route: '/admin/security', requiresStepUp: true,
    }),
    selfDefinition({
        id: 'self.two-factor', groupId: 'self', label: 'Status dan enrollment 2FA',
        detail: 'Mengikuti alur enrollment 2FA sendiri', level: 'view',
        route: '/admin/security', requiresStepUp: false,
    }),
];

const GROUP_ORDER = new Map(TEAM_ACCESS_GROUPS.map((group, index) => [group.id, index]));

function statusForDefinition(
    definition: AccessDefinition,
    role: TeamRole,
    permissions: TeamPermissions,
): TeamAccessStatus {
    if (definition.ownerOnly) {
        return role === 'owner' ? (definition.requiresStepUp ? 'step-up' : 'available') : 'owner-only';
    }

    if (definition.audience === 'team-member') {
        return definition.requiresStepUp ? 'step-up' : 'available';
    }

    if (!definition.enabledBy || !permissions[definition.enabledBy]) {
        return 'unavailable';
    }

    return definition.requiresStepUp ? 'step-up' : 'available';
}

export function getEffectiveTeamAccess(member: TeamAccessMember): EffectiveTeamAccess[] {
    const permissions = resolveEffectiveTeamPermissions(member.role, member.permissions);
    return ACCESS_DEFINITIONS.map((definition) => {
        const status = statusForDefinition(definition, member.role, permissions);
        const effectiveStatus = !member.active && (status === 'available' || status === 'step-up')
            ? 'suspended'
            : status;
        const { ownerOnly: _ownerOnly, enabledBy: _enabledBy, ...access } = definition;
        return { ...access, status: effectiveStatus };
    });
}

export function summarizeEffectiveTeamAccess(
    access: readonly EffectiveTeamAccess[],
): {
    availableCount: number;
    managedCount: number;
    actionCount: number;
    stepUpCount: number;
    labels: string[];
    remainingGroupCount: number;
} {
    const eligible = access.filter((entry) => entry.status === 'available' || entry.status === 'step-up');
    const operational = eligible.filter((entry) => entry.groupId !== 'self');
    const groupIds = [...new Set(operational.map((entry) => entry.groupId))].sort((left, right) => (
        (GROUP_ORDER.get(left) ?? Number.MAX_SAFE_INTEGER) - (GROUP_ORDER.get(right) ?? Number.MAX_SAFE_INTEGER)
    ));
    const labels = groupIds.slice(0, 3).map((groupId) => (
        TEAM_ACCESS_GROUPS.find((group) => group.id === groupId)?.label
            ?? operational.find((entry) => entry.groupId === groupId)?.label
            ?? groupId
    ));

    return {
        availableCount: operational.length,
        managedCount: operational.filter((entry) => entry.level === 'manage').length,
        actionCount: operational.filter((entry) => entry.level === 'action').length,
        stepUpCount: eligible.filter((entry) => entry.status === 'step-up').length,
        labels,
        remainingGroupCount: Math.max(0, groupIds.length - labels.length),
    };
}
