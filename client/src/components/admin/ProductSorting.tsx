import { useState, useEffect, useCallback } from 'react';
import { X, GripVertical, ArrowUpDown, Loader2, ArrowLeft, Check } from 'lucide-react';
import { apiV2 } from '../../api';

interface Category {
    _id: string;
    name: string;
}

interface Operator {
    _id: string;
    name: string;
    categoryId: string;
}

interface ProductType {
    _id: string;
    name: string;
    operatorId: string;
    categoryId?: string;
}

interface SortProduct {
    _id: string;
    code: string;
    name: string;
    price: {
        basic: number;
        gold: number;
        platinum: number;
    };
    sortOrder: number;
    status: boolean;
}

interface ProductSortingProps {
    isOpen: boolean;
    onClose: () => void;
    categories: Category[];
    operators: Operator[];
    productTypes: ProductType[];
}

export default function ProductSorting({ isOpen, onClose, categories, operators, productTypes }: ProductSortingProps) {
    const [selectedCategory, setSelectedCategory] = useState('');
    const [selectedOperator, setSelectedOperator] = useState('');
    const [selectedProductType, setSelectedProductType] = useState('');
    
    const [products, setProducts] = useState<SortProduct[]>([]);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    
    const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
    const [hasChanges, setHasChanges] = useState(false);

    const filteredOperators = operators.filter(o => !selectedCategory || o.categoryId === selectedCategory);
    const filteredProductTypes = productTypes.filter(pt => {
        const matchCat = !selectedCategory || pt.categoryId === selectedCategory;
        const matchOp = !selectedOperator || pt.operatorId === selectedOperator;
        return matchCat && matchOp;
    });

    const fetchProducts = useCallback(async () => {
        if (!selectedCategory && !selectedOperator && !selectedProductType) {
            setProducts([]);
            return;
        }

        setLoading(true);
        try {
            const params = new URLSearchParams();
            if (selectedCategory) params.set('categoryId', selectedCategory);
            if (selectedOperator) params.set('operatorId', selectedOperator);
            if (selectedProductType) params.set('productTypeId', selectedProductType);

            const path = `/products/admin/sorting?${params.toString()}`;
            const res = await apiV2.get(path);
            setProducts(res.data || []);
            setHasChanges(false);
        } catch (error) {
            console.error('Failed to fetch products', error);
            setMessage({ type: 'error', text: 'Gagal memuat produk' });
        } finally {
            setLoading(false);
        }
    }, [selectedCategory, selectedOperator, selectedProductType]);

    useEffect(() => {
        if (isOpen && (selectedCategory || selectedOperator || selectedProductType)) {
            fetchProducts();
        }
    }, [isOpen, fetchProducts, selectedCategory, selectedOperator, selectedProductType]);

    useEffect(() => {
        if (message) {
            const timer = setTimeout(() => setMessage(null), 3000);
            return () => clearTimeout(timer);
        }
    }, [message]);

    const handleCategoryChange = (value: string) => {
        setSelectedCategory(value);
        setSelectedOperator('');
        setSelectedProductType('');
        setProducts([]);
    };

    const handleOperatorChange = (value: string) => {
        setSelectedOperator(value);
        setSelectedProductType('');
        setProducts([]);
    };

    const handleProductTypeChange = (value: string) => {
        setSelectedProductType(value);
    };

    const handleDragStart = (index: number) => {
        setDraggedIndex(index);
    };

    const handleDragOver = (e: React.DragEvent, index: number) => {
        e.preventDefault();
        if (draggedIndex === null || draggedIndex === index) return;

        const newProducts = [...products];
        const draggedItem = newProducts[draggedIndex];
        newProducts.splice(draggedIndex, 1);
        newProducts.splice(index, 0, draggedItem);
        
        setProducts(newProducts);
        setDraggedIndex(index);
        setHasChanges(true);
    };

    const handleDragEnd = () => {
        setDraggedIndex(null);
    };

    const handleSortByPrice = async (order: 'asc' | 'desc') => {
        if (!selectedProductType && !selectedOperator && !selectedCategory) {
            setMessage({ type: 'error', text: 'Pilih filter terlebih dahulu' });
            return;
        }

        setSaving(true);
        try {
            const payload = {
                categoryId: selectedCategory || undefined,
                operatorId: selectedOperator || undefined,
                productTypeId: selectedProductType || undefined,
                order
            };
            await apiV2
                .post('/products/admin/sort-by-price', payload);
            setMessage({ type: 'success', text: 'Produk berhasil diurutkan berdasarkan harga' });
            fetchProducts();
        } catch (error) {
            console.error('Failed to sort by price', error);
            setMessage({ type: 'error', text: 'Gagal mengurutkan produk' });
        } finally {
            setSaving(false);
        }
    };

    const handleSave = async () => {
        if (products.length === 0) return;

        setSaving(true);
        try {
            const updates = products.map((p, index) => ({
                _id: p._id,
                sortOrder: index + 1
            }));

            await apiV2
                .post('/products/admin/sort-order', { products: updates });
            setMessage({ type: 'success', text: 'Urutan produk berhasil disimpan' });
            setHasChanges(false);
        } catch (error) {
            console.error('Failed to save sort order', error);
            setMessage({ type: 'error', text: 'Gagal menyimpan urutan' });
        } finally {
            setSaving(false);
        }
    };

    const getSelectionLabel = () => {
        const parts: string[] = [];
        if (selectedCategory) {
            const cat = categories.find(c => c._id === selectedCategory);
            if (cat) parts.push(cat.name);
        }
        if (selectedOperator) {
            const op = operators.find(o => o._id === selectedOperator);
            if (op) parts.push(op.name);
        }
        if (selectedProductType) {
            const pt = productTypes.find(p => p._id === selectedProductType);
            if (pt) parts.push(pt.name);
        }
        return parts.join(' / ') || 'Pilih filter di bawah';
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[60] overflow-y-auto bg-[var(--ui-bg)]">
            <div className="min-h-screen">
                {/* Header */}
                <div className="sticky top-0 z-10 ui-panel border-b ui-border px-4 py-4">
                    <div className="max-w-6xl mx-auto flex items-center justify-between">
                        <div className="flex items-center gap-4">
                            <button
                                onClick={onClose}
                                className="flex items-center gap-2 ui-text-muted hover:text-[var(--ui-text)] transition-colors"
                            >
                                <ArrowLeft className="w-5 h-5" />
                                <span className="font-medium">Kembali</span>
                            </button>
                            <div>
                                <h2 className="text-xl font-bold ui-text flex items-center gap-2">
                                    <ArrowUpDown className="w-5 h-5 ui-accent-text" />
                                    Sorting Produk
                                </h2>
                                <p className="text-sm ui-text-muted mt-0.5">{getSelectionLabel()}</p>
                            </div>
                        </div>
                        <div className="flex items-center gap-3">
                            {message && (
                                <div className={`px-4 py-2 rounded-lg border text-sm font-medium ${message.type === 'success' ? 'ui-success-chip' : 'ui-danger-chip'}`}>
                                    {message.text}
                                </div>
                            )}
                            {hasChanges && (
                                <button
                                    onClick={handleSave}
                                    disabled={saving}
                                    className="px-4 py-2 ui-accent-solid rounded-lg font-medium text-sm flex items-center gap-2 disabled:opacity-50"
                                >
                                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                                    Simpan Urutan
                                </button>
                            )}
                        </div>
                    </div>
                </div>

                <div className="max-w-6xl mx-auto px-4 py-6">
                    {/* Filter Selection */}
                    <div className="ui-panel-muted rounded-xl border ui-border p-4 mb-6">
                        <label className="block text-xs font-medium ui-text-muted mb-2 uppercase tracking-wide">Pilih Jenis</label>
                        <div className="flex flex-wrap items-center gap-2">
                            <select
                                value={selectedCategory}
                                onChange={(e) => handleCategoryChange(e.target.value)}
                                className="flex-1 min-w-[150px] px-3 py-2.5 rounded-lg border ui-field text-sm"
                            >
                                <option value="">Pilih Kategori</option>
                                {categories.map(c => (
                                    <option key={c._id} value={c._id}>{c.name}</option>
                                ))}
                            </select>

                            <span className="ui-text-muted">/</span>

                            <select
                                value={selectedOperator}
                                onChange={(e) => handleOperatorChange(e.target.value)}
                                disabled={!selectedCategory}
                                className="flex-1 min-w-[150px] px-3 py-2.5 rounded-lg border ui-field text-sm disabled:opacity-50"
                            >
                                <option value="">Pilih Operator</option>
                                {filteredOperators.map(o => (
                                    <option key={o._id} value={o._id}>{o.name}</option>
                                ))}
                            </select>

                            <span className="ui-text-muted">/</span>

                            <select
                                value={selectedProductType}
                                onChange={(e) => handleProductTypeChange(e.target.value)}
                                disabled={!selectedOperator}
                                className="flex-1 min-w-[150px] px-3 py-2.5 rounded-lg border ui-field text-sm disabled:opacity-50"
                            >
                                <option value="">Pilih Tipe Produk</option>
                                {filteredProductTypes.map(pt => (
                                    <option key={pt._id} value={pt._id}>{pt.name}</option>
                                ))}
                            </select>

                            <button
                                onClick={() => {
                                    setSelectedCategory('');
                                    setSelectedOperator('');
                                    setSelectedProductType('');
                                    setProducts([]);
                                }}
                                className="p-2.5 ui-text-muted hover:text-[var(--ui-text)] hover:bg-[var(--ui-card-muted)] rounded-lg transition-colors"
                                title="Reset Filter"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>
                    </div>

                    {/* Info & Auto-sort */}
                    {products.length > 0 && (
                        <div className="flex items-center justify-between mb-4">
                            <p className="text-sm ui-text-muted">
                                <span className="ui-accent-text">*</span> Drag & drop untuk mengurutkan
                            </p>
                            <button
                                onClick={() => handleSortByPrice('asc')}
                                disabled={saving}
                                className="px-4 py-2 border ui-muted-action rounded-lg font-medium text-sm flex items-center gap-2 transition-colors disabled:opacity-50"
                            >
                                <ArrowUpDown className="w-4 h-4" />
                                Urutkan dari harga terkecil
                            </button>
                        </div>
                    )}

                    {/* Products Grid */}
                    {loading ? (
                        <div className="flex items-center justify-center py-20">
                            <Loader2 className="w-8 h-8 ui-accent-text animate-spin" />
                        </div>
                    ) : products.length === 0 ? (
                        <div className="text-center py-20 ui-text-muted">
                            <ArrowUpDown className="w-16 h-16 mx-auto mb-4 opacity-20" />
                            <p>Pilih kategori, operator, dan tipe produk untuk melihat daftar produk</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                            {products.map((product, index) => (
                                <div
                                    key={product._id}
                                    draggable
                                    onDragStart={() => handleDragStart(index)}
                                    onDragOver={(e) => handleDragOver(e, index)}
                                    onDragEnd={handleDragEnd}
                                    className={`relative ui-panel-muted border rounded-xl p-4 cursor-grab active:cursor-grabbing transition-all ${
                                        draggedIndex === index
                                            ? 'border-[var(--ui-accent)] bg-[var(--ui-accent-soft)] scale-105 shadow-lg'
                                            : 'ui-border hover:border-[var(--ui-accent)]'
                                    }`}
                                >
                                    {/* Order Number */}
                                    <div className="absolute top-2 left-2 w-6 h-6 rounded-full border ui-accent-chip text-xs font-bold flex items-center justify-center">
                                        {index + 1}
                                    </div>

                                    {/* Drag Handle */}
                                    <div className="absolute top-2 right-2 ui-text-muted">
                                        <GripVertical className="w-4 h-4" />
                                    </div>

                                    {/* Product Info */}
                                    <div className="mt-6">
                                        <h4 className="text-sm font-semibold ui-text line-clamp-2 mb-2">
                                            {product.name}
                                        </h4>
                                        
                                        {/* Price Tiers */}
                                        <div className="space-y-1 text-xs">
                                            <div className="flex justify-between">
                                                <span className="ui-text-muted">Basic</span>
                                                <span className="ui-accent-text">Rp{product.price.basic.toLocaleString('id-ID')}</span>
                                            </div>
                                            <div className="flex justify-between">
                                                <span className="ui-text-muted">Gold</span>
                                                <span className="ui-warning-text">Rp{product.price.gold.toLocaleString('id-ID')}</span>
                                            </div>
                                            <div className="flex justify-between">
                                                <span className="ui-text-muted">Platinum</span>
                                                <span className="ui-info-text">Rp{product.price.platinum.toLocaleString('id-ID')}</span>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
