import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
    apiV2,
    attachIdempotencyKey,
    createIdempotencyKey,
    CRITICAL_MUTATION_AMBIGUOUS_MESSAGE,
    isAmbiguousMutationFailure,
} from '../../api';
import { useStepUpOrchestration } from '../../auth/useStepUpOrchestration';
import { stepUpActionErrorMessage } from '../../auth/withStepUp';
import DigiflazzSellerTransactionsPanel from '../../components/admin/DigiflazzSellerTransactionsPanel';
import {
    canRecheckVendor,
    isDeferredValidation,
    transactionBalanceCopy,
    type TransactionPresentationInput,
} from '../../lib/transactionPresentation';
import { useAuthStore } from '../../store/useAuthStore';
import {
    AlertTriangle,
    CheckCircle,
    Clock,
    Copy,
    Download,
    Edit,
    ExternalLink,
    Eye,
    Filter,
    Loader2,
    RefreshCw,
    RotateCcw,
    Search,
    ShieldAlert,
    Timer,
    X,
    XCircle,
} from 'lucide-react';

type TransactionStatus = 'pending' | 'processing' | 'success' | 'failed';
type TransactionSource = 'web' | 'api';
type TransactionDeskMode = 'internal' | 'digiflazzSeller';

interface AdminTransaction {
    _id: string;
    target: string;
    amount: number;
    status: TransactionStatus;
    referenceId?: string;
  vendorTrxId?: string;
    customerRefId?: string;
    sn?: string;
    message?: string;
    refunded: boolean;
    refundedAt?: string;
    refundReason?: string;
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
    discountVoucherCode?: string;
    discountAmount?: number;
    baseAmount?: number;
    flashSale?: string;
}

