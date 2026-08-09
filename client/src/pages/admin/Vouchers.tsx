import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { apiV2 } from '../../api';
import BalanceGiveawayPanel from './BalanceGiveawayPanel';
import {
    AlertTriangle,
    Archive,
    Check,
    CheckCircle,
    Copy,
    Download,
    Gift,
    Loader2,
    Plus,
    RotateCcw,
    Search,
    Ticket,
    Undo2
} from 'lucide-react';

type VoucherStatusFilter = '' | 'available' | 'redeemed' | 'archived';

interface VoucherRecord {
    _id: string;
    code: string;
    amount: number;
    kind?: string;
    discountType?: string;
    discountValue?: number;
    maxUses?: number;
    usedCount?: number;
    minPurchase?: number;
    maxDiscount?: number;
    onePerUser?: boolean;
    isRedeemed: boolean;
    isArchived: boolean;
    redeemedAt?: string;
    redeemedBalanceBefore?: number;
    redeemedBalanceAfter?: number;
    archiveReason?: string;
    archivedAt?: string;
    createdAt: string;
    updatedAt: string;
    redeemedBy?: {
        name?: string;
        email?: string;
        role?: string;
    };
    createdBy?: {
        name?: string;
        email?: string;
        role?: string;
    };
    archivedBy?: {
        name?: string;
        email?: string;
        role?: string;
    };
}

interface VoucherListResponse {
    items: VoucherRecord[];
    meta: {
        page: number;
        limit: number;
        total: number;
        totalPages: number;
    };
    summary: {
        total: number;
        totalAmount: number;
        available: number;
        redeemed: number;
        archived: number;
    };
}

type FilterState = {
    search: string;
    status: VoucherStatusFilter;
    startDate: string;
    endDate: string;
    minAmount: string;
    maxAmount: string;
};

