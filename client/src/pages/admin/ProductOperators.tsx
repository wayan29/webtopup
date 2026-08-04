import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { apiV2 } from '../../api';
import { Plus, Edit2, Power, Trash2, AlertCircle, Package, GripVertical, Search, X } from 'lucide-react';
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
import OperatorIcon from '../../components/OperatorIcon';

interface Category {
    _id: string;
    name: string;
    slug: string;
    icon: string;
    sortOrder: number;
    status: boolean;
}

interface Operator {
    _id: string;
    operatorId?: number;
    name: string;
    slug?: string;
    categoryId: string | { _id: string; name: string; icon: string; slug?: string; status?: boolean };
    icon?: string;
    checkUsername: boolean;
    usernameLabel?: string;
    validationType?: string;
    userIdLabel?: string;
    sortOrder: number;
    status: boolean;
    productCount?: number;
    directProductCount?: number;
    legacyProductCount?: number;
    productTypeCount?: number;
    dependencyCount?: number;
    canDelete?: boolean;
    createdAt?: string;
    updatedAt?: string;
}

function SortableOperatorRow({
    operator,
    displayOrder,
    validationLabel,
    onEdit,
    onToggleStatus,
    onDelete,
    dragDisabled = false,
    actionDisabled = false,
    toggling = false,
}: {
    operator: Operator;
    displayOrder: number;
    validationLabel: string;
    onEdit: (operator: Operator) => void;
    onToggleStatus: (operator: Operator) => void;
    onDelete: (operator: Operator) => void;
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
    } = useSortable({ id: operator._id, disabled: dragDisabled });

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        backgroundColor: isDragging ? 'var(--ui-card-muted)' : undefined,
    };

    return (
        <tr ref={setNodeRef} style={style} className="hover:bg-[var(--ui-card-bg)]">
            <td className="px-4 py-3">
                <span className="text-sm font-mono ui-accent-text">#{operator.operatorId || '-'}</span>
            </td>
            <td className="px-4 py-3 text-sm ui-text-muted">
                <div className="flex items-center gap-2">
                    <button
                        {...attributes}
                        {...listeners}
                        disabled={dragDisabled}
                        className={`touch-none rounded p-1 transition-colors ${dragDisabled ? 'cursor-not-allowed opacity-40' : 'cursor-grab active:cursor-grabbing hover:bg-[var(--ui-card-muted)]'}`}
                        title={dragDisabled ? 'Matikan filter untuk mengubah urutan' : 'Drag untuk mengubah urutan'}
                        aria-label={dragDisabled ? `Pengurutan ${operator.name} terkunci` : `Geser ${operator.name} untuk mengubah urutan`}
                    >
                        <GripVertical className="h-4 w-4 ui-text-muted" />
                    </button>
                    {displayOrder}
                </div>
            </td>
            <td className="px-4 py-3">
                <div className="flex items-center gap-2">
                    {operator.icon && <OperatorIcon icon={operator.icon} size="md" />}
                    <div>
                        <span className="text-sm font-semibold ui-text">{operator.name}</span>
                        {operator.slug && <p className="text-xs font-mono ui-text-muted">{operator.slug}</p>}
                    </div>
                </div>
            </td>
            <td className="px-4 py-3 text-sm ui-text-muted">
                <div className="space-y-1">
                    <span className="inline-flex rounded-full ui-panel-muted px-2 py-1 text-xs font-medium ui-text">
                        {operator.productCount || 0} produk
                    </span>
                    <p className="text-[11px] ui-text-muted">Tipe produk: {operator.productTypeCount || 0}</p>
                    {(operator.legacyProductCount || 0) > 0 && (
                        <p className="text-[11px] ui-warning-text">
                            {operator.legacyProductCount} referensi legacy tanpa `operatorId`
                        </p>
                    )}
                </div>
            </td>
            <td className="px-4 py-3 text-sm ui-text-muted">
                {validationLabel !== '-' ? (
                    <span className="ui-info-text">{validationLabel}</span>
                ) : (
                    <span className="ui-text-muted">-</span>
                )}
            </td>
            <td className="px-4 py-3">
                <span className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-semibold ${operator.status ? 'ui-success-chip' : 'ui-panel-muted ui-text-muted'}`}>
                    {operator.status ? 'Aktif' : 'Nonaktif'}
                </span>
            </td>
            <td className="px-4 py-3 text-xs ui-text-muted whitespace-nowrap">
                {operator.createdAt ? new Date(operator.createdAt).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) : '-'}
            </td>
            <td className="px-4 py-3 text-xs ui-text-muted whitespace-nowrap">
                {operator.updatedAt ? new Date(operator.updatedAt).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) : '-'}
            </td>
            <td className="px-4 py-3">
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => onEdit(operator)}
                        disabled={actionDisabled}
                        className="ui-info-chip rounded-lg p-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                        title="Edit"
                        aria-label={`Edit operator ${operator.name}`}
                    >
                        <Edit2 className="h-4 w-4" />
                    </button>
                    <button
                        onClick={() => onToggleStatus(operator)}
                        disabled={actionDisabled || toggling}
                        className={`rounded-lg p-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${operator.status ? 'ui-accent-text hover:bg-[var(--ui-accent-soft)] hover:text-[var(--ui-accent-strong)]' : 'ui-success-action'}`}
                        title={operator.status ? 'Nonaktifkan' : 'Aktifkan'}
                        aria-label={`${operator.status ? 'Nonaktifkan' : 'Aktifkan'} operator ${operator.name}`}
                    >
                        {toggling ? <div className="h-4 w-4 rounded-full border-2 border-current border-t-transparent animate-spin" /> : <Power className="h-4 w-4" />}
                    </button>
                    <button
                        onClick={() => onDelete(operator)}
                        disabled={actionDisabled}
                        className="ui-danger-action rounded-lg p-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                        title="Hapus"
                        aria-label={`Hapus operator ${operator.name}`}
                    >
                        <Trash2 className="h-4 w-4" />
                    </button>
                </div>
            </td>
        </tr>
    );
}

export default function ProductOperators() {
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();
    const [categories, setCategories] = useState<Category[]>([]);
    const [operators, setOperators] = useState<Operator[]>([]);
    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useState<string>(() => searchParams.get('category') || '');
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [selectedOperator, setSelectedOperator] = useState<Operator | null>(null);
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const [search, setSearch] = useState(() => searchParams.get('search') || '');
    const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>(() => {
        const status = searchParams.get('status');
        return status === 'active' || status === 'inactive' ? status : 'all';
    });
    const [reordering, setReordering] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [togglingId, setTogglingId] = useState<string | null>(null);
    const latestRequestId = useRef(0);
    const reorderInFlight = useRef(false);

    const sensors = useSensors(
        useSensor(PointerSensor),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        })
    );

    const fetchData = useCallback(async () => {
        const requestId = latestRequestId.current + 1;
        latestRequestId.current = requestId;

        try {
            setLoading(true);
            const [categoriesRes, operatorsRes] = await Promise.all([
                apiV2.get('/categories/admin/all'),
                apiV2.get('/operators/admin/all')
            ]);
            if (requestId !== latestRequestId.current) return;
            setCategories(categoriesRes.data);
            setOperators(operatorsRes.data || []);
            setActiveTab((currentTab) => {
                if (currentTab && categoriesRes.data.some((category: Category) => category._id === currentTab)) {
                    return currentTab;
                }
                const urlCategory = searchParams.get('category');
                if (urlCategory && categoriesRes.data.some((category: Category) => category._id === urlCategory)) {
                    return urlCategory;
                }
                return categoriesRes.data[0]?._id || '';
            });
        } catch (error) {
            if (requestId !== latestRequestId.current) return;
            console.error('Failed to fetch data', error);
            setMessage({ type: 'error', text: 'Gagal memuat data operator' });
        } finally {
            if (requestId === latestRequestId.current) {
                setLoading(false);
            }
        }
    }, [searchParams]);

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
        if (activeTab) params.set('category', activeTab); else params.delete('category');
        if (search.trim()) params.set('search', search.trim()); else params.delete('search');
        if (statusFilter !== 'all') params.set('status', statusFilter); else params.delete('status');
        setSearchParams(params, { replace: true });
    }, [activeTab, search, statusFilter, searchParams, setSearchParams]);

    // Helper to get categoryId as string
    const getCategoryId = (op: Operator): string => {
        if (typeof op.categoryId === 'object') {
            return op.categoryId._id;
        }
        return op.categoryId;
    };

    const categoryOperatorCountMap = useMemo(() => {
        return operators.reduce((map, operator) => {
            const categoryId = getCategoryId(operator);
            map.set(categoryId, (map.get(categoryId) || 0) + 1);
            return map;
        }, new Map<string, number>());
    }, [operators]);

    const activeCategoryOperators = useMemo(() => {
        return operators.filter(op => getCategoryId(op) === activeTab);
    }, [operators, activeTab]);

    const filteredOperators = useMemo(() => {
        const keyword = search.trim().toLowerCase();
        return activeCategoryOperators.filter((operator) => {
            const matchesSearch = keyword.length === 0
                || operator.name.toLowerCase().includes(keyword)
                || (operator.slug || '').toLowerCase().includes(keyword);
            const matchesStatus = statusFilter === 'all'
                || (statusFilter === 'active' ? operator.status : !operator.status);

            return matchesSearch && matchesStatus;
        });
    }, [activeCategoryOperators, search, statusFilter]);

    const canReorder = Boolean(activeTab) && search.trim().length === 0 && statusFilter === 'all';
    const activeStats = useMemo(() => activeCategoryOperators.reduce((stats, operator) => ({
        products: stats.products + (operator.productCount || 0),
        productTypes: stats.productTypes + (operator.productTypeCount || 0),
        legacy: stats.legacy + (operator.legacyProductCount || 0),
        active: stats.active + (operator.status ? 1 : 0),
        inactive: stats.inactive + (operator.status ? 0 : 1),
    }), { products: 0, productTypes: 0, legacy: 0, active: 0, inactive: 0 }), [activeCategoryOperators]);
    const activeProductsTotal = activeStats.products;
    const activeProductTypesTotal = activeStats.productTypes;
    const activeLegacyTotal = activeStats.legacy;
    const selectedDependencyTotal = selectedOperator?.dependencyCount
        ?? ((selectedOperator?.productCount || 0) + (selectedOperator?.productTypeCount || 0));
    const busy = loading || reordering || deleting || Boolean(togglingId);

    const validationLabelForOperator = (operator: Operator) => {
        if (operator.validationType && operator.validationType !== 'none') {
            const labels: Record<string, string> = {
                freefire: 'Free Fire',
                mobilelegends: 'Mobile Legends',
                operator: 'Cek No. HP',
            };
            return labels[operator.validationType] || operator.validationType;
        }
        if (operator.checkUsername) {
            return operator.usernameLabel || operator.userIdLabel || 'Ya';
        }
        return '-';
    };

    const handleOpenForm = (operator?: Operator) => {
        const params = new URLSearchParams();
        if (activeTab) params.set('category', activeTab);
        if (search.trim()) params.set('search', search.trim());
        if (statusFilter !== 'all') params.set('status', statusFilter);
        const suffix = params.toString() ? `?${params.toString()}` : '';
        if (operator) {
            navigate(`/admin/product-operators/edit/${operator._id}${suffix}`);
        } else {
            navigate(`/admin/product-operators/create${suffix}`);
        }
    };

    const handleDragEnd = async (event: DragEndEvent) => {
        if (!canReorder || reordering || reorderInFlight.current || deleting || togglingId) {
            return;
        }

        const { active, over } = event;

        if (over && active.id !== over.id) {
            const oldIndex = activeCategoryOperators.findIndex((operator) => operator._id === active.id);
            const newIndex = activeCategoryOperators.findIndex((operator) => operator._id === over.id);
            if (oldIndex < 0 || newIndex < 0) {
                return;
            }
            const reorderedActiveOperators = arrayMove(activeCategoryOperators, oldIndex, newIndex).map((operator, idx) => ({
                ...operator,
                sortOrder: idx + 1
            }));

            const reorderedIds = new Set(reorderedActiveOperators.map((operator) => operator._id));
            const untouchedOperators = operators.filter((operator) => !reorderedIds.has(operator._id));
            setOperators([...untouchedOperators, ...reorderedActiveOperators]);

            try {
                reorderInFlight.current = true;
                setReordering(true);
                const orders = reorderedActiveOperators.map((operator, idx) => ({
                    id: operator._id,
                    sortOrder: idx + 1
                }));
                await apiV2.put('/operators/admin/sort-order', { categoryId: activeTab, orders });
                setMessage({ type: 'success', text: 'Urutan operator berhasil diperbarui' });
            } catch (error) {
                console.error('Failed to update operator sort order', error);
                setMessage({ type: 'error', text: 'Gagal menyimpan urutan operator' });
                await fetchData();
            } finally {
                reorderInFlight.current = false;
                setReordering(false);
            }
        }
    };

    const handleDelete = async () => {
        if (!selectedOperator || deleting || reordering) return;

        try {
            setDeleting(true);
            await apiV2.delete(`/operators/admin/${selectedOperator._id}`);
            setMessage({ type: 'success', text: 'Operator berhasil dihapus' });
            setShowDeleteModal(false);
            setSelectedOperator(null);
            await fetchData();
        } catch (error: any) {
            setMessage({ type: 'error', text: error.response?.data?.message || 'Gagal menghapus operator' });
        } finally {
            setDeleting(false);
        }
    };

    const handleToggleStatus = async (operator: Operator) => {
        if (togglingId || reordering || deleting) return;
        if (operator.status && (operator.dependencyCount || 0) > 0) {
            const ok = window.confirm(`Operator ini masih dipakai oleh ${operator.productCount || 0} produk dan ${operator.productTypeCount || 0} tipe produk. Menonaktifkan operator dapat menyembunyikan katalog terkait. Lanjutkan?`);
            if (!ok) return;
        }

        try {
            setTogglingId(operator._id);
            await apiV2.put(`/operators/admin/${operator._id}`, { status: !operator.status });
            setMessage({ type: 'success', text: `Operator ${!operator.status ? 'diaktifkan' : 'dinonaktifkan'}` });
            await fetchData();
        } catch (error: any) {
            setMessage({ type: 'error', text: error.response?.data?.message || 'Gagal mengubah status' });
        } finally {
            setTogglingId(null);
        }
    };

    // Auto-hide message
    useEffect(() => {
        if (message?.type === 'success') {
            const timer = setTimeout(() => setMessage(null), 3000);
            return () => clearTimeout(timer);
        }
    }, [message]);

    const activeCategory = categories.find(c => c._id === activeTab);

    return (
        <div className="space-y-5">
            <div className="ui-panel-muted border ui-border rounded-xl p-4 flex flex-wrap items-center gap-3">
                <button
                    onClick={() => handleOpenForm()}
                    className="inline-flex items-center gap-2 px-4 py-2.5 ui-accent-solid rounded-xl text-sm font-semibold transition-colors"
                >
                    <Plus className="w-4 h-4" />
                    Tambah Operator
                </button>
                <div className="flex items-center gap-2 text-xs uppercase tracking-[0.14em] ui-text-muted ui-panel border ui-border px-3 py-2 rounded-xl">
                    <GripVertical className="h-4 w-4 ui-accent-text" />
                    drag rows
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

            <div className="ui-panel-muted border ui-border rounded-lg p-4 text-sm ui-text flex items-start gap-2">
                <GripVertical className="w-5 h-5 mt-0.5 flex-shrink-0 ui-text-muted" />
                <div>
                    <p className="font-medium ui-text">Tips Pengurutan</p>
                    <p className="ui-text-muted">Urutan operator berlaku per kategori. Gunakan drag hanya saat filter mati agar urutan yang tersimpan tetap akurat.</p>
                    {!canReorder && activeTab && (
                        <p className="mt-2 ui-warning-text">Filter aktif. Matikan filter jika ingin mengubah urutan operator.</p>
                    )}
                </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-xl border ui-border ui-panel-muted p-4">
                    <p className="text-sm ui-text-muted">Operator di Kategori</p>
                    <p className="mt-2 text-2xl font-bold ui-text">{activeCategoryOperators.length}</p>
                    <p className="mt-1 text-xs ui-text-muted">{filteredOperators.length} tampil sesuai filter</p>
                </div>
                <div className="rounded-xl border ui-border ui-panel-muted p-4">
                    <p className="text-sm ui-text-muted">Status Operator</p>
                    <p className="mt-2 text-2xl font-bold ui-success-text">{activeStats.active}</p>
                    <p className="mt-1 text-xs ui-text-muted">{activeStats.inactive} nonaktif</p>
                </div>
                <div className="rounded-xl border ui-border ui-panel-muted p-4">
                    <p className="text-sm ui-text-muted">Referensi Produk</p>
                    <p className="mt-2 text-2xl font-bold ui-text">{activeProductsTotal}</p>
                    <p className="mt-1 text-xs ui-warning-text">{activeLegacyTotal} referensi legacy</p>
                </div>
                <div className="rounded-xl border ui-border ui-panel-muted p-4">
                    <p className="text-sm ui-text-muted">Tipe Produk</p>
                    <p className="mt-2 text-2xl font-bold ui-text">{activeProductTypesTotal}</p>
                    <p className="mt-1 text-xs ui-text-muted">Terkait operator di kategori aktif</p>
                </div>
            </div>

            <div className="ui-panel-muted rounded-xl border ui-border overflow-hidden">
                {/* Category Tabs */}
                <div className="overflow-x-auto">
                    <div className="flex min-w-full ui-panel border-b ui-border">
                        {loading ? (
                            <div className="px-4 py-3 text-sm ui-text-muted">Memuat kategori...</div>
                        ) : categories.length === 0 ? (
                            <div className="px-4 py-3 text-sm ui-text-muted">
                                Belum ada kategori. <Link to="/admin/product-categories" className="ui-accent-text hover:underline">Tambah kategori</Link> terlebih dahulu.
                            </div>
                        ) : (
                            <div role="tablist" aria-label="Kategori operator" className="flex">
                                {categories.map((cat) => (
                                <button
                                    key={cat._id}
                                    role="tab"
                                    aria-selected={activeTab === cat._id}
                                    disabled={busy}
                                    onClick={() => setActiveTab(cat._id)}
                                    className={`px-4 py-3 text-sm font-medium border-r ui-border whitespace-nowrap flex items-center gap-2 transition-colors ${
                                        activeTab === cat._id 
                                            ? 'ui-accent-chip ui-accent-text' 
                                            : 'ui-text-muted hover:bg-[var(--ui-card-muted)]'
                                    } disabled:cursor-not-allowed disabled:opacity-60`}
                                >
                                    <span>{cat.icon}</span>
                                    <span>{cat.name}</span>
                                    <span className="rounded-full ui-panel-muted px-2 py-0.5 text-[11px] ui-text-muted">
                                        {categoryOperatorCountMap.get(cat._id) || 0}
                                    </span>
                                </button>
                                ))}
                            </div>
                        )}
                    </div>
                </div>

                {/* Info */}
                {activeCategory && (
                    <div className="px-4 py-2 text-sm ui-text-muted border-b ui-border flex items-center gap-2">
                        <span className="text-lg">{activeCategory.icon}</span>
                        <span>Operator untuk kategori <strong className="ui-text">{activeCategory.name}</strong></span>
                        <span className="ui-text-muted">|</span>
                        <span className="ui-text-muted">{activeCategoryOperators.length} operator</span>
                    </div>
                )}

                <div className="flex flex-col gap-3 border-b ui-border px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
                    <div className="relative w-full max-w-md">
                        <label htmlFor="operator-search" className="sr-only">Cari operator</label>
                        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 ui-text-muted" />
                        <input
                            id="operator-search"
                            type="text"
                            value={search}
                            disabled={reordering}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="Cari nama atau slug operator..."
                            className="w-full rounded-xl border ui-border ui-panel py-2.5 pl-10 pr-4 text-sm ui-text placeholder:ui-text-muted focus:outline-none focus:border-[var(--ui-accent)]"
                        />
                    </div>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                        <label htmlFor="operator-status-filter" className="sr-only">Filter status operator</label>
                        <select
                            id="operator-status-filter"
                            value={statusFilter}
                            disabled={reordering}
                            onChange={(e) => setStatusFilter(e.target.value as 'all' | 'active' | 'inactive')}
                            className="rounded-xl border ui-border ui-panel px-4 py-2.5 text-sm ui-text focus:outline-none focus:border-[var(--ui-accent)]"
                        >
                            <option value="all">Semua Status</option>
                            <option value="active">Aktif</option>
                            <option value="inactive">Nonaktif</option>
                        </select>
                        <div className="rounded-xl border ui-border ui-panel px-3 py-2 text-xs uppercase tracking-[0.14em] ui-text-muted">
                            {reordering ? 'menyimpan urutan...' : canReorder ? 'drag rows' : 'filter mode'}
                        </div>
                    </div>
                </div>

                {/* Table */}
                <table className="min-w-full">
                    <thead>
                        <tr className="ui-panel ui-text-muted text-xs uppercase">
                            <th className="px-4 py-3 text-left font-semibold w-16">#ID</th>
                            <th className="px-4 py-3 text-left font-semibold w-16">#</th>
                            <th className="px-4 py-3 text-left font-semibold">Nama Operator</th>
                            <th className="px-4 py-3 text-left font-semibold">Dependensi</th>
                            <th className="px-4 py-3 text-left font-semibold">Cek Username</th>
                            <th className="px-4 py-3 text-left font-semibold">Status</th>
                            <th className="px-4 py-3 text-left font-semibold">Dibuat</th>
                            <th className="px-4 py-3 text-left font-semibold">Diubah</th>
                            <th className="px-4 py-3 text-left font-semibold">Aksi</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--ui-border)]">
                        {loading ? (
                            <tr>
                                <td colSpan={9} className="px-4 py-6 text-center ui-text-muted">
                                    <div className="flex items-center justify-center gap-2">
                                        <div className="h-5 w-5 border-2 border-[var(--ui-border)] border-t-[var(--ui-accent)] rounded-full animate-spin" />
                                        Memuat data...
                                    </div>
                                </td>
                            </tr>
                        ) : !activeTab ? (
                            <tr>
                                <td colSpan={9} className="px-4 py-10 text-center">
                                    <Package className="w-12 h-12 ui-text-muted mx-auto mb-3" />
                                    <p className="ui-text-muted">Pilih kategori untuk melihat operator</p>
                                </td>
                            </tr>
                        ) : filteredOperators.length === 0 ? (
                            <tr>
                                <td colSpan={9} className="px-4 py-10 text-center">
                                    <Package className="w-12 h-12 ui-text-muted mx-auto mb-3" />
                                    <p className="ui-text-muted font-semibold">
                                        {activeCategoryOperators.length === 0 ? 'Belum ada operator untuk kategori ini' : 'Tidak ada operator yang cocok'}
                                    </p>
                                    <p className="ui-text-muted text-sm mt-1">
                                        {activeCategoryOperators.length === 0 ? 'Klik "Tambah Operator" untuk menambahkan' : 'Coba ubah keyword pencarian atau filter status.'}
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
                                    items={filteredOperators.map((operator) => operator._id)}
                                    strategy={verticalListSortingStrategy}
                                >
                                    {filteredOperators.map((operator, idx) => (
                                        <SortableOperatorRow
                                            key={operator._id}
                                            operator={operator}
                                            displayOrder={canReorder ? idx + 1 : operator.sortOrder || idx + 1}
                                            validationLabel={validationLabelForOperator(operator)}
                                            dragDisabled={!canReorder || reordering}
                                            actionDisabled={busy}
                                            toggling={togglingId === operator._id}
                                            onEdit={handleOpenForm}
                                            onToggleStatus={handleToggleStatus}
                                            onDelete={(selected) => {
                                                setSelectedOperator(selected);
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

            {/* Delete Confirmation Modal */}
            {showDeleteModal && selectedOperator && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
                    <div className="ui-panel-muted border ui-border rounded-xl shadow-xl w-full max-w-sm mx-4 p-6" role="dialog" aria-modal="true" aria-labelledby="delete-operator-title">
                        <div className="text-center">
                            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full border ui-danger-chip">
                                <Trash2 className="w-6 h-6 ui-danger-text" />
                            </div>
                            <h3 id="delete-operator-title" className="text-lg font-semibold ui-text mb-2">Hapus Operator?</h3>
                            <p className="ui-text-muted mb-6">
                                Anda yakin ingin menghapus operator "<span className="font-medium ui-text">{selectedOperator.name}</span>"?
                                {selectedDependencyTotal > 0 && (
                                    <span className="block mt-2 ui-danger-text text-sm">
                                        Operator ini masih dipakai oleh:
                                        <span className="block mt-1">
                                            {selectedOperator.directProductCount || 0} produk, {selectedOperator.productTypeCount || 0} tipe produk.
                                        </span>
                                        {(selectedOperator.legacyProductCount || 0) > 0 && (
                                            <span className="block mt-1 ui-warning-text">
                                                {selectedOperator.legacyProductCount} referensi legacy belum memakai `operatorId`.
                                            </span>
                                        )}
                                        <span className="block mt-1">Hapus tidak tersedia. Nonaktifkan operator jika ingin menyembunyikannya dari katalog.</span>
                                    </span>
                                )}
                            </p>
                            <div className="flex gap-3">
                                <button
                                    onClick={() => {
                                        setShowDeleteModal(false);
                                        setSelectedOperator(null);
                                    }}
                                    className="flex-1 px-4 py-2 border ui-border ui-text-muted rounded-lg hover:bg-[var(--ui-card-muted)] transition-colors"
                                >
                                    Batal
                                </button>
                                <button
                                    onClick={handleDelete}
                                    disabled={deleting || reordering || selectedDependencyTotal > 0 || selectedOperator.canDelete === false}
                                    aria-disabled={deleting || reordering || selectedDependencyTotal > 0 || selectedOperator.canDelete === false}
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
