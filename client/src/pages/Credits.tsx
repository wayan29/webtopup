import { useEffect, useEffectEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiV2 } from '../api';
import {
    ArrowRight,
    Coins,
    Download,
    Gift,
    Loader2,
    RefreshCw,
    Receipt,
    Sparkles,
    Star
} from 'lucide-react';

type CreditFilterType = 'all' | 'earn' | 'redeem' | 'admin_adjustment';

interface PointHistoryItem {
    _id: string;
    type: 'earn' | 'redeem' | 'admin_adjustment';
    points: number;
    description: string;
    createdAt: string;
    relatedReward?: {
        _id?: string;
        name?: string;
    } | null;
    relatedTransaction?: {
        _id?: string;
        amount?: number;
        target?: string;
        status?: string;
        product?: {
            _id?: string;
            name?: string;
        } | null;
    } | null;
}

interface PointsSummary {
    currentPoints: number;
    totalEarned: number;
    totalRedeemed: number;
    activityCount: number;
    lastActivityAt: string | null;
}

interface PointsMeta {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    type: CreditFilterType;
}

interface PointsHistoryResponse {
    currentPoints?: number;
    pointValueRate?: number;
    pointsPerTransaction?: number;
    estimatedValue?: number;
    items?: PointHistoryItem[];
    history?: PointHistoryItem[];
    summary?: Partial<PointsSummary>;
    meta?: Partial<PointsMeta>;
}

const typeLabels: Record<PointHistoryItem['type'], string> = {
    earn: 'Masuk',
    redeem: 'Redeem',
    admin_adjustment: 'Adjustment'
};

const typeBadgeClasses: Record<PointHistoryItem['type'], string> = {
    earn: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20',
    redeem: 'bg-orange-500/15 text-orange-300 border-orange-500/20',
    admin_adjustment: 'bg-sky-500/15 text-sky-300 border-sky-500/20'
};

const formatPointDelta = (points: number) => `${points > 0 ? '+' : ''}${points.toLocaleString('id-ID')} poin`;

const buildFallbackSummary = (
    items: PointHistoryItem[],
    currentPoints: number,
    totalCount: number
): PointsSummary => ({
    currentPoints,
    totalEarned: items
        .filter((item) => item.type === 'earn')
        .reduce((sum, item) => sum + Math.abs(item.points), 0),
    totalRedeemed: items
        .filter((item) => item.type === 'redeem')
        .reduce((sum, item) => sum + Math.abs(item.points), 0),
    activityCount: totalCount,
    lastActivityAt: items[0]?.createdAt || null
});

