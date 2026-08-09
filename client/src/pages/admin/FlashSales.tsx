import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AlertTriangle,
    Clock,
    Edit,
    Eye,
    EyeOff,
    Layers3,
    Package,
    Percent,
    Plus,
    Search,
    Sparkles,
    Trash2,
    TrendingUp,
    X,
    Zap
} from 'lucide-react';
import { apiV2 } from '../../api';
import ImagePickerField from '../../components/admin/ImagePickerField';

type StatusFilter = 'all' | 'live' | 'upcoming' | 'ended' | 'inactive' | 'issue';
type FlashSaleStatusKey = 'inactive' | 'upcoming' | 'live' | 'ended';

interface FlashSaleProductRef {
    _id: string;
    name: string;
    code: string;
    price: { basic: number; gold: number; platinum: number };
    icon?: string;
    costPrice?: number;
    status?: boolean;
}

interface FlashSaleProduct {
    productRefId?: string;
    productId: FlashSaleProductRef | null;
    discountType: 'percentage' | 'fixed';
    discountValue: number;
    stock: number;
    soldCount: number;
}

interface FlashSaleSummary {
    productCount: number;
    totalStock: number;
    soldCount: number;
    remainingStock: number;
    soldOutCount: number;
    lowStockCount: number;
    missingProductCount: number;
    inactiveProductCount: number;
    pricingIssueCount: number;
    overlapCount: number;
}

interface FlashSaleOverlap {
    productId: string;
    detail: string[];
}

interface FlashSale {
    _id: string;
    name: string;
    description?: string;
    startDate: string;
    endDate: string;
    products: FlashSaleProduct[];
    isActive: boolean;
    banner?: string;
    createdAt: string;
    statusKey?: FlashSaleStatusKey;
    statusLabel?: string;
    productCount?: number;
    summary?: FlashSaleSummary;
    overlappingProducts?: FlashSaleOverlap[];
    hasIssues?: boolean;
    canDelete?: boolean;
    deleteBlockedReason?: string;
}

interface Product {
    _id: string;
    name: string;
    code: string;
    price: { basic: number; gold: number; platinum: number };
    icon?: string;
    costPrice?: number;
    status: boolean;
}

interface FormData {
    name: string;
    description: string;
    startDate: string;
    endDate: string;
    isActive: boolean;
    banner: string;
}

interface ProductFormData {
    productId: string;
    flashPrice: number;
    stock: number;
}

interface SelectedProductItem {
    productId: string;
    productName: string;
    productCode: string;
    productPrice: number;
    flashPrice: number;
    stock: number;
}

const defaultForm: FormData = {
    name: '',
    description: '',
    startDate: '',
    endDate: '',
    isActive: true,
    banner: ''
};

const defaultProductForm: ProductFormData = {
    productId: '',
    flashPrice: 0,
    stock: 100
};

const inputClass = 'w-full rounded-lg ui-panel border ui-border px-3 py-2 text-sm ui-text placeholder-[var(--ui-text-muted)] focus:outline-none focus:border-[var(--ui-accent)]';
const labelClass = 'block text-sm font-medium ui-text-muted mb-1';

const statusAppearance: Record<
    FlashSaleStatusKey,
    { label: string; badgeClass: string; iconClass: string }
> = {
    inactive: {
        label: 'Nonaktif',
        badgeClass: 'ui-panel-muted ui-text-muted ui-border',
        iconClass: 'ui-text-muted ui-panel-muted'
    },
    upcoming: {
        label: 'Akan Datang',
        badgeClass: 'ui-info-chip',
        iconClass: 'ui-info-chip'
    },
    live: {
        label: 'Berlangsung',
        badgeClass: 'ui-success-chip',
        iconClass: 'ui-success-chip'
    },
    ended: {
        label: 'Berakhir',
        badgeClass: 'ui-danger-chip',
        iconClass: 'ui-danger-chip'
    }
};

const formatCurrency = (value: number) => `Rp${Math.max(0, value || 0).toLocaleString('id-ID')}`;

/** Human-readable remaining time until a live flash sale ends (null when not live). */
const getRemainingLabel = (sale: Pick<FlashSale, 'endDate'>, statusKey: FlashSaleStatusKey): string | null => {
    if (statusKey !== 'live') return null;
    const end = new Date(sale.endDate).getTime();
    const diffMs = end - Date.now();
    if (!Number.isFinite(diffMs) || diffMs <= 0) return null;
    const totalMinutes = Math.floor(diffMs / 60000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    if (days > 0) return `${days}h ${hours}j tersisa`;
    if (hours > 0) return `${hours}j ${minutes}m tersisa`;
    return `${minutes}m tersisa`;
};

const calculateFlashPrice = (
    price: number,
    discountType: 'percentage' | 'fixed',
    discountValue: number
) => {
    if (discountType === 'percentage') {
        return Math.max(0, Math.round(price * (1 - discountValue / 100)));
    }

    return Math.max(0, price - discountValue);
};

const getResolvedProductId = (item: FlashSaleProduct) => item.productId?._id ?? item.productRefId ?? '';

const getStatusKey = (sale: Pick<FlashSale, 'statusKey' | 'isActive' | 'startDate' | 'endDate'>): FlashSaleStatusKey => {
    if (sale.statusKey) return sale.statusKey;

    const now = new Date();
    const start = new Date(sale.startDate);
    const end = new Date(sale.endDate);

    if (!sale.isActive) return 'inactive';
    if (now < start) return 'upcoming';
    if (now > end) return 'ended';
    return 'live';
};

const formatDate = (dateStr: string) =>
    new Date(dateStr).toLocaleDateString('id-ID', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });

