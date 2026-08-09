import { useEffect, useRef, useState } from 'react';
import { apiV2 } from '../../api';
import {
    TrendingUp,
    DollarSign,
    ShoppingCart,
    Download,
    Calendar,
    BarChart3,

    CheckCircle2,
    Clock3,
    XCircle,
    Activity,
    Layers3,
    UserRound,
    Target
} from 'lucide-react';

interface RecentTransaction {
    _id: string;
    product: string;
    category: string;
    user: string;
    target: string;
    amount: number;
    status: 'pending' | 'processing' | 'success' | 'failed' | string;
    createdAt: string;
}

interface SalesReportData {
    summary: {
        totalTransactions: number;
        successTransactions: number;
        pendingTransactions: number;
        failedTransactions: number;
        totalOmset: number;
        totalProfit: number;
        averageTransaction: number;
    };
    categoryData: Array<{
        category: string;
        count: number;
        omset: number;
        profit: number;
    }>;
    dailyData: Array<{
        date: string;
        count: number;
        omset: number;
        profit: number;
    }>;
    recentTransactions: RecentTransaction[];
}

type ReportPreset = 'today' | '7d' | '30d' | 'month';
type ReportRange = { startDate: string; endDate: string };

const emptyRange: ReportRange = { startDate: '', endDate: '' };

const formatCurrency = (value: number) => `Rp ${value.toLocaleString('id-ID')}`;

const parseDateValue = (value: string) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (match) {
        return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
    }
    return new Date(value);
};

const formatInputDate = (date: Date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

const formatShortDate = (value: string) =>
    parseDateValue(value).toLocaleDateString('id-ID', {
        day: 'numeric',
        month: 'short'
    });

const formatDateTime = (value: string) =>
    parseDateValue(value).toLocaleString('id-ID', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
    });

const getPresetRange = (preset: ReportPreset) => {
    const endDate = new Date();
    const startDate = new Date(endDate);

    if (preset === 'today') {
        return {
            startDate: formatInputDate(startDate),
            endDate: formatInputDate(endDate)
        };
    }

    if (preset === '7d') {
        startDate.setDate(startDate.getDate() - 6);
    } else if (preset === '30d') {
        startDate.setDate(startDate.getDate() - 29);
    } else {
        startDate.setDate(1);
    }

    return {
        startDate: formatInputDate(startDate),
        endDate: formatInputDate(endDate)
    };
};

const getStatusMeta = (status: string) => {
    if (status === 'success') {
        return 'ui-success-chip';
    }

    if (status === 'pending' || status === 'processing') {
        return 'ui-warning-chip';
    }

    return 'ui-danger-chip';
};

