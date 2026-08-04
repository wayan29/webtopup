import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
    AlertTriangle,
    Clock3,
    CreditCard,
    Edit,
    FolderOpen,
    Image as ImageIcon,
    Layers3,
    Loader2,
    Plus,
    RefreshCw,
    RotateCcw,
    Search,
    ShieldAlert,

    Trash2,
    Upload,
    Wallet,
    X
} from 'lucide-react';
import { apiV2 } from '../../api';
import { useStepUpOrchestration } from '../../auth/useStepUpOrchestration';
import { stepUpActionErrorMessage } from '../../auth/withStepUp';
import ImagePicker from '../../components/admin/ImagePicker';
import { useAuthStore } from '../../store/useAuthStore';

type PaymentCategory = {
    _id: string;
    name: string;
    slug: string;
    icon?: string;
    status: 'active' | 'inactive';
};

type PaymentMethod = {
    _id: string;
    name: string;
    category: PaymentCategory | string | null;
    accountNumber: string;
    accountName: string;
    icon?: string;
    minAmount: number;
    maxAmount: number;
    adminFee: number;
    adminPercent: number;
    operationalStart: string;
    operationalEnd: string;
    useUniqueCode: boolean;
    status: 'active' | 'inactive';
    dependency?: {
        depositCount: number;
        pendingDepositCount: number;
        guestTransactionCount: number;
        waitingPaymentCount: number;
        totalUsageCount: number;
    };
    canDelete?: boolean;
    deleteBlockedReason?: string;
    isOperationalNow?: boolean;
    isVisibleToUsers?: boolean;
    visibilityIssues?: string[];
};

type FormData = {
    name: string;
    category: string;
    accountNumber: string;
    accountName: string;
    icon: string;
    minAmount: number;
    maxAmount: number;
    adminFee: number;
    adminPercent: number;
    operationalStart: string;
    operationalEnd: string;
    useUniqueCode: boolean;
    status: 'active' | 'inactive';
};

const defaultForm: FormData = {
    name: '',
    category: '',
    accountNumber: '',
    accountName: '',
    icon: '',
    minAmount: 10000,
    maxAmount: 5000000,
    adminFee: 0,
    adminPercent: 0,
    operationalStart: '00:00',
    operationalEnd: '23:59',
    useUniqueCode: true,
    status: 'active'
};

const formatCurrency = (value: number) => `Rp ${Math.max(0, value || 0).toLocaleString('id-ID')}`;

const getCategoryName = (category: PaymentCategory | string | null): string => {
    if (!category) return '-';
    if (typeof category === 'string') return category;
    return category.name;
};

const getCategoryId = (category: PaymentCategory | string | null): string => {
    if (!category) return '';
    if (typeof category === 'string') return category;
    return category._id;
};

const getCategoryStatus = (category: PaymentCategory | string | null): 'active' | 'inactive' | 'missing' => {
    if (!category) return 'missing';
    if (typeof category === 'string') return 'missing';
    return category.status;
};

const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;

const filterValuesFromSearchParams = (params: URLSearchParams) => ({
    search: params.get('search') || '',
    status: (params.get('status') as 'all' | 'active' | 'inactive') || 'all',
    category: params.get('category') || 'all'
});