export default function Credits() {
    const [items, setItems] = useState<PointHistoryItem[]>([]);
    const [summary, setSummary] = useState<PointsSummary>({
        currentPoints: 0,
        totalEarned: 0,
        totalRedeemed: 0,
        activityCount: 0,
        lastActivityAt: null
    });
    const [meta, setMeta] = useState<PointsMeta>({
        page: 1,
        limit: 10,
        total: 0,
        totalPages: 1,
        type: 'all'
    });
    const [filterType, setFilterType] = useState<CreditFilterType>('all');
    const [pointValueRate, setPointValueRate] = useState(1);
    const [pointsPerTransaction, setPointsPerTransaction] = useState(100);
    const [compatibilityNotice, setCompatibilityNotice] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const loadCredits = useEffectEvent(async (mode: 'initial' | 'refresh' = 'initial') => {
        if (mode === 'initial') {
            setLoading(true);
        } else {
            setRefreshing(true);
        }

        try {
            const params = new URLSearchParams({
                page: String(meta.page),
                limit: String(meta.limit)
            });

            if (filterType !== 'all') {
                params.set('type', filterType);
            }

            const path = `/points/history?${params.toString()}`;
            const response = await apiV2
                .get<PointsHistoryResponse>(path);
            const payload = response.data || {};
            const historyItems = Array.isArray(payload.items)
                ? payload.items
                : Array.isArray(payload.history)
                    ? payload.history
                    : [];
            const currentPoints = Number(payload.currentPoints ?? 0);
            const resolvedRate = Math.max(1, Number(payload.pointValueRate ?? 1) || 1);
            const resolvedPointsPerTransaction = Math.max(1, Number(payload.pointsPerTransaction ?? 100) || 100);
            const resolvedMeta: PointsMeta = {
                page: Number(payload.meta?.page ?? meta.page ?? 1),
                limit: Number(payload.meta?.limit ?? meta.limit ?? 10),
                total: Number(payload.meta?.total ?? historyItems.length),
                totalPages: Math.max(1, Number(payload.meta?.totalPages ?? 1)),
                type: (payload.meta?.type as CreditFilterType) || filterType
            };

            setItems(historyItems);
            setPointValueRate(resolvedRate);
            setPointsPerTransaction(resolvedPointsPerTransaction);
            setMeta(resolvedMeta);
            setSummary(
                payload.summary
                    ? {
                        currentPoints: Number(payload.summary.currentPoints ?? currentPoints),
                        totalEarned: Number(payload.summary.totalEarned ?? 0),
                        totalRedeemed: Number(payload.summary.totalRedeemed ?? 0),
                        activityCount: Number(payload.summary.activityCount ?? resolvedMeta.total),
                        lastActivityAt: payload.summary.lastActivityAt ?? historyItems[0]?.createdAt ?? null
                    }
                    : buildFallbackSummary(historyItems, currentPoints, resolvedMeta.total)
            );
            setCompatibilityNotice(
                payload.summary && payload.meta
                    ? null
                    : 'Server belum mengirim summary poin lengkap. Halaman menampilkan histori terbaru yang tersedia.'
            );
            setError(null);
        } catch (fetchError: any) {
            console.error('Failed to load points history', fetchError);
            setError(fetchError.response?.data?.message || 'Gagal memuat data credits.');
        } finally {
            if (mode === 'initial') {
                setLoading(false);
            } else {
                setRefreshing(false);
            }
        }
    });

    useEffect(() => {
        void loadCredits('initial');
    }, [filterType, meta.page, meta.limit]);

    const handleExportCsv = () => {
        const headers = ['Tanggal', 'Tipe', 'Keterangan', 'Referensi', 'Poin'];
        const rows = items.map((item) => [
            new Date(item.createdAt).toLocaleString('id-ID'),
            typeLabels[item.type],
            item.description,
            item.relatedReward?.name || item.relatedTransaction?.product?.name || item.relatedTransaction?.target || '-',
            formatPointDelta(item.points)
        ]);

        const csvContent = [headers, ...rows]
            .map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(','))
            .join('\n');

        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `riwayat_poin_${new Date().toISOString().split('T')[0]}.csv`;
        link.click();
        URL.revokeObjectURL(url);
    };

    const estimatedValue = summary.currentPoints * pointValueRate;
    const pageStart = meta.total === 0 ? 0 : (meta.page - 1) * meta.limit + 1;
    const pageEnd = Math.min(meta.page * meta.limit, meta.total);

    return (
        <div className="min-h-screen bg-[#1a1a1f] text-white p-4 md:p-6 space-y-6">
            <div className="relative overflow-hidden rounded-2xl border border-orange-500/20 bg-gradient-to-r from-[#1f1f35] via-[#1b1b2f] to-[#11111f] p-5 sm:p-6">
                <div className="absolute inset-0 pointer-events-none">
                    <div className="absolute inset-0 opacity-30 bg-[radial-gradient(circle_at_20%_20%,rgba(255,141,70,0.2),transparent_32%),radial-gradient(circle_at_80%_10%,rgba(109,152,255,0.22),transparent_30%)]" />
                </div>
                <div className="relative flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
                    <div className="max-w-2xl">
                        <div className="inline-flex items-center gap-2 rounded-full border border-orange-500/20 bg-orange-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-orange-300">
                            <Sparkles className="h-3.5 w-3.5" />
                            Loyalty Points
                        </div>
                        <h1 className="mt-4 text-2xl font-bold text-white sm:text-3xl">Credits & Poin Member</h1>
                        <p className="mt-2 text-sm text-gray-400 sm:text-base">
                            Halaman ini menampilkan poin loyalitas yang Kamu kumpulkan dari transaksi sukses. Top up atau redeem manual belum tersedia sebagai flow terpisah.
                        </p>
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-white/5 p-5 sm:min-w-[280px]">
                        <p className="text-xs uppercase tracking-[0.2em] text-orange-300">Saldo Poin Saat Ini</p>
                        <div className="mt-3 flex items-center gap-3">
                            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-orange-500/15">
                                <Coins className="h-7 w-7 text-orange-300" />
                            </div>
                            <div>
                                <p className="text-3xl font-bold text-white">{summary.currentPoints.toLocaleString('id-ID')}</p>
                                <p className="text-sm text-gray-400">Estimasi nilai Rp {estimatedValue.toLocaleString('id-ID')}</p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {error && (
                <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                    {error}
                </div>
            )}

            {compatibilityNotice && !error && (
                <div className="rounded-xl border border-yellow-500/20 bg-yellow-500/10 px-4 py-3 text-sm text-yellow-100">
                    {compatibilityNotice}
                </div>
            )}

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-xl border border-white/5 bg-[#25252d] p-5">
                    <p className="text-xs uppercase tracking-wide text-gray-500">Poin Aktif</p>
                    <p className="mt-3 text-3xl font-bold text-white">{summary.currentPoints.toLocaleString('id-ID')}</p>
                    <p className="mt-1 text-sm text-gray-400">Siap dipakai pada program reward yang tersedia.</p>
                </div>
                <div className="rounded-xl border border-white/5 bg-[#25252d] p-5">
                    <p className="text-xs uppercase tracking-wide text-gray-500">Nilai Estimasi</p>
                    <p className="mt-3 text-3xl font-bold text-orange-300">Rp {estimatedValue.toLocaleString('id-ID')}</p>
                    <p className="mt-1 text-sm text-gray-400">1 poin = Rp {pointValueRate.toLocaleString('id-ID')}</p>
                </div>
                <div className="rounded-xl border border-white/5 bg-[#25252d] p-5">
                    <p className="text-xs uppercase tracking-wide text-gray-500">Perolehan</p>
                    <p className="mt-3 text-3xl font-bold text-emerald-300">{summary.totalEarned.toLocaleString('id-ID')}</p>
                    <p className="mt-1 text-sm text-gray-400">{pointsPerTransaction.toLocaleString('id-ID')} poin per Rp 10.000 transaksi sukses</p>
                </div>
                <div className="rounded-xl border border-white/5 bg-[#25252d] p-5">
                    <p className="text-xs uppercase tracking-wide text-gray-500">Aktivitas</p>
                    <p className="mt-3 text-3xl font-bold text-white">{summary.activityCount.toLocaleString('id-ID')}</p>
                    <p className="mt-1 text-sm text-gray-400">
                        {summary.lastActivityAt
                            ? `Terakhir ${new Date(summary.lastActivityAt).toLocaleString('id-ID')}`
                            : 'Belum ada aktivitas poin.'}
                    </p>
                </div>
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1.2fr_0.8fr]">
                <div className="rounded-xl border border-white/5 bg-[#25252d] p-5">
                    <div className="flex items-center gap-3">
                        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-emerald-500/10">
                            <Gift className="h-5 w-5 text-emerald-300" />
                        </div>
                        <div>
                            <h2 className="font-semibold text-white">Cara dapat poin</h2>
                            <p className="text-sm text-gray-400">Poin diberikan otomatis saat transaksi produk sukses.</p>
                        </div>
                    </div>
                    <div className="mt-4 grid gap-3 text-sm text-gray-300">
                        <div className="rounded-xl border border-white/5 bg-[#1d1d24] px-4 py-3">
                            Setiap Rp 10.000 transaksi sukses memberi <span className="font-semibold text-white">{pointsPerTransaction.toLocaleString('id-ID')} poin</span>.
                        </div>
                        <div className="rounded-xl border border-white/5 bg-[#1d1d24] px-4 py-3">
                            Jika ada penukaran hadiah atau penyesuaian admin, riwayatnya akan langsung muncul di daftar bawah.
                        </div>
                    </div>
                </div>

                <div className="rounded-xl border border-white/5 bg-[#25252d] p-5">
                    <p className="text-xs uppercase tracking-wide text-gray-500">Aksi Cepat</p>
                    <div className="mt-4 space-y-3">
                        <Link
                            to="/products"
                            className="flex items-center justify-between rounded-xl border border-white/5 bg-[#1d1d24] px-4 py-3 text-sm text-gray-200 transition hover:border-orange-500/20 hover:text-white"
                        >
                            <div>
                                <p className="font-medium text-white">Belanja untuk tambah poin</p>
                                <p className="mt-1 text-xs text-gray-400">Lihat katalog produk yang tersedia.</p>
                            </div>
                            <ArrowRight className="h-4 w-4 text-orange-300" />
                        </Link>
                        <Link
                            to="/transactions"
                            className="flex items-center justify-between rounded-xl border border-white/5 bg-[#1d1d24] px-4 py-3 text-sm text-gray-200 transition hover:border-orange-500/20 hover:text-white"
                        >
                            <div>
                                <p className="font-medium text-white">Lihat transaksi sukses</p>
                                <p className="mt-1 text-xs text-gray-400">Cek sumber perolehan poin dari histori order.</p>
                            </div>
                            <Receipt className="h-4 w-4 text-orange-300" />
                        </Link>
                    </div>
                </div>
            </div>

            <div className="overflow-hidden rounded-xl border border-white/5 bg-[#25252d]">
                <div className="flex flex-col gap-4 border-b border-white/5 p-5 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                        <h2 className="text-lg font-semibold text-white">Riwayat Poin</h2>
                        <p className="mt-1 text-sm text-gray-400">
                            Menampilkan {pageStart}-{pageEnd} dari {meta.total.toLocaleString('id-ID')} aktivitas poin.
                        </p>
                    </div>
                    <div className="flex flex-col gap-3 sm:flex-row">
                        <select
                            value={filterType}
                            onChange={(event) => {
                                setFilterType(event.target.value as CreditFilterType);
                                setMeta((current) => ({ ...current, page: 1 }));
                            }}
                            className="rounded-lg border border-white/10 bg-[#1a1a1f] px-3 py-2.5 text-sm text-white outline-none transition focus:border-orange-500"
                        >
                            <option value="all">Semua aktivitas</option>
                            <option value="earn">Poin masuk</option>
                            <option value="redeem">Redeem</option>
                            <option value="admin_adjustment">Adjustment admin</option>
                        </select>
                        <select
                            value={meta.limit}
                            onChange={(event) => {
                                setMeta((current) => ({
                                    ...current,
                                    page: 1,
                                    limit: Number(event.target.value)
                                }));
                            }}
                            className="rounded-lg border border-white/10 bg-[#1a1a1f] px-3 py-2.5 text-sm text-white outline-none transition focus:border-orange-500"
                        >
                            <option value={10}>10 per halaman</option>
                            <option value={20}>20 per halaman</option>
                            <option value={50}>50 per halaman</option>
                        </select>
                        <button
                            onClick={() => void loadCredits('refresh')}
                            disabled={refreshing}
                            className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/10 bg-[#1a1a1f] px-4 py-2.5 text-sm font-medium text-gray-200 transition hover:border-orange-500/20 hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
                            Refresh
                        </button>
                        <button
                            onClick={handleExportCsv}
                            disabled={items.length === 0}
                            className="inline-flex items-center justify-center gap-2 rounded-lg bg-orange-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-orange-600 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            <Download className="h-4 w-4" />
                            Export CSV
                        </button>
                    </div>
                </div>

                {loading ? (
                    <div className="flex min-h-[280px] items-center justify-center">
                        <Loader2 className="h-8 w-8 animate-spin text-orange-400" />
                    </div>
                ) : items.length === 0 ? (
                    <div className="flex min-h-[280px] flex-col items-center justify-center px-6 text-center">
                        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-orange-500/10">
                            <Star className="h-8 w-8 text-orange-300" />
                        </div>
                        <h3 className="mt-4 text-lg font-semibold text-white">Belum ada aktivitas poin</h3>
                        <p className="mt-2 max-w-md text-sm text-gray-400">
                            Setelah transaksi sukses pertama atau penukaran reward, riwayat poinmu akan tampil di sini.
                        </p>
                    </div>
                ) : (
                    <>
                        <div className="overflow-x-auto">
                            <table className="min-w-full text-sm">
                                <thead>
                                    <tr className="border-b border-white/5 text-left text-gray-400">
                                        <th className="px-5 py-3 font-medium">Tanggal</th>
                                        <th className="px-5 py-3 font-medium">Tipe</th>
                                        <th className="px-5 py-3 font-medium">Keterangan</th>
                                        <th className="px-5 py-3 font-medium">Referensi</th>
                                        <th className="px-5 py-3 text-right font-medium">Poin</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {items.map((item) => (
                                        <tr key={item._id} className="border-b border-white/5 align-top last:border-b-0">
                                            <td className="px-5 py-4 text-gray-300">
                                                {new Date(item.createdAt).toLocaleString('id-ID')}
                                            </td>
                                            <td className="px-5 py-4">
                                                <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${typeBadgeClasses[item.type]}`}>
                                                    {typeLabels[item.type]}
                                                </span>
                                            </td>
                                            <td className="px-5 py-4">
                                                <p className="font-medium text-white">{item.description}</p>
                                                {item.relatedTransaction?.product?.name && (
                                                    <p className="mt-1 text-xs text-gray-500">
                                                        Produk: {item.relatedTransaction.product.name}
                                                    </p>
                                                )}
                                            </td>
                                            <td className="px-5 py-4 text-gray-300">
                                                {item.relatedReward?.name ? (
                                                    <div>
                                                        <p className="font-medium text-white">{item.relatedReward.name}</p>
                                                        <p className="mt-1 text-xs text-gray-500">Hadiah</p>
                                                    </div>
                                                ) : item.relatedTransaction?.target ? (
                                                    <div>
                                                        <p className="font-medium text-white">{item.relatedTransaction.target}</p>
                                                        <p className="mt-1 text-xs text-gray-500">
                                                            {item.relatedTransaction.amount
                                                                ? `Rp ${Number(item.relatedTransaction.amount).toLocaleString('id-ID')}`
                                                                : 'Transaksi terkait'}
                                                        </p>
                                                    </div>
                                                ) : (
                                                    <span className="text-gray-500">-</span>
                                                )}
                                            </td>
                                            <td className={`px-5 py-4 text-right font-semibold ${item.points >= 0 ? 'text-emerald-300' : 'text-orange-300'}`}>
                                                {formatPointDelta(item.points)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        <div className="flex flex-col gap-4 border-t border-white/5 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                            <p className="text-sm text-gray-400">
                                Halaman {meta.page} dari {meta.totalPages}
                            </p>
                            <div className="flex items-center gap-2">
                                <button
                                    onClick={() => setMeta((current) => ({ ...current, page: Math.max(1, current.page - 1) }))}
                                    disabled={meta.page <= 1}
                                    className="rounded-lg border border-white/10 px-3 py-2 text-sm text-gray-300 transition hover:border-orange-500/20 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    Sebelumnya
                                </button>
                                <button
                                    onClick={() => setMeta((current) => ({ ...current, page: Math.min(current.totalPages, current.page + 1) }))}
                                    disabled={meta.page >= meta.totalPages}
                                    className="rounded-lg border border-white/10 px-3 py-2 text-sm text-gray-300 transition hover:border-orange-500/20 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    Berikutnya
                                </button>
                            </div>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
