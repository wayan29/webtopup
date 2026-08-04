import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiV2 } from '../../api';
import {
    AlertTriangle,
    Archive,
    Check,
    CheckCircle,
    Copy,
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
};

const defaultFilters: FilterState = {
    search: '',
    status: '',
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

const getVoucherBadge = (voucher: VoucherRecord) => {
    if (voucher.isArchived) {
        return <span className="rounded-full ui-panel px-2 py-1 text-xs font-semibold ui-text-muted">Arsip</span>;
    }

    if (voucher.isRedeemed) {
        return <span className="ui-success-chip rounded-full border px-2 py-1 text-xs font-semibold">Redeemed</span>;
    }

    return <span className="ui-accent-chip rounded-full px-2 py-1 text-xs font-semibold">Aktif</span>;
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
    const [copiedId, setCopiedId] = useState<string | null>(null);
    const [createdCodes, setCreatedCodes] = useState<string[]>([]);
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
    }, [appliedFilters, meta.limit, meta.page]);

    useEffect(() => {
        fetchVouchers();
    }, [fetchVouchers]);

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
            const payload = {
                amount: Number(amount),
                quantity: customCode ? 1 : Number(quantity),
                code: customCode || undefined
            };
            const response = await apiV2
                .post('/vouchers', payload);

            const items = response.data?.items || [];
            setAmount('');
            setQuantity('1');
            setCustomCode('');
            setCreatedCodes(items.map((item: VoucherRecord) => item.code).slice(0, 8));
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
        setErrorMessage('');
        setAppliedFilters({ ...filters });
        setMeta((current) => ({ ...current, page: 1 }));
        setSuccessMessage('');
    };

    const resetFilters = () => {
        setFilters(defaultFilters);
        setAppliedFilters(defaultFilters);
        setMeta((current) => ({ ...current, page: 1 }));
        setSuccessMessage('');
    };

    return (
        <div className="space-y-6">

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
                                Format: huruf besar, angka, `_` atau `-`, minimal 4 karakter.
                            </p>
                        </label>

                        <button
                            type="submit"
                            disabled={submitting || !amount}
                            className="inline-flex w-full items-center justify-center gap-2 rounded-xl ui-accent-solid px-4 py-3 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                            {submitting ? 'Membuat Voucher...' : 'Buat Voucher'}
                        </button>
                    </form>

                    {createdCodes.length > 0 && (
                        <div className="ui-success-chip mt-5 rounded-2xl border p-4">
                            <p className="text-sm font-semibold">Kode terbaru</p>
                            <div className="mt-3 flex flex-wrap gap-2">
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

                    <div className="grid gap-4 border-b ui-border px-5 py-5 md:grid-cols-2 xl:grid-cols-4">
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
                                                <div className="font-semibold ui-text">{formatCurrency(voucher.amount)}</div>
                                                {voucher.redeemedBalanceAfter !== undefined && (
                                                    <div className="mt-2 text-xs ui-success-text">
                                                        Balance user: {formatCurrency(voucher.redeemedBalanceBefore || 0)} → {formatCurrency(voucher.redeemedBalanceAfter)}
                                                    </div>
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

            {confirmation && (
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
        </div>
    );
}
