import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { apiV2 } from '../../api';
import {
    Calendar,
    ArrowRight,
    Info,
    RefreshCw,
    BadgeCheck,
    TrendingUp,
    Activity,
    DollarSign,
    ShoppingCart,
    AlertTriangle,
    Webhook,
    type LucideIcon
} from 'lucide-react';
import { useAuthStore } from '../../store/useAuthStore';
import TwoFactorReminderDialog from '../../components/admin/TwoFactorReminderDialog';

interface SummaryData {
    totalTransactions: number;
    successTransactions: number;
    pendingTransactions: number;
    failedTransactions: number;
    totalOmset: number;
    totalProfit: number;
    averageTransaction: number;
}

interface DashboardOverviewData {
    summary: SummaryData;
    dailyData: Array<{
        date: string;
        count: number;
        omset: number;
        profit: number;
    }>;
    quickStats: {
        today: number;
        yesterday: number;
        thisMonth: number;
        lastMonth: number;
    };
    revenueBreakdown: {
        today: { omset: number; profit: number };
        yesterday: { omset: number; profit: number };
        thisMonth: { omset: number; profit: number };
        lastMonth: { omset: number; profit: number };
    };
    sellerCallbackQueue?: {
        pending: number;
        due: number;
        highAttempt: number;
        highAttemptThreshold: number;
        schedulerHealth?: RetryQueueHealth;
    };
    lastUpdatedAt: string;
}

type RetryQueueHealth = {
    status: 'never' | 'success' | 'partial' | 'failed';
    source: 'admin' | 'scheduler' | 'unknown';
    lastRunAt?: string | null;
    processed: number;
    successCount: number;
    failedCount: number;
    remainingDue: number;
    lastError?: string;
};

interface StuckTransaction {
    _id: string;
    target: string;
    amount: number;
    status: string;
    vendorTrxId?: string;
    customerRefId?: string;
    source?: string;
    createdAt: string;
    updatedAt: string;
    ageMinutes: number;
    user?: {
        name?: string;
        email?: string;
    };
    product?: {
        name?: string;
        code?: string;
        category?: string;
        brand?: string;
        vendor?: string | { name?: string };
    };
}

interface StuckTransactionsData {
    thresholdMinutes: number;
    total: number;
    items: StuckTransaction[];
}

type StuckTransactionsSource = 'api-v2';

interface OpsSnapshotData {
    generated_at: string;
    transactions_today: {
        total: number;
        success: number;
        pending: number;
        failed: number;
        omset: number;
        success_rate: number;
    };
    deposits: {
        pending: number;
        pending_amount_total: number;
        pending_transfer_total: number;
    };
    vendors: {
        total: number;
        active: number;
        inactive: number;
        low_balance_configured: number;
    };
    stuck: {
        threshold_minutes: number;
        total: number;
    };
}

interface NotificationSummaryData {
    total: number;
    unread: number;
    critical: number;
    warning: number;
    info: number;
    categories: {
        transactions: number;
        deposits: number;
        vendors: number;
        callbacks: number;
    };
}

type FinanceCard = {
    title: string;
    sub: string;
    value: number;
    icon: LucideIcon;
    profit?: boolean;
    highlight?: boolean;
    valueType?: 'currency' | 'number' | 'percent';
};

const formatCurrency = (value: number) => `Rp${value.toLocaleString('id-ID')}`;

const formatNumber = (value: number) => value.toLocaleString('id-ID');

const parseDateValue = (value: string) => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (match) {
        return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
    }

    return new Date(value);
};

const formatShortDate = (value: string) =>
    parseDateValue(value).toLocaleDateString('id-ID', {
        day: 'numeric',
        month: 'short'
    });

const formatDateTime = (value: string) =>
    new Date(value).toLocaleString('id-ID', {
        day: '2-digit',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
    });

const formatCardValue = (card: FinanceCard) => {
    if (card.valueType === 'number') {
        return formatNumber(card.value);
    }

    if (card.valueType === 'percent') {
        return `${Math.round(card.value)}%`;
    }

    return formatCurrency(card.value);
};

const getVendorName = (vendor?: string | { name?: string }) => {
    if (!vendor) return '';
    return typeof vendor === 'string' ? vendor : vendor.name || '';
};

