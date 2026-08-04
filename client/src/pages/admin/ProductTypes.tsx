import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { apiV2 } from '../../api';
import { Plus, Edit2, Trash2, Power, AlertCircle, Package, Clock, GripVertical, Search, X } from 'lucide-react';
import {
    DndContext,
    KeyboardSensor,
    PointerSensor,
    closestCenter,
    useSensor,
    useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import {
    SortableContext,
    arrayMove,
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
    status?: boolean;
}

interface Operator {
    _id: string;
    name: string;
    slug: string;
    icon?: string;
    status?: boolean;
    categoryId: string | { _id: string };
}

interface ProductType {
    _id: string;
    typeId?: number;
    name: string;
    slug: string;
    categoryId: string | { _id: string; name: string; icon: string; status?: boolean };
    operatorId: string | { _id: string; name: string; icon?: string; status?: boolean };
    openTime: string;
    closeTime: string;
    open24Hours?: boolean;
    processType?: 'auto' | 'manual';
    sortOrder: number;
    status: boolean;
    productCount?: number;
    dependencyCount?: number;
    canDelete?: boolean;
    createdAt?: string;
    updatedAt?: string;
}

function SortableProductTypeRow({
    productType,
    displayOrder,
    dragDisabled,
    actionDisabled = false,
    toggling = false,
    onEdit,
    onToggleStatus,
    onDelete
}: {
    productType: ProductType;
    displayOrder: number;
    dragDisabled: boolean;
    actionDisabled?: boolean;
    toggling?: boolean;
    onEdit: (productType: ProductType) => void;
    onToggleStatus: (productType: ProductType) => void;
    onDelete: (productType: ProductType) => void;
}) {
    const {
        attributes,
        listeners,
        setNodeRef,
        transform,
        transition,
        isDragging,
    } = useSortable({ id: productType._id, disabled: dragDisabled });

    const style = {
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
        backgroundColor: isDragging ? 'var(--ui-card-muted)' : undefined,
    };

    const category = typeof productType.categoryId === 'object' ? productType.categoryId : null;
    const operator = typeof productType.operatorId === 'object' ? productType.operatorId : null;

    return (
        <tr ref={setNodeRef} style={style} className="hover:bg-[var(--ui-card-bg)]">
            <td className="px-4 py-3">
                <span className="text-sm font-mono ui-accent-text">#{productType.typeId || '-'}</span>
            </td>
            <td className="px-4 py-3 text-sm ui-text-muted">
                <div className="flex items-center gap-2">
                    <button
                        {...attributes}
                        {...listeners}
                        disabled={dragDisabled}
                        className={`touch-none rounded p-1 transition-colors ${dragDisabled ? 'cursor-not-allowed opacity-40' : 'cursor-grab active:cursor-grabbing hover:bg-[var(--ui-card-muted)]'}`}
                        title={dragDisabled ? 'Matikan filter untuk mengubah urutan' : 'Drag untuk mengubah urutan'}
                        aria-label={dragDisabled ? `Pengurutan ${productType.name} terkunci` : `Geser ${productType.name} untuk mengubah urutan`}
                    >
                        <GripVertical className="h-4 w-4 ui-text-muted" />
                    </button>
                    {displayOrder}
                </div>
            </td>
            <td className="px-4 py-3">
                <div>
                    <span className="text-sm font-semibold ui-text">{productType.name}</span>
                    <p className="text-xs font-mono ui-text-muted">{productType.slug}</p>
                </div>
            </td>
            <td className="px-4 py-3 text-sm ui-text-muted">
                <div className="space-y-1">
                    <span className="inline-flex rounded-full ui-panel-muted px-2 py-1 text-xs font-medium ui-text">
                        {productType.productCount || 0} produk
                    </span>
                    <p className="text-[11px] ui-text-muted">
                        {productType.canDelete === false ? 'Masih dipakai produk terkait' : 'Aman dihapus jika tidak dipakai'}
                    </p>
                </div>
            </td>
            <td className="px-4 py-3 text-sm ui-text-muted">
                <div className="flex items-center gap-1">
                    {category?.icon && <span>{category.icon}</span>}
                    <span>{category?.name || '-'}</span>
                </div>
                <div className="mt-1 flex items-center gap-1 text-xs ui-text-muted">
                    {operator?.icon && <OperatorIcon icon={operator.icon} size="sm" />}
                    <span>{operator?.name || '-'}</span>
                </div>
            </td>
            <td className="px-4 py-3 text-sm ui-text-muted">
                <div className="inline-flex items-center gap-1 ui-info-text">
                    <Clock className="h-4 w-4" />
                    <span>{productType.open24Hours ? '24 Jam' : `${productType.openTime} - ${productType.closeTime}`}</span>
                </div>
                <p className="mt-1 text-xs ui-text-muted">
                    Proses: {productType.processType === 'manual' ? 'Manual' : 'Otomatis'}
                </p>
            </td>
            <td className="px-4 py-3">
                <span className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-semibold ${productType.status ? 'ui-success-chip' : 'ui-panel-muted ui-text-muted'}`}>
                    {productType.status ? 'Aktif' : 'Nonaktif'}
                </span>
            </td>
            <td className="px-4 py-3 text-xs ui-text-muted whitespace-nowrap">
                {productType.createdAt ? new Date(productType.createdAt).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) : '-'}
            </td>
            <td className="px-4 py-3 text-xs ui-text-muted whitespace-nowrap">
                {productType.updatedAt ? new Date(productType.updatedAt).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) : '-'}
            </td>
            <td className="px-4 py-3">
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => onEdit(productType)}
                        disabled={actionDisabled}
                        className="ui-info-chip rounded-lg p-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                        title="Edit"
                        aria-label={`Edit jenis produk ${productType.name}`}
                    >
                        <Edit2 className="h-4 w-4" />
                    </button>
                    <button
                        onClick={() => onToggleStatus(productType)}
                        disabled={actionDisabled || toggling}
                        className={`rounded-lg p-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${productType.status ? 'ui-accent-text hover:bg-[var(--ui-accent-soft)] hover:text-[var(--ui-accent-strong)]' : 'ui-success-action'}`}
                        title={productType.status ? 'Nonaktifkan' : 'Aktifkan'}
                        aria-label={`${productType.status ? 'Nonaktifkan' : 'Aktifkan'} jenis produk ${productType.name}`}
                    >
                        {toggling ? <div className="h-4 w-4 rounded-full border-2 border-current border-t-transparent animate-spin" /> : <Power className="h-4 w-4" />}
                    </button>
                    <button
                        onClick={() => onDelete(productType)}
                        disabled={actionDisabled}
                        className="ui-danger-action rounded-lg p-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                        title="Hapus"
                        aria-label={`Hapus jenis produk ${productType.name}`}
                    >
                        <Trash2 className="h-4 w-4" />
                    </button>
                </div>
            </td>
        </tr>
    );
}

export default function ProductTypes() {
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();
    const [categories, setCategories] = useState<Category[]>([]);
    const [operators, setOperators] = useState<Operator[]>([]);
    const [productTypes, setProductTypes] = useState<ProductType[]>([]);
    const [loading, setLoading] = useState(true);
    const [activeCategory, setActiveCategory] = useState<string>(() => searchParams.get('category') || '');
    const [activeOperator, setActiveOperator] = useState<string>(() => searchParams.get('operator') || '');
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [selectedType, setSelectedType] = useState<ProductType | null>(null);
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
            const [categoriesRes, operatorsRes, typesRes] = await Promise.all([
                apiV2.get('/categories/admin/all'),
                apiV2.get('/operators/admin/all'),
                apiV2.get('/product-types/admin/all')
            ]);
            if (requestId !== latestRequestId.current) return;
            setCategories(categoriesRes.data);
            setOperators(operatorsRes.data);
            setProductTypes(typesRes.data || []);
            setActiveCategory((currentCategory) => {
                if (currentCategory && categoriesRes.data.some((category: Category) => category._id === currentCategory)) {
                    return currentCategory;
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
            setMessage({ type: 'error', text: 'Gagal memuat data jenis produk' });
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
        if (activeCategory) params.set('category', activeCategory); else params.delete('category');
        if (activeOperator) params.set('operator', activeOperator); else params.delete('operator');
        if (search.trim()) params.set('search', search.trim()); else params.delete('search');
        if (statusFilter !== 'all') params.set('status', statusFilter); else params.delete('status');
        setSearchParams(params, { replace: true });
    }, [activeCategory, activeOperator, search, statusFilter, searchParams, setSearchParams]);

    const getCategoryId = (item?: Operator | ProductType | null): string => {
        if (!item) return '';
        const category = (item as any).categoryId;
        if (category && typeof category === 'object') {
            return category._id || '';
        }
        return category || '';
    };

    const getOperatorId = (item?: ProductType | null): string => {
        if (!item) return '';
        const operator = (item as any).operatorId;
        if (operator && typeof operator === 'object') {
            return operator._id || '';
        }
        return operator || '';
    };

    const categoryTypeCountMap = useMemo(() => {
        return productTypes.reduce((map, productType) => {
            const categoryId = getCategoryId(productType);
            map.set(categoryId, (map.get(categoryId) || 0) + 1);
            return map;
        }, new Map<string, number>());
    }, [productTypes]);

    const operatorTypeCountMap = useMemo(() => {
        return productTypes.reduce((map, productType) => {
            const operatorId = getOperatorId(productType);
            map.set(operatorId, (map.get(operatorId) || 0) + 1);
            return map;
        }, new Map<string, number>());
    }, [productTypes]);

    const filteredOperators = useMemo(() => {
        if (!activeCategory) return operators.filter(Boolean);
        return operators.filter((operator) => operator && getCategoryId(operator) === activeCategory);
    }, [operators, activeCategory]);

    useEffect(() => {
        if (filteredOperators.length > 0 && !filteredOperators.find((operator) => operator._id === activeOperator)) {
            setActiveOperator(filteredOperators[0]._id);
        } else if (filteredOperators.length === 0) {
            setActiveOperator('');
        }
    }, [filteredOperators, activeOperator]);

    const activeOperatorTypes = useMemo(() => {
        if (!activeOperator) return [];
        return productTypes.filter((productType) => productType && getOperatorId(productType) === activeOperator);
    }, [productTypes, activeOperator]);

    const filteredTypes = useMemo(() => {
        const keyword = search.trim().toLowerCase();
        return activeOperatorTypes.filter((productType) => {
            const matchesSearch = keyword.length === 0
                || productType.name.toLowerCase().includes(keyword)
                || productType.slug.toLowerCase().includes(keyword)
                || String(productType.typeId || '').includes(keyword);
            const matchesStatus = statusFilter === 'all'
                || (statusFilter === 'active' ? productType.status : !productType.status);

            return matchesSearch && matchesStatus;
        });
    }, [activeOperatorTypes, search, statusFilter]);

    const canReorder = Boolean(activeOperator) && search.trim().length === 0 && statusFilter === 'all';
    const activeStats = useMemo(() => activeOperatorTypes.reduce((stats, productType) => ({
        productCount: stats.productCount + (productType.productCount || 0),
        manualCount: stats.manualCount + (productType.processType === 'manual' ? 1 : 0),
        open24Count: stats.open24Count + (productType.open24Hours ? 1 : 0),
        activeCount: stats.activeCount + (productType.status ? 1 : 0),
        inactiveCount: stats.inactiveCount + (productType.status ? 0 : 1),
    }), { productCount: 0, manualCount: 0, open24Count: 0, activeCount: 0, inactiveCount: 0 }), [activeOperatorTypes]);
    const activeProductCount = activeStats.productCount;
    const activeManualCount = activeStats.manualCount;
    const activeOpen24Count = activeStats.open24Count;
    const selectedDependencyTotal = selectedType?.dependencyCount ?? selectedType?.productCount ?? 0;
    const busy = loading || reordering || deleting || Boolean(togglingId);

    const listQuery = () => {
        const params = new URLSearchParams();
        if (activeCategory) params.set('category', activeCategory);
        if (activeOperator) params.set('operator', activeOperator);
        if (search.trim()) params.set('search', search.trim());
        if (statusFilter !== 'all') params.set('status', statusFilter);
        const query = params.toString();
        return query ? `?${query}` : '';
    };

    const handleDragEnd = async (event: DragEndEvent) => {
        if (!canReorder || reordering || reorderInFlight.current || deleting || togglingId) {
            return;
        }

        const { active, over } = event;
        if (!over || active.id === over.id) {
            return;
        }

        const oldIndex = activeOperatorTypes.findIndex((productType) => productType._id === active.id);
        const newIndex = activeOperatorTypes.findIndex((productType) => productType._id === over.id);
        if (oldIndex === -1 || newIndex === -1) {
            return;
        }

        const reorderedActiveTypes = arrayMove(activeOperatorTypes, oldIndex, newIndex).map((productType, index) => ({
            ...productType,
            sortOrder: index + 1
        }));

        const reorderedIds = new Set(reorderedActiveTypes.map((productType) => productType._id));
        const untouchedTypes = productTypes.filter((productType) => !reorderedIds.has(productType._id));
        setProductTypes([...untouchedTypes, ...reorderedActiveTypes]);

        try {
            reorderInFlight.current = true;
            setReordering(true);
            const orders = reorderedActiveTypes.map((productType, index) => ({
                id: productType._id,
                sortOrder: index + 1
            }));
            await apiV2.put('/product-types/admin/sort-order', { operatorId: activeOperator, orders });
            setMessage({ type: 'success', text: 'Urutan jenis produk berhasil diperbarui' });
        } catch (error) {
            console.error('Failed to update product type sort order', error);
            setMessage({ type: 'error', text: 'Gagal menyimpan urutan jenis produk' });
            await fetchData();
        } finally {
            reorderInFlight.current = false;
            setReordering(false);
        }
    };

    const handleDelete = async () => {
        if (!selectedType || deleting || reordering) return;

        try {
            setDeleting(true);
            await apiV2.delete(`/product-types/admin/${selectedType._id}`);
            setMessage({ type: 'success', text: 'Jenis produk berhasil dihapus' });
            setShowDeleteModal(false);
            setSelectedType(null);
            await fetchData();
        } catch (error: any) {
            const dependencies = error.response?.data?.dependencies;
            if (dependencies && selectedType) {
                setSelectedType({
                    ...selectedType,
                    ...dependencies
                });
            }
            setMessage({ type: 'error', text: error.response?.data?.message || 'Gagal menghapus jenis produk' });
        } finally {
            setDeleting(false);
        }
    };

    const handleToggleStatus = async (productType: ProductType) => {
        if (togglingId || reordering || deleting) return;
        if (productType.status && (productType.productCount || 0) > 0) {
            const ok = window.confirm(`Jenis produk ini masih dipakai oleh ${productType.productCount || 0} produk terkait. Menonaktifkan jenis produk dapat menyembunyikan katalog terkait. Lanjutkan?`);
            if (!ok) return;
        }

        try {
            setTogglingId(productType._id);
            await apiV2.put(`/product-types/admin/${productType._id}`, { status: !productType.status });
            setMessage({ type: 'success', text: `Jenis produk ${!productType.status ? 'diaktifkan' : 'dinonaktifkan'}` });
            await fetchData();
        } catch (error: any) {
            setMessage({ type: 'error', text: error.response?.data?.message || 'Gagal mengubah status' });
        } finally {
            setTogglingId(null);
        }
    };

    useEffect(() => {
        if (message?.type === 'success') {
            const timer = setTimeout(() => setMessage(null), 3000);
            return () => clearTimeout(timer);
        }
    }, [message]);

    const activeCategoryData = categories.find((category) => category._id === activeCategory);
    const activeOperatorData = operators.find((operator) => operator._id === activeOperator);

    return (
        <div className="space-y-5">
            <div className="ui-panel-muted border ui-border rounded-xl p-4 flex flex-wrap items-center gap-3">
                <button
                    onClick={() => navigate(`/admin/product-types/create${listQuery()}`)}
                    disabled={!activeOperator}
                    className="inline-flex items-center gap-2 rounded-xl ui-accent-solid px-4 py-2.5 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                >
                    <Plus className="h-4 w-4" />
                    Tambah Jenis Produk
                </button>
                <div className="flex items-center gap-2 rounded-xl border ui-border ui-panel px-3 py-2 text-xs uppercase tracking-[0.14em] ui-text-muted">
                    <GripVertical className="h-4 w-4 ui-accent-text" />
                    drag rows
                </div>
            </div>

            {message && (
                <div className={`flex items-center gap-2 rounded-lg border p-4 ${message.type === 'success' ? 'ui-success-chip' : 'ui-danger-chip'}`} role="alert" aria-live="polite">
                    <AlertCircle className="h-5 w-5" />
                    <span className="flex-1">{message.text}</span>
                    {message.type === 'error' && (
                        <button type="button" onClick={() => setMessage(null)} className="rounded-lg p-1 hover:bg-[var(--ui-card-muted)]" aria-label="Tutup pesan">
                            <X className="h-4 w-4" />
                        </button>
                    )}
                </div>
            )}

            <div className="flex items-start gap-2 rounded-lg border ui-border ui-panel-muted p-4 text-sm ui-text">
                <GripVertical className="mt-0.5 h-5 w-5 flex-shrink-0 ui-text-muted" />
                <div>
                    <p className="font-medium ui-text">Tips Pengurutan</p>
                    <p className="ui-text-muted">Urutan jenis produk berlaku per operator. Gunakan drag hanya saat filter mati agar urutan tersimpan dengan benar.</p>
                    {!canReorder && activeOperator && (
                        <p className="mt-2 ui-warning-text">Filter aktif. Matikan filter jika ingin mengubah urutan jenis produk.</p>
                    )}
                </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-xl border ui-border ui-panel-muted p-4">
                    <p className="text-sm ui-text-muted">Jenis di Operator</p>
                    <p className="mt-2 text-2xl font-bold ui-text">{activeOperatorTypes.length}</p>
                    <p className="mt-1 text-xs ui-text-muted">{filteredTypes.length} tampil sesuai filter</p>
                </div>
                <div className="rounded-xl border ui-border ui-panel-muted p-4">
                    <p className="text-sm ui-text-muted">Status Jenis</p>
                    <p className="mt-2 text-2xl font-bold ui-success-text">{activeStats.activeCount}</p>
                    <p className="mt-1 text-xs ui-text-muted">{activeStats.inactiveCount} nonaktif</p>
                </div>
                <div className="rounded-xl border ui-border ui-panel-muted p-4">
                    <p className="text-sm ui-text-muted">Produk Terkait</p>
                    <p className="mt-2 text-2xl font-bold ui-text">{activeProductCount}</p>
                    <p className="mt-1 text-xs ui-text-muted">Produk memakai jenis di operator aktif</p>
                </div>
                <div className="rounded-xl border ui-border ui-panel-muted p-4">
                    <p className="text-sm ui-text-muted">Operasional</p>
                    <p className="mt-2 text-2xl font-bold ui-text">{activeOpen24Count}</p>
                    <p className="mt-1 text-xs ui-text-muted">{activeManualCount} jenis proses manual</p>
                </div>
            </div>

            <div className="overflow-hidden rounded-xl border ui-border ui-panel-muted">
                <div className="overflow-x-auto">
                    <div className="flex min-w-full border-b ui-border ui-panel">
                        {loading ? (
                            <div className="px-4 py-3 text-sm ui-text-muted">Memuat kategori...</div>
                        ) : categories.length === 0 ? (
                            <div className="px-4 py-3 text-sm ui-text-muted">
                                Belum ada kategori. <Link to="/admin/product-categories" className="ui-accent-text hover:underline">Tambah kategori</Link> terlebih dahulu.
                            </div>
                        ) : (
                            categories.map((category) => (
                                <button
                                    key={category._id}
                                    disabled={busy}
                                    onClick={() => setActiveCategory(category._id)}
                                    className={`flex items-center gap-2 whitespace-nowrap border-r ui-border px-4 py-3 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${activeCategory === category._id ? 'ui-accent-chip ui-accent-text' : 'ui-text-muted hover:bg-[var(--ui-card-muted)]'}`}
                                >
                                    <span>{category.icon}</span>
                                    <span>{category.name}</span>
                                    <span className="rounded-full ui-panel-muted px-2 py-0.5 text-[11px] ui-text-muted">
                                        {categoryTypeCountMap.get(category._id) || 0}
                                    </span>
                                </button>
                            ))
                        )}
                    </div>
                </div>

                <div className="flex flex-wrap gap-2 border-b ui-border px-4 py-3">
                    {filteredOperators.length === 0 ? (
                        <p className="text-sm ui-text-muted">
                            Belum ada operator untuk kategori ini. <Link to={`/admin/product-operators?category=${activeCategory}`} className="ui-accent-text hover:underline">Tambah operator</Link> terlebih dahulu.
                        </p>
                    ) : (
                        filteredOperators.map((operator) => (
                            <button
                                key={operator._id}
                                disabled={busy}
                                onClick={() => setActiveOperator(operator._id)}
                                className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${activeOperator === operator._id ? 'border-[var(--ui-accent)]/40 ui-accent-chip ui-accent-text' : 'ui-border ui-text-muted hover:bg-[var(--ui-card-muted)]'}`}
                            >
                                {operator.icon && <OperatorIcon icon={operator.icon} size="sm" />}
                                <span>{operator.name}</span>
                                <span className="rounded-full ui-panel-muted px-2 py-0.5 text-[11px] ui-text-muted">
                                    {operatorTypeCountMap.get(operator._id) || 0}
                                </span>
                            </button>
                        ))
                    )}
                </div>

                {activeCategoryData && activeOperatorData && (
                    <div className="flex items-center gap-2 border-b ui-border px-4 py-2 text-sm ui-text-muted">
                        <span className="text-lg">{activeCategoryData.icon}</span>
                        <span>{activeCategoryData.name}</span>
                        <span className="ui-text-muted">→</span>
                        {activeOperatorData.icon && <OperatorIcon icon={activeOperatorData.icon} size="sm" />}
                        <span className="font-medium ui-text">{activeOperatorData.name}</span>
                        <span className="ui-text-muted">|</span>
                        <span>{activeOperatorTypes.length} jenis</span>
                    </div>
                )}

                <div className="flex flex-col gap-3 border-b ui-border px-4 py-4 lg:flex-row lg:items-center lg:justify-between">
                    <div className="relative w-full max-w-md">
                        <label htmlFor="product-type-search" className="sr-only">Cari jenis produk</label>
                        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 ui-text-muted" />
                        <input
                            id="product-type-search"
                            type="text"
                            value={search}
                            disabled={reordering}
                            onChange={(event) => setSearch(event.target.value)}
                            placeholder="Cari nama atau slug jenis produk..."
                            className="w-full rounded-xl border ui-border ui-panel py-2.5 pl-10 pr-4 text-sm ui-text placeholder:ui-text-muted focus:border-[var(--ui-accent)] focus:outline-none"
                        />
                    </div>
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                        <label htmlFor="product-type-status-filter" className="sr-only">Filter status jenis produk</label>
                        <select
                            id="product-type-status-filter"
                            value={statusFilter}
                            disabled={reordering}
                            onChange={(event) => setStatusFilter(event.target.value as 'all' | 'active' | 'inactive')}
                            className="rounded-xl border ui-border ui-panel px-4 py-2.5 text-sm ui-text focus:border-[var(--ui-accent)] focus:outline-none"
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

                <table className="min-w-full">
                    <thead>
                        <tr className="ui-panel text-xs uppercase ui-text-muted">
                            <th className="w-16 px-4 py-3 text-left font-semibold">#ID</th>
                            <th className="w-16 px-4 py-3 text-left font-semibold">#</th>
                            <th className="px-4 py-3 text-left font-semibold">Nama Jenis</th>
                            <th className="px-4 py-3 text-left font-semibold">Dependensi</th>
                            <th className="px-4 py-3 text-left font-semibold">Kategori / Operator</th>
                            <th className="px-4 py-3 text-left font-semibold">Jam Operasional</th>
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
                                        <div className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--ui-border)] border-t-[var(--ui-accent)]" />
                                        Memuat data...
                                    </div>
                                </td>
                            </tr>
                        ) : !activeOperator ? (
                            <tr>
                                <td colSpan={10} className="px-4 py-10 text-center">
                                    <Package className="mx-auto mb-3 h-12 w-12 ui-text-muted" />
                                    <p className="ui-text-muted">Pilih operator untuk melihat jenis produk</p>
                                </td>
                            </tr>
                        ) : filteredTypes.length === 0 ? (
                            <tr>
                                <td colSpan={10} className="px-4 py-10 text-center">
                                    <Package className="mx-auto mb-3 h-12 w-12 ui-text-muted" />
                                    <p className="font-semibold ui-text-muted">
                                        {activeOperatorTypes.length === 0 ? 'Belum ada jenis produk untuk operator ini' : 'Tidak ada jenis produk yang cocok'}
                                    </p>
                                    <p className="mt-1 text-sm ui-text-muted">
                                        {activeOperatorTypes.length === 0 ? 'Klik "Tambah Jenis Produk" untuk menambahkan' : 'Coba ubah keyword pencarian atau filter status.'}
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
                                    items={filteredTypes.map((productType) => productType._id)}
                                    strategy={verticalListSortingStrategy}
                                >
                                    {filteredTypes.map((productType, index) => (
                                        <SortableProductTypeRow
                                            key={productType._id}
                                            productType={productType}
                                            displayOrder={canReorder ? index + 1 : productType.sortOrder || index + 1}
                                            dragDisabled={!canReorder || reordering}
                                            actionDisabled={busy}
                                            toggling={togglingId === productType._id}
                                            onEdit={(selected) => navigate(`/admin/product-types/edit/${selected._id}${listQuery()}`)}
                                            onToggleStatus={handleToggleStatus}
                                            onDelete={(selected) => {
                                                setSelectedType(selected);
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

            {showDeleteModal && selectedType && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
                    <div className="mx-4 w-full max-w-sm rounded-xl border ui-border ui-panel-muted p-6 shadow-xl" role="dialog" aria-modal="true" aria-labelledby="delete-product-type-title">
                        <div className="text-center">
                            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full border ui-danger-chip">
                                <Trash2 className="h-6 w-6 ui-danger-text" />
                            </div>
                            <h3 id="delete-product-type-title" className="mb-2 text-lg font-semibold ui-text">Hapus Jenis Produk?</h3>
                            <p className="mb-6 ui-text-muted">
                                Anda yakin ingin menghapus jenis produk "<span className="font-medium ui-text">{selectedType.name}</span>"?
                                {selectedDependencyTotal > 0 && (
                                    <span className="mt-2 block text-sm ui-danger-text">
                                        Jenis produk ini masih dipakai oleh {selectedType.productCount || selectedDependencyTotal} produk.
                                        <span className="mt-1 block">Hapus tidak tersedia. Nonaktifkan jenis produk jika ingin menyembunyikannya dari katalog.</span>
                                    </span>
                                )}
                            </p>
                            <div className="flex gap-3">
                                <button
                                    onClick={() => {
                                        setShowDeleteModal(false);
                                        setSelectedType(null);
                                    }}
                                    className="flex-1 rounded-lg border ui-border px-4 py-2 ui-text-muted transition-colors hover:bg-[var(--ui-card-muted)]"
                                >
                                    Batal
                                </button>
                                <button
                                    onClick={handleDelete}
                                    disabled={deleting || reordering || selectedDependencyTotal > 0 || selectedType.canDelete === false}
                                    className="ui-danger-action flex-1 rounded-lg border px-4 py-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
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