export default function SalesReport() {
    const [loading, setLoading] = useState(true);
    const [data, setData] = useState<SalesReportData | null>(null);
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [isExporting, setIsExporting] = useState(false);
    const [selectedPreset, setSelectedPreset] = useState<ReportPreset | null>(null);
    const [apiV2Error, setApiV2Error] = useState('');
    const [filterError, setFilterError] = useState('');
    const [exportError, setExportError] = useState('');
    const [appliedRange, setAppliedRange] = useState<ReportRange>(emptyRange);
    const [lastRefreshFailed, setLastRefreshFailed] = useState(false);
    const latestRequestId = useRef(0);

    const hasInvalidRange = Boolean(startDate && endDate && startDate > endDate);
    const hasUnappliedChanges = startDate !== appliedRange.startDate || endDate !== appliedRange.endDate;

    const fetchReport = async (range: ReportRange = appliedRange) => {
        if (range.startDate && range.endDate && range.startDate > range.endDate) {
            setFilterError('Tanggal mulai tidak boleh lebih besar dari tanggal akhir.');
            return;
        }

        const requestId = latestRequestId.current + 1;
        latestRequestId.current = requestId;

        try {
            setLoading(true);
            setApiV2Error('');
            setFilterError('');
            setExportError('');

            const params = new URLSearchParams();
            if (range.startDate) params.append('startDate', range.startDate);
            if (range.endDate) params.append('endDate', range.endDate);

            const suffix = params.toString();
            const res = await apiV2.get(`/reports/sales/summary${suffix ? `?${suffix}` : ''}`);

            if (requestId !== latestRequestId.current) return;

            setData(res.data);
            setAppliedRange(range);
            setLastRefreshFailed(false);
        } catch (error: any) {
            if (requestId !== latestRequestId.current) return;

            console.error('Failed to fetch sales report:', error);
            setLastRefreshFailed(true);
            setApiV2Error(error.response?.data?.message || 'Gagal memuat laporan penjualan.');
        } finally {
            if (requestId === latestRequestId.current) {
                setLoading(false);
            }
        }
    };

    const handleExport = async () => {
        if (hasInvalidRange) {
            setFilterError('Tanggal mulai tidak boleh lebih besar dari tanggal akhir.');
            return;
        }

        if (hasUnappliedChanges) {
            setExportError('Terapkan filter terlebih dahulu sebelum export agar CSV sesuai dengan data di layar.');
            return;
        }

        try {
            setIsExporting(true);
            setExportError('');
            const params = new URLSearchParams();
            if (appliedRange.startDate) params.append('startDate', appliedRange.startDate);
            if (appliedRange.endDate) params.append('endDate', appliedRange.endDate);

            const suffix = params.toString();
            const exportPath = `/reports/sales/export${suffix ? `?${suffix}` : ''}`;
            const res = await apiV2
                .get(exportPath, { responseType: 'blob' });

            const url = window.URL.createObjectURL(new Blob([res.data]));
            const link = document.createElement('a');
            link.href = url;
            link.setAttribute('download', `laporan-penjualan-${formatInputDate(new Date())}.csv`);
            document.body.appendChild(link);
            link.click();
            link.remove();
            window.setTimeout(() => window.URL.revokeObjectURL(url), 0);
        } catch (error: any) {
            console.error('Failed to export report:', error);
            setExportError(error.response?.data?.message || 'Gagal export laporan. Coba lagi beberapa saat.');
        } finally {
            setIsExporting(false);
        }
    };

    const handleApplyFilter = () => {
        if (hasInvalidRange) {
            setFilterError('Tanggal mulai tidak boleh lebih besar dari tanggal akhir.');
            return;
        }

        fetchReport({ startDate, endDate });
    };

    const handleResetFilter = () => {
        setSelectedPreset(null);
        setStartDate('');
        setEndDate('');
        fetchReport(emptyRange);
    };

    const handlePreset = (preset: ReportPreset) => {
        const range = getPresetRange(preset);
        setSelectedPreset(preset);
        setStartDate(range.startDate);
        setEndDate(range.endDate);
        fetchReport(range);
    };

    useEffect(() => {
        fetchReport(emptyRange);
    }, []);

    useEffect(() => {
        const handleLayoutRefresh = () => {
            void fetchReport(appliedRange);
        };

        window.addEventListener('admin:refresh-current-page', handleLayoutRefresh);
        return () => window.removeEventListener('admin:refresh-current-page', handleLayoutRefresh);
    });

    if (loading && !data) {
        return (
            <div className="flex items-center justify-center h-64">
                <div className="flex flex-col items-center gap-2">
                    <div className="h-10 w-10 animate-spin rounded-full border-4 border-[color-mix(in_srgb,var(--ui-accent)_28%,transparent)] border-t-[var(--ui-accent)]" />
                    <p className="ui-text-muted text-sm font-medium">Memuat laporan...</p>
                </div>
            </div>
        );
    }

    if (!data) {
        return (
            <div className="ui-panel mx-auto max-w-lg rounded-3xl border p-6 text-center">
                <p className="ui-danger-text text-sm font-black uppercase tracking-[0.18em]">Laporan gagal dimuat</p>
                <h1 className="ui-text mt-2 text-2xl font-black">Data tidak tersedia</h1>
                <p className="ui-text-muted mt-2 text-sm">{apiV2Error || 'Terjadi kesalahan saat memuat laporan penjualan.'}</p>
                <button onClick={() => fetchReport(emptyRange)} className="ui-accent-solid mt-5 rounded-xl px-4 py-2 text-sm font-black">
                    Coba lagi
                </button>
            </div>
        );
    }

    const successRate = data.summary.totalTransactions > 0
        ? Math.round((data.summary.successTransactions / data.summary.totalTransactions) * 100)
        : 0;
    const profitMargin = data.summary.totalOmset > 0
        ? ((data.summary.totalProfit / data.summary.totalOmset) * 100).toFixed(1)
        : '0.0';
    const activeRangeLabel = appliedRange.startDate || appliedRange.endDate
        ? `${appliedRange.startDate ? formatShortDate(appliedRange.startDate) : 'Awal'} - ${appliedRange.endDate ? formatShortDate(appliedRange.endDate) : 'Sekarang'}`
        : 'Semua periode';
    const recentDailyData = data.dailyData.slice(-7);
    const maxDailyOmset = Math.max(...recentDailyData.map((day) => day.omset), 1);
    const chartWidth = Math.max(240, (recentDailyData.length - 1) * 72);
    const chartHeight = 180;
    const chartStep = recentDailyData.length > 1 ? chartWidth / (recentDailyData.length - 1) : chartWidth;
    const chartPoints = recentDailyData.map((day, index) => ({
        x: index * chartStep,
        y: chartHeight - (day.omset / maxDailyOmset) * (chartHeight * 0.7),
        label: formatShortDate(day.date),
        count: day.count,
        value: day.omset
    }));
    const chartLine = chartPoints.map((point, index, arr) => {
        if (index === 0) return `M ${point.x},${point.y}`;
        const prev = arr[index - 1];
        const cp1x = prev.x + (point.x - prev.x) * 0.5;
        const cp2x = prev.x + (point.x - prev.x) * 0.5;
        return `C ${cp1x},${prev.y} ${cp2x},${point.y} ${point.x},${point.y}`;
    }).join(' ');
    const chartArea = chartPoints.length
        ? `${chartLine} L ${chartPoints[chartPoints.length - 1].x},${chartHeight} L 0,${chartHeight} Z`
        : '';
    const topCategory = data.categoryData.length > 0
        ? data.categoryData.reduce((top, current) => current.omset > top.omset ? current : top)
        : null;
    const topDay = recentDailyData.length > 0
        ? recentDailyData.reduce((top, current) => current.omset > top.omset ? current : top)
        : null;
    const statusCards = [
        {
            label: 'Sukses',
            value: data.summary.successTransactions,
            note: `${successRate}% conversion`,
            icon: CheckCircle2,
            tone: 'ui-success-chip'
        },
        {
            label: 'Pending',
            value: data.summary.pendingTransactions,
            note: 'Butuh monitoring',
            icon: Clock3,
            tone: 'ui-warning-chip'
        },
        {
            label: 'Failed',
            value: data.summary.failedTransactions,
            note: 'Perlu review',
            icon: XCircle,
            tone: 'ui-danger-chip'
        }
    ];

    return (
        <div className="mx-auto w-full max-w-[1740px] min-w-0 space-y-5 pb-8 sm:space-y-6 sm:pb-10">
            <section className="ui-panel rounded-[24px] border p-4 sm:p-5">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between lg:gap-6">
                    <div className="min-w-0 flex-1">
                        <p className="ui-text-muted text-xs font-bold uppercase tracking-[0.18em]">Pusat Export</p>
                        <h2 className="ui-text mt-1.5 text-xl font-black sm:text-2xl">CSV siap unduh</h2>
                        <p className="ui-text-muted mt-1.5 text-sm leading-6">
                            Periode aktif: <span className="font-bold ui-text">{activeRangeLabel}</span>
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={handleExport}
                        disabled={isExporting || loading || hasInvalidRange || hasUnappliedChanges || lastRefreshFailed}
                        className="ui-accent-solid inline-flex w-full shrink-0 items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-black transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60 lg:w-auto lg:min-w-[11rem]"
                    >
                        <Download className="h-4 w-4" />
                        {isExporting ? 'Mengexport...' : 'Export CSV'}
                    </button>
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <div className="ui-panel-muted ui-border rounded-2xl border p-4">
                        <p className="ui-text-muted text-[10px] font-black uppercase tracking-[0.16em]">Total Omset</p>
                        <p className="ui-text mt-2 text-xl font-black sm:text-2xl">{formatCurrency(data.summary.totalOmset)}</p>
                    </div>
                    <div className="ui-panel-muted ui-border rounded-2xl border p-4">
                        <p className="ui-text-muted text-[10px] font-black uppercase tracking-[0.16em]">Total Profit</p>
                        <p className="ui-text mt-2 text-xl font-black sm:text-2xl">{formatCurrency(data.summary.totalProfit)}</p>
                    </div>
                </div>

                <p className="ui-text-muted mt-3 text-[11px] leading-5">
                    Export mengikuti data yang tampil. Terapkan perubahan filter sebelum mengunduh CSV.
                </p>
            </section>

            {(apiV2Error || filterError || exportError || hasUnappliedChanges || loading) && (
                <div className={`${filterError || exportError || apiV2Error ? 'ui-warning-chip' : 'ui-info-chip'} rounded-2xl border px-4 py-3 text-sm font-semibold`}>
                    {loading ? 'Memperbarui laporan...' : null}
                    {apiV2Error ? `${lastRefreshFailed ? 'Gagal memuat data terbaru. Menampilkan data terakhir yang berhasil dimuat. ' : ''}${apiV2Error}` : null}
                    {filterError ? filterError : null}
                    {exportError ? exportError : null}
                    {!loading && !apiV2Error && !filterError && !exportError && hasUnappliedChanges ? 'Ada perubahan filter yang belum diterapkan.' : null}
                </div>
            )}

            <section className="ui-panel rounded-[24px] border p-4 sm:p-5">
                <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                    <div>
                        <p className="ui-accent-text text-xs font-black uppercase tracking-[0.22em]">Builder Periode</p>
                        <p className="ui-text-muted mt-1 text-sm">Preset cepat atau tanggal manual untuk query laporan.</p>
                    </div>

                    <div className="flex flex-wrap gap-2">
                        {[
                            { id: 'today' as ReportPreset, label: 'Hari Ini' },
                            { id: '7d' as ReportPreset, label: '7 Hari' },
                            { id: '30d' as ReportPreset, label: '30 Hari' },
                            { id: 'month' as ReportPreset, label: 'Bulan Ini' }
                        ].map((preset) => (
                            <button
                                key={preset.id}
                                onClick={() => handlePreset(preset.id)}
                                className={`rounded-xl border px-3 py-2 text-sm font-bold transition-colors ${selectedPreset === preset.id ? 'ui-accent-chip' : 'ui-muted-action'}`}
                            >
                                {preset.label}
                            </button>
                        ))}
                    </div>

                    <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto]">
                        <label className="ui-panel-muted ui-border flex items-center gap-2 rounded-xl border px-3 py-2">
                            <Calendar className="ui-text-muted h-4 w-4" />
                            <input
                                type="date"
                                value={startDate}
                                max={endDate || undefined}
                                aria-label="Tanggal mulai laporan penjualan"
                                onChange={(e) => {
                                    setSelectedPreset(null);
                                    setStartDate(e.target.value);
                                    setFilterError('');
                                    setExportError('');
                                }}
                                className="ui-text min-w-0 bg-transparent text-sm font-semibold outline-none"
                            />
                        </label>
                        <label className="ui-panel-muted ui-border flex items-center gap-2 rounded-xl border px-3 py-2">
                            <Calendar className="ui-text-muted h-4 w-4" />
                            <input
                                type="date"
                                value={endDate}
                                min={startDate || undefined}
                                aria-label="Tanggal akhir laporan penjualan"
                                onChange={(e) => {
                                    setSelectedPreset(null);
                                    setEndDate(e.target.value);
                                    setFilterError('');
                                    setExportError('');
                                }}
                                className="ui-text min-w-0 bg-transparent text-sm font-semibold outline-none"
                            />
                        </label>
                        <button onClick={handleApplyFilter} disabled={loading || hasInvalidRange} className="ui-accent-solid rounded-xl px-4 py-2 text-sm font-black transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60">Terapkan</button>
                        {(startDate || endDate || selectedPreset) && (
                            <button onClick={handleResetFilter} className="ui-muted-action rounded-xl px-4 py-2 text-sm font-bold">Reset</button>
                        )}
                    </div>
                </div>
                {(filterError || hasInvalidRange) && (
                    <p className="ui-danger-text mt-3 text-xs font-bold" role="alert">
                        {filterError || 'Tanggal mulai tidak boleh lebih besar dari tanggal akhir.'}
                    </p>
                )}
            </section>

            <section className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
                {[
                    { label: 'Total Transaksi', value: data.summary.totalTransactions.toLocaleString('id-ID'), note: `${data.summary.successTransactions} sukses`, icon: ShoppingCart, tone: 'ui-accent-text', bg: 'bg-[var(--ui-accent-soft)]' },
                    { label: 'Total Omset', value: formatCurrency(data.summary.totalOmset), note: `${data.summary.successTransactions} transaksi`, icon: DollarSign, tone: 'text-[var(--ui-chart-2)]', bg: 'bg-[color-mix(in_srgb,var(--ui-chart-2)_14%,transparent)]' },
                    { label: 'Total Profit', value: formatCurrency(data.summary.totalProfit), note: `Margin ${profitMargin}%`, icon: TrendingUp, tone: 'text-[var(--ui-chart-3)]', bg: 'bg-[color-mix(in_srgb,var(--ui-chart-3)_14%,transparent)]' },
                    { label: 'Rata-rata', value: formatCurrency(Math.round(data.summary.averageTransaction)), note: `${data.summary.pendingTransactions} pending`, icon: BarChart3, tone: 'text-[var(--ui-chart-5)]', bg: 'bg-[color-mix(in_srgb,var(--ui-chart-5)_14%,transparent)]' }
                ].map((metric) => (
                    <div key={metric.label} className="ui-panel group relative overflow-hidden rounded-2xl border p-4 transition hover:-translate-y-0.5 hover:border-[color-mix(in_srgb,var(--ui-accent)_38%,transparent)]">
                        <metric.icon className={`absolute -bottom-5 -right-3 h-24 w-24 ${metric.tone} opacity-[0.06] transition group-hover:scale-110`} />
                        <div className="relative flex items-start justify-between gap-4">
                            <div className="min-w-0">
                                <p className="ui-text-muted text-[11px] font-black uppercase tracking-[0.18em]">{metric.label}</p>
                                <p className="ui-text mt-3 truncate text-2xl font-black leading-none lg:text-3xl">{metric.value}</p>
                                <p className={`mt-2 text-xs font-bold ${metric.tone}`}>{metric.note}</p>
                            </div>
                            <div className={`rounded-2xl p-3 ${metric.bg} ${metric.tone}`}>
                                <metric.icon className="h-5 w-5" />
                            </div>
                        </div>
                    </div>
                ))}
            </section>

            <section className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.25fr)_minmax(360px,0.75fr)]">
                <div className="ui-panel overflow-hidden rounded-[24px] border">
                    <div className="ui-border flex flex-col gap-3 border-b p-4 sm:flex-row sm:items-center sm:justify-between lg:p-6">
                        <div>
                            <p className="ui-accent-text text-xs font-black uppercase tracking-[0.22em]">Komposisi Kategori</p>
                            <h3 className="ui-text mt-2 text-2xl font-black">Laporan Per Kategori</h3>
                        </div>
                        {topCategory && (
                            <span className="ui-accent-chip inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-bold">
                                <Layers3 className="h-3.5 w-3.5" />
                                Top: {topCategory.category}
                            </span>
                        )}
                    </div>

                    <div className="overflow-x-auto">
                        <table className="min-w-full divide-y divide-[var(--ui-border)]">
                            <thead className="ui-panel-muted">
                                <tr>
                                    {['Kategori', 'Transaksi', 'Omset', 'Profit', 'Kontribusi'].map((heading) => (
                                        <th key={heading} className="ui-text-muted px-6 py-4 text-left text-xs font-black uppercase tracking-[0.16em]">
                                            {heading}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-[var(--ui-border)]">
                                {data.categoryData.length === 0 ? (
                                    <tr>
                                        <td colSpan={5} className="ui-text-muted px-6 py-14 text-center">Tidak ada data kategori</td>
                                    </tr>
                                ) : (
                                    data.categoryData.map((cat) => {
                                        const percentage = data.summary.totalOmset > 0 ? ((cat.omset / data.summary.totalOmset) * 100).toFixed(1) : '0.0';
                                        return (
                                            <tr key={cat.category} className="transition hover:bg-[var(--ui-card-muted)]">
                                                <td className="whitespace-nowrap px-6 py-4"><div className="ui-text text-sm font-bold">{cat.category}</div></td>
                                                <td className="whitespace-nowrap px-6 py-4"><div className="ui-text-muted text-sm">{cat.count} trx</div></td>
                                                <td className="whitespace-nowrap px-6 py-4"><div className="ui-text text-sm font-bold">{formatCurrency(cat.omset)}</div></td>
                                                <td className="whitespace-nowrap px-6 py-4"><div className="text-sm font-bold ui-success-text">{formatCurrency(cat.profit)}</div></td>
                                                <td className="whitespace-nowrap px-6 py-4">
                                                    <div className="flex min-w-[150px] items-center gap-2">
                                                        <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--ui-card-muted)]">
                                                            <div className="h-full rounded-full bg-[var(--ui-accent)]" style={{ width: `${Math.min(Number(percentage), 100)}%` }} />
                                                        </div>
                                                        <span className="ui-text-muted w-12 text-sm font-semibold">{percentage}%</span>
                                                    </div>
                                                </td>
                                            </tr>
                                        );
                                    })
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>

                <div className="flex flex-col gap-5">
                    <div className="ui-panel rounded-[24px] border p-5">
                        <div className="flex items-start justify-between gap-4">
                            <div>
                                <p className="ui-accent-text text-xs font-black uppercase tracking-[0.2em]">Status Transaksi</p>
                                <h3 className="ui-text mt-2 text-xl font-black">Status Transaksi</h3>
                            </div>
                            <Activity className="ui-accent-text h-5 w-5" />
                        </div>
                        <div className="mt-5 space-y-3">
                            {statusCards.map((item) => (
                                <div key={item.label} className="ui-panel-muted ui-border flex items-center justify-between rounded-2xl border p-4">
                                    <div className="flex items-center gap-3">
                                        <div className={`flex h-11 w-11 items-center justify-center rounded-2xl border ${item.tone}`}>
                                            <item.icon className="h-5 w-5" />
                                        </div>
                                        <div>
                                            <p className="ui-text text-sm font-bold">{item.label}</p>
                                            <p className="ui-text-muted text-xs">{item.note}</p>
                                        </div>
                                    </div>
                                    <p className="ui-text text-2xl font-black">{item.value}</p>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="ui-panel-muted ui-border rounded-[24px] border p-5">
                        <p className="ui-accent-text text-xs font-black uppercase tracking-[0.2em]">Insight Cepat</p>
                        <div className="mt-4 space-y-4">
                            <div>
                                <p className="ui-text-muted text-xs font-bold uppercase tracking-[0.16em]">Kategori Teratas</p>
                                <p className="ui-text mt-1 text-lg font-black">{topCategory ? topCategory.category : 'Belum ada data'}</p>
                                <p className="ui-text-muted mt-1 text-sm">{topCategory ? `${formatCurrency(topCategory.omset)} dari ${topCategory.count} transaksi` : 'Data kategori akan muncul setelah transaksi sukses.'}</p>
                            </div>
                            <div className="ui-border border-t pt-4">
                                <p className="ui-text-muted text-xs font-bold uppercase tracking-[0.16em]">Hari Puncak</p>
                                <p className="ui-text mt-1 text-lg font-black">{topDay ? formatShortDate(topDay.date) : 'Belum ada data'}</p>
                                <p className="ui-text-muted mt-1 text-sm">{topDay ? `${topDay.count} transaksi • ${formatCurrency(topDay.omset)}` : 'Trend harian akan tampil saat data masuk.'}</p>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            <section className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(360px,0.85fr)]">
                <div className="ui-panel rounded-[24px] border p-4 lg:p-6">
                    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                        <div>
                            <p className="ui-accent-text text-xs font-black uppercase tracking-[0.22em]">Trajektori Harian</p>
                            <h3 className="ui-text mt-2 text-2xl font-black">Trend Harian</h3>
                        </div>
                        <span className="ui-text-muted text-sm">7 titik terakhir dalam periode • {recentDailyData.length} titik data</span>
                    </div>

                    {recentDailyData.length > 0 ? (
                        <div className="ui-panel-muted ui-border rounded-2xl border p-4">
                            <div className="mb-5 grid gap-3 sm:grid-cols-2">
                                <div className="ui-panel ui-border rounded-2xl border p-4">
                                    <p className="ui-text-muted text-xs font-bold uppercase tracking-[0.16em]">Puncak Omset</p>
                                    <p className="ui-text mt-2 text-xl font-black">{topDay ? formatCurrency(topDay.omset) : formatCurrency(0)}</p>
                                </div>
                                <div className="ui-panel ui-border rounded-2xl border p-4">
                                    <p className="ui-text-muted text-xs font-bold uppercase tracking-[0.16em]">Rata-rata 7 Hari</p>
                                    <p className="ui-text mt-2 text-xl font-black">{formatCurrency(Math.round(recentDailyData.reduce((sum, day) => sum + day.omset, 0) / recentDailyData.length))}</p>
                                </div>
                            </div>

                            <div className="relative h-[280px] rounded-xl bg-[var(--ui-card-bg)] p-3">
                                <svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} className="h-full w-full overflow-visible" preserveAspectRatio="none">
                                    <defs>
                                        <linearGradient id="salesTrendFill" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="0%" stopColor="var(--ui-accent)" stopOpacity="0.45" />
                                            <stop offset="100%" stopColor="var(--ui-accent)" stopOpacity="0" />
                                        </linearGradient>
                                    </defs>
                                    {chartArea && <path d={chartArea} fill="url(#salesTrendFill)" />}
                                    {chartLine && <path d={chartLine} fill="none" stroke="var(--ui-accent)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />}
                                    {chartPoints.map((point) => (
                                        <circle key={point.label} cx={point.x} cy={point.y} r="4" fill="var(--ui-card-bg)" stroke="var(--ui-accent)" strokeWidth="2" />
                                    ))}
                                </svg>
                            </div>

                            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
                                {chartPoints.map((point) => (
                                    <div key={point.label} className="ui-panel ui-border rounded-xl border px-3 py-2">
                                        <p className="ui-text-muted text-[11px] font-bold uppercase tracking-[0.14em]">{point.label}</p>
                                        <p className="ui-text mt-1 text-sm font-black">{formatCurrency(point.value)}</p>
                                        <p className="ui-text-muted text-xs">{point.count} trx</p>
                                    </div>
                                ))}
                            </div>
                        </div>
                    ) : (
                        <div className="ui-panel-muted ui-text-muted rounded-2xl border px-6 py-12 text-center">Belum ada data trend harian.</div>
                    )}
                </div>

                <div className="ui-panel rounded-[24px] border p-4 lg:p-6">
                    <div className="mb-5 flex items-center justify-between gap-3">
                        <div>
                            <p className="ui-accent-text text-xs font-black uppercase tracking-[0.22em]">Feed Transaksi</p>
                            <h3 className="ui-text mt-2 text-2xl font-black">Transaksi Terbaru</h3>
                        </div>
                        <Layers3 className="ui-accent-text h-5 w-5" />
                    </div>

                    {data.recentTransactions.length === 0 ? (
                        <div className="ui-panel-muted ui-text-muted rounded-2xl border px-6 py-12 text-center">Belum ada transaksi terbaru.</div>
                    ) : (
                        <div className="space-y-3">
                            {data.recentTransactions.map((transaction) => (
                                <div key={transaction._id} className="ui-panel-muted ui-border rounded-2xl border p-4">
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <p className="ui-text truncate text-sm font-black">{transaction.product}</p>
                                            <p className="ui-text-muted mt-1 text-xs">{transaction.category}</p>
                                        </div>
                                        <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-wide ${getStatusMeta(transaction.status)}`}>{transaction.status}</span>
                                    </div>

                                    <div className="ui-text-muted mt-3 space-y-2 text-xs">
                                        <div className="flex items-center gap-2"><UserRound className="h-3.5 w-3.5" /><span className="truncate">{transaction.user}</span></div>
                                        <div className="flex items-center gap-2"><Target className="h-3.5 w-3.5" /><span className="truncate">{transaction.target}</span></div>
                                    </div>

                                    <div className="mt-4 flex items-end justify-between gap-3">
                                        <div>
                                            <p className="ui-text-muted text-[11px] font-bold uppercase tracking-[0.14em]">Nominal</p>
                                            <p className="ui-text text-sm font-black">{formatCurrency(transaction.amount)}</p>
                                        </div>
                                        <p className="ui-text-muted text-right text-[11px]">{formatDateTime(transaction.createdAt)}</p>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </section>
        </div>
    );
}
