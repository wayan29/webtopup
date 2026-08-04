import { useEffect, useEffectEvent, useState } from 'react';
import { apiV2 } from '../api';
import { useAuthStore } from '../store/useAuthStore';
import {
    Award,
    Crown,
    Loader2,
    Medal,
    RefreshCw,
    Sparkles,
    Trophy,
    Users,
    Wallet
} from 'lucide-react';

type LeaderboardPeriod = 'weekly' | 'monthly' | 'alltime';

interface LeaderboardEntry {
    _id: string;
    name: string;
    level?: string;
    totalTransactions: number;
    totalAmount: number;
    rank?: number;
    isCurrentUser?: boolean;
}

interface LeaderboardResponse {
    items?: LeaderboardEntry[];
    currentUser?: {
        id: string;
        name: string;
        rank: number;
        totalTransactions: number;
        totalAmount: number;
        inTopList: boolean;
    } | null;
    meta?: {
        period: LeaderboardPeriod;
        participantCount: number;
        totalTransactions: number;
        totalAmount: number;
        generatedAt: string;
    };
}

const periodLabels: Record<LeaderboardPeriod, string> = {
    weekly: 'Minggu Ini',
    monthly: 'Bulan Ini',
    alltime: 'Semua Waktu'
};

const getRankIcon = (rank: number) => {
    switch (rank) {
        case 1:
            return <Trophy className="h-7 w-7 text-yellow-300" />;
        case 2:
            return <Medal className="h-7 w-7 text-[var(--ui-text)]" />;
        case 3:
            return <Award className="h-7 w-7 text-amber-400" />;
        default:
            return <span className="ui-text text-sm font-bold">#{rank}</span>;
    }
};

const getRankCardClasses = (rank: number) => {
    switch (rank) {
        case 1:
            return 'border-yellow-500/20 bg-gradient-to-br from-yellow-500/15 via-[var(--ui-card-bg)] to-[var(--ui-card-muted)]';
        case 2:
            return 'border-[color-mix(in_srgb,var(--ui-text)_20%,transparent)] bg-gradient-to-br from-[color-mix(in_srgb,var(--ui-text)_10%,transparent)] via-[var(--ui-card-bg)] to-[var(--ui-card-muted)]';
        case 3:
            return 'border-amber-500/20 bg-gradient-to-br from-amber-500/10 via-[var(--ui-card-bg)] to-[var(--ui-card-muted)]';
        default:
            return 'ui-border bg-[var(--ui-card-bg)]';
    }
};