export default function AdminDashboard() {
    const { hasPermission } = useAuthStore();
    const [loading, setLoading] = useState(true);
    const [dashboard, setDashboard] = useState<DashboardOverviewData | null>(null);
    const [startDate, setStartDate] = useState('');
    const [endDate, setEndDate] = useState('');
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [filterError, setFilterError] = useState<string | null>(null);
    const [stuckLoading, setStuckLoading] = useState(true);
    const [stuckError, setStuckError] = useState<string | null>(null);
    const [stuckData, setStuckData] = useState<StuckTransactionsData | null>(null);
    const [stuckSource, setStuckSource] = useState<StuckTransactionsSource>('api-v2');
    const [opsSnapshot, setOpsSnapshot] = useState<OpsSnapshotData | null>(null);
    const [opsSnapshotError, setOpsSnapshotError] = useState<string | null>(null);
    const [notificationSummary, setNotificationSummary] = useState<NotificationSummaryData | null>(null);
    const [notificationSummaryError, setNotificationSummaryError] = useState<string | null>(null);
    const [recheckingId, setRecheckingId] = useState<string | null>(null);

    const fetchDashboard = async (range?: { start?: string; end?: string }) => {
        try {
            setLoading(true);
            setErrorMessage(null);

            const start = range?.start ?? startDate;
            const end = range?.end ?? endDate;
            const params = new URLSearchParams();

            if (start) params.append('startDate', start);
            if (end) params.append('endDate', end);

            const suffix = params.toString();
            const path = `/reports/dashboard${suffix ? `?${suffix}` : ''}`;
            const res = await apiV2
                .get(path);
            setDashboard(res.data);
        } catch (error: any) {
            console.error('Failed to fetch dashboard data', error);
            setErrorMessage(error.response?.data?.message || 'Gagal memuat dashboard admin.');
        } finally {
            setLoading(false);
        }
    };

    const fetchStuckTransactions = async () => {
        try {
            setStuckLoading(true);
            setStuckError(null);
            const res = await apiV2.get('/transactions/stuck?thresholdMinutes=15&limit=5');
            setStuckData(res.data);
            setStuckSource('api-v2');
        } catch (error: any) {
            console.error('Failed to fetch stuck transactions', error);
            setStuckError(error.response?.data?.message || 'Gagal memuat transaksi macet.');
        } finally {
            setStuckLoading(false);
        }
    };

    const fetchOpsSnapshot = async () => {
        try {
            setOpsSnapshotError(null);
            const res = await apiV2.get('/dashboard/ops-snapshot');
            setOpsSnapshot(res.data);
        } catch (error: any) {
            console.warn('Failed to fetch API v2 ops snapshot', error);
            setOpsSnapshotError(error.response?.data?.message || 'Snapshot API v2 belum tersedia.');
        }
    };

    const fetchNotificationSummary = async () => {
        try {
            setNotificationSummaryError(null);
            const res = await apiV2.get('/notifications/admin/summary');
            setNotificationSummary(res.data);
        } catch (error: any) {
            console.warn('Failed to fetch API v2 notification summary', error);
            setNotificationSummaryError(error.response?.data?.message || 'Ringkasan notifikasi API v2 belum tersedia.');
        }
    };

    useEffect(() => {
        fetchDashboard();
        fetchStuckTransactions();
        fetchOpsSnapshot();
        fetchNotificationSummary();
    }, []);

    useEffect(() => {
        const handleLayoutRefresh = () => {
            void refreshAll();
        };

        window.addEventListener('admin:refresh-current-page', handleLayoutRefresh);
        return () => window.removeEventListener('admin:refresh-current-page', handleLayoutRefresh);
    });

    const handleRecheckStuckTransaction = async (transactionId: string) => {
        try {
            setRecheckingId(transactionId);
            await apiV2.post(`/transactions/${transactionId}/recheck`);
            await Promise.all([fetchDashboard(), fetchStuckTransactions()]);
        } catch (error: any) {
            console.error('Failed to recheck stuck transaction', error);
            setStuckError(error.response?.data?.message || 'Gagal cek status vendor.');
        } finally {
            setRecheckingId(null);
        }
    };

    const handleResetFilters = () => {
        setStartDate('');
        setEndDate('');
        setFilterError(null);
        fetchDashboard({ start: '', end: '' });
    };

    const handleApplyFilter = (e: FormEvent) => {
        e.preventDefault();

        if (startDate && endDate && startDate > endDate) {
            setFilterError('Tanggal mulai tidak boleh lebih besar dari tanggal akhir.');
            return;
        }

        setFilterError(null);
        fetchDashboard({ start: startDate, end: endDate });
    };

    const hasActiveRange = Boolean(startDate || endDate);
    const activeRangeLabel = hasActiveRange
        ? `${startDate ? formatShortDate(startDate) : 'Awal'} - ${endDate ? formatShortDate(endDate) : 'Sekarang'}`
        : 'Realtime hari ini';
    const summary = dashboard?.summary;
    const quickStats = dashboard?.quickStats;
    const successRate = summary?.totalTransactions
        ? Math.round((summary.successTransactions / summary.totalTransactions) * 100)
        : 0;
    const canViewSalesReport = hasPermission('viewReports');
    const canManageProducts = hasPermission('manageProducts');
    const canProcessManualTransaction = hasPermission('processManualTransaction');
    const sellerCallbackQueue = dashboard?.sellerCallbackQueue || {
        pending: 0,
        due: 0,
        highAttempt: 0,
        highAttemptThreshold: 5,
        schedulerHealth: undefined
    };
    const retryQueueHealth = sellerCallbackQueue.schedulerHealth;

    const refreshAll = async () => {
        await Promise.allSettled([
            fetchDashboard(),
            fetchStuckTransactions(),
            fetchOpsSnapshot(),
            fetchNotificationSummary()
        ]);
    };

    const actionRequiredCards = [
        {
            title: 'Transaksi Pending',
            value: summary?.pendingTransactions || 0,
            note: 'Perlu dipantau',
            to: '/admin/transactions?status=pending,processing',
            tone: (summary?.pendingTransactions || 0) > 0 ? 'ui-warning-chip' : 'ui-success-chip'
        },
        {
            title: 'Transaksi Macet',
            value: stuckData?.total || opsSnapshot?.stuck.total || 0,
            note: `>${stuckData?.thresholdMinutes || opsSnapshot?.stuck.threshold_minutes || 15} menit`,
            to: '/admin/transactions?status=pending,processing',
            tone: (stuckData?.total || opsSnapshot?.stuck.total || 0) > 0 ? 'ui-danger-chip' : 'ui-success-chip'
        },
        {
            title: 'Deposit Pending',
            value: opsSnapshot?.deposits.pending || 0,
            note: 'Menunggu verifikasi',
            to: '/admin/deposits?status=pending',
            tone: (opsSnapshot?.deposits.pending || 0) > 0 ? 'ui-warning-chip' : 'ui-success-chip'
        },
        {
            title: 'Callback Due',
            value: sellerCallbackQueue.due,
            note: 'Retry seller callback',
            to: '/admin/transactions?mode=seller&callback=due',
            tone: sellerCallbackQueue.due > 0 ? 'ui-danger-chip' : 'ui-success-chip'
        },
        {
            title: 'Notifikasi Critical',
            value: notificationSummary?.critical || 0,
            note: 'Alert prioritas',
            to: '/admin/notifications?severity=critical',
            tone: (notificationSummary?.critical || 0) > 0 ? 'ui-danger-chip' : 'ui-success-chip'
        },
        {
            title: 'Voucher Idle >30h',
            value: (opsSnapshot as any)?.promo?.idle_vouchers || 0,
            note: 'Belum dibagikan',
            to: '/admin/vouchers',
            tone: ((opsSnapshot as any)?.promo?.idle_vouchers || 0) > 0 ? 'ui-warning-chip' : 'ui-success-chip'
        },
        {
            title: 'Flash Sale Live',
            value: (opsSnapshot as any)?.promo?.flash_sales_live || 0,
            note: 'Sedang berjalan',
            to: '/admin/flash-sales',
            tone: ((opsSnapshot as any)?.promo?.flash_sales_live || 0) > 0 ? 'ui-accent-chip' : 'ui-success-chip'
        },
        {
            title: 'Diskon Terbuka',
            value: (opsSnapshot as any)?.promo?.discount_vouchers_open || 0,
            note: 'Slot masih ada',
            to: '/admin/vouchers',
            tone: 'ui-info-chip'
        },
        {
            title: 'Giveaway Total',
            value: (opsSnapshot as any)?.promo?.giveaways_total || 0,
            note: `Kredit ${(opsSnapshot as any)?.promo?.giveaways_amount_total ? `Rp${Number((opsSnapshot as any).promo.giveaways_amount_total).toLocaleString('id-ID')}` : 'Rp0'}`,
            to: '/admin/vouchers',
            tone: 'ui-success-chip'
        }
    ];

    const financePrimaryCards = useMemo<FinanceCard[]>(() => {
        if (!dashboard) {
            return [];
        }

        if (hasActiveRange) {
            return [
                { title: 'Periode Aktif', sub: 'Omset', value: dashboard.summary.totalOmset, icon: DollarSign },
                { title: 'Periode Aktif', sub: 'Profit', value: dashboard.summary.totalProfit, profit: true, icon: TrendingUp },
                { title: 'Periode Aktif', sub: 'Rata-rata', value: Math.round(dashboard.summary.averageTransaction || 0), highlight: true, icon: Activity },
                { title: 'Periode Aktif', sub: 'Success Rate', value: successRate, highlight: true, icon: BadgeCheck, valueType: 'percent' }
            ];
        }

        return [
            { title: 'Hari Ini', sub: 'Omset', value: dashboard.revenueBreakdown.today.omset, icon: TrendingUp },
            { title: 'Hari Ini', sub: 'Profit', value: dashboard.revenueBreakdown.today.profit, profit: true, icon: TrendingUp },
            { title: 'Bulan Ini', sub: 'Omset', value: dashboard.revenueBreakdown.thisMonth.omset, highlight: true, icon: DollarSign },
            { title: 'Bulan Ini', sub: 'Profit', value: dashboard.revenueBreakdown.thisMonth.profit, profit: true, highlight: true, icon: DollarSign }
        ];
    }, [dashboard, hasActiveRange, successRate]);

    const financeSecondaryStats = useMemo(() => {
        if (!dashboard) {
            return [];
        }

        if (hasActiveRange) {
            return [
                { label: 'Total Transaksi', value: formatNumber(dashboard.summary.totalTransactions), tone: 'ui-text' },
                { label: 'Pending / Proses', value: formatNumber(dashboard.summary.pendingTransactions), tone: 'ui-warning-text' },
                { label: 'Transaksi Gagal', value: formatNumber(dashboard.summary.failedTransactions), tone: 'ui-danger-text' },
                { label: 'Update Data', value: formatDateTime(dashboard.lastUpdatedAt), tone: 'ui-info-text' }
            ];
        }

        return [
            { label: 'Omset Kemarin', value: formatCurrency(dashboard.revenueBreakdown.yesterday.omset), tone: 'ui-text' },
            { label: 'Profit Kemarin', value: formatCurrency(dashboard.revenueBreakdown.yesterday.profit), tone: 'ui-success-text' },
            { label: 'Omset Bulan Lalu', value: formatCurrency(dashboard.revenueBreakdown.lastMonth.omset), tone: 'ui-text' },
            { label: 'Profit Bulan Lalu', value: formatCurrency(dashboard.revenueBreakdown.lastMonth.profit), tone: 'ui-success-text' }
        ];
    }, [dashboard, hasActiveRange]);

    const omsetChart = useMemo(() => {
        if (!dashboard?.dailyData?.length) return null;

        const recent = dashboard.dailyData.slice(-8);
        const values = recent.map((day) => day.omset);
        const maxValue = Math.max(...values, 1);
        const width = Math.max(160, (recent.length - 1) * 60);
        const height = 180;
        const step = recent.length > 1 ? width / (recent.length - 1) : width;

        const points = recent.map((item, idx) => {
            const x = idx * step;
            const y = height - (item.omset / maxValue) * (height * 0.7);

            return {
                x,
                y,
                label: formatShortDate(item.date),
                value: item.omset
            };
        });

        const getCommand = (point: { x: number; y: number }, index: number, all: Array<{ x: number; y: number }>) => {
            if (index === 0) return `M ${point.x},${point.y}`;
            const prev = all[index - 1];
            const cp1x = prev.x + (point.x - prev.x) * 0.5;
            const cp2x = prev.x + (point.x - prev.x) * 0.5;
            return `C ${cp1x},${prev.y} ${cp2x},${point.y} ${point.x},${point.y}`;
        };

        const line = points.map((point, index, all) => getCommand(point, index, all)).join(' ');
        const area = `${line} L ${points[points.length - 1].x},${height} L 0,${height} Z`;

        return { points, width, height, line, area };
    }, [dashboard]);

    if (loading && !dashboard) {
        return (
            <div className="ui-shell flex h-screen items-center justify-center">
                <div className="flex flex-col items-center gap-3">
                    <div className="h-10 w-10 animate-spin rounded-full border-4 border-[color-mix(in_srgb,var(--ui-accent)_28%,transparent)] border-t-[var(--ui-accent)]" />
                    <p className="ui-text-muted text-sm font-medium">Memuat dashboard...</p>
                </div>
            </div>
        );
    }

    if (!dashboard) {
        return (
            <div className="min-h-[60vh] flex items-center justify-center">
                <div className="max-w-md rounded-2xl border p-6 text-center space-y-4 ui-danger-chip">
                    <div className="inline-flex h-12 w-12 items-center justify-center rounded-full border ui-danger-chip">
                        <Info className="w-5 h-5" />
                    </div>
                    <div>
                        <h2 className="text-lg font-bold">Dashboard tidak bisa dimuat</h2>
                        <p className="mt-2 text-sm opacity-80">{errorMessage || 'Terjadi kesalahan saat mengambil data dashboard.'}</p>
                    </div>
                    <button
                        onClick={() => fetchDashboard()}
                        className="ui-accent-solid inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition hover:brightness-105"
                    >
                        <RefreshCw className="w-4 h-4" />
                        Coba lagi
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="mx-auto w-full max-w-[1740px] min-w-0 space-y-5 pb-8 sm:space-y-6 sm:pb-10">
            <TwoFactorReminderDialog />
            {canManageProducts && (
                <section className="ui-panel-muted flex flex-wrap gap-2 rounded-2xl border ui-border p-4">
                    <Link
                        to="/admin/catalog-audit"
                        className="ui-muted-action inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-bold"
                    >
                        Audit Katalog <ArrowRight className="h-4 w-4" />
                    </Link>
                </section>
            )}

            {errorMessage && (
                <div className={`rounded-2xl border px-4 py-3 ${dashboard ? 'ui-warning-chip' : 'ui-danger-chip'}`}>
                    <div className="flex items-start gap-3">
                        <Info className="mt-0.5 h-4 w-4 shrink-0" />
                        <div>
                            <p className="text-sm font-bold">{dashboard ? 'Data terbaru gagal dimuat' : 'Gagal memuat dashboard'}</p>
                            <p className="mt-1 text-xs opacity-80">{errorMessage}</p>
                        </div>
                    </div>
                </div>
            )}

            <section className="ui-panel rounded-[24px] border p-5">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <div>
                        <p className="ui-accent-text text-xs font-black uppercase tracking-[0.22em]">Butuh Tindakan</p>
                        <h2 className="ui-text mt-1 text-xl font-black">Prioritas Operasional</h2>
                    </div>
                    <p className="ui-text-muted text-xs">Update: {formatDateTime(dashboard.lastUpdatedAt)}</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
                    {actionRequiredCards.map((item) => (
                        <Link
                            key={item.title}
                            to={item.to}
                            className={`rounded-2xl border p-4 transition hover:-translate-y-0.5 hover:brightness-105 ${item.tone}`}
                        >
                            <p className="text-[11px] font-bold uppercase tracking-[0.16em] opacity-80">{item.title}</p>
                            <p className="mt-2 text-3xl font-black">{formatNumber(item.value)}</p>
                            <p className="mt-1 text-xs opacity-80">{item.note}</p>
                        </Link>
                    ))}
                </div>
            </section>

            <section className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
                {[
                    { label: 'Trx Hari Ini', value: quickStats?.today || 0, sub: 'Sukses', icon: TrendingUp, color: 'text-[var(--ui-chart-2)]', bg: 'bg-[color-mix(in_srgb,var(--ui-chart-2)_14%,transparent)]' },
                    { label: 'Trx Kemarin', value: quickStats?.yesterday || 0, sub: 'Sukses', icon: Activity, color: 'text-[var(--ui-chart-3)]', bg: 'bg-[color-mix(in_srgb,var(--ui-chart-3)_14%,transparent)]' },
                    { label: 'Trx Bulan Ini', value: quickStats?.thisMonth || 0, sub: 'Sukses', icon: Calendar, color: 'text-[var(--ui-chart-5)]', bg: 'bg-[color-mix(in_srgb,var(--ui-chart-5)_14%,transparent)]' },
                    { label: 'Trx Bulan Lalu', value: quickStats?.lastMonth || 0, sub: 'Sukses', icon: Calendar, color: 'ui-accent-text', bg: 'bg-[var(--ui-accent-soft)]' }
                ].map((item) => (
                    <div key={item.label} className="ui-panel group relative overflow-hidden rounded-2xl border p-4 transition hover:-translate-y-0.5 hover:border-[color-mix(in_srgb,var(--ui-accent)_38%,transparent)]">
                        <item.icon className={`absolute -bottom-5 -right-3 h-24 w-24 ${item.color} opacity-[0.06] transition group-hover:scale-110`} />
                        <div className="relative flex items-start justify-between gap-4">
                            <div>
                                <p className="ui-text-muted text-[11px] font-bold uppercase tracking-[0.18em]">{item.label}</p>
                                <p className="ui-text mt-3 text-4xl font-black leading-none">{formatNumber(item.value)}</p>
                                <p className={`mt-2 inline-flex items-center gap-1 text-xs font-bold ${item.color}`}>
                                    <BadgeCheck className="h-3.5 w-3.5" /> {item.sub}
                                </p>
                            </div>
                            <div className={`rounded-2xl p-3 ${item.bg} ${item.color}`}>
                                <item.icon className="h-5 w-5" />
                            </div>
                        </div>
                    </div>
                ))}
            </section>

            <section className="ui-panel rounded-[24px] border p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                        <p className="ui-info-text text-xs font-black uppercase tracking-[0.22em]">Snapshot Operasional API v2</p>
                        <h3 className="ui-text mt-2 text-xl font-black">Ringkasan MongoDB Read-only</h3>
                        <p className="ui-text-muted mt-1 text-xs">
                            Ringkasan ringan dari Rust API v2, tidak mengganti dashboard utama.
                        </p>
                    </div>
                    <button
                        onClick={() => {
                            fetchOpsSnapshot();
                            fetchNotificationSummary();
                        }}
                        className="ui-muted-action inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs font-black"
                    >
                        <RefreshCw className="h-3.5 w-3.5" /> Segarkan
                    </button>
                </div>

                {opsSnapshotError ? (
                    <div className="ui-warning-chip mt-4 rounded-2xl border px-4 py-3 text-xs font-semibold">
                        {opsSnapshotError}
                    </div>
                ) : null}
                {notificationSummaryError ? (
                    <div className="ui-warning-chip mt-3 rounded-2xl border px-4 py-3 text-xs font-semibold">
                        {notificationSummaryError}
                    </div>
                ) : null}

                {opsSnapshot ? (
                    <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                        <div className="ui-panel-muted ui-border rounded-2xl border p-4">
                            <p className="ui-text-muted text-[10px] font-bold uppercase tracking-[0.16em]">Trx Hari Ini</p>
                            <p className="ui-text mt-2 text-3xl font-black">{formatNumber(opsSnapshot.transactions_today.total)}</p>
                            <p className="ui-success-text mt-1 text-xs font-bold">
                                {formatNumber(opsSnapshot.transactions_today.success)} sukses, {opsSnapshot.transactions_today.success_rate}% rate
                            </p>
                        </div>
                        <div className="ui-panel-muted ui-border rounded-2xl border p-4">
                            <p className="ui-text-muted text-[10px] font-bold uppercase tracking-[0.16em]">Omset Hari Ini</p>
                            <p className="ui-text mt-2 text-3xl font-black">{formatCurrency(opsSnapshot.transactions_today.omset)}</p>
                            <p className="ui-warning-text mt-1 text-xs font-bold">
                                {formatNumber(opsSnapshot.transactions_today.pending)} pending/proses
                            </p>
                        </div>
                        <div className="ui-panel-muted ui-border rounded-2xl border p-4">
                            <p className="ui-text-muted text-[10px] font-bold uppercase tracking-[0.16em]">Deposit Pending</p>
                            <p className="ui-text mt-2 text-3xl font-black">{formatNumber(opsSnapshot.deposits.pending)}</p>
                            <p className="ui-info-text mt-1 text-xs font-bold">
                                {formatCurrency(opsSnapshot.deposits.pending_transfer_total)} transfer
                            </p>
                        </div>
                        <div className="ui-panel-muted ui-border rounded-2xl border p-4">
                            <p className="ui-text-muted text-[10px] font-bold uppercase tracking-[0.16em]">Vendor & Stuck</p>
                            <p className="ui-text mt-2 text-3xl font-black">{formatNumber(opsSnapshot.vendors.active)}/{formatNumber(opsSnapshot.vendors.total)}</p>
                            <p className="ui-warning-text mt-1 text-xs font-bold">
                                {formatNumber(opsSnapshot.stuck.total)} stuck &gt; {opsSnapshot.stuck.threshold_minutes}m
                            </p>
                        </div>
                    </div>
                ) : !opsSnapshotError ? (
                    <div className="ui-panel-muted ui-border mt-5 rounded-2xl border px-4 py-8 text-center">
                        <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-[color-mix(in_srgb,var(--ui-info)_28%,transparent)] border-t-[var(--ui-info)]" />
                        <p className="ui-text-muted mt-3 text-xs font-semibold">Memuat snapshot API v2...</p>
                    </div>
                ) : null}

                {notificationSummary ? (
                    <div className="ui-panel-muted ui-border mt-3 rounded-2xl border p-4">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                                <p className="ui-text-muted text-[10px] font-bold uppercase tracking-[0.16em]">Ringkasan Notifikasi</p>
                                <p className="ui-text mt-1 text-sm font-black">
                                    {formatNumber(notificationSummary.unread)} belum dibaca dari {formatNumber(notificationSummary.total)} alert aktif
                                </p>
                            </div>
                            <Link to="/admin/notifications" className="ui-accent-text inline-flex items-center gap-1 text-xs font-black transition hover:brightness-125">
                                Buka Pusat Notifikasi <ArrowRight className="h-3.5 w-3.5" />
                            </Link>
                        </div>
                        <div className="mt-3 grid gap-2 text-xs sm:grid-cols-4">
                            <div className="ui-danger-chip rounded-xl border px-3 py-2 font-black">Critical {formatNumber(notificationSummary.critical)}</div>
                            <div className="ui-warning-chip rounded-xl border px-3 py-2 font-black">Warning {formatNumber(notificationSummary.warning)}</div>
                            <div className="ui-info-chip rounded-xl border px-3 py-2 font-black">Info {formatNumber(notificationSummary.info)}</div>
                            <div className="ui-panel ui-border rounded-xl border px-3 py-2 font-black ui-text-muted">Callbacks {formatNumber(notificationSummary.categories.callbacks)}</div>
                        </div>
                    </div>
                ) : null}
            </section>

            <section className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.3fr)_minmax(360px,0.7fr)]">
                <div className="ui-panel overflow-hidden rounded-[24px] border">
                    <div className="ui-border flex flex-col gap-4 border-b p-4 lg:flex-row lg:items-end lg:justify-between lg:p-6">
                        <div>
                            <p className="ui-accent-text text-xs font-black uppercase tracking-[0.24em]">Radar Keuangan</p>
                            <h3 className="ui-text mt-2 text-2xl font-black">Omset & Profit</h3>
                            <p className="ui-text-muted mt-1 text-sm">{hasActiveRange ? `Ringkasan ${activeRangeLabel}` : 'Performa harian dan bulanan terkini.'}</p>
                        </div>
                        <div className="space-y-2">
                            <form onSubmit={handleApplyFilter} className="ui-panel-muted ui-border grid gap-2 rounded-2xl border p-2 sm:grid-cols-[1fr_1fr_auto_auto] lg:w-auto">
                                <label className="ui-panel ui-border flex items-center gap-2 rounded-xl border px-3 py-2">
                                    <Calendar className="ui-text-muted h-4 w-4" />
                                    <input
                                        type="date"
                                        value={startDate}
                                        max={endDate || undefined}
                                        aria-label="Tanggal mulai laporan"
                                        onChange={(e) => {
                                            setStartDate(e.target.value);
                                            setFilterError(null);
                                        }}
                                        className="ui-text min-w-0 bg-transparent text-xs font-semibold outline-none"
                                    />
                                </label>
                                <label className="ui-panel ui-border flex items-center gap-2 rounded-xl border px-3 py-2">
                                    <Calendar className="ui-text-muted h-4 w-4" />
                                    <input
                                        type="date"
                                        value={endDate}
                                        min={startDate || undefined}
                                        aria-label="Tanggal akhir laporan"
                                        onChange={(e) => {
                                            setEndDate(e.target.value);
                                            setFilterError(null);
                                        }}
                                        className="ui-text min-w-0 bg-transparent text-xs font-semibold outline-none"
                                    />
                                </label>
                                <button type="submit" className="ui-accent-solid rounded-xl px-4 py-2 text-xs font-black transition hover:brightness-105">Terapkan</button>
                                {(startDate || endDate) && (
                                    <button type="button" onClick={handleResetFilters} className="ui-muted-action rounded-xl px-4 py-2 text-xs font-bold">Reset</button>
                                )}
                            </form>
                            {filterError && (
                                <p className="ui-danger-text px-2 text-xs font-bold" role="alert">{filterError}</p>
                            )}
                        </div>
                    </div>

                    <div className="grid gap-5 p-4 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:p-6">
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
                            {financePrimaryCards.map((stat) => (
                                <div key={`${stat.title}-${stat.sub}`} className={`relative overflow-hidden rounded-2xl border p-4 ${stat.highlight ? 'ui-accent-chip' : 'ui-panel-muted ui-border'}`}>
                                    <stat.icon className="absolute -bottom-3 -right-2 h-16 w-16 opacity-10" />
                                    <div className="relative flex items-start justify-between gap-3">
                                        <div>
                                            <p className="ui-text-muted text-[10px] font-bold uppercase tracking-[0.16em]">{stat.title}</p>
                                            <p className={`mt-1 text-xs font-bold ${stat.profit ? 'ui-success-text' : 'ui-info-text'}`}>{stat.sub}</p>
                                        </div>
                                        <div className={`rounded-xl border p-2 ${stat.profit ? 'ui-success-chip' : 'ui-info-chip'}`}>
                                            <stat.icon className="h-4 w-4" />
                                        </div>
                                    </div>
                                    <p className="ui-text relative mt-5 text-2xl font-black">{formatCardValue(stat)}</p>
                                </div>
                            ))}
                        </div>

                        <div className="flex min-h-[360px] flex-col rounded-2xl border ui-border ui-panel-muted p-4">
                            <div className="flex items-center justify-between gap-3">
                                <div>
                                    <h4 className="ui-text text-sm font-black">{hasActiveRange ? 'Trend Periode' : 'Trend 7 Hari'}</h4>
                                    <p className="ui-text-muted mt-1 text-xs">{hasActiveRange ? activeRangeLabel : 'Omset harian terbaru'}</p>
                                </div>
                                {canViewSalesReport && (
                                    <Link to="/admin/sales-report" className="ui-accent-text inline-flex items-center gap-1 text-xs font-black transition hover:brightness-125">
                                        Detail <ArrowRight className="h-3.5 w-3.5" />
                                    </Link>
                                )}
                            </div>

                            <div className="relative mt-5 min-h-[260px] flex-1 overflow-hidden rounded-xl border ui-border bg-[var(--ui-card-bg)]">
                                {omsetChart ? (
                                    <div className="absolute inset-0 flex items-end p-4">
                                        <svg viewBox={`0 0 ${omsetChart.width} ${omsetChart.height}`} className="h-full w-full overflow-visible" preserveAspectRatio="none">
                                            <defs>
                                                <linearGradient id="omsetGradient" x1="0" y1="0" x2="0" y2="1">
                                                    <stop offset="0%" stopColor="var(--ui-accent)" stopOpacity="0.45" />
                                                    <stop offset="100%" stopColor="var(--ui-accent)" stopOpacity="0" />
                                                </linearGradient>
                                            </defs>
                                            <path d={omsetChart.area} fill="url(#omsetGradient)" />
                                            <path d={omsetChart.line} fill="none" stroke="var(--ui-accent)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                                            {omsetChart.points.map((point, index) => (
                                                <circle key={index} cx={point.x} cy={point.y} r="3.5" fill="var(--ui-card-bg)" stroke="var(--ui-accent)" strokeWidth="2" />
                                            ))}
                                        </svg>
                                    </div>
                                ) : (
                                    <div className="ui-text-muted absolute inset-0 flex items-center justify-center text-xs">Tidak ada data chart untuk periode ini</div>
                                )}
                            </div>
                        </div>
                    </div>

                    <div className="ui-border grid gap-3 border-t p-4 sm:grid-cols-2 lg:grid-cols-4 lg:p-6">
                        {financeSecondaryStats.map((item) => (
                            <div key={item.label} className="ui-panel-muted ui-border rounded-2xl border p-4">
                                <p className="ui-text-muted text-[10px] font-bold uppercase tracking-[0.16em]">{item.label}</p>
                                <p className={`mt-2 text-sm font-black ${item.tone}`}>{item.value}</p>
                            </div>
                        ))}
                    </div>
                </div>

                <div className="flex min-w-0 flex-col gap-5">
                    <div className="ui-panel rounded-[24px] border p-5">
                        <div className="flex items-start justify-between gap-4">
                            <div>
                                <p className="ui-accent-text text-xs font-black uppercase tracking-[0.2em]">Status Data</p>
                                <h3 className="ui-text mt-2 text-xl font-black">Pipeline Operasional</h3>
                            </div>
                            <Activity className="ui-accent-text h-5 w-5" />
                        </div>

                        <div className="mt-5 space-y-3">
                            {[
                                { label: 'Pending / Proses', value: summary?.pendingTransactions || 0, tone: 'ui-warning-chip' },
                                { label: 'Gagal', value: summary?.failedTransactions || 0, tone: 'ui-danger-chip' },
                                { label: 'Sukses', value: summary?.successTransactions || 0, tone: 'ui-success-chip' }
                            ].map((item) => (
                                <div key={item.label} className="ui-panel-muted ui-border flex items-center justify-between rounded-2xl border p-4">
                                    <span className="ui-text-muted text-sm font-semibold">{item.label}</span>
                                    <span className={`rounded-full border px-3 py-1 text-sm font-black ${item.tone}`}>{formatNumber(item.value)}</span>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="ui-panel rounded-[24px] border p-5">
                        <div className="flex items-start justify-between gap-4">
                            <div>
                                <p className="ui-info-text text-xs font-black uppercase tracking-[0.2em]">Seller Callback Queue</p>
                                <h3 className="ui-text mt-2 text-xl font-black">Retry Callback</h3>
                                <p className="ui-text-muted mt-1 text-xs">Antrian callback Digiflazz Seller yang perlu dikirim ulang.</p>
                            </div>
                            <Webhook className="ui-info-text h-5 w-5" />
                        </div>

                        <div className="mt-5 grid gap-3 sm:grid-cols-3">
                            <div className={`rounded-2xl border p-4 ${sellerCallbackQueue.due > 0 ? 'ui-danger-chip' : 'ui-success-chip'}`}>
                                <p className="text-[10px] font-bold uppercase tracking-[0.16em] opacity-80">Retry Due</p>
                                <p className="mt-2 text-3xl font-black">{formatNumber(sellerCallbackQueue.due)}</p>
                                <p className="mt-1 text-xs opacity-80">siap diproses queue</p>
                            </div>
                            <div className={`rounded-2xl border p-4 ${sellerCallbackQueue.highAttempt > 0 ? 'ui-danger-chip' : 'ui-success-chip'}`}>
                                <p className="text-[10px] font-bold uppercase tracking-[0.16em] opacity-80">High Attempt</p>
                                <p className="mt-2 text-3xl font-black">{formatNumber(sellerCallbackQueue.highAttempt)}</p>
                                <p className="mt-1 text-xs opacity-80">&gt;= {sellerCallbackQueue.highAttemptThreshold} percobaan</p>
                            </div>
                            <div className={`rounded-2xl border p-4 ${sellerCallbackQueue.pending > 0 ? 'ui-warning-chip' : 'ui-success-chip'}`}>
                                <p className="text-[10px] font-bold uppercase tracking-[0.16em] opacity-80">Pending Callback</p>
                                <p className="mt-2 text-3xl font-black">{formatNumber(sellerCallbackQueue.pending)}</p>
                                <p className="mt-1 text-xs opacity-80">menunggu callback final</p>
                            </div>
                        </div>

                        <div className="ui-panel-muted ui-border mt-3 rounded-2xl border p-4">
                            <div className="flex flex-wrap items-center justify-between gap-3">
                                <div>
                                    <p className="ui-text-muted text-[10px] font-bold uppercase tracking-[0.16em]">Scheduler Health</p>
                                    <p className="ui-text mt-1 text-sm font-black">
                                        {retryQueueHealth?.status === 'never'
                                            ? 'Belum pernah jalan'
                                            : retryQueueHealth?.lastRunAt
                                                ? formatDateTime(retryQueueHealth.lastRunAt)
                                                : '-'}
                                    </p>
                                </div>
                                <span className={`rounded-full border px-3 py-1 text-xs font-black ${retryQueueHealth?.status === 'failed' ? 'ui-danger-chip' : retryQueueHealth?.status === 'partial' ? 'ui-warning-chip' : retryQueueHealth?.status === 'success' ? 'ui-success-chip' : 'ui-panel ui-border ui-text-muted'}`}>
                                    {(retryQueueHealth?.status || 'never').toUpperCase()}
                                </span>
                            </div>
                            <div className="mt-3 grid grid-cols-3 gap-2 text-xs ui-text-muted">
                                <div>Processed <span className="ui-text font-black">{formatNumber(retryQueueHealth?.processed || 0)}</span></div>
                                <div>Success <span className="ui-success-text font-black">{formatNumber(retryQueueHealth?.successCount || 0)}</span></div>
                                <div>Failed <span className="ui-danger-text font-black">{formatNumber(retryQueueHealth?.failedCount || 0)}</span></div>
                            </div>
                            {retryQueueHealth?.lastError ? (
                                <p className="ui-danger-text mt-2 text-xs font-semibold">{retryQueueHealth.lastError}</p>
                            ) : null}
                        </div>

                        <div className="mt-4 grid gap-2 sm:grid-cols-2">
                            <Link
                                to="/admin/transactions?mode=seller&callback=due"
                                className="ui-accent-solid inline-flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-xs font-black transition hover:brightness-105"
                            >
                                Lihat Due <ArrowRight className="h-3.5 w-3.5" />
                            </Link>
                            <Link
                                to="/admin/addons/digiflazz-seller"
                                className="ui-muted-action inline-flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-xs font-black"
                            >
                                Seller Center <ArrowRight className="h-3.5 w-3.5" />
                            </Link>
                        </div>
                    </div>

                    <div className="ui-panel rounded-[24px] border p-5">
                        <div className="flex items-start justify-between gap-4">
                            <div>
                                <p className="ui-warning-text text-xs font-black uppercase tracking-[0.2em]">Stuck Monitor</p>
                                <div className="mt-2 flex flex-wrap items-center gap-2">
                                    <h3 className="ui-text text-xl font-black">Transaksi Macet</h3>
                                    <span className="ui-panel-muted ui-border rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-wide ui-text-muted">
                                        {stuckSource === 'api-v2' ? 'API v2' : 'Fallback v1'}
                                    </span>
                                </div>
                                <p className="ui-text-muted mt-1 text-xs">
                                    Pending/proses lebih dari {stuckData?.thresholdMinutes || 15} menit.
                                </p>
                            </div>
                            <button
                                onClick={fetchStuckTransactions}
                                disabled={stuckLoading}
                                className="ui-muted-action inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
                                title="Refresh transaksi macet"
                            >
                                <RefreshCw className={`h-4 w-4 ${stuckLoading ? 'animate-spin' : ''}`} />
                            </button>
                        </div>

                        <div className="mt-5">
                            {stuckError && (
                                <div className="ui-danger-chip mb-3 rounded-2xl border px-3 py-2 text-xs font-semibold">
                                    {stuckError}
                                </div>
                            )}

                            {stuckLoading && !stuckData ? (
                                <div className="ui-panel-muted ui-border rounded-2xl border px-4 py-8 text-center">
                                    <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-[color-mix(in_srgb,var(--ui-warning)_28%,transparent)] border-t-[var(--ui-warning)]" />
                                    <p className="ui-text-muted mt-3 text-xs font-semibold">Memuat monitor...</p>
                                </div>
                            ) : stuckData && stuckData.items.length > 0 ? (
                                <div className="space-y-3">
                                    <div className="ui-warning-chip flex items-center justify-between rounded-2xl border px-4 py-3">
                                        <span className="inline-flex items-center gap-2 text-sm font-black">
                                            <AlertTriangle className="h-4 w-4" />
                                            {formatNumber(stuckData.total)} butuh perhatian
                                        </span>
                                        <Link to="/admin/transactions?status=pending,processing" className="text-xs font-black underline underline-offset-4">
                                            Lihat semua
                                        </Link>
                                    </div>

                                    {stuckData.items.map((trx) => (
                                        <div key={trx._id} className="ui-panel-muted ui-border rounded-2xl border p-4">
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="min-w-0">
                                                    <p className="ui-text truncate text-sm font-black">{trx.product?.name || 'Produk tidak diketahui'}</p>
                                                    <p className="ui-text-muted mt-1 truncate text-xs">{trx.user?.name || trx.user?.email || 'Unknown'} • {trx.target}</p>
                                                </div>
                                                <span className="ui-warning-chip rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-wide">
                                                    {trx.ageMinutes}m
                                                </span>
                                            </div>

                                            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
                                                <span className="ui-panel ui-border rounded-full border px-2.5 py-1 font-bold ui-text-muted">{trx.status}</span>
                                                <span className="ui-panel ui-border rounded-full border px-2.5 py-1 font-bold ui-text-muted">{formatCurrency(trx.amount || 0)}</span>
                                                {getVendorName(trx.product?.vendor) && (
                                                    <span className="ui-panel ui-border rounded-full border px-2.5 py-1 font-bold ui-text-muted">{getVendorName(trx.product?.vendor)}</span>
                                                )}
                                            </div>

                                            <div className="mt-4 grid gap-2 sm:grid-cols-2">
                                                {canProcessManualTransaction && (
                                                    <button
                                                        onClick={() => handleRecheckStuckTransaction(trx._id)}
                                                        disabled={recheckingId === trx._id}
                                                        className="ui-accent-solid inline-flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-xs font-black transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-60"
                                                    >
                                                        <RefreshCw className={`h-3.5 w-3.5 ${recheckingId === trx._id ? 'animate-spin' : ''}`} />
                                                        Cek Vendor
                                                    </button>
                                                )}
                                                <Link
                                                    to={`/admin/transactions?search=${encodeURIComponent(trx._id)}`}
                                                    className="ui-muted-action inline-flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-xs font-black"
                                                >
                                                    Detail <ArrowRight className="h-3.5 w-3.5" />
                                                </Link>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div className="ui-success-chip rounded-2xl border px-4 py-8 text-center">
                                    <BadgeCheck className="mx-auto h-8 w-8" />
                                    <p className="mt-3 text-sm font-black">Tidak ada transaksi macet</p>
                                    <p className="mt-1 text-xs opacity-80">Pipeline pending/proses masih dalam batas normal.</p>
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="ui-accent-solid relative overflow-hidden rounded-[24px] p-5 shadow-lg">
                        <ShoppingCart className="absolute -bottom-4 -right-2 h-28 w-28 rotate-12 opacity-15" />
                        <div className="relative">
                            <p className="text-xs font-bold uppercase tracking-[0.18em] opacity-80">{hasActiveRange ? 'Omset Periode' : 'Total Omset'}</p>
                            <p className="mt-3 text-3xl font-black leading-none">{formatCurrency(summary?.totalOmset || 0)}</p>
                            <div className="mt-5 flex items-center justify-between gap-3 border-t border-[color:var(--ui-on-accent)]/20 pt-4">
                                <span className="text-xs font-bold opacity-85">Profit</span>
                                <span className="rounded-full bg-[color:var(--ui-on-accent)]/20 px-3 py-1 text-sm font-black">{formatCurrency(summary?.totalProfit || 0)}</span>
                            </div>
                        </div>
                    </div>

                    <div className="ui-panel-muted ui-border rounded-[24px] border p-5">
                        <p className="ui-text-muted text-xs font-bold uppercase tracking-[0.18em]">Operational Note</p>
                        <p className="ui-text mt-3 text-sm leading-7">
                            Gunakan filter periode untuk investigasi tren transaksi, lalu buka laporan lengkap untuk breakdown detail per tanggal.
                        </p>
                        {canViewSalesReport && (
                            <Link to="/admin/sales-report" className="ui-muted-action mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-bold">
                                Buka Sales Report <ArrowRight className="h-4 w-4" />
                            </Link>
                        )}
                    </div>
                </div>
            </section>
        </div>
    );
}
