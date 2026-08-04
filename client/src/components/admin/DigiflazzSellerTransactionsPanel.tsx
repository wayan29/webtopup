import { useEffect, useMemo, useState } from 'react';
import {
    CheckCircle,
    Clock,
    Copy,
    Download,
    Eye,
    Filter,
    Loader2,
    RefreshCw,
    RotateCcw,
    Search,
    Send,
    ShieldCheck,
    X,
    XCircle,
    Zap
} from 'lucide-react';
import { apiV2 } from '../../api';

type SellerOrderStatus = 'pending' | 'success' | 'failed';

type SellerOrderCallbackFilter = '' | 'pending' | 'due' | 'delivered';

interface SellerTransactionProduct {
    _id?: string;
    name?: string;
    code?: string;
    brand?: string;
    category?: string;
    vendorName?: string;
    vendorSku?: string;
    active?: boolean;
}

interface SellerTransaction {
    id: string;
    refId: string;
    trId: string;
    pulsaCode: string;
    target: string;
    price: number;
    status: SellerOrderStatus;
    rc: string;
    message: string;
    sn?: string;
    vendorName?: string;
    vendorSku?: string;
    vendorTrxId?: string;
    callbackRequired: boolean;
    callbackAttemptCount: number;
    callbackDeliveredAt?: string | null;
    callbackLastAttemptAt?: string | null;
    callbackNextRetryAt?: string | null;
    callbackLastStatusCode?: number | null;
    callbackLastMessage?: string;
    requestIp?: string;
    rawRequest?: Record<string, unknown> | null;
    createdAt: string;
    updatedAt: string;
    product?: SellerTransactionProduct | null;
}

interface SellerTransactionsResponse {
    items: SellerTransaction[];
    meta: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
    };
    summary: {
        total: number;
        pending: number;
        success: number;
        failed: number;
        callbackPending: number;
        callbackDueRetry: number;
        amountTotal: number;
    };
}

type SellerFilterState = {
    search: string;
    status: string;
    callback: SellerOrderCallbackFilter;
    startDate: string;
    endDate: string;
};

type SellerFilterPreset = Partial<Pick<SellerFilterState, 'callback'>>;

const defaultFilters: SellerFilterState = {
    search: '',
    status: '',
    callback: '',
    startDate: '',
    endDate: ''
};

