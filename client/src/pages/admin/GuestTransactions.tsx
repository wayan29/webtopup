import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiV2 } from '../../api';
import { useStepUpOrchestration } from '../../auth/useStepUpOrchestration';
import { stepUpActionErrorMessage } from '../../auth/withStepUp';
import { useAuthStore } from '../../store/useAuthStore';
import {
    AlertTriangle,
    CheckCircle,
    Clock,
    Copy,
    Edit,
    Eye,
    Loader2,
    RefreshCw,
    RotateCcw,
    Search,

    X,
    XCircle
} from 'lucide-react';

type PaymentStatus = 'waiting_payment' | 'paid' | 'expired' | 'cancelled';
type TransactionStatus = 'pending' | 'processing' | 'success' | 'failed';

interface AdminGuestTransaction {
    _id: string;
    invoiceNumber: string;
    target: string;
    whatsapp: string;
    email?: string;
    amount: number;
    adminFee: number;
    uniqueCode: number;
    totalAmount: number;
    paymentStatus: PaymentStatus;
    transactionStatus: TransactionStatus;
    vendorTrxId?: string;
    sn?: string;
    paidAt?: string;
    expiredAt: string;
    createdAt: string;
    updatedAt: string;
    statusUpdatedAt?: string;
    statusUpdateNote?: string;
    user?: {
        _id?: string;
        name?: string;
        email?: string;
    };
    product?: {
        _id?: string;
        name?: string;
        code?: string;
        category?: string;
        brand?: string;
        vendorName?: string;
    };
    paymentMethod?: {
        _id?: string;
        name?: string;
        categoryName?: string;
        accountName?: string;
        accountNumber?: string;
    };
    statusUpdatedBy?: {
        _id?: string;
        name?: string;
        email?: string;
        role?: string;
    };
}

interface GuestTransactionsResponse {
    items: AdminGuestTransaction[];
    meta: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
    };
    summary: {
        total: number;
        amountTotal: number;
        waitingPayment: number;
        paid: number;
        expired: number;
        cancelled: number;
        processing: number;
        success: number;
        failed: number;
    };
}

type FilterState = {
    search: string;
    scope: 'actionable' | 'all';
    paymentStatus: '' | PaymentStatus;
    transactionStatus: '' | TransactionStatus;
    startDate: string;
    endDate: string;
};

type ActionMode = 'confirm' | 'cancel' | 'edit' | null;

const defaultFilters: FilterState = {
    search: '',
    scope: 'actionable',
    paymentStatus: '',
    transactionStatus: '',
    startDate: '',
    endDate: ''
};

const formatCurrency = (value: number) => `Rp${value.toLocaleString('id-ID')}`;
const formatDateTime = (value?: string) => (
    value
        ? new Date(value).toLocaleString('id-ID', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        })
        : '-'
);

const getPaymentStatusBadge = (status: PaymentStatus, size: 'sm' | 'md' = 'sm') => {
    const baseClass = size === 'md'
        ? 'px-3 py-1.5 text-sm font-semibold rounded-full'
        : 'px-2 py-1 text-xs font-semibold rounded-full';

    switch (status) {
        case 'waiting_payment':
            return <span className={`${baseClass} border ui-warning-chip`}>Menunggu Bayar</span>;
        case 'paid':
            return <span className={`${baseClass} border ui-success-chip`}>Sudah Dibayar</span>;
        case 'expired':
            return <span className={`${baseClass} ui-panel-muted ui-text-muted`}>Expired</span>;
        case 'cancelled':
            return <span className={`${baseClass} border ui-danger-chip`}>Dibatalkan</span>;
        default:
            return <span className={`${baseClass} ui-panel-muted ui-text-muted`}>{status}</span>;
    }
};

const getTransactionStatusBadge = (status: TransactionStatus, size: 'sm' | 'md' = 'sm') => {
    const baseClass = size === 'md'
        ? 'px-3 py-1.5 text-sm font-semibold rounded-full'
        : 'px-2 py-1 text-xs font-semibold rounded-full';

    switch (status) {
        case 'pending':
            return <span className={`${baseClass} border ui-warning-chip`}>Pending</span>;
        case 'processing':
            return <span className={`${baseClass} border ui-info-chip`}>Processing</span>;
        case 'success':
            return <span className={`${baseClass} border ui-success-chip`}>Sukses</span>;
        case 'failed':
            return <span className={`${baseClass} border ui-danger-chip`}>Gagal</span>;
        default:
            return <span className={`${baseClass} ui-panel-muted ui-text-muted`}>{status}</span>;
    }
};

const isExpiredByTime = (transaction: AdminGuestTransaction) => {
    const expiredAt = new Date(transaction.expiredAt).getTime();
    return Number.isFinite(expiredAt) && expiredAt <= Date.now();
};

const canConfirmTransaction = (transaction: AdminGuestTransaction) => (
    transaction.paymentStatus === 'waiting_payment' && transaction.transactionStatus === 'pending' && !isExpiredByTime(transaction)
);

const canCancelTransaction = (transaction: AdminGuestTransaction) => (
    transaction.paymentStatus === 'waiting_payment' ||
    (transaction.paymentStatus === 'paid' && transaction.transactionStatus === 'failed')
);

const canEditTransaction = (transaction: AdminGuestTransaction) => (
    transaction.paymentStatus === 'paid' ||
    transaction.paymentStatus === 'expired' ||
    transaction.paymentStatus === 'cancelled'
);

const getAllowedEditStatuses = (transaction: AdminGuestTransaction): TransactionStatus[] => {
    if (transaction.paymentStatus === 'paid') {
        return ['processing', 'success', 'failed'];
    }

    if (transaction.paymentStatus === 'expired' || transaction.paymentStatus === 'cancelled') {
        return ['failed'];
    }

    return ['pending'];
};

const getTransactionIcon = (status: TransactionStatus) => {
    switch (status) {
        case 'success':
            return <CheckCircle className="w-12 h-12 ui-success-text" />;
        case 'processing':
            return <RefreshCw className="w-12 h-12 ui-info-text animate-spin" />;
        case 'failed':
            return <XCircle className="w-12 h-12 ui-danger-text" />;
        case 'pending':
            return <Clock className="w-12 h-12 ui-warning-text" />;
        default:
            return <Clock className="w-12 h-12 ui-text-muted" />;
    }
};

