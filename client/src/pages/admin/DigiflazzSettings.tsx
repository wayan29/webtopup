import { useState, useEffect } from 'react';
import { Save, RefreshCw, Wallet, CheckCircle, AlertCircle, Eye, EyeOff, Search, ChevronLeft, ChevronRight, Download, ShoppingCart, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { apiV2 } from '../../api';
import { useStepUpOrchestration } from '../../auth/useStepUpOrchestration';
import { stepUpActionErrorMessage } from '../../auth/withStepUp';

interface PricelistItem {
    _id: string;
    buyer_sku_code: string;
    product_name: string;
    category: string;
    brand: string;
    price: number;
    seller_product_status: boolean;
    desc?: string;
}

interface InternalPurchaseItem {
    _id: string;
    provider: 'digiflazz';
    buyerSkuCode: string;
    productName: string;
    customerNo: string;
    price: number;
    refId: string;
    status: 'pending' | 'success' | 'failed' | 'unknown';
    message?: string;
    sn?: string;
    note?: string;
    createdAt: string;
    createdBy?: {
        id?: string;
        name?: string;
        email?: string;
        role?: string;
    };
}

export default function DigiflazzSettings() {
    const stepUp = useStepUpOrchestration();
    const navigate = useNavigate();
    const [activeTab, setActiveTab] = useState<'settings' | 'pricelist' | 'webhook'>('settings');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [checkingBalance, setCheckingBalance] = useState(false);
    const [showApiKey, setShowApiKey] = useState(false);
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

    const [settings, setSettings] = useState({
        username: '',
        apiKey: '',
        configured: false
    });

    const [balance, setBalance] = useState<number | null>(null);

    // Pricelist state
    const [pricelistLoading, setPricelistLoading] = useState(false);
    const [pricelist, setPricelist] = useState<PricelistItem[]>([]);
    const [pricelistTotal, setPricelistTotal] = useState(0);
    const [pricelistPage, setPricelistPage] = useState(1);
    const [pricelistLimit] = useState(20);
    const [pricelistTotalPages, setPricelistTotalPages] = useState(0);
    const [pricelistFilters, setPricelistFilters] = useState<{ categories: string[]; brands: string[] }>({ categories: [], brands: [] });
    const [pricelistSearch, setPricelistSearch] = useState('');
    const [pricelistSku, setPricelistSku] = useState('');
    const [pricelistCategory, setPricelistCategory] = useState('');
    const [pricelistBrand, setPricelistBrand] = useState('');
    const [pricelistError, setPricelistError] = useState('');
    const [fetchingPricelist, setFetchingPricelist] = useState(false);

    // Internal purchase state
    const [selectedPurchaseItem, setSelectedPurchaseItem] = useState<PricelistItem | null>(null);
    const [purchaseCustomerNo, setPurchaseCustomerNo] = useState('');
    const [purchaseNote, setPurchaseNote] = useState('');
    const [purchaseSubmitting, setPurchaseSubmitting] = useState(false);
    const [purchaseHistory, setPurchaseHistory] = useState<InternalPurchaseItem[]>([]);
    const [purchaseHistoryLoading, setPurchaseHistoryLoading] = useState(false);

    // Webhook state
    const [webhookSecret, setWebhookSecret] = useState('');
    const [webhookWhitelistIP, setWebhookWhitelistIP] = useState('');
    const [webhookConfigured, setWebhookConfigured] = useState(false);
    const [webhookProtectionMode, setWebhookProtectionMode] = useState<'signature' | 'ip_only' | 'unprotected'>('unprotected');
    const [webhookSaving, setWebhookSaving] = useState(false);
    const [webhookLogs, setWebhookLogs] = useState<Array<{
        id: string;
        timestamp: string;
        event: string;
        refId: string;
        status: string;
        message: string;
        verified: boolean;
    }>>([]);
    const [webhookLogsLoading, setWebhookLogsLoading] = useState(false);

    useEffect(() => {
        fetchSettings();
    }, []);

    useEffect(() => {
        if (message) {
            const timer = setTimeout(() => setMessage(null), 5000);
            return () => clearTimeout(timer);
        }
    }, [message]);

    useEffect(() => {
        if (activeTab === 'pricelist') {
            fetchPricelist();
            fetchInternalPurchases();
        }
        if (activeTab === 'webhook') {
            fetchWebhookConfig();
            fetchWebhookLogs();
        }
    }, [activeTab, pricelistPage, pricelistCategory, pricelistBrand]);

    const fetchSettings = async () => {
        try {
            setLoading(true);
            const res = await apiV2
                .get('/vendors/digiflazz/settings');
            setSettings({
                username: res.data.username || '',
                apiKey: '',
                configured: res.data.configured
            });

            if (res.data.configured) {
                fetchBalance();
            }
        } catch (error) {
            console.error('Failed to fetch settings', error);
            setMessage({ type: 'error', text: 'Gagal memuat konfigurasi Digiflazz' });
        } finally {
            setLoading(false);
        }
    };

    const fetchBalance = async () => {
        try {
            setCheckingBalance(true);
            const res = await apiV2.get('/vendors/digiflazz/balance');
            setBalance(res.data.balance);
        } catch (error: any) {
            console.error('Failed to fetch balance', error);
            setMessage({ type: 'error', text: error.response?.data?.message || 'Gagal mengambil saldo' });
        } finally {
            setCheckingBalance(false);
        }
    };

    const fetchPricelist = async () => {
        try {
            setPricelistLoading(true);
            setPricelistError('');
            const params = new URLSearchParams();
            params.append('page', String(pricelistPage));
            params.append('limit', String(pricelistLimit));
            if (pricelistSearch) params.append('search', pricelistSearch);
            if (pricelistSku) params.append('sku', pricelistSku);
            if (pricelistCategory) params.append('category', pricelistCategory);
            if (pricelistBrand) params.append('brand', pricelistBrand);

            const path = `/vendors/digiflazz/pricelist?${params.toString()}`;
            const res = await apiV2.get(path);

            if (res.data.success) {
                setPricelist(res.data.data);
                setPricelistTotal(res.data.total);
                setPricelistTotalPages(res.data.totalPages);
                setPricelistFilters(res.data.filters || { categories: [], brands: [] });
            } else {
                setPricelistError(res.data.message || 'Gagal memuat pricelist');
                if (res.data.availableCollections) {
                    setPricelistError(`Collection tidak ditemukan. Collections yang tersedia: ${res.data.availableCollections.join(', ')}`);
                }
            }
        } catch (error: any) {
            console.error('Failed to fetch pricelist', error);
            setPricelistError(error.response?.data?.message || 'Gagal memuat pricelist');
        } finally {
            setPricelistLoading(false);
        }
    };

    const handleSearchPricelist = (e: React.FormEvent) => {
        e.preventDefault();
        setPricelistPage(1);
        fetchPricelist();
    };

    const handleFetchFromDigiflazz = async () => {
        if (!settings.configured) {
            setMessage({ type: 'error', text: 'Konfigurasi kredensial Digiflazz terlebih dahulu di tab Settings' });
            return;
        }
        try {
            setFetchingPricelist(true);
            setPricelistError('');
            const res = await apiV2.post('/vendors/digiflazz/pricelist/fetch');
            if (res.data.success) {
                setMessage({ type: 'success', text: res.data.message || 'Pricelist berhasil diambil dari Digiflazz' });
                fetchPricelist();
            } else {
                setMessage({ type: 'error', text: res.data.message || 'Gagal mengambil pricelist' });
            }
        } catch (error: any) {
            console.error('Failed to fetch from Digiflazz', error);
            setMessage({ type: 'error', text: error.response?.data?.message || 'Gagal mengambil pricelist dari Digiflazz' });
        } finally {
            setFetchingPricelist(false);
        }
    };

    const fetchInternalPurchases = async () => {
        try {
            setPurchaseHistoryLoading(true);
            const res = await apiV2.get('/vendors/digiflazz/internal-purchases?limit=20');
            if (res.data?.success) {
                setPurchaseHistory(res.data.data || []);
            }
        } catch (error) {
            console.error('Failed to fetch internal purchases', error);
        } finally {
            setPurchaseHistoryLoading(false);
        }
    };

    const openPurchaseModal = (item: PricelistItem) => {
        setSelectedPurchaseItem(item);
        setPurchaseCustomerNo('');
        setPurchaseNote('');
    };

    const resetPurchaseModal = () => {
        setSelectedPurchaseItem(null);
        setPurchaseCustomerNo('');
        setPurchaseNote('');
    };

    const closePurchaseModal = () => {
        if (purchaseSubmitting) return;
        resetPurchaseModal();
    };

    const formatPurchaseDate = (value?: string) => {
        if (!value) return '-';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '-';
        return date.toLocaleString('id-ID');
    };

    const purchaseStatusClass = (status: InternalPurchaseItem['status']) => {
        if (status === 'success') return 'ui-success-chip';
        if (status === 'failed') return 'ui-danger-chip';
        return 'ui-panel-muted';
    };

    const handleInternalPurchase = async (event: React.FormEvent) => {
        event.preventDefault();
        if (!selectedPurchaseItem) return;
        const customerNo = purchaseCustomerNo.trim();
        if (!customerNo) {
            setMessage({ type: 'error', text: 'Nomor tujuan wajib diisi' });
            return;
        }

        try {
            setPurchaseSubmitting(true);
            const res = await apiV2.post('/vendors/digiflazz/internal-purchases', {
                buyerSkuCode: selectedPurchaseItem.buyer_sku_code,
                customerNo,
                note: purchaseNote.trim() || undefined
            });
            setMessage({ type: 'success', text: res.data?.message || 'Pembelian internal dikirim ke Digiflazz' });
            resetPurchaseModal();
            fetchInternalPurchases();
        } catch (error: any) {
            setMessage({ type: 'error', text: error.response?.data?.message || 'Gagal melakukan pembelian internal' });
        } finally {
            setPurchaseSubmitting(false);
        }
    };

    const fetchWebhookConfig = async () => {
        try {
            const res = await apiV2
                .get('/webhook/digiflazz/config');
            setWebhookConfigured(res.data.configured);
            setWebhookWhitelistIP(res.data.whitelistIP || '');
            setWebhookProtectionMode(res.data.protectionMode || 'unprotected');
        } catch (error) {
            console.error('Failed to fetch webhook config', error);
        }
    };

    const fetchWebhookLogs = async () => {
        try {
            setWebhookLogsLoading(true);
            const res = await apiV2
                .get('/webhook/digiflazz/logs');
            setWebhookLogs(res.data);
        } catch (error) {
            console.error('Failed to fetch webhook logs', error);
        } finally {
            setWebhookLogsLoading(false);
        }
    };

    const handleSaveWebhook = async () => {
        try {
            setWebhookSaving(true);
            const payload = {
                secret: webhookSecret || undefined,
                whitelistIP: webhookWhitelistIP
            };
            await apiV2
                .post('/webhook/digiflazz/config', payload);
            setMessage({ type: 'success', text: 'Webhook config berhasil disimpan!' });
            setWebhookSecret('');
            await fetchWebhookConfig();
            await fetchWebhookLogs();
        } catch (error: any) {
            setMessage({ type: 'error', text: error.response?.data?.message || 'Gagal menyimpan webhook config' });
        } finally {
            setWebhookSaving(false);
        }
    };

    const handleSave = async (e: React.FormEvent) => {
        e.preventDefault();

        if (!settings.username.trim()) {
            setMessage({ type: 'error', text: 'Username wajib diisi' });
            return;
        }

        if (!settings.configured && !settings.apiKey.trim()) {
            setMessage({ type: 'error', text: 'API Key wajib diisi untuk setup awal Digiflazz' });
            return;
        }

        try {
            setSaving(true);
            const payload = {
                username: settings.username.trim(),
                apiKey: settings.apiKey.trim() || undefined
            };
            const res = await stepUp.run('integrations.credentials', (config) =>
                apiV2.post('/vendors/digiflazz/settings', payload, config as never),
            );

            setMessage({ type: 'success', text: 'Settings berhasil disimpan!' });
            setBalance(res.data.balance);
            setSettings(prev => ({ ...prev, configured: true, apiKey: '' }));
        } catch (error: any) {
            const text = stepUpActionErrorMessage(error, 'Gagal menyimpan settings');
            if (text) setMessage({ type: 'error', text });
        } finally {
            setSaving(false);
        }
    };

    return (<>

        <div className="space-y-5">
            {/* Message */}
            {message && (
                <div className={`p-4 rounded-lg flex items-center gap-2 border ${message.type === 'success' ? 'ui-success-chip' : 'ui-danger-chip'}`}>
                    {message.type === 'success' ? <CheckCircle className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
                    {message.text}
                </div>
            )}

            {/* Tabs */}
            <div className="flex gap-2 border-b ui-border">
                <button
                    onClick={() => setActiveTab('settings')}
                    className={`px-4 py-2 font-medium text-sm border-b-2 transition-colors ${
                        activeTab === 'settings'
                            ? 'border-[var(--ui-accent)] ui-accent-text'
                            : 'border-transparent ui-text-muted hover:text-[var(--ui-text)]'
                    }`}
                >
                    Settings
                </button>
                <button
                    onClick={() => setActiveTab('pricelist')}
                    className={`px-4 py-2 font-medium text-sm border-b-2 transition-colors ${
                        activeTab === 'pricelist'
                            ? 'border-[var(--ui-accent)] ui-accent-text'
                            : 'border-transparent ui-text-muted hover:text-[var(--ui-text)]'
                    }`}
                >
                    Pricelist
                </button>
                <button
                    onClick={() => setActiveTab('webhook')}
                    className={`px-4 py-2 font-medium text-sm border-b-2 transition-colors ${
                        activeTab === 'webhook'
                            ? 'border-[var(--ui-accent)] ui-accent-text'
                            : 'border-transparent ui-text-muted hover:text-[var(--ui-text)]'
                    }`}
                >
                    Webhook
                </button>
            </div>

            {activeTab === 'settings' && (
                <>
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
                        {/* Balance Card */}
                        <div className="ui-panel-muted rounded-xl border ui-border shadow-lg p-6 ui-text">
                            <div className="flex items-center justify-between mb-4">
                                <div className="flex items-center gap-2">
                                    <Wallet className="w-6 h-6" />
                                    <span className="font-semibold">Saldo Digiflazz</span>
                                </div>
                                <button
                                    onClick={fetchBalance}
                                    disabled={checkingBalance || !settings.configured}
                                    className="p-2 hover:bg-[var(--ui-card-bg)] rounded-lg transition-colors disabled:opacity-50"
                                    title="Refresh Saldo"
                                >
                                    <RefreshCw className={`w-5 h-5 ${checkingBalance ? 'animate-spin' : ''}`} />
                                </button>
                            </div>
                            {loading ? (
                                <div className="h-10 ui-panel rounded animate-pulse" />
                            ) : balance !== null ? (
                                <div className="text-3xl font-bold">
                                    Rp {balance.toLocaleString('id-ID')}
                                </div>
                            ) : (
                                <div className="text-lg opacity-80">
                                    {settings.configured ? 'Klik refresh untuk cek saldo' : 'Belum dikonfigurasi'}
                                </div>
                            )}
                            <div className="mt-4 text-sm opacity-80">
                                Status: {settings.configured ? (
                                    <span className="inline-flex items-center gap-1">
                                        <CheckCircle className="w-4 h-4" /> Terhubung
                                    </span>
                                ) : 'Belum dikonfigurasi'}
                            </div>
                        </div>

                        {/* Settings Form */}
                        <div className="lg:col-span-2 ui-panel-muted rounded-xl border ui-border">
                            <div className="p-4 border-b ui-border">
                                <h2 className="font-semibold ui-text">Kredensial API</h2>
                                <p className="text-sm ui-text-muted">Masukkan username dan API key dari akun Digiflazz Anda</p>
                            </div>
                            <form onSubmit={handleSave} className="p-4 space-y-4">
                                <div>
                                    <label className="block text-sm font-medium ui-text mb-1">Username</label>
                                    <input
                                        type="text"
                                        value={settings.username}
                                        onChange={(e) => setSettings({ ...settings, username: e.target.value })}
                                        className="w-full rounded-lg border px-3 py-2 ui-field"
                                        placeholder="Masukkan username Digiflazz"
                                    />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium ui-text mb-1">API Key</label>
                                    <div className="relative">
                                        <input
                                            type={showApiKey ? 'text' : 'password'}
                                            value={settings.apiKey}
                                            onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })}
                                            className="w-full rounded-lg border px-3 py-2 pr-10 ui-field"
                                            placeholder={settings.configured ? '************' : 'Masukkan API Key'}
                                        />
                                        <button
                                            type="button"
                                            onClick={() => setShowApiKey(!showApiKey)}
                                            className="absolute right-3 top-1/2 -translate-y-1/2 ui-text-muted hover:text-[var(--ui-text)]"
                                        >
                                            {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                        </button>
                                    </div>
                                    {settings.configured && (
                                        <p className="text-xs ui-text-muted mt-1">Kosongkan jika tidak ingin mengubah API Key</p>
                                    )}
                                </div>

                                <div className="ui-panel border ui-border rounded-lg p-4 text-sm ui-text">
                                    <p className="font-medium mb-1 ui-text">Cara mendapatkan API Key:</p>
                                    <ol className="list-decimal list-inside space-y-1 ui-text-muted">
                                        <li>Login ke <a href="https://member.digiflazz.com" target="_blank" rel="noopener noreferrer" className="underline">member.digiflazz.com</a></li>
                                        <li>Buka menu "API" atau "Pengaturan API"</li>
                                        <li>Salin Username dan API Key Production</li>
                                    </ol>
                                </div>

                                <div className="flex gap-3 pt-4">
                                    <button
                                        type="button"
                                        onClick={() => navigate('/admin/addons')}
                                        className="flex-1 px-4 py-2 border rounded-lg ui-muted-action transition-colors"
                                    >
                                        Batal
                                    </button>
                                    <button
                                        type="submit"
                                        disabled={saving}
                                        className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 ui-accent-solid rounded-lg transition-colors disabled:opacity-50"
                                    >
                                        <Save className="w-4 h-4" />
                                        {saving ? 'Menyimpan...' : 'Simpan Settings'}
                                    </button>
                                </div>
                            </form>
                        </div>
                    </div>

                    {/* Info Card */}
                    <div className="ui-panel-muted rounded-xl border ui-border p-4">
                        <h3 className="font-semibold ui-text mb-3">Tentang Digiflazz</h3>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
                            <div className="flex items-start gap-3">
                                <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ui-success-chip">
                                    <Wallet className="w-5 h-5" />
                                </div>
                                <div>
                                    <p className="font-medium ui-text">H2H PPOB</p>
                                    <p className="ui-text-muted">Pulsa, Data, PLN, E-Wallet, Games, dll</p>
                                </div>
                            </div>
                            <div className="flex items-start gap-3">
                                <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ui-info-chip">
                                    <RefreshCw className="w-5 h-5" />
                                </div>
                                <div>
                                    <p className="font-medium ui-text">Realtime</p>
                                    <p className="ui-text-muted">Transaksi otomatis & cepat</p>
                                </div>
                            </div>
                            <div className="flex items-start gap-3">
                                <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ui-accent-chip">
                                    <CheckCircle className="w-5 h-5" />
                                </div>
                                <div>
                                    <p className="font-medium ui-text">Webhook</p>
                                    <p className="ui-text-muted">Notifikasi status transaksi</p>
                                </div>
                            </div>
                        </div>
                    </div>
                </>
            )}

            {activeTab === 'pricelist' && (
                <div className="space-y-4">
                    {/* Get Pricelist Button */}
                    <div className="ui-panel border ui-border rounded-xl p-4 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                        <div>
                            <h3 className="font-semibold ui-text">Ambil Pricelist dari Digiflazz</h3>
                            <p className="text-sm ui-text-muted">Klik tombol untuk mengambil/memperbarui daftar harga dari API Digiflazz dan menyimpan ke database lokal.</p>
                        </div>
                        <button
                            onClick={handleFetchFromDigiflazz}
                            disabled={fetchingPricelist || !settings.configured}
                            className="inline-flex items-center gap-2 px-4 py-2 ui-accent-solid rounded-lg transition-colors disabled:opacity-50 whitespace-nowrap"
                        >
                            <Download className={`w-4 h-4 ${fetchingPricelist ? 'animate-bounce' : ''}`} />
                            {fetchingPricelist ? 'Mengambil...' : 'Get Pricelist'}
                        </button>
                    </div>

                    {/* Search & Filters */}
                    <div className="ui-panel-muted rounded-xl border ui-border p-4">
                        <form onSubmit={handleSearchPricelist} className="grid grid-cols-1 md:grid-cols-5 gap-3">
                            <div className="relative">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ui-text-muted" />
                                <input
                                    type="text"
                                    value={pricelistSearch}
                                    onChange={(e) => setPricelistSearch(e.target.value)}
                                    placeholder="Cari produk..."
                                    className="w-full rounded-lg border pl-10 pr-3 py-2 ui-field"
                                />
                            </div>
                            <input
                                type="text"
                                value={pricelistSku}
                                onChange={(e) => setPricelistSku(e.target.value)}
                                placeholder="Filter SKU..."
                                className="w-full rounded-lg border px-3 py-2 ui-field"
                            />
                            <select
                                value={pricelistCategory}
                                onChange={(e) => { setPricelistCategory(e.target.value); setPricelistPage(1); }}
                                className="w-full rounded-lg border px-3 py-2 ui-field"
                            >
                                <option value="">Semua Kategori</option>
                                {pricelistFilters.categories.map((cat) => (
                                    <option key={cat} value={cat}>{cat}</option>
                                ))}
                            </select>
                            <select
                                value={pricelistBrand}
                                onChange={(e) => { setPricelistBrand(e.target.value); setPricelistPage(1); }}
                                className="w-full rounded-lg border px-3 py-2 ui-field"
                            >
                                <option value="">Semua Brand</option>
                                {pricelistFilters.brands.map((brand) => (
                                    <option key={brand} value={brand}>{brand}</option>
                                ))}
                            </select>
                            <button
                                type="submit"
                                className="px-4 py-2 ui-accent-solid rounded-lg transition-colors"
                            >
                                Cari
                            </button>
                        </form>
                    </div>

                    {/* Stats */}
                    <div className="flex items-center justify-between text-sm ui-text-muted">
                        <span>Total: <strong className="ui-text">{pricelistTotal.toLocaleString()}</strong> produk</span>
                        <span>Halaman {pricelistPage} dari {pricelistTotalPages}</span>
                    </div>

                    {/* Error */}
                    {pricelistError && (
                        <div className="rounded-lg border p-4 ui-danger-chip">
                            <p className="font-medium">Error:</p>
                            <p className="text-sm">{pricelistError}</p>
                        </div>
                    )}

                    <div className="ui-panel-muted rounded-xl border ui-border overflow-hidden">
                        <div className="overflow-x-auto">
                            <table className="min-w-full divide-y ui-border">
                                <thead className="ui-panel">
                                    <tr>
                                        <th className="px-4 py-3 text-left text-xs font-semibold ui-text-muted">SKU</th>
                                        <th className="px-4 py-3 text-left text-xs font-semibold ui-text-muted">Nama</th>
                                        <th className="px-4 py-3 text-left text-xs font-semibold ui-text-muted">Kategori</th>
                                        <th className="px-4 py-3 text-left text-xs font-semibold ui-text-muted">Brand</th>
                                        <th className="px-4 py-3 text-right text-xs font-semibold ui-text-muted">Harga</th>
                                        <th className="px-4 py-3 text-left text-xs font-semibold ui-text-muted">Status</th>
                                        <th className="px-4 py-3 text-right text-xs font-semibold ui-text-muted">Aksi</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y ui-border">
                                    {pricelistLoading ? (
                                        <tr>
                                            <td colSpan={7} className="px-4 py-8 text-center ui-text-muted">Memuat...</td>
                                        </tr>
                                    ) : pricelist.length === 0 ? (
                                        <tr>
                                            <td colSpan={7} className="px-4 py-8 text-center ui-text-muted">Belum ada data</td>
                                        </tr>
                                    ) : (
                                        pricelist.map((item) => (
                                            <tr key={item._id} className="hover:bg-[var(--ui-card-bg)]">
                                                <td className="px-4 py-3 text-sm font-mono ui-text-muted">{item.buyer_sku_code}</td>
                                                <td className="px-4 py-3 text-sm ui-text">{item.product_name}</td>
                                                <td className="px-4 py-3 text-sm ui-text-muted">{item.category}</td>
                                                <td className="px-4 py-3 text-sm ui-text-muted">{item.brand}</td>
                                                <td className="px-4 py-3 text-sm text-right ui-text font-semibold">Rp{item.price.toLocaleString('id-ID')}</td>
                                                <td className="px-4 py-3 text-sm">
                                                    <span className={`px-2 py-1 rounded-full border text-xs font-semibold ${item.seller_product_status ? 'ui-success-chip' : 'ui-danger-chip'}`}>
                                                        {item.seller_product_status ? 'Aktif' : 'Nonaktif'}
                                                    </span>
                                                </td>
                                                <td className="px-4 py-3 text-right">
                                                    <button
                                                        type="button"
                                                        onClick={() => openPurchaseModal(item)}
                                                        disabled={!item.seller_product_status}
                                                        className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-bold ui-accent-chip disabled:cursor-not-allowed disabled:opacity-40"
                                                    >
                                                        <ShoppingCart className="h-3.5 w-3.5" />
                                                        Beli
                                                    </button>
                                                </td>
                                            </tr>
                                        ))
                                    )}
                                </tbody>
                            </table>
                        </div>

                        {/* Pagination */}
                        {pricelistTotalPages > 1 && (
                            <div className="flex items-center justify-between px-4 py-3 border-t ui-border">
                                <button
                                    onClick={() => setPricelistPage(p => Math.max(1, p - 1))}
                                    disabled={pricelistPage === 1}
                                    className="inline-flex items-center gap-1 px-3 py-1 text-sm ui-text-muted hover:bg-[var(--ui-card-bg)] rounded-lg disabled:opacity-50"
                                >
                                    <ChevronLeft className="w-4 h-4" />
                                    Prev
                                </button>
                                <div className="flex items-center gap-1">
                                    {Array.from({ length: Math.min(5, pricelistTotalPages) }, (_, i) => {
                                        let pageNum;
                                        if (pricelistTotalPages <= 5) {
                                            pageNum = i + 1;
                                        } else if (pricelistPage <= 3) {
                                            pageNum = i + 1;
                                        } else if (pricelistPage >= pricelistTotalPages - 2) {
                                            pageNum = pricelistTotalPages - 4 + i;
                                        } else {
                                            pageNum = pricelistPage - 2 + i;
                                        }
                                        return (
                                            <button
                                                key={pageNum}
                                                onClick={() => setPricelistPage(pageNum)}
                                                className={`w-8 h-8 text-sm rounded-lg ${
                                                    pricelistPage === pageNum
                                                        ? 'ui-accent-solid'
                                                        : 'ui-text-muted hover:bg-[var(--ui-card-bg)]'
                                                }`}
                                            >
                                                {pageNum}
                                            </button>
                                        );
                                    })}
                                </div>
                                <button
                                    onClick={() => setPricelistPage(p => Math.min(pricelistTotalPages, p + 1))}
                                    disabled={pricelistPage === pricelistTotalPages}
                                    className="inline-flex items-center gap-1 px-3 py-1 text-sm ui-text-muted hover:bg-[var(--ui-card-bg)] rounded-lg disabled:opacity-50"
                                >
                                    Next
                                    <ChevronRight className="w-4 h-4" />
                                </button>
                            </div>
                        )}
                    </div>

                    {selectedPurchaseItem && (
                        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm">
                            <form onSubmit={handleInternalPurchase} role="dialog" aria-modal="true" aria-labelledby="internal-purchase-title" className="ui-panel w-full max-w-lg rounded-2xl border ui-border shadow-2xl">
                                <div className="flex items-start justify-between gap-4 border-b ui-border p-5">
                                    <div>
                                        <p className="ui-accent-chip inline-flex rounded-full border px-3 py-1 text-xs font-bold">Pembelian Internal</p>
                                        <h3 id="internal-purchase-title" className="mt-3 text-xl font-black ui-text">Beli via Digiflazz</h3>
                                        <p className="mt-1 text-sm ui-text-muted">Aksi ini langsung mengirim order dan memakai saldo vendor. Pastikan SKU, target, dan harga benar.</p>
                                    </div>
                                    <button type="button" onClick={closePurchaseModal} className="rounded-lg p-2 ui-text-muted hover:bg-[var(--ui-panel-muted)] hover:text-[var(--ui-text)]">
                                        <X className="h-5 w-5" />
                                    </button>
                                </div>
                                <div className="space-y-4 p-5">
                                    <div className="rounded-xl border ui-border ui-panel-muted p-4 text-sm">
                                        <p className="font-black ui-text">{selectedPurchaseItem.product_name}</p>
                                        <p className="mt-1 font-mono text-xs ui-text-muted">SKU: {selectedPurchaseItem.buyer_sku_code}</p>
                                        <p className="mt-2 font-semibold ui-text">Rp{selectedPurchaseItem.price.toLocaleString('id-ID')}</p>
                                        {purchaseCustomerNo.trim() ? <p className="mt-2 text-xs font-bold text-red-500">Target: {purchaseCustomerNo.trim()}</p> : null}
                                    </div>
                                    <div>
                                        <label htmlFor="internal-purchase-customer-no" className="mb-2 block text-sm font-semibold ui-text">Nomor tujuan / customer no</label>
                                        <input
                                            id="internal-purchase-customer-no"
                                            value={purchaseCustomerNo}
                                            onChange={(event) => setPurchaseCustomerNo(event.target.value)}
                                            className="w-full rounded-xl border px-3 py-3 ui-field"
                                            placeholder="Masukkan nomor tujuan"
                                        />
                                    </div>
                                    <div>
                                        <label htmlFor="internal-purchase-note" className="mb-2 block text-sm font-semibold ui-text">Catatan internal</label>
                                        <textarea
                                            id="internal-purchase-note"
                                            value={purchaseNote}
                                            onChange={(event) => setPurchaseNote(event.target.value)}
                                            className="min-h-24 w-full rounded-xl border px-3 py-3 ui-field"
                                            placeholder="Opsional"
                                        />
                                    </div>
                                </div>
                                <div className="flex justify-end gap-3 border-t ui-border p-5">
                                    <button type="button" onClick={closePurchaseModal} className="rounded-xl border ui-border px-4 py-2 text-sm font-bold ui-text-muted hover:bg-[var(--ui-panel-muted)]">Batal</button>
                                    <button type="submit" disabled={purchaseSubmitting} className="ui-accent-solid inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-bold disabled:opacity-50">
                                        <ShoppingCart className="h-4 w-4" />
                                        {purchaseSubmitting ? 'Mengirim...' : 'Konfirmasi & Kirim ke Vendor'}
                                    </button>
                                </div>
                            </form>
                        </div>
                    )}

                    <div className="ui-panel rounded-xl border ui-border p-4">
                        <div className="mb-4 flex items-center justify-between gap-3">
                            <div>
                                <h3 className="font-semibold ui-text">Riwayat Pembelian Internal</h3>
                                <p className="text-sm ui-text-muted">20 pembelian internal Digiflazz terbaru.</p>
                            </div>
                            <button onClick={fetchInternalPurchases} className="inline-flex items-center gap-2 rounded-lg border ui-border px-3 py-2 text-sm font-semibold ui-text-muted hover:bg-[var(--ui-panel-muted)]">
                                <RefreshCw className="h-4 w-4" /> Refresh
                            </button>
                        </div>
                        <div className="overflow-x-auto">
                            <table className="min-w-full divide-y ui-border text-sm">
                                <thead>
                                    <tr className="ui-panel-muted">
                                        <th className="px-3 py-2 text-left font-semibold ui-text-muted">Waktu</th>
                                        <th className="px-3 py-2 text-left font-semibold ui-text-muted">Staff/Admin</th>
                                        <th className="px-3 py-2 text-left font-semibold ui-text-muted">Produk</th>
                                        <th className="px-3 py-2 text-left font-semibold ui-text-muted">Tujuan</th>
                                        <th className="px-3 py-2 text-left font-semibold ui-text-muted">Ref ID</th>
                                        <th className="px-3 py-2 text-left font-semibold ui-text-muted">Status</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y ui-border">
                                    {purchaseHistoryLoading ? (
                                        <tr><td colSpan={6} className="px-3 py-6 text-center ui-text-muted">Memuat riwayat...</td></tr>
                                    ) : purchaseHistory.length === 0 ? (
                                        <tr><td colSpan={6} className="px-3 py-6 text-center ui-text-muted">Belum ada riwayat pembelian internal</td></tr>
                                    ) : purchaseHistory.map((item) => (
                                        <tr key={item._id}>
                                            <td className="px-3 py-2 ui-text-muted">{formatPurchaseDate(item.createdAt)}</td>
                                            <td className="px-3 py-2 ui-text">{item.createdBy?.name || item.createdBy?.email || '-'}</td>
                                            <td className="px-3 py-2 ui-text">{item.productName}<div className="font-mono text-xs ui-text-muted">{item.buyerSkuCode}</div></td>
                                            <td className="px-3 py-2 font-mono ui-text-muted">{item.customerNo}</td>
                                            <td className="px-3 py-2 font-mono ui-text-muted">{item.refId}</td>
                                            <td className="px-3 py-2"><span className={`rounded-full border px-2 py-1 text-xs font-bold ${purchaseStatusClass(item.status)}`}>{item.status}</span></td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </div>
            )}

            {activeTab === 'webhook' && (
                <div className="space-y-5">
                    {/* Webhook URL Info */}
                    <div className="ui-panel-muted rounded-xl border ui-border p-4">
                        <h3 className="font-semibold ui-text mb-2">Webhook URL</h3>
                        <p className="text-sm ui-text-muted mb-3">
                            Salin URL di bawah ini dan paste di pengaturan Webhook Digiflazz (menu Atur Koneksi &gt; API &gt; Webhook).
                        </p>
                        <div className="flex items-center gap-2">
                            <input
                                type="text"
                                readOnly
                                value={`${window.location.origin}/api/v2/webhook/digiflazz`}
                                className="flex-1 rounded-lg border px-3 py-2 ui-field font-mono text-sm"
                            />
                            <button
                                onClick={() => {
                                    navigator.clipboard.writeText(`${window.location.origin}/api/v2/webhook/digiflazz`);
                                    setMessage({ type: 'success', text: 'URL berhasil disalin!' });
                                }}
                                className="px-4 py-2 ui-accent-solid rounded-lg text-sm font-medium"
                            >
                                Salin
                            </button>
                        </div>
                        <div className="mt-3 p-3 ui-panel rounded-lg border ui-border">
                            <p className="text-xs ui-text-muted mb-2">Webhook ini akan menerima event:</p>
                            <div className="flex gap-2">
                                <span className="px-2 py-1 text-xs rounded-full border font-semibold ui-info-chip">create</span>
                                <span className="px-2 py-1 text-xs rounded-full border font-semibold ui-success-chip">update</span>
                            </div>
                            <p className="text-xs ui-text-muted mt-2">
                                Status transaksi akan otomatis diupdate: Sukses, Gagal, atau Pending.
                                Refund saldo otomatis jika transaksi gagal.
                            </p>
                        </div>
                    </div>

                    {/* Webhook Secret */}
                    <div className="ui-panel-muted rounded-xl border ui-border">
                        <div className="p-4 border-b ui-border">
                            <h3 className="font-semibold ui-text">Webhook Secret</h3>
                            <p className="text-sm ui-text-muted">Secret key untuk verifikasi signature (X-Hub-Signature) dari Digiflazz.</p>
                        </div>
                        <div className="p-4 space-y-4">
                            <div className="flex items-center gap-2 text-sm">
                                <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full border text-xs font-semibold ${webhookConfigured ? 'ui-success-chip' : 'ui-warning-chip'}`}>
                                    {webhookConfigured ? (
                                        <><CheckCircle className="w-3 h-3" /> Terkonfigurasi</>
                                    ) : (
                                        <><AlertCircle className="w-3 h-3" /> Belum dikonfigurasi</>
                                    )}
                                </span>
                            </div>
                            <div>
                                <label className="block text-sm font-medium ui-text mb-1">Secret Key</label>
                                <div className="relative">
                                    <input
                                        type={showApiKey ? 'text' : 'password'}
                                        value={webhookSecret}
                                        onChange={(e) => setWebhookSecret(e.target.value)}
                                        className="w-full rounded-lg border px-3 py-2 pr-10 ui-field"
                                        placeholder={webhookConfigured ? '************ (kosongkan jika tidak ingin mengubah)' : 'Masukkan secret key'}
                                    />
                                    <button
                                        type="button"
                                        onClick={() => setShowApiKey(!showApiKey)}
                                        className="absolute right-3 top-1/2 -translate-y-1/2 ui-text-muted hover:text-[var(--ui-text)]"
                                    >
                                        {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                    </button>
                                </div>
                                <p className="text-xs ui-text-muted mt-1">
                                    Secret ini harus sama dengan yang Anda set di panel Digiflazz. Jika secret belum diisi, Anda wajib melindungi webhook dengan whitelist IP agar callback tidak ditolak.
                                </p>
                                {webhookProtectionMode === 'unprotected' && (
                                    <p className="text-xs ui-danger-text mt-2">Webhook belum aman. Atur secret atau whitelist IP sebelum mengandalkan callback Digiflazz.</p>
                                )}
                                {webhookProtectionMode === 'ip_only' && (
                                    <p className="text-xs ui-warning-text mt-2">Webhook saat ini hanya dilindungi whitelist IP. Lebih aman jika Anda juga mengisi secret signature.</p>
                                )}
                            </div>
                            <div>
                                <label className="block text-sm font-medium ui-text mb-1">Whitelist IP</label>
                                <input
                                    type="text"
                                    value={webhookWhitelistIP}
                                    onChange={(e) => setWebhookWhitelistIP(e.target.value)}
                                    className="w-full rounded-lg border px-3 py-2 ui-field"
                                    placeholder="Contoh: 103.81.248.0,103.81.249.0"
                                />
                                <p className="text-xs ui-text-muted mt-1">
                                    Daftar IP yang diizinkan mengirim webhook, pisahkan dengan koma.
                                    Kosongkan untuk menerima dari semua IP (tidak disarankan di production).
                                </p>
                                <div className="mt-2 p-2 ui-panel rounded-lg border ui-border">
                                    <p className="text-xs ui-text-muted">IP Server Digiflazz (tambahkan ke whitelist):</p>
                                    <div className="flex flex-wrap gap-1 mt-1">
                                        {['103.81.248.0/22', '159.223.34.184', '159.223.34.234'].map((ip) => (
                                            <button
                                                key={ip}
                                                onClick={() => {
                                                    const current = webhookWhitelistIP.split(',').map(s => s.trim()).filter(Boolean);
                                                    if (!current.includes(ip)) {
                                                        setWebhookWhitelistIP([...current, ip].join(', '));
                                                    }
                                                }}
                                                className="px-2 py-0.5 text-xs rounded-full border font-mono ui-info-chip hover:opacity-80"
                                            >
                                                + {ip}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>
                            <button
                                onClick={handleSaveWebhook}
                                disabled={webhookSaving}
                                className="inline-flex items-center gap-2 px-4 py-2 ui-accent-solid rounded-lg transition-colors disabled:opacity-50"
                            >
                                <Save className="w-4 h-4" />
                                {webhookSaving ? 'Menyimpan...' : 'Simpan Config'}
                            </button>
                        </div>
                    </div>

                    {/* Webhook Logs */}
                    <div className="ui-panel-muted rounded-xl border ui-border">
                        <div className="p-4 border-b ui-border flex items-center justify-between">
                            <div>
                                <h3 className="font-semibold ui-text">Log Webhook</h3>
                                <p className="text-sm ui-text-muted">100 log terakhir dari callback Digiflazz</p>
                            </div>
                            <button
                                onClick={fetchWebhookLogs}
                                disabled={webhookLogsLoading}
                                className="p-2 hover:bg-[var(--ui-card-bg)] rounded-lg transition-colors ui-text-muted hover:text-[var(--ui-text)]"
                            >
                                <RefreshCw className={`w-4 h-4 ${webhookLogsLoading ? 'animate-spin' : ''}`} />
                            </button>
                        </div>
                        <div className="overflow-x-auto">
                            <table className="min-w-full divide-y ui-border">
                                <thead className="ui-panel">
                                    <tr>
                                        <th className="px-4 py-3 text-left text-xs font-semibold ui-text-muted">Waktu</th>
                                        <th className="px-4 py-3 text-left text-xs font-semibold ui-text-muted">Event</th>
                                        <th className="px-4 py-3 text-left text-xs font-semibold ui-text-muted">Ref ID</th>
                                        <th className="px-4 py-3 text-left text-xs font-semibold ui-text-muted">Status</th>
                                        <th className="px-4 py-3 text-left text-xs font-semibold ui-text-muted">Message</th>
                                        <th className="px-4 py-3 text-left text-xs font-semibold ui-text-muted">Verified</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y ui-border">
                                    {webhookLogsLoading ? (
                                        <tr>
                                            <td colSpan={6} className="px-4 py-8 text-center ui-text-muted">Memuat...</td>
                                        </tr>
                                    ) : webhookLogs.length === 0 ? (
                                        <tr>
                                            <td colSpan={6} className="px-4 py-8 text-center ui-text-muted">Belum ada log webhook</td>
                                        </tr>
                                    ) : (
                                        webhookLogs.map((log) => (
                                            <tr key={log.id} className="hover:bg-[var(--ui-card-bg)]">
                                                <td className="px-4 py-3 text-xs ui-text-muted whitespace-nowrap">
                                                    {new Date(log.timestamp).toLocaleString('id-ID')}
                                                </td>
                                                <td className="px-4 py-3 text-xs">
                                                    <span className="px-2 py-0.5 rounded-full border font-semibold ui-info-chip">
                                                        {log.event}
                                                    </span>
                                                </td>
                                                <td className="px-4 py-3 text-xs ui-text font-mono">{log.refId}</td>
                                                <td className="px-4 py-3 text-xs">
                                                    <span className={`px-2 py-0.5 rounded-full font-semibold ${
                                                        log.status.toLowerCase() === 'sukses' ? 'ui-success-chip' :
                                                        log.status.toLowerCase() === 'gagal' ? 'ui-danger-chip' :
                                                        log.status === 'error' || log.status === 'rejected' ? 'ui-danger-chip' :
                                                        'ui-warning-chip'
                                                    }`}>
                                                        {log.status}
                                                    </span>
                                                </td>
                                                <td className="px-4 py-3 text-xs ui-text-muted max-w-[200px] truncate">{log.message}</td>
                                                <td className="px-4 py-3 text-xs">
                                                    {log.verified ? (
                                                        <CheckCircle className="w-4 h-4 ui-success-text" />
                                                    ) : (
                                                        <AlertCircle className="w-4 h-4 ui-danger-text" />
                                                    )}
                                                </td>
                                            </tr>
                                        ))
                                    )}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    {/* Setup Guide */}
                    <div className="ui-panel-muted rounded-xl border ui-border p-4">
                        <h3 className="font-semibold ui-text mb-3">Cara Setup Webhook Digiflazz</h3>
                        <ol className="list-decimal list-inside space-y-2 text-sm ui-text-muted">
                            <li>Login ke <a href="https://member.digiflazz.com" target="_blank" rel="noopener noreferrer" className="ui-accent-text underline">member.digiflazz.com</a></li>
                            <li>Buka menu <strong className="ui-text">Atur Koneksi</strong> &gt; <strong className="ui-text">API</strong> &gt; <strong className="ui-text">Webhook</strong></li>
                            <li>Paste <strong className="ui-text">Webhook URL</strong> di atas ke kolom URL</li>
                            <li>Set <strong className="ui-text">Secret</strong> yang sama dengan yang Anda simpan di atas</li>
                            <li>Simpan pengaturan di Digiflazz</li>
                            <li>Klik tombol <strong className="ui-text">Ping</strong> di Digiflazz untuk test koneksi</li>
                        </ol>
                        <div className="mt-4 rounded-lg border p-3 ui-warning-chip">
                            <p className="text-xs">
                                <strong>Penting:</strong> Pastikan domain/server Anda bisa diakses secara publik (bukan localhost).
                                Digiflazz akan mengirim HTTP POST ke URL webhook saat ada perubahan status transaksi.
                            </p>
                        </div>
                    </div>
                </div>
            )}
        </div>
            {stepUp.dialog}
        </>
    );
}