interface AdminTransactionsResponse {
    items: AdminTransaction[];
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

function toPresentationInput(transaction: Pick<
    AdminTransaction,
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

type FilterState = {
    search: string;
    status: string;
    source: string;
    category: string;
    brand: string;
    vendor: string;
    startDate: string;
    endDate: string;
};

type TaxonomyOption = { _id: string; name: string };
type VendorOption = { _id: string; name: string };

type StuckTransaction = {
    _id: string;
    target: string;
    amount: number;
    status: string;
    referenceId?: string;
  vendorTrxId?: string;
    customerRefId?: string;
    source: string;
    createdAt: string;
    updatedAt: string;
    ageMinutes: number;
    user?: { _id?: string; name?: string; email?: string };
    product?: { _id?: string; name?: string; code?: string; category?: string; brand?: string; vendor?: string };
};

type StuckResponse = {
    thresholdMinutes: number;
    total: number;
    items: StuckTransaction[];
};

type DatePresetId = 'today' | '7d' | 'pending' | 'processing' | 'failed_today' | 'stuck';

const defaultFilters: FilterState = {
    search: '',
    status: '',
    source: '',
    category: '',
    brand: '',
    vendor: '',
    startDate: '',
    endDate: '',
};

const filterKeys: Array<keyof FilterState> = ['search', 'status', 'source', 'category', 'brand', 'vendor', 'startDate', 'endDate'];

const wibDateParts = (date = new Date()) => {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Jakarta',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(date);
    const year = parts.find((part) => part.type === 'year')?.value || '1970';
    const month = parts.find((part) => part.type === 'month')?.value || '01';
    const day = parts.find((part) => part.type === 'day')?.value || '01';
    return { year, month, day, iso: `${year}-${month}-${day}` };
};

const shiftWibDate = (iso: string, deltaDays: number) => {
    const [year, month, day] = iso.split('-').map(Number);
    // Anchor at UTC noon so WIB day boundaries stay stable when shifting.
    const shifted = new Date(Date.UTC(year, month - 1, day, 12) + deltaDays * 86_400_000);
    return wibDateParts(shifted).iso;
};

const filtersFromSearchParams = (params: URLSearchParams): FilterState => ({
    search: params.get('search') || '',
    status: params.get('status') || '',
    source: params.get('source') || '',
    category: params.get('category') || '',
    brand: params.get('brand') || '',
    vendor: params.get('vendor') || '',
    startDate: params.get('startDate') || '',
    endDate: params.get('endDate') || '',
});

const buildPresetFilters = (preset: DatePresetId): FilterState => {
    const today = wibDateParts().iso;
    if (preset === 'today') {
        return { ...defaultFilters, startDate: today, endDate: today };
    }
    if (preset === '7d') {
        return { ...defaultFilters, startDate: shiftWibDate(today, -6), endDate: today };
    }
    if (preset === 'pending') {
        return { ...defaultFilters, status: 'pending' };
    }
    if (preset === 'failed_today') {
        return { ...defaultFilters, status: 'failed', startDate: today, endDate: today };
    }
    if (preset === 'processing') {
        return { ...defaultFilters, status: 'processing' };
    }
    // stuck: open stuck queue (not a list filter)
    return { ...defaultFilters };
};

const PRESET_CHIPS: Array<{ id: DatePresetId; label: string }> = [
    { id: 'today', label: 'Hari ini' },
    { id: '7d', label: '7 hari' },
    { id: 'pending', label: 'Pending saja' },
    { id: 'processing', label: 'Proses saja' },
    { id: 'failed_today', label: 'Gagal hari ini' },
    { id: 'stuck', label: 'Stuck queue' },
];

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

const buildTimeline = (trx: AdminTransaction) => {
    const events: Array<{ at: string; label: string; detail?: string; tone: string }> = [];
    if (trx.createdAt) {
        events.push({
            at: trx.createdAt,
            label: 'Dibuat',
            detail: `Sumber ${getSourceLabel(trx.source)}`,
            tone: 'ui-info-text',
        });
    }
    if (trx.statusUpdatedAt) {
        events.push({
            at: trx.statusUpdatedAt,
            label: 'Update manual',
            detail: [trx.statusUpdatedBy?.name, trx.statusUpdateNote].filter(Boolean).join(' · ') || undefined,
            tone: 'ui-warning-text',
        });
    }
    if (trx.refundedAt) {
        events.push({
            at: trx.refundedAt,
            label: 'Refund saldo',
            detail: trx.refundReason || undefined,
            tone: 'ui-success-text',
        });
    }
    if (
        trx.updatedAt
        && trx.updatedAt !== trx.createdAt
        && trx.updatedAt !== trx.statusUpdatedAt
        && trx.updatedAt !== trx.refundedAt
    ) {
        events.push({
            at: trx.updatedAt,
            label: `Status: ${trx.status}`,
            detail: trx.message || undefined,
            tone: 'ui-text-muted',
        });
    }
    return events.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
};

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

export default function AdminTransactions() {
    const stepUp = useStepUpOrchestration();
    const [searchParams, setSearchParams] = useSearchParams();
    const { hasPermission, isOwner } = useAuthStore();
    const canEditStatus = isOwner || hasPermission('processManualTransaction');
    const canManageSellerCallbacks = isOwner || hasPermission('manageVendors');
    const [mode, setMode] = useState<TransactionDeskMode>(searchParams.get('mode') === 'seller' ? 'digiflazzSeller' : 'internal');
    const sellerInitialCallbackFilter = searchParams.get('callback') === 'due' ? 'due' : undefined;

    const [transactions, setTransactions] = useState<AdminTransaction[]>([]);
    const [summary, setSummary] = useState<AdminTransactionsResponse['summary']>({
        total: 0,
        pending: 0,
        processing: 0,
        success: 0,
        failed: 0,
        amountTotal: 0
    });
    const [meta, setMeta] = useState<AdminTransactionsResponse['meta']>({
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 1
    });
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [refunding, setRefunding] = useState(false);
    const [recheckingId, setRecheckingId] = useState<string | null>(null);
    const initialFilters = useMemo(() => filtersFromSearchParams(searchParams), []);
    const [filters, setFilters] = useState<FilterState>(initialFilters);
    const [appliedFilters, setAppliedFilters] = useState<FilterState>(initialFilters);
    const [selectedTrx, setSelectedTrx] = useState<AdminTransaction | null>(null);
    const [editingTrx, setEditingTrx] = useState<AdminTransaction | null>(null);
    const [copied, setCopied] = useState<string | null>(null);
    const [errorMessage, setErrorMessage] = useState('');
    const [successMessage, setSuccessMessage] = useState('');
    const latestRequestId = useRef(0);
    const [exporting, setExporting] = useState(false);
    const [stuckOpen, setStuckOpen] = useState(false);
    const [stuckLoading, setStuckLoading] = useState(false);
    const [stuckThresholdMinutes, setStuckThresholdMinutes] = useState(30);
    const [stuckTotal, setStuckTotal] = useState(0);
    const [stuckItems, setStuckItems] = useState<StuckTransaction[]>([]);
    const [selectedIds, setSelectedIds] = useState<string[]>([]);
    const [bulkRechecking, setBulkRechecking] = useState(false);
    const [taxonomyCategories, setTaxonomyCategories] = useState<TaxonomyOption[]>([]);
    const [taxonomyBrands, setTaxonomyBrands] = useState<TaxonomyOption[]>([]);
    const [taxonomyVendors, setTaxonomyVendors] = useState<VendorOption[]>([]);
    const [editForm, setEditForm] = useState({
        status: 'pending' as TransactionStatus,
        vendorTrxId: '',
        sn: '',
        note: ''
    });
    const [refundForm, setRefundForm] = useState({
        transaction: null as AdminTransaction | null,
        reason: ''
    });
    /** Issued when refund confirmation opens; cleared only on success/cancel. */
    const refundIdempotencyKeyRef = useRef<string | null>(null);

    const hasInvalidRange = Boolean(filters.startDate && filters.endDate && filters.startDate > filters.endDate);
    const hasUnappliedChanges = useMemo(() => (
        filterKeys.some((key) => filters[key] !== appliedFilters[key])
    ), [appliedFilters, filters]);

    const refreshSidebarBadges = () => {
        window.dispatchEvent(new Event('admin:sidebar-badges-refresh'));
    };

    const syncUrlParams = useCallback((nextMode: TransactionDeskMode, nextFilters: FilterState) => {
        const params = new URLSearchParams();
        if (nextMode === 'digiflazzSeller') params.set('mode', 'seller');
        filterKeys.forEach((key) => {
            const value = nextFilters[key];
            if (value) params.set(key, value);
        });
        setSearchParams(params, { replace: true });
    }, [setSearchParams]);

    const fetchTransactions = useCallback(async () => {
        if (mode !== 'internal') {
            return;
        }

        const requestId = latestRequestId.current + 1;
        latestRequestId.current = requestId;
        setLoading(true);
        setErrorMessage('');

        try {
            const params = {
                page: meta.page,
                limit: meta.limit,
                ...Object.fromEntries(
                    Object.entries(appliedFilters).filter(([, value]) => value)
                )
            };
            const response = await apiV2.get<AdminTransactionsResponse>('/transactions/admin', { params });
            if (requestId !== latestRequestId.current) return;

            setTransactions(response.data.items || []);
            setSummary(response.data.summary);
            setMeta(response.data.meta);
            setSelectedIds([]);
        } catch (error: any) {
            if (requestId !== latestRequestId.current) return;
            const message = error.response?.data?.message || 'Gagal memuat transaksi admin';
            setErrorMessage(message);
        } finally {
            if (requestId === latestRequestId.current) {
                setLoading(false);
            }
        }
    }, [appliedFilters, meta.limit, meta.page, mode]);

    const fetchStuckTransactions = useCallback(async (thresholdMinutes = stuckThresholdMinutes) => {
        setStuckLoading(true);
        try {
            const response = await apiV2.get<StuckResponse>('/transactions/admin/stuck', {
                params: { thresholdMinutes, limit: 50 },
            });
            setStuckItems(response.data.items || []);
            setStuckTotal(response.data.total || 0);
            setStuckThresholdMinutes(response.data.thresholdMinutes || thresholdMinutes);
        } catch (error: any) {
            setErrorMessage(error.response?.data?.message || 'Gagal memuat antrian stuck');
        } finally {
            setStuckLoading(false);
        }
    }, [stuckThresholdMinutes]);

    const openStuckQueue = useCallback(async () => {
        setStuckOpen(true);
        setSuccessMessage('');
        await fetchStuckTransactions(30);
    }, [fetchStuckTransactions]);

    const applyPreset = useCallback((preset: DatePresetId) => {
        if (preset === 'stuck') {
            void openStuckQueue();
            return;
        }
        const next = buildPresetFilters(preset);
        setFilters(next);
        setAppliedFilters(next);
        setMeta((current) => ({ ...current, page: 1 }));
        setErrorMessage('');
        setSuccessMessage('');
        syncUrlParams(mode, next);
    }, [mode, openStuckQueue, syncUrlParams]);

    useEffect(() => {
        if (mode !== 'internal') {
            return;
        }

        fetchTransactions();
    }, [fetchTransactions, mode]);

    useEffect(() => {
        const handleRefresh = () => {
            fetchTransactions();
            if (stuckOpen) {
                void fetchStuckTransactions();
            }
        };
        window.addEventListener('admin:refresh-current-page', handleRefresh);
        return () => window.removeEventListener('admin:refresh-current-page', handleRefresh);
    }, [fetchStuckTransactions, fetchTransactions, stuckOpen]);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const [categoriesRes, operatorsRes, vendorsRes] = await Promise.all([
                    apiV2.get('/categories/admin/all'),
                    apiV2.get('/operators/admin/all'),
                    apiV2.get('/vendors/admin/all'),
                ]);
                if (cancelled) return;
                const categories = Array.isArray(categoriesRes.data) ? categoriesRes.data : [];
                const operators = Array.isArray(operatorsRes.data) ? operatorsRes.data : [];
                const vendors = Array.isArray(vendorsRes.data) ? vendorsRes.data : [];
                setTaxonomyCategories(
                    categories
                        .map((item: any) => ({ _id: String(item._id || item.id || ''), name: String(item.name || '') }))
                        .filter((item: TaxonomyOption) => item._id && item.name)
                        .sort((a: TaxonomyOption, b: TaxonomyOption) => a.name.localeCompare(b.name)),
                );
                setTaxonomyBrands(
                    operators
                        .map((item: any) => ({ _id: String(item._id || item.id || ''), name: String(item.name || '') }))
                        .filter((item: TaxonomyOption) => item._id && item.name)
                        .sort((a: TaxonomyOption, b: TaxonomyOption) => a.name.localeCompare(b.name)),
                );
                setTaxonomyVendors(
                    vendors
                        .map((item: any) => ({ _id: String(item._id || item.id || ''), name: String(item.name || item.code || '') }))
                        .filter((item: VendorOption) => item._id && item.name)
                        .sort((a: VendorOption, b: VendorOption) => a.name.localeCompare(b.name)),
                );
            } catch {
                // Taxonomy dropdowns are progressive enhancement; free-text still works if empty.
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const inputClass = 'w-full rounded-lg ui-field border px-3 py-2 text-sm';
    const selectClass = 'w-full rounded-lg ui-field border px-3 py-2 text-sm';

    const rangeLabel = useMemo(() => {
        if (meta.total === 0) {
            return '0 data';
        }

        const start = (meta.page - 1) * meta.limit + 1;
        const end = Math.min(meta.page * meta.limit, meta.total);
        return `${start}-${end} dari ${meta.total} transaksi`;
    }, [meta]);

    const hasActiveFilters = useMemo(
        () => Object.values(appliedFilters).some(Boolean),
        [appliedFilters]
    );

    const openEditModal = (transaction: AdminTransaction) => {
        if (!canEditStatus) {
            return;
        }

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

    const openRefundModal = (transaction: AdminTransaction) => {
        if (!canEditStatus || transaction.refunded || transaction.status === 'success') {
            return;
        }

        // Generate before first attempt; preserve across refresh/step-up.
        refundIdempotencyKeyRef.current = createIdempotencyKey();
        setRefundForm({
            transaction,
            reason: transaction.statusUpdateNote || `Refund manual untuk transaksi ${transaction._id.slice(-8).toUpperCase()}`
        });
    };

    const closeRefundModal = () => {
        setRefundForm({ transaction: null, reason: '' });
        // Cancel clears the key so a later confirmation cannot reuse it.
        refundIdempotencyKeyRef.current = null;
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

    const applyFilters = () => {
        setErrorMessage('');
        setSuccessMessage('');
        if (hasInvalidRange) {
            setErrorMessage('Tanggal mulai tidak boleh lebih besar dari tanggal akhir.');
            return;
        }
        setMeta((current) => ({
            ...current,
            page: 1
        }));
        setAppliedFilters({ ...filters });
        syncUrlParams(mode, filters);
    };

    const resetFilters = () => {
        setFilters(defaultFilters);
        setAppliedFilters(defaultFilters);
        setSuccessMessage('');
        setErrorMessage('');
        setMeta((current) => ({
            ...current,
            page: 1
        }));
        syncUrlParams(mode, defaultFilters);
    };

    const handleSaveStatus = async () => {
        if (!editingTrx) {
            return;
        }

        setSaving(true);
        setErrorMessage('');
        setSuccessMessage('');

        try {
            const payload = {
                status: editForm.status,
                vendorTrxId: editForm.vendorTrxId,
                sn: editForm.sn,
                note: editForm.note
            };
            await stepUp.run('transactions.manual', (config) =>
                apiV2.put(`/transactions/${editingTrx._id}/status`, payload, config as never),
            );

            setSuccessMessage('Status transaksi berhasil diperbarui');
            refreshSidebarBadges();
            closeEditModal();
            setSelectedTrx(null);
            await fetchTransactions();
            if (stuckOpen) {
                await fetchStuckTransactions();
            }
        } catch (error: any) {
            if (isAmbiguousMutationFailure(error)) {
                setErrorMessage(
                    `${CRITICAL_MUTATION_AMBIGUOUS_MESSAGE}. Muat ulang daftar transaksi sebelum mencoba lagi.`,
                );
                await fetchTransactions();
                return;
            }
            const text = stepUpActionErrorMessage(error, 'Gagal memperbarui status transaksi');
            if (text) setErrorMessage(text);
        } finally {
            setSaving(false);
        }
    };

    const handleRefund = async () => {
        if (!refundForm.transaction) {
            return;
        }

        setRefunding(true);
        setErrorMessage('');
        setSuccessMessage('');

        try {
            const transactionId = refundForm.transaction._id;
            const payload = { reason: refundForm.reason };
            const idempotencyKey =
                refundIdempotencyKeyRef.current ?? createIdempotencyKey();
            refundIdempotencyKeyRef.current = idempotencyKey;
            await stepUp.run(
                'finance.refund',
                (config) =>
                    apiV2.post(
                        `/transactions/${transactionId}/refund`,
                        payload,
                        attachIdempotencyKey(config as never, idempotencyKey) as never,
                    ),
                attachIdempotencyKey({} as never, idempotencyKey) as never,
            );

            setSuccessMessage('Saldo transaksi berhasil direfund');
            refreshSidebarBadges();
            // Clear only on definitive success.
            refundIdempotencyKeyRef.current = null;
            closeRefundModal();
            setSelectedTrx(null);
            await fetchTransactions();
        } catch (error: any) {
            if (isAmbiguousMutationFailure(error)) {
                setErrorMessage(
                    `${CRITICAL_MUTATION_AMBIGUOUS_MESSAGE}. Muat ulang daftar transaksi sebelum mencoba lagi.`,
                );
                await fetchTransactions();
                return;
            }
            const text = stepUpActionErrorMessage(error, 'Gagal memproses refund transaksi');
            if (text) setErrorMessage(text);
        } finally {
            setRefunding(false);
        }
    };

    const handleRecheckVendor = async (transaction: AdminTransaction) => {
        setRecheckingId(transaction._id);
        setErrorMessage('');
        setSuccessMessage('');

        try {
            const response = await apiV2
                .post(`/transactions/${transaction._id}/recheck`);
            setSuccessMessage(response.data?.message || 'Cek status vendor selesai');
            refreshSidebarBadges();
            setSelectedTrx(null);
            await fetchTransactions();
            if (stuckOpen) {
                await fetchStuckTransactions();
            }
        } catch (error: any) {
            if (isAmbiguousMutationFailure(error)) {
                setErrorMessage(
                    `${CRITICAL_MUTATION_AMBIGUOUS_MESSAGE}. Muat ulang daftar transaksi sebelum mencoba lagi.`,
                );
                await fetchTransactions();
                return;
            }
            setErrorMessage(error.response?.data?.message || 'Gagal cek status ke vendor');
        } finally {
            setRecheckingId(null);
        }
    };

    const toggleSelected = (id: string) => {
        setSelectedIds((current) => (
            current.includes(id)
                ? current.filter((value) => value !== id)
                : [...current, id]
        ));
    };

    const toggleSelectAllVisible = () => {
        const visibleIds = transactions.map((trx) => trx._id);
        const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.includes(id));
        setSelectedIds(allSelected ? [] : visibleIds);
    };

    const handleBulkRecheck = async () => {
        const targets = transactions.filter(
            (trx) => selectedIds.includes(trx._id) && canRecheckVendor(toPresentationInput(trx)),
        );
        if (targets.length === 0) {
            setErrorMessage('Tidak ada transaksi terpilih yang bisa di-recheck vendor.');
            return;
        }

        setBulkRechecking(true);
        setErrorMessage('');
        setSuccessMessage('');
        let ok = 0;
        let failed = 0;
        let ambiguous = 0;

        for (const trx of targets) {
            try {
                await apiV2.post(`/transactions/${trx._id}/recheck`);
                ok += 1;
            } catch (error: any) {
                if (isAmbiguousMutationFailure(error)) {
                    ambiguous += 1;
                } else {
                    failed += 1;
                }
            }
        }

        refreshSidebarBadges();
        await fetchTransactions();
        if (stuckOpen) {
            await fetchStuckTransactions();
        }

        const parts = [
            ok > 0 ? `${ok} berhasil` : null,
            failed > 0 ? `${failed} gagal` : null,
            ambiguous > 0 ? `${ambiguous} status belum pasti` : null,
        ].filter(Boolean);
        if (failed > 0 || ambiguous > 0) {
            setErrorMessage(`Bulk recheck selesai: ${parts.join(', ')}.`);
        } else {
            setSuccessMessage(`Bulk recheck selesai: ${parts.join(', ') || 'tidak ada perubahan'}.`);
        }
        setBulkRechecking(false);
    };

    const selectedRecheckableCount = useMemo(
        () => transactions.filter(
            (trx) => selectedIds.includes(trx._id) && canRecheckVendor(toPresentationInput(trx)),
        ).length,
        [selectedIds, transactions],
    );

    const allVisibleSelected = transactions.length > 0
        && transactions.every((trx) => selectedIds.includes(trx._id));

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
                .get('/transactions/admin/export', exportConfig);

            const blob = new Blob([response.data], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.setAttribute('download', `admin-transactions-${new Date().toISOString().split('T')[0]}.csv`);
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        } catch (error: any) {
            setErrorMessage(error.response?.data?.message || 'Gagal export CSV transaksi');
        } finally {
            setExporting(false);
        }
    };

    const summaryCards = [
        {
            label: 'Total Ledger',
            value: summary.total,
            helper: rangeLabel,
            accent: 'ui-text',
            border: 'ui-border'
        },
        {
            label: 'Sukses',
            value: summary.success,
            helper: 'Transaksi berhasil',
            accent: 'ui-success-text',
            border: 'ui-border'
        },
        {
            label: 'Menunggu + Proses',
            value: summary.pending + summary.processing,
            helper: `${summary.pending} pending / ${summary.processing} proses`,
            accent: 'ui-warning-text',
            border: 'ui-border'
        },
        {
            label: 'Gagal',
            value: summary.failed,
            helper: 'Perlu rekonsiliasi',
            accent: 'ui-danger-text',
            border: 'ui-border'
        },
        {
            label: 'Nominal',
            value: formatCurrency(summary.amountTotal),
            helper: 'Total nominal filter aktif',
            accent: 'ui-accent-text',
            border: 'border-[color-mix(in_srgb,var(--ui-accent)_34%,transparent)]'
        }
    ];

    const priorityTransactions = transactions
        .filter((trx) => trx.status === 'failed' || trx.status === 'processing' || trx.refunded)
        .slice(0, 4);

    const editNeedsRefund = editingTrx && editForm.status === 'failed' && !editingTrx.refunded;
    const editNeedsRecharge = editingTrx && editForm.status !== 'failed' && editingTrx.refunded;
    const editWillRevokePoints = editingTrx && editingTrx.status === 'success' && editForm.status !== 'success';
    const editWillAwardPoints = editingTrx && editingTrx.status !== 'success' && editForm.status === 'success';
    const editRequiresNote = Boolean(editNeedsRefund || editNeedsRecharge || editWillRevokePoints || editWillAwardPoints);
    const editNoteInvalid = editRequiresNote && editForm.note.trim().length < 5;
    const refundTarget = refundForm.transaction;

    return (
        <div className="space-y-6">
            <div className="ui-panel rounded-2xl border ui-border p-4 sm:p-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                        <p className="text-xs uppercase tracking-[0.18em] ui-text-muted">Meja Transaksi</p>
                        <h1 className="mt-1 text-xl font-black ui-text sm:text-2xl">
                            {mode === 'internal'
                                ? (hasActiveFilters ? 'Audit terfilter' : 'Transaksi internal')
                                : 'Digiflazz Seller'}
                        </h1>
                        <p className="mt-1 text-sm ui-text-muted">
                            {mode === 'internal'
                                ? rangeLabel
                                : (canManageSellerCallbacks
                                    ? 'Filter, export, detail raw, dan retry callback seller.'
                                    : 'Mode lihat-saja untuk transaksi seller.')}
                        </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <button
                            type="button"
                            onClick={() => {
                                setMode('internal');
                                syncUrlParams('internal', appliedFilters);
                            }}
                            className={`px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors ${
                                mode === 'internal'
                                    ? 'ui-accent-solid shadow-[0_12px_40px_var(--ui-accent-soft)]'
                                    : 'ui-muted-action border hover:border-[var(--ui-accent)]'
                            }`}
                        >
                            Transaksi Internal
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                setMode('digiflazzSeller');
                                setStuckOpen(false);
                                syncUrlParams('digiflazzSeller', appliedFilters);
                            }}
                            className={`px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors ${
                                mode === 'digiflazzSeller'
                                    ? 'ui-accent-solid shadow-[0_12px_40px_var(--ui-accent-soft)]'
                                    : 'ui-muted-action border hover:border-[var(--ui-accent)]'
                            }`}
                        >
                            Digiflazz Seller
                        </button>
                    </div>
                </div>

                {mode === 'internal' && (
                    <div className="mt-4 space-y-3">
                        <div className="flex flex-wrap gap-2">
                            {PRESET_CHIPS.map((chip) => (
                                <button
                                    key={chip.id}
                                    type="button"
                                    onClick={() => applyPreset(chip.id)}
                                    className="ui-muted-action rounded-full border px-3 py-1.5 text-xs font-semibold transition hover:border-[var(--ui-accent)]"
                                >
                                    {chip.id === 'stuck' ? (
                                        <span className="inline-flex items-center gap-1">
                                            <Timer className="h-3.5 w-3.5" /> {chip.label}
                                            {stuckTotal > 0 ? ` (${stuckTotal})` : ''}
                                        </span>
                                    ) : chip.label}
                                </button>
                            ))}
                        </div>

                        <div className="flex flex-col gap-3 rounded-2xl border ui-border bg-[var(--ui-card-muted)]/70 p-3 sm:flex-row sm:items-center sm:justify-between">
                            <div className="min-w-0">
                                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] ui-text-muted">Prioritas cepat</p>
                                <div className="mt-2 flex flex-wrap gap-2">
                                    {(priorityTransactions.length > 0 ? priorityTransactions : transactions.slice(0, 3)).map((trx) => (
                                        <button
                                            key={trx._id}
                                            type="button"
                                            onClick={() => setSelectedTrx(trx)}
                                            className="max-w-full rounded-xl border ui-border bg-[var(--ui-card-bg)]/80 px-3 py-2 text-left transition hover:border-[var(--ui-accent)]"
                                        >
                                            <div className="flex items-center gap-2">
                                                {getStatusBadge(trx.status)}
                                                <span className="truncate text-xs font-semibold ui-text">{trx.product?.name || trx.target}</span>
                                            </div>
                                            <p className="mt-1 truncate text-[11px] ui-text-muted">{trx.target} · {formatCurrency(trx.amount)}</p>
                                        </button>
                                    ))}
                                    {!loading && transactions.length === 0 && (
                                        <span className="text-xs ui-text-muted">Tidak ada transaksi pada filter aktif.</span>
                                    )}
                                </div>
                            </div>
                            <div className="flex shrink-0 flex-wrap gap-2">
                                <button
                                    type="button"
                                    onClick={() => fetchTransactions()}
                                    className="ui-muted-action inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold"
                                >
                                    <RefreshCw className="h-4 w-4" />
                                    Segarkan
                                </button>
                                <button
                                    type="button"
                                    onClick={handleExport}
                                    disabled={exporting || meta.total === 0}
                                    className="ui-accent-solid inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold disabled:opacity-60"
                                >
                                    <Download className="h-4 w-4" />
                                    {exporting ? 'CSV…' : 'CSV'}
                                </button>
                            </div>
                        </div>
                        <p className="text-[11px] leading-5 ui-text-muted">
                            CSV memakai filter yang sudah diterapkan (bukan draft filter yang belum di-Cari).
                        </p>
                    </div>
                )}
            </div>

