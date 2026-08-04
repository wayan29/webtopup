import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
    apiV2,
    attachIdempotencyKey,
    createIdempotencyKey,
    CRITICAL_MUTATION_AMBIGUOUS_MESSAGE,
    isAmbiguousMutationFailure,
} from '../../api';
import { useStepUpOrchestration } from '../../auth/useStepUpOrchestration';
import { stepUpActionErrorMessage } from '../../auth/withStepUp';
import { useAuthStore } from '../../store/useAuthStore';
import {
    ChevronLeft,
    ChevronRight,
    Edit,
    Filter,
    Key,
    MoreVertical,
    Power,
    PowerOff,
    RefreshCw,
    Save,
    Search,
    User as UserIcon,
    Wallet,
    X
} from 'lucide-react';

interface User {
    _id: string;
    name: string;
    email: string;
    level: 'basic' | 'gold' | 'platinum';
    balance: number;
    points: number;
    active: boolean;
    memberCode?: string;
    hasOpenApiKey?: boolean;
    createdAt: string;
    updatedAt: string;
}

interface PaginationInfo {
    currentPage: number;
    totalPages: number;
    totalUsers: number;
    pageSize: number;
}

interface UserSummary {
    totalMembers: number;
    activeMembers: number;
    inactiveMembers: number;
    totalBalance: number;
}

interface UserFilters {
    search: string;
    level: string;
    status: '' | 'active' | 'inactive';
    sortBy: 'createdAt' | 'updatedAt' | 'name' | 'email' | 'balance';
    sortOrder: 'asc' | 'desc';
}

interface BalanceAdjustmentLog {
    _id: string;
    type: 'add' | 'subtract';
    amount: number;
    balanceBefore: number;
    balanceAfter: number;
    reason: string;
    createdAt: string;
    adjustedBy?: {
        _id?: string;
        name?: string;
        email?: string;
        role?: string;
    } | null;
}

interface FeedbackState {
    type: 'success' | 'error';
    text: string;
}

const formatCurrency = (value: number) => `Rp${(Number.isFinite(value) ? value : 0).toLocaleString('id-ID')}`;

const isNegativeAmount = (value: number) => Number.isFinite(value) && value < 0;

const formatDate = (value: string) => new Date(value).toLocaleDateString('id-ID');

const formatDateTime = (value: string) => new Date(value).toLocaleString('id-ID');

const getErrorMessage = (error: unknown, fallback: string) => {
    const message = (error as { response?: { data?: { message?: string } } })?.response?.data?.message;
    return typeof message === 'string' && message.trim().length > 0 ? message : fallback;
};

const getLevelTone = (level: User['level']) => {
    switch (level) {
        case 'platinum':
            return 'ui-info-chip';
        case 'gold':
            return 'ui-warning-chip';
        default:
            return 'ui-panel ui-text-muted ui-border';
    }
};

