import { useEffect, useEffectEvent, useMemo, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
    AlertCircle,
    CreditCard,
    FileText,
    LayoutDashboard,
    LogOut,
    Menu,
    Receipt,
    RefreshCw,
    Repeat,
    Search,
    Settings,
    Trophy,
    X,
    BarChart3
} from 'lucide-react';
import { apiV2 } from '../api';
import { useAuthStore } from '../store/useAuthStore';
import { buildLegacyBalanceHistory } from '../utils/balanceHistory';
import type {
    DashboardBalanceHistoryItem,
    DashboardDeposit,
    DashboardOutletContext,
    DashboardTransaction
} from '../pages/dashboard/types';

export default function DashboardLayout() {
    const { user, logout, syncProfile } = useAuthStore();
    const location = useLocation();
    const navigate = useNavigate();
    const [isSidebarOpen, setIsSidebarOpen] = useState(false);
    const [transactions, setTransactions] = useState<DashboardTransaction[]>([]);
    const [deposits, setDeposits] = useState<DashboardDeposit[]>([]);
    const [balanceHistory, setBalanceHistory] = useState<DashboardBalanceHistoryItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);

    useEffect(() => {
        setIsSidebarOpen(false);
    }, [location.pathname]);

    const loadDashboardData = useEffectEvent(async (mode: 'initial' | 'refresh' = 'initial') => {
        if (mode === 'initial') {
            setLoading(true);
        } else {
            setRefreshing(true);
        }

        try {
            const [transactionsResponse, depositsResponse] = await Promise.all([
                apiV2.get<DashboardTransaction[]>('/transactions'),
                apiV2.get<DashboardDeposit[]>('/deposits')
            ]);

            const transactionItems = Array.isArray(transactionsResponse.data) ? transactionsResponse.data : [];
            const depositItems = Array.isArray(depositsResponse.data) ? depositsResponse.data : [];

            let historyItems: DashboardBalanceHistoryItem[] = [];
            let warningMessage: string | null = null;

            try {
                const balanceHistoryResponse = await apiV2
                    .get<DashboardBalanceHistoryItem[] | { items?: DashboardBalanceHistoryItem[] }>('/users/me/balance-history');
                const historyPayload = Array.isArray(balanceHistoryResponse.data)
                    ? balanceHistoryResponse.data
                    : balanceHistoryResponse.data?.items;
                historyItems = Array.isArray(historyPayload)
                    ? historyPayload
                    : buildLegacyBalanceHistory(transactionItems, depositItems);
            } catch (historyError: any) {
                if (historyError.response?.status === 404) {
                    historyItems = buildLegacyBalanceHistory(transactionItems, depositItems);
                    warningMessage = 'Riwayat saldo detail belum aktif di server. Dashboard memakai fallback sementara.';
                } else {
                    throw historyError;
                }
            }

            setTransactions(transactionItems);
            setDeposits(depositItems);
            setBalanceHistory(historyItems);
            setError(warningMessage);
            setLastUpdatedAt(Date.now());
        } catch (fetchError: any) {
            console.error('Failed to load dashboard data', fetchError);
            setError(fetchError.response?.data?.message || 'Gagal memuat data dashboard.');
        } finally {
            if (mode === 'initial') {
                setLoading(false);
            } else {
                setRefreshing(false);
            }
        }
    });

    useEffect(() => {
        void syncProfile();
        void loadDashboardData('initial');
    }, [syncProfile]);

    const handleRefresh = async () => {
        await Promise.all([
            syncProfile(),
            loadDashboardData('refresh')
        ]);
    };

    const handleRouteNavigate = (path: string) => {
        setIsSidebarOpen(false);
        navigate(path);
    };

    const navItems = [
        { label: 'Dashboard', to: '/dashboard', icon: LayoutDashboard, subtitle: 'Ringkasan aktivitas member' },
        { label: 'Transaksi', to: '/dashboard/history', icon: Receipt, subtitle: 'Riwayat order dan invoice' },
        { label: 'Mutasi', to: '/dashboard/mutation', icon: Repeat, subtitle: 'Arus saldo masuk dan keluar' },
        { label: 'Laporan', to: '/dashboard/report', icon: BarChart3, subtitle: 'Statistik performa akun' },
        { label: 'Top Up', to: '/dashboard/deposit', icon: CreditCard, subtitle: 'Tambah saldo akun' },
        { label: 'Cek Transaksi', to: '/dashboard/check-transaction', icon: Search, subtitle: 'Lacak invoice guest' },
        { label: 'Leaderboard', to: '/leaderboard', icon: Trophy, subtitle: 'Peringkat member aktif' },
        { label: 'Artikel', to: '/articles', icon: FileText, subtitle: 'Insight dan panduan terbaru' }
    ];

    const isActive = (path: string) => {
        if (path === '/dashboard') {
            return location.pathname === '/dashboard';
        }

        return location.pathname.startsWith(path);
    };

    const updateTimeLabel = lastUpdatedAt
        ? new Date(lastUpdatedAt).toLocaleTimeString('id-ID', {
            hour: '2-digit',
            minute: '2-digit'
        })
        : '-';
    const shouldShowBalance = user?.preferences?.showBalance !== false;
    const maskedBalance = shouldShowBalance
        ? `Rp ${user?.balance?.toLocaleString('id-ID') || '0'}`
        : 'Rp ••••••';
    const currentRoute = useMemo(() => (
        navItems
            .filter((item) => location.pathname === item.to || location.pathname.startsWith(`${item.to}/`))
            .sort((left, right) => right.to.length - left.to.length)[0]
    ), [location.pathname]);
    const currentRouteLabel = currentRoute?.label || 'Dashboard';
    const currentRouteSubtitle = currentRoute?.subtitle || 'Ringkasan aktivitas member yang lebih rapi dan nyaman dipantau.';

    const outletContext: DashboardOutletContext = {
        transactions,
        deposits,
        balanceHistory,
        loading,
        refreshing,
        error,
        lastUpdatedAt,
        refreshData: handleRefresh
    };

    return (
        <div className="ui-shell min-h-screen ui-text">
            <div className="fixed inset-x-0 top-0 z-40 border-b ui-border bg-[color-mix(in_srgb,var(--ui-body-bg)_88%,transparent)] backdrop-blur-xl lg:hidden">
                <div className="flex items-center justify-between px-4 py-3">
                    <div className="min-w-0">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.28em] ui-accent-text">Member Area</p>
                        <p className="truncate text-sm font-semibold ui-text">{currentRouteLabel}</p>
                    </div>
                    <button
                        onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                        className="rounded-full border ui-border bg-[var(--ui-card-bg)] p-2 ui-text-muted hover:bg-[var(--ui-card-muted)] hover:text-[var(--ui-text)]"
                    >
                        {isSidebarOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
                    </button>
                </div>
            </div>

            {isSidebarOpen && (
                <div
                    className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm lg:hidden"
                    onClick={() => setIsSidebarOpen(false)}
                />
            )}

            <div className="mx-auto flex max-w-[1520px] gap-5 px-4 pb-6 pt-20 lg:px-6 lg:pt-6">
                <aside className={`
                    ui-panel fixed inset-y-0 left-0 z-40 w-[272px] shrink-0 overflow-hidden rounded-r-[24px] border-r ui-border shadow-[0_20px_80px_rgba(0,0,0,0.24)]
                    transition-transform duration-300 ease-in-out lg:sticky lg:top-6 lg:h-[calc(100vh-3rem)] lg:rounded-[26px] lg:border
                    ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
                `}>
                    <div className="flex h-full flex-col p-4 pt-20 lg:pt-4">
                        <div className="rounded-[22px] border ui-border bg-[var(--ui-card-bg)]/70 p-4">
                            <div className="flex items-center gap-3">
                                <div className="ui-accent-solid flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-lg font-black shadow-lg">
                                    {user?.name?.charAt(0).toUpperCase() || 'M'}
                                </div>
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-base font-black ui-text">{user?.name || 'Member'}</p>
                                    <p className="mt-0.5 truncate text-xs ui-text-muted">{user?.email || 'Akun aktif'}</p>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => handleRouteNavigate('/settings')}
                                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border ui-border bg-[var(--ui-card-muted)] ui-text-muted transition-colors hover:bg-[var(--ui-card-bg)] hover:text-[var(--ui-text)]"
                                    title="Pengaturan"
                                >
                                    <Settings className="h-4 w-4" />
                                </button>
                            </div>
                        </div>

                        <div className="mt-4 flex-1 overflow-y-auto pr-1">
                            <div className="rounded-[22px] border ui-border bg-[var(--ui-card-bg)]/70 p-2">
                                <p className="px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.28em] ui-text-muted">Menu</p>
                                <nav className="space-y-1">
                                    {navItems.map(({ label, to, icon: Icon }) => {
                                        const active = isActive(to);
                                        const useButtonNavigation = to === '/dashboard/deposit' || to === '/dashboard/check-transaction';
                                        const itemClass = `w-full flex items-center gap-3 rounded-[18px] border px-3 py-2.5 text-left transition-all ${
                                            active
                                                ? 'ui-accent-chip shadow-[0_14px_32px_var(--ui-accent-soft)]'
                                                : 'ui-muted-action border-transparent hover:border-[var(--ui-border)] hover:bg-[var(--ui-card-muted)] hover:text-[var(--ui-text)]'
                                        }`;
                                        const content = (
                                            <>
                                                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl border transition-colors ${
                                                    active ? 'ui-accent-solid border-transparent' : 'ui-panel-muted ui-border ui-text-muted'
                                                }`}>
                                                    <Icon className="h-4 w-4" />
                                                </span>
                                                <span className={`min-w-0 truncate text-sm font-semibold ${active ? 'ui-accent-text' : 'ui-text'}`}>
                                                    {label}
                                                </span>
                                            </>
                                        );

                                        if (useButtonNavigation) {
                                            return (
                                                <button
                                                    key={label}
                                                    type="button"
                                                    onClick={() => handleRouteNavigate(to)}
                                                    className={itemClass}
                                                >
                                                    {content}
                                                </button>
                                            );
                                        }

                                        return (
                                            <Link key={label} to={to} className={itemClass}>
                                                {content}
                                            </Link>
                                        );
                                    })}
                                </nav>
                            </div>
                        </div>

                        <button
                            onClick={() => { logout(); navigate('/login'); }}
                            className="ui-danger-action mt-4 flex w-full items-center gap-3 rounded-[18px] border px-4 py-3 text-left transition-colors"
                        >
                            <LogOut className="h-4 w-4" />
                            <span className="text-sm font-semibold">Keluar</span>
                        </button>
                    </div>
                </aside>

                <main className="min-w-0 flex-1">
                    <div className="ui-panel rounded-[26px] border p-4 shadow-[0_18px_60px_rgba(0,0,0,0.22)]">
                        <div className="mb-4 rounded-[22px] border ui-border bg-[var(--ui-card-bg)]/70 p-4">
                            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                                <div className="min-w-0">
                                    <p className="ui-accent-text text-[11px] font-semibold uppercase tracking-[0.28em]">{currentRouteLabel}</p>
                                    <h1 className="mt-1 text-2xl font-black ui-text sm:text-3xl">{currentRouteLabel}</h1>
                                    <p className="mt-1 max-w-2xl text-sm leading-6 ui-text-muted">{currentRouteSubtitle}</p>
                                </div>
                                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
                                    <div className="rounded-[18px] border ui-border bg-[var(--ui-card-muted)] px-4 py-3">
                                        <p className="text-[10px] font-semibold uppercase tracking-[0.24em] ui-text-muted">Saldo</p>
                                        <p className="mt-1 text-lg font-black ui-text">{maskedBalance}</p>
                                        <p className="text-[11px] ui-text-muted">Update {updateTimeLabel}</p>
                                    </div>
                                    <button
                                        onClick={() => void handleRefresh()}
                                        disabled={loading || refreshing}
                                        className="ui-muted-action inline-flex items-center justify-center gap-2 rounded-[18px] border px-4 py-3 text-sm font-semibold disabled:opacity-50 transition-colors"
                                    >
                                        <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
                                        Refresh
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => handleRouteNavigate(location.pathname === '/dashboard/deposit' ? '/dashboard/check-transaction' : '/dashboard/deposit')}
                                        className="ui-accent-solid inline-flex items-center justify-center gap-2 rounded-[18px] px-4 py-3 text-sm font-semibold"
                                    >
                                        {location.pathname === '/dashboard/deposit' ? <Search className="h-4 w-4" /> : <CreditCard className="h-4 w-4" />}
                                        {location.pathname === '/dashboard/deposit' ? 'Cek Transaksi' : 'Top Up'}
                                    </button>
                                </div>
                            </div>
                        </div>

                        {error && (
                            <div className="mb-4 rounded-[20px] border px-4 py-4 text-sm ui-warning-chip">
                                <div className="flex items-start gap-3">
                                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 ui-warning-text" />
                                    <div className="flex-1">
                                        <p className="font-semibold">Sinkronisasi data terhambat</p>
                                        <p className="mt-1 opacity-80">{error}</p>
                                    </div>
                                    <button
                                        onClick={() => void handleRefresh()}
                                        className="ui-warning-action rounded-full px-3 py-1 text-xs font-semibold transition-colors"
                                    >
                                        Coba lagi
                                    </button>
                                </div>
                            </div>
                        )}

                        <Outlet context={outletContext} />
                    </div>
                </main>
            </div>
        </div>
    );
}