export default function Leaderboard() {
    const { user, isAuthenticated } = useAuthStore();
    const [period, setPeriod] = useState<LeaderboardPeriod>('monthly');
    const [items, setItems] = useState<LeaderboardEntry[]>([]);
    const [summary, setSummary] = useState({
        participantCount: 0,
        totalTransactions: 0,
        totalAmount: 0,
        generatedAt: ''
    });
    const [currentUser, setCurrentUser] = useState<LeaderboardResponse['currentUser']>(null);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const fetchLeaderboard = useEffectEvent(async (mode: 'initial' | 'refresh' = 'initial') => {
        if (mode === 'initial') {
            setLoading(true);
        } else {
            setRefreshing(true);
        }

        try {
            const response = await apiV2
                .get<LeaderboardResponse | LeaderboardEntry[]>(`/leaderboard?period=${period}`);
            const payload = response.data;

            if (Array.isArray(payload)) {
                const legacyItems = payload.map((item, index) => ({
                    ...item,
                    rank: index + 1,
                    isCurrentUser: user?.id === item._id
                }));

                setItems(legacyItems);
                setSummary({
                    participantCount: legacyItems.length,
                    totalTransactions: legacyItems.reduce((sum, item) => sum + item.totalTransactions, 0),
                    totalAmount: legacyItems.reduce((sum, item) => sum + item.totalAmount, 0),
                    generatedAt: new Date().toISOString()
                });
                setCurrentUser(
                    isAuthenticated
                        ? (() => {
                            const found = legacyItems.find((item) => item._id === user?.id);
                            return found
                                ? {
                                    id: found._id,
                                    name: found.name,
                                    rank: found.rank || 0,
                                    totalTransactions: found.totalTransactions,
                                    totalAmount: found.totalAmount,
                                    inTopList: true
                                }
                                : null;
                        })()
                        : null
                );
            } else {
                const resolvedItems = Array.isArray(payload.items) ? payload.items : [];
                setItems(
                    resolvedItems.map((item, index) => ({
                        ...item,
                        rank: item.rank || index + 1,
                        isCurrentUser: item.isCurrentUser || user?.id === item._id
                    }))
                );
                setSummary({
                    participantCount: Number(payload.meta?.participantCount || 0),
                    totalTransactions: Number(payload.meta?.totalTransactions || 0),
                    totalAmount: Number(payload.meta?.totalAmount || 0),
                    generatedAt: payload.meta?.generatedAt || new Date().toISOString()
                });
                setCurrentUser(payload.currentUser || null);
            }

            setError(null);
        } catch (fetchError: any) {
            console.error('Failed to fetch leaderboard', fetchError);
            setError(fetchError.response?.data?.message || 'Gagal memuat leaderboard.');
            setItems([]);
            setCurrentUser(null);
        } finally {
            if (mode === 'initial') {
                setLoading(false);
            } else {
                setRefreshing(false);
            }
        }
    });

    useEffect(() => {
        void fetchLeaderboard('initial');
    }, [period]);

    const topThree = items.slice(0, 3);
    const remainingItems = items.slice(3);
    const generatedAtLabel = summary.generatedAt
        ? new Date(summary.generatedAt).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })
        : '-';

    return (
        <div className="ui-shell min-h-screen p-4 ui-text md:p-6">
            <div className="mx-auto max-w-5xl space-y-6">
                <div className="ui-card-gradient ui-border relative overflow-hidden rounded-2xl border p-5 sm:p-6">
                    <div className="absolute inset-0 pointer-events-none">
                        <div className="absolute inset-0 opacity-30 bg-[radial-gradient(circle_at_20%_20%,rgba(250,204,21,0.18),transparent_30%),radial-gradient(circle_at_80%_10%,rgba(255,141,70,0.14),transparent_28%)]" />
                    </div>
                    <div className="relative flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
                        <div className="max-w-2xl">
                            <div className="inline-flex items-center gap-2 rounded-full border border-yellow-500/20 bg-yellow-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-yellow-200">
                                <Sparkles className="h-3.5 w-3.5" />
                                Public Ranking
                            </div>
                            <h1 className="mt-4 text-3xl font-bold ui-text">Leaderboard Member</h1>
                            <p className="mt-2 text-sm ui-text-muted sm:text-base">
                                Ranking member aktif berdasarkan total transaksi sukses pada periode yang dipilih.
                            </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {(Object.keys(periodLabels) as LeaderboardPeriod[]).map((value) => (
                                <button
                                    key={value}
                                    onClick={() => setPeriod(value)}
                                    className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
                                        period === value
                                            ? 'ui-accent-chip'
                                            : 'ui-muted-action'
                                    }`}
                                >
                                    {periodLabels[value]}
                                </button>
                            ))}
                            <button
                                onClick={() => void fetchLeaderboard('refresh')}
                                disabled={refreshing}
                                className="ui-muted-action inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
                            >
                                <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
                                Refresh
                            </button>
                        </div>
                    </div>
                </div>

                {error && (
                    <div className="rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-200">
                        {error}
                    </div>
                )}

                <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                    <div className="ui-panel ui-border rounded-xl border p-5">
                        <div className="flex items-center justify-between">
                            <p className="text-xs uppercase tracking-wide ui-text-muted">Partisipan</p>
                            <Users className="h-4 w-4 ui-text-muted" />
                        </div>
                        <p className="mt-3 text-3xl font-bold ui-text">{summary.participantCount.toLocaleString('id-ID')}</p>
                        <p className="mt-1 text-sm ui-text-muted">Member aktif yang masuk ranking {periodLabels[period].toLowerCase()}.</p>
                    </div>
                    <div className="ui-panel ui-border rounded-xl border p-5">
                        <div className="flex items-center justify-between">
                            <p className="text-xs uppercase tracking-wide ui-text-muted">Total Transaksi</p>
                            <Trophy className="h-4 w-4 ui-text-muted" />
                        </div>
                        <p className="mt-3 text-3xl font-bold ui-text">{summary.totalTransactions.toLocaleString('id-ID')}</p>
                        <p className="mt-1 text-sm ui-text-muted">
                            Data diperbarui {generatedAtLabel}.
                        </p>
                    </div>
                    <div className="ui-panel ui-border rounded-xl border p-5">
                        <div className="flex items-center justify-between">
                            <p className="text-xs uppercase tracking-wide ui-text-muted">Total Omset</p>
                            <Wallet className="h-4 w-4 ui-text-muted" />
                        </div>
                        <p className="ui-accent-text mt-3 text-3xl font-bold">Rp {summary.totalAmount.toLocaleString('id-ID')}</p>
                        <p className="mt-1 text-sm ui-text-muted">Akumulasi transaksi sukses seluruh leaderboard.</p>
                    </div>
                </div>

                {currentUser && (
                    <div className="ui-panel ui-border rounded-xl border p-5">
                        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                            <div>
                                <p className="text-xs uppercase tracking-[0.2em] text-orange-300">Posisi Kamu</p>
                                <h2 className="mt-2 text-xl font-semibold ui-text">
                                    #{currentUser.rank} · {currentUser.name}
                                </h2>
                                <p className="mt-1 text-sm ui-text-muted">
                                    {currentUser.inTopList
                                        ? 'Kamu sedang masuk 10 besar periode ini.'
                                        : 'Kamu belum masuk 10 besar, tapi posisi rank tetap sudah dihitung.'}
                                </p>
                            </div>
                            <div className="grid grid-cols-2 gap-3 text-sm">
                                <div className="ui-panel-muted ui-border rounded-xl border px-4 py-3">
                                    <p className="text-xs uppercase tracking-wide ui-text-muted">Transaksi</p>
                                    <p className="mt-1 text-lg font-semibold ui-text">{currentUser.totalTransactions.toLocaleString('id-ID')}</p>
                                </div>
                                <div className="ui-panel-muted ui-border rounded-xl border px-4 py-3">
                                    <p className="text-xs uppercase tracking-wide ui-text-muted">Omset</p>
                                    <p className="ui-accent-text mt-1 text-lg font-semibold">Rp {currentUser.totalAmount.toLocaleString('id-ID')}</p>
                                </div>
                            </div>
                        </div>
                    </div>
                )}

                {loading ? (
                    <div className="ui-panel ui-border flex min-h-[320px] items-center justify-center rounded-2xl border">
                        <Loader2 className="h-8 w-8 animate-spin ui-accent-text" />
                    </div>
                ) : items.length === 0 ? (
                    <div className="ui-panel ui-border rounded-2xl border px-6 py-16 text-center">
                        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-yellow-500/10">
                            <Crown className="h-8 w-8 text-yellow-300" />
                        </div>
                        <h2 className="mt-4 text-xl font-semibold ui-text">Leaderboard masih kosong</h2>
                        <p className="mt-2 text-sm ui-text-muted">
                            Belum ada transaksi sukses pada periode ini. Mulai transaksi untuk mengisi ranking.
                        </p>
                    </div>
                ) : (
                    <div className="space-y-6">
                        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
                            {topThree.map((entry) => (
                                <div
                                    key={entry._id}
                                    className={`rounded-2xl border p-5 ${getRankCardClasses(entry.rank || 0)}`}
                                >
                                    <div className="flex items-center justify-between">
                                        <div className="ui-panel-muted flex h-12 w-12 items-center justify-center rounded-2xl">
                                            {getRankIcon(entry.rank || 0)}
                                        </div>
                                        {entry.level && (
                                            <span className="ui-accent-chip rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide">
                                                {entry.level}
                                            </span>
                                        )}
                                    </div>
                                    <div className="mt-6 flex items-center gap-3">
                                        <div className="ui-accent-solid flex h-12 w-12 items-center justify-center rounded-full text-lg font-bold">
                                            {entry.name?.charAt(0).toUpperCase() || '?'}
                                        </div>
                                        <div className="min-w-0">
                                            <p className="truncate font-semibold ui-text">
                                                {entry.name}
                                                {entry.isCurrentUser && <span className="ml-2 text-sm text-orange-300">(Kamu)</span>}
                                            </p>
                                            <p className="text-sm ui-text-muted">{entry.totalTransactions} transaksi sukses</p>
                                        </div>
                                    </div>
                                    <div className="ui-panel-muted ui-border mt-6 rounded-xl border px-4 py-3">
                                        <p className="text-xs uppercase tracking-wide ui-text-muted">Total Omset</p>
                                        <p className="mt-2 text-2xl font-bold ui-text">Rp {entry.totalAmount.toLocaleString('id-ID')}</p>
                                    </div>
                                </div>
                            ))}
                        </div>

                        {remainingItems.length > 0 && (
                            <div className="ui-panel ui-border overflow-hidden rounded-2xl border">
                                <div className="ui-border border-b px-5 py-4">
                                    <h2 className="text-lg font-semibold ui-text">Peringkat Lainnya</h2>
                                    <p className="mt-1 text-sm ui-text-muted">Urutan setelah podium utama untuk periode {periodLabels[period].toLowerCase()}.</p>
                                </div>
                                <div className="divide-y divide-[var(--ui-border)]">
                                    {remainingItems.map((entry) => (
                                        <div key={entry._id} className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                                            <div className="flex min-w-0 items-center gap-4">
                                                <div className="ui-panel-muted flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl">
                                                    {getRankIcon(entry.rank || 0)}
                                                </div>
                                                <div className="ui-accent-solid flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-base font-bold">
                                                    {entry.name?.charAt(0).toUpperCase() || '?'}
                                                </div>
                                                <div className="min-w-0">
                                                    <p className="truncate font-medium ui-text">
                                                        {entry.name}
                                                        {entry.isCurrentUser && <span className="ml-2 text-sm text-orange-300">(Kamu)</span>}
                                                    </p>
                                                    <p className="text-sm ui-text-muted">{entry.totalTransactions} transaksi sukses</p>
                                                </div>
                                            </div>
                                            <div className="text-left sm:text-right">
                                                <p className="ui-accent-text font-semibold">Rp {entry.totalAmount.toLocaleString('id-ID')}</p>
                                                <p className="text-xs ui-text-muted">Omset total</p>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