            {mode === 'internal' ? (
                <>
                    {(errorMessage || successMessage) && (
                        <div className={`rounded-xl border px-4 py-3 text-sm ${
                            errorMessage
                                ? 'ui-danger-chip'
                                : 'ui-success-chip'
                        }`}>
                            {errorMessage || successMessage}
                        </div>
                    )}

                    {stuckOpen && (
                        <div className="ui-panel rounded-2xl border ui-border p-4 sm:p-5">
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                                <div>
                                    <p className="text-xs font-semibold uppercase tracking-[0.18em] ui-warning-text">Stuck queue</p>
                                    <h2 className="mt-1 text-lg font-bold ui-text">Pending/proses &gt; {stuckThresholdMinutes} menit</h2>
                                    <p className="mt-1 text-sm ui-text-muted">
                                        {stuckLoading ? 'Memuat…' : `${stuckTotal} transaksi melewati ambang (tampil max 50).`}
                                    </p>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    <button
                                        type="button"
                                        onClick={() => void fetchStuckTransactions()}
                                        className="ui-muted-action rounded-xl border px-3 py-2 text-sm font-semibold"
                                    >
                                        Segarkan stuck
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setStuckOpen(false)}
                                        className="ui-muted-action rounded-xl border px-3 py-2 text-sm font-semibold"
                                    >
                                        Tutup
                                    </button>
                                </div>
                            </div>
                            <div className="mt-4 space-y-2">
                                {stuckItems.map((item) => (
                                    <div
                                        key={item._id}
                                        className="flex flex-col gap-2 rounded-xl border ui-border bg-[var(--ui-card-muted)]/70 p-3 sm:flex-row sm:items-center sm:justify-between"
                                    >
                                        <div className="min-w-0">
                                            <div className="flex flex-wrap items-center gap-2">
                                                {getStatusBadge(item.status as TransactionStatus)}
                                                <span className="text-xs font-semibold ui-warning-text">{item.ageMinutes} mnt</span>
                                                <span className="truncate text-sm font-semibold ui-text">{item.product?.name || item.target}</span>
                                            </div>
                                            <p className="mt-1 truncate text-xs ui-text-muted">
                                                {item.target} · {formatCurrency(item.amount)} · {item.user?.email || '-'}
                                            </p>
                                            <p className="font-mono text-[11px] ui-text-muted break-all">{item._id}</p>
                                        </div>
                                        <div className="flex shrink-0 flex-wrap gap-2">
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    const match = transactions.find((trx) => trx._id === item._id);
                                                    if (match) setSelectedTrx(match);
                                                    else {
                                                        setFilters((current) => ({ ...current, search: item._id }));
                                                        setAppliedFilters((current) => ({ ...current, search: item._id }));
                                                        setMeta((current) => ({ ...current, page: 1 }));
                                                        syncUrlParams(mode, { ...appliedFilters, search: item._id });
                                                    }
                                                }}
                                                className="ui-muted-action rounded-lg border px-3 py-1.5 text-xs font-semibold"
                                            >
                                                Buka
                                            </button>
                                            {canEditStatus && (item.status === 'pending' || item.status === 'processing') && (
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        const asAdmin: AdminTransaction = {
                                                            _id: item._id,
                                                            target: item.target,
                                                            amount: item.amount,
                                                            status: item.status as TransactionStatus,
                                                            vendorTrxId: item.vendorTrxId,
                                                            customerRefId: item.customerRefId,
                                                            refunded: false,
                                                            source: (item.source === 'api' ? 'api' : 'web'),
                                                            createdAt: item.createdAt,
                                                            updatedAt: item.updatedAt,
                                                            user: item.user,
                                                            product: item.product
                                                                ? {
                                                                    _id: item.product._id,
                                                                    name: item.product.name,
                                                                    code: item.product.code,
                                                                    category: item.product.category,
                                                                    brand: item.product.brand,
                                                                    vendorName: item.product.vendor,
                                                                }
                                                                : undefined,
                                                        };
                                                        void handleRecheckVendor(asAdmin);
                                                    }}
                                                    disabled={recheckingId === item._id}
                                                    className="ui-info-action inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-60"
                                                    title="Cek status ke vendor"
                                                >
                                                    {recheckingId === item._id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                                                    Recheck
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                ))}
                                {!stuckLoading && stuckItems.length === 0 && (
                                    <p className="rounded-xl border ui-border p-4 text-sm ui-text-muted">Tidak ada transaksi stuck di atas ambang ini.</p>
                                )}
                            </div>
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
                            <p className="text-xs font-semibold uppercase tracking-[0.22em] ui-accent-text">Filter Ledger</p>
                            <h2 className="mt-1 text-lg font-bold ui-text">Persempit audit transaksi internal</h2>
                        </div>
                        <div className="space-y-4 p-5">
                        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
                            <input
                                placeholder="Cari ID, user, produk, target, ref vendor"
                                value={filters.search}
                                onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter') applyFilters();
                                }}
                                className={inputClass}
                                aria-label="Cari transaksi internal"
                            />
                            <select
                                value={filters.status}
                                onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}
                                className={selectClass}
                            >
                                <option value="">Semua status</option>
                                <option value="pending">Pending</option>
                                <option value="processing">Processing</option>
                                <option value="success">Success</option>
                                <option value="failed">Failed</option>
                            </select>
                            <select
                                value={filters.source}
                                onChange={(event) => setFilters((current) => ({ ...current, source: event.target.value }))}
                                className={selectClass}
                            >
                                <option value="">Semua sumber</option>
                                <option value="web">Web</option>
                                <option value="api">API</option>
                            </select>
                            <select
                                value={filters.category}
                                onChange={(event) => setFilters((current) => ({ ...current, category: event.target.value }))}
                                className={selectClass}
                            >
                                <option value="">Semua kategori</option>
                                {taxonomyCategories.map((item) => (
                                    <option key={item._id} value={item.name}>{item.name}</option>
                                ))}
                            </select>
                            <select
                                value={filters.brand}
                                onChange={(event) => setFilters((current) => ({ ...current, brand: event.target.value }))}
                                className={selectClass}
                            >
                                <option value="">Semua brand/operator</option>
                                {taxonomyBrands.map((item) => (
                                    <option key={item._id} value={item.name}>{item.name}</option>
                                ))}
                            </select>
                            <select
                                value={filters.vendor}
                                onChange={(event) => setFilters((current) => ({ ...current, vendor: event.target.value }))}
                                className={selectClass}
                            >
                                <option value="">Semua vendor</option>
                                {taxonomyVendors.map((item) => (
                                    <option key={item._id} value={item.name}>{item.name}</option>
                                ))}
                            </select>
                            <input
                                type="date"
                                value={filters.startDate}
                                max={filters.endDate || undefined}
                                onChange={(event) => setFilters((current) => ({ ...current, startDate: event.target.value }))}
                                className={inputClass}
                                aria-label="Tanggal mulai transaksi internal"
                            />
                            <input
                                type="date"
                                value={filters.endDate}
                                min={filters.startDate || undefined}
                                onChange={(event) => setFilters((current) => ({ ...current, endDate: event.target.value }))}
                                className={inputClass}
                                aria-label="Tanggal akhir transaksi internal"
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
                                className="ui-muted-action inline-flex items-center gap-2 px-4 py-2 rounded-lg border text-sm font-semibold transition-colors"
                            >
                                <RotateCcw className="w-4 h-4" />
                                Reset
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
                            <span className="rounded-full border ui-info-chip px-3 py-1 text-xs font-semibold">
                                Periode WIB
                            </span>
                            {hasUnappliedChanges && (
                                <span className="rounded-full border ui-warning-chip px-3 py-1 text-xs font-semibold">
                                    Filter belum diterapkan
                                </span>
                            )}
                            {hasInvalidRange && (
                                <span className="rounded-full border ui-danger-chip px-3 py-1 text-xs font-semibold">
                                    Tanggal mulai tidak boleh lebih besar dari tanggal akhir.
                                </span>
                            )}
                        </div>
                        </div>
                    </div>

                    <div className="ui-panel-muted rounded-3xl border ui-border overflow-hidden">
                        <div className="flex flex-col gap-3 border-b ui-border px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
                            <div>
                                <p className="text-xs font-semibold uppercase tracking-[0.22em] ui-accent-text">Internal Ledger</p>
                                <h2 className="mt-1 text-lg font-bold ui-text">Daftar transaksi member</h2>
                            </div>
                            <div className="flex flex-wrap items-center gap-2">
                                <div className="text-xs ui-text-muted">{rangeLabel}</div>
                                {selectedIds.length > 0 && (
                                    <button
                                        type="button"
                                        onClick={() => void handleBulkRecheck()}
                                        disabled={bulkRechecking || selectedRecheckableCount === 0}
                                        className="ui-info-action inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-semibold disabled:opacity-60"
                                        title="Hanya transaksi pending/proses yang eligible recheck"
                                    >
                                        {bulkRechecking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                                        Bulk recheck ({selectedRecheckableCount}/{selectedIds.length})
                                    </button>
                                )}
                            </div>
                        </div>
                        <div className="overflow-x-auto">
                            <table className="min-w-full">
                                <thead>
                                    <tr className="ui-panel ui-text-muted text-xs uppercase">
                                        <th className="px-3 py-3 text-left font-semibold">
                                            <input
                                                type="checkbox"
                                                checked={allVisibleSelected}
                                                onChange={toggleSelectAllVisible}
                                                aria-label="Pilih semua di halaman ini"
                                            />
                                        </th>
                                        <th className="px-4 py-3 text-left font-semibold">Referensi</th>
                                        <th className="px-4 py-3 text-left font-semibold">Member</th>
                                        <th className="px-4 py-3 text-left font-semibold">Produk</th>
                                        <th className="px-4 py-3 text-left font-semibold">Nominal</th>
                                        <th className="px-4 py-3 text-left font-semibold">Sumber</th>
                                        <th className="px-4 py-3 text-left font-semibold">Tujuan</th>
                                        <th className="px-4 py-3 text-left font-semibold">Status</th>
                                        <th className="px-4 py-3 text-right font-semibold">Aksi</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-[var(--ui-border)]">
                                    {loading ? (
                                        <tr>
                                            <td colSpan={9} className="px-4 py-8 text-center ui-text-muted">
                                                <span className="inline-flex items-center gap-2">
                                                    <Loader2 className="w-4 h-4 animate-spin" />
                                                    Memuat data transaksi...
                                                </span>
                                            </td>
                                        </tr>
                                    ) : transactions.length === 0 ? (
                                        <tr>
                                            <td colSpan={9} className="px-4 py-8 text-center ui-text-muted">
                                                Tidak ada transaksi yang cocok dengan filter saat ini.
                                            </td>
                                        </tr>
                                    ) : (
                                        transactions.map((trx) => (
                                            <tr key={trx._id} className="hover:bg-[var(--ui-card-bg)]">
                                                <td className="px-3 py-3 align-top">
                                                    <input
                                                        type="checkbox"
                                                        checked={selectedIds.includes(trx._id)}
                                                        onChange={() => toggleSelected(trx._id)}
                                                        aria-label={`Pilih ${trx._id}`}
                                                    />
                                                </td>
                                                <td className="px-4 py-3 align-top text-sm ui-text">
                                                    <div className="font-semibold ui-info-text">{trx.referenceId || '-'}</div>
                                                    <div className="text-[11px] ui-text-muted">Ref vendor: {trx.vendorTrxId || '-'}</div>
                                                    <div className="text-xs ui-text-muted font-mono break-all">{trx._id}</div>
                                                    {trx.customerRefId && (
                                                        <div className="text-[11px] ui-accent-text">
                                                            Ref pelanggan: {trx.customerRefId}
                                                        </div>
                                                    )}
                                                </td>
                                                <td className="px-4 py-3 align-top text-sm ui-text">
                                                    <div className="font-semibold">{trx.user?.name || '-'}</div>
                                                    <div className="text-xs ui-info-text break-all">{trx.user?.email || '-'}</div>
                                                    {trx.user?._id && (
                                                        <Link
                                                            to={`/admin/users?q=${encodeURIComponent(trx.user.email || trx.user._id)}`}
                                                            className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold ui-accent-text hover:underline"
                                                        >
                                                            Buka user <ExternalLink className="h-3 w-3" />
                                                        </Link>
                                                    )}
                                                </td>
                                                <td className="px-4 py-3 align-top text-sm ui-text">
                                                    <div className="font-semibold">{trx.product?.name || '-'}</div>
                                                    <div className="text-xs ui-text-muted">
                                                        {trx.product?.code || '-'} • {trx.product?.category || '-'}
                                                    </div>
                                                    <div className="text-[11px] ui-text-muted">
                                                        {trx.product?.brand || '-'} / {trx.product?.vendorName || '-'}
                                                    </div>
                                                    {trx.product?._id && (
                                                        <Link
                                                            to={`/admin/products?q=${encodeURIComponent(trx.product.code || trx.product.name || trx.product._id)}`}
                                                            className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold ui-accent-text hover:underline"
                                                        >
                                                            Buka produk <ExternalLink className="h-3 w-3" />
                                                        </Link>
                                                    )}
                                                </td>
                                                <td className="px-4 py-3 align-top text-sm ui-text">
                                                    <div className="font-semibold">{formatCurrency(trx.amount)}</div>
                                                    <div className={`text-xs ${trx.refunded ? 'ui-success-text' : 'ui-text-muted'}`}>
                                                        {trx.refunded ? 'Sudah refund saldo' : 'Belum refund'}
                                                    </div>
                                                    {trx.sn && (
                                                        <div className="text-xs ui-success-text break-all mt-1">
                                                            SN: {trx.sn}
                                                        </div>
                                                    )}
                                                </td>
                                                <td className="px-4 py-3 align-top text-sm ui-text-muted">
                                                    <div>{getSourceLabel(trx.source)}</div>
                                                    <div className="text-xs ui-text-muted">{trx.product?.vendorName || '-'}</div>
                                                </td>
                                                <td className="px-4 py-3 align-top text-sm ui-text">
                                                    <div>{trx.target}</div>
                                                    <div className="text-xs ui-text-muted">{formatDateTime(trx.createdAt)}</div>
                                                </td>
                                                <td className="px-4 py-3 align-top text-sm ui-text">
                                                    {getStatusBadge(trx.status)}
                                                    <div className="mt-2 text-xs ui-text-muted">
                                                        Manual: {trx.statusUpdatedAt ? formatDateTime(trx.statusUpdatedAt) : '-'}
                                                    </div>
                                                    <div className="text-[11px] ui-text-muted">
                                                        {trx.statusUpdatedBy?.name || 'Belum ada audit'}
                                                    </div>
                                                </td>
                                                <td className="px-4 py-3 align-top text-right">
                                                    <div className="inline-flex items-center gap-2">
                                                        <button
                                                            onClick={() => setSelectedTrx(trx)}
                                                            className="ui-accent-chip px-2 py-1 rounded"
                                                            title="Lihat detail"
                                                        >
                                                            <Eye className="w-4 h-4" />
                                                        </button>
                                                        {canEditStatus && (
                                                            <>
                                                                <button
                                                                    onClick={() => openEditModal(trx)}
                                                                    className="ui-info-action relative px-2 py-1 rounded"
                                                                    title="Edit status (step-up)"
                                                                >
                                                                    <Edit className="w-4 h-4" />
                                                                    <ShieldAlert className="absolute -right-1 -top-1 h-3 w-3 ui-warning-text" />
                                                                </button>
                                                                {!trx.refunded && trx.status !== 'success' && (
                                                                    <button
                                                                        onClick={() => openRefundModal(trx)}
                                                                        className="ui-warning-action relative px-2 py-1 rounded"
                                                                        title="Refund saldo (step-up)"
                                                                    >
                                                                        <RotateCcw className="w-4 h-4" />
                                                                        <ShieldAlert className="absolute -right-1 -top-1 h-3 w-3 ui-warning-text" />
                                                                    </button>
                                                                )}
                                                                {canRecheckVendor(toPresentationInput(trx)) && (
                                                                    <button
                                                                        onClick={() => handleRecheckVendor(trx)}
                                                                        disabled={recheckingId === trx._id}
                                                                        className="ui-muted-action px-2 py-1 rounded disabled:opacity-60"
                                                                        title="Cek status vendor"
                                                                    >
                                                                        {recheckingId === trx._id ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                                                                    </button>
                                                                )}
                                                            </>
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

                            <div className="relative w-full max-w-4xl ui-panel border ui-border rounded-2xl overflow-hidden animate-slide-up max-h-[90vh] overflow-y-auto">
                                <div className="flex items-center justify-between px-6 py-4 border-b ui-border">
                                    <div>
                                        <p className="text-xs ui-text-muted">Detail Transaksi</p>
                                        <p className="text-lg font-semibold ui-text">{selectedTrx.product?.name || '-'}</p>
                                    </div>
                                    <button
                                        onClick={() => setSelectedTrx(null)}
                                        className="w-9 h-9 rounded-full ui-panel-muted flex items-center justify-center ui-text-muted hover:text-[var(--ui-text)] hover:bg-[var(--ui-card-bg)] transition-colors"
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
                                        <div className="ui-panel-muted border ui-border rounded-xl p-3 flex items-start justify-between gap-3">
                                            <div>
                                                <p className="text-xs ui-text-muted">Internal ID</p>
                                                <p className="text-sm ui-text font-mono break-all">{selectedTrx._id}</p>
                                            </div>
                                            <button
                                                onClick={() => copyToClipboard(selectedTrx._id, 'internal-id')}
                                                className="p-2 hover:bg-[var(--ui-card-bg)] rounded-lg ui-text-muted"
                                            >
                                                {copied === 'internal-id' ? <CheckCircle className="w-4 h-4 ui-success-text" /> : <Copy className="w-4 h-4" />}
                                            </button>
                                        </div>

                                        <div className="ui-panel-muted border ui-border rounded-xl p-3 flex items-start justify-between gap-3">
                                            <div>
                                                <p className="text-xs ui-text-muted">Vendor Trx ID</p>
                                                <p className="text-sm ui-text font-mono break-all">{selectedTrx.vendorTrxId || '-'}</p>
                                            </div>
                                            {selectedTrx.vendorTrxId && (
                                                <button
                                                    onClick={() => copyToClipboard(selectedTrx.vendorTrxId!, 'vendor-id')}
                                                    className="p-2 hover:bg-[var(--ui-card-bg)] rounded-lg ui-text-muted"
                                                >
                                                    {copied === 'vendor-id' ? <CheckCircle className="w-4 h-4 ui-success-text" /> : <Copy className="w-4 h-4" />}
                                                </button>
                                            )}
                                        </div>

                                        <div className="ui-panel-muted border ui-border rounded-xl p-3 flex items-start justify-between gap-3">
                                            <div>
                                                <p className="text-xs ui-text-muted">Customer Ref ID</p>
                                                <p className="text-sm ui-text font-mono break-all">{selectedTrx.customerRefId || '-'}</p>
                                            </div>
                                            {selectedTrx.customerRefId && (
                                                <button
                                                    onClick={() => copyToClipboard(selectedTrx.customerRefId!, 'customer-ref')}
                                                    className="p-2 hover:bg-[var(--ui-card-bg)] rounded-lg ui-text-muted"
                                                >
                                                    {copied === 'customer-ref' ? <CheckCircle className="w-4 h-4 ui-success-text" /> : <Copy className="w-4 h-4" />}
                                                </button>
                                            )}
                                        </div>

                                        <div className="ui-panel-muted border ui-border rounded-xl p-3">
                                            <p className="text-xs ui-text-muted">Sumber</p>
                                            <p className="text-sm ui-text">{getSourceLabel(selectedTrx.source)}</p>
                                            <p className="text-xs ui-text-muted mt-1">Vendor: {selectedTrx.product?.vendorName || '-'}</p>
                                        </div>

                                        <div className="ui-panel-muted border ui-border rounded-xl p-3 md:col-span-2">
                                            <p className="text-xs ui-text-muted">Produk</p>
                                            <p className="text-sm ui-text font-semibold">{selectedTrx.product?.name || '-'}</p>
                                            <p className="text-xs ui-text-muted">
                                                {selectedTrx.product?.code || '-'} • {selectedTrx.product?.category || '-'} • {selectedTrx.product?.brand || '-'}
                                            </p>
                                            {selectedTrx.product?._id && (
                                                <Link
                                                    to={`/admin/products?q=${encodeURIComponent(selectedTrx.product.code || selectedTrx.product.name || selectedTrx.product._id)}`}
                                                    className="mt-2 inline-flex items-center gap-1 text-xs font-semibold ui-accent-text hover:underline"
                                                >
                                                    Buka produk <ExternalLink className="h-3.5 w-3.5" />
                                                </Link>
                                            )}
                                        </div>

                                        <div className="ui-panel-muted border ui-border rounded-xl p-3 flex items-start justify-between gap-3">
                                            <div>
                                                <p className="text-xs ui-text-muted">Target</p>
                                                <p className="text-sm ui-text break-all">{selectedTrx.target}</p>
                                            </div>
                                            <button
                                                onClick={() => copyToClipboard(selectedTrx.target, 'target')}
                                                className="p-2 hover:bg-[var(--ui-card-bg)] rounded-lg ui-text-muted"
                                            >
                                                {copied === 'target' ? <CheckCircle className="w-4 h-4 ui-success-text" /> : <Copy className="w-4 h-4" />}
                                            </button>
                                        </div>

                                        <div className="ui-panel-muted border ui-border rounded-xl p-3">
                                            <p className="text-xs ui-text-muted">Member</p>
                                            <p className="text-sm ui-text font-semibold">{selectedTrx.user?.name || '-'}</p>
                                            <p className="text-xs ui-info-text break-all">{selectedTrx.user?.email || '-'}</p>
                                            {selectedTrx.user?._id && (
                                                <Link
                                                    to={`/admin/users?q=${encodeURIComponent(selectedTrx.user.email || selectedTrx.user._id)}`}
                                                    className="mt-2 inline-flex items-center gap-1 text-xs font-semibold ui-accent-text hover:underline"
                                                >
                                                    Buka user <ExternalLink className="h-3.5 w-3.5" />
                                                </Link>
                                            )}
                                        </div>

                                        <div className="ui-panel-muted border ui-border rounded-xl p-3">
                                            <p className="text-xs ui-text-muted">Nominal</p>
                                            <p className="text-lg ui-accent-text font-bold">{formatCurrency(selectedTrx.amount)}</p>
                                            {selectedTrx.baseAmount && selectedTrx.baseAmount > selectedTrx.amount ? (
                                                <p className="text-xs ui-text-muted mt-1">
                                                    Sebelum promo {formatCurrency(selectedTrx.baseAmount)}
                                                </p>
                                            ) : null}
                                            {selectedTrx.discountAmount ? (
                                                <p className="text-xs ui-success-text mt-1">
                                                    Diskon {formatCurrency(selectedTrx.discountAmount)}
                                                    {selectedTrx.discountVoucherCode ? ` · ${selectedTrx.discountVoucherCode}` : ''}
                                                </p>
                                            ) : null}
                                            {selectedTrx.flashSale ? (
                                                <p className="text-xs ui-warning-text mt-1">Flash sale aktif</p>
                                            ) : null}
                                            <p className={`text-xs mt-1 ${selectedTrx.refunded ? 'ui-success-text' : 'ui-text-muted'}`}>
                                                {transactionBalanceCopy(toPresentationInput(selectedTrx))}
                                            </p>
                                            {selectedTrx.refundedAt && (
                                                <p className="text-xs ui-text-muted mt-1">{formatDateTime(selectedTrx.refundedAt)}</p>
                                            )}
                                        </div>

                                        {selectedTrx.refundReason && (
                                            <div className="ui-panel-muted border ui-border rounded-xl p-3 md:col-span-2">
                                                <p className="text-xs ui-text-muted">Alasan Refund</p>
                                                <p className="text-sm ui-text whitespace-pre-wrap">{selectedTrx.refundReason}</p>
                                            </div>
                                        )}

                                        <div className="ui-panel-muted border ui-border rounded-xl p-3">
                                            <p className="text-xs ui-text-muted">SN / Token</p>
                                            <p className="text-sm ui-text break-all font-mono">{selectedTrx.sn || '-'}</p>
                                        </div>

                                        <div className="ui-panel-muted border ui-border rounded-xl p-3 md:col-span-2">
                                            <p className="text-xs ui-text-muted">Vendor Message</p>
                                            <p className="text-sm ui-text whitespace-pre-wrap">{selectedTrx.message || '-'}</p>
                                        </div>

                                        <div className="ui-panel-muted border ui-border rounded-xl p-3 md:col-span-2">
                                            <p className="text-xs ui-text-muted">Catatan Admin</p>
                                            <p className="text-sm ui-text whitespace-pre-wrap">{selectedTrx.statusUpdateNote || '-'}</p>
                                        </div>

                                        <div className="ui-panel-muted border ui-border rounded-xl p-3">
                                            <p className="text-xs ui-text-muted">Dibuat</p>
                                            <p className="text-sm ui-text">{formatDateTime(selectedTrx.createdAt)}</p>
                                        </div>
                                        <div className="ui-panel-muted border ui-border rounded-xl p-3">
                                            <p className="text-xs ui-text-muted">Diperbarui</p>
                                            <p className="text-sm ui-text">{formatDateTime(selectedTrx.updatedAt)}</p>
                                        </div>
                                        <div className="ui-panel-muted border ui-border rounded-xl p-3">
                                            <p className="text-xs ui-text-muted">Update Manual</p>
                                            <p className="text-sm ui-text">{formatDateTime(selectedTrx.statusUpdatedAt)}</p>
                                        </div>
                                        <div className="ui-panel-muted border ui-border rounded-xl p-3">
                                            <p className="text-xs ui-text-muted">Diproses Oleh</p>
                                            <p className="text-sm ui-text">{selectedTrx.statusUpdatedBy?.name || '-'}</p>
                                            <p className="text-xs ui-text-muted">{selectedTrx.statusUpdatedBy?.email || selectedTrx.statusUpdatedBy?.role || '-'}</p>
                                        </div>

                                        <div className="ui-panel-muted border ui-border rounded-xl p-3 md:col-span-2">
                                            <p className="text-xs ui-text-muted">Timeline status (dari field transaksi)</p>
                                            <div className="mt-3 space-y-2">
                                                {buildTimeline(selectedTrx).map((event) => (
                                                    <div key={`${event.label}-${event.at}`} className="flex gap-3">
                                                        <div className={`mt-1 h-2 w-2 shrink-0 rounded-full ${event.tone.includes('success') ? 'bg-emerald-400' : event.tone.includes('warning') ? 'bg-amber-400' : 'bg-sky-400'}`} />
                                                        <div className="min-w-0">
                                                            <p className={`text-sm font-semibold ${event.tone}`}>{event.label}</p>
                                                            <p className="text-xs ui-text-muted">{formatDateTime(event.at)}</p>
                                                            {event.detail && <p className="mt-0.5 text-xs ui-text-muted whitespace-pre-wrap">{event.detail}</p>}
                                                        </div>
                                                    </div>
                                                ))}
                                                {buildTimeline(selectedTrx).length === 0 && (
                                                    <p className="text-sm ui-text-muted">Belum ada jejak status.</p>
                                                )}
                                            </div>
                                            <p className="mt-3 text-[11px] ui-text-muted">
                                                Riwayat penuh audit log belum digabung di sini — ini ringkasan dari field transaksi.
                                            </p>
                                        </div>
                                    </div>
                                </div>

                                <div className="px-6 py-4 border-t ui-border flex flex-wrap justify-end gap-3">
                                    {canEditStatus && (
                                        <button
                                            onClick={() => openEditModal(selectedTrx)}
                                            className="ui-info-action inline-flex items-center gap-2 rounded-lg px-4 py-2 font-semibold"
                                            title="Memerlukan step-up"
                                        >
                                            <Edit className="w-4 h-4" /> Edit status
                                            <span className="rounded-full border px-2 py-0.5 text-[10px] font-bold ui-warning-chip">step-up</span>
                                        </button>
                                    )}
                                    {canEditStatus && !selectedTrx.refunded && selectedTrx.status !== 'success' && (
                                        <button
                                            onClick={() => openRefundModal(selectedTrx)}
                                            className="ui-warning-action inline-flex items-center gap-2 rounded-lg px-4 py-2 font-semibold transition-colors"
                                            title="Memerlukan step-up"
                                        >
                                            <RotateCcw className="w-4 h-4" /> Refund Saldo
                                            <span className="rounded-full border px-2 py-0.5 text-[10px] font-bold ui-warning-chip">step-up</span>
                                        </button>
                                    )}
                                    {canEditStatus && canRecheckVendor(toPresentationInput(selectedTrx)) && (
                                        <button
                                            onClick={() => handleRecheckVendor(selectedTrx)}
                                            disabled={recheckingId === selectedTrx._id}
                                            className="ui-info-action inline-flex items-center gap-2 rounded-lg px-4 py-2 font-semibold transition-colors disabled:opacity-60"
                                        >
                                            {recheckingId === selectedTrx._id ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                                            Cek Vendor
                                        </button>
                                    )}
                                    <button
                                        onClick={() => setSelectedTrx(null)}
                                        className="px-4 py-2 ui-accent-solid rounded-lg font-semibold transition-colors"
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

                            <div className="relative w-full max-w-xl ui-panel border ui-border rounded-2xl overflow-hidden animate-slide-up">
                                <div className="flex items-center justify-between px-6 py-4 border-b ui-border">
                                    <div>
                                        <p className="text-xs ui-text-muted">Edit Status Transaksi</p>
                                        <p className="text-lg font-semibold ui-text">{editingTrx.product?.name || '-'}</p>
                                    </div>
                                    <button
                                        onClick={closeEditModal}
                                        className="w-9 h-9 rounded-full ui-panel-muted flex items-center justify-center ui-text-muted hover:text-[var(--ui-text)] hover:bg-[var(--ui-card-bg)] transition-colors"
                                    >
                                        <X className="w-5 h-5" />
                                    </button>
                                </div>

                                <div className="p-6 space-y-4">
                                    <div className="ui-panel-muted border ui-border rounded-xl p-3">
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

                                    {(editNeedsRefund || editNeedsRecharge || editWillRevokePoints || editWillAwardPoints) && (
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
                                                    {editWillAwardPoints && (
                                                        <p>Status dipindah ke <strong>success</strong>. Reward poin dapat diberikan jika transaksi eligible.</p>
                                                    )}
                                                    {editRequiresNote && (
                                                        <p>Catatan minimal 5 karakter wajib diisi untuk perubahan berisiko.</p>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </div>

                                <div className="px-6 py-4 border-t ui-border flex gap-3 justify-end">
                                    <button
                                        onClick={closeEditModal}
                                        className="px-4 py-2 border ui-border ui-text-muted rounded-lg font-semibold hover:bg-[var(--ui-card-bg)] transition-colors"
                                    >
                                        Batal
                                    </button>
                                    <button
                                        onClick={handleSaveStatus}
                                        disabled={saving || editForm.note.length > 500 || editNoteInvalid}
                                        className="px-4 py-2 ui-accent-solid rounded-lg font-semibold transition-colors disabled:opacity-60 inline-flex items-center gap-2"
                                    >
                                        {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                                        {saving ? 'Menyimpan...' : 'Simpan'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {refundTarget && (
                        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                            <div
                                className="absolute inset-0 bg-black/60 backdrop-blur-sm"
                                onClick={closeRefundModal}
                            />

                            <div className="relative w-full max-w-lg ui-panel border ui-border rounded-2xl overflow-hidden animate-slide-up">
                                <div className="flex items-center justify-between px-6 py-4 border-b ui-border">
                                    <div>
                                        <p className="text-xs ui-text-muted">Refund Saldo Transaksi</p>
                                        <p className="text-lg font-semibold ui-text">{refundTarget.product?.name || '-'}</p>
                                    </div>
                                    <button
                                        onClick={closeRefundModal}
                                        className="w-9 h-9 rounded-full ui-panel-muted flex items-center justify-center ui-text-muted hover:text-[var(--ui-text)] hover:bg-[var(--ui-card-bg)] transition-colors"
                                    >
                                        <X className="w-5 h-5" />
                                    </button>
                                </div>

                                <div className="p-6 space-y-4">
                                    <div className="rounded-xl border p-4 text-sm ui-warning-chip space-y-2">
                                        <div className="flex items-start gap-2">
                                            <AlertTriangle className="w-4 h-4 mt-0.5 ui-warning-text" />
                                            <div>
                                                <p className="font-semibold">Saldo akan dikembalikan ke member dan status transaksi menjadi failed.</p>
                                                <p className="mt-1">Nominal refund: <strong>{formatCurrency(refundTarget.amount)}</strong></p>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="ui-panel-muted border ui-border rounded-xl p-3">
                                        <p className="text-xs ui-text-muted mb-1">Internal ID</p>
                                        <p className="text-sm ui-text font-mono break-all">{refundTarget._id}</p>
                                    </div>

                                    <div>
                                        <label className="block text-sm font-medium ui-text-muted mb-2">Alasan Refund</label>
                                        <textarea
                                            value={refundForm.reason}
                                            onChange={(event) => setRefundForm((current) => ({ ...current, reason: event.target.value }))}
                                            placeholder="Tulis alasan refund saldo"
                                            rows={4}
                                            className={`${inputClass} min-h-[110px]`}
                                        />
                                        <div className="mt-2 text-xs ui-text-muted text-right">
                                            {refundForm.reason.length}/300
                                        </div>
                                    </div>
                                </div>

                                <div className="px-6 py-4 border-t ui-border flex gap-3 justify-end">
                                    <button
                                        onClick={closeRefundModal}
                                        className="px-4 py-2 border ui-border ui-text-muted rounded-lg font-semibold hover:bg-[var(--ui-card-bg)] transition-colors"
                                    >
                                        Batal
                                    </button>
                                    <button
                                        onClick={handleRefund}
                                        disabled={refunding || refundForm.reason.trim().length < 5 || refundForm.reason.length > 300}
                                        className="px-4 py-2 ui-warning-action rounded-lg font-semibold transition-colors disabled:opacity-60 inline-flex items-center gap-2"
                                    >
                                        {refunding && <Loader2 className="w-4 h-4 animate-spin" />}
                                        {refunding ? 'Memproses...' : 'Refund Saldo'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
</>
            ) : (
                <DigiflazzSellerTransactionsPanel
                    canManageCallbacks={canManageSellerCallbacks}
                    initialFilters={{ callback: sellerInitialCallbackFilter }}
                />
            )}
            {stepUp.dialog}
        </div>
    );
}
