import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiV2 } from '../../api';
import { useStepUpOrchestration } from '../../auth/useStepUpOrchestration';
import { stepUpActionErrorMessage } from '../../auth/withStepUp';
import {
    isDeferredValidation,
    transactionBalanceCopy,
    type TransactionPresentationInput,
} from '../../lib/transactionPresentation';
import {
    AlertTriangle,
    CheckCircle,
    Clock,
    Copy,
    Edit,
    Eye,
    Filter,
    Loader2,
    RefreshCw,
    RotateCcw,
    Search,

    X,
    XCircle
} from 'lucide-react';

type TransactionStatus = 'pending' | 'processing' | 'success' | 'failed';
type TransactionSource = 'web' | 'api';

function toPresentationInput(transaction: Pick<
    ManualTransaction,
    'status' | 'refunded' | 'message' | 'statusUpdateNote'
> & { product?: { vendorName?: string } }): TransactionPresentationInput {
    return {
        status: transaction.status,
        refunded: transaction.refunded,
        vendorName: transaction.product?.vendorName,
        message: transaction.message,
        statusUpdateNote: transaction.statusUpdateNote,
    };
}

interface ManualTransaction {
    _id: string;
    target: string;
    amount: number;
    status: TransactionStatus;
    vendorTrxId?: string;
    customerRefId?: string;
    sn?: string;
    message?: string;
    refunded: boolean;
    source: TransactionSource;
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
    statusUpdatedBy?: {
        _id?: string;
        name?: string;
        email?: string;
        role?: string;
    };
}

interface ManualTransactionsResponse {
    items: ManualTransaction[];
    meta: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
    };
    summary: {
        total: number;
        pending: number;
        processing: number;
        success: number;
        failed: number;
        amountTotal: number;
    };
}

type FilterState = {
    search: string;
    status: 'actionable' | 'all' | TransactionStatus;
    source: '' | TransactionSource;
    startDate: string;
    endDate: string;
};

