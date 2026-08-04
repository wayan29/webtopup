import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { apiV2 } from '../../api';
import { Plus, Edit2, Trash2, Power, X, AlertCircle, GripVertical, Package, Sparkles, Search } from 'lucide-react';
import {
    DndContext,
    closestCenter,
    KeyboardSensor,
    PointerSensor,
    useSensor,
    useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import {
    arrayMove,
    SortableContext,
    sortableKeyboardCoordinates,
    useSortable,
    verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

interface Category {
    _id: string;
    categoryId?: number;
    name: string;
    slug: string;
    icon: string;
    sortOrder: number;
    status: boolean;
    productCount?: number;
    directProductCount?: number;
    legacyProductCount?: number;
    operatorCount?: number;
    productTypeCount?: number;
    dependencyCount?: number;
    canDelete?: boolean;
    createdAt: string;
    updatedAt: string;
}

const ICONS = ['🎮', '📱', '💳', '⚡', '🌐', '📡', '🎫', '🛒', '💰', '🎁', '📦', '🔌', '📺', '🎵', '🎬'];

const slugify = (text: string) => text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

function SortableRow({ category, displayOrder, onEdit, onToggleStatus, onDelete, dragDisabled = false, actionDisabled = false, toggling = false }: {
    category: Category;
    displayOrder: number;
    onEdit: (cat: Category) => void;
    onToggleStatus: (cat: Category) => void;
    onDelete: (cat: Category) => void;
    dragDisabled?: boolean;
    actionDisabled?: boolean;
    toggling?: boolean;
}) {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
    } = useSortable({ id: category._id, disabled: dragDisabled });

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        backgroundColor: isDragging ? 'var(--ui-card-muted)' : undefined,
    };

    return (
        <tr ref={setNodeRef} style={style} className="hover:bg-[var(--ui-card-bg)]">
            <td className="px-4 py-3">
                <span className="text-sm font-mono ui-accent-text">#{category.categoryId || '-'}</span>
            </td>
            <td className="px-4 py-3 text-sm ui-text-muted">
                <div className="flex items-center gap-2">
                    <button
                        {...attributes}
                        {...listeners}
                        disabled={dragDisabled}
                        className={`touch-none p-1 rounded transition-colors ${dragDisabled ? 'cursor-not-allowed opacity-40' : 'cursor-grab active:cursor-grabbing hover:bg-[var(--ui-card-muted)]'}`}
                        title={dragDisabled ? 'Matikan filter untuk mengubah urutan' : 'Drag untuk mengubah urutan'}
                        aria-label={dragDisabled ? `Pengurutan ${category.name} terkunci. Matikan filter untuk mengubah urutan.` : `Geser ${category.name} untuk mengubah urutan`}
                    >
                        <GripVertical className="w-4 h-4 ui-text-muted" />
                    </button>
                    {displayOrder}
                </div>
            </td>
            <td className="px-4 py-3 text-2xl">{category.icon}</td>
            <td className="px-4 py-3 text-sm font-semibold ui-text">{category.name}</td>
            <td className="px-4 py-3 text-sm ui-text-muted font-mono">{category.slug}</td>
            <td className="px-4 py-3 text-sm ui-text-muted">
                <div className="space-y-1">
                    <span className="inline-flex px-2 py-1 ui-panel-muted rounded-full text-xs font-medium ui-text">
                        {category.productCount || 0} produk
                    </span>
                    <p className="text-[11px] ui-text-muted">
                        Operator: {category.operatorCount || 0} • Tipe: {category.productTypeCount || 0}
                    </p>
                    {(category.legacyProductCount || 0) > 0 && (
                        <p className="text-[11px] ui-warning-text">
                            {category.legacyProductCount} referensi legacy tanpa `categoryId`
                        </p>
                    )}
                </div>
            </td>
            <td className="px-4 py-3">
                <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-semibold ${category.status ? 'ui-success-chip' : 'ui-panel-muted ui-text-muted'}`}>
                    {category.status ? 'Aktif' : 'Nonaktif'}
                </span>
            </td>
            <td className="px-4 py-3 text-xs ui-text-muted whitespace-nowrap">
                {category.createdAt ? new Date(category.createdAt).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) : '-'}
            </td>
            <td className="px-4 py-3 text-xs ui-text-muted whitespace-nowrap">
                {category.updatedAt ? new Date(category.updatedAt).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) : '-'}
            </td>
            <td className="px-4 py-3">
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => onEdit(category)}
                        disabled={actionDisabled}
                        className="ui-info-chip p-2 rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                        title="Edit"
                        aria-label={`Edit kategori ${category.name}`}
                    >
                        <Edit2 className="w-4 h-4" />
                    </button>
                    <button
                        onClick={() => onToggleStatus(category)}
                        disabled={actionDisabled || toggling}
                        className={`p-2 rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${category.status ? 'ui-accent-text hover:text-[var(--ui-accent-strong)] hover:bg-[var(--ui-accent-soft)]' : 'ui-success-action'}`}
                        title={category.status ? 'Nonaktifkan' : 'Aktifkan'}
                        aria-label={`${category.status ? 'Nonaktifkan' : 'Aktifkan'} kategori ${category.name}`}
                    >
                        {toggling ? <div className="h-4 w-4 rounded-full border-2 border-current border-t-transparent animate-spin" /> : <Power className="w-4 h-4" />}
                    </button>
                    <button
                        onClick={() => onDelete(category)}
                        disabled={actionDisabled}
                        className="ui-danger-action p-2 rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                        title="Hapus"
                        aria-label={`Hapus kategori ${category.name}`}
                    >
                        <Trash2 className="w-4 h-4" />
                    </button>
                </div>
            </td>
        </tr>
    );
}

export default function ProductCategories() {
    const [searchParams, setSearchParams] = useSearchParams();
    const [categories, setCategories] = useState<Category[]>([]);
    const [loading, setLoading] = useState(true);
    const [showModal, setShowModal] = useState(false);
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [selectedCategory, setSelectedCategory] = useState<Category | null>(null);
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const [saving, setSaving] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [togglingId, setTogglingId] = useState<string | null>(null);
    const [reordering, setReordering] = useState(false);
    const latestRequestId = useRef(0);
    const reorderInFlight = useRef(false);
    const [search, setSearch] = useState(() => searchParams.get('search') || '');
    const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>(() => {
        const status = searchParams.get('status');
        return status === 'active' || status === 'inactive' ? status : 'all';
    });

    const [formData, setFormData] = useState({
        name: '',
        icon: '📦',
        sortOrder: 0,
        status: true
    });

    const sensors = useSensors(
        useSensor(PointerSensor),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        })
    );

    const fetchCategories = useCallback(async () => {
        const requestId = latestRequestId.current + 1;
        latestRequestId.current = requestId;

        try {
            setLoading(true);
            const res = await apiV2
                .get('/categories/admin/all');
            if (requestId !== latestRequestId.current) return;
            setCategories(res.data);
        } catch (error) {
            if (requestId !== latestRequestId.current) return;
            console.error('Failed to fetch categories', error);
            setMessage({ type: 'error', text: 'Gagal memuat data kategori' });
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
        const handler = () => fetchCategories();
        window.addEventListener('admin:refresh-current-page', handler);
        return () => window.removeEventListener('admin:refresh-current-page', handler);
    }, [fetchCategories]);

    useEffect(() => {
        const params = new URLSearchParams(searchParams);
        if (search.trim()) {
            params.set('search', search.trim());
        } else {
            params.delete('search');
        }
        if (statusFilter !== 'all') {
            params.set('status', statusFilter);
        } else {
            params.delete('status');
        }
        setSearchParams(params, { replace: true });
    }, [search, statusFilter, searchParams, setSearchParams]);

    const filteredCategories = useMemo(() => categories.filter((category) => {
        const keyword = search.trim().toLowerCase();
        const matchesSearch = keyword.length === 0
            || category.name.toLowerCase().includes(keyword)
            || category.slug.toLowerCase().includes(keyword);
        const matchesStatus = statusFilter === 'all'
            || (statusFilter === 'active' ? category.status : !category.status);

        return matchesSearch && matchesStatus;
    }), [categories, search, statusFilter]);

    const canReorder = search.trim().length === 0 && statusFilter === 'all';
    const categoryStats = useMemo(() => categories.reduce((stats, category) => ({
        totalProductRefs: stats.totalProductRefs + (category.productCount || 0),
        totalOperatorRefs: stats.totalOperatorRefs + (category.operatorCount || 0),
        totalProductTypeRefs: stats.totalProductTypeRefs + (category.productTypeCount || 0),
        totalLegacyRefs: stats.totalLegacyRefs + (category.legacyProductCount || 0),
        activeCount: stats.activeCount + (category.status ? 1 : 0),
        inactiveCount: stats.inactiveCount + (category.status ? 0 : 1),
    }), {
        totalProductRefs: 0,
        totalOperatorRefs: 0,
        totalProductTypeRefs: 0,
        totalLegacyRefs: 0,
        activeCount: 0,
        inactiveCount: 0,
    }), [categories]);
    const totalProductRefs = categoryStats.totalProductRefs;
    const totalOperatorRefs = categoryStats.totalOperatorRefs;
    const totalProductTypeRefs = categoryStats.totalProductTypeRefs;
    const totalLegacyRefs = categoryStats.totalLegacyRefs;
    const slugPreview = slugify(formData.name);
    const selectedDependencyTotal = selectedCategory?.dependencyCount
        ?? ((selectedCategory?.productCount || 0) + (selectedCategory?.operatorCount || 0) + (selectedCategory?.productTypeCount || 0));

    const handleDragEnd = async (event: DragEndEvent) => {
        if (!canReorder || reordering || reorderInFlight.current || saving || deleting || togglingId) {
            return;
        }

        const { active, over } = event;

        if (over && active.id !== over.id) {
            const oldIndex = categories.findIndex((c) => c._id === active.id);
            const newIndex = categories.findIndex((c) => c._id === over.id);
            if (oldIndex < 0 || newIndex < 0) {
                return;
            }

            const newCategories = arrayMove(categories, oldIndex, newIndex);
            
            // Update sortOrder for all items
            const updatedCategories = newCategories.map((cat, idx) => ({
                ...cat,
                sortOrder: idx + 1
            }));
            
            setCategories(updatedCategories);

            // Save to server
            try {
                reorderInFlight.current = true;
                setReordering(true);
                const orders = updatedCategories.map((cat, idx) => ({
                    id: cat._id,
                    sortOrder: idx + 1
                }));
                await apiV2
                    .put('/categories/admin/sort-order', { orders });
                setMessage({ type: 'success', text: 'Urutan kategori berhasil diperbarui' });
            } catch (error) {
                console.error('Failed to update sort order', error);
                setMessage({ type: 'error', text: 'Gagal menyimpan urutan' });
                await fetchCategories(); // Revert on error
            } finally {
                reorderInFlight.current = false;
                setReordering(false);
            }
        }
    };

    const handleOpenModal = (category?: Category) => {
        if (category) {
            setSelectedCategory(category);
            setFormData({
                name: category.name,
                icon: category.icon,
                sortOrder: category.sortOrder,
                status: category.status
            });
        } else {
            setSelectedCategory(null);
            setFormData({
                name: '',
                icon: '📦',
                sortOrder: 0,
                status: true
            });
        }
        setShowModal(true);
    };

    const handleCloseModal = () => {
        setShowModal(false);
        setSelectedCategory(null);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setMessage(null);
        if (!slugPreview) {
            setMessage({ type: 'error', text: 'Nama kategori harus menghasilkan slug yang valid.' });
            return;
        }
        setSaving(true);

        try {
            if (selectedCategory) {
                await apiV2
                    .put(`/categories/admin/${selectedCategory._id}`, formData);
                setMessage({ type: 'success', text: 'Kategori berhasil diperbarui' });
            } else {
                const { sortOrder: _sortOrder, ...createPayload } = formData;
                await apiV2
                    .post('/categories/admin/create', createPayload);
                setMessage({ type: 'success', text: 'Kategori berhasil ditambahkan' });
            }
            handleCloseModal();
            await fetchCategories();
        } catch (error: any) {
            setMessage({ type: 'error', text: error.response?.data?.message || 'Gagal menyimpan kategori' });
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async () => {
        if (!selectedCategory || deleting || reordering) return;

        try {
            setDeleting(true);
            await apiV2
                .delete(`/categories/admin/${selectedCategory._id}`);
            setMessage({ type: 'success', text: 'Kategori berhasil dihapus' });
            setShowDeleteModal(false);
            setSelectedCategory(null);
            await fetchCategories();
        } catch (error: any) {
            setMessage({ type: 'error', text: error.response?.data?.message || 'Gagal menghapus kategori' });
        } finally {
            setDeleting(false);
        }
    };

    const handleToggleStatus = async (category: Category) => {
        if (togglingId || reordering || saving || deleting) return;

        try {
            setTogglingId(category._id);
            await apiV2
                .put(`/categories/admin/${category._id}`, { status: !category.status });
            setMessage({ type: 'success', text: `Kategori ${!category.status ? 'diaktifkan' : 'dinonaktifkan'}` });
            await fetchCategories();
        } catch (error: any) {
            setMessage({ type: 'error', text: error.response?.data?.message || 'Gagal mengubah status' });
        } finally {
            setTogglingId(null);
        }
    };

    // Auto-hide message after 3 seconds
    useEffect(() => {
        if (message?.type === 'success') {
            const timer = setTimeout(() => setMessage(null), 3000);
            return () => clearTimeout(timer);
        }
    }, [message]);

    return (
        <div className="space-y-5">
            <div className="ui-panel-muted border ui-border rounded-xl p-4 flex flex-wrap items-center gap-3">
                <button
                    onClick={() => handleOpenModal()}
                    className="inline-flex items-center gap-2 px-4 py-2.5 ui-accent-solid rounded-xl text-sm font-semibold transition-colors"
                >
                    <Plus className="w-4 h-4" />
                    Tambah Kategori
                </button>
                <div className="flex items-center gap-2 text-xs uppercase tracking-[0.14em] ui-text-muted ui-panel border ui-border px-3 py-2 rounded-xl">
                    <GripVertical className="h-4 w-4 ui-accent-text" />
                    drag to reorder
                </div>
            </div>

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

            {/* Info Box */}
            <div className="ui-panel-muted border ui-border rounded-lg p-4 text-sm ui-text flex items-start gap-2">
                <GripVertical className="w-5 h-5 mt-0.5 flex-shrink-0 ui-text-muted" />
                <div>
                    <p className="font-medium ui-text">Tips Pengurutan</p>
                    <p className="ui-text-muted">Drag icon <GripVertical className="w-4 h-4 inline" /> di sebelah kiri untuk mengubah urutan kategori. Urutan ini akan mempengaruhi tampilan di halaman user.</p>
                    {!canReorder && (
                        <p className="mt-2 ui-warning-text">Filter aktif. Matikan filter jika ingin mengubah urutan kategori.</p>
                    )}
                </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-xl border ui-border ui-panel-muted p-4">
                    <p className="text-sm ui-text-muted">Total Kategori</p>
                    <p className="mt-2 text-2xl font-bold ui-text">{categories.length}</p>
                    <p className="mt-1 text-xs ui-text-muted">{filteredCategories.length} tampil sesuai filter</p>
                </div>
                <div className="rounded-xl border ui-border ui-panel-muted p-4">
                    <p className="text-sm ui-text-muted">Status Kategori</p>
                    <p className="mt-2 text-2xl font-bold ui-success-text">{categoryStats.activeCount}</p>
                    <p className="mt-1 text-xs ui-text-muted">{categoryStats.inactiveCount} nonaktif</p>
                </div>
                <div className="rounded-xl border ui-border ui-panel-muted p-4">
                    <p className="text-sm ui-text-muted">Referensi Produk</p>
                    <p className="mt-2 text-2xl font-bold ui-text">{totalProductRefs}</p>
                    <p className="mt-1 text-xs ui-warning-text">{totalLegacyRefs} referensi legacy</p>
                </div>
                <div className="rounded-xl border ui-border ui-panel-muted p-4">
                    <p className="text-sm ui-text-muted">Struktur Turunan</p>
                    <p className="mt-2 text-2xl font-bold ui-text">{totalOperatorRefs + totalProductTypeRefs}</p>
                    <p className="mt-1 text-xs ui-text-muted">{totalOperatorRefs} operator • {totalProductTypeRefs} tipe</p>
                </div>
            </div>

            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="relative w-full max-w-md">
                    <label htmlFor="product-category-search" className="sr-only">Cari kategori produk</label>
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 ui-text-muted" />
                    <input
                        id="product-category-search"
                        type="text"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Cari nama atau slug kategori..."
                        className="w-full rounded-xl border ui-border ui-panel-muted py-2.5 pl-10 pr-4 text-sm ui-text placeholder:ui-text-muted focus:outline-none focus:border-[var(--ui-accent)]"
                    />
                </div>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                    <label htmlFor="product-category-status" className="sr-only">Filter status kategori</label>
                    <select
                        id="product-category-status"
                        value={statusFilter}
                        onChange={(e) => setStatusFilter(e.target.value as 'all' | 'active' | 'inactive')}
                        className="rounded-xl border ui-border ui-panel-muted px-4 py-2.5 text-sm ui-text focus:outline-none focus:border-[var(--ui-accent)]"
                    >
                        <option value="all">Semua Status</option>
                        <option value="active">Aktif</option>
                        <option value="inactive">Nonaktif</option>
                    </select>
                    <div className="rounded-xl border ui-border ui-panel px-3 py-2 text-xs uppercase tracking-[0.14em] ui-text-muted">
                        {reordering ? 'menyimpan urutan...' : canReorder ? 'drag to reorder' : 'filter mode'}
                    </div>
                </div>
            </div>

            {/* Table */}
            <div className="ui-panel-muted rounded-xl border ui-border overflow-hidden">
                <div className="overflow-x-auto">
                    <table className="min-w-full">
                        <thead>
                            <tr className="ui-panel ui-text-muted text-xs uppercase">
                                <th className="px-4 py-3 text-left font-semibold w-16">#ID</th>
                                <th className="px-4 py-3 text-left font-semibold w-20">Urutan</th>
                                <th className="px-4 py-3 text-left font-semibold w-16">Icon</th>
                                <th className="px-4 py-3 text-left font-semibold">Nama</th>
                                <th className="px-4 py-3 text-left font-semibold">Slug</th>
                                <th className="px-4 py-3 text-left font-semibold">Dependensi</th>
                                <th className="px-4 py-3 text-left font-semibold">Status</th>
                                <th className="px-4 py-3 text-left font-semibold">Dibuat</th>
                                <th className="px-4 py-3 text-left font-semibold">Diubah</th>
                                <th className="px-4 py-3 text-left font-semibold">Aksi</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-[var(--ui-border)]">
                            {loading ? (
                                <tr>
                                    <td colSpan={10} className="px-4 py-6 text-center ui-text-muted">
                                        <div className="flex items-center justify-center gap-2">
                                            <div className="h-5 w-5 border-2 border-[var(--ui-border)] border-t-[var(--ui-accent)] rounded-full animate-spin" />
                                            Memuat data...
                                        </div>
                                    </td>
                                </tr>
                            ) : filteredCategories.length === 0 ? (
                                <tr>
                                    <td colSpan={10} className="px-4 py-10 text-center">
                                        <Package className="w-12 h-12 ui-text-muted mx-auto mb-3" />
                                        <p className="ui-text-muted font-semibold">{categories.length === 0 ? 'Belum ada kategori' : 'Tidak ada kategori yang cocok'}</p>
                                        <p className="ui-text-muted text-sm">
                                            {categories.length === 0
                                                ? 'Klik tombol "Tambah Kategori" untuk membuat kategori baru'
                                                : 'Coba ubah keyword pencarian atau filter status.'}
                                        </p>
                                    </td>
                                </tr>
                            ) : (
                                <DndContext
                                    sensors={sensors}
                                    collisionDetection={closestCenter}
                                    onDragEnd={handleDragEnd}
                                >
                                    <SortableContext
                                        items={filteredCategories.map(c => c._id)}
                                        strategy={verticalListSortingStrategy}
                                    >
                                        {filteredCategories.map((cat, idx) => (
                                            <SortableRow
                                                key={cat._id}
                                                category={cat}
                                                displayOrder={canReorder ? idx + 1 : cat.sortOrder || idx + 1}
                                                onEdit={handleOpenModal}
                                                onToggleStatus={handleToggleStatus}
                                                actionDisabled={saving || deleting || reordering || Boolean(togglingId)}
                                                toggling={togglingId === cat._id}
                                                dragDisabled={!canReorder || reordering}
                                                onDelete={(c) => {
                                                    setSelectedCategory(c);
                                                    setShowDeleteModal(true);
                                                }}
                                            />
                                        ))}
                                    </SortableContext>
                                </DndContext>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Stats */}
            <div className="flex flex-wrap gap-4 text-sm ui-text-muted">
                <span>
                    Total: <span className="font-semibold ui-text">{categories.length}</span> kategori
                </span>
                <span>
                    Tampil: <span className="font-semibold ui-text">{filteredCategories.length}</span>
                </span>
                <span>
                    Aktif: <span className="font-semibold ui-success-text">{categoryStats.activeCount}</span>
                </span>
                <span>
                    Nonaktif: <span className="font-semibold ui-danger-text">{categoryStats.inactiveCount}</span>
                </span>
            </div>

            {/* Create/Edit Modal */}
            {showModal && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
                    <div className="ui-panel w-full max-w-lg overflow-hidden rounded-2xl border border-[color-mix(in_srgb,var(--ui-accent)_34%,transparent)] shadow-[0_30px_80px_rgba(0,0,0,0.5)]" role="dialog" aria-modal="true" aria-labelledby="product-category-modal-title">
                        <div className="ui-card-gradient relative px-5 py-4 border-b ui-border">
                            <div className="absolute inset-0 pointer-events-none opacity-30 bg-[radial-gradient(circle_at_18%_18%,rgba(255,141,70,0.22),transparent_32%),radial-gradient(circle_at_82%_8%,rgba(109,152,255,0.22),transparent_30%)]" />
                            <div className="relative flex items-center justify-between">
                                <div className="flex items-center gap-3">
                                    <span className="inline-flex items-center justify-center h-10 w-10 rounded-xl ui-panel-muted border ui-border ui-accent-text">
                                        <Sparkles className="h-5 w-5" />
                                    </span>
                                    <div>
                                        <p className="text-[11px] uppercase tracking-[0.18em] ui-accent-text">Kategori</p>
                                        <h2 id="product-category-modal-title" className="text-xl font-bold ui-text leading-tight">
                                            {selectedCategory ? 'Edit Kategori' : 'Tambah Kategori Baru'}
                                        </h2>
                                    </div>
                                </div>
                                <button type="button" onClick={handleCloseModal} className="p-2 ui-text-muted hover:text-[var(--ui-text)] hover:bg-[var(--ui-card-muted)] rounded-lg transition-colors" aria-label="Tutup modal kategori">
                                    <X className="w-5 h-5" />
                                </button>
                            </div>
                        </div>
                        <form onSubmit={handleSubmit} className="p-5 space-y-4">
                            <div>
                                <label htmlFor="product-category-name" className="block text-sm font-medium ui-text-muted mb-1">Nama Kategori</label>
                                <input
                                    id="product-category-name"
                                    type="text"
                                    required
                                    value={formData.name}
                                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                                    className="w-full px-3 py-2 ui-panel border ui-border rounded-lg focus:outline-none focus:border-[var(--ui-accent)] ui-text shadow-inner"
                                    placeholder="Contoh: Pulsa & Paket Data"
                                />
                                <p className="mt-2 text-xs ui-text-muted">
                                    Slug: <span className={`${slugPreview ? 'ui-text-muted' : 'ui-danger-text'} font-mono`}>{slugPreview || 'nama tidak valid untuk slug'}</span>
                                </p>
                            </div>

                            <div>
                                <label className="block text-sm font-medium ui-text-muted mb-2" id="product-category-icon-label">Icon</label>
                                <div className="flex flex-wrap gap-2">
                                    {ICONS.map((icon) => (
                                        <button
                                            key={icon}
                                            type="button"
                                            onClick={() => setFormData({ ...formData, icon })}
                                            className={`w-10 h-10 text-xl rounded-lg border-2 transition-colors ${formData.icon === icon ? 'border-[var(--ui-accent)] bg-[var(--ui-accent-soft)] ui-text shadow-[0_8px_30px_var(--ui-accent-soft)]' : 'ui-border hover:border-[var(--ui-accent)] ui-text ui-panel'}`}
                                            aria-label={`Pilih ikon ${icon}`}
                                            aria-pressed={formData.icon === icon}
                                        >
                                            {icon}
                                        </button>
                                    ))}
                                </div>
                            </div>

                            <div className="flex items-center gap-2">
                                <input
                                    type="checkbox"
                                    id="status"
                                    checked={formData.status}
                                    onChange={(e) => setFormData({ ...formData, status: e.target.checked })}
                                    className="w-4 h-4 ui-accent-text ui-panel ui-border rounded focus:ring-[var(--ui-accent)]"
                                />
                                <label htmlFor="status" className="text-sm ui-text-muted">Kategori Aktif (tampil di halaman user)</label>
                            </div>

                            <div className="flex gap-3 pt-4">
                                <button
                                    type="button"
                                    onClick={handleCloseModal}
                                    className="flex-1 px-4 py-2 border ui-border ui-text rounded-lg hover:bg-[var(--ui-card-muted)] transition-colors"
                                >
                                    Batal
                                </button>
                                <button
                                    type="submit"
                                    disabled={saving || !slugPreview}
                                    className="flex-1 px-4 py-2 ui-accent-solid rounded-lg hover:shadow-[0_14px_46px_rgba(255,140,66,0.36)] transition-all disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    {saving ? 'Menyimpan...' : selectedCategory ? 'Simpan Perubahan' : 'Tambah Kategori'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Delete Confirmation Modal */}
            {showDeleteModal && selectedCategory && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
                    <div className="ui-panel-muted border ui-border rounded-xl shadow-xl w-full max-w-sm mx-4 p-6" role="dialog" aria-modal="true" aria-labelledby="delete-product-category-title">
                        <div className="text-center">
                            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full border ui-danger-chip">
                                <Trash2 className="w-6 h-6 ui-danger-text" />
                            </div>
                            <h3 id="delete-product-category-title" className="text-lg font-semibold ui-text mb-2">Hapus Kategori?</h3>
                            <p className="ui-text-muted mb-6">
                                Anda yakin ingin menghapus kategori "<span className="font-medium ui-text">{selectedCategory.name}</span>"?
                                {selectedDependencyTotal > 0 && (
                                    <span className="block mt-2 ui-danger-text text-sm">
                                        Kategori ini masih dipakai oleh:
                                        <span className="block mt-1">
                                            {selectedCategory.directProductCount || 0} produk, {selectedCategory.operatorCount || 0} operator, {selectedCategory.productTypeCount || 0} tipe produk.
                                        </span>
                                        {(selectedCategory.legacyProductCount || 0) > 0 && (
                                            <span className="block mt-1 ui-warning-text">
                                                {selectedCategory.legacyProductCount} referensi legacy belum memakai `categoryId`.
                                            </span>
                                        )}
                                        <span className="block mt-1">Hapus tidak tersedia. Nonaktifkan kategori jika ingin menyembunyikannya dari user.</span>
                                    </span>
                                )}
                            </p>
                            <div className="flex gap-3">
                                <button
                                    onClick={() => {
                                        setShowDeleteModal(false);
                                        setSelectedCategory(null);
                                    }}
                                    className="flex-1 px-4 py-2 border ui-border ui-text-muted rounded-lg hover:bg-[var(--ui-card-muted)] transition-colors"
                                >
                                    Batal
                                </button>
                                <button
                                    onClick={handleDelete}
                                    disabled={deleting || reordering || selectedDependencyTotal > 0 || selectedCategory.canDelete === false}
                                    className="ui-danger-action flex-1 px-4 py-2 border rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    {deleting ? 'Menghapus...' : 'Hapus'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