export default function GuestTransactions() {
    const stepUp = useStepUpOrchestration();
    const { hasPermission, isOwner } = useAuthStore();
    const canProcess = isOwner || hasPermission('processManualTransaction');

    const [transactions, setTransactions] = useState<AdminGuestTransaction[]>([]);
    const [summary, setSummary] = useState<GuestTransactionsResponse['summary']>({
        total: 0,
        amountTotal: 0,
        waitingPayment: 0,
        paid: 0,
        expired: 0,
        cancelled: 0,
        processing: 0,
        success: 0,
        failed: 0
    });
    const [meta, setMeta] = useState<GuestTransactionsResponse['meta']>({
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 1
    });
    const [filters, setFilters] = useState<FilterState>(defaultFilters);
    const [appliedFilters, setAppliedFilters] = useState<FilterState>(defaultFilters);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [selectedTransaction, setSelectedTransaction] = useState<AdminGuestTransaction | null>(null);
    const [actionTransaction, setActionTransaction] = useState<AdminGuestTransaction | null>(null);
    const [actionMode, setActionMode] = useState<ActionMode>(null);
    const [copied, setCopied] = useState<string | null>(null);
    const [errorMessage, setErrorMessage] = useState('');
    const [successMessage, setSuccessMessage] = useState('');
    const latestRequestId = useRef(0);
    const [actionForm, setActionForm] = useState({
        note: '',
        transactionStatus: 'processing' as TransactionStatus,
        vendorTrxId: '',
        sn: ''
    });

    const inputClass = 'w-full rounded-lg ui-field border px-3 py-2 text-sm';
    const selectClass = 'w-full rounded-lg ui-field border px-3 py-2 text-sm';

    const hasInvalidRange = Boolean(filters.startDate && filters.endDate && filters.startDate > filters.endDate);
    const hasUnappliedChanges = useMemo(() => (
        filters.search !== appliedFilters.search
        || filters.scope !== appliedFilters.scope
        || filters.paymentStatus !== appliedFilters.paymentStatus
        || filters.transactionStatus !== appliedFilters.transactionStatus
        || filters.startDate !== appliedFilters.startDate
        || filters.endDate !== appliedFilters.endDate
    ), [appliedFilters, filters]);

    const refreshSidebarBadges = () => {
        window.dispatchEvent(new Event('admin:sidebar-badges-refresh'));
    };

    const fetchTransactions = useCallback(async () => {
        const requestId = latestRequestId.current + 1;
        latestRequestId.current = requestId;
        setLoading(true);
        setErrorMessage('');

        try {
            const params: Record<string, string | number> = {
                page: meta.page,
                limit: meta.limit,
                scope: appliedFilters.scope
            };

            if (appliedFilters.search) params.search = appliedFilters.search;
            if (appliedFilters.paymentStatus) params.paymentStatus = appliedFilters.paymentStatus;
            if (appliedFilters.transactionStatus) params.transactionStatus = appliedFilters.transactionStatus;
            if (appliedFilters.startDate) params.startDate = appliedFilters.startDate;
            if (appliedFilters.endDate) params.endDate = appliedFilters.endDate;

            const response = await apiV2.get<GuestTransactionsResponse>('/guest-transactions', { params });
            if (requestId !== latestRequestId.current) return;
            setTransactions(response.data.items || []);
            setSummary(response.data.summary);
            setMeta(response.data.meta);
        } catch (error: any) {
            if (requestId !== latestRequestId.current) return;
            setErrorMessage(error.response?.data?.message || 'Gagal memuat transaksi guest');
        } finally {
            if (requestId === latestRequestId.current) {
                setLoading(false);
            }
        }
    }, [appliedFilters, meta.limit, meta.page]);

    useEffect(() => {
        fetchTransactions();
    }, [fetchTransactions]);

    useEffect(() => {
        const handleRefresh = () => fetchTransactions();
        window.addEventListener('admin:refresh-current-page', handleRefresh);
        return () => window.removeEventListener('admin:refresh-current-page', handleRefresh);
    }, [fetchTransactions]);

    const rangeLabel = useMemo(() => {
        if (meta.total === 0) {
            return '0 data';
        }

        const start = (meta.page - 1) * meta.limit + 1;
        const end = Math.min(meta.page * meta.limit, meta.total);
        return `${start}-${end} dari ${meta.total} transaksi`;
    }, [meta]);

    const scopeLabel = useMemo(() => {
        if (appliedFilters.scope === 'all') {
            return 'Menampilkan seluruh histori guest transaction';
        }

        return 'Menampilkan antrean pembayaran masuk dan fulfillment yang belum selesai';
    }, [appliedFilters.scope]);

    const priorityTransactions = transactions
        .filter((transaction) => canConfirmTransaction(transaction) || canCancelTransaction(transaction) || canEditTransaction(transaction))
        .slice(0, 4);

    const resetFilters = () => {
        setFilters(defaultFilters);
        setAppliedFilters(defaultFilters);
        setMeta((current) => ({ ...current, page: 1 }));
        setSuccessMessage('');
    };

    const applyFilters = () => {
        setErrorMessage('');
        if (hasInvalidRange) {
            setErrorMessage('Tanggal mulai tidak boleh lebih besar dari tanggal akhir.');
            return;
        }
        setAppliedFilters({ ...filters });
        setMeta((current) => ({ ...current, page: 1 }));
        setSuccessMessage('');
    };

    const copyToClipboard = async (text: string, key: string) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(key);
            window.setTimeout(() => setCopied(null), 1600);
        } catch {
            setErrorMessage('Gagal menyalin data');
        }
    };

    const closeActionModal = () => {
        setActionMode(null);
        setActionTransaction(null);
        setActionForm({
            note: '',
            transactionStatus: 'processing',
            vendorTrxId: '',
            sn: ''
        });
    };

    const openActionModal = (mode: Exclude<ActionMode, null>, transaction: AdminGuestTransaction) => {
        const allowedStatuses = getAllowedEditStatuses(transaction);
        setActionMode(mode);
        setActionTransaction(transaction);
        setActionForm({
            note: '',
            transactionStatus: allowedStatuses.includes(transaction.transactionStatus)
                ? transaction.transactionStatus
                : allowedStatuses[0],
            vendorTrxId: transaction.vendorTrxId || '',
            sn: transaction.sn || ''
        });
        setSuccessMessage('');
        setErrorMessage('');
    };

    const submitAction = async () => {
        if (!actionMode || !actionTransaction) {
            return;
        }

        setSaving(true);
        setErrorMessage('');
        setSuccessMessage('');

        try {
            let response;

            if (actionMode === 'confirm') {
                const payload = {
                    note: actionForm.note
                };
                response = await stepUp.run('transactions.manual', (config) =>
                    apiV2.post(`/guest-transactions/${actionTransaction._id}/confirm`, payload, config as never),
                );
                setSuccessMessage('Pembayaran guest berhasil dikonfirmasi');
            } else if (actionMode === 'cancel') {
                const payload = {
                    note: actionForm.note
                };
                response = await stepUp.run('transactions.manual', (config) =>
                    apiV2.post(`/guest-transactions/${actionTransaction._id}/cancel`, payload, config as never),
                );
                setSuccessMessage('Transaksi guest berhasil dibatalkan');
            } else {
                const payload = {
                    transactionStatus: actionForm.transactionStatus,
                    vendorTrxId: actionForm.vendorTrxId,
                    sn: actionForm.sn,
                    note: actionForm.note
                };
                response = await stepUp.run('transactions.manual', (config) =>
                    apiV2.put(`/guest-transactions/${actionTransaction._id}/status`, payload, config as never),
                );
                setSuccessMessage('Status transaksi guest berhasil diperbarui');
            }

            const updatedTransaction = response?.data?.transaction as AdminGuestTransaction | undefined;
            if (updatedTransaction && selectedTransaction?._id === updatedTransaction._id) {
                setSelectedTransaction(updatedTransaction);
            }

            refreshSidebarBadges();
            closeActionModal();
            await fetchTransactions();
        } catch (error: any) {
            const text = stepUpActionErrorMessage(error, 'Aksi transaksi guest gagal diproses');
            if (text) setErrorMessage(text);
        } finally {
            setSaving(false);
        }
    };

    return (<>
        <div className="space-y-6">
            <div className="ui-panel rounded-2xl border ui-border p-4 sm:p-5">
                <div className="relative">
                    <div className="rounded-3xl border ui-border bg-[var(--ui-card-bg)]/75 p-5 backdrop-blur">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <p className="text-xs uppercase tracking-[0.18em] ui-text-muted">Sinyal Operator</p>
                                <h2 className="mt-1 text-lg font-bold ui-text">{canProcess ? 'Aksi aktif' : 'Akses baca saja'}</h2>
                                <p className="mt-1 text-xs ui-text-muted">{scopeLabel}</p>
                            </div>
                            <button
                                type="button"
                                onClick={fetchTransactions}
                                className="ui-accent-chip inline-flex items-center justify-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold transition"
                            >
                                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                                Segarkan
                            </button>
                        </div>
                        <div className="mt-5 space-y-3">
                            {(priorityTransactions.length > 0 ? priorityTransactions : transactions.slice(0, 4)).map((transaction) => (
                                <button
                                    key={transaction._id}
                                    type="button"
                                    onClick={() => setSelectedTransaction(transaction)}
                                    className="w-full rounded-2xl border ui-border bg-[var(--ui-card-muted)]/80 p-3 text-left transition hover:border-[var(--ui-accent)]"
                                >
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <p className="truncate text-sm font-semibold ui-text">{transaction.invoiceNumber}</p>
                                            <p className="mt-1 truncate text-xs ui-text-muted">{transaction.target} • {formatCurrency(transaction.totalAmount)}</p>
                                        </div>
                                        <div className="flex shrink-0 flex-col items-end gap-1">
                                            {getPaymentStatusBadge(transaction.paymentStatus)}
                                            {getTransactionStatusBadge(transaction.transactionStatus)}
                                        </div>
                                    </div>
                                </button>
                            ))}
                            {!loading && transactions.length === 0 && (
                                <div className="rounded-2xl border ui-border bg-[var(--ui-card-muted)]/80 p-4 text-sm ui-text-muted">
                                    Tidak ada prioritas guest pada filter aktif.
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {(errorMessage || successMessage) && (
                <div className="space-y-3">
                    {errorMessage && (
                        <div className="flex items-start gap-3 rounded-2xl border px-4 py-3 text-sm ui-danger-chip">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                            <span>{errorMessage}</span>
                        </div>
                    )}
                    {successMessage && (
                        <div className="flex items-start gap-3 rounded-2xl border px-4 py-3 text-sm ui-success-chip">
                            <CheckCircle className="mt-0.5 h-4 w-4 shrink-0" />
                            <span>{successMessage}</span>
                        </div>
                    )}
                </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
                <div className="ui-panel-muted rounded-2xl border p-4">
                    <p className="text-xs uppercase tracking-[0.18em] ui-text-muted">Menunggu Bayar</p>
                    <p className="mt-3 text-3xl font-bold ui-text">{summary.waitingPayment}</p>
                    <p className="mt-2 text-xs ui-warning-text">Invoice yang masih butuh verifikasi transfer.</p>
                </div>
                <div className="ui-panel-muted rounded-2xl border p-4">
                    <p className="text-xs uppercase tracking-[0.18em] ui-text-muted">Sudah Dibayar</p>
                    <p className="mt-3 text-3xl font-bold ui-text">{summary.paid}</p>
                    <p className="mt-2 text-xs ui-success-text">Pembayaran masuk yang sudah diakui sistem.</p>
                </div>
                <div className="ui-panel-muted rounded-2xl border p-4">
                    <p className="text-xs uppercase tracking-[0.18em] ui-text-muted">Processing</p>
                    <p className="mt-3 text-3xl font-bold ui-text">{summary.processing}</p>
                    <p className="mt-2 text-xs ui-info-text">Fulfillment vendor masih berjalan atau perlu follow-up.</p>
                </div>
                <div className="ui-panel-muted rounded-2xl border p-4">
                    <p className="text-xs uppercase tracking-[0.18em] ui-text-muted">Sukses</p>
                    <p className="mt-3 text-3xl font-bold ui-text">{summary.success}</p>
                    <p className="mt-2 text-xs ui-success-text">Transaksi guest yang sudah selesai terkirim.</p>
                </div>
                <div className="ui-panel-muted rounded-2xl border p-4">
                    <p className="text-xs uppercase tracking-[0.18em] ui-text-muted">Gagal / Dibatalkan</p>
                    <p className="mt-3 text-3xl font-bold ui-text">{summary.failed}</p>
                    <p className="mt-2 text-xs ui-danger-text">
                        Termasuk transaksi gagal yang kemudian ditutup sebagai cancelled.
                    </p>
                </div>
            </div>

            <div className="ui-panel-muted rounded-3xl border overflow-hidden">
                <div className="border-b ui-border px-5 py-4">
                    <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                        <div>
                            <p className="text-xs font-semibold uppercase tracking-[0.22em] ui-accent-text">Filter Operasional</p>
                            <h2 className="text-lg font-semibold ui-text">Antrean Transaksi Guest</h2>
                        </div>
                        <div className="text-right text-xs ui-text-muted">
                            Total nominal pada hasil filter: <span className="ui-text">{formatCurrency(summary.amountTotal)}</span>
                        </div>
                    </div>
                </div>

                <div className="grid gap-4 px-5 py-5 md:grid-cols-2 xl:grid-cols-3">
                    <label className="space-y-2">
                        <span className="text-xs font-semibold uppercase tracking-[0.16em] ui-text-muted">Cari</span>
                        <div className="relative">
                            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 ui-text-muted" />
                            <input
                                value={filters.search}
                                onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter') applyFilters();
                                }}
                                placeholder="Invoice, target, WhatsApp, email, ref vendor..."
                                className={`${inputClass} pl-10`}
                                aria-label="Cari transaksi guest"
                            />
                        </div>
                    </label>

                    <label className="space-y-2">
                        <span className="text-xs font-semibold uppercase tracking-[0.16em] ui-text-muted">Scope</span>
                        <select
                            value={filters.scope}
                            onChange={(event) => setFilters((current) => ({ ...current, scope: event.target.value as FilterState['scope'] }))}
                            className={selectClass}
                        >
                            <option value="actionable">Antrean Aktif</option>
                            <option value="all">Semua Histori</option>
                        </select>
                    </label>

                    <label className="space-y-2">
                        <span className="text-xs font-semibold uppercase tracking-[0.16em] ui-text-muted">Status Bayar</span>
                        <select
                            value={filters.paymentStatus}
                            onChange={(event) => setFilters((current) => ({ ...current, paymentStatus: event.target.value as FilterState['paymentStatus'] }))}
                            className={selectClass}
                        >
                            <option value="">Semua Status Bayar</option>
                            <option value="waiting_payment">Menunggu Bayar</option>
                            <option value="paid">Sudah Dibayar</option>
                            <option value="expired">Expired</option>
                            <option value="cancelled">Dibatalkan</option>
                        </select>
                    </label>

                    <label className="space-y-2">
                        <span className="text-xs font-semibold uppercase tracking-[0.16em] ui-text-muted">Status Fulfillment</span>
                        <select
                            value={filters.transactionStatus}
                            onChange={(event) => setFilters((current) => ({ ...current, transactionStatus: event.target.value as FilterState['transactionStatus'] }))}
                            className={selectClass}
                        >
                            <option value="">Semua Status Fulfillment</option>
                            <option value="pending">Pending</option>
                            <option value="processing">Processing</option>
                            <option value="success">Sukses</option>
                            <option value="failed">Gagal</option>
                        </select>
                    </label>

                    <label className="space-y-2">
                        <span className="text-xs font-semibold uppercase tracking-[0.16em] ui-text-muted">Dari Tanggal</span>
                        <input
                            type="date"
                            value={filters.startDate}
                            max={filters.endDate || undefined}
                            onChange={(event) => setFilters((current) => ({ ...current, startDate: event.target.value }))}
                            className={inputClass}
                            aria-label="Tanggal mulai transaksi guest"
                        />
                    </label>

                    <label className="space-y-2">
                        <span className="text-xs font-semibold uppercase tracking-[0.16em] ui-text-muted">Sampai Tanggal</span>
                        <input
                            type="date"
                            value={filters.endDate}
                            min={filters.startDate || undefined}
                            onChange={(event) => setFilters((current) => ({ ...current, endDate: event.target.value }))}
                            className={inputClass}
                            aria-label="Tanggal akhir transaksi guest"
                        />
                    </label>
                </div>

                {(hasInvalidRange || hasUnappliedChanges) && (
                    <div className="border-t ui-border px-5 py-3">
                        <div className="flex flex-wrap gap-2 text-xs font-semibold">
                            {hasInvalidRange && (
                                <span className="rounded-full border ui-danger-chip px-3 py-1">
                                    Tanggal mulai tidak boleh lebih besar dari tanggal akhir.
                                </span>
                            )}
                            {hasUnappliedChanges && (
                                <span className="rounded-full border ui-warning-chip px-3 py-1">
                                    Filter belum diterapkan
                                </span>
                            )}
                            <span className="rounded-full border ui-info-chip px-3 py-1">
                                Periode WIB
                            </span>
                        </div>
                    </div>
                )}

                <div className="flex flex-col gap-3 border-t ui-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="text-xs ui-text-muted">
                        {canProcess
                            ? 'Akun ini bisa konfirmasi pembayaran, batal, dan koreksi status guest transaction.'
                            : 'Akun ini hanya punya akses lihat. Aksi status guest transaction disembunyikan.'}
                    </div>
                    <div className="flex flex-col gap-2 sm:flex-row">
                        <button
                            type="button"
                            onClick={resetFilters}
                            className="inline-flex items-center justify-center gap-2 rounded-xl border ui-border ui-panel px-4 py-2 text-sm font-semibold ui-text transition hover:bg-[var(--ui-card-muted)]"
                        >
                            <RotateCcw className="w-4 h-4" />
                            Reset
                        </button>
                        <button
                            type="button"
                            onClick={applyFilters}
                            disabled={hasInvalidRange}
                            className="inline-flex items-center justify-center gap-2 rounded-xl ui-accent-solid px-4 py-2 text-sm font-semibold ui-text transition disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            <Search className="w-4 h-4" />
                            Terapkan Filter
                        </button>
                    </div>
                </div>
            </div>

            <div className="rounded-3xl border ui-border ui-panel-muted overflow-hidden">
                <div className="flex flex-col gap-3 border-b ui-border px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                        <h2 className="text-lg font-semibold ui-text">Daftar Transaksi Guest</h2>
                        <p className="text-xs ui-text-muted">Gunakan detail dan audit untuk memastikan pembayaran masuk tidak salah proses.</p>
                    </div>
                    <div className="flex items-center gap-3 text-xs ui-text-muted">
                        <span>{rangeLabel}</span>
                        <span className="rounded-full border ui-info-chip px-3 py-1 text-xs font-semibold">Periode WIB</span>
                        <select
                            value={meta.limit}
                            onChange={(event) => setMeta((current) => ({
                                ...current,
                                page: 1,
                                limit: Number(event.target.value)
                            }))}
                            className="rounded-lg border ui-border ui-panel px-3 py-2 text-xs ui-text focus:outline-none focus:border-[var(--ui-accent)]"
                        >
                            <option value={20}>20 / halaman</option>
                            <option value={50}>50 / halaman</option>
                            <option value={100}>100 / halaman</option>
                        </select>
                    </div>
                </div>

                {loading ? (
                    <div className="flex items-center justify-center px-6 py-14">
                        <Loader2 className="h-8 w-8 animate-spin ui-accent-text" />
                    </div>
                ) : transactions.length === 0 ? (
                    <div className="px-6 py-14 text-center">
                        <p className="text-lg font-semibold ui-text">Tidak ada transaksi guest</p>
                        <p className="mt-2 text-sm ui-text-muted">Ubah filter atau scope jika Anda ingin melihat histori lain.</p>
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="min-w-full divide-y divide-[var(--ui-border)]">
                            <thead className="ui-panel">
                                <tr>
                                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.16em] ui-text-muted">Invoice</th>
                                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.16em] ui-text-muted">Produk & Target</th>
                                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.16em] ui-text-muted">Pembayaran</th>
                                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.16em] ui-text-muted">Fulfillment</th>
                                    <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.16em] ui-text-muted">Audit</th>
                                    <th className="px-4 py-3 text-center text-xs font-semibold uppercase tracking-[0.16em] ui-text-muted">Aksi</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-[color-mix(in_srgb,var(--ui-border)_65%,transparent)]">
                                {transactions.map((transaction) => (
                                    <tr key={transaction._id} className="hover:bg-[var(--ui-card-bg)]">
                                        <td className="px-4 py-4 align-top">
                                            <button
                                                type="button"
                                                onClick={() => copyToClipboard(transaction.invoiceNumber, transaction._id)}
                                                className="group inline-flex items-center gap-2 text-left"
                                                aria-label={`Salin invoice ${transaction.invoiceNumber}`}
                                            >
                                                <span className="font-mono text-sm font-semibold ui-accent-text group-hover:text-[var(--ui-accent-strong)]">
                                                    {transaction.invoiceNumber}
                                                </span>
                                                <Copy className="w-3.5 h-3.5 ui-text-muted" />
                                            </button>
                                            <div className="mt-2 text-xs ui-text-muted">
                                                {copied === transaction._id ? 'Invoice disalin' : formatDateTime(transaction.createdAt)}
                                            </div>
                                            {transaction.vendorTrxId && (
                                                <div className="mt-2 text-xs ui-text-muted">
                                                    Ref vendor: <span className="font-mono ui-text">{transaction.vendorTrxId}</span>
                                                </div>
                                            )}
                                        </td>
                                        <td className="px-4 py-4 align-top">
                                            <div className="space-y-2">
                                                <div>
                                                    <div className="font-semibold ui-text">{transaction.product?.name || '-'}</div>
                                                    <div className="text-xs ui-text-muted">
                                                        {transaction.product?.code || '-'}
                                                        {transaction.product?.brand ? ` • ${transaction.product.brand}` : ''}
                                                    </div>
                                                </div>
                                                <div className="text-sm ui-text">{transaction.target}</div>
                                                <div className="text-xs ui-text-muted">
                                                    WA {transaction.whatsapp}
                                                    {transaction.email ? ` • ${transaction.email}` : ''}
                                                </div>
                                                {transaction.user?.email && (
                                                    <div className="text-xs ui-info-text">
                                                        Member terkait: {transaction.user.name || transaction.user.email}
                                                    </div>
                                                )}
                                            </div>
                                        </td>
                                        <td className="px-4 py-4 align-top">
                                            <div className="space-y-2">
                                                <div className="font-semibold ui-text">{formatCurrency(transaction.totalAmount)}</div>
                                                <div className="text-xs ui-text-muted">
                                                    Harga {formatCurrency(transaction.amount)} • Fee {formatCurrency(transaction.adminFee)} • Kode {transaction.uniqueCode}
                                                </div>
                                                <div className="flex flex-wrap gap-2">
                                                    {getPaymentStatusBadge(transaction.paymentStatus)}
                                                    {transaction.paidAt && (
                                                        <span className="rounded-full border px-2 py-1 text-xs font-semibold ui-success-chip">
                                                            {formatDateTime(transaction.paidAt)}
                                                        </span>
                                                    )}
                                                </div>
                                                <div className="text-xs ui-text-muted">
                                                    {transaction.paymentMethod?.name || 'Metode tidak tersedia'}
                                                    {transaction.paymentMethod?.categoryName ? ` • ${transaction.paymentMethod.categoryName}` : ''}
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-4 py-4 align-top">
                                            <div className="space-y-2">
                                                <div className="flex flex-wrap gap-2">
                                                    {getTransactionStatusBadge(transaction.transactionStatus)}
                                                    {transaction.sn && (
                                                        <span className="rounded-full border px-2 py-1 text-xs font-semibold ui-success-chip">
                                                            SN tersedia
                                                        </span>
                                                    )}
                                                </div>
                                                <div className="text-xs ui-text-muted">
                                                    Vendor: {transaction.product?.vendorName || '-'}
                                                </div>
                                                <div className="text-xs ui-text-muted">
                                                    Expired: {formatDateTime(transaction.expiredAt)}
                                                </div>
                                                {transaction.paymentStatus === 'paid' && transaction.transactionStatus === 'failed' && (
                                                    <div className="rounded-xl border px-3 py-2 text-xs ui-danger-chip">
                                                        Pembayaran sudah masuk tetapi fulfillment gagal. Pastikan ada tindak lanjut sebelum close.
                                                    </div>
                                                )}
                                            </div>
                                        </td>
                                        <td className="px-4 py-4 align-top">
                                            <div className="space-y-2 text-xs ui-text-muted">
                                                <div>Diperbarui: <span className="ui-text">{formatDateTime(transaction.statusUpdatedAt || transaction.updatedAt)}</span></div>
                                                <div>Operator: <span className="ui-text">{transaction.statusUpdatedBy?.name || '-'}</span></div>
                                                <div className="max-w-xs ui-text-muted">
                                                    {transaction.statusUpdateNote || 'Belum ada catatan manual'}
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-4 py-4 align-top">
                                            <div className="flex flex-wrap items-center justify-center gap-2">
                                                <button
                                                    type="button"
                                                    onClick={() => setSelectedTransaction(transaction)}
                                                    className="inline-flex items-center gap-2 rounded-lg border ui-border ui-panel px-3 py-2 text-xs font-semibold ui-text transition hover:bg-[var(--ui-card-muted)]"
                                                    aria-label={`Lihat detail transaksi guest ${transaction.invoiceNumber}`}
                                                >
                                                    <Eye className="w-3.5 h-3.5" />
                                                    Detail
                                                </button>
                                                {canProcess && canConfirmTransaction(transaction) && (
                                                    <button
                                                        type="button"
                                                        onClick={() => openActionModal('confirm', transaction)}
                                                        className="ui-success-action inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold transition"
                                                        aria-label={`Konfirmasi pembayaran ${transaction.invoiceNumber}`}
                                                    >
                                                        <CheckCircle className="w-3.5 h-3.5" />
                                                        Konfirmasi
                                                    </button>
                                                )}
                                                {canProcess && canCancelTransaction(transaction) && (
                                                    <button
                                                        type="button"
                                                        onClick={() => openActionModal('cancel', transaction)}
                                                        className="ui-danger-action inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold transition"
                                                        aria-label={`Batalkan transaksi guest ${transaction.invoiceNumber}`}
                                                    >
                                                        <XCircle className="w-3.5 h-3.5" />
                                                        Batalkan
                                                    </button>
                                                )}
                                                {canProcess && canEditTransaction(transaction) && (
                                                    <button
                                                        type="button"
                                                        onClick={() => openActionModal('edit', transaction)}
                                                        className="ui-info-action inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold transition"
                                                        aria-label={`Edit status transaksi guest ${transaction.invoiceNumber}`}
                                                    >
                                                        <Edit className="w-3.5 h-3.5" />
                                                        Edit
                                                    </button>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}

                <div className="flex flex-col gap-3 border-t ui-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="text-xs ui-text-muted">{rangeLabel}</div>
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            disabled={meta.page <= 1 || loading}
                            onClick={() => setMeta((current) => ({ ...current, page: Math.max(1, current.page - 1) }))}
                            className="rounded-lg border ui-border ui-panel px-3 py-2 text-xs font-semibold ui-text transition hover:bg-[var(--ui-card-muted)] disabled:cursor-not-allowed disabled:opacity-40"
                        >
                            Sebelumnya
                        </button>
                        <div className="rounded-lg border ui-border ui-panel px-3 py-2 text-xs ui-text">
                            Halaman {meta.page} / {Math.max(meta.totalPages, 1)}
                        </div>
                        <button
                            type="button"
                            disabled={meta.page >= meta.totalPages || loading}
                            onClick={() => setMeta((current) => ({ ...current, page: Math.min(current.totalPages, current.page + 1) }))}
                            className="rounded-lg border ui-border ui-panel px-3 py-2 text-xs font-semibold ui-text transition hover:bg-[var(--ui-card-muted)] disabled:cursor-not-allowed disabled:opacity-40"
                        >
                            Berikutnya
                        </button>
                    </div>
                </div>
            </div>

            {selectedTransaction && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
                    <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-3xl border ui-border ui-panel-muted shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="guest-transaction-detail-title">
                        <div className="sticky top-0 flex items-center justify-between border-b ui-border ui-panel-muted px-5 py-4 backdrop-blur">
                            <div>
                                <p className="text-xs uppercase tracking-[0.18em] ui-accent-text">Detail Transaksi Guest</p>
                                <h2 id="guest-transaction-detail-title" className="text-lg font-semibold ui-text">{selectedTransaction.invoiceNumber}</h2>
                            </div>
                            <button
                                type="button"
                                onClick={() => setSelectedTransaction(null)}
                                className="rounded-xl border ui-border ui-panel p-2 ui-text transition hover:bg-[var(--ui-card-muted)]"
                                aria-label="Tutup detail transaksi guest"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        <div className="space-y-5 p-5">
                            <div className="grid gap-4 md:grid-cols-[220px_minmax(0,1fr)]">
                                <div className="rounded-2xl border ui-border ui-panel p-5 flex flex-col items-center justify-center gap-3 text-center">
                                    {getTransactionIcon(selectedTransaction.transactionStatus)}
                                    <div className="space-y-2">
                                        {getPaymentStatusBadge(selectedTransaction.paymentStatus, 'md')}
                                        {getTransactionStatusBadge(selectedTransaction.transactionStatus, 'md')}
                                    </div>
                                </div>
                                <div className="rounded-2xl border ui-border ui-panel p-5 space-y-4">
                                    <div className="grid gap-4 sm:grid-cols-2">
                                        <div>
                                            <p className="text-xs uppercase tracking-[0.16em] ui-text-muted">Produk</p>
                                            <p className="mt-2 font-semibold ui-text">{selectedTransaction.product?.name || '-'}</p>
                                            <p className="text-sm ui-text-muted">{selectedTransaction.product?.code || '-'}</p>
                                        </div>
                                        <div>
                                            <p className="text-xs uppercase tracking-[0.16em] ui-text-muted">Target</p>
                                            <p className="mt-2 font-semibold ui-text">{selectedTransaction.target}</p>
                                            <p className="text-sm ui-text-muted">{selectedTransaction.whatsapp}</p>
                                        </div>
                                    </div>
                                    <div className="grid gap-4 sm:grid-cols-2">
                                        <div>
                                            <p className="text-xs uppercase tracking-[0.16em] ui-text-muted">Metode Pembayaran</p>
                                            <p className="mt-2 font-semibold ui-text">{selectedTransaction.paymentMethod?.name || '-'}</p>
                                            <p className="text-sm ui-text-muted">
                                                {selectedTransaction.paymentMethod?.accountName || '-'}
                                                {selectedTransaction.paymentMethod?.accountNumber ? ` • ${selectedTransaction.paymentMethod.accountNumber}` : ''}
                                            </p>
                                        </div>
                                        <div>
                                            <p className="text-xs uppercase tracking-[0.16em] ui-text-muted">Nominal</p>
                                            <p className="mt-2 font-semibold ui-text">{formatCurrency(selectedTransaction.totalAmount)}</p>
                                            <p className="text-sm ui-text-muted">
                                                Harga {formatCurrency(selectedTransaction.amount)} • Fee {formatCurrency(selectedTransaction.adminFee)} • Kode {selectedTransaction.uniqueCode}
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div className="grid gap-4 lg:grid-cols-2">
                                <div className="rounded-2xl border ui-border ui-panel p-5 space-y-3">
                                    <p className="text-xs font-semibold uppercase tracking-[0.18em] ui-text-muted">Kontak & Referensi</p>
                                    <div className="space-y-2 text-sm">
                                        <div className="flex items-start justify-between gap-4">
                                            <span className="ui-text-muted">Invoice</span>
                                            <span className="font-mono ui-accent-text">{selectedTransaction.invoiceNumber}</span>
                                        </div>
                                        <div className="flex items-start justify-between gap-4">
                                            <span className="ui-text-muted">Email</span>
                                            <span className="text-right ui-text">{selectedTransaction.email || '-'}</span>
                                        </div>
                                        <div className="flex items-start justify-between gap-4">
                                            <span className="ui-text-muted">Member terkait</span>
                                            <span className="text-right ui-text">
                                                {selectedTransaction.user?.name || selectedTransaction.user?.email || '-'}
                                            </span>
                                        </div>
                                        <div className="flex items-start justify-between gap-4">
                                            <span className="ui-text-muted">Ref Vendor</span>
                                            <span className="text-right font-mono ui-text">{selectedTransaction.vendorTrxId || '-'}</span>
                                        </div>
                                        <div className="flex items-start justify-between gap-4">
                                            <span className="ui-text-muted">SN / Token</span>
                                            <span className="text-right font-mono ui-success-text">{selectedTransaction.sn || '-'}</span>
                                        </div>
                                    </div>
                                </div>

                                <div className="rounded-2xl border ui-border ui-panel p-5 space-y-3">
                                    <p className="text-xs font-semibold uppercase tracking-[0.18em] ui-text-muted">Audit Operator</p>
                                    <div className="space-y-2 text-sm">
                                        <div className="flex items-start justify-between gap-4">
                                            <span className="ui-text-muted">Dibuat</span>
                                            <span className="text-right ui-text">{formatDateTime(selectedTransaction.createdAt)}</span>
                                        </div>
                                        <div className="flex items-start justify-between gap-4">
                                            <span className="ui-text-muted">Dibayar</span>
                                            <span className="text-right ui-text">{formatDateTime(selectedTransaction.paidAt)}</span>
                                        </div>
                                        <div className="flex items-start justify-between gap-4">
                                            <span className="ui-text-muted">Expired</span>
                                            <span className="text-right ui-text">{formatDateTime(selectedTransaction.expiredAt)}</span>
                                        </div>
                                        <div className="flex items-start justify-between gap-4">
                                            <span className="ui-text-muted">Operator terakhir</span>
                                            <span className="text-right ui-text">
                                                {selectedTransaction.statusUpdatedBy?.name || '-'}
                                            </span>
                                        </div>
                                        <div className="flex items-start justify-between gap-4">
                                            <span className="ui-text-muted">Update terakhir</span>
                                            <span className="text-right ui-text">{formatDateTime(selectedTransaction.statusUpdatedAt || selectedTransaction.updatedAt)}</span>
                                        </div>
                                        <div className="rounded-2xl border ui-border ui-panel p-3 text-sm ui-text-muted">
                                            {selectedTransaction.statusUpdateNote || 'Belum ada catatan manual.'}
                                        </div>
                                    </div>
                                </div>
                            </div>

                            {canProcess && (
                                <div className="flex flex-col gap-3 sm:flex-row">
                                    {canCancelTransaction(selectedTransaction) && (
                                        <button
                                            type="button"
                                            onClick={() => openActionModal('cancel', selectedTransaction)}
                                            className="ui-danger-action inline-flex flex-1 items-center justify-center gap-2 rounded-2xl px-4 py-3 text-sm font-semibold transition"
                                        >
                                            <XCircle className="w-4 h-4" />
                                            Batalkan Transaksi
                                        </button>
                                    )}
                                    {canConfirmTransaction(selectedTransaction) && (
                                        <button
                                            type="button"
                                            onClick={() => openActionModal('confirm', selectedTransaction)}
                                            className="ui-success-action inline-flex flex-1 items-center justify-center gap-2 rounded-2xl px-4 py-3 text-sm font-semibold transition"
                                        >
                                            <CheckCircle className="w-4 h-4" />
                                            Konfirmasi Pembayaran
                                        </button>
                                    )}
                                    {canEditTransaction(selectedTransaction) && (
                                        <button
                                            type="button"
                                            onClick={() => openActionModal('edit', selectedTransaction)}
                                            className="ui-info-action inline-flex flex-1 items-center justify-center gap-2 rounded-2xl px-4 py-3 text-sm font-semibold transition"
                                        >
                                            <Edit className="w-4 h-4" />
                                            Koreksi Status
                                        </button>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {actionMode && actionTransaction && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
                    <div className="w-full max-w-xl rounded-3xl border ui-border ui-panel-muted shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="guest-transaction-action-title">
                        <div className="flex items-center justify-between border-b ui-border px-5 py-4">
                            <div>
                                <p className="text-xs uppercase tracking-[0.18em] ui-accent-text">
                                    {actionMode === 'confirm' ? 'Konfirmasi Pembayaran' : actionMode === 'cancel' ? 'Batalkan Transaksi Guest' : 'Edit Status Fulfillment'}
                                </p>
                                <h3 id="guest-transaction-action-title" className="text-lg font-semibold ui-text">{actionTransaction.invoiceNumber}</h3>
                            </div>
                            <button
                                type="button"
                                onClick={closeActionModal}
                                className="rounded-xl border ui-border ui-panel p-2 ui-text transition hover:bg-[var(--ui-card-muted)]"
                                aria-label="Tutup modal aksi transaksi guest"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        <div className="space-y-4 px-5 py-5">
                            <div className="rounded-2xl border ui-border ui-panel p-4 text-sm">
                                <div className="flex flex-wrap items-center gap-2">
                                    {getPaymentStatusBadge(actionTransaction.paymentStatus)}
                                    {getTransactionStatusBadge(actionTransaction.transactionStatus)}
                                </div>
                                <div className="mt-3 ui-text">{actionTransaction.product?.name || '-'}</div>
                                <div className="text-xs ui-text-muted">
                                    {actionTransaction.target} • {formatCurrency(actionTransaction.totalAmount)}
                                </div>
                            </div>

                            {actionMode === 'edit' && (
                                <>
                                    <label className="space-y-2">
                                        <span className="text-xs font-semibold uppercase tracking-[0.16em] ui-text-muted">Status Fulfillment Baru</span>
                                        <select
                                            value={actionForm.transactionStatus}
                                            onChange={(event) => setActionForm((current) => ({
                                                ...current,
                                                transactionStatus: event.target.value as TransactionStatus
                                            }))}
                                            className={selectClass}
                                        >
                                            {getAllowedEditStatuses(actionTransaction).map((status) => (
                                                <option key={status} value={status}>
                                                    {status === 'processing'
                                                        ? 'Processing'
                                                        : status === 'success'
                                                            ? 'Success'
                                                            : status === 'failed'
                                                                ? 'Failed'
                                                                : 'Pending'}
                                                </option>
                                            ))}
                                        </select>
                                    </label>

                                    <div className="grid gap-4 sm:grid-cols-2">
                                        <label className="space-y-2">
                                            <span className="text-xs font-semibold uppercase tracking-[0.16em] ui-text-muted">Vendor Trx ID</span>
                                            <input
                                                value={actionForm.vendorTrxId}
                                                onChange={(event) => setActionForm((current) => ({ ...current, vendorTrxId: event.target.value }))}
                                                className={inputClass}
                                                placeholder="Opsional"
                                            />
                                        </label>
                                        <label className="space-y-2">
                                            <span className="text-xs font-semibold uppercase tracking-[0.16em] ui-text-muted">SN / Token</span>
                                            <input
                                                value={actionForm.sn}
                                                onChange={(event) => setActionForm((current) => ({ ...current, sn: event.target.value }))}
                                                className={inputClass}
                                                placeholder="Opsional"
                                            />
                                        </label>
                                    </div>
                                            {stepUp.dialog}
</>
                            )}

                            <label className="space-y-2">
                                <span className="text-xs font-semibold uppercase tracking-[0.16em] ui-text-muted">Catatan Operator</span>
                                <textarea
                                    rows={4}
                                    value={actionForm.note}
                                    onChange={(event) => setActionForm((current) => ({ ...current, note: event.target.value }))}
                                    className={`${inputClass} min-h-[120px] resize-none`}
                                    placeholder={
                                        actionMode === 'confirm'
                                            ? 'Contoh: transfer sudah cocok dengan mutasi bank.'
                                            : actionMode === 'cancel'
                                                ? 'Contoh: pembayaran tidak ditemukan sampai batas waktu.'
                                                : 'Contoh: vendor sudah kirim SN manual.'
                                    }
                                />
                            </label>

                            {actionMode === 'confirm' && (
                                <div className="rounded-2xl border px-4 py-3 text-sm ui-success-chip">
                                    Konfirmasi pembayaran akan langsung meng-claim transaksi ini dan mengirim order ke vendor satu kali. Gunakan hanya setelah bukti transfer benar.
                                </div>
                            )}

                            {actionMode === 'cancel' && (
                                <div className="rounded-2xl border px-4 py-3 text-sm ui-danger-chip">
                                    Pembatalan hanya aman untuk invoice yang belum dibayar atau pembayaran yang sudah dinyatakan gagal. Transaksi yang sedang processing vendor tidak bisa ditutup dari sini.
                                </div>
                            )}

                            {actionMode === 'edit' && (
                                <div className="rounded-2xl border px-4 py-3 text-sm ui-info-chip">
                                    Koreksi status fulfillment hanya mengubah state internal guest transaction. Pastikan catatan operator cukup jelas untuk audit berikutnya.
                                </div>
                            )}
                        </div>

                        <div className="flex flex-col gap-3 border-t ui-border px-5 py-4 sm:flex-row sm:justify-end">
                            <button
                                type="button"
                                onClick={closeActionModal}
                                className="inline-flex items-center justify-center rounded-xl border ui-border ui-panel px-4 py-2.5 text-sm font-semibold ui-text transition hover:bg-[var(--ui-card-muted)]"
                            >
                                Tutup
                            </button>
                            <button
                                type="button"
                                disabled={saving}
                                onClick={submitAction}
                                className="inline-flex items-center justify-center gap-2 rounded-xl ui-accent-solid px-4 py-2.5 text-sm font-semibold ui-text transition  disabled:cursor-not-allowed disabled:opacity-60"
                            >
                                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : actionMode === 'confirm' ? <CheckCircle className="w-4 h-4" /> : actionMode === 'cancel' ? <XCircle className="w-4 h-4" /> : <Edit className="w-4 h-4" />}
                                {actionMode === 'confirm' ? 'Konfirmasi Sekarang' : actionMode === 'cancel' ? 'Batalkan Transaksi' : 'Simpan Perubahan'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
            {stepUp.dialog}
        </>
    );
}