const defaultFilters: FilterState = {
    search: '',
    status: 'actionable',
    source: '',
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

const getSourceLabel = (source: TransactionSource) => (
    source === 'api' ? 'API' : 'Web'
);

const getStatusBadge = (status: TransactionStatus, size: 'sm' | 'md' = 'sm') => {
    const baseClass = size === 'md'
        ? 'px-3 py-1.5 text-sm font-semibold rounded-full'
        : 'px-2 py-1 text-xs font-semibold rounded-full';

    switch (status) {
        case 'success':
            return <span className={`${baseClass} border ui-success-chip`}>Sukses</span>;
        case 'pending':
            return <span className={`${baseClass} border ui-warning-chip`}>Menunggu</span>;
        case 'processing':
            return <span className={`${baseClass} border ui-info-chip`}>Proses</span>;
        case 'failed':
            return <span className={`${baseClass} border ui-danger-chip`}>Gagal</span>;
        default:
            return <span className={`${baseClass} ui-panel-muted ui-text-muted`}>{status}</span>;
    }
};

const getStatusIcon = (status: TransactionStatus) => {
    switch (status) {
        case 'success':
            return <CheckCircle className="w-12 h-12 ui-success-text" />;
        case 'pending':
            return <Clock className="w-12 h-12 ui-warning-text" />;
        case 'processing':
            return <RefreshCw className="w-12 h-12 ui-info-text animate-spin" />;
        case 'failed':
            return <XCircle className="w-12 h-12 ui-danger-text" />;
        default:
            return <Clock className="w-12 h-12 ui-text-muted" />;
    }
};

export default function AdminManualTransactions() {
    const stepUp = useStepUpOrchestration();
    const [transactions, setTransactions] = useState<ManualTransaction[]>([]);
    const [summary, setSummary] = useState<ManualTransactionsResponse['summary']>({
        total: 0,
        pending: 0,
        processing: 0,
        success: 0,
        failed: 0,
        amountTotal: 0
    });
    const [meta, setMeta] = useState<ManualTransactionsResponse['meta']>({
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 1
    });
    const [filters, setFilters] = useState<FilterState>(defaultFilters);
    const [appliedFilters, setAppliedFilters] = useState<FilterState>(defaultFilters);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [selectedTrx, setSelectedTrx] = useState<ManualTransaction | null>(null);
    const [editingTrx, setEditingTrx] = useState<ManualTransaction | null>(null);
    const [copied, setCopied] = useState<string | null>(null);
    const [errorMessage, setErrorMessage] = useState('');
    const [successMessage, setSuccessMessage] = useState('');
    const latestRequestId = useRef(0);
    const [editForm, setEditForm] = useState({
        status: 'pending' as TransactionStatus,
        vendorTrxId: '',
        sn: '',
        note: ''
    });

    const hasInvalidRange = Boolean(filters.startDate && filters.endDate && filters.startDate > filters.endDate);
    const hasUnappliedChanges = useMemo(() => (
        filters.search !== appliedFilters.search
        || filters.status !== appliedFilters.status
        || filters.source !== appliedFilters.source
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
                limit: meta.limit
            };

            if (appliedFilters.search) params.search = appliedFilters.search;
            if (appliedFilters.source) params.source = appliedFilters.source;
            if (appliedFilters.startDate) params.startDate = appliedFilters.startDate;
            if (appliedFilters.endDate) params.endDate = appliedFilters.endDate;

            if (appliedFilters.status === 'all') {
                params.scope = 'all';
            } else if (appliedFilters.status !== 'actionable') {
                params.status = appliedFilters.status;
            }

            const response = await apiV2.get<ManualTransactionsResponse>('/transactions/manual', { params });
            if (requestId !== latestRequestId.current) return;
            setTransactions(response.data.items || []);
            setSummary(response.data.summary);
            setMeta(response.data.meta);
        } catch (error: any) {
            if (requestId !== latestRequestId.current) return;
            setErrorMessage(error.response?.data?.message || 'Gagal memuat antrean transaksi manual');
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
        const handleRefresh = () => {
            fetchTransactions();
        };
        window.addEventListener('admin:refresh-current-page', handleRefresh);
        return () => window.removeEventListener('admin:refresh-current-page', handleRefresh);
    }, [fetchTransactions]);

    const inputClass = 'w-full rounded-lg ui-panel border ui-border px-3 py-2 text-sm ui-text placeholder-[var(--ui-text-muted)] focus:outline-none focus:border-[var(--ui-accent)]';
    const selectClass = 'w-full rounded-lg ui-panel border ui-border px-3 py-2 text-sm ui-text focus:outline-none focus:border-[var(--ui-accent)]';

    const rangeLabel = useMemo(() => {
        if (meta.total === 0) {
            return '0 data';
        }

        const start = (meta.page - 1) * meta.limit + 1;
        const end = Math.min(meta.page * meta.limit, meta.total);
        return `${start}-${end} dari ${meta.total} transaksi`;
    }, [meta]);

    const scopeLabel = useMemo(() => {
        if (appliedFilters.status === 'actionable') return 'Menampilkan antrean pending, processing, dan failed';
        if (appliedFilters.status === 'all') return 'Menampilkan semua status transaksi';
        return `Status aktif: ${appliedFilters.status.toUpperCase()}`;
    }, [appliedFilters.status]);

    const resetFilters = () => {
        setFilters(defaultFilters);
        setAppliedFilters(defaultFilters);
        setMeta((current) => ({
            ...current,
            page: 1
        }));
        setSuccessMessage('');
    };

    const applyFilters = () => {
        setErrorMessage('');
        if (hasInvalidRange) {
            setErrorMessage('Tanggal mulai tidak boleh lebih besar dari tanggal akhir.');
            return;
        }
        setAppliedFilters({ ...filters });
        setMeta((current) => ({
            ...current,
            page: 1
        }));
        setSuccessMessage('');
    };

    const copyToClipboard = async (text: string, field: string) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(field);
            window.setTimeout(() => setCopied(null), 1800);
        } catch {
            setErrorMessage('Gagal menyalin data');
        }
    };

    const openEditModal = (transaction: ManualTransaction) => {
        setEditingTrx(transaction);
        setEditForm({
            status: transaction.status,
            vendorTrxId: transaction.vendorTrxId || '',
            sn: transaction.sn || '',
            note: transaction.statusUpdateNote || ''
        });
    };

    const closeEditModal = () => {
        setEditingTrx(null);
        setEditForm({
            status: 'pending',
            vendorTrxId: '',
            sn: '',
            note: ''
        });
    };

    const handleSaveStatus = async () => {
        if (!editingTrx) return;

        setSaving(true);
        setErrorMessage('');
        setSuccessMessage('');

        try {
            await stepUp.run('transactions.manual', (config) =>
                apiV2.put(`/transactions/${editingTrx._id}/status`, {
                    status: editForm.status,
                    vendorTrxId: editForm.vendorTrxId,
                    sn: editForm.sn,
                    note: editForm.note
                }, config as never),
            );

            setSuccessMessage('Status transaksi manual berhasil diperbarui');
            refreshSidebarBadges();
            closeEditModal();
            setSelectedTrx(null);
            await fetchTransactions();
        } catch (error: any) {
            const text = stepUpActionErrorMessage(error, 'Gagal memperbarui status transaksi');
            if (text) setErrorMessage(text);
        } finally {
            setSaving(false);
        }
    };

    const summaryCards = [
        {
            label: 'Antrean Aktif',
            value: summary.pending + summary.processing + summary.failed,
            helper: 'Menunggu + proses + gagal',
            accent: 'ui-text',
            border: 'ui-border'
        },
        {
            label: 'Pending',
            value: summary.pending,
            helper: 'Belum diproses vendor',
            accent: 'ui-warning-text',
            border: 'ui-border'
        },
        {
            label: 'Proses',
            value: summary.processing,
            helper: 'Menunggu hasil vendor',
            accent: 'ui-info-text',
            border: 'ui-border'
        },
        {
            label: 'Failed',
            value: summary.failed,
            helper: 'Perlu keputusan manual',
            accent: 'ui-danger-text',
            border: 'ui-border'
        },
        {
            label: 'Nominal',
            value: formatCurrency(summary.amountTotal),
            helper: 'Total nominal pada filter aktif',
            accent: 'ui-accent-text',
            border: 'border-[color-mix(in_srgb,var(--ui-accent)_34%,transparent)]'
        }
    ];

    const priorityTransactions = transactions.filter((trx) => trx.status === 'failed' || trx.status === 'pending').slice(0, 3);

    const editNeedsRefund = editingTrx && editForm.status === 'failed' && !editingTrx.refunded;
    const editNeedsRecharge = editingTrx && editForm.status !== 'failed' && editingTrx.refunded;
    const editWillRevokePoints = editingTrx && editingTrx.status === 'success' && editForm.status !== 'success';

    return (<>

        <div className="space-y-6">
            <div className="ui-panel rounded-2xl border ui-border p-4 sm:p-5">
                <div className="relative">
                    <div className="rounded-3xl border ui-border bg-[var(--ui-card-bg)]/75 p-5 backdrop-blur">
                        <div className="flex items-center justify-between gap-3">
                            <div>
                                <p className="text-xs uppercase tracking-[0.18em] ui-text-muted">Sinyal Antrean</p>
                                <h2 className="mt-1 text-lg font-bold ui-text">{scopeLabel}</h2>
                            </div>
                            <button
                                onClick={() => fetchTransactions()}
                                className="ui-accent-chip inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold transition-colors"
                            >
                                <RefreshCw className="h-4 w-4" />
                                Segarkan
                            </button>
                        </div>
                        <div className="mt-5 space-y-3">
                            {(priorityTransactions.length > 0 ? priorityTransactions : transactions.slice(0, 3)).map((trx) => (
                                <button
                                    key={trx._id}
                                    type="button"
                                    onClick={() => setSelectedTrx(trx)}
                                    className="w-full rounded-2xl border ui-border bg-[var(--ui-card-muted)]/80 p-3 text-left transition hover:border-[var(--ui-accent)]"
                                >
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <p className="truncate text-sm font-semibold ui-text">{trx.product?.name || '-'}</p>
                                            <p className="mt-1 truncate text-xs ui-text-muted">{trx.target} • {formatCurrency(trx.amount)}</p>
                                        </div>
                                        {getStatusBadge(trx.status)}
                                    </div>
                                </button>
                            ))}
                            {!loading && transactions.length === 0 && (
                                <div className="rounded-2xl border ui-border bg-[var(--ui-card-muted)]/80 p-4 text-sm ui-text-muted">
                                    Tidak ada prioritas pada filter aktif.
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {(errorMessage || successMessage) && (
                <div className={`rounded-xl border px-4 py-3 text-sm ${
                    errorMessage
                        ? 'ui-danger-chip'
                        : 'ui-success-chip'
                }`}>
                    {errorMessage || successMessage}
                </div>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-5">
                {summaryCards.map((card) => (
                    <div
                        key={card.label}
                        className={`ui-panel-muted rounded-2xl border ${card.border} p-4 shadow-[0_12px_40px_rgba(0,0,0,0.12)]`}
                    >
                        <p className="text-xs uppercase tracking-[0.18em] ui-text-muted">{card.label}</p>
                        <p className={`mt-3 text-2xl font-black ${card.accent}`}>{card.value}</p>
                        <p className="mt-2 text-xs ui-text-muted">{card.helper}</p>
                    </div>
                ))}
            </div>

            <div className="ui-panel-muted overflow-hidden rounded-3xl border">
                <div className="border-b ui-border px-5 py-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] ui-accent-text">Filter & Triage</p>
                    <h2 className="mt-1 text-lg font-bold ui-text">Bangun antrean kerja operator</h2>
                </div>
                <div className="space-y-4 p-5">
                {hasInvalidRange && (
                    <div className="rounded-xl border ui-danger-chip px-4 py-3 text-sm">
                        Tanggal mulai tidak boleh lebih besar dari tanggal akhir.
                    </div>
                )}
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
                    <input
                        placeholder="Cari ID, user, produk, target, ref vendor"
                        value={filters.search}
                        onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') applyFilters();
                        }}
                        className={inputClass}
                        aria-label="Cari transaksi manual"
                    />
                    <select
                        value={filters.status}
                        onChange={(event) => setFilters((current) => ({
                            ...current,
                            status: event.target.value as FilterState['status']
                        }))}
                        className={selectClass}
                    >
                        <option value="actionable">Antrean aktif</option>
                        <option value="pending">Pending</option>
                        <option value="processing">Processing</option>
                        <option value="failed">Failed</option>
                        <option value="success">Success</option>
                        <option value="all">Semua status</option>
                    </select>
                    <select
                        value={filters.source}
                        onChange={(event) => setFilters((current) => ({
                            ...current,
                            source: event.target.value as FilterState['source']
                        }))}
                        className={selectClass}
                    >
                        <option value="">Semua sumber</option>
                        <option value="web">Web</option>
                        <option value="api">API</option>
                    </select>
                    <input
                        type="date"
                        value={filters.startDate}
                        max={filters.endDate || undefined}
                        onChange={(event) => setFilters((current) => ({ ...current, startDate: event.target.value }))}
                        className={inputClass}
                        aria-label="Tanggal mulai transaksi manual"
                    />
                    <input
                        type="date"
                        value={filters.endDate}
                        min={filters.startDate || undefined}
                        onChange={(event) => setFilters((current) => ({ ...current, endDate: event.target.value }))}
                        className={inputClass}
                        aria-label="Tanggal akhir transaksi manual"
                    />
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    <button
                        onClick={applyFilters}
                        disabled={hasInvalidRange}
                        className="ui-accent-solid inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-colors disabled:opacity-60"
                    >
                        <Search className="w-4 h-4" />
                        Cari
                    </button>
                    <button
                        onClick={resetFilters}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border ui-border text-sm font-semibold ui-text-muted hover:bg-[var(--ui-card-bg)] transition-colors"
                    >
                        <RotateCcw className="w-4 h-4" />
                        Reset
                    </button>
                    <div className="flex items-center gap-2 text-sm ui-text-muted">
                        <Filter className="w-4 h-4" />
                        <span>{rangeLabel}</span>
                    </div>
                    <span className="ui-accent-chip rounded-full border px-3 py-1 text-xs">
                        {scopeLabel}
                    </span>
                    <span className="rounded-full border ui-info-chip px-3 py-1 text-xs font-semibold">
                        Periode WIB
                    </span>
                    {hasUnappliedChanges && (
                        <span className="rounded-full border ui-warning-chip px-3 py-1 text-xs font-semibold">
                            Filter belum diterapkan
                        </span>
                    )}
                </div>
                </div>
            </div>

            <div className="ui-panel-muted rounded-3xl border overflow-hidden">
                <div className="flex flex-col gap-3 border-b ui-border px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.22em] ui-accent-text">Antrean Manual</p>
                        <h2 className="mt-1 text-lg font-bold ui-text">Daftar transaksi yang bisa diputuskan manual</h2>
                    </div>
                    <div className="text-xs ui-text-muted">{rangeLabel}</div>
                </div>
                <div className="overflow-x-auto">
                    <table className="min-w-full">
                        <thead>
                            <tr className="ui-panel text-xs uppercase ui-text-muted">
                                <th className="px-4 py-3 text-left font-semibold">Referensi</th>
                                <th className="px-4 py-3 text-left font-semibold">Member</th>
                                <th className="px-4 py-3 text-left font-semibold">Produk</th>
                                <th className="px-4 py-3 text-left font-semibold">Tujuan</th>
                                <th className="px-4 py-3 text-left font-semibold">Nominal</th>
                                <th className="px-4 py-3 text-left font-semibold">Status</th>
                                <th className="px-4 py-3 text-left font-semibold">Audit</th>
                                <th className="px-4 py-3 text-right font-semibold">Aksi</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--ui-border)]">
                            {loading ? (
                                <tr>
                                    <td colSpan={8} className="px-4 py-8 text-center ui-text-muted">
                                        <span className="inline-flex items-center gap-2">
                                            <Loader2 className="w-4 h-4 animate-spin" />
                                            Memuat antrean transaksi manual...
                                        </span>
                                    </td>
                                </tr>
                            ) : transactions.length === 0 ? (
                                <tr>
                                    <td colSpan={8} className="px-4 py-8 text-center ui-text-muted">
                                        Tidak ada transaksi pada antrean manual saat ini.
                                    </td>
                                </tr>
                            ) : (
                                transactions.map((trx) => (
                                    <tr key={trx._id} className="hover:bg-[var(--ui-card-bg)]">
                                        <td className="px-4 py-3 align-top text-sm ui-text">
                                            <div className="font-semibold ui-accent-text">{trx.vendorTrxId || '-'}</div>
                                            <div className="text-xs ui-text-muted font-mono break-all">{trx._id}</div>
                                            {trx.customerRefId && (
                                                <div className="text-[11px] ui-accent-text">
                                                    Ref pelanggan: {trx.customerRefId}
                                                </div>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 align-top text-sm ui-text">
                                            <div className="font-semibold">{trx.user?.name || '-'}</div>
                                            <div className="text-xs ui-accent-text break-all">{trx.user?.email || '-'}</div>
                                        </td>
                                        <td className="px-4 py-3 align-top text-sm ui-text">
                                            <div className="font-semibold">{trx.product?.name || '-'}</div>
                                            <div className="text-xs ui-text-muted">
                                                {trx.product?.code || '-'} • {trx.product?.category || '-'}
                                            </div>
                                            <div className="text-[11px] ui-text-muted">
                                                {trx.product?.brand || '-'} / {trx.product?.vendorName || '-'}
                                            </div>
                                        </td>
                                        <td className="px-4 py-3 align-top text-sm ui-text">
                                            <div>{trx.target}</div>
                                            <div className="text-xs ui-text-muted">{getSourceLabel(trx.source)} • {formatDateTime(trx.createdAt)}</div>
                                        </td>
                                        <td className="px-4 py-3 align-top text-sm ui-text">
                                            <div className="font-semibold">{formatCurrency(trx.amount)}</div>
                                            <div className={`text-xs ${trx.refunded ? 'ui-success-text' : 'ui-text-muted'}`}>
                                                {trx.refunded ? 'Saldo sudah direfund' : 'Belum refund'}
                                            </div>
                                            {trx.sn && (
                                                <div className="text-xs ui-success-text break-all mt-1">
                                                    SN: {trx.sn}
                                                </div>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 align-top text-sm ui-text">
                                            {getStatusBadge(trx.status)}
                                            <div className="mt-2 text-xs ui-text-muted">
                                                {trx.message || 'Belum ada pesan vendor'}
                                            </div>
                                        </td>
                                        <td className="px-4 py-3 align-top text-sm ui-text">
                                            <div className="text-xs ui-text-muted">Update manual</div>
                                            <div className="text-sm">{trx.statusUpdatedAt ? formatDateTime(trx.statusUpdatedAt) : '-'}</div>
                                            <div className="text-xs ui-text-muted">
                                                {trx.statusUpdatedBy?.name || 'Belum ada audit'}
                                            </div>
                                        </td>
                                        <td className="px-4 py-3 align-top text-right">
                                            <div className="inline-flex items-center gap-2">
                                                <button
                                                    onClick={() => setSelectedTrx(trx)}
                                                    className="ui-accent-chip px-2 py-1 rounded"
                                                    title="Lihat detail"
                                                    aria-label={`Lihat detail transaksi ${trx._id}`}
                                                >
                                                    <Eye className="w-4 h-4" />
                                                </button>
                                                <button
                                                    onClick={() => openEditModal(trx)}
                                                    className="ui-accent-chip px-2 py-1 rounded"
                                                    title="Edit status"
                                                    aria-label={`Edit status transaksi ${trx._id}`}
                                                >
                                                    <Edit className="w-4 h-4" />
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>

                <div className="flex flex-col gap-3 border-t ui-border px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="text-sm ui-text-muted">{rangeLabel}</div>
                    <div className="flex flex-wrap items-center gap-3">
                        <select
                            value={meta.limit}
                            onChange={(event) => setMeta((current) => ({
                                ...current,
                                limit: Number(event.target.value),
                                page: 1
                            }))}
                            className={selectClass}
                        >
                            <option value={20}>20 / halaman</option>
                            <option value={50}>50 / halaman</option>
                            <option value={100}>100 / halaman</option>
                        </select>
                        <button
                            onClick={() => setMeta((current) => ({ ...current, page: Math.max(1, current.page - 1) }))}
                            disabled={loading || meta.page <= 1}
                            className="px-4 py-2 rounded-lg border ui-border text-sm font-semibold ui-text-muted hover:bg-[var(--ui-card-bg)] transition-colors disabled:opacity-50"
                        >
                            Sebelumnya
                        </button>
                        <div className="text-sm ui-text-muted min-w-[110px] text-center">
                            Hal {meta.page} / {meta.totalPages}
                        </div>
                        <button
                            onClick={() => setMeta((current) => ({
                                ...current,
                                page: Math.min(current.totalPages, current.page + 1)
                            }))}
                            disabled={loading || meta.page >= meta.totalPages}
                            className="px-4 py-2 rounded-lg border ui-border text-sm font-semibold ui-text-muted hover:bg-[var(--ui-card-bg)] transition-colors disabled:opacity-50"
                        >
                            Berikutnya
                        </button>
                    </div>
                </div>
            </div>

            {selectedTrx && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                    <div
                        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
                        onClick={() => setSelectedTrx(null)}
                    />

                    <div className="ui-panel relative w-full max-w-4xl border rounded-2xl overflow-hidden animate-slide-up max-h-[90vh] overflow-y-auto" role="dialog" aria-modal="true" aria-labelledby="manual-transaction-detail-title">
                        <div className="flex items-center justify-between px-6 py-4 border-b ui-border">
                            <div>
                                <p className="text-xs ui-text-muted">Detail Transaksi Manual</p>
                                <p id="manual-transaction-detail-title" className="text-lg font-semibold ui-text">{selectedTrx.product?.name || '-'}</p>
                            </div>
                            <button
                                onClick={() => setSelectedTrx(null)}
                                className="w-9 h-9 rounded-full ui-panel-muted flex items-center justify-center ui-text-muted hover:text-[var(--ui-text)] transition-colors"
                                aria-label="Tutup detail transaksi manual"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        <div className="p-6 space-y-6">
                            <div className="flex items-center gap-3">
                                {getStatusIcon(selectedTrx.status)}
                                {getStatusBadge(selectedTrx.status, 'md')}
                            </div>

                            {isDeferredValidation(toPresentationInput(selectedTrx)) && (
                                <div className="rounded-xl border ui-warning-chip p-4 text-sm">
                                    <div className="flex items-start gap-2">
                                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 ui-warning-text" />
                                        <div>
                                            <p className="font-semibold ui-warning-text">Validasi tertunda</p>
                                            <p className="mt-1 ui-text-muted">
                                                {transactionBalanceCopy(toPresentationInput(selectedTrx))}
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            )}

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                <div className="ui-panel-muted border rounded-xl p-3 flex items-start justify-between gap-3">
                                    <div>
                                        <p className="text-xs ui-text-muted">Internal ID</p>
                                        <p className="text-sm ui-text font-mono break-all">{selectedTrx._id}</p>
                                    </div>
                                    <button
                                        onClick={() => copyToClipboard(selectedTrx._id, 'internal-id')}
                                        className="p-2 hover:bg-[var(--ui-card-bg)] rounded-lg ui-text-muted"
                                        aria-label="Salin internal ID"
                                    >
                                        {copied === 'internal-id' ? <CheckCircle className="w-4 h-4 ui-success-text" /> : <Copy className="w-4 h-4" />}
                                    </button>
                                </div>

                                <div className="ui-panel-muted border rounded-xl p-3 flex items-start justify-between gap-3">
                                    <div>
                                        <p className="text-xs ui-text-muted">Vendor Trx ID</p>
                                        <p className="text-sm ui-text font-mono break-all">{selectedTrx.vendorTrxId || '-'}</p>
                                    </div>
                                    {selectedTrx.vendorTrxId && (
                                        <button
                                            onClick={() => copyToClipboard(selectedTrx.vendorTrxId!, 'vendor-id')}
                                            className="p-2 hover:bg-[var(--ui-card-bg)] rounded-lg ui-text-muted"
                                            aria-label="Salin vendor transaction ID"
                                        >
                                            {copied === 'vendor-id' ? <CheckCircle className="w-4 h-4 ui-success-text" /> : <Copy className="w-4 h-4" />}
                                        </button>
                                    )}
                                </div>

                                <div className="ui-panel-muted border rounded-xl p-3 flex items-start justify-between gap-3">
                                    <div>
                                        <p className="text-xs ui-text-muted">Customer Ref ID</p>
                                        <p className="text-sm ui-text font-mono break-all">{selectedTrx.customerRefId || '-'}</p>
                                    </div>
                                    {selectedTrx.customerRefId && (
                                        <button
                                            onClick={() => copyToClipboard(selectedTrx.customerRefId!, 'customer-ref')}
                                            className="p-2 hover:bg-[var(--ui-card-bg)] rounded-lg ui-text-muted"
                                            aria-label="Salin customer reference ID"
                                        >
                                            {copied === 'customer-ref' ? <CheckCircle className="w-4 h-4 ui-success-text" /> : <Copy className="w-4 h-4" />}
                                        </button>
                                    )}
                                </div>

                                <div className="ui-panel-muted border rounded-xl p-3">
                                    <p className="text-xs ui-text-muted">Sumber</p>
                                    <p className="text-sm ui-text">{getSourceLabel(selectedTrx.source)}</p>
                                    <p className="text-xs ui-text-muted mt-1">Vendor: {selectedTrx.product?.vendorName || '-'}</p>
                                </div>

                                <div className="ui-panel-muted border rounded-xl p-3 md:col-span-2">
                                    <p className="text-xs ui-text-muted">Produk</p>
                                    <p className="text-sm ui-text font-semibold">{selectedTrx.product?.name || '-'}</p>
                                    <p className="text-xs ui-text-muted">
                                        {selectedTrx.product?.code || '-'} • {selectedTrx.product?.category || '-'} • {selectedTrx.product?.brand || '-'}
                                    </p>
                                </div>

                                <div className="ui-panel-muted border rounded-xl p-3 flex items-start justify-between gap-3">
                                    <div>
                                        <p className="text-xs ui-text-muted">Target</p>
                                        <p className="text-sm ui-text break-all">{selectedTrx.target}</p>
                                    </div>
                                    <button
                                        onClick={() => copyToClipboard(selectedTrx.target, 'target')}
                                        className="p-2 hover:bg-[var(--ui-card-bg)] rounded-lg ui-text-muted"
                                        aria-label="Salin target transaksi"
                                    >
                                        {copied === 'target' ? <CheckCircle className="w-4 h-4 ui-success-text" /> : <Copy className="w-4 h-4" />}
                                    </button>
                                </div>

                                <div className="ui-panel-muted border rounded-xl p-3">
                                    <p className="text-xs ui-text-muted">Member</p>
                                    <p className="text-sm ui-text font-semibold">{selectedTrx.user?.name || '-'}</p>
                                    <p className="text-xs ui-accent-text break-all">{selectedTrx.user?.email || '-'}</p>
                                </div>

                                <div className="ui-panel-muted border rounded-xl p-3">
                                    <p className="text-xs ui-text-muted">Nominal</p>
                                    <p className="text-lg ui-accent-text font-bold">{formatCurrency(selectedTrx.amount)}</p>
                                    <p className={`text-xs mt-1 ${selectedTrx.refunded ? 'ui-success-text' : 'ui-text-muted'}`}>
                                        {transactionBalanceCopy(toPresentationInput(selectedTrx))}
                                    </p>
                                </div>

                                <div className="ui-panel-muted border rounded-xl p-3">
                                    <p className="text-xs ui-text-muted">SN / Token</p>
                                    <p className="text-sm ui-text break-all font-mono">{selectedTrx.sn || '-'}</p>
                                </div>

                                <div className="ui-panel-muted border rounded-xl p-3 md:col-span-2">
                                    <p className="text-xs ui-text-muted">Vendor Message</p>
                                    <p className="text-sm ui-text whitespace-pre-wrap">{selectedTrx.message || '-'}</p>
                                </div>

                                <div className="ui-panel-muted border rounded-xl p-3 md:col-span-2">
                                    <p className="text-xs ui-text-muted">Catatan Admin</p>
                                    <p className="text-sm ui-text whitespace-pre-wrap">{selectedTrx.statusUpdateNote || '-'}</p>
                                </div>

                                <div className="ui-panel-muted border rounded-xl p-3">
                                    <p className="text-xs ui-text-muted">Dibuat</p>
                                    <p className="text-sm ui-text">{formatDateTime(selectedTrx.createdAt)}</p>
                                </div>
                                <div className="ui-panel-muted border rounded-xl p-3">
                                    <p className="text-xs ui-text-muted">Diperbarui</p>
                                    <p className="text-sm ui-text">{formatDateTime(selectedTrx.updatedAt)}</p>
                                </div>
                                <div className="ui-panel-muted border rounded-xl p-3">
                                    <p className="text-xs ui-text-muted">Update Manual</p>
                                    <p className="text-sm ui-text">{formatDateTime(selectedTrx.statusUpdatedAt)}</p>
                                </div>
                                <div className="ui-panel-muted border rounded-xl p-3">
                                    <p className="text-xs ui-text-muted">Diproses Oleh</p>
                                    <p className="text-sm ui-text">{selectedTrx.statusUpdatedBy?.name || '-'}</p>
                                    <p className="text-xs ui-text-muted">{selectedTrx.statusUpdatedBy?.email || selectedTrx.statusUpdatedBy?.role || '-'}</p>
                                </div>
                            </div>
                        </div>

                        <div className="px-6 py-4 border-t ui-border flex justify-end">
                            <button
                                onClick={() => setSelectedTrx(null)}
                                className="ui-accent-solid px-4 py-2 rounded-lg font-semibold transition-colors"
                            >
                                Tutup
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {editingTrx && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                    <div
                        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
                        onClick={closeEditModal}
                    />

                    <div className="ui-panel relative w-full max-w-xl border rounded-2xl overflow-hidden animate-slide-up" role="dialog" aria-modal="true" aria-labelledby="manual-transaction-edit-title">
                        <div className="flex items-center justify-between px-6 py-4 border-b ui-border">
                            <div>
                                <p className="text-xs ui-text-muted">Proses Transaksi Manual</p>
                                <p id="manual-transaction-edit-title" className="text-lg font-semibold ui-text">{editingTrx.product?.name || '-'}</p>
                            </div>
                            <button
                                onClick={closeEditModal}
                                className="w-9 h-9 rounded-full ui-panel-muted flex items-center justify-center ui-text-muted hover:text-[var(--ui-text)] transition-colors"
                                aria-label="Tutup modal edit status transaksi manual"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        <div className="p-6 space-y-4">
                            <div className="ui-panel-muted border rounded-xl p-3">
                                <p className="text-xs ui-text-muted mb-1">Internal ID</p>
                                <p className="text-sm ui-text font-mono break-all">{editingTrx._id}</p>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                    <label className="block text-sm font-medium ui-text-muted mb-2">Status</label>
                                    <select
                                        value={editForm.status}
                                        onChange={(event) => setEditForm((current) => ({
                                            ...current,
                                            status: event.target.value as TransactionStatus
                                        }))}
                                        className={selectClass}
                                    >
                                        <option value="pending">Pending</option>
                                        <option value="processing">Processing</option>
                                        <option value="success">Success</option>
                                        <option value="failed">Failed</option>
                                    </select>
                                </div>

                                <div>
                                    <label className="block text-sm font-medium ui-text-muted mb-2">Vendor Trx ID</label>
                                    <input
                                        type="text"
                                        value={editForm.vendorTrxId}
                                        onChange={(event) => setEditForm((current) => ({ ...current, vendorTrxId: event.target.value }))}
                                        placeholder="Masukkan ID vendor"
                                        className={inputClass}
                                    />
                                </div>
                            </div>

                            <div>
                                <label className="block text-sm font-medium ui-text-muted mb-2">SN / Token</label>
                                <input
                                    type="text"
                                    value={editForm.sn}
                                    onChange={(event) => setEditForm((current) => ({ ...current, sn: event.target.value }))}
                                    placeholder="Masukkan SN atau token"
                                    className={inputClass}
                                />
                            </div>

                            <div>
                                <label className="block text-sm font-medium ui-text-muted mb-2">Catatan Admin</label>
                                <textarea
                                    value={editForm.note}
                                    onChange={(event) => setEditForm((current) => ({ ...current, note: event.target.value }))}
                                    placeholder="Tulis alasan perubahan status"
                                    rows={4}
                                    className={`${inputClass} min-h-[110px]`}
                                />
                                <div className="mt-2 text-xs ui-text-muted text-right">
                                    {editForm.note.length}/500
                                </div>
                            </div>

                            {(editNeedsRefund || editNeedsRecharge || editWillRevokePoints) && (
                                <div className="rounded-xl border p-4 text-sm ui-warning-chip space-y-2">
                                    <div className="flex items-start gap-2">
                                        <AlertTriangle className="w-4 h-4 mt-0.5 ui-warning-text" />
                                        <div className="space-y-1">
                                            {editNeedsRefund && (
                                                <p>Status ini akan mengembalikan saldo transaksi ke user.</p>
                                            )}
                                            {editNeedsRecharge && (
                                                <p>Status ini akan menarik kembali saldo transaksi dari user yang sebelumnya sudah refund.</p>
                                            )}
                                            {editWillRevokePoints && (
                                                <p>
                                                    Status dipindah dari <strong>success</strong>. Poin dari transaksi ini akan dicabut kembali.
                                                    Jika poin user tidak cukup, update akan ditolak.
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>

                        <div className="px-6 py-4 border-t ui-border flex gap-3 justify-end">
                            <button
                                onClick={closeEditModal}
                                className="px-4 py-2 border ui-border ui-text-muted rounded-lg font-semibold hover:bg-[var(--ui-card-muted)] transition-colors"
                            >
                                Batal
                            </button>
                            <button
                                onClick={handleSaveStatus}
                                disabled={saving || editForm.note.length > 500}
                                className="ui-accent-solid px-4 py-2 rounded-lg font-semibold transition-colors disabled:opacity-60 inline-flex items-center gap-2"
                            >
                                {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                                {saving ? 'Menyimpan...' : 'Simpan'}
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