const formatDatetimeLocal = (dateStr: string) => {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    const pad = (value: number) => String(value).padStart(2, '0');

    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const getFallbackSummary = (sale: FlashSale): FlashSaleSummary =>
    sale.products.reduce(
        (summary, item) => {
            const remaining = Math.max(item.stock - item.soldCount, 0);
            const basePrice = item.productId?.price?.basic ?? 0;
            const flashPrice = basePrice
                ? calculateFlashPrice(basePrice, item.discountType, item.discountValue)
                : basePrice;

            summary.productCount += 1;
            summary.totalStock += item.stock;
            summary.soldCount += item.soldCount;
            summary.remainingStock += remaining;

            if (remaining <= 0) summary.soldOutCount += 1;
            if (remaining > 0 && remaining <= 5) summary.lowStockCount += 1;
            if (!item.productId) summary.missingProductCount += 1;
            if (item.productId?.status === false) summary.inactiveProductCount += 1;
            if (!basePrice || flashPrice >= basePrice) summary.pricingIssueCount += 1;

            return summary;
        },
        {
            productCount: 0,
            totalStock: 0,
            soldCount: 0,
            remainingStock: 0,
            soldOutCount: 0,
            lowStockCount: 0,
            missingProductCount: 0,
            inactiveProductCount: 0,
            pricingIssueCount: 0,
            overlapCount: sale.overlappingProducts?.length ?? 0
        }
    );

const getIssueList = (sale: FlashSale) => {
    const summary = sale.summary ?? getFallbackSummary(sale);
    const issues: string[] = [];

    if (summary.missingProductCount > 0) {
        issues.push(`${summary.missingProductCount} produk referensinya hilang`);
    }
    if (summary.inactiveProductCount > 0) {
        issues.push(`${summary.inactiveProductCount} produk sedang nonaktif`);
    }
    if (summary.pricingIssueCount > 0) {
        issues.push(`${summary.pricingIssueCount} produk perlu cek harga promo`);
    }
    if (summary.overlapCount > 0) {
        issues.push(`${summary.overlapCount} produk overlap dengan promo aktif lain`);
    }

    return issues;
};

const validatePromoInput = (
    originalPrice: number,
    flashPrice: number,
    stock: number,
    soldCount = 0,
    costPrice = 0
) => {
    if (!Number.isFinite(flashPrice) || flashPrice < 0) {
        return 'Harga flash sale tidak valid';
    }
    if (flashPrice >= originalPrice) {
        return 'Harga flash sale harus lebih rendah dari harga normal';
    }
    if (costPrice > 0 && flashPrice < costPrice) {
        return `Harga flash sale tidak boleh di bawah modal (${formatCurrency(costPrice)})`;
    }
    if (!Number.isInteger(stock) || stock < 1) {
        return 'Stok flash sale minimal 1';
    }
    if (stock < soldCount) {
        return 'Stok tidak boleh lebih kecil dari jumlah terjual';
    }

    return null;
};

export default function FlashSales() {
    const [flashSales, setFlashSales] = useState<FlashSale[]>([]);
    const [products, setProducts] = useState<Product[]>([]);
    const [productsLoading, setProductsLoading] = useState(false);
    const [productsError, setProductsError] = useState('');
    const [loading, setLoading] = useState(true);
    const [showModal, setShowModal] = useState(false);
    const [showProductModal, setShowProductModal] = useState(false);
    const [editingFlashSale, setEditingFlashSale] = useState<FlashSale | null>(null);
    const [selectedFlashSale, setSelectedFlashSale] = useState<FlashSale | null>(null);
    const [saleToDelete, setSaleToDelete] = useState<FlashSale | null>(null);
    const [form, setForm] = useState<FormData>(defaultForm);
    const [productForm, setProductForm] = useState<ProductFormData>(defaultProductForm);
    const [productSearch, setProductSearch] = useState('');
    const [globalSearch, setGlobalSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
    const [saving, setSaving] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [selectedProducts, setSelectedProducts] = useState<SelectedProductItem[]>([]);
    const [newProductSearch, setNewProductSearch] = useState('');
    const [editingProduct, setEditingProduct] = useState<{ saleId: string; product: FlashSaleProduct } | null>(null);
    const [editProductForm, setEditProductForm] = useState({ flashPrice: 0, stock: 0 });
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
    const latestFlashSalesRequestId = useRef(0);
    const latestProductsRequestId = useRef(0);

    const fetchFlashSales = useCallback(async () => {
        const requestId = latestFlashSalesRequestId.current + 1;
        latestFlashSalesRequestId.current = requestId;
        try {
            setLoading(true);
            setMessage(null);
            const response = await apiV2
                .get('/flash-sales/admin/all');
            if (requestId !== latestFlashSalesRequestId.current) return;
            setFlashSales(response.data);
        } catch (error: any) {
            if (requestId !== latestFlashSalesRequestId.current) return;
            console.error('Failed to load flash sales', error);
            setMessage({ type: 'error', text: error.response?.data?.message || 'Gagal memuat data flash sale' });
        } finally {
            if (requestId === latestFlashSalesRequestId.current) {
                setLoading(false);
            }
        }
    }, []);

    const fetchProducts = useCallback(async () => {
        const requestId = latestProductsRequestId.current + 1;
        latestProductsRequestId.current = requestId;
        setProductsLoading(true);
        setProductsError('');
        try {
            const response = await apiV2
                .get('/products/admin/all');
            if (requestId !== latestProductsRequestId.current) return;
            setProducts(response.data.filter((product: Product) => product.status));
        } catch (error: any) {
            if (requestId !== latestProductsRequestId.current) return;
            console.error('Failed to load products', error);
            setProductsError(error.response?.data?.message || 'Gagal memuat data produk');
        } finally {
            if (requestId === latestProductsRequestId.current) {
                setProductsLoading(false);
            }
        }
    }, []);

    const refreshAll = useCallback(async () => {
        await Promise.all([fetchFlashSales(), fetchProducts()]);
    }, [fetchFlashSales, fetchProducts]);

    useEffect(() => {
        refreshAll();
    }, [refreshAll]);

    useEffect(() => {
        const handleRefresh = () => refreshAll();
        window.addEventListener('admin:refresh-current-page', handleRefresh);
        return () => window.removeEventListener('admin:refresh-current-page', handleRefresh);
    }, [refreshAll]);

    const dashboardSummary = useMemo(() => {
        return flashSales.reduce(
            (summary, sale) => {
                const statusKey = getStatusKey(sale);
                const saleSummary = sale.summary ?? getFallbackSummary(sale);

                summary.total += 1;
                summary.products += saleSummary.productCount;
                summary.stock += saleSummary.totalStock;
                summary.remaining += saleSummary.remainingStock;

                if (statusKey === 'live') summary.live += 1;
                if (statusKey === 'upcoming') summary.upcoming += 1;
                if (statusKey === 'ended') summary.ended += 1;
                if (statusKey === 'inactive') summary.inactive += 1;
                if (sale.hasIssues || getIssueList(sale).length > 0) summary.issue += 1;

                return summary;
            },
            {
                total: 0,
                live: 0,
                upcoming: 0,
                ended: 0,
                inactive: 0,
                issue: 0,
                products: 0,
                stock: 0,
                remaining: 0
            }
        );
    }, [flashSales]);

    const filteredFlashSales = useMemo(() => {
        const searchTerm = globalSearch.trim().toLowerCase();

        return flashSales.filter((sale) => {
            const statusKey = getStatusKey(sale);
            const saleIssues = getIssueList(sale);
            const searchBlob = [
                sale.name,
                sale.description,
                sale.statusLabel,
                ...sale.products.flatMap((item) => [item.productId?.name, item.productId?.code, item.productRefId])
            ]
                .filter(Boolean)
                .join(' ')
                .toLowerCase();

            const matchesSearch = !searchTerm || searchBlob.includes(searchTerm);
            const matchesStatus =
                statusFilter === 'all' ||
                (statusFilter === 'issue'
                    ? sale.hasIssues || saleIssues.length > 0
                    : statusKey === statusFilter);

            return matchesSearch && matchesStatus;
        });
    }, [flashSales, globalSearch, statusFilter]);

    const filteredNewProducts = useMemo(() => {
        const term = newProductSearch.trim().toLowerCase();
        const selectedIds = new Set(selectedProducts.map((product) => product.productId));

        return products.filter((product) => {
            const matchesSearch =
                !term ||
                product.name.toLowerCase().includes(term) ||
                product.code.toLowerCase().includes(term);

            return matchesSearch && !selectedIds.has(product._id);
        });
    }, [products, newProductSearch, selectedProducts]);

    const filteredProducts = useMemo(() => {
        const term = productSearch.trim().toLowerCase();
        const existingIds = new Set(
            (selectedFlashSale?.products ?? [])
                .map((item) => getResolvedProductId(item))
                .filter(Boolean)
        );

        return products.filter((product) => {
            const matchesSearch =
                !term ||
                product.name.toLowerCase().includes(term) ||
                product.code.toLowerCase().includes(term);

            return matchesSearch && !existingIds.has(product._id);
        });
    }, [products, productSearch, selectedFlashSale]);

    const handleSubmit = async (event: React.FormEvent) => {
        event.preventDefault();

        if (!form.name || !form.startDate || !form.endDate) {
            setMessage({ type: 'error', text: 'Nama, tanggal mulai, dan tanggal selesai wajib diisi' });
            return;
        }

        const startDate = new Date(form.startDate);
        const endDate = new Date(form.endDate);

        if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || endDate <= startDate) {
            setMessage({ type: 'error', text: 'Rentang waktu flash sale tidak valid' });
            return;
        }

        if (!editingFlashSale && form.isActive && selectedProducts.length === 0) {
            setMessage({ type: 'error', text: 'Flash sale aktif wajib memiliki minimal satu produk' });
            return;
        }

        if (!editingFlashSale) {
            for (const product of selectedProducts) {
                const validationError = validatePromoInput(
                    product.productPrice,
                    product.flashPrice,
                    product.stock,
                    0,
                    products.find((item) => item._id === product.productId)?.costPrice ?? 0
                );
                if (validationError) {
                    setMessage({ type: 'error', text: `${product.productName}: ${validationError}` });
                    return;
                }
            }
        }

        setSaving(true);
        try {
            if (editingFlashSale) {
                await apiV2
                    .put(`/flash-sales/admin/${editingFlashSale._id}`, form);
            } else {
                const payload = {
                    ...form,
                    products: selectedProducts.map((product) => ({
                        productId: product.productId,
                        discountType: 'fixed' as const,
                        discountValue: product.productPrice - product.flashPrice,
                        stock: product.stock
                    }))
                };

                await apiV2
                    .post('/flash-sales/admin/create', payload);
            }

            await fetchFlashSales();
            setShowModal(false);
            setForm(defaultForm);
            setEditingFlashSale(null);
            setSelectedProducts([]);
        } catch (error: any) {
            console.error('Failed to save flash sale', error);
            setMessage({ type: 'error', text: error.response?.data?.message || 'Gagal menyimpan flash sale' });
        } finally {
            setSaving(false);
        }
    };

    const handleEdit = (sale: FlashSale) => {
        setEditingFlashSale(sale);
        setForm({
            name: sale.name,
            description: sale.description || '',
            startDate: formatDatetimeLocal(sale.startDate),
            endDate: formatDatetimeLocal(sale.endDate),
            isActive: sale.isActive,
            banner: sale.banner || ''
        });
        setShowModal(true);
    };

    const confirmDeleteSale = async () => {
        if (!saleToDelete) return;

        setDeleting(true);
        try {
            await apiV2
                .delete(`/flash-sales/admin/${saleToDelete._id}`);
            await fetchFlashSales();
            setSaleToDelete(null);
        } catch (error: any) {
            console.error('Failed to delete flash sale', error);
            setMessage({ type: 'error', text: error.response?.data?.message || 'Gagal menghapus flash sale' });
        } finally {
            setDeleting(false);
        }
    };

    const handleToggleStatus = async (sale: FlashSale) => {
        if (actionLoadingId) return;
        setActionLoadingId(sale._id);
        try {
            await apiV2
                .put(`/flash-sales/admin/${sale._id}`, { isActive: !sale.isActive });
            await fetchFlashSales();
        } catch (error: any) {
            console.error('Failed to toggle status', error);
            setMessage({ type: 'error', text: error.response?.data?.message || 'Gagal mengubah status flash sale' });
        } finally {
            setActionLoadingId(null);
        }
    };

    // End a live flash sale immediately by moving endDate to now (keeps history).
    const handleEndNow = async (sale: FlashSale) => {
        if (actionLoadingId) return;
        setActionLoadingId(sale._id);
        try {
            await apiV2
                .put(`/flash-sales/admin/${sale._id}`, { endDate: new Date().toISOString() });
            setMessage({ type: 'success', text: `Flash sale "${sale.name}" diakhiri.` });
            await fetchFlashSales();
        } catch (error: any) {
            console.error('Failed to end flash sale', error);
            setMessage({ type: 'error', text: error.response?.data?.message || 'Gagal mengakhiri flash sale' });
        } finally {
            setActionLoadingId(null);
        }
    };

    const openAddModal = () => {
        setEditingFlashSale(null);
        setForm(defaultForm);
        setSelectedProducts([]);
        setNewProductSearch('');
        setShowModal(true);
    };

    const addProductToSelection = (product: Product) => {
        if (selectedProducts.find((item) => item.productId === product._id)) {
            setMessage({ type: 'error', text: 'Produk sudah ditambahkan' });
            return;
        }

        const defaultFlashPrice = Math.max(product.costPrice || 0, Math.round(product.price.basic * 0.9));
        setSelectedProducts((current) => [
            ...current,
            {
                productId: product._id,
                productName: product.name,
                productCode: product.code,
                productPrice: product.price.basic,
                flashPrice: defaultFlashPrice,
                stock: 100
            }
        ]);
        setNewProductSearch('');
    };

    const removeProductFromSelection = (productId: string) => {
        setSelectedProducts((current) => current.filter((product) => product.productId !== productId));
    };

    const updateSelectedProduct = (
        productId: string,
        field: keyof Pick<SelectedProductItem, 'flashPrice' | 'stock'>,
        value: number
    ) => {
        setSelectedProducts((current) =>
            current.map((product) =>
                product.productId === productId ? { ...product, [field]: value } : product
            )
        );
    };

    const openProductModal = (sale: FlashSale) => {
        setSelectedFlashSale(sale);
        setProductForm(defaultProductForm);
        setProductSearch('');
        setShowProductModal(true);
    };

    const handleAddProduct = async (event: React.FormEvent) => {
        event.preventDefault();

        if (!selectedFlashSale || !productForm.productId) {
            setMessage({ type: 'error', text: 'Pilih produk terlebih dahulu' });
            return;
        }

        const product = products.find((item) => item._id === productForm.productId);
        if (!product) {
            setMessage({ type: 'error', text: 'Produk tidak ditemukan' });
            return;
        }

        const validationError = validatePromoInput(product.price.basic, productForm.flashPrice, productForm.stock, 0, product.costPrice || 0);
        if (validationError) {
            setMessage({ type: 'error', text: validationError });
            return;
        }

        setSaving(true);
        try {
            const payload = {
                productId: productForm.productId,
                discountType: 'fixed',
                discountValue: product.price.basic - productForm.flashPrice,
                stock: productForm.stock
            };
            await apiV2
                .post(`/flash-sales/admin/${selectedFlashSale._id}/products`, payload);
            await fetchFlashSales();
            setShowProductModal(false);
            setProductForm(defaultProductForm);
            setSelectedFlashSale(null);
        } catch (error: any) {
            console.error('Failed to add product', error);
            setMessage({ type: 'error', text: error.response?.data?.message || 'Gagal menambahkan produk' });
        } finally {
            setSaving(false);
        }
    };

    const handleRemoveProduct = async (saleId: string, productId: string) => {
        const sale = flashSales.find((item) => item._id === saleId);
        const product = sale?.products.find((item) => getResolvedProductId(item) === productId);
        if (product && product.soldCount > 0) {
            setMessage({ type: 'error', text: 'Produk sudah memiliki penjualan promo. Turunkan stok atau nonaktifkan flash sale, jangan hapus item.' });
            return;
        }
        if (sale && getStatusKey(sale) === 'live') {
            setMessage({ type: 'error', text: 'Produk tidak bisa dihapus saat flash sale sedang berlangsung' });
            return;
        }
        if (!window.confirm('Yakin ingin menghapus produk dari flash sale ini?')) return;

        setActionLoadingId(`${saleId}:${productId}`);
        try {
            await apiV2
                .delete(`/flash-sales/admin/${saleId}/products/${productId}`);
            await fetchFlashSales();
        } catch (error: any) {
            console.error('Failed to remove product', error);
            setMessage({ type: 'error', text: error.response?.data?.message || 'Gagal menghapus produk' });
        } finally {
            setActionLoadingId(null);
        }
    };

    const openEditProduct = (saleId: string, product: FlashSaleProduct) => {
        if (!product.productId) {
            setMessage({ type: 'error', text: 'Produk referensi sudah tidak ditemukan. Hapus item ini dari flash sale.' });
            return;
        }

        const flashPrice = calculateFlashPrice(
            product.productId.price.basic,
            product.discountType,
            product.discountValue
        );

        setEditingProduct({ saleId, product });
        setEditProductForm({ flashPrice, stock: product.stock });
    };

    const handleUpdateProduct = async () => {
        if (!editingProduct || !editingProduct.product.productId) return;

        const { saleId, product } = editingProduct;
        const currentProduct = product.productId;
        if (!currentProduct) return;
        const validationError = validatePromoInput(
            currentProduct.price.basic,
            editProductForm.flashPrice,
            editProductForm.stock,
            product.soldCount,
            currentProduct.costPrice || 0
        );

        if (validationError) {
            setMessage({ type: 'error', text: validationError });
            return;
        }

        setSaving(true);
        try {
            const flashSale = flashSales.find((sale) => sale._id === saleId);
            if (!flashSale) return;

                const updatedProducts = flashSale.products.map((item) => {
                    const productId = getResolvedProductId(item);
                    if (productId === currentProduct._id) {
                        return {
                            productId,
                            discountType: 'fixed' as const,
                            discountValue: currentProduct.price.basic - editProductForm.flashPrice,
                            stock: editProductForm.stock,
                            soldCount: item.soldCount
                        };
                    }

                    return {
                        productId,
                        discountType: item.discountType,
                        discountValue: item.discountValue,
                        stock: item.stock,
                        soldCount: item.soldCount
                    };
                });

            await apiV2
                .put(`/flash-sales/admin/${saleId}`, { products: updatedProducts });
            await fetchFlashSales();
            setEditingProduct(null);
        } catch (error: any) {
            console.error('Failed to update product', error);
            setMessage({ type: 'error', text: error.response?.data?.message || 'Gagal update produk' });
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="space-y-5">
            <div className="ui-panel-muted border ui-border rounded-xl p-4 flex flex-wrap gap-2">
                <button
                    onClick={openAddModal}
                    className="inline-flex items-center justify-center gap-2 px-4 py-2.5 ui-accent-solid rounded-xl text-sm font-semibold transition-colors"
                >
                    <Plus className="w-4 h-4" />
                    Tambah Flash Sale
                </button>
            </div>

            {message && (
                <div className={`rounded-xl border px-4 py-3 text-sm ${message.type === 'success' ? 'ui-success-chip' : 'ui-danger-chip'}`} role="alert" aria-live="polite">
                    {message.text}
                </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-2xl border ui-border ui-panel-muted p-4">
                    <div className="flex items-start justify-between">
                        <div>
                            <p className="text-[11px] uppercase tracking-[0.18em] ui-text-muted">Promo Aktif</p>
                            <p className="mt-2 text-3xl font-black ui-text">{dashboardSummary.live}</p>
                            <p className="mt-1 text-sm ui-text-muted">{dashboardSummary.upcoming} akan datang</p>
                        </div>
                        <div className="rounded-xl border p-2.5 ui-success-chip">
                            <Sparkles className="w-5 h-5" />
                        </div>
                    </div>
                </div>
                <div className="rounded-2xl border ui-border ui-panel-muted p-4">
                    <div className="flex items-start justify-between">
                        <div>
                            <p className="text-[11px] uppercase tracking-[0.18em] ui-text-muted">Total Produk Promo</p>
                            <p className="mt-2 text-3xl font-black ui-text">{dashboardSummary.products}</p>
                            <p className="mt-1 text-sm ui-text-muted">{dashboardSummary.total} flash sale tercatat</p>
                        </div>
                        <div className="rounded-xl p-2.5 bg-[var(--ui-accent-soft)] ui-accent-text">
                            <Layers3 className="w-5 h-5" />
                        </div>
                    </div>
                </div>
                <div className="rounded-2xl border ui-border ui-panel-muted p-4">
                    <div className="flex items-start justify-between">
                        <div>
                            <p className="text-[11px] uppercase tracking-[0.18em] ui-text-muted">Sisa Stok Promo</p>
                            <p className="mt-2 text-3xl font-black ui-text">{dashboardSummary.remaining}</p>
                            <p className="mt-1 text-sm ui-text-muted">dari {dashboardSummary.stock} stok promo</p>
                        </div>
                        <div className="rounded-xl border p-2.5 ui-info-chip">
                            <Package className="w-5 h-5" />
                        </div>
                    </div>
                </div>
                <div className="rounded-2xl border ui-border ui-panel-muted p-4">
                    <div className="flex items-start justify-between">
                        <div>
                            <p className="text-[11px] uppercase tracking-[0.18em] ui-text-muted">Perlu Tindakan</p>
                            <p className="mt-2 text-3xl font-black ui-text">{dashboardSummary.issue}</p>
                            <p className="mt-1 text-sm ui-text-muted">{dashboardSummary.ended} promo sudah berakhir</p>
                        </div>
                        <div className="rounded-xl border p-2.5 ui-warning-chip">
                            <AlertTriangle className="w-5 h-5" />
                        </div>
                    </div>
                </div>
            </div>

            <div className="rounded-2xl border ui-border ui-panel-muted p-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
                    <div className="relative flex-1">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ui-text-muted" />
                        <input
                            type="text"
                            value={globalSearch}
                            onChange={(event) => setGlobalSearch(event.target.value)}
                            className={`${inputClass} pl-9`}
                            placeholder="Cari nama flash sale, produk, atau kode produk..."
                        />
                    </div>
                    <select
                        value={statusFilter}
                        onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
                        className="w-full lg:w-56 rounded-lg ui-panel border ui-border px-3 py-2 text-sm ui-text focus:outline-none focus:border-[var(--ui-accent)]"
                    >
                        <option value="all">Semua Status</option>
                        <option value="live">Berlangsung</option>
                        <option value="upcoming">Akan Datang</option>
                        <option value="ended">Berakhir</option>
                        <option value="inactive">Nonaktif</option>
                        <option value="issue">Perlu Tindakan</option>
                    </select>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs ui-text-muted">
                    <span className="inline-flex items-center gap-1 rounded-full border ui-border px-2.5 py-1">
                        <TrendingUp className="w-3.5 h-3.5" />
                        {filteredFlashSales.length} promo tampil
                    </span>
                    <span className="inline-flex items-center gap-1 rounded-full border ui-border px-2.5 py-1">
                        <Package className="w-3.5 h-3.5" />
                        {products.length} produk aktif tersedia
                    </span>
                </div>
            </div>

            <div className="space-y-4">
                {loading ? (
                    <div className="ui-panel-muted rounded-xl border ui-border p-8 text-center ui-text-muted">
                        Memuat...
                    </div>
                ) : flashSales.length === 0 ? (
                    <div className="ui-panel-muted rounded-xl border ui-border p-8 text-center ui-text-muted">
                        <Zap className="w-12 h-12 mx-auto mb-3 opacity-30" />
                        <p>Belum ada flash sale.</p>
                    </div>
                ) : filteredFlashSales.length === 0 ? (
                    <div className="ui-panel-muted rounded-xl border ui-border p-8 text-center ui-text-muted">
                        <Search className="w-12 h-12 mx-auto mb-3 opacity-30" />
                        <p>Tidak ada flash sale yang cocok dengan filter saat ini.</p>
                    </div>
                ) : (
                    filteredFlashSales.map((sale) => {
                        const statusKey = getStatusKey(sale);
                        const statusMeta = statusAppearance[statusKey];
                        const summary = sale.summary ?? getFallbackSummary(sale);
                        const issues = getIssueList(sale);
                        const remainingLabel = getRemainingLabel(sale, statusKey);

                        return (
                            <div
                                key={sale._id}
                                className="overflow-hidden rounded-2xl border ui-border ui-panel-muted"
                            >
                                <div className="border-b ui-border p-4 sm:p-5">
                                    <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                                        <div className="flex items-start gap-3">
                                            <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${statusMeta.iconClass}`}>
                                                <Zap className="w-5 h-5" />
                                            </div>
                                            <div className="space-y-2">
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <h3 className="text-lg font-bold ui-text">{sale.name}</h3>
                                                    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold ${statusMeta.badgeClass}`}>
                                                        {statusMeta.label}
                                                    </span>
                                                    {remainingLabel ? (
                                                        <span className="ui-accent-chip inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold">
                                                            <Clock className="w-3.5 h-3.5" />
                                                            {remainingLabel}
                                                        </span>
                                                    ) : null}
                                                    {sale.hasIssues || issues.length > 0 ? (
                                                        <span className="ui-warning-chip inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold">
                                                            <AlertTriangle className="w-3.5 h-3.5" />
                                                            Perlu perhatian
                                                        </span>
                                                    ) : null}
                                                </div>
                                                {sale.description ? (
                                                    <p className="text-sm ui-text-muted">{sale.description}</p>
                                                ) : (
                                                    <p className="text-sm ui-text-muted">Tanpa deskripsi tambahan.</p>
                                                )}
                                                <div className="flex flex-wrap items-center gap-3 text-sm ui-text-muted">
                                                    <span className="inline-flex items-center gap-1">
                                                        <Clock className="w-4 h-4" />
                                                        {formatDate(sale.startDate)} - {formatDate(sale.endDate)}
                                                    </span>
                                                    <span className="inline-flex items-center gap-1">
                                                        <Package className="w-4 h-4" />
                                                        {summary.productCount} produk
                                                    </span>
                                                </div>
                                            </div>
                                        </div>

                                        <div className="flex flex-wrap items-center gap-2">
                                            <button
                                                onClick={() => openProductModal(sale)}
                                                className="ui-info-chip inline-flex h-10 items-center gap-2 rounded-xl border px-3 text-sm font-semibold"
                                                title="Tambah Produk"
                                            >
                                                <Plus className="w-4 h-4" />
                                                Produk
                                            </button>
                                            <button
                                                onClick={() => handleEdit(sale)}
                                                className="inline-flex h-10 items-center gap-2 rounded-xl ui-panel px-3 text-sm font-semibold ui-text hover:bg-[var(--ui-card-muted)]"
                                                title="Edit Flash Sale"
                                            >
                                                <Edit className="w-4 h-4" />
                                                Edit
                                            </button>
                                            {statusKey === 'live' ? (
                                                <button
                                                    onClick={() => handleEndNow(sale)}
                                                    disabled={actionLoadingId === sale._id}
                                                    className="ui-danger-chip inline-flex h-10 items-center gap-2 rounded-xl border px-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
                                                    title="Akhiri flash sale sekarang"
                                                >
                                                    <Clock className="w-4 h-4" />
                                                    Akhiri
                                                </button>
                                            ) : null}
                                            <button
                                                onClick={() => handleToggleStatus(sale)}
                                                disabled={actionLoadingId === sale._id}
                                                className={`inline-flex h-10 items-center gap-2 rounded-xl px-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60 ${
                                                    sale.isActive
                                                        ? 'ui-warning-chip border'
                                                        : 'ui-success-chip border'
                                                }`}
                                                title={sale.isActive ? 'Nonaktifkan' : 'Aktifkan'}
                                            >
                                                {sale.isActive ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                                {sale.isActive ? 'Pause' : 'Aktifkan'}
                                            </button>
                                            <button
                                                onClick={() => setSaleToDelete(sale)}
                                                disabled={sale.canDelete === false || getStatusKey(sale) === 'live' || actionLoadingId === sale._id}
                                                title={sale.deleteBlockedReason || 'Hapus Flash Sale'}
                                                className={`inline-flex h-10 items-center gap-2 rounded-xl px-3 text-sm font-semibold ${
                                                    sale.canDelete === false
                                                        ? 'cursor-not-allowed ui-danger-chip border opacity-55'
                                                        : 'ui-danger-chip border'
                                                }`}
                                            >
                                                <Trash2 className="w-4 h-4" />
                                                Hapus
                                            </button>
                                        </div>
                                    </div>

                                    <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                                        <div className="rounded-xl border ui-border ui-panel p-3">
                                            <p className="text-[11px] uppercase tracking-[0.16em] ui-text-muted">Total Stok</p>
                                            <p className="mt-2 text-2xl font-black ui-text">{summary.totalStock}</p>
                                            <p className="mt-1 text-xs ui-text-muted">{summary.remainingStock} masih tersedia</p>
                                        </div>
                                        <div className="rounded-xl border ui-border ui-panel p-3">
                                            <p className="text-[11px] uppercase tracking-[0.16em] ui-text-muted">Terjual</p>
                                            <p className="mt-2 text-2xl font-black ui-text">{summary.soldCount}</p>
                                            <p className="mt-1 text-xs ui-text-muted">{summary.soldOutCount} produk habis</p>
                                        </div>
                                        <div className="rounded-xl border ui-border ui-panel p-3">
                                            <p className="text-[11px] uppercase tracking-[0.16em] ui-text-muted">Perlu Review</p>
                                            <p className="mt-2 text-2xl font-black ui-text">
                                                {issues.length > 0 ? issues.length : 0}
                                            </p>
                                            <p className="mt-1 text-xs ui-text-muted">
                                                {summary.lowStockCount} item stok rendah
                                            </p>
                                        </div>
                                        <div className="rounded-xl border ui-border ui-panel p-3">
                                            <p className="text-[11px] uppercase tracking-[0.16em] ui-text-muted">Cakupan Promo</p>
                                            <p className="mt-2 text-2xl font-black ui-text">{summary.productCount}</p>
                                            <p className="mt-1 text-xs ui-text-muted">
                                                {sale.banner ? 'Banner terpasang' : 'Tanpa banner'}
                                            </p>
                                        </div>
                                    </div>

                                    {issues.length > 0 ? (
                                        <div className="ui-warning-chip mt-4 rounded-xl border p-3">
                                            <div className="flex items-start gap-2">
                                                <AlertTriangle className="mt-0.5 w-4 h-4 shrink-0 ui-warning-text" />
                                                <div className="space-y-2">
                                                    <p className="text-sm font-semibold">
                                                        Area yang perlu dicek
                                                    </p>
                                                    <div className="flex flex-wrap gap-2">
                                                        {issues.map((issue) => (
                                                            <span
                                                                key={issue}
                                                                className="rounded-full border border-current/20 bg-[var(--ui-card-bg)] px-2.5 py-1 text-xs"
                                                            >
                                                                {issue}
                                                            </span>
                                                        ))}
                                                    </div>
                                                    {sale.overlappingProducts?.slice(0, 2).map((overlap) =>
                                                        overlap.detail.slice(0, 2).map((detail) => (
                                                            <p key={`${overlap.productId}-${detail}`} className="text-xs opacity-80">
                                                                {detail}
                                                            </p>
                                                        ))
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    ) : null}
                                </div>

                                {sale.products.length > 0 ? (
                                    <div className="p-4 sm:p-5">
                                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                                            {sale.products.map((item, index) => {
                                                const productId = getResolvedProductId(item);
                                                const originalPrice = item.productId?.price.basic ?? 0;
                                                const flashPrice = item.productId
                                                    ? calculateFlashPrice(
                                                        item.productId.price.basic,
                                                        item.discountType,
                                                        item.discountValue
                                                    )
                                                    : 0;
                                                const remaining = Math.max(item.stock - item.soldCount, 0);
                                                const progress = item.stock > 0 ? (item.soldCount / item.stock) * 100 : 0;
                                                const isMissing = !item.productId;
                                                const isInactive = item.productId?.status === false;
                                                const isActionBusy = actionLoadingId === `${sale._id}:${productId}`;
                                                const cannotRemove = !productId || item.soldCount > 0 || getStatusKey(sale) === 'live' || isActionBusy;

                                                return (
                                                    <div
                                                        key={productId || `${sale._id}-${index}`}
                                                        className="group relative rounded-xl border ui-border ui-panel p-3"
                                                    >
                                                        <div className="absolute right-2 top-2 flex gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                                                            <button
                                                                onClick={() => openEditProduct(sale._id, item)}
                                                                disabled={!item.productId || saving}
                                                                className={`rounded p-1 ${
                                                                    item.productId
                                                                        ? 'ui-info-chip'
                                                                        : 'cursor-not-allowed ui-panel ui-text-muted'
                                                                }`}
                                                                title={item.productId ? 'Edit' : 'Produk referensi hilang'}
                                                            >
                                                                <Edit className="w-3 h-3" />
                                                            </button>
                                                            <button
                                                                onClick={() => handleRemoveProduct(sale._id, productId)}
                                                                disabled={cannotRemove}
                                                                className={`rounded p-1 ${
                                                                    !cannotRemove
                                                                        ? 'ui-danger-chip'
                                                                        : 'cursor-not-allowed ui-panel ui-text-muted'
                                                                }`}
                                                                title={item.soldCount > 0 ? 'Produk sudah memiliki penjualan promo' : getStatusKey(sale) === 'live' ? 'Tidak bisa hapus saat promo berlangsung' : 'Hapus dari flash sale'}
                                                            >
                                                                <X className="w-3 h-3" />
                                                            </button>
                                                        </div>

                                                        <div className="flex items-start gap-3">
                                                            <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-lg border ui-border ui-panel-muted">
                                                                {item.productId?.icon ? (
                                                                    <img
                                                                        src={item.productId.icon}
                                                                        alt=""
                                                                        className="h-full w-full object-cover"
                                                                    />
                                                                ) : (
                                                                    <Package className="w-5 h-5 ui-text-muted" />
                                                                )}
                                                            </div>
                                                            <div className="min-w-0 flex-1">
                                                                <p className="truncate text-sm font-semibold ui-text">
                                                                    {item.productId?.name || 'Produk tidak ditemukan'}
                                                                </p>
                                                                <p className="text-xs ui-text-muted">
                                                                    {item.productId?.code || `Ref: ${productId || '-'}`}
                                                                </p>
                                                            </div>
                                                        </div>

                                                        <div className="mt-3 space-y-2">
                                                            {isMissing ? (
                                                                 <div className="ui-danger-chip rounded-lg border px-2.5 py-2 text-xs">
                                                                    Referensi produk hilang. Hapus item ini atau hubungkan ulang datanya.
                                                                </div>
                                                            ) : null}
                                                            {isInactive ? (
                                                                <div className="ui-warning-chip rounded-lg border px-2.5 py-2 text-xs">
                                                                    Produk sedang nonaktif, promo ini tidak akan tampil normal di publik.
                                                                </div>
                                                            ) : null}

                                                            {item.productId ? (
                                                                <>
                                                                    <div className="flex items-center justify-between text-xs">
                                                                        <span className="ui-text-muted line-through">
                                                                            {formatCurrency(originalPrice)}
                                                                        </span>
                                                                        <span
                                                                            className="flex items-center gap-1 font-semibold ui-accent-text"
                                                                            title={item.discountType === 'percentage' ? 'Diskon persen dari harga normal' : 'Potongan harga tetap'}
                                                                        >
                                                                            {item.discountType === 'percentage' ? (
                                                                                <Percent className="w-3 h-3" />
                                                                            ) : (
                                                                                <span className="text-[10px] font-black uppercase tracking-wide">Potong</span>
                                                                            )}
                                                                            {item.discountType === 'percentage'
                                                                                ? `${item.discountValue}%`
                                                                                : formatCurrency(item.discountValue)}
                                                                        </span>
                                                                    </div>
                                                                    <p className="text-lg font-bold ui-success-text">
                                                                        {formatCurrency(flashPrice)}
                                                                    </p>
                                                                    {(item.productId.costPrice || 0) > 0 && flashPrice < (item.productId.costPrice || 0) ? (
                                                                        <p className="text-xs ui-danger-text">
                                                                            Di bawah modal {formatCurrency(item.productId.costPrice || 0)}
                                                                        </p>
                                                                    ) : null}
                                                                </>
                                                            ) : (
                                                                <p className="text-sm font-semibold ui-text-muted">
                                                                    Harga promo tidak bisa dihitung
                                                                </p>
                                                            )}

                                                            <div className="space-y-1">
                                                                <div className="flex items-center justify-between text-xs ui-text-muted">
                                                                    <span>Terjual {item.soldCount}/{item.stock}</span>
                                                                    <span>{remaining} tersisa</span>
                                                                </div>
                                                                <div className="h-1.5 overflow-hidden rounded-full ui-panel-muted">
                                                                    <div
                                                                        className="h-full ui-accent-solid transition-all"
                                                                        style={{ width: `${Math.min(progress, 100)}%` }}
                                                                    />
                                                                </div>
                                                            </div>
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                ) : (
                                    <div className="p-5 text-sm ui-text-muted">Belum ada produk dalam flash sale ini.</div>
                                )}
                            </div>
                        );
                    })
                )}
            </div>

            {showModal ? (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
                    <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border ui-border ui-panel-muted shadow-xl" role="dialog" aria-modal="true" aria-labelledby="flash-sale-form-title">
                        <div className="flex items-center justify-between border-b ui-border p-4">
                            <h2 id="flash-sale-form-title" className="text-lg font-semibold ui-text">
                                {editingFlashSale ? 'Edit Flash Sale' : 'Tambah Flash Sale'}
                            </h2>
                            <button onClick={() => setShowModal(false)} className="ui-text-muted hover:text-[var(--ui-text)]-muted" aria-label="Tutup form flash sale">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <form onSubmit={handleSubmit} className="space-y-4 p-4">
                            <div>
                                <label className={labelClass}>Nama Flash Sale</label>
                                <input
                                    type="text"
                                    value={form.name}
                                    onChange={(event) => setForm({ ...form, name: event.target.value })}
                                    className={inputClass}
                                    placeholder="Flash Sale Akhir Tahun"
                                    required
                                />
                            </div>

                            <div>
                                <label className={labelClass}>Deskripsi (opsional)</label>
                                <textarea
                                    value={form.description}
                                    onChange={(event) => setForm({ ...form, description: event.target.value })}
                                    className={inputClass}
                                    placeholder="Diskon terbatas untuk produk pilihan"
                                    rows={2}
                                />
                            </div>

                            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                <div>
                                    <label className={labelClass}>
                                        Tanggal Mulai
                                        <span className="ui-accent-chip ml-2 inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold">WIB</span>
                                    </label>
                                    <input
                                        type="datetime-local"
                                        value={form.startDate}
                                        onChange={(event) => setForm({ ...form, startDate: event.target.value })}
                                        className={inputClass}
                                        required
                                    />
                                </div>
                                <div>
                                    <label className={labelClass}>
                                        Tanggal Selesai
                                        <span className="ui-accent-chip ml-2 inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold">WIB</span>
                                    </label>
                                    <input
                                        type="datetime-local"
                                        value={form.endDate}
                                        onChange={(event) => setForm({ ...form, endDate: event.target.value })}
                                        className={inputClass}
                                        required
                                    />
                                </div>
                            </div>
                            <p className="mt-1 text-xs ui-text-muted">
                                Waktu diisi dalam zona WIB (UTC+7). Pelanggan di zona lain melihat hitung mundur yang sama.
                            </p>

                            <div>
                                <label className={labelClass}>Banner (opsional)</label>
                                <ImagePickerField
                                    value={form.banner}
                                    onChange={(url: string) => setForm({ ...form, banner: url })}
                                    folder="covers"
                                />
                            </div>

                            <div className="flex items-center gap-2">
                                <input
                                    type="checkbox"
                                    id="isActive"
                                    checked={form.isActive}
                                    onChange={(event) => setForm({ ...form, isActive: event.target.checked })}
                                    className="w-4 h-4 rounded ui-border ui-panel-muted ui-accent-text focus:ring-[var(--ui-accent)]"
                                />
                                <label htmlFor="isActive" className="text-sm ui-text-muted">
                                    Aktif
                                </label>
                            </div>

                            {!editingFlashSale ? (
                                <div className="border-t ui-border pt-4">
                                    <div className="mb-3 flex items-center justify-between">
                                        <label className={labelClass}>Pilih Produk Flash Sale</label>
                                        <span className="text-xs ui-text-muted">
                                            {selectedProducts.length} produk dipilih
                                        </span>
                                    </div>

                                    <div className="relative mb-3">
                                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ui-text-muted" />
                                        <input
                                            type="text"
                                            value={newProductSearch}
                                            onChange={(event) => setNewProductSearch(event.target.value)}
                                            className={`${inputClass} pl-9`}
                                            placeholder="Cari nama atau kode produk..."
                                        />
                                    </div>

                                    {productsError ? (
                                        <div className="mb-3 rounded-lg border ui-danger-chip px-3 py-2 text-xs">
                                            {productsError} — coba tombol Segarkan di atas.
                                        </div>
                                    ) : null}

                                    <div className="mb-3 max-h-52 overflow-y-auto rounded-lg border ui-border ui-panel">
                                        {productsLoading ? (
                                            <p className="px-3 py-3 text-sm ui-text-muted">Memuat produk…</p>
                                        ) : filteredNewProducts.length === 0 ? (
                                            <p className="px-3 py-3 text-sm ui-text-muted">
                                                {products.length === 0
                                                    ? 'Belum ada produk aktif. Buat produk dulu di menu Produk.'
                                                    : 'Tidak ada produk yang cocok dengan pencarian.'}
                                            </p>
                                        ) : (
                                            filteredNewProducts.slice(0, 20).map((product) => (
                                                <button
                                                    key={product._id}
                                                    type="button"
                                                    onClick={() => addProductToSelection(product)}
                                                    className="flex w-full items-center justify-between px-3 py-2 text-left hover:bg-[var(--ui-card-muted)]"
                                                >
                                                    <div>
                                                        <p className="text-sm ui-text">{product.name}</p>
                                                        <p className="text-xs ui-text-muted">
                                                            {product.code} - {formatCurrency(product.price.basic)}
                                                        </p>
                                                    </div>
                                                    <Plus className="w-4 h-4 ui-success-text" />
                                                </button>
                                            ))
                                        )}
                                    </div>
                                    {!newProductSearch && filteredNewProducts.length > 20 ? (
                                        <p className="mb-3 text-[11px] ui-text-muted">
                                            Menampilkan 20 produk pertama — ketik untuk mencari sisanya.
                                        </p>
                                    ) : null}

                                    {selectedProducts.length > 0 ? (
                                        <div className="space-y-2">
                                            {selectedProducts.map((item) => {
                                                const discount = item.productPrice - item.flashPrice;
                                                const discountPercent = item.productPrice
                                                    ? Math.round((discount / item.productPrice) * 100)
                                                    : 0;
                                                const validationError = validatePromoInput(
                                                    item.productPrice,
                                                    item.flashPrice,
                                                    item.stock,
                                                    0,
                                                    products.find((product) => product._id === item.productId)?.costPrice ?? 0
                                                );

                                                return (
                                                    <div
                                                        key={item.productId}
                                                        className="rounded-lg border ui-border ui-panel p-3"
                                                    >
                                                        <div className="mb-2 flex items-start justify-between gap-3">
                                                            <div>
                                                                <p className="text-sm font-medium ui-text">{item.productName}</p>
                                                                <p className="text-xs ui-text-muted">
                                                                    {item.productCode} - Harga normal {formatCurrency(item.productPrice)}
                                                                </p>
                                                            </div>
                                                            <button
                                                                type="button"
                                                                onClick={() => removeProductFromSelection(item.productId)}
                                                                className="rounded p-1 ui-danger-action"
                                                            >
                                                                <X className="w-4 h-4" />
                                                            </button>
                                                        </div>
                                                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                                            <div>
                                                                <label className="text-[10px] ui-text-muted">Harga Flash Sale</label>
                                                                <input
                                                                    type="number"
                                                                    value={item.flashPrice}
                                                                    onChange={(event) =>
                                                                        updateSelectedProduct(
                                                                            item.productId,
                                                                            'flashPrice',
                                                                            Number(event.target.value)
                                                                        )
                                                                    }
                                                                    className="w-full rounded border ui-border ui-panel-muted px-2 py-1 text-xs ui-text"
                                                                    min="0"
                                                                />
                                                            </div>
                                                            <div>
                                                                <label className="text-[10px] ui-text-muted">Stok</label>
                                                                <input
                                                                    type="number"
                                                                    value={item.stock}
                                                                    onChange={(event) =>
                                                                        updateSelectedProduct(
                                                                            item.productId,
                                                                            'stock',
                                                                            Number(event.target.value)
                                                                        )
                                                                    }
                                                                    className="w-full rounded border ui-border ui-panel-muted px-2 py-1 text-xs ui-text"
                                                                    min="1"
                                                                />
                                                            </div>
                                                        </div>
                                                        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs">
                                                            <span className="ui-accent-text">
                                                                Hemat {formatCurrency(discount)} ({discountPercent}%)
                                                            </span>
                                                            <span className="font-semibold ui-success-text">
                                                                {formatCurrency(item.flashPrice)}
                                                            </span>
                                                        </div>
                                                        {validationError ? (
                                                            <p className="mt-2 text-xs ui-danger-text">{validationError}</p>
                                                        ) : null}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    ) : (
                                        <p className="py-4 text-center text-xs ui-text-muted">
                                            Ketik untuk mencari dan menambahkan produk.
                                        </p>
                                    )}
                                </div>
                            ) : null}

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

            {showProductModal && selectedFlashSale ? (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
                    <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border ui-border ui-panel-muted shadow-xl" role="dialog" aria-modal="true" aria-labelledby="flash-sale-add-product-title">
                        <div className="flex items-center justify-between border-b ui-border p-4">
                            <h2 id="flash-sale-add-product-title" className="text-lg font-semibold ui-text">
                                Tambah Produk ke "{selectedFlashSale.name}"
                            </h2>
                            <button
                                onClick={() => setShowProductModal(false)}
                                className="ui-text-muted hover:text-[var(--ui-text)]-muted"
                                aria-label="Tutup form tambah produk flash sale"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <form onSubmit={handleAddProduct} className="space-y-4 p-4">
                            <div>
                                <label className={labelClass}>Cari Produk</label>
                                <div className="relative">
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ui-text-muted" />
                                    <input
                                        type="text"
                                        value={productSearch}
                                        onChange={(event) => setProductSearch(event.target.value)}
                                        className={`${inputClass} pl-9`}
                                        placeholder="Cari nama atau kode produk..."
                                    />
                                </div>
                            </div>

                            <div>
                                <label className={labelClass}>Pilih Produk</label>
                                <select
                                    value={productForm.productId}
                                    onChange={(event) => {
                                        const selectedProduct = products.find((product) => product._id === event.target.value);
                                        const defaultFlashPrice = selectedProduct
                                            ? Math.max(0, Math.round(selectedProduct.price.basic * 0.9))
                                            : 0;
                                        setProductForm({
                                            ...productForm,
                                            productId: event.target.value,
                                            flashPrice: defaultFlashPrice
                                        });
                                    }}
                                    className={inputClass}
                                    required
                                >
                                    <option value="">
                                        {productsLoading
                                            ? 'Memuat produk…'
                                            : productsError
                                                ? 'Gagal memuat produk — coba segarkan'
                                                : filteredProducts.length === 0
                                                    ? 'Tidak ada produk aktif yang bisa dipilih'
                                                    : '-- Pilih Produk --'}
                                    </option>
                                    {filteredProducts.slice(0, 50).map((product) => (
                                        <option key={product._id} value={product._id}>
                                            {product.code} - {product.name} ({formatCurrency(product.price.basic)})
                                        </option>
                                    ))}
                                </select>
                                {productsError ? (
                                    <p className="mt-1 text-xs ui-danger-text">{productsError}</p>
                                ) : null}
                                {filteredProducts.length > 50 ? (
                                    <p className="mt-1 text-xs ui-text-muted">
                                        Menampilkan 50 dari {filteredProducts.length} produk. Gunakan pencarian untuk mempersempit hasil.
                                    </p>
                                ) : null}
                            </div>

                            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                <div>
                                    <label className={labelClass}>Harga Flash Sale</label>
                                    <input
                                        type="number"
                                        value={productForm.flashPrice}
                                        onChange={(event) =>
                                            setProductForm({
                                                ...productForm,
                                                flashPrice: Number(event.target.value)
                                            })
                                        }
                                        className={inputClass}
                                        min="0"
                                        required
                                    />
                                </div>
                                <div>
                                    <label className={labelClass}>Stok Flash Sale</label>
                                    <input
                                        type="number"
                                        value={productForm.stock}
                                        onChange={(event) =>
                                            setProductForm({
                                                ...productForm,
                                                stock: Number(event.target.value)
                                            })
                                        }
                                        className={inputClass}
                                        min="1"
                                        required
                                    />
                                </div>
                            </div>

                            {productForm.productId ? (
                                <div className="rounded-lg border ui-border ui-panel p-3">
                                    <p className="mb-2 text-xs ui-text-muted">Preview Harga:</p>
                                    {(() => {
                                        const product = products.find((item) => item._id === productForm.productId);
                                        if (!product) return null;
                                        const savings = product.price.basic - productForm.flashPrice;
                                        const discountPercent = product.price.basic
                                            ? Math.round((savings / product.price.basic) * 100)
                                            : 0;
                                        const validationError = validatePromoInput(
                                            product.price.basic,
                                            productForm.flashPrice,
                                            productForm.stock,
                                            0,
                                            product.costPrice || 0
                                        );

                                        return (
                                            <>
                                                <div className="flex flex-wrap items-center gap-3">
                                                    <span className="ui-text-muted line-through">
                                                        {formatCurrency(product.price.basic)}
                                                    </span>
                                                    <span className="text-xl font-bold ui-success-text">
                                                        {formatCurrency(productForm.flashPrice)}
                                                    </span>
                                                    <span className={`text-xs ${validationError ? 'ui-danger-text' : 'ui-accent-text'}`}>
                                                        {validationError ? 'Harga promo tidak valid' : `Hemat ${formatCurrency(savings)} (${discountPercent}%)`}
                                                    </span>
                                                </div>
                                                {validationError ? (
                                                    <p className="mt-2 text-xs ui-danger-text">{validationError}</p>
                                                ) : null}
                                            </>
                                        );
                                    })()}
                                </div>
                            ) : null}

                            <div className="flex justify-end gap-3 pt-4">
                                <button
                                    type="button"
                                    onClick={() => setShowProductModal(false)}
                                    className="rounded-lg border ui-border px-4 py-2 text-sm font-medium ui-text-muted hover:bg-[var(--ui-card-muted)]"
                                >
                                    Batal
                                </button>
                                <button
                                    type="submit"
                                    disabled={saving}
                                    className="rounded-lg ui-accent-solid px-4 py-2 text-sm font-medium ui-text  disabled:opacity-50"
                                >
                                    {saving ? 'Menambahkan...' : 'Tambah Produk'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            ) : null}

            {editingProduct ? (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
                    <div className="w-full max-w-md rounded-xl border ui-border ui-panel-muted shadow-xl" role="dialog" aria-modal="true" aria-labelledby="flash-sale-edit-product-title">
                        <div className="flex items-center justify-between border-b ui-border p-4">
                            <h2 id="flash-sale-edit-product-title" className="text-lg font-semibold ui-text">Edit Produk Flash Sale</h2>
                            <button onClick={() => setEditingProduct(null)} className="ui-text-muted hover:text-[var(--ui-text)]-muted" aria-label="Tutup form edit produk flash sale">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <div className="space-y-4 p-4">
                            <div className="rounded-lg ui-panel p-3">
                                <p className="text-sm font-medium ui-text">
                                    {editingProduct.product.productId?.name}
                                </p>
                                <p className="text-xs ui-text-muted">
                                    {editingProduct.product.productId?.code}
                                </p>
                                <p className="mt-1 text-xs ui-text-muted">
                                    Harga Normal:{' '}
                                    {formatCurrency(editingProduct.product.productId?.price.basic || 0)}
                                </p>
                            </div>

                            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                                <div>
                                    <label className={labelClass}>Harga Flash Sale</label>
                                    <input
                                        type="number"
                                        value={editProductForm.flashPrice}
                                        onChange={(event) =>
                                            setEditProductForm({
                                                ...editProductForm,
                                                flashPrice: Number(event.target.value)
                                            })
                                        }
                                        className={inputClass}
                                        min="0"
                                    />
                                </div>
                                <div>
                                    <label className={labelClass}>Stok</label>
                                    <input
                                        type="number"
                                        value={editProductForm.stock}
                                        onChange={(event) =>
                                            setEditProductForm({
                                                ...editProductForm,
                                                stock: Number(event.target.value)
                                            })
                                        }
                                        className={inputClass}
                                        min="1"
                                    />
                                </div>
                            </div>

                            <div className="rounded-lg ui-panel p-3">
                                <p className="mb-2 text-xs ui-text-muted">Preview:</p>
                                {(() => {
                                    const originalPrice = editingProduct.product.productId?.price.basic || 0;
                                    const savings = originalPrice - editProductForm.flashPrice;
                                    const discountPercent = originalPrice
                                        ? Math.round((savings / originalPrice) * 100)
                                        : 0;
                                    const validationError = validatePromoInput(
                                        originalPrice,
                                        editProductForm.flashPrice,
                                        editProductForm.stock,
                                        editingProduct.product.soldCount,
                                        editingProduct.product.productId?.costPrice || 0
                                    );

                                    return (
                                        <>
                                            <div className="flex flex-wrap items-center gap-3">
                                                <span className="ui-text-muted line-through">
                                                    {formatCurrency(originalPrice)}
                                                </span>
                                                <span className="text-xl font-bold ui-success-text">
                                                    {formatCurrency(editProductForm.flashPrice)}
                                                </span>
                                                <span className={`text-xs ${validationError ? 'ui-danger-text' : 'ui-accent-text'}`}>
                                                    {validationError ? 'Harga promo tidak valid' : `Hemat ${discountPercent}%`}
                                                </span>
                                            </div>
                                            <p className="mt-2 text-xs ui-text-muted">
                                                Terjual: {editingProduct.product.soldCount} / {editingProduct.product.stock}
                                            </p>
                                            {validationError ? (
                                                <p className="mt-2 text-xs ui-danger-text">{validationError}</p>
                                            ) : null}
                                        </>
                                    );
                                })()}
                            </div>

                            <div className="flex justify-end gap-3 pt-4">
                                <button
                                    type="button"
                                    onClick={() => setEditingProduct(null)}
                                    className="rounded-lg border ui-border px-4 py-2 text-sm font-medium ui-text-muted hover:bg-[var(--ui-card-muted)]"
                                >
                                    Batal
                                </button>
                                <button
                                    onClick={handleUpdateProduct}
                                    disabled={saving}
                                    className="rounded-lg ui-accent-solid px-4 py-2 text-sm font-medium ui-text  disabled:opacity-50"
                                >
                                    {saving ? 'Menyimpan...' : 'Simpan'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}

            {saleToDelete ? (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4">
                    <div className="w-full max-w-md rounded-xl border ui-border ui-panel-muted shadow-xl" role="dialog" aria-modal="true" aria-labelledby="flash-sale-delete-title">
                        <div className="border-b ui-border p-4">
                            <div className="flex items-center gap-3">
                                <div className="rounded-xl border p-2.5 ui-danger-chip">
                                    <Trash2 className="w-5 h-5" />
                                </div>
                                <div>
                                    <h2 id="flash-sale-delete-title" className="text-lg font-semibold ui-text">Hapus Flash Sale</h2>
                                    <p className="text-sm ui-text-muted">
                                        Tindakan ini akan menghapus promo beserta daftar produknya.
                                    </p>
                                </div>
                            </div>
                        </div>
                        <div className="space-y-4 p-4">
                            <div className="rounded-lg border ui-border ui-panel p-3">
                                <p className="text-sm font-semibold ui-text">{saleToDelete.name}</p>
                                <p className="mt-1 text-xs ui-text-muted">
                                    {formatDate(saleToDelete.startDate)} - {formatDate(saleToDelete.endDate)}
                                </p>
                                <p className="mt-2 text-xs ui-text-muted">
                                    {saleToDelete.summary?.productCount ?? saleToDelete.products.length} produk di promo ini.
                                </p>
                            </div>
                            {saleToDelete.deleteBlockedReason ? (
                                <div className="ui-warning-chip rounded-lg border p-3 text-sm">
                                    {saleToDelete.deleteBlockedReason}
                                </div>
                            ) : null}
                            <div className="flex justify-end gap-3">
                                <button
                                    type="button"
                                    onClick={() => setSaleToDelete(null)}
                                    className="rounded-lg border ui-border px-4 py-2 text-sm font-medium ui-text-muted hover:bg-[var(--ui-card-muted)]"
                                >
                                    Batal
                                </button>
                                <button
                                    type="button"
                                    onClick={confirmDeleteSale}
                                    disabled={deleting || saleToDelete.canDelete === false}
                                    className="ui-danger-action rounded-lg px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    {deleting ? 'Menghapus...' : 'Hapus'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            ) : null}
        </div>
    );
}
