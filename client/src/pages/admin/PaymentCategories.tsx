import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
    Edit,
    FolderOpen,
    GripVertical,
    Image as ImageIcon,
    Layers3,
    Link2,
    Loader2,
    Plus,
    RefreshCw,
    RotateCcw,
    Search,
    ShieldAlert,

    Trash2,
    Upload,
    X
} from 'lucide-react';
import { apiV2 } from '../../api';
import ImagePicker from '../../components/admin/ImagePicker';
import { useAuthStore } from '../../store/useAuthStore';

type PaymentCategory = {
    _id: string;
    name: string;
    slug: string;
    icon?: string;
    order: number;
    status: 'active' | 'inactive';
    methodCount?: number;
    activeMethodCount?: number;
    inactiveMethodCount?: number;
    canDelete?: boolean;
    deleteBlockedReason?: string;
};

type FormData = {
    name: string;
    slug: string;
    icon: string;
    order: number;
    status: 'active' | 'inactive';
};

const defaultForm: FormData = {
    name: '',
    slug: '',
    icon: '',
    order: 0,
    status: 'active'
};

const slugify = (value: string) =>
    value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/(^-|-$)/g, '');

const filterValuesFromSearchParams = (params: URLSearchParams) => ({
    search: params.get('search') || '',
    status: (params.get('status') as 'all' | 'active' | 'inactive') || 'all'
});

