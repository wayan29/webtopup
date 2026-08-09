import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiV2 } from '../../api';
import { useStepUpOrchestration } from '../../auth/useStepUpOrchestration';
import { stepUpActionErrorMessage } from '../../auth/withStepUp';
import { useAuthStore } from '../../store/useAuthStore';
import {
    CheckCircle,
    ChevronLeft,
    ChevronRight,
    Clock,
    Eye,
    Filter,
    Download,
    RefreshCw,
    RotateCcw,
    Search,
    ShieldAlert,

    Wallet,
    UserCheck,
    Unlock,
    X,
    XCircle
} from 'lucide-react';

interface DepositUser {
    _id?: string;
    name?: string;
    email?: string;
    role?: string;
}

interface DepositPaymentMethod {
    _id?: string;
    name?: string;
    accountNumber?: string;
    accountName?: string;
}

interface Deposit {
    _id: string;
    invoiceCode?: string;
    user?: DepositUser | null;
    amount: number;
    uniqueCode: number;
    adminFee?: number;
    totalAmount: number;
    netAmount?: number;
    paymentMethod?: DepositPaymentMethod | null;
    assignedTo?: DepositUser | null;
    assignedAt?: string;
    processedBy?: DepositUser | null;
    processedAt?: string;
    processingNote?: string;
    status: 'pending' | 'approved' | 'rejected';
    createdAt: string;
    updatedAt: string;
}

interface DepositsMeta {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
}

interface DepositsSummary {
    total: number;
    pending: number;
    approved: number;
    rejected: number;
}

type Filters = {
    invoiceId: string;
    userQuery: string;
    totalTransfer: string;
    status: '' | 'pending' | 'approved' | 'rejected';
    assignment: '' | 'unassigned' | 'mine' | 'locked';
};

type ActionState = {
    type: 'approve' | 'reject';
    deposit: Deposit;
} | null;

const filterKeys: Array<keyof Filters> = ['invoiceId', 'userQuery', 'totalTransfer', 'status', 'assignment'];

const filtersFromSearchParams = (params: URLSearchParams): Filters => ({
    invoiceId: params.get('invoiceId') || '',
    userQuery: params.get('userQuery') || params.get('search') || '',
    totalTransfer: params.get('totalTransfer') || '',
    status: (params.get('status') as Filters['status']) || '',
    assignment: (params.get('assignment') as Filters['assignment']) || ''
});

const defaultFilters: Filters = {
    invoiceId: '',
    userQuery: '',
    totalTransfer: '',
    status: '',
    assignment: ''
};

const defaultMeta: DepositsMeta = {
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 1
};

const defaultSummary: DepositsSummary = {
    total: 0,
    pending: 0,
    approved: 0,
    rejected: 0
};

const formatCurrency = (value: number) => `Rp ${Math.max(0, value || 0).toLocaleString('id-ID')}`;

const statusBadgeClass: Record<Deposit['status'], string> = {
    approved: 'border ui-success-chip',
    pending: 'border ui-warning-chip',
    rejected: 'border ui-danger-chip'
};

const statusLabel: Record<Deposit['status'], string> = {
    approved: 'Sukses',
    pending: 'Pending',
    rejected: 'Ditolak'
};

const fieldClass = 'w-full rounded-lg ui-field border px-3 py-2 text-sm';