export default function PaymentMethods() {
    const stepUp = useStepUpOrchestration();
    const [searchParams, setSearchParams] = useSearchParams();
    const { isOwner, hasPermission } = useAuthStore();
    const canManagePayment = isOwner || hasPermission('managePayment');
    const initialFilters = useMemo(() => filterValuesFromSearchParams(searchParams), []);
    const [methods, setMethods] = useState<PaymentMethod[]>([]);
    const [categories, setCategories] = useState<PaymentCategory[]>([]);
    const [search, setSearch] = useState(initialFilters.search);
    const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>(initialFilters.status);
    const [categoryFilter, setCategoryFilter] = useState<string>(initialFilters.category);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [showModal, setShowModal] = useState(false);
    const [editingMethod, setEditingMethod] = useState<PaymentMethod | null>(null);
    const [methodToDelete, setMethodToDelete] = useState<PaymentMethod | null>(null);
    const [form, setForm] = useState(defaultForm);
    const [uploadingIcon, setUploadingIcon] = useState(false);
    const [showIconPicker, setShowIconPicker] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const latestRequestId = useRef(0);

    const syncUrlParams = useCallback((nextSearch: string, nextStatus: string, nextCategory: string) => {
        const params = new URLSearchParams();
        if (nextSearch.trim()) params.set('search', nextSearch.trim());
        if (nextStatus !== 'all') params.set('status', nextStatus);
        if (nextCategory !== 'all') params.set('category', nextCategory);
        setSearchParams(params, { replace: true });
    }, [setSearchParams]);

    const fetchMethods = useCallback(async () => {
        const requestId = latestRequestId.current + 1;
        latestRequestId.current = requestId;
        setLoading(true);
        setMessage(null);
        try {
            const response = await apiV2
                .get('/payment-methods/admin/all');
            if (requestId !== latestRequestId.current) return;
            setMethods(response.data);
        } catch (error: any) {
            if (requestId !== latestRequestId.current) return;
            console.error('Failed to fetch payment methods', error);
            setMessage({ type: 'error', text: error.response?.data?.message || 'Gagal memuat metode pembayaran' });
        } finally {
            if (requestId === latestRequestId.current) {
                setLoading(false);
            }
        }
    }, []);

    const fetchCategories = useCallback(async () => {
        try {
            const response = await apiV2
                .get('/payment-categories/admin/all');
            setCategories(response.data);
        } catch (error: any) {
            console.error('Failed to fetch payment categories', error);
            setMessage({ type: 'error', text: error.response?.data?.message || 'Gagal memuat kategori pembayaran' });
        }
    }, []);

    const refreshAll = useCallback(async () => {
        await Promise.all([fetchMethods(), fetchCategories()]);
    }, [fetchCategories, fetchMethods]);

    useEffect(() => {
        refreshAll();
    }, [refreshAll]);

    useEffect(() => {
        const handleRefresh = () => refreshAll();
        window.addEventListener('admin:refresh-current-page', handleRefresh);
        return () => window.removeEventListener('admin:refresh-current-page', handleRefresh);
    }, [refreshAll]);

    const filteredMethods = useMemo(() => {
        const keyword = search.trim().toLowerCase();

        return methods.filter((method) => {
            const matchesSearch =
                !keyword ||
                method.name.toLowerCase().includes(keyword) ||
                method.accountNumber.toLowerCase().includes(keyword) ||
                method.accountName.toLowerCase().includes(keyword) ||
                getCategoryName(method.category).toLowerCase().includes(keyword);

            const matchesStatus =
                statusFilter === 'all' || method.status === statusFilter;

            const matchesCategory =
                categoryFilter === 'all' || getCategoryId(method.category) === categoryFilter;

            return matchesSearch && matchesStatus && matchesCategory;
        });
    }, [methods, search, statusFilter, categoryFilter]);

    const summary = useMemo(() => {
        return methods.reduce(
            (result, method) => {
                result.total += 1;
                result.blocked += method.canDelete === false ? 1 : 0;
                result.historicalUsage += Number(method.dependency?.totalUsageCount ?? 0);

                if (method.status === 'active') {
                    result.active += 1;
                } else {
                    result.inactive += 1;
                }

                if (method.isVisibleToUsers) {
                    result.visible += 1;
                } else {
                    result.hidden += 1;
                }

                return result;
            },
            {
                total: 0,
                active: 0,
                inactive: 0,
                visible: 0,
                hidden: 0,
                blocked: 0,
                historicalUsage: 0
            }
        );
    }, [methods]);

    const selectedCategory = useMemo(
        () => categories.find((category) => category._id === form.category) ?? null,
        [categories, form.category]
    );

    const hasActiveFilters = Boolean(search.trim() || statusFilter !== 'all' || categoryFilter !== 'all');

    useEffect(() => {
        syncUrlParams(search, statusFilter, categoryFilter);
    }, [categoryFilter, search, statusFilter, syncUrlParams]);

    const attentionMethods = methods
        .filter((method) => method.status === 'inactive' || !method.isVisibleToUsers || method.canDelete === false)
        .slice(0, 4);

    const validateForm = () => {
        if (!form.name.trim()) return 'Nama metode pembayaran wajib diisi';
        if (!form.category) return 'Kategori wajib dipilih';
        if (!form.accountNumber.trim()) return 'Nomor rekening wajib diisi';
        if (!form.accountName.trim()) return 'Atas nama wajib diisi';
        if (form.minAmount < 0) return 'Minimum amount tidak boleh negatif';
        if (form.maxAmount <= 0) return 'Maximum amount harus lebih besar dari 0';
        if (form.maxAmount < form.minAmount) return 'Maximum amount tidak boleh lebih kecil dari minimum amount';
        if (form.adminFee < 0) return 'Biaya admin tetap tidak boleh negatif';
        if (form.adminPercent < 0 || form.adminPercent > 100) return 'Biaya admin persen harus di antara 0 sampai 100';
        if (!timePattern.test(form.operationalStart) || !timePattern.test(form.operationalEnd)) return 'Jam operasional harus berformat HH:mm';

        return null;
    };

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();

        const validationError = validateForm();
        if (validationError) {
            setMessage({ type: 'error', text: validationError });
            return;
        }

        setSaving(true);
        setMessage(null);
        try {
            const payload = {
                ...form,
                name: form.name.trim(),
                accountNumber: form.accountNumber.trim(),
                accountName: form.accountName.trim(),
                icon: form.icon.trim()
            };

            if (editingMethod) {
                await stepUp.run('integrations.credentials', (config) =>
                    apiV2.put(`/payment-methods/${editingMethod._id}`, payload, config as never),
                );
            } else {
                await stepUp.run('integrations.credentials', (config) =>
                    apiV2.post('/payment-methods', payload, config as never),
                );
            }

            await refreshAll();
            setMessage({ type: 'success', text: editingMethod ? 'Metode pembayaran berhasil diperbarui' : 'Metode pembayaran berhasil ditambahkan' });
            setShowModal(false);
            setForm(defaultForm);
            setEditingMethod(null);
        } catch (error: any) {
            console.error('Failed to save payment method', error);
            const text = stepUpActionErrorMessage(error, 'Gagal menyimpan metode pembayaran');
            if (text) setMessage({ type: 'error', text });
        } finally {
            setSaving(false);
        }
    };

    const handleIconUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        if (!file.type.startsWith('image/')) {
            setMessage({ type: 'error', text: 'File icon harus berupa gambar' });
            return;
        }

        setUploadingIcon(true);
        setMessage(null);
        try {
            const formData = new FormData();
            formData.append('file', file);

            const response = await apiV2
                .post('/upload?type=icons', formData, {
                    headers: { 'Content-Type': 'multipart/form-data' }
                });

            if (response.data?.url) {
                setForm((current) => ({ ...current, icon: response.data.url }));
            }
        } catch (error: any) {
            console.error('Icon upload failed', error);
            setMessage({ type: 'error', text: error.response?.data?.message || 'Gagal upload icon pembayaran' });
        } finally {
            setUploadingIcon(false);
        }
    };

    const handleEdit = (method: PaymentMethod) => {
        if (!canManagePayment) return;
        setEditingMethod(method);
        setForm({
            name: method.name,
            category: getCategoryId(method.category),
            accountNumber: method.accountNumber,
            accountName: method.accountName,
            icon: method.icon || '',
            minAmount: method.minAmount,
            maxAmount: method.maxAmount,
            adminFee: method.adminFee,
            adminPercent: method.adminPercent,
            operationalStart: method.operationalStart,
            operationalEnd: method.operationalEnd,
            useUniqueCode: method.useUniqueCode ?? true,
            status: method.status
        });
        setShowModal(true);
    };

    const confirmDelete = async () => {
        if (!methodToDelete || deleting || methodToDelete.canDelete === false) return;

        setDeleting(true);
        setMessage(null);
        try {
            await stepUp.run('integrations.credentials', (config) =>
                apiV2.delete(`/payment-methods/${methodToDelete._id}`, config as never),
            );
            await refreshAll();
            setMessage({ type: 'success', text: 'Metode pembayaran berhasil dihapus' });
            setMethodToDelete(null);
        } catch (error: any) {
            console.error('Failed to delete payment method', error);
            const text = stepUpActionErrorMessage(error, 'Gagal menghapus metode pembayaran');
            if (text) setMessage({ type: 'error', text });
        } finally {
            setDeleting(false);
        }
    };

    const openAddModal = () => {
        if (!canManagePayment) return;
        setEditingMethod(null);
        setForm(defaultForm);
        setMessage(null);
        setShowModal(true);
    };

    const inputClass = 'w-full rounded-lg ui-field border px-3 py-2 text-sm';
    const selectClass = 'w-full rounded-lg ui-field border px-3 py-2 text-sm';
    const labelClass = 'block text-sm font-medium ui-text-muted mb-1';

    return (
        <div className="space-y-6">
            <div className="ui-panel rounded-2xl border ui-border p-4 sm:p-5">
                <div className="relative">
                    <div className="rounded-3xl border ui-border bg-[var(--ui-card-bg)]/75 p-5 backdrop-blur">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <p className="text-xs uppercase tracking-[0.18em] ui-text-muted">Sinyal Rail</p>
                                <h2 className="mt-1 text-lg font-bold ui-text">{filteredMethods.length} metode dalam view</h2>
                                <p className="mt-1 text-xs ui-text-muted">{categories.length} kategori tersedia</p>
                            </div>
                            <div className="flex gap-2">
                                <button
                                    onClick={refreshAll}
                                    className="ui-muted-action inline-flex items-center justify-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold"
                                >
                                    <RefreshCw className="h-4 w-4" />
                                    Segarkan
                                </button>
                                {canManagePayment && (
                                    <button
                                        onClick={openAddModal}
                                        className="ui-accent-solid inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold transition-colors"
                                    >
                                        <Plus className="h-4 w-4" />
                                        Tambah Metode
                                    </button>
                                )}
                            </div>
                        </div>
                        <div className="mt-5 space-y-3">
                            {(attentionMethods.length > 0 ? attentionMethods : methods.slice(0, 4)).map((method) => (
                                <button
                                    key={method._id}
                                    type="button"
                                    onClick={() => {
                                    if (canManagePayment) handleEdit(method);
                                }}
                                    className="w-full rounded-2xl border ui-border bg-[var(--ui-card-muted)]/80 p-3 text-left transition hover:border-[var(--ui-accent)]"
                                >
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <p className="truncate text-sm font-semibold ui-text">{method.name}</p>
                                            <p className="mt-1 truncate text-xs ui-text-muted">{getCategoryName(method.category)} • {method.accountNumber}</p>
                                        </div>
                                        <span className={`inline-flex shrink-0 rounded-full border px-2 py-1 text-xs font-semibold ${method.isVisibleToUsers ? 'ui-success-chip' : 'ui-warning-chip'}`}>
                                            {method.isVisibleToUsers ? 'Visible' : 'Hidden'}
                                        </span>
                                    </div>
                                </button>
                            ))}
                            {!loading && methods.length === 0 && (
                                <div className="rounded-2xl border ui-border bg-[var(--ui-card-muted)]/80 p-4 text-sm ui-text-muted">
                                    Belum ada metode pembayaran.
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            {message && (
                <div className={`rounded-xl border px-4 py-3 text-sm ${message.type === 'success' ? 'ui-success-chip' : 'ui-danger-chip'}`}>
                    {message.text}
                </div>
            )}

            {!canManagePayment && (
                <div className="ui-warning-chip rounded-xl border p-4 text-sm">
                    Akun ini hanya dapat melihat metode pembayaran. Aksi tambah, edit, dan hapus disembunyikan.
                </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-2xl border ui-border ui-panel-muted p-4">
                    <div className="flex items-start justify-between">
                        <div>
                            <p className="text-[11px] uppercase tracking-[0.18em] ui-text-muted">Total Metode</p>
                            <p className="mt-2 text-3xl font-black ui-text">{summary.total}</p>
                            <p className="mt-1 text-sm ui-text-muted">{summary.active} aktif</p>
                        </div>
                        <div className="rounded-xl bg-[var(--ui-accent-soft)] p-2.5 ui-accent-text">
                            <CreditCard className="w-5 h-5" />
                        </div>
                    </div>
                </div>
                <div className="rounded-2xl border ui-border ui-panel-muted p-4">
                    <div className="flex items-start justify-between">
                        <div>
                            <p className="text-[11px] uppercase tracking-[0.18em] ui-text-muted">Tampil ke User</p>
                            <p className="mt-2 text-3xl font-black ui-text">{summary.visible}</p>
                            <p className="mt-1 text-sm ui-text-muted">{summary.hidden} tersembunyi</p>
                        </div>
                        <div className="rounded-xl ui-success-chip border p-2.5">
                            <Wallet className="w-5 h-5" />
                        </div>
                    </div>
                </div>
                <div className="rounded-2xl border ui-border ui-panel-muted p-4">
                    <div className="flex items-start justify-between">
                        <div>
                            <p className="text-[11px] uppercase tracking-[0.18em] ui-text-muted">Delete Diblock</p>
                            <p className="mt-2 text-3xl font-black ui-text">{summary.blocked}</p>
                            <p className="mt-1 text-sm ui-text-muted">karena dipakai histori</p>
                        </div>
                        <div className="rounded-xl ui-warning-chip border p-2.5">
                            <ShieldAlert className="w-5 h-5" />
                        </div>
                    </div>
                </div>
                <div className="rounded-2xl border ui-border ui-panel-muted p-4">
                    <div className="flex items-start justify-between">
                        <div>
                            <p className="text-[11px] uppercase tracking-[0.18em] ui-text-muted">Usage Historis</p>
                            <p className="mt-2 text-3xl font-black ui-text">{summary.historicalUsage}</p>
                            <p className="mt-1 text-sm ui-text-muted">{summary.inactive} metode nonaktif</p>
                        </div>
                        <div className="rounded-xl ui-info-chip border p-2.5">
                            <Layers3 className="w-5 h-5" />
                        </div>
                    </div>
                </div>
            </div>

            <div className="ui-panel-muted overflow-hidden rounded-3xl border ui-border">
                <div className="border-b ui-border px-5 py-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] ui-accent-text">Filter Metode</p>
                    <h2 className="mt-1 text-lg font-bold ui-text">Cari rekening, kategori, dan status rail</h2>
                </div>
                <div className="space-y-3 p-5">
                <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px_220px_auto]">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ui-text-muted" />
                        <input
                            type="text"
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                            className={`${inputClass} pl-9`}
                            placeholder="Cari nama, rekening, atau kategori..."
                            aria-label="Cari metode pembayaran"
                        />
                    </div>
                    <select
                        value={categoryFilter}
                        onChange={(event) => setCategoryFilter(event.target.value)}
                        className={selectClass}
                    >
                        <option value="all">Semua Kategori</option>
                        {categories.map((category) => (
                            <option key={category._id} value={category._id}>
                                {category.name} {category.status === 'inactive' ? '(Nonaktif)' : ''}
                            </option>
                        ))}
                    </select>
                    <select
                        value={statusFilter}
                        onChange={(event) => setStatusFilter(event.target.value as 'all' | 'active' | 'inactive')}
                        className={selectClass}
                    >
                        <option value="all">Semua Status</option>
                        <option value="active">Aktif</option>
                        <option value="inactive">Nonaktif</option>
                    </select>
                    <button
                        onClick={() => {
                            setSearch('');
                            setStatusFilter('all');
                            setCategoryFilter('all');
                            setMessage(null);
                        }}
                        className="inline-flex items-center justify-center gap-2 rounded-lg border ui-border px-4 py-2 text-sm font-semibold ui-text-muted hover:bg-[var(--ui-card-muted)] transition-colors"
                    >
                        <RotateCcw className="w-4 h-4" />
                        Reset
                    </button>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs ui-text-muted">
                    <span className="rounded-full border ui-border px-2.5 py-1">
                        {filteredMethods.length} metode tampil
                    </span>
                    <span className="rounded-full border ui-border px-2.5 py-1">
                        {categories.length} kategori tersedia
                    </span>
                    {hasActiveFilters && (
                        <span className="rounded-full border ui-warning-chip px-2.5 py-1 font-semibold">
                            Filter aktif
                        </span>
                    )}
                </div>
                </div>
            </div>

            <div className="ui-panel-muted rounded-3xl border ui-border overflow-hidden">
                <div className="flex flex-col gap-3 border-b ui-border px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.22em] ui-accent-text">Rail Pembayaran</p>
                        <h2 className="mt-1 text-lg font-bold ui-text">Daftar metode pembayaran aktif dan historis</h2>
                    </div>
                    <div className="text-xs ui-text-muted">{filteredMethods.length} dari {methods.length} metode</div>
                </div>
                <div className="overflow-x-auto">
                    <table className="min-w-full">
                        <thead>
                            <tr className="ui-panel ui-text-muted text-xs uppercase">
                                <th className="px-4 py-3 text-left font-semibold">Metode</th>
                                <th className="px-4 py-3 text-left font-semibold">Kategori</th>
                                <th className="px-4 py-3 text-left font-semibold">Limit & Fee</th>
                                <th className="px-4 py-3 text-left font-semibold">Operasional</th>
                                <th className="px-4 py-3 text-left font-semibold">Usage</th>
                                <th className="px-4 py-3 text-left font-semibold">Status</th>
                                <th className="px-4 py-3 text-left font-semibold">Aksi</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--ui-border)]">
                            {loading ? (
                                <tr>
                                    <td colSpan={7} className="px-4 py-10 text-center ui-text-muted">
                                        Memuat metode pembayaran...
                                    </td>
                                </tr>
                            ) : filteredMethods.length === 0 ? (
                                <tr>
                                    <td colSpan={7} className="px-4 py-10 text-center ui-text-muted font-semibold">
                                        Tidak ada metode pembayaran yang cocok.
                                    </td>
                                </tr>
                            ) : (
                                filteredMethods.map((method) => {
                                    const categoryStatus = getCategoryStatus(method.category);
                                    const usageCount = method.dependency?.totalUsageCount ?? 0;

                                    return (
                                        <tr key={method._id} className="hover:bg-[var(--ui-card-bg)] align-top">
                                            <td className="px-4 py-3 text-sm ui-text font-semibold">
                                                <div className="flex items-start gap-3">
                                                    <div className="w-10 h-10 rounded-md ui-panel border ui-border flex items-center justify-center overflow-hidden flex-shrink-0">
                                                        {method.icon ? (
                                                            <img src={method.icon} alt={method.name} className="w-full h-full object-cover" />
                                                        ) : (
                                                            <span className="text-[10px] ui-text-muted">ICON</span>
                                                        )}
                                                    </div>
                                                    <div className="min-w-0">
                                                        <p>{method.name}</p>
                                                        <p className="text-xs ui-text-muted font-mono">{method.accountNumber}</p>
                                                        <p className="text-xs ui-text-muted">{method.accountName}</p>
                                                    </div>
                                                </div>
                                            </td>
                                            <td className="px-4 py-3 text-sm">
                                                <div className="space-y-1">
                                                    <p className="ui-text font-semibold">{getCategoryName(method.category)}</p>
                                                    <span
                                                        className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${
                                                            categoryStatus === 'active'
                                                                ? 'border ui-success-chip'
                                                                : categoryStatus === 'inactive'
                                                                    ? 'border ui-warning-chip'
                                                                    : 'border ui-danger-chip'
                                                        }`}
                                                    >
                                                        {categoryStatus === 'active'
                                                            ? 'Kategori Aktif'
                                                            : categoryStatus === 'inactive'
                                                                ? 'Kategori Nonaktif'
                                                                : 'Kategori Hilang'}
                                                    </span>
                                                </div>
                                            </td>
                                            <td className="px-4 py-3 text-sm ui-text">
                                                <div>{formatCurrency(method.minAmount)} - {formatCurrency(method.maxAmount)}</div>
                                                <div className="text-xs ui-text-muted">
                                                    Fee {formatCurrency(method.adminFee)}
                                                    {method.adminPercent > 0 ? ` + ${method.adminPercent}%` : ''}
                                                </div>
                                                <div className="text-xs ui-text-muted">
                                                    {method.useUniqueCode ? 'Kode unik aktif' : 'Tanpa kode unik'}
                                                </div>
                                            </td>
                                            <td className="px-4 py-3 text-sm">
                                                <div className="space-y-1">
                                                    <div className="flex items-center gap-2 ui-text">
                                                        <Clock3 className="w-4 h-4 ui-text-muted" />
                                                        <span>{method.operationalStart} - {method.operationalEnd}</span>
                                                    </div>
                                                    <span
                                                        className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${
                                                            method.isOperationalNow
                                                                ? 'border ui-success-chip'
                                                                : 'border ui-warning-chip'
                                                        }`}
                                                    >
                                                        {method.isOperationalNow ? 'Sedang Buka' : 'Di Luar Jam Operasional'}
                                                    </span>
                                                </div>
                                            </td>
                                            <td className="px-4 py-3 text-sm">
                                                <div className="space-y-1 ui-text">
                                                    <p className="font-semibold">{usageCount} penggunaan</p>
                                                    <p className="text-xs ui-text-muted">
                                                        Deposit {method.dependency?.depositCount ?? 0}, Guest {method.dependency?.guestTransactionCount ?? 0}
                                                    </p>
                                                    {method.canDelete === false ? (
                                                        <p className="text-xs ui-warning-text">{method.deleteBlockedReason}</p>
                                                    ) : (
                                                        <p className="text-xs ui-text-muted">Aman untuk dihapus</p>
                                                    )}
                                                </div>
                                            </td>
                                            <td className="px-4 py-3 text-sm">
                                                <div className="space-y-2">
                                                    <span
                                                        className={`inline-flex rounded-full px-2 py-1 text-xs font-semibold ${
                                                            method.status === 'active'
                                                                ? 'border ui-success-chip'
                                                                : 'border ui-danger-chip'
                                                        }`}
                                                    >
                                                        {method.status === 'active' ? 'AKTIF' : 'NONAKTIF'}
                                                    </span>
                                                    {method.isVisibleToUsers ? (
                                                        <span className="inline-flex rounded-full border px-2 py-1 text-xs font-semibold ui-success-chip">
                                                            Tampil ke user
                                                        </span>
                                                    ) : (
                                                        <div className="ui-warning-chip rounded-lg border p-2 text-xs">
                                                            <div className="flex items-start gap-2">
                                                                <AlertTriangle className="mt-0.5 w-3.5 h-3.5 shrink-0" />
                                                                <div>
                                                                    {(method.visibilityIssues && method.visibilityIssues.length > 0 ? method.visibilityIssues : ['Tidak tampil ke user']).slice(0, 2).map((issue) => (
                                                                        <p key={issue}>{issue}</p>
                                                                    ))}
                                                                </div>
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                            </td>
                                            <td className="px-4 py-3 text-sm">
                                                <div className="flex items-center gap-2">
                                                    {canManagePayment && (
                                                        <>
                                                            <button
                                                                onClick={() => handleEdit(method)}
                                                                className="ui-info-action rounded p-1.5"
                                                                aria-label={`Edit metode pembayaran ${method.name}`}
                                                            >
                                                                <Edit className="w-4 h-4" />
                                                            </button>
                                                            <button
                                                                onClick={() => setMethodToDelete(method)}
                                                                className={`p-1.5 rounded ${
                                                                    method.canDelete === false
                                                                        ? 'ui-warning-action'
                                                                        : 'ui-danger-action'
                                                                }`}
                                                                aria-label={`Hapus metode pembayaran ${method.name}`}
                                                            >
                                                                <Trash2 className="w-4 h-4" />
                                                            </button>
                                                        </>
                                                    )}
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

            {showModal ? (
                <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
                    <div className="ui-panel-muted border ui-border rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto" role="dialog" aria-modal="true" aria-labelledby="payment-method-form-title">
                        <div className="flex items-center justify-between p-4 border-b ui-border">
                            <h2 id="payment-method-form-title" className="text-lg font-semibold ui-text">
                                {editingMethod ? 'Edit Metode Pembayaran' : 'Tambah Metode Pembayaran'}
                            </h2>
                            <button onClick={() => setShowModal(false)} className="ui-text-muted hover:text-[var(--ui-text)]" aria-label="Tutup form metode pembayaran">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <form onSubmit={handleSubmit} className="p-4 space-y-4">
                            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                <div>
                                    <label className={labelClass}>Nama Metode</label>
                                    <input
                                        type="text"
                                        value={form.name}
                                        onChange={(event) => setForm({ ...form, name: event.target.value })}
                                        className={inputClass}
                                        placeholder="BCA"
                                        required
                                    />
                                </div>
                                <div>
                                    <label className={labelClass}>Kategori</label>
                                    <select
                                        value={form.category}
                                        onChange={(event) => setForm({ ...form, category: event.target.value })}
                                        className={selectClass}
                                    >
                                        <option value="">-- Pilih Kategori --</option>
                                        {categories.map((category) => (
                                            <option key={category._id} value={category._id}>
                                                {category.name} {category.status === 'inactive' ? '(Nonaktif)' : ''}
                                            </option>
                                        ))}
                                    </select>
                                    {selectedCategory ? (
                                        <p className="mt-1 text-xs ui-text-muted">
                                            {selectedCategory.status === 'active'
                                                ? 'Kategori aktif.'
                                                : 'Kategori nonaktif: metode aktif tidak akan tampil ke user.'}
                                        </p>
                                    ) : null}
                                </div>
                            </div>

                            <div>
                                <label className={labelClass}>Icon (Opsional)</label>
                                <div className="flex items-start gap-3">
                                    <div className="relative w-16 h-16 rounded-lg border-2 border-dashed ui-border ui-panel flex items-center justify-center overflow-hidden">
                                        {form.icon ? (
                                            <>
                                                <img src={form.icon} alt="icon" className="w-full h-full object-cover" />
                                                <button
                                                    type="button"
                                                    onClick={() => setForm({ ...form, icon: '' })}
                                                    className="absolute top-1 right-1 bg-black/60 ui-text rounded-full p-1 hover:bg-black/80"
                                                    aria-label="Hapus icon metode pembayaran"
                                                >
                                                    <X className="w-3 h-3" />
                                                </button>
                                            </>
                                        ) : (
                                            <ImageIcon className="w-7 h-7 ui-text-muted" />
                                        )}
                                    </div>
                                    <div className="flex-1 space-y-2">
                                        <button
                                            type="button"
                                            onClick={() => setShowIconPicker(true)}
                                            className="ui-accent-chip w-full flex items-center justify-center gap-2 px-3 py-2 border rounded-lg text-sm"
                                        >
                                            <FolderOpen className="w-4 h-4" />
                                            Pilih dari Galeri
                                        </button>
                                        <label className={`w-full inline-flex items-center justify-center gap-2 px-3 py-2 ui-panel border ui-border rounded-lg text-sm ui-text-muted hover:bg-[var(--ui-card-muted)] cursor-pointer ${uploadingIcon ? 'opacity-50 cursor-wait' : ''}`}>
                                            {uploadingIcon ? (
                                                <><Loader2 className="w-4 h-4 animate-spin" /> Uploading...</>
                                            ) : (
                                                <><Upload className="w-4 h-4" /> Upload File Baru</>
                                            )}
                                            <input type="file" accept="image/*" className="hidden" onChange={handleIconUpload} disabled={uploadingIcon} />
                                        </label>
                                    </div>
                                </div>
                            </div>

                            <div>
                                <label className={labelClass}>No. Rekening</label>
                                <input
                                    type="text"
                                    value={form.accountNumber}
                                    onChange={(event) => setForm({ ...form, accountNumber: event.target.value })}
                                    className={inputClass}
                                    placeholder="1234567890"
                                    required
                                />
                            </div>

                            <div>
                                <label className={labelClass}>Atas Nama</label>
                                <input
                                    type="text"
                                    value={form.accountName}
                                    onChange={(event) => setForm({ ...form, accountName: event.target.value })}
                                    className={inputClass}
                                    placeholder="PT. Toko Voucher"
                                    required
                                />
                            </div>

                            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                <div>
                                    <label className={labelClass}>Min. Amount</label>
                                    <input
                                        type="number"
                                        min={0}
                                        step={1}
                                        value={form.minAmount}
                                        onChange={(event) => setForm({ ...form, minAmount: Number(event.target.value) })}
                                        className={inputClass}
                                    />
                                </div>
                                <div>
                                    <label className={labelClass}>Max. Amount</label>
                                    <input
                                        type="number"
                                        min={1}
                                        step={1}
                                        value={form.maxAmount}
                                        onChange={(event) => setForm({ ...form, maxAmount: Number(event.target.value) })}
                                        className={inputClass}
                                    />
                                </div>
                            </div>

                            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                <div>
                                    <label className={labelClass}>Jam Mulai</label>
                                    <input
                                        type="time"
                                        value={form.operationalStart}
                                        onChange={(event) => setForm({ ...form, operationalStart: event.target.value })}
                                        className={inputClass}
                                    />
                                </div>
                                <div>
                                    <label className={labelClass}>Jam Selesai</label>
                                    <input
                                        type="time"
                                        value={form.operationalEnd}
                                        onChange={(event) => setForm({ ...form, operationalEnd: event.target.value })}
                                        className={inputClass}
                                    />
                                </div>
                            </div>

                            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                <div>
                                    <label className={labelClass}>Biaya Admin (Rp)</label>
                                    <input
                                        type="number"
                                        min={0}
                                        step={1}
                                        value={form.adminFee}
                                        onChange={(event) => setForm({ ...form, adminFee: Number(event.target.value) })}
                                        className={inputClass}
                                    />
                                </div>
                                <div>
                                    <label className={labelClass}>Biaya Admin (%)</label>
                                    <input
                                        type="number"
                                        min={0}
                                        max={100}
                                        step={0.01}
                                        value={form.adminPercent}
                                        onChange={(event) => setForm({ ...form, adminPercent: Number(event.target.value) })}
                                        className={inputClass}
                                    />
                                </div>
                            </div>

                            <div className="flex items-center justify-between p-3 ui-panel border ui-border rounded-lg">
                                <div>
                                    <label className="text-sm font-medium ui-text">Gunakan Kode Unik</label>
                                    <p className="text-xs ui-text-muted">Tambahkan angka unik di total transfer</p>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setForm({ ...form, useUniqueCode: !form.useUniqueCode })}
                                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${form.useUniqueCode ? 'bg-[var(--ui-accent)]' : 'ui-panel-muted'}`}
                                    aria-label="Toggle kode unik metode pembayaran"
                                >
                                    <span className={`inline-block h-4 w-4 transform rounded-full bg-[var(--ui-card-bg)] transition-transform ${form.useUniqueCode ? 'translate-x-6' : 'translate-x-1'}`} />
                                </button>
                            </div>

                            <div>
                                <label className={labelClass}>Status</label>
                                <select
                                    value={form.status}
                                    onChange={(event) => setForm({ ...form, status: event.target.value as 'active' | 'inactive' })}
                                    className={selectClass}
                                >
                                    <option value="active">Aktif</option>
                                    <option value="inactive">Nonaktif</option>
                                </select>
                            </div>

                            {selectedCategory?.status === 'inactive' && form.status === 'active' ? (
                                <div className="ui-warning-chip rounded-lg border p-3 text-sm">
                                    Metode aktif di kategori nonaktif tetap tersimpan, tetapi tidak akan tampil ke user sampai kategori diaktifkan lagi.
                                </div>
                            ) : null}

                            <div className="flex justify-end gap-3 pt-4">
                                <button
                                    type="button"
                                    onClick={() => setShowModal(false)}
                                    className="px-4 py-2 border ui-border rounded-lg text-sm font-medium ui-text-muted hover:bg-[var(--ui-card-muted)]"
                                >
                                    Batal
                                </button>
                                <button
                                    type="submit"
                                    disabled={saving}
                                    className="px-4 py-2 ui-accent-solid rounded-lg text-sm font-medium  disabled:opacity-50"
                                >
                                    {saving ? 'Menyimpan...' : 'Simpan'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            ) : null}

            {methodToDelete ? (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
                    <div className="mx-4 w-full max-w-md rounded-xl border ui-border ui-panel-muted shadow-xl" role="dialog" aria-modal="true" aria-labelledby="payment-method-delete-title">
                        <div className="border-b ui-border p-4">
                            <h2 id="payment-method-delete-title" className="text-lg font-semibold ui-text">Hapus Metode Pembayaran</h2>
                            <p className="mt-1 text-sm ui-text-muted">
                                Metode yang sudah dipakai transaksi/deposit historis tidak boleh dihapus.
                            </p>
                        </div>
                        <div className="space-y-4 p-4">
                            <div className="rounded-lg border ui-border ui-panel p-3">
                                <p className="text-sm font-semibold ui-text">{methodToDelete.name}</p>
                                <p className="mt-1 text-xs ui-text-muted">{methodToDelete.accountNumber}</p>
                                <p className="mt-2 text-xs ui-text-muted">
                                    Usage historis: {methodToDelete.dependency?.totalUsageCount ?? 0}
                                </p>
                                <p className="mt-1 text-xs ui-text-muted">
                                    Aktif berjalan: deposit pending {methodToDelete.dependency?.pendingDepositCount ?? 0}, guest menunggu bayar {methodToDelete.dependency?.waitingPaymentCount ?? 0}
                                </p>
                            </div>
                            {methodToDelete.canDelete === false ? (
                                <div className="ui-warning-chip rounded-lg border p-3 text-sm">
                                    {methodToDelete.deleteBlockedReason || 'Metode ini belum bisa dihapus.'}
                                </div>
                            ) : (
                                <div className="rounded-lg border p-3 text-sm ui-danger-chip">
                                    Metode akan dihapus permanen.
                                </div>
                            )}
                            <div className="flex justify-end gap-3">
                                <button
                                    type="button"
                                    onClick={() => setMethodToDelete(null)}
                                    className="rounded-lg border ui-border px-4 py-2 text-sm font-medium ui-text-muted hover:bg-[var(--ui-card-muted)]"
                                >
                                    Tutup
                                </button>
                                <button
                                    type="button"
                                    onClick={confirmDelete}
                                    disabled={methodToDelete.canDelete === false || deleting}
                                    className="ui-danger-action rounded-lg px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    {deleting ? 'Menghapus...' : 'Hapus'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}

            <ImagePicker
                isOpen={showIconPicker}
                onClose={() => setShowIconPicker(false)}
                onSelect={(url) => setForm((current) => ({ ...current, icon: url }))}
                currentValue={form.icon}
                type="icons"
                title="Pilih Icon Pembayaran"
            />

            {/* Must stay at the component root: nested inside the upload button label it only
                rendered while the edit panel was open, so an expired grant left the save
                silently rejected with no re-verification prompt. */}
            {stepUp.dialog}
        </div>
    );
}
