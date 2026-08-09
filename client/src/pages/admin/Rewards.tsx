import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiV2 } from '../../api';
import {
    Gift,
    Plus,
    Edit2,
    Trash2,
    Search,
    X,
    Package,
    Sparkles,
    AlertCircle,
    Settings,
    Save,
    Info,
    ChevronLeft,
    ChevronRight,
    Copy,
    Power,
    TrendingUp,
    TrendingDown
} from 'lucide-react';
import ImagePickerField from '../../components/admin/ImagePickerField';
import { getAssetUrl } from '../../lib/assetUrl';

interface Reward {
    _id: string;
    name: string;
    description: string;
    pointsRequired: number;
    stock: number;
    imageUrl?: string;
    category: string;
    status: boolean;
    createdAt: string;
    updatedAt: string;
}

interface PointTransaction {
    _id: string;
    user?: { name?: string; email?: string };
    type: 'earn' | 'redeem' | 'admin_adjustment';
    points: number;
    description: string;
    relatedReward?: { name: string } | null;
    createdAt: string;
}

interface PointsStats {
    totalPointsEarned: number;
    totalPointsRedeemed: number;
    activeUsers: number;
    totalUsers: number;
    engagementRate: number;
}

interface PointsSetting {
    _id: string;
    key: string;
    value: number;
    description?: string;
    pointValueRate?: number;
}

interface TransactionsMeta {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
}