export default function PaymentCategories() {
    const [searchParams, setSearchParams] = useSearchParams();
    const { isOwner, hasPermission } = useAuthStore();
    const canManagePayment = isOwner || hasPermission('managePayment');
    const initialFilters = useMemo(() => filterValuesFromSearchParams(searchParams), []);
    const latestRequestId = useRef(0);
    const [categories, setCategories] = useState<PaymentCategory[]>([]);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [reordering, setReordering] = useState(false);
    const [showModal, setShowModal] = useState(false);
    const [editingCategory, setEditingCategory] = useState<PaymentCategory | null>(null);
    const [categoryToDelete, setCategoryToDelete] = useState<PaymentCategory | null>(null);
    const [form, setForm] = useState<FormData>(defaultForm);
    const [uploadingIcon, setUploadingIcon] = useState(false);
    const [showIconPicker, setShowIconPicker] = useState(false);
    const [draggedItem, setDraggedItem] = useState<PaymentCategory | null>(null);
    const [deleting, setDeleting] = useState(false);
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const [search, setSearch] = useState(initialFilters.search);
    const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>(initialFilters.status);

    const syncUrlParams = useCallback((nextSearch: string, nextStatus: string) => {
        const params = new URLSearchParams();
        if (nextSearch.trim()) params.set('search', nextSearch.trim());
        if (nextStatus !== 'all') params.set('status', nextStatus);
        setSearchParams(params, { replace: true });
    }, [setSearchParams]);

    const fetchCategories = useCallback(async () => {
        const requestId = latestRequestId.current + 1;
        latestRequestId.current = requestId;
        setLoading(true);
        setMessage(null);
        try {
            const response = await apiV2
                .get('/payment-categories/admin/all');
            if (requestId !== latestRequestId.current) return;
            setCategories(response.data);
        } catch (error: any) {
            if (requestId !== latestRequestId.current) return;
            console.error('Failed to fetch payment categories', error);
            setMessage({ type: 'error', text: error.response?.data?.message || 'Gagal memuat kategori pembayaran' });
        } finally {
            if (requestId === latestRequestId.current) {
                setLoading(false);
            }
        }
    }, []);

    useEffect(() => {
        fetchCategories();
    }, [fetchCategories]);

    useEffect(() => {
        const handleRefresh = () => fetchCategories();
        window.addEventListener('admin:refresh-current-page', handleRefresh);
        return () => window.removeEventListener('admin:refresh-current-page', handleRefresh);
    }, [fetchCategories]);

    useEffect(() => {
        syncUrlParams(search, statusFilter);
    }, [search, statusFilter, syncUrlParams]);

    const filteredCategories = useMemo(() => {
        const keyword = search.trim().toLowerCase();

        return categories.filter((category) => {
            const matchesSearch =
                !keyword ||
                category.name.toLowerCase().includes(keyword) ||
                category.slug.toLowerCase().includes(keyword);
            const matchesStatus =
                statusFilter === 'all' || category.status === statusFilter;

            return matchesSearch && matchesStatus;
        });
    }, [categories, search, statusFilter]);

    const summary = useMemo(() => {
        return categories.reduce(
            (result, category) => {
                result.total += 1;
                result.methods += Number(category.methodCount ?? 0);
                result.blocked += category.canDelete === false ? 1 : 0;

                if (category.status === 'active') {
                    result.active += 1;
                } else {
                    result.inactive += 1;
                }

                return result;
            },
            {
                total: 0,
                active: 0,
                inactive: 0,
                methods: 0,
                blocked: 0
            }
        );
    }, [categories]);

    const isFilterActive = Boolean(search.trim() || statusFilter !== 'all');
    const slugPreview = slugify(form.slug || form.name);
    const attentionCategories = categories
        .filter((category) => category.status === 'inactive' || category.canDelete === false)
        .slice(0, 4);

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();

        const name = form.name.trim();
        const slug = slugify(form.slug || form.name);

        if (!canManagePayment) {
            setMessage({ type: 'error', text: 'Akun ini tidak memiliki izin mengelola kategori pembayaran' });
            return;
        }

        if (!name) {
            setMessage({ type: 'error', text: 'Nama kategori wajib diisi' });
            return;
        }

        if (!slug) {
            setMessage({ type: 'error', text: 'Slug kategori tidak valid' });
            return;
        }

        setSaving(true);
        setMessage(null);
        try {
            const payload = {
                name,
                slug,
                icon: form.icon.trim(),
                status: form.status
            };

            if (editingCategory) {
                await apiV2.put(`/payment-categories/${editingCategory._id}`, payload)
            } else {
                await apiV2.post('/payment-categories', payload)
            }

            await fetchCategories();
            setMessage({ type: 'success', text: editingCategory ? 'Kategori pembayaran berhasil diperbarui' : 'Kategori pembayaran berhasil ditambahkan' });
            setShowModal(false);
            setForm(defaultForm);
            setEditingCategory(null);
        } catch (error: unknown) {
            console.error('Failed to save payment category', error);
            const err = error as { response?: { data?: { message?: string } } };
            setMessage({ type: 'error', text: err.response?.data?.message || 'Gagal menyimpan kategori' });
        } finally {
            setSaving(false);
        }
    };

    const handleIconUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        if (!file.type.startsWith('image/')) {
            setMessage({ type: 'error', text: 'File icon harus berupa gambar' });
            event.target.value = '';
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
            setMessage({ type: 'error', text: error.response?.data?.message || 'Gagal upload icon kategori' });
        } finally {
            setUploadingIcon(false);
            event.target.value = '';
        }
    };

    const handleEdit = (category: PaymentCategory) => {
        if (!canManagePayment || reordering) return;
        setEditingCategory(category);
        setForm({
            name: category.name,
            slug: category.slug,
            icon: category.icon || '',
            order: category.order,
            status: category.status
        });
        setShowModal(true);
    };

    const confirmDelete = async () => {
        if (!categoryToDelete || deleting || categoryToDelete.canDelete === false || !canManagePayment) return;

        setDeleting(true);
        setMessage(null);
        try {
            await apiV2.delete(`/payment-categories/${categoryToDelete._id}`);
            await fetchCategories();
            setMessage({ type: 'success', text: 'Kategori pembayaran berhasil dihapus' });
            setCategoryToDelete(null);
        } catch (error: unknown) {
            console.error('Failed to delete payment category', error);
            const err = error as { response?: { data?: { message?: string } } };
            setMessage({ type: 'error', text: err.response?.data?.message || 'Gagal menghapus kategori pembayaran' });
        } finally {
            setDeleting(false);
        }
    };

    const openAddModal = () => {
        if (!canManagePayment || reordering) return;
        setEditingCategory(null);
        setForm(defaultForm);
        setMessage(null);
        setShowModal(true);
    };

    const handleDragStart = (category: PaymentCategory) => {
        if (!canManagePayment || isFilterActive || reordering || saving || deleting) return;
        setDraggedItem(category);
    };

    const handleDrop = async (targetCategory: PaymentCategory) => {
        if (!canManagePayment || isFilterActive || reordering || saving || deleting || !draggedItem || draggedItem._id === targetCategory._id) {
            return;
        }

        const nextCategories = [...categories];
        const draggedIndex = nextCategories.findIndex((category) => category._id === draggedItem._id);
        const targetIndex = nextCategories.findIndex((category) => category._id === targetCategory._id);

        if (draggedIndex === -1 || targetIndex === -1) {
            setDraggedItem(null);
            return;
        }

        nextCategories.splice(draggedIndex, 1);
        nextCategories.splice(targetIndex, 0, draggedItem);

        const orders = nextCategories.map((category, index) => ({
            id: category._id,
            order: index + 1
        }));

        setCategories(
            nextCategories.map((category, index) => ({
                ...category,
                order: index + 1
            }))
        );
        setDraggedItem(null);
        setReordering(true);

        try {
            await apiV2.put('/payment-categories/reorder', { orders });
            await fetchCategories();
            setMessage({ type: 'success', text: 'Urutan kategori berhasil disimpan' });
        } catch (error: unknown) {
            console.error('Failed to reorder categories', error);
            const err = error as { response?: { data?: { message?: string } } };
            setMessage({ type: 'error', text: err.response?.data?.message || 'Gagal mengurutkan kategori' });
            await fetchCategories();
        } finally {
            setReordering(false);
        }
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
                                <p className="text-xs uppercase tracking-[0.18em] ui-text-muted">Sinyal Matriks</p>
                                <h2 className="mt-1 text-lg font-bold ui-text">{filteredCategories.length} kategori dalam view</h2>
                                <p className="mt-1 text-xs ui-text-muted">
                                    {isFilterActive
                                        ? 'Reorder nonaktif saat filter aktif'
                                        : canManagePayment
                                            ? 'Drag & drop aktif untuk urutan tampil'
                                            : 'Mode lihat saja, reorder butuh izin kelola pembayaran'}
                                </p>
                            </div>
                            <div className="flex gap-2">
                                <button
                                    onClick={fetchCategories}
                                    disabled={loading || saving || reordering || deleting}
                                    className="ui-muted-action inline-flex items-center justify-center gap-2 rounded-xl border px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                                    Segarkan
                                </button>
                                {canManagePayment && (
                                    <button
                                        onClick={openAddModal}
                                        disabled={saving || reordering || deleting}
                                        className="ui-accent-solid inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                                    >
                                        <Plus className="h-4 w-4" />
                                        Tambah Kategori
                                    </button>
                                )}
                            </div>
                        </div>
                        <div className="mt-5 space-y-3">
                            {(attentionCategories.length > 0 ? attentionCategories : categories.slice(0, 4)).map((category) => (
                                <button
                                    key={category._id}
                                    type="button"
                                    onClick={() => {
                                        if (canManagePayment) handleEdit(category);
                                    }}
                                    disabled={!canManagePayment || reordering || saving || deleting}
                                    className="w-full rounded-2xl border ui-border bg-[var(--ui-card-muted)]/80 p-3 text-left transition hover:border-[var(--ui-accent)] disabled:cursor-not-allowed disabled:opacity-70"
                                >
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="min-w-0">
                                            <p className="truncate text-sm font-semibold ui-text">{category.name}</p>
                                            <p className="mt-1 truncate text-xs ui-text-muted">/{category.slug} • {category.methodCount ?? 0} metode</p>
                                        </div>
                                        <span className={`inline-flex shrink-0 rounded-full border px-2 py-1 text-xs font-semibold ${category.status === 'active' ? 'ui-success-chip' : 'ui-danger-chip'}`}>
                                            {category.status === 'active' ? 'Aktif' : 'Nonaktif'}
                                        </span>
                                    </div>
                                </button>
                            ))}
                            {!loading && categories.length === 0 && (
                                <div className="rounded-2xl border ui-border bg-[var(--ui-card-muted)]/80 p-4 text-sm ui-text-muted">
                                    Belum ada kategori pembayaran.
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
                    Akun ini hanya dapat melihat kategori pembayaran. Aksi tambah, edit, hapus, dan reorder disembunyikan.
                </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-2xl border ui-border ui-panel-muted p-4">
                    <div className="flex items-start justify-between">
                        <div>
                            <p className="text-[11px] uppercase tracking-[0.18em] ui-text-muted">Total Kategori</p>
                            <p className="mt-2 text-3xl font-black ui-text">{summary.total}</p>
                            <p className="mt-1 text-sm ui-text-muted">{summary.active} aktif</p>
                        </div>
                        <div className="rounded-xl bg-[var(--ui-accent-soft)] p-2.5 ui-accent-text">
                            <Layers3 className="w-5 h-5" />
                        </div>
                    </div>
                </div>
                <div className="rounded-2xl border ui-border ui-panel-muted p-4">
                    <div className="flex items-start justify-between">
                        <div>
                            <p className="text-[11px] uppercase tracking-[0.18em] ui-text-muted">Metode Terkait</p>
                            <p className="mt-2 text-3xl font-black ui-text">{summary.methods}</p>
                            <p className="mt-1 text-sm ui-text-muted">{summary.inactive} kategori nonaktif</p>
                        </div>
                        <div className="rounded-xl ui-info-chip border p-2.5">
                            <Link2 className="w-5 h-5" />
                        </div>
                    </div>
                </div>
                <div className="rounded-2xl border ui-border ui-panel-muted p-4">
                    <div className="flex items-start justify-between">
                        <div>
                            <p className="text-[11px] uppercase tracking-[0.18em] ui-text-muted">Hapus Terblokir</p>
                            <p className="mt-2 text-3xl font-black ui-text">{summary.blocked}</p>
                            <p className="mt-1 text-sm ui-text-muted">karena masih dipakai metode</p>
                        </div>
                        <div className="rounded-xl ui-warning-chip border p-2.5">
                            <ShieldAlert className="w-5 h-5" />
                        </div>
                    </div>
                </div>
                <div className="rounded-2xl border ui-border ui-panel-muted p-4">
                    <div className="flex items-start justify-between">
                        <div>
                            <p className="text-[11px] uppercase tracking-[0.18em] ui-text-muted">Tampil Saat Ini</p>
                            <p className="mt-2 text-3xl font-black ui-text">{filteredCategories.length}</p>
                            <p className="mt-1 text-sm ui-text-muted">setelah filter diterapkan</p>
                        </div>
                        <div className="rounded-xl ui-success-chip border p-2.5">
                            <Search className="w-5 h-5" />
                        </div>
                    </div>
                </div>
            </div>

            <div className="overflow-hidden rounded-3xl border ui-border ui-panel-muted">
                <div className="border-b ui-border px-5 py-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.22em] ui-accent-text">Filter Kategori</p>
                    <h2 className="mt-1 text-lg font-bold ui-text">Cari grup pembayaran dan kontrol reorder</h2>
                </div>
                <div className="space-y-3 p-5">
                <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px_auto]">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ui-text-muted" />
                        <input
                            type="text"
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                            className={`${inputClass} pl-9`}
                            placeholder="Cari nama atau slug kategori..."
                            aria-label="Cari kategori pembayaran"
                        />
                    </div>
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
                            setMessage(null);
                        }}
                        className="inline-flex items-center justify-center gap-2 rounded-lg border ui-border px-4 py-2 text-sm font-medium ui-text-muted hover:bg-[var(--ui-card-muted)]"
                    >
                        <RotateCcw className="w-4 h-4" />
                        Reset Filter
                    </button>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs ui-text-muted">
                    <span className="rounded-full border ui-border px-2.5 py-1">
                        {filteredCategories.length} kategori tampil
                    </span>
                    {isFilterActive ? (
                        <span className="ui-warning-chip rounded-full border px-2.5 py-1">
                            Reorder dinonaktifkan saat filter aktif
                        </span>
                    ) : !canManagePayment ? (
                        <span className="ui-warning-chip rounded-full border px-2.5 py-1">
                            Reorder butuh izin kelola pembayaran
                        </span>
                    ) : (
                        <span className="rounded-full border px-2.5 py-1 ui-success-chip">
                            Drag & drop aktif untuk mengatur urutan tampil
                        </span>
                    )}
                    {reordering ? (
                        <span className="rounded-full border px-2.5 py-1 ui-info-chip">
                            Menyimpan urutan...
                        </span>
                    ) : null}
                </div>
                </div>
            </div>

            <div className="overflow-hidden rounded-3xl border ui-border ui-panel-muted">
                <div className="flex flex-col gap-3 border-b ui-border px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                        <p className="text-xs font-semibold uppercase tracking-[0.22em] ui-accent-text">Matriks Kategori</p>
                        <h2 className="mt-1 text-lg font-bold ui-text">Daftar kategori dan urutan tampil</h2>
                    </div>
                    <div className="text-xs ui-text-muted">{filteredCategories.length} dari {categories.length} kategori</div>
                </div>
                <div className="overflow-x-auto">
                    <table className="min-w-full">
                        <thead>
                            <tr className="ui-panel text-xs uppercase ui-text-muted">
                                <th className="w-12 px-4 py-3 text-left font-semibold">Urut</th>
                                <th className="px-4 py-3 text-left font-semibold">Kategori</th>
                                <th className="px-4 py-3 text-left font-semibold">Slug</th>
                                <th className="px-4 py-3 text-left font-semibold">Status</th>
                                <th className="px-4 py-3 text-left font-semibold">Metode</th>
                                <th className="px-4 py-3 text-left font-semibold">Aksi</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--ui-border)]">
                            {loading ? (
                                <tr>
                                    <td colSpan={6} className="px-4 py-10 text-center ui-text-muted">
                                        Memuat kategori pembayaran...
                                    </td>
                                </tr>
                            ) : filteredCategories.length === 0 ? (
                                <tr>
                                    <td colSpan={6} className="px-4 py-10 text-center ui-text-muted font-semibold">
                                        Tidak ada kategori pembayaran yang cocok.
                                    </td>
                                </tr>
                            ) : (
                                filteredCategories.map((category) => (
                                    <tr
                                        key={category._id}
                                        className={`hover:bg-[var(--ui-card-bg)] ${draggedItem?._id === category._id ? 'opacity-50' : ''}`}
                                        draggable={canManagePayment && !isFilterActive && !reordering && !saving && !deleting}
                                        onDragStart={() => handleDragStart(category)}
                                        onDragOver={(event) => event.preventDefault()}
                                        onDrop={() => handleDrop(category)}
                                        onDragEnd={() => setDraggedItem(null)}
                                    >
                                        <td className="px-4 py-3">
                                            <div className="flex items-center gap-2 ui-text-muted">
                                                <GripVertical className={`w-4 h-4 ${!canManagePayment || isFilterActive || reordering ? 'opacity-40' : ''}`} aria-label="Drag untuk mengubah urutan kategori" />
                                                <span className="text-xs font-semibold">{category.order}</span>
                                            </div>
                                        </td>
                                        <td className="px-4 py-3">
                                            <div className="flex items-center gap-3">
                                                <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-md border ui-border ui-panel">
                                                    {category.icon ? (
                                                        <img src={category.icon} alt={category.name} className="h-full w-full object-cover" />
                                                    ) : (
                                                        <span className="text-[10px] ui-text-muted">ICON</span>
                                                    )}
                                                </div>
                                                <div>
                                                    <p className="text-sm font-semibold ui-text">{category.name}</p>
                                                    <p className="text-xs ui-text-muted">
                                                        {category.activeMethodCount ?? 0} metode aktif, {category.inactiveMethodCount ?? 0} nonaktif
                                                    </p>
                                                </div>
                                            </div>
                                        </td>
                                        <td className="px-4 py-3">
                                            <code className="rounded bg-[var(--ui-card-bg)] px-2 py-1 text-xs ui-text-muted">
                                                {category.slug}
                                            </code>
                                        </td>
                                        <td className="px-4 py-3">
                                            <span
                                                className={`rounded-full px-2 py-1 text-xs font-semibold ${
                                                    category.status === 'active'
                                                        ? 'border ui-success-chip'
                                                        : 'border ui-danger-chip'
                                                }`}
                                            >
                                                {category.status === 'active' ? 'AKTIF' : 'NONAKTIF'}
                                            </span>
                                        </td>
                                        <td className="px-4 py-3">
                                            <div className="space-y-1 text-sm ui-text">
                                                <p className="font-semibold">{category.methodCount ?? 0} metode</p>
                                                {category.canDelete === false ? (
                                                    <p className="text-xs ui-warning-text">{category.deleteBlockedReason}</p>
                                                ) : (
                                                    <p className="text-xs ui-text-muted">Aman untuk dihapus</p>
                                                )}
                                                {(category.methodCount ?? 0) > 0 ? (
                                                    <Link
                                                        to={`/admin/payment-methods?category=${encodeURIComponent(category._id)}`}
                                                        className="text-xs font-semibold ui-accent-text hover:underline"
                                                    >
                                                        Lihat metode
                                                    </Link>
                                                ) : null}
                                            </div>
                                        </td>
                                        <td className="px-4 py-3">
                                            <div className="flex items-center gap-2">
                                                {canManagePayment && (
                                                    <>
                                                        <button
                                                            onClick={() => handleEdit(category)}
                                                            disabled={reordering || saving || deleting}
                                                            className="ui-info-action rounded p-1.5 disabled:cursor-not-allowed disabled:opacity-50"
                                                            aria-label={`Edit kategori ${category.name}`}
                                                        >
                                                            <Edit className="w-4 h-4" />
                                                        </button>
                                                        <button
                                                            onClick={() => setCategoryToDelete(category)}
                                                            disabled={reordering || saving || deleting}
                                                            className={`rounded p-1.5 disabled:cursor-not-allowed disabled:opacity-50 ${
                                                                category.canDelete === false
                                                                    ? 'ui-warning-action'
                                                                    : 'ui-danger-action'
                                                            }`}
                                                            aria-label={`Hapus kategori ${category.name}`}
                                                        >
                                                            <Trash2 className="w-4 h-4" />
                                                        </button>
                                                    </>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {showModal ? (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
                    <div className="mx-4 max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl border ui-border ui-panel-muted shadow-xl" role="dialog" aria-modal="true" aria-labelledby="payment-category-form-title">
                        <div className="flex items-center justify-between border-b ui-border p-4">
                            <h2 id="payment-category-form-title" className="text-lg font-semibold ui-text">
                                {editingCategory ? 'Edit Kategori Pembayaran' : 'Tambah Kategori Pembayaran'}
                            </h2>
                            <button onClick={() => setShowModal(false)} className="ui-text-muted hover:text-[var(--ui-text)]" aria-label="Tutup form kategori pembayaran">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <form onSubmit={handleSubmit} className="space-y-4 p-4">
                            <div>
                                <label className={labelClass} htmlFor="payment-category-name">Nama Kategori</label>
                                <input
                                    id="payment-category-name"
                                    type="text"
                                    value={form.name}
                                    onChange={(event) => setForm({ ...form, name: event.target.value })}
                                    className={inputClass}
                                    placeholder="Bank Transfer"
                                    required
                                />
                            </div>

                            <div>
                                <label className={labelClass} htmlFor="payment-category-slug">Slug</label>
                                <input
                                    id="payment-category-slug"
                                    type="text"
                                    value={form.slug}
                                    onChange={(event) => setForm({ ...form, slug: event.target.value })}
                                    className={inputClass}
                                    placeholder="bank-transfer"
                                />
                                <p className="mt-1 text-xs ui-text-muted">
                                    Preview slug: <span className="ui-text-muted">{slugPreview || '-'}</span>
                                </p>
                            </div>

                            <div>
                                <label className={labelClass}>Icon (Opsional)</label>
                                <div className="flex items-start gap-3">
                                    <div className="relative flex h-16 w-16 items-center justify-center overflow-hidden rounded-lg border-2 border-dashed ui-border ui-panel">
                                        {form.icon ? (
                                            <>
                                                <img src={form.icon} alt="icon" className="h-full w-full object-cover" />
                                                <button
                                                    type="button"
                                                    onClick={() => setForm({ ...form, icon: '' })}
                                                    className="absolute right-1 top-1 rounded-full bg-black/60 p-1 ui-text hover:bg-black/80"
                                                    aria-label="Hapus icon kategori pembayaran"
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
                                            className="ui-accent-chip flex w-full items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm"
                                        >
                                            <FolderOpen className="w-4 h-4" />
                                            Pilih dari Galeri
                                        </button>
                                        <label className={`inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg border ui-border ui-panel px-3 py-2 text-sm ui-text-muted hover:bg-[var(--ui-card-muted)] ${uploadingIcon ? 'cursor-wait opacity-50' : ''}`}>
                                            {uploadingIcon ? (
                                                <>
                                                    <Loader2 className="w-4 h-4 animate-spin" /> Uploading...
                                                </>
                                            ) : (
                                                <>
                                                    <Upload className="w-4 h-4" /> Upload File Baru
                                                </>
                                            )}
                                            <input
                                                type="file"
                                                accept="image/*"
                                                className="hidden"
                                                onChange={handleIconUpload}
                                                disabled={uploadingIcon}
                                            />
                                        </label>
                                    </div>
                                </div>
                            </div>

                            <div>
                                <label className={labelClass} htmlFor="payment-category-status">Status</label>
                                <select
                                    id="payment-category-status"
                                    value={form.status}
                                    onChange={(event) => setForm({ ...form, status: event.target.value as 'active' | 'inactive' })}
                                    className={selectClass}
                                >
                                    <option value="active">Aktif</option>
                                    <option value="inactive">Nonaktif</option>
                                </select>
                            </div>

                            <div className="flex justify-end gap-3 pt-4">
                                <button
                                    type="button"
                                    onClick={() => setShowModal(false)}
                                    className="rounded-lg border ui-border px-4 py-2 text-sm font-medium ui-text-muted hover:bg-[var(--ui-card-muted)]"
                                >
                                    Batal
                                </button>
                                <button
                                    type="submit"
                                    disabled={saving}
                                    className="rounded-lg ui-accent-solid px-4 py-2 text-sm font-medium ui-text  disabled:opacity-50"
                                >
                                    {saving ? 'Menyimpan...' : 'Simpan'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            ) : null}

            {categoryToDelete ? (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
                    <div className="mx-4 w-full max-w-md rounded-xl border ui-border ui-panel-muted shadow-xl" role="dialog" aria-modal="true" aria-labelledby="payment-category-delete-title">
                        <div className="border-b ui-border p-4">
                            <h2 id="payment-category-delete-title" className="text-lg font-semibold ui-text">Hapus Kategori Pembayaran</h2>
                            <p className="mt-1 text-sm ui-text-muted">
                                Tindakan ini hanya aman jika kategori belum dipakai metode pembayaran.
                            </p>
                        </div>
                        <div className="space-y-4 p-4">
                            <div className="rounded-lg border ui-border ui-panel p-3">
                                <p className="text-sm font-semibold ui-text">{categoryToDelete.name}</p>
                                <p className="mt-1 text-xs ui-text-muted">{categoryToDelete.slug}</p>
                                <p className="mt-2 text-xs ui-text-muted">
                                    {categoryToDelete.methodCount ?? 0} metode masih terkait.
                                </p>
                                <p className="mt-1 text-xs ui-text-muted">
                                    Aktif {categoryToDelete.activeMethodCount ?? 0}, nonaktif {categoryToDelete.inactiveMethodCount ?? 0}.
                                </p>
                            </div>
                            {categoryToDelete.canDelete === false ? (
                                <div className="ui-warning-chip rounded-lg border p-3 text-sm">
                                    {categoryToDelete.deleteBlockedReason || 'Kategori ini belum bisa dihapus.'}
                                </div>
                            ) : (
                                <div className="rounded-lg border p-3 text-sm ui-danger-chip">
                                    Kategori akan dihapus permanen.
                                </div>
                            )}
                            <div className="flex justify-end gap-3">
                                <button
                                    type="button"
                                    onClick={() => setCategoryToDelete(null)}
                                    className="rounded-lg border ui-border px-4 py-2 text-sm font-medium ui-text-muted hover:bg-[var(--ui-card-muted)]"
                                >
                                    Tutup
                                </button>
                                <button
                                    type="button"
                                    onClick={confirmDelete}
                                    disabled={categoryToDelete.canDelete === false || deleting}
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
                title="Pilih Icon Kategori"
            />
        </div>
    );
}