export default function AdminUsers() {
    const stepUp = useStepUpOrchestration();
    const { hasPermission, isOwner } = useAuthStore();
    const [searchParams, setSearchParams] = useSearchParams();
    const canManageUsers = isOwner || hasPermission('manageUsers');

    const [users, setUsers] = useState<User[]>([]);
    const [loading, setLoading] = useState(true);
    const [feedback, setFeedback] = useState<FeedbackState | null>(null);
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editForm, setEditForm] = useState<{ name: string; email: string; level: User['level'] }>({
        name: '',
        email: '',
        level: 'basic'
    });
    const [pagination, setPagination] = useState<PaginationInfo>({
        currentPage: Math.max(1, Number(searchParams.get('page')) || 1),
        totalPages: 1,
        totalUsers: 0,
        pageSize: 10
    });
    const [summary, setSummary] = useState<UserSummary>({
        totalMembers: 0,
        activeMembers: 0,
        inactiveMembers: 0,
        totalBalance: 0
    });
    const [filters, setFilters] = useState<UserFilters>(() => ({
        search: searchParams.get('q') || '',
        level: searchParams.get('level') || '',
        status: searchParams.get('status') === 'active' || searchParams.get('status') === 'inactive'
            ? searchParams.get('status') as UserFilters['status']
            : '',
        sortBy: ['createdAt', 'updatedAt', 'name', 'email', 'balance'].includes(searchParams.get('sortBy') || '')
            ? searchParams.get('sortBy') as UserFilters['sortBy']
            : 'createdAt',
        sortOrder: searchParams.get('sortOrder') === 'asc' ? 'asc' : 'desc'
    }));
    const [showFilters, setShowFilters] = useState(false);
    const [actionMenuOpen, setActionMenuOpen] = useState<string | null>(null);
    const [menuPosition, setMenuPosition] = useState<{ top: number; left: number } | null>(null);
    const [showBalanceModal, setShowBalanceModal] = useState(false);
    const [selectedUser, setSelectedUser] = useState<User | null>(null);
    const [balanceForm, setBalanceForm] = useState({
        amount: '',
        type: 'add' as 'add' | 'subtract',
        reason: ''
    });
    const [auditLoading, setAuditLoading] = useState(false);
    const [recentAdjustments, setRecentAdjustments] = useState<BalanceAdjustmentLog[]>([]);
    const [submittingBalance, setSubmittingBalance] = useState(false);
    const [confirmStatusUser, setConfirmStatusUser] = useState<{ user: User; active: boolean } | null>(null);
    const [confirmRevokeOpenApiUser, setConfirmRevokeOpenApiUser] = useState<User | null>(null);
    const [revokingOpenApi, setRevokingOpenApi] = useState(false);
    /** Issued when the balance confirmation modal opens; cleared only on success/cancel. */
    const balanceIdempotencyKeyRef = useRef<string | null>(null);
    const latestRequestId = useRef(0);
    const fieldClass = 'w-full rounded-xl border px-3 py-2.5 text-sm ui-field';
    const compactFieldClass = 'w-full rounded-lg border px-3 py-2 text-sm ui-field';
    const mutedButtonClass = 'inline-flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm ui-muted-action';

    const activeFilterCount = useMemo(() => {
        return [filters.search, filters.level, filters.status].filter(Boolean).length;
    }, [filters.level, filters.search, filters.status]);

    const fetchUsers = useCallback(async (page = pagination.currentPage) => {
        const requestId = latestRequestId.current + 1;
        latestRequestId.current = requestId;

        try {
            setLoading(true);
            const params = new URLSearchParams({
                page: page.toString(),
                limit: pagination.pageSize.toString(),
                sortBy: filters.sortBy,
                sortOrder: filters.sortOrder
            });

            if (filters.search.trim()) params.set('search', filters.search.trim());
            if (filters.level) params.set('level', filters.level);
            if (filters.status) params.set('status', filters.status);

            const res = await apiV2
                .get(`/users/admin/list?${params.toString()}`);

            if (requestId !== latestRequestId.current) return;
            setUsers(res.data.users || []);
            setPagination((prev) => ({
                currentPage: res.data.currentPage || page,
                totalPages: res.data.totalPages || 1,
                totalUsers: res.data.totalUsers || 0,
                pageSize: res.data.pageSize || prev.pageSize
            }));
            setSummary({
                totalMembers: res.data.summary?.totalMembers || 0,
                activeMembers: res.data.summary?.activeMembers || 0,
                inactiveMembers: res.data.summary?.inactiveMembers || 0,
                totalBalance: res.data.summary?.totalBalance || 0
            });
        } catch (error) {
            if (requestId !== latestRequestId.current) return;
            setFeedback({
                type: 'error',
                text: getErrorMessage(error, 'Gagal memuat daftar user.')
            });
        } finally {
            if (requestId === latestRequestId.current) {
                setLoading(false);
            }
        }
    }, [filters, pagination.currentPage, pagination.pageSize]);

    const fetchRecentAdjustments = async (userId: string) => {
        try {
            setAuditLoading(true);
            const res = await apiV2
                .get(`/users/${userId}/balance-adjustments?limit=6`);
            setRecentAdjustments(res.data.items || []);
        } catch (error) {
            setRecentAdjustments([]);
            setFeedback({
                type: 'error',
                text: getErrorMessage(error, 'Gagal memuat audit penyesuaian saldo.')
            });
        } finally {
            setAuditLoading(false);
        }
    };

    useEffect(() => {
        fetchUsers();
    }, [fetchUsers]);

    useEffect(() => {
        const next = new URLSearchParams();
        if (filters.search.trim()) next.set('q', filters.search.trim());
        if (filters.level) next.set('level', filters.level);
        if (filters.status) next.set('status', filters.status);
        if (filters.sortBy !== 'createdAt') next.set('sortBy', filters.sortBy);
        if (filters.sortOrder !== 'desc') next.set('sortOrder', filters.sortOrder);
        if (pagination.currentPage > 1) next.set('page', String(pagination.currentPage));
        setSearchParams(next, { replace: true });
    }, [filters, pagination.currentPage, setSearchParams]);

    useEffect(() => {
        const handler = () => fetchUsers();
        window.addEventListener('admin:refresh-current-page', handler);
        return () => window.removeEventListener('admin:refresh-current-page', handler);
    }, [fetchUsers]);

    const handlePageChange = (page: number) => {
        if (page < 1 || page > pagination.totalPages || page === pagination.currentPage) {
            return;
        }

        setPagination((prev) => ({ ...prev, currentPage: page }));
    };

    const handleFilterChange = (next: Partial<UserFilters>) => {
        setFilters((prev) => ({ ...prev, ...next }));
        setPagination((prev) => ({ ...prev, currentPage: 1 }));
    };

    const resetFilters = () => {
        setFilters({
            search: '',
            level: '',
            status: '',
            sortBy: 'createdAt',
            sortOrder: 'desc'
        });
        setPagination((prev) => ({ ...prev, currentPage: 1 }));
    };

    const closeActionMenu = () => {
        setActionMenuOpen(null);
        setMenuPosition(null);
    };

    const handleEdit = (user: User) => {
        setEditingId(user._id);
        setEditForm({
            name: user.name,
            email: user.email,
            level: user.level
        });
        closeActionMenu();
    };

    const handleCancelEdit = () => {
        setEditingId(null);
        setEditForm({
            name: '',
            email: '',
            level: 'basic'
        });
    };

    const handleSave = async (id: string) => {
        try {
            const payload = {
                name: editForm.name,
                email: editForm.email,
                level: editForm.level
            };
            await apiV2.put(`/users/${id}`, payload);

            setFeedback({
                type: 'success',
                text: 'Data user berhasil diperbarui.'
            });
            handleCancelEdit();
            await fetchUsers();
        } catch (error) {
            setFeedback({
                type: 'error',
                text: getErrorMessage(error, 'Gagal memperbarui data user.')
            });
        }
    };

    const handleStatusChange = async (user: User, active: boolean) => {
        try {
            const payload = { active };
            await apiV2
                .patch(`/users/${user._id}/status`, payload);
            setFeedback({
                type: 'success',
                text: active ? 'User berhasil diaktifkan kembali.' : 'User berhasil dinonaktifkan.'
            });
            closeActionMenu();
            setConfirmStatusUser(null);
            await fetchUsers();
        } catch (error) {
            setFeedback({
                type: 'error',
                text: getErrorMessage(error, 'Gagal mengubah status user.')
            });
        }
    };

    const handleRevokeOpenApi = async (user: User) => {
        try {
            setRevokingOpenApi(true);
            await apiV2.delete(`/users/${user._id}/openapi-key`);
            setFeedback({
                type: 'success',
                text: `Open API key ${user.name} berhasil dicabut.`,
            });
            setConfirmRevokeOpenApiUser(null);
            closeActionMenu();
            await fetchUsers();
        } catch (error) {
            setFeedback({
                type: 'error',
                text: getErrorMessage(error, 'Gagal mencabut Open API key.'),
            });
        } finally {
            setRevokingOpenApi(false);
        }
    };

    const openBalanceModal = async (user: User) => {
        setSelectedUser(user);
        setBalanceForm({
            amount: '',
            type: 'add',
            reason: ''
        });
        // Generate before first attempt; preserve across refresh/step-up.
        balanceIdempotencyKeyRef.current = createIdempotencyKey();
        setShowBalanceModal(true);
        closeActionMenu();
        await fetchRecentAdjustments(user._id);
    };

    const closeBalanceModal = () => {
        setShowBalanceModal(false);
        setSelectedUser(null);
        setRecentAdjustments([]);
        setBalanceForm({
            amount: '',
            type: 'add',
            reason: ''
        });
        // Cancel clears the key so a later confirmation cannot reuse it.
        balanceIdempotencyKeyRef.current = null;
    };

    const handleBalanceAdjustment = async () => {
        if (!selectedUser) {
            return;
        }

        try {
            setSubmittingBalance(true);
            const amount = Number(balanceForm.amount);
            if (!/^\d+$/.test(balanceForm.amount) || amount <= 0 || amount > 100000000) {
                setFeedback({ type: 'error', text: 'Nominal wajib angka Rupiah bulat maksimal Rp100.000.000.' });
                return;
            }
            const payload = {
                amount,
                type: balanceForm.type,
                reason: balanceForm.reason
            };
            const idempotencyKey =
                balanceIdempotencyKeyRef.current ?? createIdempotencyKey();
            balanceIdempotencyKeyRef.current = idempotencyKey;
            await stepUp.run(
                'finance.adjust_balance',
                (config) =>
                    apiV2.post(
                        `/users/${selectedUser._id}/balance`,
                        payload,
                        attachIdempotencyKey(config as never, idempotencyKey) as never,
                    ),
                attachIdempotencyKey({} as never, idempotencyKey) as never,
            );

            setFeedback({
                type: 'success',
                text: balanceForm.type === 'add'
                    ? 'Saldo user berhasil ditambahkan.'
                    : 'Saldo user berhasil dikurangi.'
            });

            // Clear only on definitive success.
            balanceIdempotencyKeyRef.current = null;
            closeBalanceModal();
            await fetchUsers();
        } catch (error) {
            if (isAmbiguousMutationFailure(error)) {
                setFeedback({
                    type: 'error',
                    text: `${CRITICAL_MUTATION_AMBIGUOUS_MESSAGE}. Muat ulang riwayat penyesuaian saldo sebelum mencoba lagi.`,
                });
                await fetchRecentAdjustments(selectedUser._id);
                return;
            }
            const text = stepUpActionErrorMessage(error, 'Gagal menyesuaikan saldo user.');
            if (text) {
                setFeedback({ type: 'error', text });
            }
        } finally {
            setSubmittingBalance(false);
        }
    };

    return (<>

        <div className="space-y-6">
            {feedback && (
                <div
                    className={`rounded-xl border px-4 py-3 text-sm ${
                        feedback.type === 'success'
                            ? 'ui-success-chip'
                            : 'ui-danger-chip'
                    }`}
                >
                    {feedback.text}
                </div>
            )}

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-2xl border ui-border ui-panel-muted p-5">
                    <div className="text-xs uppercase tracking-[0.18em] ui-text-muted">Total Member</div>
                    <div className="mt-2 text-3xl font-black ui-text">{summary.totalMembers.toLocaleString('id-ID')}</div>
                    <p className="mt-1 text-sm ui-text-muted">Member terdaftar di sistem.</p>
                </div>
                <div className="rounded-2xl border ui-border ui-panel-muted p-5">
                    <div className="text-xs uppercase tracking-[0.18em] ui-success-text">Aktif</div>
                    <div className="mt-2 text-3xl font-black ui-success-text">{summary.activeMembers.toLocaleString('id-ID')}</div>
                    <p className="mt-1 text-sm ui-text-muted">Bisa login dan memakai API key.</p>
                </div>
                <div className="rounded-2xl border ui-border ui-panel-muted p-5">
                    <div className="text-xs uppercase tracking-[0.18em] ui-warning-text">Nonaktif</div>
                    <div className="mt-2 text-3xl font-black ui-warning-text">{summary.inactiveMembers.toLocaleString('id-ID')}</div>
                    <p className="mt-1 text-sm ui-text-muted">Disimpan untuk histori tanpa hard delete.</p>
                </div>
                <div className="rounded-2xl border ui-border ui-panel-muted p-5">
                    <div className="text-xs uppercase tracking-[0.18em] ui-info-text">Total Saldo</div>
                    <div className="mt-2 text-3xl font-black ui-text">{formatCurrency(summary.totalBalance)}</div>
                    <p className="mt-1 text-sm ui-text-muted">Akumulasi saldo seluruh member.</p>
                </div>
            </div>

            <div className="rounded-2xl border ui-border ui-panel-muted p-5">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
                    <div className="relative flex-1">
                        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 ui-text-muted" />
                        <input
                            type="text"
                            value={filters.search}
                            onChange={(event) => handleFilterChange({ search: event.target.value })}
                            placeholder="Cari nama atau email member..."
                            className={`${fieldClass} py-2.5 pl-10 pr-4`}
                        />
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <button
                            onClick={() => setShowFilters((prev) => !prev)}
                            className={mutedButtonClass}
                        >
                            <Filter className="h-4 w-4" />
                            Filter
                            {activeFilterCount > 0 && (
                                <span className="ui-accent-chip rounded-full px-2 py-0.5 text-[11px] font-semibold">
                                    {activeFilterCount}
                                </span>
                            )}
                        </button>
                        <button
                            onClick={() => fetchUsers()}
                            className={mutedButtonClass}
                        >
                            <RefreshCw className="h-4 w-4" />
                            Segarkan
                        </button>
                    </div>
                </div>

                {showFilters && (
                    <div className="mt-4 grid gap-4 border-t ui-border pt-4 md:grid-cols-4">
                        <div>
                            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide ui-text-muted">Level</label>
                            <select
                                value={filters.level}
                                onChange={(event) => handleFilterChange({ level: event.target.value })}
                                className={fieldClass}
                            >
                                <option value="">Semua level</option>
                                <option value="basic">Basic</option>
                                <option value="gold">Gold</option>
                                <option value="platinum">Platinum</option>
                            </select>
                        </div>
                        <div>
                            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide ui-text-muted">Status</label>
                            <select
                                value={filters.status}
                                onChange={(event) => handleFilterChange({ status: event.target.value as UserFilters['status'] })}
                                className={fieldClass}
                            >
                                <option value="">Semua status</option>
                                <option value="active">Aktif</option>
                                <option value="inactive">Nonaktif</option>
                            </select>
                        </div>
                        <div>
                            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide ui-text-muted">Urutkan</label>
                            <select
                                value={filters.sortBy}
                                onChange={(event) => handleFilterChange({ sortBy: event.target.value as UserFilters['sortBy'] })}
                                className={fieldClass}
                            >
                                <option value="createdAt">Tanggal daftar</option>
                                <option value="updatedAt">Terakhir update</option>
                                <option value="name">Nama</option>
                                <option value="email">Email</option>
                                <option value="balance">Saldo</option>
                            </select>
                        </div>
                        <div>
                            <label className="mb-1 block text-xs font-semibold uppercase tracking-wide ui-text-muted">Arah urutan</label>
                            <div className="flex gap-2">
                                <select
                                    value={filters.sortOrder}
                                    onChange={(event) => handleFilterChange({ sortOrder: event.target.value as UserFilters['sortOrder'] })}
                                    className="flex-1 rounded-xl border px-3 py-2.5 text-sm ui-field"
                                >
                                    <option value="desc">Terbaru / terbesar</option>
                                    <option value="asc">Terlama / terkecil</option>
                                </select>
                                <button
                                    onClick={resetFilters}
                                    className="rounded-xl border px-4 py-2.5 text-sm ui-muted-action"
                                >
                                    Reset
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            <div className="overflow-hidden rounded-2xl border ui-border ui-panel-muted">
                <div className="overflow-x-auto">
                    <table className="min-w-full divide-y ui-border">
                        <thead className="ui-panel">
                            <tr>
                                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider ui-text-muted">User</th>
                                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider ui-text-muted">Level</th>
                                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider ui-text-muted">Saldo</th>
                                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider ui-text-muted">Status</th>
                                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-wider ui-text-muted">Terdaftar</th>
                                <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-wider ui-text-muted">Aksi</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y ui-border">
                            {loading ? (
                                <tr>
                                    <td colSpan={6} className="px-6 py-10 text-center text-sm ui-text-muted">
                                        Memuat daftar member...
                                    </td>
                                </tr>
                            ) : users.length === 0 ? (
                                <tr>
                                    <td colSpan={6} className="px-6 py-10 text-center text-sm ui-text-muted">
                                        Tidak ada member yang cocok dengan filter saat ini.
                                    </td>
                                </tr>
                            ) : (
                                users.map((user) => (
                                    <tr
                                        key={user._id}
                                        className={`transition-colors hover:bg-[var(--ui-card-bg)] ${user.active ? '' : 'bg-[var(--ui-warning-bg)]'}`}
                                    >
                                        <td className="px-6 py-4">
                                            <div className="flex items-center gap-3">
                                                <div className="flex h-11 w-11 items-center justify-center rounded-full ui-panel">
                                                    <UserIcon className="h-5 w-5 ui-text" />
                                                </div>
                                                <div className="min-w-0">
                                                    {editingId === user._id ? (
                                                        <div className="space-y-2">
                                                            <input
                                                                type="text"
                                                                value={editForm.name}
                                                                onChange={(event) => setEditForm((prev) => ({ ...prev, name: event.target.value }))}
                                                                className={compactFieldClass}
                                                            />
                                                            <input
                                                                type="email"
                                                                value={editForm.email}
                                                                onChange={(event) => setEditForm((prev) => ({ ...prev, email: event.target.value }))}
                                                                className={compactFieldClass}
                                                            />
                                                        </div>
                                                    ) : (
                                                        <>
                                                            <div className="truncate text-sm font-semibold ui-text">{user.name}</div>
                                                            <div className="truncate text-sm ui-text-muted">{user.email}</div>
                                                            <div className="mt-1 text-xs ui-text-muted">{user.points.toLocaleString('id-ID')} poin</div>
                                                        </>
                                                    )}
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-6 py-4 text-sm ui-text">
                                            {editingId === user._id ? (
                                                <select
                                                    value={editForm.level}
                                                    onChange={(event) => setEditForm((prev) => ({
                                                        ...prev,
                                                        level: event.target.value as User['level']
                                                    }))}
                                                    className="rounded-lg border px-3 py-2 text-sm ui-field"
                                                >
                                                    <option value="basic">Basic</option>
                                                    <option value="gold">Gold</option>
                                                    <option value="platinum">Platinum</option>
                                                </select>
                                            ) : (
                                                <span className={`inline-flex rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wide ${getLevelTone(user.level)}`}>
                                                    {user.level}
                                                </span>
                                            )}
                                        </td>
                                        <td className="px-6 py-4 text-sm">
                                            <div className={`font-semibold ${isNegativeAmount(user.balance) ? 'ui-danger-text' : 'ui-text'}`}>{formatCurrency(user.balance)}</div>
                                            <div className="text-xs ui-text-muted">Update {formatDate(user.updatedAt)}</div>
                                        </td>
                                        <td className="px-6 py-4 text-sm">
                                            <div className="flex flex-col items-start gap-1.5">
                                                <span
                                                    className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide ${
                                                        user.active
                                                            ? 'ui-success-chip'
                                                            : 'ui-warning-chip'
                                                    }`}
                                                >
                                                    {user.active ? 'Aktif' : 'Nonaktif'}
                                                </span>
                                                {user.hasOpenApiKey ? (
                                                    <span className="inline-flex rounded-full border border-orange-500/30 bg-orange-500/10 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-orange-300">
                                                        Open API{user.memberCode ? ` · ${user.memberCode}` : ''}
                                                    </span>
                                                ) : null}
                                            </div>
                                        </td>
                                        <td className="px-6 py-4 text-sm ui-text-muted">
                                            {formatDate(user.createdAt)}
                                        </td>
                                        <td className="px-6 py-4 text-right">
                                            {editingId === user._id ? (
                                                <div className="flex justify-end gap-2">
                                                    <button
                                                        onClick={() => handleSave(user._id)}
                                                        className="ui-success-action inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium"
                                                    >
                                                        <Save className="h-4 w-4" />
                                                        Simpan
                                                    </button>
                                                    <button
                                                        onClick={handleCancelEdit}
                                                        className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium ui-muted-action"
                                                    >
                                                        <X className="h-4 w-4" />
                                                        Batal
                                                    </button>
                                                </div>
                                            ) : canManageUsers ? (
                                                <button
                                                    onClick={(event) => {
                                                        if (actionMenuOpen === user._id) {
                                                            closeActionMenu();
                                                            return;
                                                        }

                                                        const rect = event.currentTarget.getBoundingClientRect();
                                                        const menuHeight = 170;
                                                        const spaceBelow = window.innerHeight - rect.bottom;
                                                        const top = spaceBelow < menuHeight
                                                            ? rect.top - menuHeight + window.scrollY
                                                            : rect.bottom + window.scrollY;

                                                        setActionMenuOpen(user._id);
                                                        setMenuPosition({
                                                            top,
                                                            left: rect.right - 192
                                                        });
                                                    }}
                                                    className="rounded-lg p-2 ui-text-muted hover:bg-[var(--ui-card-muted)] hover:text-[var(--ui-text)]"
                                                >
                                                    <MoreVertical className="h-5 w-5" />
                                                </button>
                                            ) : (
                                                <span className="text-xs ui-text-muted">View only</span>
                                            )}
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>

                {pagination.totalPages > 1 && (
                    <div className="flex flex-col gap-3 border-t ui-border px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                        <p className="text-sm ui-text-muted">
                            Menampilkan{' '}
                            <span className="font-semibold ui-text">
                                {(pagination.currentPage - 1) * pagination.pageSize + 1}
                            </span>{' '}
                            sampai{' '}
                            <span className="font-semibold ui-text">
                                {Math.min(pagination.currentPage * pagination.pageSize, pagination.totalUsers)}
                            </span>{' '}
                            dari <span className="font-semibold ui-text">{pagination.totalUsers}</span> member
                        </p>
                        <div className="flex items-center justify-end gap-2">
                            <button
                                onClick={() => handlePageChange(pagination.currentPage - 1)}
                                disabled={pagination.currentPage === 1}
                                className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ui-muted-action disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                <ChevronLeft className="h-4 w-4" />
                                Prev
                            </button>
                            <div className="rounded-lg ui-panel px-3 py-2 text-sm font-medium ui-text">
                                {pagination.currentPage} / {pagination.totalPages}
                            </div>
                            <button
                                onClick={() => handlePageChange(pagination.currentPage + 1)}
                                disabled={pagination.currentPage === pagination.totalPages}
                                className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ui-muted-action disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                Next
                                <ChevronRight className="h-4 w-4" />
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {actionMenuOpen && menuPosition && (
                <>
                    <div className="fixed inset-0 z-40" onClick={closeActionMenu} />
                    <div
                        className="fixed z-50 w-48 rounded-xl border ui-border ui-panel p-1 shadow-xl"
                        style={{ top: menuPosition.top, left: menuPosition.left }}
                    >
                        <button
                            onClick={() => {
                                const targetUser = users.find((item) => item._id === actionMenuOpen);
                                if (targetUser) handleEdit(targetUser);
                            }}
                            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm ui-text hover:bg-[var(--ui-card-muted)]"
                        >
                            <Edit className="h-4 w-4" />
                            Edit user
                        </button>
                        <button
                            onClick={() => {
                                const targetUser = users.find((item) => item._id === actionMenuOpen);
                                if (targetUser) {
                                    void openBalanceModal(targetUser);
                                }
                            }}
                            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm ui-text hover:bg-[var(--ui-card-muted)]"
                        >
                            <Wallet className="h-4 w-4" />
                            Atur saldo
                        </button>
                        {users.find((item) => item._id === actionMenuOpen)?.hasOpenApiKey ? (
                            <button
                                onClick={() => {
                                    const targetUser = users.find((item) => item._id === actionMenuOpen);
                                    if (targetUser) {
                                        setConfirmRevokeOpenApiUser(targetUser);
                                        closeActionMenu();
                                    }
                                }}
                                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm ui-warning-text hover:bg-[var(--ui-card-muted)]"
                            >
                                <Key className="h-4 w-4" />
                                Cabut Open API
                            </button>
                        ) : null}
                        <button
                            onClick={() => {
                                const targetUser = users.find((item) => item._id === actionMenuOpen);
                                if (targetUser) {
                                    setConfirmStatusUser({ user: targetUser, active: !targetUser.active });
                                    closeActionMenu();
                                }
                            }}
                            className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-[var(--ui-card-muted)] ${
                                users.find((item) => item._id === actionMenuOpen)?.active
                                    ? 'ui-warning-text'
                                    : 'ui-success-text'
                            }`}
                        >
                            {users.find((item) => item._id === actionMenuOpen)?.active ? (
                                <PowerOff className="h-4 w-4" />
                            ) : (
                                <Power className="h-4 w-4" />
                            )}
                            {users.find((item) => item._id === actionMenuOpen)?.active ? 'Nonaktifkan' : 'Aktifkan'}
                        </button>
                    </div>
                </>
            )}

            {confirmStatusUser && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 py-6">
                    <div className="w-full max-w-md rounded-2xl border ui-border ui-panel p-6 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="user-status-confirm-title">
                        <h2 id="user-status-confirm-title" className="text-lg font-semibold ui-text">
                            {confirmStatusUser.active ? 'Aktifkan member?' : 'Nonaktifkan member?'}
                        </h2>
                        <p className="mt-2 text-sm ui-text-muted">
                            {confirmStatusUser.active
                                ? `Akun ${confirmStatusUser.user.name} akan dapat login kembali.`
                                : `Akun ${confirmStatusUser.user.name} akan dinonaktifkan, Open API key & secret dicabut, dan histori transaksi tetap disimpan.`}
                        </p>
                        <div className="mt-6 flex justify-end gap-3">
                            <button type="button" onClick={() => setConfirmStatusUser(null)} className="rounded-xl border px-4 py-2.5 text-sm ui-muted-action">
                                Batal
                            </button>
                            <button
                                type="button"
                                onClick={() => void handleStatusChange(confirmStatusUser.user, confirmStatusUser.active)}
                                className={`rounded-xl px-4 py-2.5 text-sm font-semibold ${confirmStatusUser.active ? 'ui-success-action border' : 'ui-warning-action border'}`}
                            >
                                {confirmStatusUser.active ? 'Aktifkan' : 'Nonaktifkan'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {confirmRevokeOpenApiUser && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 py-6">
                    <div className="w-full max-w-md rounded-2xl border ui-border ui-panel p-6 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="user-openapi-revoke-title">
                        <h2 id="user-openapi-revoke-title" className="text-lg font-semibold ui-text">
                            Cabut Open API member?
                        </h2>
                        <p className="mt-2 text-sm ui-text-muted">
                            Key dan secret Open API untuk {confirmRevokeOpenApiUser.name}
                            {confirmRevokeOpenApiUser.memberCode ? ` (${confirmRevokeOpenApiUser.memberCode})` : ''} akan dihapus.
                            Akun tetap aktif dan bisa login.
                        </p>
                        <div className="mt-6 flex justify-end gap-3">
                            <button type="button" onClick={() => setConfirmRevokeOpenApiUser(null)} className="rounded-xl border px-4 py-2.5 text-sm ui-muted-action" disabled={revokingOpenApi}>
                                Batal
                            </button>
                            <button
                                type="button"
                                onClick={() => void handleRevokeOpenApi(confirmRevokeOpenApiUser)}
                                disabled={revokingOpenApi}
                                className="rounded-xl border px-4 py-2.5 text-sm font-semibold ui-warning-action disabled:opacity-50"
                            >
                                {revokingOpenApi ? 'Memproses...' : 'Cabut Open API'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {showBalanceModal && selectedUser && (
                <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 px-4 py-8">
                    <div className="w-full max-w-3xl rounded-2xl border ui-border ui-panel shadow-2xl">
                        <div className="flex items-center justify-between border-b ui-border px-6 py-4 ui-card-gradient">
                            <div>
                                <h2 className="text-lg font-semibold ui-text">Penyesuaian Saldo Member</h2>
                                <p className="text-sm ui-text-muted">
                                    {selectedUser.name} • {selectedUser.email}
                                </p>
                            </div>
                            <button
                                onClick={closeBalanceModal}
                                className="rounded-lg p-2 ui-text-muted hover:bg-[var(--ui-card-muted)] hover:text-[var(--ui-text)]"
                            >
                                <X className="h-5 w-5" />
                            </button>
                        </div>

                        <div className="grid gap-6 px-6 py-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
                            <div className="space-y-4">
                                <div className="rounded-2xl border ui-border ui-panel-muted p-4">
                                    <div className="text-xs uppercase tracking-[0.18em] ui-text-muted">Saldo Saat Ini</div>
                                    <div className={`mt-2 text-3xl font-black ${isNegativeAmount(selectedUser.balance) ? 'ui-danger-text' : 'ui-text'}`}>{formatCurrency(selectedUser.balance)}</div>
                                    <p className="mt-2 text-sm ui-text-muted">
                                        Penyesuaian saldo mewajibkan alasan audit dan akan tercatat otomatis.
                                    </p>
                                </div>

                                <div>
                                    <label className="mb-1 block text-sm font-medium ui-text">Jenis penyesuaian</label>
                                    <select
                                        value={balanceForm.type}
                                        onChange={(event) => setBalanceForm((prev) => ({
                                            ...prev,
                                            type: event.target.value as 'add' | 'subtract'
                                        }))}
                                        className={fieldClass}
                                    >
                                        <option value="add">Tambah saldo</option>
                                        <option value="subtract">Kurangi saldo</option>
                                    </select>
                                </div>

                                <div>
                                    <label className="mb-1 block text-sm font-medium ui-text">Nominal</label>
                                    <input
                                        type="number"
                                        min="1"
                                        max="100000000"
                                        step="1"
                                        value={balanceForm.amount}
                                        onChange={(event) => {
                                            const value = event.target.value;
                                            if (value && !/^\d+$/.test(value)) return;
                                            setBalanceForm((prev) => ({ ...prev, amount: value }));
                                        }}
                                        placeholder="Contoh: 50000"
                                        className={fieldClass}
                                    />
                                </div>

                                <div>
                                    <label className="mb-1 block text-sm font-medium ui-text">Alasan audit</label>
                                    <textarea
                                        value={balanceForm.reason}
                                        onChange={(event) => setBalanceForm((prev) => ({ ...prev, reason: event.target.value }))}
                                        placeholder="Contoh: kompensasi transaksi gagal, koreksi saldo manual, refund internal."
                                        rows={4}
                                        className={fieldClass}
                                    />
                                </div>

                                <div className="flex justify-end gap-3">
                                    <button
                                        onClick={closeBalanceModal}
                                        className="rounded-xl border px-4 py-2.5 text-sm ui-muted-action"
                                    >
                                        Batal
                                    </button>
                                    <button
                                        onClick={handleBalanceAdjustment}
                                        disabled={
                                            submittingBalance
                                            || !/^\d+$/.test(balanceForm.amount)
                                            || Number(balanceForm.amount) <= 0
                                            || Number(balanceForm.amount) > 100000000
                                            || balanceForm.reason.trim().length < 5
                                        }
                                        className="rounded-xl ui-accent-solid px-4 py-2.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
                                    >
                                        {submittingBalance ? 'Menyimpan...' : 'Simpan Penyesuaian'}
                                    </button>
                                </div>
                            </div>

                            <div className="space-y-4">
                                <div className="rounded-2xl border ui-border ui-panel-muted p-4">
                                    <div className="flex items-center justify-between">
                                        <div>
                                            <div className="text-xs uppercase tracking-[0.18em] ui-text-muted">Audit Terbaru</div>
                                            <div className="mt-1 text-sm ui-text">6 log penyesuaian saldo terakhir</div>
                                        </div>
                                        <button
                                            onClick={() => fetchRecentAdjustments(selectedUser._id)}
                                            className="rounded-lg p-2 ui-text-muted hover:bg-[var(--ui-card-muted)] hover:text-[var(--ui-text)]"
                                        >
                                            <RefreshCw className="h-4 w-4" />
                                        </button>
                                    </div>
                                </div>

                                <div className="max-h-[420px] space-y-3 overflow-y-auto pr-1">
                                    {auditLoading ? (
                                        <div className="rounded-2xl border ui-border ui-panel-muted px-4 py-6 text-center text-sm ui-text-muted">
                                            Memuat audit saldo...
                                        </div>
                                    ) : recentAdjustments.length === 0 ? (
                                        <div className="rounded-2xl border border-dashed ui-border ui-panel-muted px-4 py-6 text-center text-sm ui-text-muted">
                                            Belum ada log penyesuaian saldo untuk member ini.
                                        </div>
                                    ) : (
                                        recentAdjustments.map((log) => (
                                            <div key={log._id} className="rounded-2xl border ui-border ui-panel-muted p-4">
                                                <div className="flex items-start justify-between gap-3">
                                                    <div>
                                                        <div className={`inline-flex rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${
                                                            log.type === 'add'
                                                                ? 'ui-success-chip'
                                                                : 'ui-danger-chip'
                                                        }`}>
                                                            {log.type === 'add' ? 'Tambah saldo' : 'Kurangi saldo'}
                                                        </div>
                                                        <div className="mt-2 text-lg font-semibold ui-text">
                                                            {log.type === 'add' ? '+' : '-'}{formatCurrency(log.amount)}
                                                        </div>
                                                    </div>
                                                    <div className="text-right text-xs ui-text-muted">
                                                        {formatDateTime(log.createdAt)}
                                                    </div>
                                                </div>
                                                <p className="mt-3 text-sm ui-text">{log.reason}</p>
                                                <div className="mt-3 grid gap-2 text-xs ui-text-muted sm:grid-cols-2">
                                                    <div>
                                                        Balance: <span className={`font-medium ${isNegativeAmount(log.balanceBefore) ? 'ui-danger-text' : 'ui-text'}`}>{formatCurrency(log.balanceBefore)}</span> →{' '}
                                                        <span className={`font-medium ${isNegativeAmount(log.balanceAfter) ? 'ui-danger-text' : 'ui-text'}`}>{formatCurrency(log.balanceAfter)}</span>
                                                    </div>
                                                    <div>
                                                        Operator: <span className="font-medium ui-text">{log.adjustedBy?.name || 'Unknown'}</span>
                                                    </div>
                                                </div>
                                            </div>
                                        ))
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
            {stepUp.dialog}
        </>
    );
}