const formatCurrency = (value: number) => `Rp${Number(value || 0).toLocaleString('id-ID')}`;
const formatDateTime = (value?: string | null) => (
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

const getStatusBadge = (status: SellerOrderStatus, size: 'sm' | 'md' = 'sm') => {
    const baseClass = size === 'md'
        ? 'px-3 py-1.5 text-sm font-semibold rounded-full'
        : 'px-2 py-1 text-xs font-semibold rounded-full';

    switch (status) {
        case 'success':
            return <span className={`${baseClass} border ui-success-chip`}>Sukses</span>;
        case 'pending':
            return <span className={`${baseClass} border ui-warning-chip`}>Pending</span>;
        case 'failed':
            return <span className={`${baseClass} border ui-danger-chip`}>Gagal</span>;
        default:
            return <span className={`${baseClass} ui-panel-muted ui-text-muted`}>{status}</span>;
    }
};

const getStatusIcon = (status: SellerOrderStatus) => {
    switch (status) {
        case 'success':
            return <CheckCircle className="w-12 h-12 ui-success-text" />;
        case 'pending':
            return <Clock className="w-12 h-12 ui-warning-text" />;
        case 'failed':
            return <XCircle className="w-12 h-12 ui-danger-text" />;
        default:
            return <Clock className="w-12 h-12 ui-text-muted" />;
    }
};

const getCallbackBadge = (order: SellerTransaction) => {
    const nextRetryAt = order.callbackNextRetryAt ? new Date(order.callbackNextRetryAt).getTime() : 0;
    const retryIsDue = order.callbackRequired && (!nextRetryAt || nextRetryAt <= Date.now());

    if (retryIsDue) {
        return <span className="px-2 py-1 text-xs font-semibold rounded-full border ui-danger-chip">Retry due</span>;
    }

    if (order.callbackRequired) {
        return <span className="px-2 py-1 text-xs font-semibold rounded-full border ui-warning-chip">Menunggu callback</span>;
    }

    if (order.callbackDeliveredAt) {
        return <span className="px-2 py-1 text-xs font-semibold rounded-full border ui-success-chip">Terkirim</span>;
    }

    if (order.status !== 'pending' && order.callbackAttemptCount <= 0 && !order.callbackLastMessage) {
        return <span className="px-2 py-1 text-xs font-semibold rounded-full ui-panel-muted ui-text-muted">Belum dikirim</span>;
    }

    if (order.callbackAttemptCount > 0 || order.callbackLastStatusCode || order.callbackLastMessage) {
        return <span className="px-2 py-1 text-xs font-semibold rounded-full border ui-danger-chip">Perlu retry</span>;
    }

    return <span className="px-2 py-1 text-xs font-semibold rounded-full ui-panel-muted ui-text-muted">Belum final</span>;
};

const stringifyJson = (value: Record<string, unknown> | null | undefined) => {
    if (!value) {
        return '-';
    }

    try {
        return JSON.stringify(value, null, 2);
    } catch {
        return '[raw request unavailable]';
    }
};

type Props = {
    canManageCallbacks: boolean;
    initialFilters?: SellerFilterPreset;
};

export default function DigiflazzSellerTransactionsPanel({ canManageCallbacks, initialFilters }: Props) {
    const [orders, setOrders] = useState<SellerTransaction[]>([]);
    const [summary, setSummary] = useState<SellerTransactionsResponse['summary']>({
        total: 0,
        pending: 0,
        success: 0,
        failed: 0,
        callbackPending: 0,
        callbackDueRetry: 0,
        amountTotal: 0
    });
    const [meta, setMeta] = useState<SellerTransactionsResponse['meta']>({
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 1
    });
    const [loading, setLoading] = useState(true);
    const initialFilterState = { ...defaultFilters, ...initialFilters };
    const [filters, setFilters] = useState<SellerFilterState>(initialFilterState);
    const [appliedFilters, setAppliedFilters] = useState<SellerFilterState>(initialFilterState);
    const [selectedOrder, setSelectedOrder] = useState<SellerTransaction | null>(null);
    const [copied, setCopied] = useState<string | null>(null);
    const [errorMessage, setErrorMessage] = useState('');
    const [successMessage, setSuccessMessage] = useState('');
    const [exporting, setExporting] = useState(false);
    const [retryingId, setRetryingId] = useState<string | null>(null);
    const [processingDueRetries, setProcessingDueRetries] = useState(false);

    const inputClass = 'w-full rounded-lg ui-field border px-3 py-2 text-sm';
    const selectClass = 'w-full rounded-lg ui-field border px-3 py-2 text-sm';

    const fetchOrders = async () => {
        setLoading(true);
        setErrorMessage('');

        try {
            const requestConfig = {
                params: {
                    page: meta.page,
                    limit: meta.limit,
                    ...Object.fromEntries(
                        Object.entries(appliedFilters).filter(([, value]) => value)
                    )
                }
            };
            const response = await apiV2
                .get<SellerTransactionsResponse>('/digiflazz-seller/orders/admin', requestConfig);

            const nextItems = response.data.items || [];
            setOrders(nextItems);
            setSummary(response.data.summary);
            setMeta(response.data.meta);
            setSelectedOrder((current) => {
                if (!current) {
                    return current;
                }

                return nextItems.find((item) => item.id === current.id) || current;
            });
        } catch (error: any) {
            setErrorMessage(error.response?.data?.message || 'Gagal memuat transaksi Digiflazz Seller');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchOrders();
    }, [meta.page, meta.limit, appliedFilters]);

    const rangeLabel = useMemo(() => {
        if (meta.total === 0) {
            return '0 data';
        }

        const start = (meta.page - 1) * meta.limit + 1;
        const end = Math.min(meta.page * meta.limit, meta.total);
        return `${start}-${end} dari ${meta.total} transaksi seller`;
    }, [meta]);

    const hasActiveFilters = useMemo(
        () => Object.values(appliedFilters).some(Boolean),
        [appliedFilters]
    );

    const summaryCards = [
        {
            label: 'Total Seller',
            value: summary.total,
            helper: rangeLabel,
            accent: 'ui-text',
            border: 'ui-border'
        },
        {
            label: 'Sukses',
            value: summary.success,
            helper: 'Order final sukses',
            accent: 'ui-success-text',
            border: 'ui-border'
        },
        {
            label: 'Pending',
            value: summary.pending,
            helper: 'Masih menunggu vendor',
            accent: 'ui-warning-text',
            border: 'ui-border'
        },
        {
            label: 'Callback Pending',
            value: summary.callbackPending,
            helper: 'Perlu kirim/ulang callback',
            accent: 'ui-info-text',
            border: 'ui-border'
        },
        {
            label: 'Retry Due',
            value: summary.callbackDueRetry,
            helper: 'Sudah waktunya diproses queue',
            accent: 'ui-danger-text',
            border: 'ui-border'
        },
        {
            label: 'Omset Seller',
            value: formatCurrency(summary.amountTotal),
            helper: 'Total harga jual seller',
            accent: 'ui-accent-text',
            border: 'border-[color-mix(in_srgb,var(--ui-accent)_34%,transparent)]'
        }
    ];

    const copyToClipboard = async (text: string, field: string) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(field);
            window.setTimeout(() => setCopied(null), 1800);
        } catch {
            setErrorMessage('Gagal menyalin data');
        }
    };

    const applyFilters = () => {
        setSuccessMessage('');
        setMeta((current) => ({
            ...current,
            page: 1
        }));
        setAppliedFilters({ ...filters });
    };

    const resetFilters = () => {
        setFilters(defaultFilters);
        setAppliedFilters(defaultFilters);
        setSuccessMessage('');
        setMeta((current) => ({
            ...current,
            page: 1
        }));
    };

    const handleRetryCallback = async (order: SellerTransaction) => {
        setRetryingId(order.id);
        setErrorMessage('');
        setSuccessMessage('');

        try {
            const response = await apiV2.post(`/digiflazz-seller/orders/${order.id}/retry-callback`);
            setSuccessMessage(response.data?.message || `Callback untuk ${order.refId} berhasil dikirim ulang`);
            await fetchOrders();
        } catch (error: any) {
            setErrorMessage(error.response?.data?.message || 'Gagal mengirim ulang callback');
        } finally {
            setRetryingId(null);
        }
    };

    const handleProcessDueRetries = async () => {
        setProcessingDueRetries(true);
        setErrorMessage('');
        setSuccessMessage('');

        try {
            const response = await apiV2.post('/digiflazz-seller/orders/process-callback-retries', { limit: 20 });
            const data = response.data || {};
            setSuccessMessage(`Queue retry diproses. ${data.successCount || 0} terkirim, ${data.failedCount || 0} gagal, ${data.remainingDue || 0} masih due.`);
            await fetchOrders();
        } catch (error: any) {
            setErrorMessage(error.response?.data?.message || 'Gagal memproses queue retry callback');
        } finally {
            setProcessingDueRetries(false);
        }
    };

    const handleExport = async () => {
        try {
            setExporting(true);
            setErrorMessage('');

            const exportConfig = {
                params: Object.fromEntries(
                    Object.entries(appliedFilters).filter(([, value]) => value)
                ),
                responseType: 'blob'
            } as const;
            const response = await apiV2
                .get('/digiflazz-seller/orders/admin/export', exportConfig);

            const disposition = response.headers['content-disposition'] || '';
            const filenameMatch = /filename="?([^";]+)"?/i.exec(disposition);
            const filename = filenameMatch?.[1] || `digiflazz-seller-orders-${new Date().toISOString().slice(0, 10)}.csv`;
            const blob = new Blob([response.data], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.setAttribute('download', filename);
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        } catch (error: any) {
            setErrorMessage(error.response?.data?.message || 'Gagal export CSV transaksi seller');
        } finally {
            setExporting(false);
        }
    };

    return (
        <div className="space-y-5">
            {(errorMessage || successMessage) && (
                <div className={`rounded-xl border px-4 py-3 text-sm ${
                    errorMessage
                        ? 'ui-danger-chip'
                        : 'ui-success-chip'
                }`}>
                    {errorMessage || successMessage}
                </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-6 gap-4">
                {summaryCards.map((card) => (
                    <div
                        key={card.label}
                        className={`rounded-xl border ${card.border} ui-panel-muted p-4 shadow-[0_12px_40px_rgba(0,0,0,0.18)]`}
                    >
                        <p className="text-xs uppercase tracking-[0.18em] ui-text-muted">{card.label}</p>
                        <p className={`mt-3 text-2xl font-black ${card.accent}`}>{card.value}</p>
                        <p className="mt-2 text-xs ui-text-muted">{card.helper}</p>
                    </div>
                ))}
            </div>

            <div className="ui-panel-muted border ui-border rounded-xl p-4 space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-3">
                    <input
                        placeholder="Cari ref, target, produk, vendor trx"
                        value={filters.search}
                        onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
                        className={inputClass}
                    />
                    <select
                        value={filters.status}
                        onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}
                        className={selectClass}
                    >
                        <option value="">Semua status</option>
                        <option value="pending">Pending</option>
                        <option value="success">Success</option>
                        <option value="failed">Failed</option>
                    </select>
                    <select
                        value={filters.callback}
                        onChange={(event) => setFilters((current) => ({
                            ...current,
                            callback: event.target.value as SellerOrderCallbackFilter
                        }))}
                        className={selectClass}
                    >
                        <option value="">Semua callback</option>
                        <option value="pending">Callback pending</option>
                        <option value="due">Retry due</option>
                        <option value="delivered">Callback delivered</option>
                    </select>
                    <input
                        type="date"
                        value={filters.startDate}
                        onChange={(event) => setFilters((current) => ({ ...current, startDate: event.target.value }))}
                        className={inputClass}
                    />
                    <input
                        type="date"
                        value={filters.endDate}
                        onChange={(event) => setFilters((current) => ({ ...current, endDate: event.target.value }))}
                        className={inputClass}
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
                    <button
                        onClick={resetFilters}
                        className="ui-muted-action inline-flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-semibold transition-colors"
                    >
                        <RotateCcw className="w-4 h-4" />
                        Reset
                    </button>
                    <button
                        onClick={() => fetchOrders()}
                        className="ui-muted-action inline-flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-semibold transition-colors"
                    >
                        <RefreshCw className="w-4 h-4" />
                        Reload
                    </button>
                    <button
                        onClick={handleProcessDueRetries}
                        disabled={!canManageCallbacks || processingDueRetries || summary.callbackDueRetry <= 0}
                        className="ui-info-action inline-flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-semibold transition-colors disabled:opacity-60"
                    >
                        {processingDueRetries ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                        Process Due ({summary.callbackDueRetry})
                    </button>
                    <button
                        onClick={handleExport}
                        disabled={exporting || orders.length === 0}
                        className="ui-muted-action inline-flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-semibold transition-colors disabled:opacity-60"
                    >
                        <Download className="w-4 h-4" />
                        {exporting ? 'Mengunduh...' : 'Export CSV'}
                    </button>
                    <div className="flex items-center gap-2 text-sm ui-text-muted">
                        <Filter className="w-4 h-4" />
                        <span>{rangeLabel}</span>
                    </div>
                    {hasActiveFilters && (
                        <span className="ui-accent-chip rounded-full border px-3 py-1 text-xs">
                            Filter aktif
                        </span>
                    )}
                </div>
            </div>

            <div className="ui-panel-muted rounded-xl border ui-border overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="min-w-full">
                        <thead>
                            <tr className="ui-panel ui-text-muted text-xs uppercase">
                                <th className="px-4 py-3 text-left font-semibold">Referensi</th>
                                <th className="px-4 py-3 text-left font-semibold">Produk</th>
                                <th className="px-4 py-3 text-left font-semibold">Harga Seller</th>
                                <th className="px-4 py-3 text-left font-semibold">Tujuan</th>
                                <th className="px-4 py-3 text-left font-semibold">Status</th>
                                <th className="px-4 py-3 text-left font-semibold">Callback</th>
                                <th className="px-4 py-3 text-left font-semibold">Supplier</th>
                                <th className="px-4 py-3 text-right font-semibold">Aksi</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--ui-border)]">
                            {loading ? (
                                <tr>
                                    <td colSpan={8} className="px-4 py-8 text-center ui-text-muted">
                                        <span className="inline-flex items-center gap-2">
                                            <Loader2 className="w-4 h-4 animate-spin" />
                                            Memuat transaksi Digiflazz Seller...
                                        </span>
                                    </td>
                                </tr>
                            ) : orders.length === 0 ? (
                                <tr>
                                    <td colSpan={8} className="px-4 py-8 text-center ui-text-muted">
                                        Tidak ada transaksi seller yang cocok dengan filter saat ini.
                                    </td>
                                </tr>
                            ) : (
                                orders.map((order) => (
                                    <tr key={order.id} className="hover:bg-[var(--ui-card-bg)]">
                                        <td className="px-4 py-3 align-top text-sm ui-text">
                                            <div className="font-semibold ui-info-text">{order.refId}</div>
                                            <div className="text-xs ui-text-muted font-mono break-all">{order.trId}</div>
                                            <div className="text-[11px] ui-text-muted mt-1">{formatDateTime(order.createdAt)}</div>
                                        </td>
                                        <td className="px-4 py-3 align-top text-sm ui-text">
                                            <div className="font-semibold">{order.product?.name || '-'}</div>
                                            <div className="text-xs ui-text-muted">
                                                {order.product?.code || order.pulsaCode} • {order.product?.brand || '-'}
                                            </div>
                                            <div className="text-[11px] ui-text-muted">
                                                {order.product?.category || '-'} / {order.pulsaCode}
                                            </div>
                                        </td>
                                        <td className="px-4 py-3 align-top text-sm ui-text">
                                            <div className="font-semibold">{formatCurrency(order.price)}</div>
                                            <div className="text-xs ui-text-muted">RC: {order.rc || '-'}</div>
                                            {order.sn && (
                                                <div className="text-xs ui-success-text break-all mt-1">SN: {order.sn}</div>
                                            )}
                                        </td>
                                        <td className="px-4 py-3 align-top text-sm ui-text">
                                            <div>{order.target}</div>
                                            <div className="text-xs ui-text-muted break-all">{order.requestIp || '-'}</div>
                                        </td>
                                        <td className="px-4 py-3 align-top text-sm ui-text">
                                            {getStatusBadge(order.status)}
                                            <div className="mt-2 text-xs ui-text-muted break-all">{order.message || '-'}</div>
                                        </td>
                                        <td className="px-4 py-3 align-top text-sm ui-text">
                                            {getCallbackBadge(order)}
                                            <div className="mt-2 text-xs ui-text-muted">
                                                Attempt: {order.callbackAttemptCount}
                                            </div>
                                            {order.callbackLastAttemptAt && (
                                                <div className="text-[11px] ui-text-muted">Last: {formatDateTime(order.callbackLastAttemptAt)}</div>
                                            )}
                                            {order.callbackRequired && (
                                                <div className="text-[11px] ui-warning-text">Next: {formatDateTime(order.callbackNextRetryAt)}</div>
                                            )}
                                            <div className="text-[11px] ui-text-muted break-all">
                                                {order.callbackLastMessage || '-'}
                                            </div>
                                        </td>
                                        <td className="px-4 py-3 align-top text-sm ui-text">
                                            <div>{order.vendorName || order.product?.vendorName || '-'}</div>
                                            <div className="text-xs ui-text-muted break-all">{order.vendorTrxId || '-'}</div>
                                            <div className="text-[11px] ui-text-muted">{order.vendorSku || order.product?.vendorSku || '-'}</div>
                                        </td>
                                        <td className="px-4 py-3 align-top text-right">
                                            <div className="inline-flex items-center gap-2">
                                                <button
                                                    onClick={() => setSelectedOrder(order)}
                                                    className="ui-accent-chip px-2 py-1 rounded"
                                                    title="Lihat detail"
                                                >
                                                    <Eye className="w-4 h-4" />
                                                </button>
                                                {canManageCallbacks && (
                                                    <button
                                                        onClick={() => handleRetryCallback(order)}
                                                        disabled={retryingId === order.id}
                                                        className="ui-info-chip px-2 py-1 rounded disabled:opacity-60"
                                                        title="Kirim callback ulang"
                                                    >
                                                        {retryingId === order.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                                                    </button>
                                                )}
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
                            className="rounded-lg ui-panel border ui-border px-3 py-2 text-sm ui-text focus:outline-none focus:border-[var(--ui-accent)]"
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
                            Prev
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
                            Next
                        </button>
                    </div>
                </div>
            </div>

            {selectedOrder && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                    <div
                        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
                        onClick={() => setSelectedOrder(null)}
                    />

                    <div className="relative w-full max-w-5xl ui-panel border ui-border rounded-2xl overflow-hidden animate-slide-up max-h-[90vh] overflow-y-auto">
                        <div className="flex items-center justify-between px-6 py-4 border-b ui-border">
                            <div>
                                <p className="text-xs ui-text-muted">Detail Transaksi Digiflazz Seller</p>
                                <p className="text-lg font-semibold ui-text">{selectedOrder.product?.name || selectedOrder.pulsaCode}</p>
                            </div>
                            <button
                                onClick={() => setSelectedOrder(null)}
                                className="w-9 h-9 rounded-full ui-panel-muted flex items-center justify-center ui-text-muted hover:text-[var(--ui-text)] hover:bg-[var(--ui-card-bg)] transition-colors"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        <div className="p-6 space-y-6">
                            <div className="flex items-center gap-3">
                                {getStatusIcon(selectedOrder.status)}
                                {getStatusBadge(selectedOrder.status, 'md')}
                                {getCallbackBadge(selectedOrder)}
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                <div className="ui-panel-muted border ui-border rounded-xl p-3 flex items-start justify-between gap-3">
                                    <div>
                                        <p className="text-xs ui-text-muted">Ref ID Digiflazz</p>
                                        <p className="text-sm ui-text font-mono break-all">{selectedOrder.refId}</p>
                                    </div>
                                    <button
                                        onClick={() => copyToClipboard(selectedOrder.refId, 'seller-ref')}
                                        className="p-2 hover:bg-[var(--ui-card-bg)] rounded-lg ui-text-muted"
                                    >
                                        {copied === 'seller-ref' ? <CheckCircle className="w-4 h-4 ui-success-text" /> : <Copy className="w-4 h-4" />}
                                    </button>
                                </div>

                                <div className="ui-panel-muted border ui-border rounded-xl p-3 flex items-start justify-between gap-3">
                                    <div>
                                        <p className="text-xs ui-text-muted">TR ID Internal Seller</p>
                                        <p className="text-sm ui-text font-mono break-all">{selectedOrder.trId}</p>
                                    </div>
                                    <button
                                        onClick={() => copyToClipboard(selectedOrder.trId, 'seller-trid')}
                                        className="p-2 hover:bg-[var(--ui-card-bg)] rounded-lg ui-text-muted"
                                    >
                                        {copied === 'seller-trid' ? <CheckCircle className="w-4 h-4 ui-success-text" /> : <Copy className="w-4 h-4" />}
                                    </button>
                                </div>

                                <div className="ui-panel-muted border ui-border rounded-xl p-3 flex items-start justify-between gap-3">
                                    <div>
                                        <p className="text-xs ui-text-muted">Vendor Trx ID</p>
                                        <p className="text-sm ui-text font-mono break-all">{selectedOrder.vendorTrxId || '-'}</p>
                                    </div>
                                    {selectedOrder.vendorTrxId && (
                                        <button
                                            onClick={() => copyToClipboard(selectedOrder.vendorTrxId!, 'seller-vendor-trx')}
                                            className="p-2 hover:bg-[var(--ui-card-bg)] rounded-lg ui-text-muted"
                                        >
                                            {copied === 'seller-vendor-trx' ? <CheckCircle className="w-4 h-4 ui-success-text" /> : <Copy className="w-4 h-4" />}
                                        </button>
                                    )}
                                </div>

                                <div className="ui-panel-muted border ui-border rounded-xl p-3 flex items-start justify-between gap-3">
                                    <div>
                                        <p className="text-xs ui-text-muted">Target</p>
                                        <p className="text-sm ui-text break-all">{selectedOrder.target}</p>
                                    </div>
                                    <button
                                        onClick={() => copyToClipboard(selectedOrder.target, 'seller-target')}
                                        className="p-2 hover:bg-[var(--ui-card-bg)] rounded-lg ui-text-muted"
                                    >
                                        {copied === 'seller-target' ? <CheckCircle className="w-4 h-4 ui-success-text" /> : <Copy className="w-4 h-4" />}
                                    </button>
                                </div>

                                <div className="ui-panel-muted border ui-border rounded-xl p-3 md:col-span-2">
                                    <p className="text-xs ui-text-muted">Produk Mapping</p>
                                    <p className="text-sm ui-text font-semibold">{selectedOrder.product?.name || '-'}</p>
                                    <p className="text-xs ui-text-muted">
                                        {selectedOrder.product?.code || '-'} • {selectedOrder.product?.category || '-'} • {selectedOrder.product?.brand || '-'}
                                    </p>
                                    <p className="text-xs ui-text-muted mt-1">
                                        Pulsa code seller: {selectedOrder.pulsaCode} • Supplier: {selectedOrder.vendorName || selectedOrder.product?.vendorName || '-'}
                                    </p>
                                </div>

                                <div className="ui-panel-muted border ui-border rounded-xl p-3">
                                    <p className="text-xs ui-text-muted">Harga Seller</p>
                                    <p className="text-lg ui-accent-text font-bold">{formatCurrency(selectedOrder.price)}</p>
                                    <p className="text-xs ui-text-muted mt-1">RC: {selectedOrder.rc || '-'}</p>
                                </div>

                                <div className="ui-panel-muted border ui-border rounded-xl p-3">
                                    <p className="text-xs ui-text-muted">SN / Token</p>
                                    <p className="text-sm ui-text break-all font-mono">{selectedOrder.sn || '-'}</p>
                                </div>

                                <div className="ui-panel-muted border ui-border rounded-xl p-3">
                                    <p className="text-xs ui-text-muted">Status Callback</p>
                                    <div className="mt-2">{getCallbackBadge(selectedOrder)}</div>
                                    <p className="text-xs ui-text-muted mt-2">Attempt: {selectedOrder.callbackAttemptCount}</p>
                                    <p className="text-xs ui-text-muted">Last Attempt: {formatDateTime(selectedOrder.callbackLastAttemptAt)}</p>
                                    <p className="text-xs ui-text-muted">Next Retry: {formatDateTime(selectedOrder.callbackNextRetryAt)}</p>
                                    <p className="text-xs ui-text-muted">Delivered: {formatDateTime(selectedOrder.callbackDeliveredAt)}</p>
                                    <p className="text-xs ui-text-muted">HTTP: {selectedOrder.callbackLastStatusCode || '-'}</p>
                                </div>

                                <div className="ui-panel-muted border ui-border rounded-xl p-3">
                                    <p className="text-xs ui-text-muted">IP Request</p>
                                    <p className="text-sm ui-text break-all">{selectedOrder.requestIp || '-'}</p>
                                    <div className="mt-2 inline-flex items-center gap-2 text-xs ui-text-muted">
                                        <ShieldCheck className="w-3.5 h-3.5" />
                                        Inbound yang tersimpan
                                    </div>
                                </div>

                                <div className="ui-panel-muted border ui-border rounded-xl p-3 md:col-span-2">
                                    <p className="text-xs ui-text-muted">Message Supplier / Seller</p>
                                    <p className="text-sm ui-text whitespace-pre-wrap">{selectedOrder.message || '-'}</p>
                                </div>

                                <div className="ui-panel-muted border ui-border rounded-xl p-3 md:col-span-2">
                                    <p className="text-xs ui-text-muted">Log Callback Terakhir</p>
                                    <p className="text-sm ui-text whitespace-pre-wrap">{selectedOrder.callbackLastMessage || '-'}</p>
                                </div>

                                <div className="ui-panel-muted border ui-border rounded-xl p-3 md:col-span-2">
                                    <p className="text-xs ui-text-muted">Raw Request Digiflazz</p>
                                    <pre className="mt-2 whitespace-pre-wrap break-all text-xs ui-text-muted font-mono overflow-x-auto">{stringifyJson(selectedOrder.rawRequest)}</pre>
                                </div>

                                <div className="ui-panel-muted border ui-border rounded-xl p-3">
                                    <p className="text-xs ui-text-muted">Dibuat</p>
                                    <p className="text-sm ui-text">{formatDateTime(selectedOrder.createdAt)}</p>
                                </div>

                                <div className="ui-panel-muted border ui-border rounded-xl p-3">
                                    <p className="text-xs ui-text-muted">Diperbarui</p>
                                    <p className="text-sm ui-text">{formatDateTime(selectedOrder.updatedAt)}</p>
                                </div>
                            </div>
                        </div>

                        <div className="px-6 py-4 border-t ui-border flex gap-3 justify-end">
                            {canManageCallbacks && (
                                <button
                                    onClick={() => handleRetryCallback(selectedOrder)}
                                    disabled={retryingId === selectedOrder.id}
                                    className="px-4 py-2 border ui-info-action rounded-lg font-semibold transition-colors disabled:opacity-60 inline-flex items-center gap-2"
                                >
                                    {retryingId === selectedOrder.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                                    {retryingId === selectedOrder.id ? 'Mengirim...' : 'Retry Callback'}
                                </button>
                            )}
                            <button
                                onClick={() => setSelectedOrder(null)}
                                className="px-4 py-2 ui-accent-solid rounded-lg font-semibold transition-colors"
                            >
                                Tutup
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