export default function AdminDeposits() {
    const stepUp = useStepUpOrchestration();
    const [searchParams, setSearchParams] = useSearchParams();
    const { user, isOwner, hasPermission } = useAuthStore();
    const canViewDeposits = isOwner || hasPermission('viewDeposits');
    const canApproveDeposits = isOwner || hasPermission('approveDeposits');

    const [deposits, setDeposits] = useState<Deposit[]>([]);
    const [loading, setLoading] = useState(true);
    const initialFilters = useMemo(() => filtersFromSearchParams(searchParams), []);
    const [draftFilters, setDraftFilters] = useState<Filters>(initialFilters);
    const [filters, setFilters] = useState<Filters>(initialFilters);
    const [meta, setMeta] = useState<DepositsMeta>(defaultMeta);
    const [summary, setSummary] = useState<DepositsSummary>(defaultSummary);
    const [selectedDeposit, setSelectedDeposit] = useState<Deposit | null>(null);
    const [actionState, setActionState] = useState<ActionState>(null);
    const [actionNote, setActionNote] = useState('');
    const [processingId, setProcessingId] = useState<string | null>(null);
    const [claimingId, setClaimingId] = useState<string | null>(null);
    const [exporting, setExporting] = useState(false);
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const latestRequestId = useRef(0);

    // Bulk action state: selectable pending rows on the current page.
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [bulkAction, setBulkAction] = useState<{ type: 'approve' | 'reject' } | null>(null);
    const [bulkNote, setBulkNote] = useState('');
    const [bulkRunning, setBulkRunning] = useState(false);

    const hasUnappliedChanges = useMemo(() => (
        filterKeys.some((key) => draftFilters[key] !== filters[key])
    ), [draftFilters, filters]);
    const exportWillBeCapped = summary.total > 5000;

    const refreshSidebarBadges = () => {
        window.dispatchEvent(new Event('admin:sidebar-badges-refresh'));
    };

    const syncUrlParams = useCallback((nextFilters: Filters) => {
        const params = new URLSearchParams();
        filterKeys.forEach((key) => {
            const value = nextFilters[key];
            if (value) params.set(key, value);
        });
        setSearchParams(params, { replace: true });
    }, [setSearchParams]);

    const fetchDeposits = useCallback(async () => {
        if (!canViewDeposits) {
            setLoading(false);
            return;
        }

        const requestId = latestRequestId.current + 1;
        latestRequestId.current = requestId;
        setLoading(true);
        const params = {
            page: meta.page,
            limit: meta.limit,
            invoiceId: filters.invoiceId || undefined,
            userQuery: filters.userQuery || undefined,
            totalTransfer: filters.totalTransfer || undefined,
            status: filters.status || undefined,
            assignment: filters.assignment || undefined
        };

        try {
            const response = await apiV2.get('/deposits/admin/list', {
                params
            });
            if (requestId !== latestRequestId.current) return;

            setDeposits(response.data.items || []);
            setMeta(response.data.meta || defaultMeta);
            setSummary(response.data.summary || defaultSummary);
        } catch (error: any) {
            if (requestId !== latestRequestId.current) return;
            console.error('Failed to fetch admin deposits', error);
            setMessage({
                type: 'error',
                text: error.response?.data?.message || 'Gagal memuat daftar deposit'
            });
        } finally {
            if (requestId === latestRequestId.current) {
                setLoading(false);
            }
        }
    }, [canViewDeposits, filters, meta.limit, meta.page]);

    useEffect(() => {
        fetchDeposits();
    }, [fetchDeposits]);

    useEffect(() => {
        const handleRefresh = () => fetchDeposits();
        window.addEventListener('admin:refresh-current-page', handleRefresh);
        return () => window.removeEventListener('admin:refresh-current-page', handleRefresh);
    }, [fetchDeposits]);

    const pageStats = useMemo(() => {
        return deposits.reduce(
            (result, deposit) => {
                result[deposit.status] += 1;
                return result;
            },
            {
                pending: 0,
                approved: 0,
                rejected: 0
            }
        );
    }, [deposits]);

    const pageRangeText = useMemo(() => {
        if (meta.total === 0) {
            return '0 dari 0 data';
        }

        const from = (meta.page - 1) * meta.limit + 1;
        const to = Math.min(meta.page * meta.limit, meta.total);
        return `${from}-${to} dari ${meta.total} data`;
    }, [meta]);

    const pendingDeposits = deposits.filter((deposit) => deposit.status === 'pending').slice(0, 4);

    // Quick presets mirror common operator flows; preset writes into draft + applied filters at once.
    const applyPreset = (preset: 'pending-today' | 'mine' | 'unassigned') => {
        const next: Filters = { ...defaultFilters };
        if (preset === 'pending-today') {
            next.status = 'pending';
        } else if (preset === 'mine') {
            next.status = 'pending';
            next.assignment = 'mine';
        } else if (preset === 'unassigned') {
            next.status = 'pending';
            next.assignment = 'unassigned';
        }
        setDraftFilters(next);
        setFilters(next);
        setMeta((current) => ({ ...current, page: 1 }));
        setMessage(null);
        syncUrlParams(next);
    };

    const selectablePending = useMemo(
        () => deposits.filter((deposit) => deposit.status === 'pending' && !isDepositLockedByOther(deposit)),
        // isDepositLockedByOther reads isOwner/user from closure; stable enough per render.
        [deposits, user?.id, isOwner]
    );
    const selectableIds = useMemo(() => selectablePending.map((deposit) => deposit._id), [selectablePending]);
    const selectedCount = selectedIds.length;
    const allSelectableChecked = selectableIds.length > 0 && selectableIds.every((id) => selectedIds.includes(id));

    // Drop selections that disappear after refetch (approved/rejected/locked rows no longer selectable).
    useEffect(() => {
        setSelectedIds((current) => current.filter((id) => selectableIds.includes(id)));
    }, [selectableIds]);

    const toggleSelectAll = () => {
        setSelectedIds(allSelectableChecked ? [] : [...selectableIds]);
    };

    const toggleSelectOne = (id: string) => {
        setSelectedIds((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
    };

    const resetFilters = () => {
        setDraftFilters(defaultFilters);
        setFilters(defaultFilters);
        setMeta((current) => ({ ...current, page: 1 }));
        setMessage(null);
        syncUrlParams(defaultFilters);
    };

    const applyFilters = () => {
        setFilters(draftFilters);
        setMeta((current) => ({ ...current, page: 1 }));
        setMessage(null);
        syncUrlParams(draftFilters);
    };

    const openActionModal = (deposit: Deposit, type: 'approve' | 'reject') => {
        if (isDepositLockedByOther(deposit)) {
            setMessage({ type: 'error', text: 'Deposit sedang di-claim admin lain' });
            return;
        }

        setActionState({ deposit, type });
        setActionNote(type === 'approve' ? deposit.processingNote || '' : '');
    };

    const closeActionModal = () => {
        setActionState(null);
        setActionNote('');
    };

    const handleAction = async () => {
        if (!actionState) {
            return;
        }

        const note = actionNote.trim();
        if (note.length < 5) {
            setMessage({
                type: 'error',
                text: actionState.type === 'approve'
                    ? 'Catatan approval minimal 5 karakter wajib diisi'
                    : 'Catatan penolakan minimal 5 karakter wajib diisi'
            });
            return;
        }

        setProcessingId(actionState.deposit._id);
        setMessage(null);

        try {
            const payload = note ? { note } : {};
            const endpoint = `/deposits/${actionState.deposit._id}/${actionState.type}`;
            const response = await stepUp.run('finance.deposit_approval', (config) =>
                apiV2.put(endpoint, payload, config as never),
            );

            const updatedDeposit = response.data.deposit as Deposit | undefined;
            if (selectedDeposit && updatedDeposit && selectedDeposit._id === updatedDeposit._id) {
                setSelectedDeposit(updatedDeposit);
            }

            const netAmountAdded = response.data?.netAmountAdded;
            const newBalance = response.data?.newBalance;
            setMessage({
                type: 'success',
                text: actionState.type === 'approve'
                    ? `Deposit berhasil disetujui${typeof netAmountAdded === 'number' ? `. Saldo masuk ${formatCurrency(netAmountAdded)}` : ''}${typeof newBalance === 'number' ? `, saldo baru ${formatCurrency(newBalance)}` : ''}.`
                    : 'Deposit berhasil ditolak'
            });
            refreshSidebarBadges();
            closeActionModal();
            await fetchDeposits();
        } catch (error: any) {
            console.error(`Failed to ${actionState.type} deposit`, error);
            const text = stepUpActionErrorMessage(error, 'Aksi deposit gagal');
            if (text) {
                setMessage({ type: 'error', text });
            }
        } finally {
            setProcessingId(null);
        }
    };

    const isDepositAssignedToMe = (deposit: Deposit) => Boolean(user?.id && deposit.assignedTo?._id === user.id);
    const isDepositLockedByOther = (deposit: Deposit) => (
        deposit.status === 'pending'
        && Boolean(deposit.assignedTo?._id)
        && !isOwner
        && !isDepositAssignedToMe(deposit)
    );

    const syncUpdatedDeposit = (updatedDeposit?: Deposit) => {
        if (!updatedDeposit) return;
        setDeposits((current) => current.map((deposit) => deposit._id === updatedDeposit._id ? updatedDeposit : deposit));
        setSelectedDeposit((current) => current?._id === updatedDeposit._id ? updatedDeposit : current);
    };

    const handleClaimToggle = async (deposit: Deposit) => {
        const shouldRelease = Boolean(deposit.assignedTo?._id) && (isOwner || isDepositAssignedToMe(deposit));
        setClaimingId(deposit._id);
        setMessage(null);

        try {
            const endpoint = `/deposits/${deposit._id}/${shouldRelease ? 'release-claim' : 'claim'}`;
            const response = await apiV2.post(endpoint);
            const updatedDeposit = response.data.deposit as Deposit | undefined;
            syncUpdatedDeposit(updatedDeposit);
            setMessage({
                type: 'success',
                text: shouldRelease ? 'Claim deposit dilepas' : 'Deposit berhasil di-claim'
            });
            refreshSidebarBadges();
            await fetchDeposits();
        } catch (error: any) {
            setMessage({
                type: 'error',
                text: error.response?.data?.message || 'Gagal mengubah claim deposit'
            });
        } finally {
            setClaimingId(null);
        }
    };

    const handleExport = async () => {
        setExporting(true);
        setMessage(null);

        try {
            const exportConfig = {
                params: {
                    invoiceId: filters.invoiceId || undefined,
                    userQuery: filters.userQuery || undefined,
                    totalTransfer: filters.totalTransfer || undefined,
                    status: filters.status || undefined,
                    assignment: filters.assignment || undefined
                },
                responseType: 'blob'
            } as const;
            const response = await apiV2
                .get('/deposits/admin/export', exportConfig);

            const blob = new Blob([response.data], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.setAttribute('download', `admin-deposits-${new Date().toISOString().split('T')[0]}.csv`);
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        } catch (error: any) {
            console.error('Failed to export admin deposits', error);
            setMessage({
                type: 'error',
                text: error.response?.data?.message || 'Gagal export CSV deposit'
            });
        } finally {
            setExporting(false);
        }
    };

    // Bulk approve/reject: run sequentially so step-up challenge fires once and failures are reported per-item.
    const handleBulkAction = async () => {
        if (!bulkAction || selectedIds.length === 0) return;
        const note = bulkNote.trim();
        if (note.length < 5) {
            setMessage({ type: 'error', text: 'Catatan bulk minimal 5 karakter wajib diisi' });
            return;
        }

        setBulkRunning(true);
        setMessage(null);
        const type = bulkAction.type;
        let succeeded = 0;
        const failed: string[] = [];

        try {
            for (const id of selectedIds) {
                try {
                    // eslint-disable-next-line no-await-in-loop
                    const response = await stepUp.run('finance.deposit_approval', (config) =>
                        apiV2.put(`/deposits/${id}/${type}`, { note }, config as never)
                    );
                    const updatedDeposit = response.data?.deposit as Deposit | undefined;
                    if (updatedDeposit) syncUpdatedDeposit(updatedDeposit);
                    succeeded += 1;
                } catch (error: any) {
                    const deposit = deposits.find((item) => item._id === id);
                    const label = deposit?.invoiceCode || id.slice(-6);
                    const text = stepUpActionErrorMessage(error, '');
                    failed.push(`${label}${text ? ` (${text})` : ''}`);
                }
            }

            refreshSidebarBadges();
            setMessage(
                failed.length === 0
                    ? {
                        type: 'success',
                        text: `${succeeded} deposit berhasil ${type === 'approve' ? 'disetujui' : 'ditolak'}.`,
                    }
                    : {
                        type: 'error',
                        text: `${succeeded} berhasil, ${failed.length} gagal: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''}`,
                    }
            );
            setBulkAction(null);
            setBulkNote('');
            setSelectedIds([]);
            await fetchDeposits();
        } finally {
            setBulkRunning(false);
        }
    };

    const ageBadge = (createdAt: string) => {
        const ageMs = Date.now() - new Date(createdAt).getTime();
        const minutes = Math.floor(ageMs / 60000);
        if (minutes < 30) return null;
        const label = minutes >= 60 ? `${Math.floor(minutes / 60)}j ${minutes % 60}m` : `${minutes}m`;
        return (
            <span className="ui-warning-chip inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold" title={`Menunggu ${label}`}>
                <Clock className="h-3 w-3" />
                {label}
            </span>
        );
    };

    if (!canViewDeposits) {
        return (
            <div className="ui-warning-chip rounded-2xl border p-6">
                Anda tidak memiliki izin untuk melihat desk deposit.
            </div>
        );
    }

    return (<>

        <div className="space-y-6">
            <div className="ui-panel rounded-2xl border ui-border p-4 sm:p-5">
                <div className="relative">
                    <div className="rounded-3xl border ui-border bg-[var(--ui-card-bg)]/75 p-5 backdrop-blur">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <p className="text-xs uppercase tracking-[0.18em] ui-text-muted">Sinyal Approval</p>
                                <h2 className="mt-1 text-lg font-bold ui-text">{canApproveDeposits ? 'Operator bisa approve' : 'Desk deposit baca saja'}</h2>
                                <p className="mt-1 text-xs ui-text-muted">{pageRangeText}</p>
                            </div>
                            <div className="flex gap-2">
                                <button
                                    onClick={fetchDeposits}
                                    className="ui-muted-action inline-flex items-center justify-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold"
                                >
                                    <RefreshCw className="h-4 w-4" />
                                    Segarkan
                                </button>
                                <button
                                    onClick={handleExport}
                                    disabled={exporting || summary.total === 0}
                                    className="ui-accent-solid inline-flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
                                >
                                    <Download className="h-4 w-4" />
                                    CSV
                                </button>
                            </div>
                        </div>
                        <div className="mt-5 space-y-3">
                            {(pendingDeposits.length > 0 ? pendingDeposits : deposits.slice(0, 4)).map((deposit) => (
                                <button
                                    key={deposit._id}
                                    type="button"
                                    onClick={() => setSelectedDeposit(deposit)}
                                    className="w-full rounded-2xl border ui-border bg-[var(--ui-card-muted)]/80 p-3 text-left transition hover:border-[var(--ui-accent)]"
                                >
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <p className="truncate text-sm font-semibold ui-text">{deposit.invoiceCode || `INV${deposit._id.slice(-8).toUpperCase()}`}</p>
                                            <p className="mt-1 truncate text-xs ui-text-muted">{deposit.user?.email || '-'} • {formatCurrency(deposit.totalAmount || deposit.amount)}</p>
                                        </div>
                                        <span className={`inline-flex shrink-0 rounded-full px-2 py-1 text-xs font-semibold ${statusBadgeClass[deposit.status]}`}>
                                            {statusLabel[deposit.status]}
                                        </span>
                                    </div>
                                </button>
                            ))}
                            {!loading && deposits.length === 0 && (
                                <div className="rounded-2xl border ui-border bg-[var(--ui-card-muted)]/80 p-4 text-sm ui-text-muted">
                                    Tidak ada deposit pada filter aktif.
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {message ? (
                <div
                    className={`rounded-xl border px-4 py-3 text-sm ${
                        message.type === 'success'
                            ? 'ui-success-chip'
                            : 'ui-danger-chip'
                    }`}
                >
                    {message.text}
                </div>
            ) : null}

            {!canApproveDeposits ? (
                <div className="ui-warning-chip rounded-xl border p-4 text-sm">
                    Akun ini dapat melihat deposit, tetapi tidak memiliki izin approve/reject.
                </div>
            ) : null}

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <div className="ui-panel-muted rounded-2xl border p-4">
                    <div className="flex items-start justify-between">
                        <div>
                            <p className="text-[11px] uppercase tracking-[0.18em] ui-text-muted">Total Hasil Filter</p>
                            <p className="mt-2 text-3xl font-black ui-text">{summary.total}</p>
                            <p className="mt-1 text-sm ui-text-muted">{pageRangeText}</p>
                        </div>
                        <div className="rounded-xl ui-info-chip border p-2.5">
                            <Wallet className="w-5 h-5" />
                        </div>
                    </div>
                </div>
                <div className="ui-panel-muted rounded-2xl border p-4">
                    <div className="flex items-start justify-between">
                        <div>
                            <p className="text-[11px] uppercase tracking-[0.18em] ui-text-muted">Pending</p>
                            <p className="mt-2 text-3xl font-black ui-text">{summary.pending}</p>
                            <p className="mt-1 text-sm ui-text-muted">{pageStats.pending} di halaman ini</p>
                        </div>
                        <div className="rounded-xl ui-warning-chip border p-2.5">
                            <Clock className="w-5 h-5" />
                        </div>
                    </div>
                </div>
                <div className="ui-panel-muted rounded-2xl border p-4">
                    <div className="flex items-start justify-between">
                        <div>
                            <p className="text-[11px] uppercase tracking-[0.18em] ui-text-muted">Approved</p>
                            <p className="mt-2 text-3xl font-black ui-text">{summary.approved}</p>
                            <p className="mt-1 text-sm ui-text-muted">{pageStats.approved} di halaman ini</p>
                        </div>
                        <div className="rounded-xl ui-success-chip border p-2.5">
                            <CheckCircle className="w-5 h-5" />
                        </div>
                    </div>
                </div>
                <div className="ui-panel-muted rounded-2xl border p-4">
                    <div className="flex items-start justify-between">
                        <div>
                            <p className="text-[11px] uppercase tracking-[0.18em] ui-text-muted">Rejected</p>
                            <p className="mt-2 text-3xl font-black ui-text">{summary.rejected}</p>
                            <p className="mt-1 text-sm ui-text-muted">Audit note tersimpan</p>
                        </div>
                        <div className="rounded-xl ui-danger-chip border p-2.5">
                            <ShieldAlert className="w-5 h-5" />
                        </div>
                    </div>
                </div>
            </div>

            <div className="ui-panel-muted overflow-hidden rounded-3xl border">
                <div className="border-b ui-border px-5 py-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] ui-accent-text">Filter Deposit</p>
                    <h2 className="mt-1 text-lg font-bold ui-text">Cari invoice, user, nominal, atau status</h2>
                </div>
                <div className="space-y-4 p-5">
                <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_180px_200px_200px]">
                    <input
                        placeholder="Cari invoice ID / ObjectId"
                        value={draftFilters.invoiceId}
                        onChange={(event) => setDraftFilters((current) => ({ ...current, invoiceId: event.target.value }))}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') applyFilters();
                        }}
                        className={fieldClass}
                        aria-label="Cari invoice deposit"
                    />
                    <input
                        placeholder="Cari nama atau email user"
                        value={draftFilters.userQuery}
                        onChange={(event) => setDraftFilters((current) => ({ ...current, userQuery: event.target.value }))}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') applyFilters();
                        }}
                        className={fieldClass}
                        aria-label="Cari user deposit"
                    />
                    <select
                        value={draftFilters.status}
                        onChange={(event) => setDraftFilters((current) => ({
                            ...current,
                            status: event.target.value as Filters['status']
                        }))}
                        className={fieldClass}
                    >
                        <option value="">Semua Status</option>
                        <option value="pending">Pending</option>
                        <option value="approved">Sukses</option>
                        <option value="rejected">Ditolak</option>
                    </select>
                    <select
                        value={draftFilters.assignment}
                        onChange={(event) => setDraftFilters((current) => ({
                            ...current,
                            assignment: event.target.value as Filters['assignment']
                        }))}
                        className={fieldClass}
                    >
                        <option value="">Semua Claim</option>
                        <option value="unassigned">Belum di-claim</option>
                        <option value="mine">Claim saya</option>
                        <option value="locked">Dikunci admin lain</option>
                    </select>
                    <input
                        placeholder="Cari total transfer"
                        value={draftFilters.totalTransfer}
                        onChange={(event) => setDraftFilters((current) => ({ ...current, totalTransfer: event.target.value }))}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') applyFilters();
                        }}
                        className={fieldClass}
                        aria-label="Cari total transfer deposit"
                    />
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    <button
                        onClick={applyFilters}
                        className="ui-accent-solid inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-colors"
                    >
                        <Search className="w-4 h-4" />
                        Cari
                    </button>
                    <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-xs ui-text-muted">Preset:</span>
                        <button
                            type="button"
                            onClick={() => applyPreset('pending-today')}
                            className="ui-muted-action rounded-full border px-3 py-1 text-xs font-semibold hover:border-[var(--ui-accent)]"
                        >
                            Pending
                        </button>
                        <button
                            type="button"
                            onClick={() => applyPreset('unassigned')}
                            className="ui-muted-action rounded-full border px-3 py-1 text-xs font-semibold hover:border-[var(--ui-accent)]"
                        >
                            Belum di-claim
                        </button>
                        <button
                            type="button"
                            onClick={() => applyPreset('mine')}
                            className="ui-muted-action rounded-full border px-3 py-1 text-xs font-semibold hover:border-[var(--ui-accent)]"
                        >
                            Claim saya
                        </button>
                    </div>
                    <button
                        onClick={resetFilters}
                        className="ui-muted-action inline-flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-semibold transition-colors"
                    >
                        <RotateCcw className="w-4 h-4" />
                        Reset
                    </button>
                    <div className="flex items-center gap-2 text-sm ui-text-muted">
                        <Filter className="w-4 h-4" />
                        <span>{pageRangeText}</span>
                    </div>
                    {hasUnappliedChanges && (
                        <span className="rounded-full border ui-warning-chip px-3 py-1 text-xs font-semibold">
                            Filter belum diterapkan
                        </span>
                    )}
                    {filters.assignment && filters.status && filters.status !== 'pending' && (
                        <span className="rounded-full border ui-warning-chip px-3 py-1 text-xs font-semibold">
                            Filter claim hanya berlaku untuk deposit pending
                        </span>
                    )}
                    {exportWillBeCapped && (
                        <span className="rounded-full border ui-danger-chip px-3 py-1 text-xs font-semibold">
                            Export dibatasi 5000 baris
                        </span>
                    )}
                </div>
                </div>
            </div>

            <div className="ui-panel-muted rounded-3xl border overflow-hidden">
                <div className="flex flex-col gap-3 border-b ui-border px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.22em] ui-accent-text">Antrean Deposit</p>
                        <h2 className="mt-1 text-lg font-bold ui-text">Daftar mutasi deposit user</h2>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        {canApproveDeposits && selectedCount > 0 ? (
                            <>
                                <span className="rounded-full border ui-accent-chip px-3 py-1 text-xs font-bold">
                                    {selectedCount} dipilih
                                </span>
                                <button
                                    type="button"
                                    onClick={() => { setBulkAction({ type: 'approve' }); setBulkNote(''); }}
                                    className="ui-success-action inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold"
                                >
                                    <CheckCircle className="h-3.5 w-3.5" />
                                    Setujui massal
                                </button>
                                <button
                                    type="button"
                                    onClick={() => { setBulkAction({ type: 'reject' }); setBulkNote(''); }}
                                    className="ui-danger-action inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold"
                                >
                                    <XCircle className="h-3.5 w-3.5" />
                                    Tolak massal
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setSelectedIds([])}
                                    className="ui-muted-action rounded-lg border px-3 py-1.5 text-xs font-semibold"
                                >
                                    Batal pilih
                                </button>
                            </>
                        ) : null}
                        <span className="text-xs ui-text-muted">{pageRangeText}</span>
                    </div>
                </div>
                <div className="overflow-x-auto">
                    <table className="min-w-full">
                        <thead>
                            <tr className="ui-panel ui-text-muted text-xs uppercase">
                                {canApproveDeposits ? (
                                    <th className="px-4 py-3 text-left font-semibold w-10">
                                        <input
                                            type="checkbox"
                                            aria-label="Pilih semua deposit pending di halaman ini"
                                            checked={allSelectableChecked}
                                            onChange={toggleSelectAll}
                                            disabled={selectableIds.length === 0}
                                            className="h-4 w-4 accent-[var(--ui-accent)] disabled:opacity-40"
                                        />
                                    </th>
                                ) : null}
                                <th className="px-4 py-3 text-left font-semibold">Invoice</th>
                                <th className="px-4 py-3 text-left font-semibold">User</th>
                                <th className="px-4 py-3 text-left font-semibold">Transfer</th>
                                <th className="px-4 py-3 text-left font-semibold">Metode</th>
                                <th className="px-4 py-3 text-left font-semibold">Status</th>
                                <th className="px-4 py-3 text-left font-semibold">Audit</th>
                                <th className="px-4 py-3 text-right font-semibold">Aksi</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--ui-border)]">
                            {loading ? (
                                <tr>
                                    <td colSpan={canApproveDeposits ? 8 : 7} className="px-4 py-10 text-center ui-text-muted">
                                        Memuat data deposit...
                                    </td>
                                </tr>
                            ) : deposits.length === 0 ? (
                                <tr>
                                    <td colSpan={canApproveDeposits ? 8 : 7} className="px-4 py-10 text-center ui-text-muted font-semibold">
                                        Tidak ada deposit yang cocok dengan filter aktif.
                                    </td>
                                </tr>
                            ) : (
                                deposits.map((deposit) => {
                                    const lockedByOther = isDepositLockedByOther(deposit);
                                    const canReleaseClaim = Boolean(deposit.assignedTo?._id) && (isOwner || isDepositAssignedToMe(deposit));
                                    const isSelectable = deposit.status === 'pending' && !lockedByOther;
                                    const isSelected = selectedIds.includes(deposit._id);

                                    return (
                                    <tr key={deposit._id} className={`hover:bg-[var(--ui-card-bg)] align-top ${isSelected ? 'bg-[var(--ui-accent-soft)]/40' : ''}`}>
                                        {canApproveDeposits ? (
                                            <td className="px-4 py-3 text-sm">
                                                <input
                                                    type="checkbox"
                                                    aria-label={`Pilih deposit ${deposit.invoiceCode || deposit._id}`}
                                                    checked={isSelected}
                                                    onChange={() => toggleSelectOne(deposit._id)}
                                                    disabled={!isSelectable}
                                                    className="h-4 w-4 accent-[var(--ui-accent)] disabled:opacity-40"
                                                />
                                            </td>
                                        ) : null}
                                        <td className="px-4 py-3 text-sm">
                                            <div className="space-y-1">
                                                <div className="font-semibold ui-info-text">{deposit.invoiceCode || `INV${deposit._id.slice(-8).toUpperCase()}`}</div>
                                                <div className="text-xs ui-text-muted break-all">{deposit._id}</div>
                                                <div className="flex items-center gap-2 text-xs ui-text-muted">
                                                    <span>{new Date(deposit.createdAt).toLocaleString('id-ID')}</span>
                                                    {deposit.status === 'pending' ? ageBadge(deposit.createdAt) : null}
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-4 py-3 text-sm ui-text">
                                            <div className="font-semibold">{deposit.user?.name || '-'}</div>
                                            <div className="text-xs ui-info-text break-all">{deposit.user?.email || '-'}</div>
                                        </td>
                                        <td className="px-4 py-3 text-sm ui-text">
                                            <div className="font-semibold">{formatCurrency(deposit.totalAmount || deposit.amount)}</div>
                                            <div className="text-xs ui-text-muted">Nominal {formatCurrency(deposit.amount)}</div>
                                            <div className="text-xs ui-success-text">Kode unik +{deposit.uniqueCode || 0}</div>
                                            <div className="text-xs ui-danger-text">Biaya admin -{formatCurrency(deposit.adminFee || 0)}</div>
                                            <div className="text-xs ui-info-text">Saldo masuk {formatCurrency(deposit.netAmount ?? (deposit.amount - (deposit.adminFee || 0)))}</div>
                                        </td>
                                        <td className="px-4 py-3 text-sm ui-text-muted">
                                            {deposit.paymentMethod ? (
                                                <div className="space-y-1">
                                                    <div className="font-semibold ui-text">{deposit.paymentMethod.name}</div>
                                                    <div className="text-xs ui-text-muted">{deposit.paymentMethod.accountNumber}</div>
                                                    <div className="text-xs ui-text-muted">{deposit.paymentMethod.accountName}</div>
                                                </div>
                                            ) : (
                                                <span className="ui-text-muted">Metode tidak tersedia</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 text-sm">
                                            <div className="space-y-2">
                                                <span className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${statusBadgeClass[deposit.status]}`}>
                                                    {statusLabel[deposit.status]}
                                                </span>
                                                {deposit.assignedTo?._id && (
                                                    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs font-semibold ${lockedByOther ? 'ui-danger-chip' : 'ui-info-chip'}`}>
                                                        <UserCheck className="h-3.5 w-3.5" />
                                                        {isDepositAssignedToMe(deposit) ? 'Claim Anda' : deposit.assignedTo.name || deposit.assignedTo.email || 'Claimed'}
                                                    </span>
                                                )}
                                            </div>
                                        </td>
                                        <td className="px-4 py-3 text-sm ui-text-muted">
                                            {deposit.processedBy ? (
                                                <div className="space-y-1">
                                                    <div className="font-semibold ui-text">{deposit.processedBy.name || '-'}</div>
                                                    <div className="text-xs ui-info-text break-all">{deposit.processedBy.email || '-'}</div>
                                                    <div className="text-xs ui-text-muted">
                                                        {deposit.processedAt ? new Date(deposit.processedAt).toLocaleString('id-ID') : '-'}
                                                    </div>
                                                </div>
                                            ) : (
                                                <span className="ui-text-muted">Belum diproses</span>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 text-right text-sm">
                                            <div className="inline-flex items-center gap-2">
                                                {deposit.status === 'pending' && canApproveDeposits ? (
                                                    <>
                                                        <button
                                                            onClick={() => handleClaimToggle(deposit)}
                                                            disabled={claimingId === deposit._id || lockedByOther}
                                                            className={`${canReleaseClaim ? 'ui-warning-chip' : 'ui-info-chip'} rounded px-2 py-1 disabled:opacity-50`}
                                                            title={canReleaseClaim ? 'Lepas claim' : 'Claim deposit'}
                                                        >
                                                            {canReleaseClaim ? <Unlock className="w-4 h-4" /> : <UserCheck className="w-4 h-4" />}
                                                        </button>
                                                        <button
                                                            onClick={() => openActionModal(deposit, 'approve')}
                                                            disabled={processingId === deposit._id || lockedByOther}
                                                            className="ui-success-action rounded px-2 py-1 disabled:opacity-50"
                                                            title="Setujui"
                                                        >
                                                            <CheckCircle className="w-4 h-4" />
                                                        </button>
                                                        <button
                                                            onClick={() => openActionModal(deposit, 'reject')}
                                                            disabled={processingId === deposit._id || lockedByOther}
                                                            className="ui-danger-action rounded px-2 py-1 disabled:opacity-50"
                                                            title="Tolak"
                                                        >
                                                            <XCircle className="w-4 h-4" />
                                                        </button>
                                                    </>
                                                ) : null}
                                                <button
                                                    onClick={() => setSelectedDeposit(deposit)}
                                                    className="rounded ui-accent-chip px-2 py-1 ui-accent-text hover:text-[var(--ui-accent-strong)]"
                                                    title="Lihat Detail"
                                                >
                                                    <Eye className="w-4 h-4" />
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                </div>
                <div className="flex flex-col gap-3 border-t ui-border ui-panel px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-3 text-sm ui-text-muted">
                        <span>{pageRangeText}</span>
                        <select
                            value={meta.limit}
                            onChange={(event) => {
                                const nextLimit = Number(event.target.value);
                                setMeta((current) => ({
                                    ...current,
                                    page: 1,
                                    limit: Number.isFinite(nextLimit) ? nextLimit : current.limit
                                }));
                            }}
                            className="rounded-lg border ui-border ui-panel-muted px-3 py-1.5 text-sm ui-text"
                        >
                            {[10, 20, 50, 100].map((value) => (
                                <option key={value} value={value}>{value} / halaman</option>
                            ))}
                        </select>
                    </div>
                    <div className="flex items-center justify-end gap-2">
                        <button
                            onClick={() => setMeta((current) => ({ ...current, page: Math.max(1, current.page - 1) }))}
                            disabled={meta.page <= 1 || loading}
                            className="inline-flex items-center gap-2 rounded-lg border ui-border px-3 py-2 text-sm font-semibold ui-text-muted hover:bg-[var(--ui-card-muted)] disabled:opacity-50"
                        >
                            <ChevronLeft className="w-4 h-4" />
                            Sebelumnya
                        </button>
                        <span className="text-sm ui-text-muted">
                            Halaman {meta.page} / {meta.totalPages}
                        </span>
                        <button
                            onClick={() => setMeta((current) => ({ ...current, page: Math.min(current.totalPages, current.page + 1) }))}
                            disabled={meta.page >= meta.totalPages || loading}
                            className="inline-flex items-center gap-2 rounded-lg border ui-border px-3 py-2 text-sm font-semibold ui-text-muted hover:bg-[var(--ui-card-muted)] disabled:opacity-50"
                        >
                            Berikutnya
                            <ChevronRight className="w-4 h-4" />
                        </button>
                    </div>
                </div>
            </div>

            {selectedDeposit ? (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
                    <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-xl border ui-border ui-panel-muted shadow-xl">
                        <div className="flex items-center justify-between border-b ui-border ui-panel p-4">
                            <h2 className="text-lg font-semibold ui-text">Detail Deposit</h2>
                            <button onClick={() => setSelectedDeposit(null)} className="ui-text-muted hover:text-[var(--ui-text)]">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <div className="space-y-4 p-5">
                            <div className="flex justify-center">
                                <span className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold ${statusBadgeClass[selectedDeposit.status]}`}>
                                    {selectedDeposit.status === 'approved' ? <CheckCircle className="w-4 h-4" /> : null}
                                    {selectedDeposit.status === 'pending' ? <Clock className="w-4 h-4" /> : null}
                                    {selectedDeposit.status === 'rejected' ? <XCircle className="w-4 h-4" /> : null}
                                    {statusLabel[selectedDeposit.status].toUpperCase()}
                                </span>
                            </div>

                            <div className="grid gap-4 md:grid-cols-2">
                                <div className="rounded-lg border ui-border ui-panel p-4 space-y-3">
                                    <p className="text-xs font-semibold uppercase tracking-wide ui-accent-text">Info User</p>
                                    <div className="flex justify-between gap-4">
                                        <span className="text-sm ui-text-muted">Nama</span>
                                        <span className="text-right text-sm font-semibold ui-text">{selectedDeposit.user?.name || '-'}</span>
                                    </div>
                                    <div className="flex justify-between gap-4">
                                        <span className="text-sm ui-text-muted">Email</span>
                                        <span className="text-right text-sm ui-info-text break-all">{selectedDeposit.user?.email || '-'}</span>
                                    </div>
                                </div>

                                <div className="rounded-lg border ui-border ui-panel p-4 space-y-3">
                                    <p className="text-xs font-semibold uppercase tracking-wide ui-accent-text">Info Deposit</p>
                                    <div className="flex justify-between gap-4">
                                        <span className="text-sm ui-text-muted">Invoice</span>
                                        <span className="text-right text-sm font-mono ui-info-text">{selectedDeposit.invoiceCode || `INV${selectedDeposit._id.slice(-8).toUpperCase()}`}</span>
                                    </div>
                                    <div className="flex justify-between gap-4">
                                        <span className="text-sm ui-text-muted">Dibuat</span>
                                        <span className="text-right text-sm ui-text">{new Date(selectedDeposit.createdAt).toLocaleString('id-ID')}</span>
                                    </div>
                                    <div className="flex justify-between gap-4">
                                        <span className="text-sm ui-text-muted">Diupdate</span>
                                        <span className="text-right text-sm ui-text-muted">{new Date(selectedDeposit.updatedAt).toLocaleString('id-ID')}</span>
                                    </div>
                                </div>
                            </div>

                            <div className="rounded-lg border ui-border ui-panel p-4 space-y-3">
                                <p className="text-xs font-semibold uppercase tracking-wide ui-accent-text">Info Keuangan</p>
                                <div className="grid gap-3 md:grid-cols-2">
                                    <div className="flex justify-between gap-4">
                                        <span className="text-sm ui-text-muted">Nominal</span>
                                        <span className="text-right text-sm font-semibold ui-text">{formatCurrency(selectedDeposit.amount)}</span>
                                    </div>
                                    <div className="flex justify-between gap-4">
                                        <span className="text-sm ui-text-muted">Kode Unik</span>
                                        <span className="text-right text-sm font-semibold ui-success-text">+{selectedDeposit.uniqueCode || 0}</span>
                                    </div>
                                    <div className="flex justify-between gap-4">
                                        <span className="text-sm ui-text-muted">Total Transfer</span>
                                        <span className="text-right text-sm font-bold ui-accent-text">{formatCurrency(selectedDeposit.totalAmount || selectedDeposit.amount)}</span>
                                    </div>
                                    <div className="flex justify-between gap-4">
                                        <span className="text-sm ui-text-muted">Biaya Admin</span>
                                        <span className="text-right text-sm font-semibold ui-danger-text">-{formatCurrency(selectedDeposit.adminFee || 0)}</span>
                                    </div>
                                </div>
                                <div className="rounded-lg border p-3 text-sm ui-info-chip">
                                    Saldo diterima: <span className="font-bold ui-info-text">{formatCurrency(selectedDeposit.netAmount ?? (selectedDeposit.amount - (selectedDeposit.adminFee || 0)))}</span>
                                </div>
                            </div>

                            <div className="rounded-lg border ui-border ui-panel p-4 space-y-3">
                                <p className="text-xs font-semibold uppercase tracking-wide ui-accent-text">Metode Pembayaran</p>
                                {selectedDeposit.paymentMethod ? (
                                    <>
                                        <div className="flex justify-between gap-4">
                                            <span className="text-sm ui-text-muted">Metode</span>
                                            <span className="text-right text-sm font-semibold ui-text">{selectedDeposit.paymentMethod.name}</span>
                                        </div>
                                        <div className="flex justify-between gap-4">
                                            <span className="text-sm ui-text-muted">No. Rekening</span>
                                            <span className="text-right text-sm font-mono ui-text">{selectedDeposit.paymentMethod.accountNumber || '-'}</span>
                                        </div>
                                        <div className="flex justify-between gap-4">
                                            <span className="text-sm ui-text-muted">Atas Nama</span>
                                            <span className="text-right text-sm ui-text">{selectedDeposit.paymentMethod.accountName || '-'}</span>
                                        </div>
                                    </>
                                ) : (
                                    <p className="text-sm ui-text-muted">Metode pembayaran sudah tidak tersedia.</p>
                                )}
                            </div>

                            <div className="rounded-lg border ui-border ui-panel p-4 space-y-3">
                                <p className="text-xs font-semibold uppercase tracking-wide ui-accent-text">Audit Proses</p>
                                <div className="flex justify-between gap-4">
                                    <span className="text-sm ui-text-muted">Claim</span>
                                    <span className="text-right text-sm ui-text">
                                        {selectedDeposit.assignedTo?.name || selectedDeposit.assignedTo?.email || '-'}
                                        {selectedDeposit.assignedAt ? ` • ${new Date(selectedDeposit.assignedAt).toLocaleString('id-ID')}` : ''}
                                    </span>
                                </div>
                                <div className="flex justify-between gap-4">
                                    <span className="text-sm ui-text-muted">Diproses Oleh</span>
                                    <span className="text-right text-sm ui-text">
                                        {selectedDeposit.processedBy?.name || '-'}
                                        {selectedDeposit.processedBy?.email ? ` (${selectedDeposit.processedBy.email})` : ''}
                                    </span>
                                </div>
                                <div className="flex justify-between gap-4">
                                    <span className="text-sm ui-text-muted">Waktu Proses</span>
                                    <span className="text-right text-sm ui-text-muted">
                                        {selectedDeposit.processedAt ? new Date(selectedDeposit.processedAt).toLocaleString('id-ID') : '-'}
                                    </span>
                                </div>
                                <div className="space-y-2">
                                    <span className="text-sm ui-text-muted">Catatan</span>
                                    <div className="rounded-lg border ui-border ui-panel-muted p-3 text-sm ui-text">
                                        {selectedDeposit.processingNote?.trim() || 'Tidak ada catatan proses.'}
                                    </div>
                                </div>
                            </div>

                            <div className="flex flex-wrap gap-3">
                                {selectedDeposit.status === 'pending' && canApproveDeposits ? (
                                    <>
                                        <button
                                            onClick={() => handleClaimToggle(selectedDeposit)}
                                            disabled={claimingId === selectedDeposit._id || isDepositLockedByOther(selectedDeposit)}
                                            className="ui-info-chip flex-1 rounded-lg border px-4 py-2.5 text-sm font-semibold disabled:opacity-50"
                                        >
                                            {selectedDeposit.assignedTo?._id && (isOwner || isDepositAssignedToMe(selectedDeposit)) ? 'Lepas Claim' : 'Claim Deposit'}
                                        </button>
                                        <button
                                            onClick={() => openActionModal(selectedDeposit, 'approve')}
                                            disabled={isDepositLockedByOther(selectedDeposit)}
                                            className="ui-success-action flex-1 rounded-lg px-4 py-2.5 text-sm font-semibold disabled:opacity-50"
                                        >
                                            Setujui
                                        </button>
                                        <button
                                            onClick={() => openActionModal(selectedDeposit, 'reject')}
                                            disabled={isDepositLockedByOther(selectedDeposit)}
                                            className="ui-danger-action flex-1 rounded-lg px-4 py-2.5 text-sm font-semibold disabled:opacity-50"
                                        >
                                            Tolak
                                        </button>
                                    </>
                                ) : null}
                                <button
                                    onClick={() => setSelectedDeposit(null)}
                                    className="flex-1 rounded-lg border ui-border px-4 py-2.5 text-sm font-medium ui-text-muted hover:bg-[var(--ui-card-muted)]"
                                >
                                    Tutup
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}

            {actionState ? (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
                    <div className="w-full max-w-lg rounded-xl border ui-border ui-panel-muted shadow-xl">
                        <div className="border-b ui-border p-4">
                            <h2 className="text-lg font-semibold ui-text">
                                {actionState.type === 'approve' ? 'Setujui Deposit' : 'Tolak Deposit'}
                            </h2>
                            <p className="mt-1 text-sm ui-text-muted">
                                {actionState.deposit.invoiceCode || `INV${actionState.deposit._id.slice(-8).toUpperCase()}`} • {actionState.deposit.user?.email || '-'}
                            </p>
                        </div>
                        <div className="space-y-4 p-4">
                            <div className="rounded-lg border ui-border ui-panel p-3">
                                <p className="text-sm ui-text">
                                    Total transfer: <span className="font-semibold">{formatCurrency(actionState.deposit.totalAmount || actionState.deposit.amount)}</span>
                                </p>
                                <p className="mt-1 text-sm ui-info-text">
                                    Saldo masuk: <span className="font-semibold">{formatCurrency(actionState.deposit.netAmount ?? (actionState.deposit.amount - (actionState.deposit.adminFee || 0)))}</span>
                                </p>
                            </div>
                            <div className="space-y-2">
                                <label className="block text-sm font-medium ui-text-muted">
                                    {actionState.type === 'approve' ? 'Catatan approval' : 'Catatan penolakan'}
                                </label>
                                <textarea
                                    value={actionNote}
                                    onChange={(event) => setActionNote(event.target.value)}
                                    rows={4}
                                    className="ui-field w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
                                    placeholder={actionState.type === 'approve' ? 'Contoh: cocok mutasi bank pukul 12:34.' : 'Jelaskan alasan penolakan deposit.'}
                                />
                            </div>
                            {actionState.type === 'approve' && (
                                <div className="rounded-lg border p-3 text-sm ui-warning-chip">
                                    Anda akan menambah saldo user sebesar <strong>{formatCurrency(actionState.deposit.netAmount ?? (actionState.deposit.amount - (actionState.deposit.adminFee || 0)))}</strong>. Pastikan transfer sudah cocok dengan mutasi bank dan catatan approval terisi.
                                </div>
                            )}
                            <div className="flex justify-end gap-3">
                                <button
                                    type="button"
                                    onClick={closeActionModal}
                                    className="rounded-lg border ui-border px-4 py-2 text-sm font-medium ui-text-muted hover:bg-[var(--ui-card-muted)]"
                                >
                                    Batal
                                </button>
                                <button
                                    type="button"
                                    onClick={handleAction}
                                    disabled={processingId === actionState.deposit._id || actionNote.trim().length < 5}
                                    className={`rounded-lg px-4 py-2 text-sm font-semibold ui-text disabled:opacity-50 ${
                                        actionState.type === 'approve'
                                            ? 'ui-success-action'
                                            : 'ui-danger-action'
                                    }`}
                                >
                                    {processingId === actionState.deposit._id
                                        ? 'Memproses...'
                                        : actionState.type === 'approve'
                                            ? 'Setujui'
                                            : 'Tolak'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}
        </div>
            {bulkAction ? (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
                    <div className="w-full max-w-lg rounded-xl border ui-border ui-panel-muted shadow-xl">
                        <div className="border-b ui-border p-4">
                            <h2 className="text-lg font-semibold ui-text">
                                {bulkAction.type === 'approve' ? 'Setujui Massal' : 'Tolak Massal'} — {selectedIds.length} deposit
                            </h2>
                            <p className="mt-1 text-sm ui-text-muted">
                                Aksi ini memproses satu per satu; yang gagal dilewati dan dilaporkan.
                            </p>
                        </div>
                        <div className="space-y-4 p-4">
                            <div className="rounded-lg border ui-border ui-panel p-3 text-sm ui-text">
                                {selectedIds.slice(0, 5).map((id) => {
                                    const deposit = deposits.find((item) => item._id === id);
                                    if (!deposit) return null;
                                    return (
                                        <div key={id} className="flex items-center justify-between gap-3 py-1">
                                            <span className="truncate font-mono text-xs ui-info-text">
                                                {deposit.invoiceCode || `INV${id.slice(-8).toUpperCase()}`}
                                            </span>
                                            <span className="shrink-0 text-xs font-semibold">
                                                {formatCurrency(deposit.totalAmount || deposit.amount)}
                                            </span>
                                        </div>
                                    );
                                })}
                                {selectedIds.length > 5 ? (
                                    <p className="pt-1 text-xs ui-text-muted">+{selectedIds.length - 5} deposit lainnya</p>
                                ) : null}
                            </div>
                            <div className="space-y-2">
                                <label className="block text-sm font-medium ui-text-muted">
                                    {bulkAction.type === 'approve' ? 'Catatan approval (dipakai untuk semua)' : 'Catatan penolakan (dipakai untuk semua)'}
                                </label>
                                <textarea
                                    value={bulkNote}
                                    onChange={(event) => setBulkNote(event.target.value)}
                                    rows={3}
                                    className="ui-field w-full rounded-lg border px-3 py-2 text-sm focus:outline-none"
                                    placeholder={bulkAction.type === 'approve' ? 'Contoh: mutasi batch pagi terverifikasi.' : 'Jelaskan alasan penolakan.'}
                                />
                            </div>
                            {bulkAction.type === 'approve' ? (
                                <div className="rounded-lg border p-3 text-sm ui-warning-chip">
                                    Saldo {selectedIds.length} user akan bertambah. Pastikan semua mutasi sudah diverifikasi.
                                </div>
                            ) : null}
                            <div className="flex justify-end gap-3">
                                <button
                                    type="button"
                                    onClick={() => { setBulkAction(null); setBulkNote(''); }}
                                    disabled={bulkRunning}
                                    className="rounded-lg border ui-border px-4 py-2 text-sm font-medium ui-text-muted hover:bg-[var(--ui-card-muted)] disabled:opacity-50"
                                >
                                    Batal
                                </button>
                                <button
                                    type="button"
                                    onClick={handleBulkAction}
                                    disabled={bulkRunning || bulkNote.trim().length < 5}
                                    className={`rounded-lg px-4 py-2 text-sm font-semibold ui-text disabled:opacity-50 ${
                                        bulkAction.type === 'approve' ? 'ui-success-action' : 'ui-danger-action'
                                    }`}
                                >
                                    {bulkRunning
                                        ? 'Memproses...'
                                        : bulkAction.type === 'approve'
                                            ? `Setujui ${selectedIds.length}`
                                            : `Tolak ${selectedIds.length}`}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}
            {stepUp.dialog}
        </>
    );
}