const CATEGORIES = ['Pulsa', 'Voucher', 'Merchandise', 'E-Wallet', 'Lainnya'];
const HISTORY_PAGE_SIZE = 12;
const POINTS_UNIT_AMOUNT = 10000;
const isValidHttpUrl = (value: string) => {
    if (!value.trim()) return true;
    try {
        const url = new URL(value.trim());
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
};

export default function Rewards() {
    const [searchParams, setSearchParams] = useSearchParams();
    const initialTab = searchParams.get('tab');
    const [rewards, setRewards] = useState<Reward[]>([]);
    const [transactions, setTransactions] = useState<PointTransaction[]>([]);
    const [stats, setStats] = useState<PointsStats | null>(null);
    const [loading, setLoading] = useState(true);
    const [search, setSearch] = useState(() => searchParams.get('q') || '');
    const [showModal, setShowModal] = useState(false);
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [selectedReward, setSelectedReward] = useState<Reward | null>(null);
    const [activeTab, setActiveTab] = useState<'settings' | 'rewards' | 'history'>(
        initialTab === 'rewards' || initialTab === 'history' ? initialTab : 'settings'
    );
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const [lowStockOnly, setLowStockOnly] = useState(false);
    const [togglingId, setTogglingId] = useState<string | null>(null);
    const [historyType, setHistoryType] = useState<'' | 'earn' | 'redeem' | 'admin_adjustment'>('redeem');
    const [historyUserQuery, setHistoryUserQuery] = useState('');

    // Points Settings State
    const [pointsSetting, setPointsSetting] = useState<PointsSetting | null>(null);
    const [pointsValue, setPointsValue] = useState<number>(100);
    const [pointValueRate, setPointValueRate] = useState<number>(1);
    const [savingPoints, setSavingPoints] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const latestDataRequestId = useRef(0);
    const latestHistoryRequestId = useRef(0);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [historyPage, setHistoryPage] = useState(() => Math.max(1, Number(searchParams.get('page')) || 1));
    const [historyMeta, setHistoryMeta] = useState<TransactionsMeta>({
        page: 1,
        limit: HISTORY_PAGE_SIZE,
        total: 0,
        totalPages: 1
    });

    const [formData, setFormData] = useState({
        name: '',
        description: '',
        pointsRequired: 0,
        stock: 0,
        imageUrl: '',
        category: 'Lainnya',
        status: true
    });

    const fetchData = useCallback(async () => {
        const requestId = latestDataRequestId.current + 1;
        latestDataRequestId.current = requestId;

        try {
            setLoading(true);
            const [rewardsRes, statsRes, settingsRes] = await Promise.all([
                apiV2.get('/rewards/admin/all'),
                apiV2.get('/points/stats'),
                apiV2.get('/points/settings')
            ]);
            if (requestId !== latestDataRequestId.current) return;
            setRewards(rewardsRes.data);
            setStats(statsRes.data);
            setPointsSetting(settingsRes.data);
            setPointsValue(settingsRes.data.value);
            setPointValueRate(settingsRes.data.pointValueRate || 1);
        } catch (error) {
            if (requestId !== latestDataRequestId.current) return;
            console.error('Failed to fetch data', error);
            setMessage({ type: 'error', text: 'Gagal memuat data' });
        } finally {
            if (requestId === latestDataRequestId.current) {
                setLoading(false);
            }
        }
    }, []);

    useEffect(() => {
        fetchData();
    }, [fetchData]);

    useEffect(() => {
        const handler = () => fetchData();
        window.addEventListener('admin:refresh-current-page', handler);
        return () => window.removeEventListener('admin:refresh-current-page', handler);
    }, [fetchData]);

    useEffect(() => {
        const params = new URLSearchParams(searchParams);
        params.set('tab', activeTab);
        if (search.trim()) params.set('q', search.trim()); else params.delete('q');
        if (activeTab === 'history' && historyPage > 1) params.set('page', String(historyPage)); else params.delete('page');
        setSearchParams(params, { replace: true });
    }, [activeTab, search, historyPage, searchParams, setSearchParams]);

    useEffect(() => {
        if (activeTab === 'history') {
            fetchHistory(historyPage);
        }
    }, [activeTab, historyPage, historyType]);

    const fetchHistory = async (page = 1, type = historyType) => {
        const requestId = latestHistoryRequestId.current + 1;
        latestHistoryRequestId.current = requestId;

        try {
            setHistoryLoading(true);
            const params = {
                type: type || undefined,
                page,
                limit: HISTORY_PAGE_SIZE
            };
            const response = await apiV2
                .get('/points/transactions', { params });

            if (requestId !== latestHistoryRequestId.current) return;
            setTransactions(response.data.items || []);
            setHistoryMeta(response.data.meta || {
                page,
                limit: HISTORY_PAGE_SIZE,
                total: 0,
                totalPages: 1
            });
        } catch (error) {
            if (requestId !== latestHistoryRequestId.current) return;
            console.error('Failed to fetch redeem history', error);
            setMessage({ type: 'error', text: 'Gagal memuat riwayat penukaran' });
        } finally {
            if (requestId === latestHistoryRequestId.current) {
                setHistoryLoading(false);
            }
        }
    };

    const handleSavePointsSettings = async () => {
        if (savingPoints) return;
        setSavingPoints(true);
        setMessage(null);

        try {
            await apiV2
                .put('/points/settings', { value: pointsValue, pointValueRate });
            setMessage({ type: 'success', text: 'Pengaturan poin berhasil disimpan!' });
            const res = await apiV2
                .get('/points/settings');
            setPointsSetting(res.data);
            setPointsValue(res.data.value);
            setPointValueRate(res.data.pointValueRate || 1);
            await fetchData();
        } catch (error) {
            console.error('Failed to update settings', error);
            setMessage({ type: 'error', text: 'Gagal menyimpan pengaturan poin' });
        } finally {
            setSavingPoints(false);
        }
    };

    const handleOpenModal = (reward?: Reward) => {
        if (reward) {
            setSelectedReward(reward);
            setFormData({
                name: reward.name,
                description: reward.description,
                pointsRequired: reward.pointsRequired,
                stock: reward.stock,
                imageUrl: reward.imageUrl || '',
                category: reward.category,
                status: reward.status
            });
        } else {
            setSelectedReward(null);
            setFormData({
                name: '',
                description: '',
                pointsRequired: 1,
                stock: 0,
                imageUrl: '',
                category: 'Lainnya',
                status: true
            });
        }
        setShowModal(true);
    };

    const handleCloseModal = () => {
        setShowModal(false);
        setSelectedReward(null);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setMessage(null);
        if (submitting) return;
        const imageUrl = formData.imageUrl.trim();
        if (!formData.name.trim() || !formData.description.trim() || !formData.category.trim()) {
            setMessage({ type: 'error', text: 'Nama, deskripsi, dan kategori hadiah wajib diisi' });
            return;
        }
        if (formData.pointsRequired < 1) {
            setMessage({ type: 'error', text: 'Poin hadiah minimal 1' });
            return;
        }
        if (formData.stock < 0) {
            setMessage({ type: 'error', text: 'Stok hadiah tidak boleh negatif' });
            return;
        }
        if (imageUrl && !isValidHttpUrl(imageUrl) && !imageUrl.startsWith('/')) {
            setMessage({ type: 'error', text: 'URL gambar harus diawali http://, https://, atau path /uploads dari galeri' });
            return;
        }

        try {
            setSubmitting(true);
            const payload = { ...formData, imageUrl };
            if (selectedReward) {
                await apiV2
                    .put(`/rewards/admin/${selectedReward._id}`, payload);
                setMessage({ type: 'success', text: 'Hadiah berhasil diperbarui' });
            } else {
                await apiV2
                    .post('/rewards/admin/create', payload);
                setMessage({ type: 'success', text: 'Hadiah berhasil ditambahkan' });
            }
            handleCloseModal();
            await fetchData();
        } catch (error: any) {
            setMessage({ type: 'error', text: error.response?.data?.message || 'Gagal menyimpan hadiah' });
        } finally {
            setSubmitting(false);
        }
    };

    const handleDelete = async () => {
        if (!selectedReward || deleting) return;

        try {
            setDeleting(true);
            const response = await apiV2
                .delete(`/rewards/admin/${selectedReward._id}`);
            setMessage({
                type: 'success',
                text: response.data?.archived
                    ? 'Hadiah punya riwayat penukaran, jadi diarsipkan dan dinonaktifkan.'
                    : 'Hadiah berhasil dihapus'
            });
            setShowDeleteModal(false);
            setSelectedReward(null);
            await fetchData();
        } catch (error: any) {
            setMessage({ type: 'error', text: error.response?.data?.message || 'Gagal menghapus hadiah' });
        } finally {
            setDeleting(false);
        }
    };

    const filteredRewards = useMemo(() => rewards.filter(reward => {
        const matchesSearch = reward.name.toLowerCase().includes(search.toLowerCase()) ||
            reward.category.toLowerCase().includes(search.toLowerCase());
        const matchesStock = !lowStockOnly || reward.stock <= 5;
        return matchesSearch && matchesStock;
    }), [rewards, search, lowStockOnly]);

    const filteredHistory = useMemo(() => {
        const term = historyUserQuery.trim().toLowerCase();
        if (!term) return transactions;
        return transactions.filter((trx) =>
            (trx.user?.name || '').toLowerCase().includes(term) ||
            (trx.user?.email || '').toLowerCase().includes(term)
        );
    }, [transactions, historyUserQuery]);

    const historyPointsSummary = useMemo(() => {
        return transactions.reduce(
            (acc, trx) => {
                if (trx.points >= 0) acc.in += trx.points;
                else acc.out += Math.abs(trx.points);
                return acc;
            },
            { in: 0, out: 0 }
        );
    }, [transactions]);

    const handleToggleStatus = async (reward: Reward) => {
        if (togglingId) return;
        setTogglingId(reward._id);
        setMessage(null);
        try {
            await apiV2
                .put(`/rewards/admin/${reward._id}`, { status: !reward.status });
            setMessage({ type: 'success', text: `Hadiah ${!reward.status ? 'diaktifkan' : 'dinonaktifkan'}` });
            await fetchData();
        } catch (error: any) {
            setMessage({ type: 'error', text: error.response?.data?.message || 'Gagal mengubah status hadiah' });
        } finally {
            setTogglingId(null);
        }
    };

    const handleDuplicate = (reward: Reward) => {
        setSelectedReward(null);
        setFormData({
            name: `${reward.name} (Salinan)`,
            description: reward.description,
            pointsRequired: reward.pointsRequired,
            stock: reward.stock,
            imageUrl: reward.imageUrl || '',
            category: reward.category,
            status: false
        });
        setShowModal(true);
    };

    const formatNumber = (num: number) => num.toLocaleString('id-ID');
    const formatDate = (date: string) => {
        const value = new Date(date);
        if (Number.isNaN(value.getTime())) return '-';
        return value.toLocaleDateString('id-ID', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
    };
    const historyStart = historyMeta.total === 0 ? 0 : (historyMeta.page - 1) * historyMeta.limit + 1;
    const historyEnd = historyMeta.total === 0 ? 0 : Math.min(historyMeta.page * historyMeta.limit, historyMeta.total);
    const [simAmount, setSimAmount] = useState<number | string>(50000);
    const simAmountNum = Math.max(0, Number(simAmount) || 0);
    const simPoints = Math.floor(simAmountNum / POINTS_UNIT_AMOUNT) * pointsValue;

    if (loading) {
        return (
            <div className="flex items-center justify-center h-64">
                <div className="flex flex-col items-center gap-2">
                    <div className="h-10 w-10 rounded-full border-4 border-[var(--ui-accent-soft)] border-t-[var(--ui-accent)] animate-spin" />
                    <p className="text-sm font-medium ui-text-muted">Memuat data hadiah...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            {activeTab === 'rewards' && (
                <div className="ui-panel-muted border ui-border rounded-xl p-4 flex flex-wrap gap-2">
                    <button
                        onClick={() => handleOpenModal()}
                        className="inline-flex items-center gap-2 ui-accent-solid px-4 py-2.5 rounded-xl font-semibold transition-colors"
                    >
                        <Plus className="w-5 h-5" />
                        Tambah Hadiah
                    </button>
                </div>
            )}

            {/* Message */}
            {message && (
                <div className={`p-4 rounded-lg flex items-center gap-2 border ${message.type === 'success' ? 'ui-success-chip' : 'ui-danger-chip'}`} role="alert" aria-live="polite">
                    <AlertCircle className="w-5 h-5" />
                    <span className="flex-1">{message.text}</span>
                    {message.type === 'error' && (
                        <button type="button" onClick={() => setMessage(null)} className="rounded-lg p-1 hover:bg-[var(--ui-card-muted)]" aria-label="Tutup pesan">
                            <X className="h-4 w-4" />
                        </button>
                    )}
                </div>
            )}

            {/* Stats Cards */}
            {stats && (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                    <div className="ui-panel-muted rounded-xl border ui-border p-4">
                        <p className="text-sm ui-text-muted">Total Poin Didapat</p>
                        <p className="text-2xl font-bold ui-success-text">{formatNumber(stats.totalPointsEarned)}</p>
                    </div>
                    <div className="ui-panel-muted rounded-xl border ui-border p-4">
                        <p className="text-sm ui-text-muted">Total Poin Ditukar</p>
                        <p className="text-2xl font-bold ui-info-text">{formatNumber(stats.totalPointsRedeemed)}</p>
                    </div>
                    <div className="ui-panel-muted rounded-xl border ui-border p-4">
                        <p className="text-sm ui-text-muted">User Aktif Poin</p>
                        <p className="text-2xl font-bold ui-accent-text">{formatNumber(stats.activeUsers)}</p>
                    </div>
                    <div className="ui-panel-muted rounded-xl border ui-border p-4">
                        <p className="text-sm ui-text-muted">Engagement Rate</p>
                        <p className="text-2xl font-bold ui-accent-text">{stats.engagementRate}%</p>
                    </div>
                </div>
            )}

            {/* Tabs */}
            <div className="border-b ui-border">
                <nav className="flex gap-4" role="tablist" aria-label="Navigasi manajemen poin dan hadiah">
                    <button
                        onClick={() => setActiveTab('settings')}
                        role="tab"
                        aria-selected={activeTab === 'settings'}
                        className={`pb-3 px-1 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${activeTab === 'settings' ? 'border-[var(--ui-accent)] ui-accent-text' : 'border-transparent ui-text-muted hover:text-[var(--ui-text)]'}`}
                    >
                        <Settings className="w-4 h-4" />
                        Pengaturan Poin
                    </button>
                    <button
                        onClick={() => setActiveTab('rewards')}
                        role="tab"
                        aria-selected={activeTab === 'rewards'}
                        className={`pb-3 px-1 text-sm font-medium border-b-2 transition-colors ${activeTab === 'rewards' ? 'border-[var(--ui-accent)] ui-accent-text' : 'border-transparent ui-text-muted hover:text-[var(--ui-text)]'}`}
                    >
                        Daftar Hadiah ({rewards.length})
                    </button>
                    <button
                        onClick={() => setActiveTab('history')}
                        role="tab"
                        aria-selected={activeTab === 'history'}
                        className={`pb-3 px-1 text-sm font-medium border-b-2 transition-colors ${activeTab === 'history' ? 'border-[var(--ui-accent)] ui-accent-text' : 'border-transparent ui-text-muted hover:text-[var(--ui-text)]'}`}
                    >
                        Riwayat Penukaran
                    </button>
                </nav>
            </div>

            {/* Settings Tab */}
            {activeTab === 'settings' && (
                <div className="space-y-6">
                    {/* Settings Card */}
                    <div className="ui-panel-muted rounded-xl border ui-border overflow-hidden">
                        <div className="p-6 border-b ui-border">
                            <h3 className="text-lg font-semibold ui-text">Konfigurasi Poin</h3>
                            <p className="text-sm ui-text-muted mt-1">Atur berapa poin yang didapat pelanggan per transaksi</p>
                        </div>

                        <div className="p-6 space-y-6">
                            {/* Info Box */}
                            <div className="ui-info-chip rounded-lg border p-4 flex gap-3">
                                <Info className="w-5 h-5 flex-shrink-0 mt-0.5" />
                                <div className="text-sm">
                                    <p className="font-medium mb-1">Cara Kerja Poin</p>
                                    <p className="opacity-85">Pelanggan mendapat poin secara otomatis saat transaksi berhasil. Poin dihitung berdasarkan nominal transaksi:</p>
                                    <p className="font-mono mt-2 ui-panel p-2 rounded ui-text">
                                        Poin = (Nominal Transaksi / 10.000) × Poin per Unit
                                    </p>
                                </div>
                            </div>

                            <div className="grid gap-5 lg:grid-cols-2">
                                <div className="space-y-3">
                                    <label htmlFor="pointsValue" className="block text-sm font-medium ui-text">
                                        Poin per Unit (setiap Rp 10.000)
                                    </label>
                                    <input
                                        type="number"
                                        id="pointsValue"
                                        min="1"
                                        step="1"
                                        value={pointsValue}
                                        onChange={(e) => setPointsValue(Math.max(1, parseInt(e.target.value, 10) || 1))}
                                        className="max-w-xs px-4 py-2 border rounded-lg ui-field"
                                        placeholder="Masukkan jumlah poin"
                                    />
                                    <p className="text-sm ui-text-muted">
                                        Setiap transaksi Rp 10.000 akan memberi <span className="font-semibold ui-text">{formatNumber(pointsValue)} poin</span>.
                                    </p>
                                </div>

                                <div className="space-y-3">
                                    <label htmlFor="pointValueRate" className="block text-sm font-medium ui-text">
                                        Nilai Tukar Poin (1 poin = X Rupiah)
                                    </label>
                                    <input
                                        type="number"
                                        id="pointValueRate"
                                        min="1"
                                        step="1"
                                        value={pointValueRate}
                                        onChange={(e) => setPointValueRate(Math.max(1, parseInt(e.target.value, 10) || 1))}
                                        className="max-w-xs px-4 py-2 border rounded-lg ui-field"
                                        placeholder="Masukkan nilai rupiah"
                                    />
                                    <p className="text-sm ui-text-muted">
                                        1 poin bernilai <span className="font-semibold ui-text">Rp {formatNumber(pointValueRate)}</span>.
                                    </p>
                                </div>
                            </div>

                            <div className="rounded-xl border border-[color-mix(in_srgb,var(--ui-accent)_28%,transparent)] bg-[var(--ui-accent-soft)] p-4 text-sm ui-text">
                                <p className="font-medium ui-accent-text">Simulasi kurs</p>
                                <div className="mt-2 flex items-center gap-2">
                                    <span className="ui-text-muted text-sm">Nominal transaksi</span>
                                    <div className="relative max-w-[180px]">
                                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs ui-text-muted">Rp</span>
                                        <input
                                            type="number"
                                            min={0}
                                            step={1000}
                                            value={simAmount}
                                            onChange={(e) => setSimAmount(e.target.value)}
                                            className="w-full rounded-lg border ui-field pl-8 pr-2 py-1.5 text-sm font-mono"
                                            aria-label="Nominal simulasi transaksi"
                                        />
                                    </div>
                                </div>
                                <p className="mt-2 ui-text-muted">
                                    Transaksi Rp {formatNumber(simAmountNum)} menghasilkan <span className="font-semibold ui-text">{formatNumber(simPoints)} poin</span>.
                                </p>
                                <p className="mt-1 ui-text-muted">
                                    Nilai tukarnya sekitar <span className="font-semibold ui-text">Rp {formatNumber(simPoints * pointValueRate)}</span>
                                    {simAmountNum > 0 && simPoints > 0 ? (
                                        <span> ({((simPoints * pointValueRate) / simAmountNum * 100).toFixed(2)}% dari nominal)</span>
                                    ) : null}.
                                </p>
                            </div>

                            {/* Save Button */}
                            <div className="pt-2">
                                <button
                                    onClick={handleSavePointsSettings}
                                    disabled={savingPoints || (pointsValue === pointsSetting?.value && pointValueRate === (pointsSetting?.pointValueRate || 1))}
                                    className="ui-accent-solid px-6 py-2 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                                >
                                    <Save className="w-4 h-4" />
                                    {savingPoints ? 'Menyimpan...' : 'Simpan Pengaturan'}
                                </button>
                            </div>
                        </div>
                    </div>

                    {/* Additional Info */}
                    <div className="ui-warning-chip rounded-lg border p-4">
                        <h4 className="font-medium mb-2 flex items-center gap-2">
                            <Info className="w-4 h-4" />
                            Catatan
                        </h4>
                        <p className="text-sm opacity-85">
                            Poin secara otomatis diberikan ke pelanggan saat transaksi mereka berhasil. Sistem poin membantu meningkatkan loyalitas dan engagement pelanggan dengan platform Anda.
                        </p>
                    </div>
                </div>
            )}

            {activeTab === 'rewards' && (
                <>
                    {/* Search */}
                    <div className="flex flex-wrap items-center gap-3">
                        <div className="relative max-w-md flex-1 min-w-[240px]">
                            <label htmlFor="reward-search" className="sr-only">Cari hadiah</label>
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 ui-text-muted" />
                            <input
                                id="reward-search"
                                type="text"
                                placeholder="Cari hadiah..."
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                className="w-full pl-10 pr-4 py-2 border rounded-lg ui-field"
                            />
                        </div>
                        <label className="flex items-center gap-2 rounded-lg ui-panel border ui-border px-3 py-2 text-sm ui-text cursor-pointer">
                            <input
                                type="checkbox"
                                checked={lowStockOnly}
                                onChange={(e) => setLowStockOnly(e.target.checked)}
                                className="h-4 w-4 accent-[var(--ui-accent)]"
                            />
                            Stok menipis (≤5)
                        </label>
                    </div>

                    {/* Rewards Grid */}
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {filteredRewards.map((reward) => (
                            <div key={reward._id} className="ui-panel-muted rounded-xl border ui-border overflow-hidden">
                                {reward.imageUrl ? (
                                    <img src={reward.imageUrl.startsWith('http') ? reward.imageUrl : getAssetUrl(reward.imageUrl)} alt={reward.name} referrerPolicy="no-referrer" className="w-full h-40 object-cover" />
                                ) : (
                                    <div className="w-full h-40 bg-[var(--ui-accent-soft)] flex items-center justify-center">
                                        <Package className="w-16 h-16 ui-accent-text opacity-60" />
                                    </div>
                                )}
                                <div className="p-4">
                                    <div className="flex items-start justify-between gap-2">
                                        <div>
                                            <h3 className="font-semibold ui-text">{reward.name}</h3>
                                            <span className="inline-block mt-1 px-2 py-0.5 ui-panel ui-text-muted text-xs rounded-full">{reward.category}</span>
                                        </div>
                                        <span className={`px-2 py-1 text-xs font-medium rounded-full ${reward.status ? 'ui-success-chip' : 'ui-panel ui-text-muted'}`}>
                                            {reward.status ? 'Aktif' : 'Nonaktif'}
                                        </span>
                                    </div>
                                    <p className="text-sm ui-text-muted mt-2 line-clamp-2">{reward.description}</p>
                                    <div className="flex items-center justify-between mt-4 pt-4 border-t ui-border">
                                        <div>
                                            <div className="flex items-center gap-1 ui-accent-text">
                                                <Sparkles className="w-4 h-4" />
                                                <span className="font-bold">{formatNumber(reward.pointsRequired)}</span>
                                                <span className="text-sm">poin</span>
                                            </div>
                                            <p className="text-xs ui-text-muted">
                                                Stok: {formatNumber(reward.stock)}
                                                {reward.stock === 0 ? (
                                                    <span className="ui-danger-chip ml-2 inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold">Habis</span>
                                                ) : reward.stock <= 5 ? (
                                                    <span className="ui-warning-chip ml-2 inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold">Menipis</span>
                                                ) : null}
                                            </p>
                                        </div>
                                        <div className="flex gap-2">
                                            <button
                                                onClick={() => handleToggleStatus(reward)}
                                                disabled={submitting || deleting || togglingId === reward._id}
                                                className={`p-2 rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                                                    reward.status
                                                        ? 'ui-warning-chip border'
                                                        : 'ui-success-chip border'
                                                }`}
                                                aria-label={reward.status ? `Nonaktifkan hadiah ${reward.name}` : `Aktifkan hadiah ${reward.name}`}
                                                title={reward.status ? 'Nonaktifkan' : 'Aktifkan'}
                                            >
                                                <Power className="w-4 h-4" />
                                            </button>
                                            <button
                                                onClick={() => handleDuplicate(reward)}
                                                disabled={submitting || deleting}
                                                className="p-2 ui-text-muted hover:text-[var(--ui-accent)] hover:bg-[var(--ui-accent-soft)] rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                                                aria-label={`Duplikat hadiah ${reward.name}`}
                                                title="Duplikat hadiah"
                                            >
                                                <Copy className="w-4 h-4" />
                                            </button>
                                            <button
                                                onClick={() => handleOpenModal(reward)}
                                                disabled={submitting || deleting}
                                                className="p-2 ui-text-muted hover:text-[var(--ui-accent)] hover:bg-[var(--ui-accent-soft)] rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                                                aria-label={`Edit hadiah ${reward.name}`}
                                            >
                                                <Edit2 className="w-4 h-4" />
                                            </button>
                                            <button
                                                onClick={() => {
                                                    setSelectedReward(reward);
                                                    setShowDeleteModal(true);
                                                }}
                                                disabled={submitting || deleting}
                                                className="ui-danger-action p-2 rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                                                aria-label={`Hapus hadiah ${reward.name}`}
                                            >
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>

                    {filteredRewards.length === 0 && (
                        <div className="text-center py-12">
                            <Gift className="w-12 h-12 ui-text-muted mx-auto mb-3" />
                            <p className="ui-text-muted">Belum ada hadiah</p>
                        </div>
                    )}
                </>
            )}

            {activeTab === 'history' && (
                <div className="ui-panel-muted rounded-xl border ui-border overflow-hidden">
                    <div className="flex flex-col gap-3 border-b ui-border px-4 py-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <div>
                                <h3 className="text-sm font-semibold ui-text">Riwayat Transaksi Poin</h3>
                                <p className="text-sm ui-text-muted">Filter per tipe transaksi dan cari user.</p>
                            </div>
                            <div className="text-xs ui-text-muted">
                                Menampilkan {historyStart}-{historyEnd} dari {formatNumber(historyMeta.total)} transaksi
                            </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            {([
                                { key: 'redeem', label: 'Redeem' },
                                { key: 'earn', label: 'Earn' },
                                { key: 'admin_adjustment', label: 'Penyesuaian Admin' },
                                { key: '', label: 'Semua' },
                            ] as const).map((item) => (
                                <button
                                    key={item.key || 'all'}
                                    type="button"
                                    onClick={() => { setHistoryType(item.key); setHistoryPage(1); }}
                                    className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                                        historyType === item.key
                                            ? 'ui-accent-chip'
                                            : 'ui-muted-action hover:border-[var(--ui-accent)]'
                                    }`}
                                >
                                    {item.label}
                                </button>
                            ))}
                            <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ui-text-muted" />
                                <input
                                    type="text"
                                    value={historyUserQuery}
                                    onChange={(e) => setHistoryUserQuery(e.target.value)}
                                    placeholder="Cari nama/email user (halaman ini)"
                                    className="w-full pl-9 pr-3 py-2 border rounded-lg ui-field text-sm"
                                />
                            </div>
                        </div>
                        <div className="flex flex-wrap gap-4 text-xs">
                            <span className="inline-flex items-center gap-1.5 ui-text-muted">
                                <TrendingUp className="w-3.5 h-3.5 ui-success-text" />
                                Poin masuk halaman ini: <span className="font-bold ui-success-text">+{formatNumber(historyPointsSummary.in)}</span>
                            </span>
                            <span className="inline-flex items-center gap-1.5 ui-text-muted">
                                <TrendingDown className="w-3.5 h-3.5 ui-danger-text" />
                                Poin keluar halaman ini: <span className="font-bold ui-danger-text">-{formatNumber(historyPointsSummary.out)}</span>
                            </span>
                        </div>
                    </div>

                    {historyLoading ? (
                        <div className="text-center py-12">
                            <div className="mx-auto mb-3 h-10 w-10 rounded-full border-4 border-[var(--ui-accent-soft)] border-t-[var(--ui-accent)] animate-spin" />
                            <p className="ui-text-muted">Memuat riwayat penukaran...</p>
                        </div>
                    ) : transactions.length > 0 ? (
                        <>
                            <div className="overflow-x-auto">
                                <table className="w-full">
                                    <thead className="ui-panel border-b ui-border">
                                        <tr>
                                            <th className="px-4 py-3 text-left text-xs font-medium ui-text-muted uppercase">User</th>
                                            <th className="px-4 py-3 text-left text-xs font-medium ui-text-muted uppercase">Hadiah</th>
                                            <th className="px-4 py-3 text-left text-xs font-medium ui-text-muted uppercase">Poin Dipakai</th>
                                            <th className="px-4 py-3 text-left text-xs font-medium ui-text-muted uppercase">Deskripsi</th>
                                            <th className="px-4 py-3 text-left text-xs font-medium ui-text-muted uppercase">Tanggal</th>
                                        </tr>
                                    </thead>
                                    <tbody className="divide-y ui-border">
                                        {filteredHistory.map((trx) => (
                                            <tr key={trx._id} className="hover:bg-[var(--ui-card-bg)]">
                                                <td className="px-4 py-3">
                                                    <p className="font-medium ui-text">{trx.user?.name || '-'}</p>
                                                    <p className="text-xs ui-text-muted">{trx.user?.email || '-'}</p>
                                                </td>
                                                <td className="px-4 py-3">
                                                    <p className="font-medium ui-text">{trx.relatedReward?.name || 'Hadiah lama / terhapus'}</p>
                                                </td>
                                                <td className="px-4 py-3">
                                                    <span className={`font-medium ${trx.points >= 0 ? 'ui-success-text' : 'ui-danger-text'}`}>
                                                        {trx.points >= 0 ? '+' : '-'}{formatNumber(Math.abs(trx.points))}
                                                    </span>
                                                    <span className="ml-2 text-[10px] uppercase ui-text-muted">{trx.type === 'admin_adjustment' ? 'penyesuaian' : trx.type}</span>
                                                </td>
                                                <td className="px-4 py-3 text-sm ui-text-muted">{trx.description}</td>
                                                <td className="px-4 py-3 text-sm ui-text-muted">{formatDate(trx.createdAt)}</td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>

                            {historyMeta.totalPages > 1 && (
                                <div className="flex flex-col gap-3 border-t ui-border px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                                    <p className="text-sm ui-text-muted">
                                        Halaman {historyMeta.page} dari {historyMeta.totalPages}
                                    </p>
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={() => setHistoryPage((current) => Math.max(1, current - 1))}
                                            disabled={historyMeta.page <= 1}
                                            className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ui-muted-action transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                                        >
                                            <ChevronLeft className="h-4 w-4" />
                                            Prev
                                        </button>
                                        <button
                                            onClick={() => setHistoryPage((current) => Math.min(historyMeta.totalPages, current + 1))}
                                            disabled={historyMeta.page >= historyMeta.totalPages}
                                            className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ui-muted-action transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                                        >
                                            Next
                                            <ChevronRight className="h-4 w-4" />
                                        </button>
                                    </div>
                                </div>
                            )}
                        </>
                    ) : (
                        <div className="text-center py-12">
                            <Sparkles className="w-12 h-12 ui-text-muted mx-auto mb-3" />
                            <p className="ui-text-muted">Belum ada riwayat penukaran poin</p>
                        </div>
                    )}
                </div>
            )}

            {/* Create/Edit Modal */}
            {showModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
                    <div className="ui-panel rounded-xl border ui-border w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto" role="dialog" aria-modal="true" aria-labelledby="reward-modal-title">
                        <div className="ui-card-gradient flex items-center justify-between p-4 border-b ui-border">
                            <h2 id="reward-modal-title" className="text-lg font-semibold ui-text">
                                {selectedReward ? 'Edit Hadiah' : 'Tambah Hadiah Baru'}
                            </h2>
                            <button type="button" onClick={handleCloseModal} className="ui-text-muted hover:text-[var(--ui-text)]" aria-label="Tutup modal hadiah">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <form onSubmit={handleSubmit} className="p-4 space-y-4">
                            <div>
                                <label htmlFor="reward-name" className="block text-sm font-medium ui-text mb-1">Nama Hadiah</label>
                                <input
                                    id="reward-name"
                                    type="text"
                                    required
                                    value={formData.name}
                                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                                    className="w-full px-3 py-2 border rounded-lg ui-field"
                                    placeholder="Contoh: Pulsa 50rb"
                                />
                            </div>
                            <div>
                                <label htmlFor="reward-description" className="block text-sm font-medium ui-text mb-1">Deskripsi</label>
                                <textarea
                                    id="reward-description"
                                    required
                                    value={formData.description}
                                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                                    className="w-full px-3 py-2 border rounded-lg ui-field"
                                    rows={3}
                                    placeholder="Deskripsi hadiah..."
                                />
                            </div>
                            <div className="grid grid-cols-2 gap-4">
                                <div>
                                    <label htmlFor="reward-points" className="block text-sm font-medium ui-text mb-1">Poin Dibutuhkan</label>
                                    <input
                                        id="reward-points"
                                        type="number"
                                        required
                                        min="1"
                                        value={formData.pointsRequired}
                                        onChange={(e) => setFormData({ ...formData, pointsRequired: Math.max(1, parseInt(e.target.value, 10) || 1) })}
                                        className="w-full px-3 py-2 border rounded-lg ui-field"
                                    />
                                </div>
                                <div>
                                    <label htmlFor="reward-stock" className="block text-sm font-medium ui-text mb-1">Stok</label>
                                    <input
                                        id="reward-stock"
                                        type="number"
                                        required
                                        min="0"
                                        value={formData.stock}
                                        onChange={(e) => setFormData({ ...formData, stock: Math.max(0, parseInt(e.target.value, 10) || 0) })}
                                        className="w-full px-3 py-2 border rounded-lg ui-field"
                                    />
                                </div>
                            </div>
                            <div>
                                <label className="block text-sm font-medium ui-text mb-1">Gambar (opsional)</label>
                                <ImagePickerField
                                    value={formData.imageUrl}
                                    onChange={(url: string) => setFormData({ ...formData, imageUrl: url })}
                                    folder="covers"
                                />
                                <p className="mt-1 text-[11px] ui-text-muted">Pilih dari galeri atau upload baru. URL manual juga bisa disimpan lewat galeri.</p>
                            </div>
                            <div>
                                <label htmlFor="reward-category" className="block text-sm font-medium ui-text mb-1">Kategori</label>
                                <select
                                    id="reward-category"
                                    value={formData.category}
                                    onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                                    className="w-full px-3 py-2 border rounded-lg ui-field"
                                >
                                    {CATEGORIES.map((cat) => (
                                        <option key={cat} value={cat}>{cat}</option>
                                    ))}
                                </select>
                            </div>
                            <div className="flex items-center gap-2">
                                <input
                                    type="checkbox"
                                    id="status"
                                    checked={formData.status}
                                    onChange={(e) => setFormData({ ...formData, status: e.target.checked })}
                                    className="w-4 h-4 text-[var(--ui-accent)] bg-[var(--ui-card-bg)] border-[var(--ui-border)] rounded focus:ring-[var(--ui-accent)]"
                                />
                                <label htmlFor="status" className="text-sm ui-text">Hadiah Aktif</label>
                            </div>
                            <div className="flex gap-3 pt-4">
                                <button
                                    type="button"
                                    onClick={handleCloseModal}
                                    disabled={submitting}
                                    className="flex-1 px-4 py-2 border ui-muted-action rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    Batal
                                </button>
                                <button
                                    type="submit"
                                    disabled={submitting || !formData.name.trim() || !formData.description.trim() || formData.pointsRequired < 1 || formData.stock < 0 || !isValidHttpUrl(formData.imageUrl)}
                                    className="flex-1 px-4 py-2 ui-accent-solid rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    {submitting ? 'Menyimpan...' : selectedReward ? 'Simpan Perubahan' : 'Tambah Hadiah'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Delete Confirmation Modal */}
            {showDeleteModal && selectedReward && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
                    <div className="ui-panel rounded-xl border ui-border w-full max-w-sm mx-4 p-6" role="dialog" aria-modal="true" aria-labelledby="delete-reward-title">
                        <div className="text-center">
                            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full border ui-danger-chip">
                                <Trash2 className="w-6 h-6 ui-danger-text" />
                            </div>
                            <h3 id="delete-reward-title" className="text-lg font-semibold ui-text mb-2">Hapus Hadiah?</h3>
                            <p className="ui-text-muted mb-6">
                                Anda yakin ingin menghapus hadiah "<span className="font-medium ui-text">{selectedReward.name}</span>"?
                                <span className="mt-2 block text-sm ui-warning-text">
                                    Jika hadiah sudah memiliki riwayat redeem, sistem akan mengarsipkannya agar histori tetap aman.
                                </span>
                            </p>
                            <div className="flex gap-3">
                                <button
                                    onClick={() => {
                                        setShowDeleteModal(false);
                                        setSelectedReward(null);
                                    }}
                                    disabled={deleting}
                                    className="flex-1 px-4 py-2 border ui-muted-action rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    Batal
                                </button>
                                <button
                                    onClick={handleDelete}
                                    disabled={deleting}
                                    className="ui-danger-action flex-1 px-4 py-2 border rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    {deleting ? 'Memproses...' : 'Hapus / Arsipkan'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