const defaultFilters: FilterState = {
    search: '',
    status: '',
    startDate: '',
    endDate: '',
    minAmount: '',
    maxAmount: ''
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

const getAgeLabel = (createdAt?: string) => {
    if (!createdAt) return '';
    const ageMs = Date.now() - new Date(createdAt).getTime();
    if (!Number.isFinite(ageMs) || ageMs < 0) return '';
    const minutes = Math.floor(ageMs / 60000);
    if (minutes < 60) return `${Math.max(1, minutes)} mnt lalu`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours} jam lalu`;
    const days = Math.floor(hours / 24);
    return `${days} hari lalu`;
};

const isIdleActive = (voucher: VoucherRecord) => {
    if (voucher.isArchived || voucher.isRedeemed) return false;
    const ageMs = Date.now() - new Date(voucher.createdAt).getTime();
    return Number.isFinite(ageMs) && ageMs >= 30 * 86400000;
};

const isDiscountVoucher = (voucher: VoucherRecord) =>
    (voucher.kind || 'balance') === 'discount';

const getVoucherBadge = (voucher: VoucherRecord) => {
    const badges: ReactNode[] = [];
    if (isDiscountVoucher(voucher)) {
        badges.push(
            <span key="kind" className="ui-info-chip rounded-full border px-2 py-1 text-xs font-semibold">Diskon</span>
        );
        const maxUses = voucher.maxUses ?? 0;
        const used = voucher.usedCount ?? 0;
        const remaining = Math.max(0, maxUses - used);
        if (voucher.isArchived) {
            badges.push(<span key="st" className="rounded-full ui-panel px-2 py-1 text-xs font-semibold ui-text-muted">Arsip</span>);
        } else if (remaining <= 0 || voucher.isRedeemed) {
            badges.push(<span key="st" className="ui-danger-chip rounded-full border px-2 py-1 text-xs font-semibold">Slot habis</span>);
        } else {
            badges.push(
                <span key="st" className="ui-accent-chip rounded-full px-2 py-1 text-xs font-semibold">
                    {used}/{maxUses} slot
                </span>
            );
        }
        return <>{badges}</>;
    }

    if (voucher.isArchived) {
        return <span className="rounded-full ui-panel px-2 py-1 text-xs font-semibold ui-text-muted">Arsip</span>;
    }

    if (voucher.isRedeemed) {
        return <span className="ui-success-chip rounded-full border px-2 py-1 text-xs font-semibold">Redeemed</span>;
    }

    if (isIdleActive(voucher)) {
        return <span className="ui-warning-chip rounded-full border px-2 py-1 text-xs font-semibold" title="Aktif tapi belum ditukar >30 hari">Perlu dibagikan</span>;
    }

    return <span className="ui-accent-chip rounded-full px-2 py-1 text-xs font-semibold">Siap pakai</span>;
};

export default function AdminVouchers() {
    const [vouchers, setVouchers] = useState<VoucherRecord[]>([]);
    const [summary, setSummary] = useState<VoucherListResponse['summary']>({
        total: 0,
        totalAmount: 0,
        available: 0,
        redeemed: 0,
        archived: 0
    });
    const [meta, setMeta] = useState<VoucherListResponse['meta']>({
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 1
    });
    const [filters, setFilters] = useState<FilterState>(defaultFilters);
    const [appliedFilters, setAppliedFilters] = useState<FilterState>(defaultFilters);
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [actioningId, setActioningId] = useState<string | null>(null);
    const [amount, setAmount] = useState('');
    const [quantity, setQuantity] = useState('1');
    const [customCode, setCustomCode] = useState('');
    const [codePrefix, setCodePrefix] = useState('');
    const [voucherKind, setVoucherKind] = useState<'balance' | 'discount'>('balance');
    const [discountType, setDiscountType] = useState<'fixed' | 'percentage'>('fixed');
    const [discountValue, setDiscountValue] = useState('5000');
    const [maxUses, setMaxUses] = useState('10');
    const [minPurchase, setMinPurchase] = useState('0');
    const [maxDiscount, setMaxDiscount] = useState('0');
    const [onePerUser, setOnePerUser] = useState(true);
    const [listKind, setListKind] = useState<'balance' | 'discount' | 'all'>('balance');
    const [categoryOptions, setCategoryOptions] = useState<Array<{ _id: string; name: string }>>([]);
    const [operatorOptions, setOperatorOptions] = useState<Array<{ _id: string; name: string }>>([]);
    const [scopeCategoryIds, setScopeCategoryIds] = useState<string[]>([]);
    const [scopeOperatorIds, setScopeOperatorIds] = useState<string[]>([]);
    const [copiedId, setCopiedId] = useState<string | null>(null);
    const [createdCodes, setCreatedCodes] = useState<string[]>([]);
    const [createdCount, setCreatedCount] = useState(0);
    const [exporting, setExporting] = useState(false);
    const [activeTab, setActiveTab] = useState<'codes' | 'giveaway'>('codes');
    const [confirmation, setConfirmation] = useState<{
        type: 'archive' | 'restore';
        voucher: VoucherRecord;
    } | null>(null);
    const [errorMessage, setErrorMessage] = useState('');
    const [successMessage, setSuccessMessage] = useState('');
    const latestRequestId = useRef(0);

    const inputClass = 'w-full rounded-xl border px-3 py-2.5 text-sm ui-field';
    const selectClass = 'w-full rounded-xl border px-3 py-2.5 text-sm ui-field';

    const fetchVouchers = useCallback(async (options?: { page?: number; limit?: number; filters?: FilterState }) => {
        const requestId = latestRequestId.current + 1;
        latestRequestId.current = requestId;
        setLoading(true);
        setErrorMessage('');

        const requestPage = options?.page ?? meta.page;
        const requestLimit = options?.limit ?? meta.limit;
        const requestFilters = options?.filters ?? appliedFilters;

        try {
            const params = {
                page: requestPage,
                limit: requestLimit,
                kind: listKind,
                ...Object.fromEntries(
                    Object.entries(requestFilters).filter(([, value]) => value)
                )
            };
            const response = await apiV2
                .get<VoucherListResponse>('/vouchers', { params });

            if (requestId !== latestRequestId.current) return;
            setVouchers(response.data.items || []);
            setSummary(response.data.summary);
            const nextMeta = response.data.meta;
            if (nextMeta.page > Math.max(nextMeta.totalPages, 1)) {
                setMeta((current) => ({ ...current, page: Math.max(nextMeta.totalPages, 1) }));
            } else {
                setMeta(nextMeta);
            }
        } catch (error: any) {
            if (requestId !== latestRequestId.current) return;
            setErrorMessage(error.response?.data?.message || 'Gagal memuat voucher');
        } finally {
            if (requestId === latestRequestId.current) {
                setLoading(false);
            }
        }
    }, [appliedFilters, meta.limit, meta.page, listKind]);

    useEffect(() => {
        fetchVouchers();
    }, [fetchVouchers]);

    useEffect(() => {
        // Taxonomy for discount scope multi-selects.
        void Promise.all([
            apiV2.get('/categories/admin/all').catch(() => ({ data: [] })),
            apiV2.get('/operators/admin/all').catch(() => ({ data: [] })),
        ]).then(([cats, ops]) => {
            setCategoryOptions((cats.data || []).map((c: any) => ({ _id: c._id, name: c.name })));
            setOperatorOptions((ops.data || []).map((o: any) => ({ _id: o._id, name: o.name })));
        });
    }, []);

    useEffect(() => {
        const handler = () => fetchVouchers();
        window.addEventListener('admin:refresh-current-page', handler);
        return () => window.removeEventListener('admin:refresh-current-page', handler);
    }, [fetchVouchers]);

    const rangeLabel = useMemo(() => {
        if (meta.total === 0) {
            return '0 data';
        }

        const start = (meta.page - 1) * meta.limit + 1;
        const end = Math.min(meta.page * meta.limit, meta.total);
        return `${start}-${end} dari ${meta.total} voucher`;
    }, [meta]);

    const handleCreate = async (event: React.FormEvent) => {
        event.preventDefault();
        setSubmitting(true);
        setErrorMessage('');
        setSuccessMessage('');
        setCreatedCodes([]);

        try {
            const payload =
                voucherKind === 'discount'
                    ? {
                        kind: 'discount',
                        code: customCode || undefined,
                        prefix: codePrefix.trim() || undefined,
                        discountType,
                        discountValue: Number(discountValue),
                        maxUses: Number(maxUses),
                        minPurchase: Number(minPurchase) || 0,
                        maxDiscount: Number(maxDiscount) || 0,
                        onePerUser,
                        categoryIds: scopeCategoryIds,
                        operatorIds: scopeOperatorIds,
                    }
                    : {
                        kind: 'balance',
                        amount: Number(amount),
                        quantity: customCode ? 1 : Number(quantity),
                        code: customCode || undefined,
                        prefix: codePrefix.trim() || undefined,
                    };
            const response = await apiV2
                .post('/vouchers', payload);

            const items = response.data?.items || [];
            setAmount('');
            setQuantity('1');
            setCustomCode('');
            setCodePrefix('');
            setCreatedCodes(items.map((item: VoucherRecord) => item.code));
            setCreatedCount(items.length);
            setSuccessMessage(response.data?.message || 'Voucher berhasil dibuat');
            setMeta((current) => ({ ...current, page: 1 }));
            setAppliedFilters(defaultFilters);
            setFilters(defaultFilters);
            await fetchVouchers({ page: 1, filters: defaultFilters });
        } catch (error: any) {
            setErrorMessage(error.response?.data?.message || 'Gagal membuat voucher');
        } finally {
            setSubmitting(false);
        }
    };

    const handleArchive = async (voucher: VoucherRecord) => {
        setActioningId(voucher._id);
        setErrorMessage('');
        setSuccessMessage('');

        try {
            const response = await apiV2
                .delete(`/vouchers/${voucher._id}`);
            setSuccessMessage(response.data?.message || 'Voucher berhasil diarsipkan');
            setConfirmation(null);
            await fetchVouchers();
        } catch (error: any) {
            setErrorMessage(error.response?.data?.message || 'Gagal mengarsipkan voucher');
        } finally {
            setActioningId(null);
        }
    };

    const handleRestore = async (voucher: VoucherRecord) => {
        setActioningId(voucher._id);
        setErrorMessage('');
        setSuccessMessage('');

        try {
            const response = await apiV2
                .patch(`/vouchers/${voucher._id}/restore`);
            setSuccessMessage(response.data?.message || 'Voucher berhasil diaktifkan kembali');
            setConfirmation(null);
            await fetchVouchers();
        } catch (error: any) {
            setErrorMessage(error.response?.data?.message || 'Gagal memulihkan voucher');
        } finally {
            setActioningId(null);
        }
    };

    const copyToClipboard = async (code: string, id: string) => {
        try {
            await navigator.clipboard.writeText(code);
            setCopiedId(id);
            window.setTimeout(() => setCopiedId(null), 1800);
        } catch {
            setErrorMessage('Gagal menyalin kode voucher');
        }
    };

    const applyFilters = () => {
        if (filters.startDate && filters.endDate && filters.startDate > filters.endDate) {
            setErrorMessage('Tanggal mulai tidak boleh lebih besar dari tanggal akhir.');
            setSuccessMessage('');
            return;
        }
        if (filters.minAmount && filters.maxAmount && Number(filters.minAmount) > Number(filters.maxAmount)) {
            setErrorMessage('Nominal minimum tidak boleh lebih besar dari maksimum.');
            setSuccessMessage('');
            return;
        }
        setErrorMessage('');
        setAppliedFilters({ ...filters });
        setMeta((current) => ({ ...current, page: 1 }));
        setSuccessMessage('');
    };

    const applyPreset = (preset: 'active-today' | 'new-7d') => {
        const today = new Date();
        const toInput = (d: Date) => d.toISOString().slice(0, 10);
        let next: FilterState;
        if (preset === 'active-today') {
            next = { ...defaultFilters, status: 'available', startDate: toInput(today), endDate: toInput(today) };
        } else {
            const weekAgo = new Date(today.getTime() - 6 * 86400000);
            next = { ...defaultFilters, startDate: toInput(weekAgo), endDate: toInput(today) };
        }
        setFilters(next);
        setAppliedFilters(next);
        setMeta((current) => ({ ...current, page: 1 }));
        setErrorMessage('');
    };

    const copyAllCreated = async () => {
        if (createdCodes.length === 0) return;
        try {
            await navigator.clipboard.writeText(createdCodes.join('\n'));
            setCopiedId('all-created');
            window.setTimeout(() => setCopiedId(null), 1800);
        } catch {
            setErrorMessage('Gagal menyalin semua kode');
        }
    };

    const handleExport = async () => {
        setExporting(true);
        setErrorMessage('');
        try {
            const params = Object.fromEntries(
                Object.entries(appliedFilters).filter(([, value]) => value)
            );
            const response = await apiV2.get('/vouchers/export', { params, responseType: 'blob' });
            const blob = new Blob([response.data], { type: 'text/csv;charset=utf-8;' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.setAttribute('download', `vouchers-${new Date().toISOString().split('T')[0]}.csv`);
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        } catch (error: any) {
            setErrorMessage(error.response?.data?.message || 'Gagal export CSV voucher');
        } finally {
            setExporting(false);
        }
    };

    const resetFilters = () => {
        setFilters(defaultFilters);
        setAppliedFilters(defaultFilters);
        setMeta((current) => ({ ...current, page: 1 }));
        setSuccessMessage('');
    };

    return (
        <div className="space-y-6">
            <div className="border-b ui-border">
                <nav className="flex gap-4" role="tablist" aria-label="Voucher dan bagikan saldo">
                    <button
                        type="button"
                        role="tab"
                        aria-selected={activeTab === 'codes'}
                        onClick={() => setActiveTab('codes')}
                        className={`inline-flex items-center gap-2 border-b-2 px-1 pb-3 text-sm font-medium transition-colors ${
                            activeTab === 'codes'
                                ? 'border-[var(--ui-accent)] ui-accent-text'
                                : 'border-transparent ui-text-muted hover:text-[var(--ui-text)]'
                        }`}
                    >
                        <Ticket className="h-4 w-4" />
                        Kode Voucher
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={activeTab === 'giveaway'}
                        onClick={() => setActiveTab('giveaway')}
                        className={`inline-flex items-center gap-2 border-b-2 px-1 pb-3 text-sm font-medium transition-colors ${
                            activeTab === 'giveaway'
                                ? 'border-[var(--ui-accent)] ui-accent-text'
                                : 'border-transparent ui-text-muted hover:text-[var(--ui-text)]'
                        }`}
                    >
                        <Gift className="h-4 w-4" />
                        Bagikan Saldo Random
                    </button>
                </nav>
            </div>

            {activeTab === 'giveaway' ? <BalanceGiveawayPanel /> : null}

            {activeTab === 'codes' ? (
            <>
            {(errorMessage || successMessage) && (
                <div className="space-y-3">
                    {errorMessage && (
                        <div className="ui-danger-chip flex items-start gap-3 rounded-2xl border px-4 py-3 text-sm">
                            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                            <span>{errorMessage}</span>
                        </div>
                    )}
                    {successMessage && (
                        <div className="ui-success-chip flex items-start gap-3 rounded-2xl border px-4 py-3 text-sm">
                            <CheckCircle className="mt-0.5 h-4 w-4 shrink-0" />
                            <span>{successMessage}</span>
                        </div>
                    )}
                </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-2xl border ui-border ui-panel-muted p-4">
                    <p className="text-xs uppercase tracking-[0.18em] ui-text-muted">Total Voucher</p>
                    <p className="mt-3 text-3xl font-bold ui-text">{summary.total}</p>
                    <p className="mt-2 text-xs ui-text-muted">Total nominal tersimpan {formatCurrency(summary.totalAmount)}.</p>
                </div>
                <div className="rounded-2xl border ui-border ui-panel-muted p-4">
                    <p className="text-xs uppercase tracking-[0.18em] ui-text-muted">Aktif</p>
                    <p className="mt-3 text-3xl font-bold ui-text">{summary.available}</p>
                    <p className="mt-2 text-xs ui-accent-text">Siap diredeem user.</p>
                </div>
                <div className="rounded-2xl border ui-border ui-panel-muted p-4">
                    <p className="text-xs uppercase tracking-[0.18em] ui-text-muted">Redeemed</p>
                    <p className="mt-3 text-3xl font-bold ui-text">{summary.redeemed}</p>
                    <p className="mt-2 text-xs ui-success-text">Sudah menambah saldo user.</p>
                </div>
                <div className="rounded-2xl border ui-border ui-panel-muted p-4">
                    <p className="text-xs uppercase tracking-[0.18em] ui-text-muted">Arsip</p>
                    <p className="mt-3 text-3xl font-bold ui-text">{summary.archived}</p>
                    <p className="mt-2 text-xs ui-text-muted">Tidak bisa diredeem lagi.</p>
                </div>
            </div>

            <div className="grid gap-6 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
                <div className="rounded-2xl border ui-border ui-panel-muted p-6">
                    <div className="mb-5">
                        <h2 className="text-lg font-semibold ui-text">Buat Voucher</h2>
                        <p className="mt-1 text-sm ui-text-muted">
                            Custom code untuk campaign khusus, atau generate batch untuk kompensasi massal.
                        </p>
                    </div>

                    <form onSubmit={handleCreate} className="space-y-4">
                        <div className="flex flex-wrap gap-2">
                            <button type="button" onClick={() => setVoucherKind('balance')} className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${voucherKind === 'balance' ? 'ui-accent-chip' : 'ui-muted-action'}`}>Saldo</button>
                            <button type="button" onClick={() => setVoucherKind('discount')} className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${voucherKind === 'discount' ? 'ui-accent-chip' : 'ui-muted-action'}`}>Diskon checkout</button>
                        </div>

                        {voucherKind === 'balance' ? (
                        <>
                        <label className="block space-y-2">
                            <span className="text-sm font-medium ui-text">Nominal Voucher</span>
                            <input
                                type="number"
                                min="1"
                                required
                                value={amount}
                                onChange={(event) => setAmount(event.target.value)}
                                className={inputClass}
                                placeholder="Contoh: 10000"
                            />
                        </label>

                        <label className="block space-y-2">
                            <span className="text-sm font-medium ui-text">Jumlah Voucher</span>
                            <input
                                type="number"
                                min="1"
                                max="200"
                                value={quantity}
                                onChange={(event) => setQuantity(event.target.value)}
                                disabled={Boolean(customCode)}
                                className={`${inputClass} disabled:cursor-not-allowed disabled:opacity-60`}
                                placeholder="Contoh: 10"
                            />
                        </label>
                        </>
                        ) : (
                        <>
                        <div className="grid grid-cols-2 gap-3">
                            <label className="block space-y-2">
                                <span className="text-sm font-medium ui-text">Tipe diskon</span>
                                <select value={discountType} onChange={(e) => setDiscountType(e.target.value as 'fixed' | 'percentage')} className={selectClass}>
                                    <option value="fixed">Potongan Rp</option>
                                    <option value="percentage">Persen %</option>
                                </select>
                            </label>
                            <label className="block space-y-2">
                                <span className="text-sm font-medium ui-text">{discountType === 'percentage' ? 'Persen' : 'Nominal potong'}</span>
                                <input type="number" min="1" value={discountValue} onChange={(e) => setDiscountValue(e.target.value)} className={inputClass} />
                            </label>
                            <label className="block space-y-2">
                                <span className="text-sm font-medium ui-text">Slot (max uses)</span>
                                <input type="number" min="1" max="10000" value={maxUses} onChange={(e) => setMaxUses(e.target.value)} className={inputClass} />
                            </label>
                            <label className="block space-y-2">
                                <span className="text-sm font-medium ui-text">Min belanja</span>
                                <input type="number" min="0" value={minPurchase} onChange={(e) => setMinPurchase(e.target.value)} className={inputClass} />
                            </label>
                            <label className="block space-y-2">
                                <span className="text-sm font-medium ui-text">Max diskon (0=∞)</span>
                                <input type="number" min="0" value={maxDiscount} onChange={(e) => setMaxDiscount(e.target.value)} className={inputClass} />
                            </label>
                            <label className="flex items-center gap-2 pt-6 text-sm ui-text">
                                <input type="checkbox" checked={onePerUser} onChange={(e) => setOnePerUser(e.target.checked)} className="h-4 w-4" />
                                1x per user
                            </label>
                        </div>
                        <div className="space-y-2">
                            <p className="text-sm font-medium ui-text">Scope kategori (opsional)</p>
                            <select
                                multiple
                                value={scopeCategoryIds}
                                onChange={(e) => setScopeCategoryIds(Array.from(e.target.selectedOptions).map((o) => o.value))}
                                className={`${selectClass} min-h-[88px]`}
                            >
                                {categoryOptions.map((c) => (
                                    <option key={c._id} value={c._id}>{c.name}</option>
                                ))}
                            </select>
                            <p className="text-xs ui-text-muted">Kosong = semua kategori. Ctrl/Cmd+klik untuk multi.</p>
                        </div>
                        <div className="space-y-2">
                            <p className="text-sm font-medium ui-text">Scope operator (opsional)</p>
                            <select
                                multiple
                                value={scopeOperatorIds}
                                onChange={(e) => setScopeOperatorIds(Array.from(e.target.selectedOptions).map((o) => o.value))}
                                className={`${selectClass} min-h-[88px]`}
                            >
                                {operatorOptions.map((o) => (
                                    <option key={o._id} value={o._id}>{o.name}</option>
                                ))}
                            </select>
                        </div>
                        </>
                        )}

                        <label className="block space-y-2">
                            <span className="text-sm font-medium ui-text">Prefix Kode (opsional)</span>
                            <input
                                type="text"
                                value={codePrefix}
                                onChange={(event) => setCodePrefix(event.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 20))}
                                disabled={Boolean(customCode)}
                                className={`${inputClass} disabled:cursor-not-allowed disabled:opacity-60`}
                                placeholder="Contoh: PROMO-"
                            />
                            <p className="text-xs ui-text-muted">
                                Hanya untuk generate batch. Contoh hasil: <span className="font-mono">{codePrefix || 'PROMO-'}A1B2C3D4E5</span>
                            </p>
                        </label>

                        <label className="block space-y-2">
                            <span className="text-sm font-medium ui-text">Custom Code</span>
                            <input
                                type="text"
                                value={customCode}
                                onChange={(event) => setCustomCode(event.target.value.toUpperCase())}
                                className={inputClass}
                                placeholder="Contoh: PROMO2026"
                            />
                            <p className="text-xs ui-text-muted">
                                Format: huruf besar, angka, `_` atau `-`, minimal 4 karakter. Mengisi custom code menonaktifkan qty & prefix.
                            </p>
                        </label>

                        {Number(amount) > 0 ? (
                            <div className="rounded-xl border ui-border ui-panel px-3 py-2.5 text-sm">
                                <p className="ui-text-muted">Total nilai batch</p>
                                <p className="mt-0.5 font-bold ui-accent-text">
                                    {formatCurrency(Number(amount))} × {customCode ? 1 : Math.max(1, Number(quantity) || 1)} ={' '}
                                    {formatCurrency(Number(amount) * (customCode ? 1 : Math.max(1, Number(quantity) || 1)))}
                                </p>
                            </div>
                        ) : null}

                        <button
                            type="submit"
                            disabled={submitting || (voucherKind === 'balance' ? !amount : !discountValue)}
                            className="inline-flex w-full items-center justify-center gap-2 rounded-xl ui-accent-solid px-4 py-3 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                            {submitting ? 'Membuat Voucher...' : 'Buat Voucher'}
                        </button>
                    </form>

                    {createdCodes.length > 0 && (
                        <div className="ui-success-chip mt-5 rounded-2xl border p-4">
                            <div className="flex items-center justify-between gap-2">
                                <p className="text-sm font-semibold">
                                    Kode terbaru ({createdCount || createdCodes.length})
                                </p>
                                <button
                                    type="button"
                                    onClick={copyAllCreated}
                                    className="inline-flex items-center gap-1.5 rounded-full ui-panel px-3 py-1 text-xs font-semibold ui-text transition hover:bg-[var(--ui-card-muted)]"
                                >
                                    {copiedId === 'all-created' ? <Check className="h-3.5 w-3.5 ui-success-text" /> : <Copy className="h-3.5 w-3.5" />}
                                    Salin semua
                                </button>
                            </div>
                            <div className="mt-3 flex max-h-40 flex-wrap gap-2 overflow-y-auto">
                                {createdCodes.map((code) => (
                                    <button
                                        key={code}
                                        type="button"
                                        onClick={() => copyToClipboard(code, `new-${code}`)}
                                        className="inline-flex items-center gap-2 rounded-full ui-panel px-3 py-1.5 text-xs font-semibold ui-text transition hover:bg-[var(--ui-card-muted)]"
                                    >
                                        <span className="font-mono">{code}</span>
                                        {copiedId === `new-${code}` ? <Check className="h-3.5 w-3.5 ui-success-text" /> : <Copy className="h-3.5 w-3.5" />}
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                </div>

                <div className="rounded-2xl border ui-border ui-panel-muted">
                    <div className="border-b ui-border px-5 py-4">
                        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                            <div>
                                <h2 className="text-lg font-semibold ui-text">Daftar Voucher</h2>
                                <p className="text-xs ui-text-muted">{rangeLabel}</p>
                            </div>
                            <div className="text-xs ui-text-muted">
                                Filter membantu memisahkan voucher aktif, redeemed, dan arsip.
                            </div>
                        </div>
                    </div>

                    <div className="grid gap-4 border-b ui-border px-5 py-5 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
                        <label className="space-y-2">
                            <span className="text-xs font-semibold uppercase tracking-[0.16em] ui-text-muted">Cari</span>
                            <div className="relative">
                                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 ui-text-muted" />
                                <input
                                    value={filters.search}
                                    onChange={(event) => setFilters((current) => ({ ...current, search: event.target.value }))}
                                    className={`${inputClass} pl-10`}
                                    placeholder="Kode atau email user..."
                                />
                            </div>
                        </label>

                        <label className="space-y-2">
                            <span className="text-xs font-semibold uppercase tracking-[0.16em] ui-text-muted">Jenis</span>
                            <select
                                value={listKind}
                                onChange={(event) => {
                                    setListKind(event.target.value as 'balance' | 'discount' | 'all');
                                    setMeta((current) => ({ ...current, page: 1 }));
                                }}
                                className={selectClass}
                            >
                                <option value="balance">Saldo</option>
                                <option value="discount">Diskon</option>
                                <option value="all">Semua</option>
                            </select>
                        </label>

                        <label className="space-y-2">
                            <span className="text-xs font-semibold uppercase tracking-[0.16em] ui-text-muted">Status</span>
                            <select
                                value={filters.status}
                                onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value as VoucherStatusFilter }))}
                                className={selectClass}
                            >
                                <option value="">Semua Status</option>
                                <option value="available">Aktif</option>
                                <option value="redeemed">Redeemed</option>
                                <option value="archived">Arsip</option>
                            </select>
                        </label>

                        <label className="space-y-2">
                            <span className="text-xs font-semibold uppercase tracking-[0.16em] ui-text-muted">Nominal Min</span>
                            <input
                                type="number"
                                min="0"
                                value={filters.minAmount}
                                onChange={(event) => setFilters((current) => ({ ...current, minAmount: event.target.value }))}
                                className={inputClass}
                                placeholder="0"
                            />
                        </label>

                        <label className="space-y-2">
                            <span className="text-xs font-semibold uppercase tracking-[0.16em] ui-text-muted">Nominal Max</span>
                            <input
                                type="number"
                                min="0"
                                value={filters.maxAmount}
                                onChange={(event) => setFilters((current) => ({ ...current, maxAmount: event.target.value }))}
                                className={inputClass}
                                placeholder="100000"
                            />
                        </label>

                        <label className="space-y-2">
                            <span className="text-xs font-semibold uppercase tracking-[0.16em] ui-text-muted">Dari Tanggal</span>
                            <input
                                type="date"
                                value={filters.startDate}
                                onChange={(event) => setFilters((current) => ({ ...current, startDate: event.target.value }))}
                                className={inputClass}
                            />
                        </label>

                        <label className="space-y-2">
                            <span className="text-xs font-semibold uppercase tracking-[0.16em] ui-text-muted">Sampai Tanggal</span>
                            <input
                                type="date"
                                value={filters.endDate}
                                onChange={(event) => setFilters((current) => ({ ...current, endDate: event.target.value }))}
                                className={inputClass}
                            />
                        </label>
                    </div>

                    <div className="flex flex-col gap-3 border-b ui-border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                        <div className="flex flex-wrap items-center gap-2">
                            <button
                                type="button"
                                onClick={() => applyPreset('active-today')}
                                className="inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold ui-muted-action transition"
                            >
                                Aktif hari ini
                            </button>
                            <button
                                type="button"
                                onClick={() => applyPreset('new-7d')}
                                className="inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold ui-muted-action transition"
                            >
                                Baru 7 hari
                            </button>
                            <button
                                type="button"
                                onClick={resetFilters}
                                className="inline-flex items-center gap-2 rounded-xl border px-4 py-2 text-sm font-semibold ui-muted-action transition"
                            >
                                <RotateCcw className="h-4 w-4" />
                                Reset
                            </button>
                            <button
                                type="button"
                                onClick={applyFilters}
                                className="inline-flex items-center gap-2 rounded-xl ui-accent-solid px-4 py-2 text-sm font-semibold transition"
                            >
                                <Search className="h-4 w-4" />
                                Terapkan
                            </button>
                            <button
                                type="button"
                                onClick={handleExport}
                                disabled={exporting || summary.total === 0}
                                className="inline-flex items-center gap-2 rounded-xl border px-4 py-2 text-sm font-semibold ui-muted-action transition disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {exporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                                Export CSV
                            </button>
                        </div>
                        <select
                            value={meta.limit}
                            onChange={(event) => setMeta((current) => ({
                                ...current,
                                page: 1,
                                limit: Number(event.target.value)
                            }))}
                            className="rounded-xl border px-3 py-2 text-sm ui-field"
                        >
                            <option value={20}>20 / halaman</option>
                            <option value={50}>50 / halaman</option>
                            <option value={100}>100 / halaman</option>
                        </select>
                    </div>

                    {loading ? (
                        <div className="flex items-center justify-center px-6 py-14">
                            <Loader2 className="h-8 w-8 animate-spin ui-accent-text" />
                        </div>
                    ) : vouchers.length === 0 ? (
                        <div className="px-6 py-14 text-center">
                            <Ticket className="mx-auto h-10 w-10 ui-text-muted" />
                            <p className="mt-3 text-lg font-semibold ui-text">Belum ada voucher pada filter ini</p>
                            <p className="mt-1 text-sm ui-text-muted">Coba ubah status atau kata kunci pencarian.</p>
                        </div>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="min-w-full divide-y ui-border">
                                <thead className="ui-panel">
                                    <tr>
                                        <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.16em] ui-text-muted">Kode</th>
                                        <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.16em] ui-text-muted">Nominal</th>
                                        <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.16em] ui-text-muted">Status</th>
                                        <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.16em] ui-text-muted">Redeem / Arsip</th>
                                        <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-[0.16em] ui-text-muted">Dibuat</th>
                                        <th className="px-4 py-3 text-right text-xs font-semibold uppercase tracking-[0.16em] ui-text-muted">Aksi</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y ui-border">
                                    {vouchers.map((voucher) => (
                                        <tr key={voucher._id} className="hover:bg-[var(--ui-card-bg)]">
                                            <td className="px-4 py-4 align-top">
                                                <div className="flex items-center gap-2">
                                                    <span className="font-mono font-semibold ui-text">{voucher.code}</span>
                                                    <button
                                                        type="button"
                                                        onClick={() => copyToClipboard(voucher.code, voucher._id)}
                                                        className="ui-text-muted transition hover:text-[var(--ui-text)]"
                                                        title="Salin kode"
                                                    >
                                                        {copiedId === voucher._id ? <Check className="h-4 w-4 ui-success-text" /> : <Copy className="h-4 w-4" />}
                                                    </button>
                                                </div>
                                                <div className="mt-2 text-xs ui-text-muted">{formatDateTime(voucher.updatedAt)}</div>
                                            </td>
                                            <td className="px-4 py-4 align-top text-sm ui-text">
                                                {isDiscountVoucher(voucher) ? (
                                                    <div className="space-y-1">
                                                        <div className="font-semibold ui-accent-text">
                                                            {voucher.discountType === 'percentage'
                                                                ? `${voucher.discountValue ?? 0}%`
                                                                : formatCurrency(voucher.discountValue || 0)}
                                                            <span className="ml-1 text-xs font-medium ui-text-muted">
                                                                {voucher.discountType === 'percentage' ? 'diskon' : 'potong'}
                                                            </span>
                                                        </div>
                                                        <div className="text-xs ui-text-muted">
                                                            Slot {(voucher.usedCount ?? 0)}/{voucher.maxUses ?? 0}
                                                            {(voucher.minPurchase || 0) > 0 ? ` · min ${formatCurrency(voucher.minPurchase || 0)}` : ''}
                                                            {(voucher.maxDiscount || 0) > 0 ? ` · max ${formatCurrency(voucher.maxDiscount || 0)}` : ''}
                                                        </div>
                                                        {voucher.onePerUser !== false ? (
                                                            <div className="text-[11px] ui-text-muted">1× per user</div>
                                                        ) : null}
                                                    </div>
                                                ) : (
                                                    <>
                                                        <div className="font-semibold ui-text">{formatCurrency(voucher.amount)}</div>
                                                        {voucher.redeemedBalanceAfter !== undefined && (
                                                            <div className="mt-2 text-xs ui-success-text">
                                                                Balance user: {formatCurrency(voucher.redeemedBalanceBefore || 0)} → {formatCurrency(voucher.redeemedBalanceAfter)}
                                                            </div>
                                                        )}
                                                    </>
                                                )}
                                            </td>
                                            <td className="px-4 py-4 align-top">
                                                <div className="flex flex-wrap gap-2">
                                                    {getVoucherBadge(voucher)}
                                                </div>
                                            </td>
                                            <td className="px-4 py-4 align-top text-sm ui-text">
                                                {voucher.isRedeemed ? (
                                                    <div className="space-y-1">
                                                        <div className="font-medium ui-text">{voucher.redeemedBy?.name || voucher.redeemedBy?.email || '-'}</div>
                                                        <div className="text-xs ui-text-muted">{formatDateTime(voucher.redeemedAt)}</div>
                                                    </div>
                                                ) : voucher.isArchived ? (
                                                    <div className="space-y-1">
                                                        <div className="font-medium ui-text">{voucher.archivedBy?.name || '-'}</div>
                                                        <div className="text-xs ui-text-muted">{formatDateTime(voucher.archivedAt)}</div>
                                                        <div className="text-xs ui-text-muted">{voucher.archiveReason || '-'}</div>
                                                    </div>
                                                ) : (
                                                    <span className="text-xs ui-text-muted">Belum diredeem</span>
                                                )}
                                            </td>
                                            <td className="px-4 py-4 align-top text-sm ui-text">
                                                <div className="space-y-1">
                                                    <div className="font-medium ui-text">{voucher.createdBy?.name || '-'}</div>
                                                    <div className="text-xs ui-text-muted">{formatDateTime(voucher.createdAt)}</div>
                                                    {getAgeLabel(voucher.createdAt) ? (
                                                        <div className="text-[11px] ui-text-muted">{getAgeLabel(voucher.createdAt)}</div>
                                                    ) : null}
                                                </div>
                                            </td>
                                            <td className="px-4 py-4 align-top">
                                                <div className="flex justify-end gap-2">
                                                    {!voucher.isArchived ? (
                                                        <button
                                                            type="button"
                                                            onClick={() => setConfirmation({ type: 'archive', voucher })}
                                                            disabled={actioningId === voucher._id}
                                                            className="ui-danger-action inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-60"
                                                        >
                                                            {actioningId === voucher._id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Archive className="h-3.5 w-3.5" />}
                                                            Arsipkan
                                                        </button>
                                                    ) : (
                                                        <button
                                                            type="button"
                                                            onClick={() => setConfirmation({ type: 'restore', voucher })}
                                                            disabled={actioningId === voucher._id || voucher.isRedeemed}
                                                            className="inline-flex items-center gap-2 rounded-lg ui-muted-action px-3 py-2 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40"
                                                        >
                                                            {actioningId === voucher._id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Undo2 className="h-3.5 w-3.5" />}
                                                            Pulihkan
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
                                className="rounded-lg border px-3 py-2 text-xs font-semibold ui-muted-action transition disabled:cursor-not-allowed disabled:opacity-40"
                            >
                                Prev
                            </button>
                            <div className="rounded-lg border ui-border ui-panel px-3 py-2 text-xs ui-text">
                                Halaman {meta.page} / {Math.max(meta.totalPages, 1)}
                            </div>
                            <button
                                type="button"
                                disabled={meta.page >= meta.totalPages || loading}
                                onClick={() => setMeta((current) => ({ ...current, page: Math.min(current.totalPages, current.page + 1) }))}
                                className="rounded-lg border px-3 py-2 text-xs font-semibold ui-muted-action transition disabled:cursor-not-allowed disabled:opacity-40"
                            >
                                Next
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            {activeTab === 'codes' && confirmation && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
                    <div className="w-full max-w-md rounded-2xl border ui-border ui-panel p-6 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="voucher-confirm-title">
                        <div className="mb-4 flex items-start gap-3">
                            <div className="rounded-full ui-warning-chip p-2">
                                <AlertTriangle className="h-5 w-5" />
                            </div>
                            <div>
                                <h3 id="voucher-confirm-title" className="text-lg font-semibold ui-text">
                                    {confirmation.type === 'archive' ? 'Arsipkan Voucher?' : 'Pulihkan Voucher?'}
                                </h3>
                                <p className="mt-1 text-sm ui-text-muted">
                                    Kode <span className="font-mono font-semibold ui-text">{confirmation.voucher.code}</span> bernominal{' '}
                                    <span className="font-semibold ui-text">{formatCurrency(confirmation.voucher.amount)}</span>.
                                </p>
                            </div>
                        </div>
                        <p className="mb-6 text-sm ui-text-muted">
                            {confirmation.type === 'archive'
                                ? confirmation.voucher.isRedeemed
                                    ? 'Voucher ini sudah diredeem. Arsipkan hanya untuk menjaga histori audit.'
                                    : 'Voucher aktif yang diarsipkan tidak bisa diredeem user.'
                                : 'Voucher arsip akan aktif kembali dan bisa diredeem user.'}
                        </p>
                        <div className="flex gap-3">
                            <button
                                type="button"
                                onClick={() => setConfirmation(null)}
                                disabled={Boolean(actioningId)}
                                className="flex-1 rounded-xl border px-4 py-2.5 text-sm font-semibold ui-muted-action disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                Batal
                            </button>
                            <button
                                type="button"
                                onClick={() => confirmation.type === 'archive' ? handleArchive(confirmation.voucher) : handleRestore(confirmation.voucher)}
                                disabled={Boolean(actioningId)}
                                className={`${confirmation.type === 'archive' ? 'ui-danger-action border' : 'ui-accent-solid'} flex-1 rounded-xl px-4 py-2.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50`}
                            >
                                {actioningId ? 'Memproses...' : confirmation.type === 'archive' ? 'Arsipkan' : 'Pulihkan'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
            </>
            ) : null}
        </div>
    );
}
