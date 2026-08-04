import { useState, useEffect } from 'react';
import { Save, RefreshCw, Wallet, CheckCircle, AlertCircle, Eye, EyeOff, Package, ChevronRight, Search, ShoppingCart, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { apiV2 } from '../../api';
import { useStepUpOrchestration } from '../../auth/useStepUpOrchestration';
import { stepUpActionErrorMessage } from '../../auth/withStepUp';

interface Category {
    id: number;
    nama: string;
}

interface Operator {
    id: number;
    nama: string;
    nama_category?: string;
    status?: number;
}

interface Jenis {
    id: number;
    nama: string;
    operator_nama?: string;
    status?: number;
}

interface Product {
    id: number;
    code: string;
    nama_produk: string;
    category_name?: string;
    operator_produk?: string;
    jenis_name?: string;
    price: number;
    status: number;
}

interface InternalPurchaseItem {
    _id: string;
    provider: 'tokovoucher';
    buyerSkuCode: string;
    productName: string;
    customerNo: string;
    serverId?: string;
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

export default function TokovoucherSettings() {
    const stepUp = useStepUpOrchestration();
    const navigate = useNavigate();
    const [activeTab, setActiveTab] = useState<'settings' | 'pricelist' | 'webhook'>('settings');
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [checkingBalance, setCheckingBalance] = useState(false);
    const [showSecret, setShowSecret] = useState(false);
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

    const [settings, setSettings] = useState({
        memberCode: '',
        secret: '',
        configured: false
    });

    const [balance, setBalance] = useState<number | null>(null);

    // Pricelist cascading filter state
    const [categories, setCategories] = useState<Category[]>([]);
    const [operators, setOperators] = useState<Operator[]>([]);
    const [jenisList, setJenisList] = useState<Jenis[]>([]);
    const [products, setProducts] = useState<Product[]>([]);

    const [selectedCategory, setSelectedCategory] = useState<number | null>(null);
    const [selectedOperator, setSelectedOperator] = useState<number | null>(null);
    const [selectedJenis, setSelectedJenis] = useState<number | null>(null);

    const [loadingCategories, setLoadingCategories] = useState(false);
    const [loadingOperators, setLoadingOperators] = useState(false);
    const [loadingJenis, setLoadingJenis] = useState(false);
    const [loadingProducts, setLoadingProducts] = useState(false);
    const [pricelistError, setPricelistError] = useState('');

    // SKU Search state
    const [skuSearch, setSkuSearch] = useState('');
    const [searchResults, setSearchResults] = useState<Product[]>([]);
    const [searchLoading, setSearchLoading] = useState(false);
    const [isSearchMode, setIsSearchMode] = useState(false);

    // Internal purchase state
    const [selectedPurchaseItem, setSelectedPurchaseItem] = useState<Product | null>(null);
    const [purchaseCustomerNo, setPurchaseCustomerNo] = useState('');
    const [purchaseServerId, setPurchaseServerId] = useState('');
    const [purchaseNote, setPurchaseNote] = useState('');
    const [purchaseSubmitting, setPurchaseSubmitting] = useState(false);
    const [purchaseHistory, setPurchaseHistory] = useState<InternalPurchaseItem[]>([]);
    const [purchaseHistoryLoading, setPurchaseHistoryLoading] = useState(false);

    // Webhook state
    const [webhookWhitelistIP, setWebhookWhitelistIP] = useState('');
    const [webhookProtectionMode, setWebhookProtectionMode] = useState<'signature' | 'ip_only' | 'unprotected'>('unprotected');
    const [webhookSaving, setWebhookSaving] = useState(false);
    const [webhookLogs, setWebhookLogs] = useState<Array<{
        id: string; timestamp: string; refId: string; status: string; message: string; verified: boolean;
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
        if (activeTab === 'pricelist' && settings.configured) {
            fetchInternalPurchases();
            if (categories.length === 0) {
                fetchCategories();
            }
        }
        if (activeTab === 'webhook') {
            fetchWebhookConfig();
            fetchWebhookLogs();
        }
    }, [activeTab, settings.configured]);

    useEffect(() => {
        if (selectedCategory) {
            fetchOperators(selectedCategory);
            setSelectedOperator(null);
            setSelectedJenis(null);
            setJenisList([]);
            setProducts([]);
        }
    }, [selectedCategory]);

    useEffect(() => {
        if (selectedOperator) {
            fetchJenis(selectedOperator);
            setSelectedJenis(null);
            setProducts([]);
        }
    }, [selectedOperator]);

    useEffect(() => {
        if (selectedJenis) {
            fetchProducts(selectedJenis);
        }
    }, [selectedJenis]);

    const fetchSettings = async () => {
        try {
            setLoading(true);
            const res = await apiV2
                .get('/vendors/tokovoucher/settings');
            setSettings({
                memberCode: res.data.memberCode || '',
                secret: '',
                configured: res.data.configured
            });

            if (res.data.configured) {
                fetchBalance();
            }
        } catch (error) {
            console.error('Failed to fetch settings', error);
            setMessage({ type: 'error', text: 'Gagal memuat konfigurasi Tokovoucher' });
        } finally {
            setLoading(false);
        }
    };

    const fetchBalance = async () => {
        try {
            setCheckingBalance(true);
            const res = await apiV2.get('/vendors/tokovoucher/balance');
            setBalance(res.data.balance);
        } catch (error: any) {
            console.error('Failed to fetch balance', error);
            setMessage({ type: 'error', text: error.response?.data?.message || 'Gagal mengambil saldo' });
        } finally {
            setCheckingBalance(false);
        }
    };

    const fetchCategories = async () => {
        try {
            setLoadingCategories(true);
            setPricelistError('');
            const res = await apiV2.get('/vendors/tokovoucher/categories');
            if (res.data.success) {
                setCategories(res.data.data || []);
            } else {
                setPricelistError(res.data.message || 'Gagal memuat kategori');
            }
        } catch (error: any) {
            setPricelistError(error.response?.data?.message || 'Gagal memuat kategori');
        } finally {
            setLoadingCategories(false);
        }
    };

    const fetchOperators = async (categoryId: number) => {
        try {
            setLoadingOperators(true);
            setOperators([]);
            const path = `/vendors/tokovoucher/operators?categoryId=${categoryId}`;
            const res = await apiV2.get(path);
            if (res.data.success) {
                setOperators(res.data.data || []);
            }
        } catch (error: any) {
            console.error('Failed to fetch operators', error);
        } finally {
            setLoadingOperators(false);
        }
    };

    const fetchJenis = async (operatorId: number) => {
        try {
            setLoadingJenis(true);
            setJenisList([]);
            const path = `/vendors/tokovoucher/jenis?operatorId=${operatorId}`;
            const res = await apiV2.get(path);
            if (res.data.success) {
                setJenisList(res.data.data || []);
            }
        } catch (error: any) {
            console.error('Failed to fetch jenis', error);
        } finally {
            setLoadingJenis(false);
        }
    };

    const fetchProducts = async (jenisId: number) => {
        try {
            setLoadingProducts(true);
            setProducts([]);
            const path = `/vendors/tokovoucher/products?jenisId=${jenisId}`;
            const res = await apiV2.get(path);
            if (res.data.success) {
                setProducts(res.data.data || []);
            }
        } catch (error: any) {
            console.error('Failed to fetch products', error);
        } finally {
            setLoadingProducts(false);
        }
    };

    const handleSkuSearch = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!skuSearch.trim()) {
            setIsSearchMode(false);
            setSearchResults([]);
            return;
        }

        try {
            setSearchLoading(true);
            setIsSearchMode(true);
            setPricelistError('');
            const path = `/vendors/tokovoucher/search?kode=${encodeURIComponent(skuSearch.trim())}`;
            const res = await apiV2.get(path);
            if (res.data.success) {
                setSearchResults(res.data.data || []);
            } else {
                setSearchResults([]);
            }
        } catch (error: any) {
            console.error('Failed to search products', error);
            setPricelistError(error.response?.data?.message || 'Gagal mencari produk');
            setSearchResults([]);
        } finally {
            setSearchLoading(false);
        }
    };

    const clearSearch = () => {
        setSkuSearch('');
        setSearchResults([]);
        setIsSearchMode(false);
    };

    const fetchInternalPurchases = async () => {
        try {
            setPurchaseHistoryLoading(true);
            const res = await apiV2.get('/vendors/tokovoucher/internal-purchases?limit=20');
            if (res.data?.success) {
                setPurchaseHistory(res.data.data || []);
            }
        } catch (error) {
            console.error('Failed to fetch Tokovoucher internal purchases', error);
        } finally {
            setPurchaseHistoryLoading(false);
        }
    };

    const openPurchaseModal = (item: Product) => {
        setSelectedPurchaseItem(item);
        setPurchaseCustomerNo('');
        setPurchaseServerId('');
        setPurchaseNote('');
    };

    const resetPurchaseModal = () => {
        setSelectedPurchaseItem(null);
        setPurchaseCustomerNo('');
        setPurchaseServerId('');
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
            const res = await apiV2.post('/vendors/tokovoucher/internal-purchases', {
                buyerSkuCode: selectedPurchaseItem.code,
                customerNo,
                serverId: purchaseServerId.trim() || undefined,
                note: purchaseNote.trim() || undefined
            });
            setMessage({ type: 'success', text: res.data?.message || 'Pembelian internal dikirim ke Tokovoucher' });
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
                .get('/webhook/tokovoucher/config');
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
                .get('/webhook/tokovoucher/logs');
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
            const payload = { whitelistIP: webhookWhitelistIP };
            await apiV2
                .post('/webhook/tokovoucher/config', payload);
            setMessage({ type: 'success', text: 'Webhook config berhasil disimpan!' });
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

        if (!settings.memberCode.trim()) {
            setMessage({ type: 'error', text: 'Member Code wajib diisi' });
            return;
        }

        if (!settings.configured && !settings.secret.trim()) {
            setMessage({ type: 'error', text: 'Secret wajib diisi untuk setup awal Tokovoucher' });
            return;
        }

        try {
            setSaving(true);
            const payload = {
                memberCode: settings.memberCode.trim(),
                secret: settings.secret.trim() || undefined
            };
            const res = await stepUp.run('integrations.credentials', (config) =>
                apiV2.post('/vendors/tokovoucher/settings', payload, config as never),
            );

            setMessage({ type: 'success', text: 'Settings berhasil disimpan!' });
            setBalance(res.data.balance);
            setSettings(prev => ({ ...prev, memberCode: prev.memberCode.trim(), configured: true, secret: '' }));
        } catch (error: any) {
            const text = stepUpActionErrorMessage(error, 'Gagal menyimpan settings');
            if (text) setMessage({ type: 'error', text });
        } finally {
            setSaving(false);
        }
    };

    const getCategoryName = () => categories.find(c => c.id === selectedCategory)?.nama || '';
    const getOperatorName = () => operators.find(o => o.id === selectedOperator)?.nama || '';
    const getJenisName = () => jenisList.find(j => j.id === selectedJenis)?.nama || '';

    return (<>

        <div className="space-y-5">
            {message && (
                <div className={`p-4 rounded-lg flex items-center gap-2 border ${message.type === 'success' ? 'ui-success-chip' : 'ui-danger-chip'}`}>
                    {message.type === 'success' ? <CheckCircle className="w-5 h-5" /> : <AlertCircle className="w-5 h-5" />}
                    {message.text}
                </div>
            )}

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
                        <div className="ui-panel-muted rounded-xl border ui-border shadow-lg p-6 ui-text">
                            <div className="flex items-center justify-between mb-4">
                                <div className="flex items-center gap-2">
                                    <Wallet className="w-6 h-6" />
                                    <span className="font-semibold">Saldo Tokovoucher</span>
                                </div>
                                <button
                                    onClick={fetchBalance}
                                    disabled={checkingBalance || !settings.configured}
                                    className="p-2 hover:bg-[var(--ui-card-bg)] rounded-lg transition-colors disabled:opacity-50"
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

                        <div className="lg:col-span-2 ui-panel-muted rounded-xl border ui-border">
                            <div className="p-4 border-b ui-border">
                                <h2 className="font-semibold ui-text">Kredensial API</h2>
                                <p className="text-sm ui-text-muted">Masukkan Member Code dan Secret dari akun Tokovoucher</p>
                            </div>
                            <form onSubmit={handleSave} className="p-4 space-y-4">
                                <div>
                                    <label className="block text-sm font-medium ui-text mb-1">Member Code</label>
                                    <input
                                        type="text"
                                        value={settings.memberCode}
                                        onChange={(e) => setSettings({ ...settings, memberCode: e.target.value })}
                                        className="w-full rounded-lg border px-3 py-2 ui-field"
                                        placeholder="Masukkan Member Code"
                                    />
                                </div>
                                <div>
                                    <label className="block text-sm font-medium ui-text mb-1">Secret</label>
                                    <div className="relative">
                                        <input
                                            type={showSecret ? 'text' : 'password'}
                                            value={settings.secret}
                                            onChange={(e) => setSettings({ ...settings, secret: e.target.value })}
                                            className="w-full rounded-lg border px-3 py-2 pr-10 ui-field"
                                            placeholder={settings.configured ? '************' : 'Masukkan Secret'}
                                        />
                                        <button
                                            type="button"
                                            onClick={() => setShowSecret(!showSecret)}
                                            className="absolute right-3 top-1/2 -translate-y-1/2 ui-text-muted hover:text-[var(--ui-text)]"
                                        >
                                            {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                        </button>
                                    </div>
                                </div>
                                <div className="ui-panel border ui-border rounded-lg p-4 text-sm ui-text">
                                    <p className="font-medium mb-1 ui-text">Cara mendapatkan kredensial:</p>
                                    <ol className="list-decimal list-inside space-y-1 ui-text-muted">
                                        <li>Login ke <a href="https://member.tokovoucher.id" target="_blank" rel="noopener noreferrer" className="underline">member.tokovoucher.id</a></li>
                                        <li>Buka menu Integrasi/API</li>
                                        <li>Salin Member Code dan Secret</li>
                                    </ol>
                                </div>
                                <div className="flex gap-3 pt-4">
                                    <button
                                        type="button"
                                        onClick={() => navigate('/admin/addons')}
                                        className="flex-1 px-4 py-2 border rounded-lg ui-muted-action"
                                    >
                                        Batal
                                    </button>
                                    <button
                                        type="submit"
                                        disabled={saving}
                                        className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2 ui-accent-solid rounded-lg disabled:opacity-50"
                                    >
                                        <Save className="w-4 h-4" />
                                        {saving ? 'Menyimpan...' : 'Simpan'}
                                    </button>
                                </div>
                            </form>
                        </div>
                    </div>
                </>
            )}

            {activeTab === 'pricelist' && (
                <div className="space-y-4">
                    {!settings.configured ? (
                        <div className="rounded-lg border p-4 ui-warning-chip">
                            <AlertCircle className="w-5 h-5 inline mr-2" />
                            Konfigurasi kredensial Tokovoucher terlebih dahulu di tab Settings
                        </div>
                    ) : (
                        <div className="space-y-4">
                            {/* SKU Search Box */}
                            <div className="ui-panel-muted rounded-xl border ui-border p-4">
                                <form onSubmit={handleSkuSearch} className="flex gap-3">
                                    <div className="flex-1 relative">
                                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ui-text-muted" />
                                        <input
                                            type="text"
                                            value={skuSearch}
                                            onChange={(e) => setSkuSearch(e.target.value)}
                                            placeholder="Cari produk berdasarkan kode/SKU (contoh: FF, ML5, AXIS)..."
                                            className="w-full rounded-lg border pl-10 pr-3 py-2 ui-field"
                                        />
                                    </div>
                                    <button
                                        type="submit"
                                        disabled={searchLoading}
                                        className="px-4 py-2 ui-accent-solid rounded-lg disabled:opacity-50"
                                    >
                                        {searchLoading ? 'Mencari...' : 'Cari'}
                                    </button>
                                    {isSearchMode && (
                                        <button
                                            type="button"
                                            onClick={clearSearch}
                                            className="px-4 py-2 border rounded-lg ui-muted-action"
                                        >
                                            Reset
                                        </button>
                                    )}
                                </form>
                                {isSearchMode && (
                                    <div className="mt-2 text-sm ui-text-muted">
                                        Ditemukan <strong className="ui-text">{searchResults.length}</strong> produk untuk "{skuSearch}"
                                    </div>
                                )}
                            </div>

                            {pricelistError && (
                                <div className="rounded-lg border p-4 ui-danger-chip">
                                    {pricelistError}
                                </div>
                            )}

                            {/* Search Results Table */}
                            {isSearchMode ? (
                                <div className="ui-panel-muted rounded-xl border ui-border overflow-hidden">
                                    <div className="overflow-x-auto">
                                        <table className="min-w-full divide-y ui-border">
                                            <thead className="ui-panel ui-text-muted text-xs uppercase">
                                                <tr>
                                                    <th className="px-4 py-3 text-left font-semibold">Kode</th>
                                                    <th className="px-4 py-3 text-left font-semibold">Nama Produk</th>
                                                    <th className="px-4 py-3 text-left font-semibold">Kategori</th>
                                                    <th className="px-4 py-3 text-left font-semibold">Operator</th>
                                                    <th className="px-4 py-3 text-right font-semibold">Harga</th>
                                                    <th className="px-4 py-3 text-center font-semibold">Status</th>
                                                    <th className="px-4 py-3 text-right font-semibold">Aksi</th>
                                                </tr>
                                            </thead>
                                            <tbody className="divide-y ui-border">
                                                {searchLoading ? (
                                                    <tr>
                                                        <td colSpan={7} className="px-4 py-6 text-center ui-text-muted">
                                                            <div className="flex items-center justify-center gap-2">
                                                                <div className="h-5 w-5 rounded-full border-2 border-[color-mix(in_srgb,var(--ui-accent)_24%,transparent)] border-t-[var(--ui-accent)] animate-spin" />
                                                                Mencari produk...
                                                            </div>
                                                        </td>
                                                    </tr>
                                                ) : searchResults.length === 0 ? (
                                                    <tr>
                                                        <td colSpan={7} className="px-4 py-10 text-center">
                                                            <Package className="w-12 h-12 ui-text-muted mx-auto mb-3" />
                                                            <p className="ui-text font-semibold">Produk tidak ditemukan</p>
                                                            <p className="ui-text-muted text-sm">Coba gunakan kode atau prefix yang berbeda</p>
                                                        </td>
                                                    </tr>
                                                ) : (
                                                    searchResults.map((item: any) => (
                                                        <tr key={item.id || item.code} className="hover:bg-[var(--ui-card-bg)]">
                                                            <td className="px-4 py-3">
                                                                <code className="text-xs ui-panel px-2 py-1 rounded ui-text-muted">{item.code}</code>
                                                            </td>
                                                            <td className="px-4 py-3 text-sm font-medium ui-text">{item.nama_produk}</td>
                                                            <td className="px-4 py-3 text-sm ui-text-muted">{item.category_name || '-'}</td>
                                                            <td className="px-4 py-3 text-sm ui-text-muted">{item.operator_produk || '-'}</td>
                                                            <td className="px-4 py-3 text-sm text-right font-semibold ui-text">
                                                                Rp {(item.price || 0).toLocaleString('id-ID')}
                                                            </td>
                                                            <td className="px-4 py-3 text-center">
                                                                <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-semibold ${
                                                                    item.status === 1 ? 'ui-success-chip' : 'ui-danger-chip'
                                                                }`}>
                                                                    {item.status === 1 ? 'Aktif' : 'Nonaktif'}
                                                                </span>
                                                            </td>
                                                            <td className="px-4 py-3 text-right">
                                                                <button
                                                                    type="button"
                                                                    onClick={() => openPurchaseModal(item)}
                                                                    disabled={item.status !== 1}
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
                                </div>
                            ) : (
                                <div className="space-y-4">
                                    {/* Breadcrumb */}
                                    <div className="flex items-center gap-2 text-sm ui-text-muted flex-wrap">
                                        <span className="font-medium ui-text">Filter:</span>
                                        {selectedCategory && (
                                            <>
                                                <span className="ui-warning-chip border px-2 py-1 rounded">{getCategoryName()}</span>
                                                {selectedOperator && (
                                                    <>
                                                        <ChevronRight className="w-4 h-4" />
                                                        <span className="ui-success-chip border px-2 py-1 rounded">{getOperatorName()}</span>
                                                    </>
                                                )}
                                                {selectedJenis && (
                                                    <>
                                                        <ChevronRight className="w-4 h-4" />
                                                        <span className="ui-accent-chip border px-2 py-1 rounded">{getJenisName()}</span>
                                                    </>
                                                )}
                                            </>
                                        )}
                                        {!selectedCategory && <span className="ui-text-muted">Pilih kategori untuk memulai</span>}
                                    </div>

                                    {/* Filter Grid */}
                                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                                        {/* Categories */}
                                        <div className="ui-panel-muted rounded-xl border ui-border">
                                            <div className="p-3 border-b ui-border font-semibold ui-text">
                                                Kategori
                                            </div>
                                            <div className="p-2 max-h-64 overflow-y-auto">
                                                {loadingCategories ? (
                                                    <div className="p-4 text-center ui-text-muted">Memuat...</div>
                                                ) : categories.length === 0 ? (
                                                    <div className="p-4 text-center ui-text-muted">Tidak ada data</div>
                                                ) : (
                                                    categories.map((cat) => (
                                                        <button
                                                            key={cat.id}
                                                            onClick={() => setSelectedCategory(cat.id)}
                                                            className={`w-full text-left px-3 py-2 rounded-lg text-sm ${
                                                                selectedCategory === cat.id
                                                                     ? 'ui-warning-chip font-medium'
                                                                    : 'hover:bg-[var(--ui-card-bg)] ui-text-muted'
                                                            }`}
                                                        >
                                                            {cat.nama}
                                                        </button>
                                                    ))
                                                )}
                                            </div>
                                        </div>

                                        {/* Operators */}
                                        <div className="ui-panel-muted rounded-xl border ui-border">
                                            <div className="p-3 border-b ui-border font-semibold ui-text">
                                                Operator
                                            </div>
                                            <div className="p-2 max-h-64 overflow-y-auto">
                                                {!selectedCategory ? (
                                                    <div className="p-4 text-center ui-text-muted text-sm">Pilih kategori</div>
                                                ) : loadingOperators ? (
                                                    <div className="p-4 text-center ui-text-muted">Memuat...</div>
                                                ) : operators.length === 0 ? (
                                                    <div className="p-4 text-center ui-text-muted">Tidak ada data</div>
                                                ) : (
                                                    operators.map((op) => (
                                                        <button
                                                            key={op.id}
                                                            onClick={() => setSelectedOperator(op.id)}
                                                            className={`w-full text-left px-3 py-2 rounded-lg text-sm ${
                                                                selectedOperator === op.id
                                                                     ? 'ui-success-chip font-medium'
                                                                    : 'hover:bg-[var(--ui-card-bg)] ui-text-muted'
                                                            }`}
                                                        >
                                                            {op.nama}
                                                        </button>
                                                    ))
                                                )}
                                            </div>
                                        </div>

                                        {/* Jenis */}
                                        <div className="ui-panel-muted rounded-xl border ui-border">
                                            <div className="p-3 border-b ui-border font-semibold ui-text">
                                                Jenis
                                            </div>
                                            <div className="p-2 max-h-64 overflow-y-auto">
                                                {!selectedOperator ? (
                                                    <div className="p-4 text-center ui-text-muted text-sm">Pilih operator</div>
                                                ) : loadingJenis ? (
                                                    <div className="p-4 text-center ui-text-muted">Memuat...</div>
                                                ) : jenisList.length === 0 ? (
                                                    <div className="p-4 text-center ui-text-muted">Tidak ada data</div>
                                                ) : (
                                                    jenisList.map((j) => (
                                                        <button
                                                            key={j.id}
                                                            onClick={() => setSelectedJenis(j.id)}
                                                            className={`w-full text-left px-3 py-2 rounded-lg text-sm ${
                                                                selectedJenis === j.id
                                                                     ? 'ui-accent-chip font-medium'
                                                                    : 'hover:bg-[var(--ui-card-bg)] ui-text-muted'
                                                            }`}
                                                        >
                                                            {j.nama}
                                                        </button>
                                                    ))
                                                )}
                                            </div>
                                        </div>

                                        {/* Products Count */}
                                        <div className="ui-panel-muted rounded-xl border ui-border">
                                            <div className="p-3 border-b ui-border font-semibold ui-text">
                                                Produk
                                            </div>
                                            <div className="p-4 text-center">
                                                {!selectedJenis ? (
                                                    <div className="ui-text-muted text-sm">Pilih jenis</div>
                                                ) : loadingProducts ? (
                                                    <div className="ui-text-muted">Memuat...</div>
                                                ) : (
                                                    <div className="text-3xl font-bold ui-warning-text">{products.length}</div>
                                                )}
                                                <div className="text-sm ui-text-muted mt-1">produk tersedia</div>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Products Table */}
                                    {selectedJenis && (
                                        <div className="ui-panel-muted rounded-xl border ui-border overflow-hidden">
                                            <div className="overflow-x-auto">
                                                <table className="min-w-full divide-y ui-border">
                                                    <thead className="ui-panel ui-text-muted text-xs uppercase">
                                                        <tr>
                                                            <th className="px-4 py-3 text-left font-semibold">Kode</th>
                                                            <th className="px-4 py-3 text-left font-semibold">Nama Produk</th>
                                                            <th className="px-4 py-3 text-right font-semibold">Harga</th>
                                                            <th className="px-4 py-3 text-center font-semibold">Status</th>
                                                            <th className="px-4 py-3 text-right font-semibold">Aksi</th>
                                                        </tr>
                                                    </thead>
                                                    <tbody className="divide-y ui-border">
                                                        {loadingProducts ? (
                                                            <tr>
                                                                <td colSpan={5} className="px-4 py-6 text-center ui-text-muted">
                                                                    <div className="flex items-center justify-center gap-2">
                                                                        <div className="h-5 w-5 rounded-full border-2 border-[color-mix(in_srgb,var(--ui-accent)_24%,transparent)] border-t-[var(--ui-accent)] animate-spin" />
                                                                        Memuat data...
                                                                    </div>
                                                                </td>
                                                            </tr>
                                                        ) : products.length === 0 ? (
                                                            <tr>
                                                                <td colSpan={5} className="px-4 py-10 text-center">
                                                                    <Package className="w-12 h-12 ui-text-muted mx-auto mb-3" />
                                                                    <p className="ui-text font-semibold">Tidak ada produk</p>
                                                                </td>
                                                            </tr>
                                                        ) : (
                                                            products.map((item) => (
                                                                <tr key={item.id} className="hover:bg-[var(--ui-card-bg)]">
                                                                    <td className="px-4 py-3">
                                                                        <code className="text-xs ui-panel px-2 py-1 rounded ui-text-muted">{item.code}</code>
                                                                    </td>
                                                                    <td className="px-4 py-3 text-sm font-medium ui-text">{item.nama_produk}</td>
                                                                    <td className="px-4 py-3 text-sm text-right font-semibold ui-text">
                                                                        Rp {(item.price || 0).toLocaleString('id-ID')}
                                                                    </td>
                                                                    <td className="px-4 py-3 text-center">
                                                                        <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-semibold ${
                                                                            item.status === 1 ? 'ui-success-chip' : 'ui-danger-chip'
                                                                        }`}>
                                                                            {item.status === 1 ? 'Aktif' : 'Nonaktif'}
                                                                        </span>
                                                                    </td>
                                                                    <td className="px-4 py-3 text-right">
                                                                        <button
                                                                            type="button"
                                                                            onClick={() => openPurchaseModal(item)}
                                                                            disabled={item.status !== 1}
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
                                        </div>
                                    )}
                                </div>
                            )}

                            {selectedPurchaseItem && (
                                <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm">
                                    <form onSubmit={handleInternalPurchase} role="dialog" aria-modal="true" aria-labelledby="tokovoucher-internal-purchase-title" className="ui-panel w-full max-w-lg rounded-2xl border ui-border shadow-2xl">
                                        <div className="flex items-start justify-between gap-4 border-b ui-border p-5">
                                            <div>
                                                <p className="ui-accent-chip inline-flex rounded-full border px-3 py-1 text-xs font-bold">Pembelian Internal</p>
                                                <h3 id="tokovoucher-internal-purchase-title" className="mt-3 text-xl font-black ui-text">Beli via Tokovoucher</h3>
                                                <p className="mt-1 text-sm ui-text-muted">Aksi ini langsung mengirim order dan memakai saldo vendor. Pastikan kode, target, server ID, dan harga benar.</p>
                                            </div>
                                            <button type="button" onClick={closePurchaseModal} className="rounded-lg p-2 ui-text-muted hover:bg-[var(--ui-panel-muted)] hover:text-[var(--ui-text)]">
                                                <X className="h-5 w-5" />
                                            </button>
                                        </div>
                                        <div className="space-y-4 p-5">
                                            <div className="rounded-xl border ui-border ui-panel-muted p-4 text-sm">
                                                <p className="font-black ui-text">{selectedPurchaseItem.nama_produk}</p>
                                                <p className="mt-1 font-mono text-xs ui-text-muted">Kode: {selectedPurchaseItem.code}</p>
                                                <p className="mt-2 font-semibold ui-text">Rp{(selectedPurchaseItem.price || 0).toLocaleString('id-ID')}</p>
                                                {purchaseCustomerNo.trim() ? <p className="mt-2 text-xs font-bold text-red-500">Target: {purchaseCustomerNo.trim()}{purchaseServerId.trim() ? ` / Server: ${purchaseServerId.trim()}` : ''}</p> : null}
                                            </div>
                                            <div>
                                                <label htmlFor="tokovoucher-internal-customer-no" className="mb-2 block text-sm font-semibold ui-text">Nomor tujuan / customer no</label>
                                                <input
                                                    id="tokovoucher-internal-customer-no"
                                                    value={purchaseCustomerNo}
                                                    onChange={(event) => setPurchaseCustomerNo(event.target.value)}
                                                    className="w-full rounded-xl border px-3 py-3 ui-field"
                                                    placeholder="Masukkan nomor tujuan"
                                                />
                                            </div>
                                            <div>
                                                <label htmlFor="tokovoucher-internal-server-id" className="mb-2 block text-sm font-semibold ui-text">Server ID</label>
                                                <input
                                                    id="tokovoucher-internal-server-id"
                                                    value={purchaseServerId}
                                                    onChange={(event) => setPurchaseServerId(event.target.value)}
                                                    className="w-full rounded-xl border px-3 py-3 ui-field"
                                                    placeholder="Opsional"
                                                />
                                            </div>
                                            <div>
                                                <label htmlFor="tokovoucher-internal-note" className="mb-2 block text-sm font-semibold ui-text">Catatan internal</label>
                                                <textarea
                                                    id="tokovoucher-internal-note"
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
                                        <p className="text-sm ui-text-muted">20 pembelian internal Tokovoucher terbaru.</p>
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
                                                <th className="px-3 py-2 text-left font-semibold ui-text-muted">Server ID</th>
                                                <th className="px-3 py-2 text-left font-semibold ui-text-muted">Ref ID</th>
                                                <th className="px-3 py-2 text-left font-semibold ui-text-muted">Status</th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y ui-border">
                                            {purchaseHistoryLoading ? (
                                                <tr><td colSpan={7} className="px-3 py-6 text-center ui-text-muted">Memuat riwayat...</td></tr>
                                            ) : purchaseHistory.length === 0 ? (
                                                <tr><td colSpan={7} className="px-3 py-6 text-center ui-text-muted">Belum ada riwayat pembelian internal</td></tr>
                                            ) : purchaseHistory.map((item) => (
                                                <tr key={item._id}>
                                                    <td className="px-3 py-2 ui-text-muted">{formatPurchaseDate(item.createdAt)}</td>
                                                    <td className="px-3 py-2 ui-text">{item.createdBy?.name || item.createdBy?.email || '-'}</td>
                                                    <td className="px-3 py-2 ui-text">{item.productName}<div className="font-mono text-xs ui-text-muted">{item.buyerSkuCode}</div></td>
                                                    <td className="px-3 py-2 font-mono ui-text-muted">{item.customerNo}</td>
                                                    <td className="px-3 py-2 font-mono ui-text-muted">{item.serverId || '-'}</td>
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
                </div>
            )}

            {activeTab === 'webhook' && (
                <div className="space-y-5">
                    {/* Webhook URL Info */}
                    <div className="ui-panel-muted rounded-xl border ui-border p-4">
                        <h3 className="font-semibold ui-text mb-2">Webhook URL</h3>
                        <p className="text-sm ui-text-muted mb-3">
                            Salin URL di bawah ini dan paste di pengaturan Webhook Tokovoucher.
                        </p>
                        <div className="flex items-center gap-2">
                            <input
                                type="text"
                                readOnly
                                value={`${window.location.origin}/api/v2/webhook/tokovoucher`}
                                className="flex-1 rounded-lg border px-3 py-2 ui-field font-mono text-sm"
                            />
                            <button
                                onClick={() => {
                                    navigator.clipboard.writeText(`${window.location.origin}/api/v2/webhook/tokovoucher`);
                                    setMessage({ type: 'success', text: 'URL berhasil disalin!' });
                                }}
                                className="px-4 py-2 ui-accent-solid rounded-lg text-sm font-medium"
                            >
                                Salin
                            </button>
                        </div>
                        <div className="mt-3 p-3 ui-panel rounded-lg border ui-border">
                            <p className="text-xs ui-text-muted mb-2">Verifikasi otomatis menggunakan header:</p>
                            <code className="text-xs ui-info-text font-mono">X-TokoVoucher-Authorization: md5(MEMBER_CODE:SECRET:REF_ID)</code>
                            <p className="text-xs ui-text-muted mt-2">
                                Signature diverifikasi otomatis menggunakan Member Code dan Secret yang sudah dikonfigurasi di tab Settings.
                            </p>
                        </div>
                    </div>

                    {/* Whitelist IP */}
                    <div className="ui-panel-muted rounded-xl border ui-border">
                        <div className="p-4 border-b ui-border">
                            <h3 className="font-semibold ui-text">Whitelist IP</h3>
                            <p className="text-sm ui-text-muted">Batasi IP yang diizinkan mengirim webhook.</p>
                        </div>
                        <div className="p-4 space-y-4">
                            <div>
                                <label className="block text-sm font-medium ui-text mb-1">Daftar IP</label>
                                <input
                                    type="text"
                                    value={webhookWhitelistIP}
                                    onChange={(e) => setWebhookWhitelistIP(e.target.value)}
                                    className="w-full rounded-lg border px-3 py-2 ui-field"
                                    placeholder="Contoh: 188.166.243.56"
                                />
                                <p className="text-xs ui-text-muted mt-1">
                                    Pisahkan dengan koma. Signature Tokovoucher tetap wajib aktif; whitelist ini menjadi lapisan proteksi tambahan.
                                </p>
                                {webhookProtectionMode === 'unprotected' && (
                                    <p className="text-xs ui-danger-text mt-2">Webhook belum aman. Lengkapi kredensial Tokovoucher agar signature callback bisa diverifikasi.</p>
                                )}
                                {webhookProtectionMode === 'ip_only' && (
                                    <p className="text-xs ui-warning-text mt-2">Webhook saat ini hanya mengandalkan whitelist IP. Pastikan kredensial Tokovoucher tetap valid.</p>
                                )}
                                <div className="mt-2 p-2 ui-panel rounded-lg border ui-border">
                                    <p className="text-xs ui-text-muted">IP Server Tokovoucher (dari dokumentasi):</p>
                                    <div className="flex flex-wrap gap-1 mt-1">
                                        {['188.166.243.56'].map((ip) => (
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
                                <p className="text-sm ui-text-muted">100 log terakhir dari callback Tokovoucher</p>
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
                                        <th className="px-4 py-3 text-left text-xs font-semibold ui-text-muted">Ref ID</th>
                                        <th className="px-4 py-3 text-left text-xs font-semibold ui-text-muted">Status</th>
                                        <th className="px-4 py-3 text-left text-xs font-semibold ui-text-muted">Message</th>
                                        <th className="px-4 py-3 text-left text-xs font-semibold ui-text-muted">Verified</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y ui-border">
                                    {webhookLogsLoading ? (
                                        <tr><td colSpan={5} className="px-4 py-8 text-center ui-text-muted">Memuat...</td></tr>
                                    ) : webhookLogs.length === 0 ? (
                                        <tr><td colSpan={5} className="px-4 py-8 text-center ui-text-muted">Belum ada log webhook</td></tr>
                                    ) : (
                                        webhookLogs.map((log) => (
                                            <tr key={log.id} className="hover:bg-[var(--ui-card-bg)]">
                                                <td className="px-4 py-3 text-xs ui-text-muted whitespace-nowrap">
                                                    {new Date(log.timestamp).toLocaleString('id-ID')}
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
                        <h3 className="font-semibold ui-text mb-3">Cara Setup Webhook Tokovoucher</h3>
                        <ol className="list-decimal list-inside space-y-2 text-sm ui-text-muted">
                            <li>Login ke dashboard <a href="https://member.tokovoucher.net" target="_blank" rel="noopener noreferrer" className="ui-accent-text underline">member.tokovoucher.net</a></li>
                            <li>Buka menu <strong className="ui-text">Pengaturan</strong> atau <strong className="ui-text">API Settings</strong></li>
                            <li>Paste <strong className="ui-text">Webhook URL</strong> di atas ke kolom Webhook URL</li>
                            <li>Simpan pengaturan</li>
                        </ol>
                        <div className="mt-4 rounded-lg border p-3 ui-warning-chip">
                            <p className="text-xs">
                                <strong>Penting:</strong> Tokovoucher memverifikasi webhook via header <code className="ui-panel px-1 rounded">X-TokoVoucher-Authorization</code> dengan formula <code className="ui-panel px-1 rounded">md5(MEMBER_CODE:SECRET:REF_ID)</code>.
                                Pastikan Member Code dan Secret sudah benar di tab Settings.
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
