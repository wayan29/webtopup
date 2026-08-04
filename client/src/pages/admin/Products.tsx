import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiV2 } from '../../api';
import { Plus, Search, Package, FileSpreadsheet, X, AlertCircle, Download, Sparkles, LayoutGrid, List, Edit2, ArrowUpDown, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, SlidersHorizontal, Power, Trash2 } from 'lucide-react';
import ProductModal from '../../components/admin/ProductModal';
import ProductSorting from '../../components/admin/ProductSorting';
import { useAuthStore } from '../../store/useAuthStore';

interface Category {
    _id: string;
    name: string;
    icon: string;
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

interface TvCategory {
    _id: string;
    name: string;
}

interface TvOperator {
    _id: string;
    name: string;
    categoryId: string;
}

interface TvJenis {
    _id: string;
    name: string;
    operatorId: string;
}

interface TvProduct {
    _id?: string;
    kode?: string;
    code?: string;
    buyer_sku_code?: string;
    nama?: string;
    name?: string;
    product_name?: string;
    nama_produk?: string;
    price?: number;
    harga?: number;
    buyer_product_price?: number;
}

interface DgProduct {
    _id?: string;
    buyer_sku_code?: string;
    product_name?: string;
    category?: string;
    brand?: string;
    price?: number;
    buyer_product_price?: number;
    seller_product_status?: boolean;
    desc?: string;
}

type TvSelected = {
    sku: string;
    code: string;
    name: string;
    costPrice: number;
    price: { basic: number; gold: number; platinum: number };
};

interface Product {
    _id: string;
    productId?: number;
    name: string;
    code: string;
    category: string;
    categoryId?: { _id: string; name: string; icon: string; status?: boolean } | null;
    operatorId?: { _id: string; name: string; status?: boolean } | string | null;
    productTypeId?: { _id: string; name: string; status?: boolean } | string | null;
    paymentType?: 'prabayar' | 'pascabayar';
    brand: string;
    costPrice: number;
    price: {
        basic: number;
        gold: number;
        platinum: number;
    };
    vendor?: {
        name: string;
        sku: string;
    };
    icon?: string;
    status: boolean;
    canPurchase?: boolean;
    visibilityIssues?: string[];
    createdAt?: string;
    updatedAt?: string;
    rewardPoints?: number;
}

interface MarginConfig {
    basic: number;
    gold: number;
    platinum: number;
}

export default function AdminProducts() {
    const { isOwner, hasPermission } = useAuthStore();
    const canManageProducts = isOwner || hasPermission('manageProducts');
    const canManageVendors = isOwner || hasPermission('manageVendors');
    const [products, setProducts] = useState<Product[]>([]);
    const [categories, setCategories] = useState<Category[]>([]);
    const [operatorsAll, setOperatorsAll] = useState<Operator[]>([]);
    const [productTypesAll, setProductTypesAll] = useState<ProductType[]>([]);
    const [marginConfig, setMarginConfig] = useState<MarginConfig>({ basic: 10, gold: 5, platinum: 0 });
    const [loading, setLoading] = useState(true);
    const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
    const [searchTerm, setSearchTerm] = useState('');
    const [categoryFilter, setCategoryFilter] = useState('');
    const [operatorFilter, setOperatorFilter] = useState('');
    const [productTypeFilter, setProductTypeFilter] = useState('');
    const [statusFilter, setStatusFilter] = useState('all');
    const [currentPage, setCurrentPage] = useState(1);
    const [pageSize, setPageSize] = useState(20);
    const [showFilters, setShowFilters] = useState(false);

    // Filter search state


    // Modal State
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [isBulkModalOpen, setIsBulkModalOpen] = useState(false);
    const [isBulkPriceOpen, setIsBulkPriceOpen] = useState(false);
    const [isAddTypeModalOpen, setIsAddTypeModalOpen] = useState(false);
    const [isVendorImportOpen, setIsVendorImportOpen] = useState(false);
    const [isSortingOpen, setIsSortingOpen] = useState(false);
    const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
    const [selectedDeleteProduct, setSelectedDeleteProduct] = useState<Product | null>(null);
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const [dataSource, setDataSource] = useState<'api-v2' | 'api-v1'>('api-v2');
    const [showDeleteModal, setShowDeleteModal] = useState(false);
    const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
    const latestRequestId = useRef(0);
    const dgProductsRequestId = useRef(0);
    const tvOperatorsRequestId = useRef(0);
    const tvJenisRequestId = useRef(0);
    const tvProductsRequestId = useRef(0);

    // Bulk upload state
    const [bulkData, setBulkData] = useState('');
    const [bulkLoading, setBulkLoading] = useState(false);
    const [bulkCategoryId, setBulkCategoryId] = useState('');
    const [bulkOperatorId, setBulkOperatorId] = useState('');
    const [bulkProductTypeId, setBulkProductTypeId] = useState('');

    // Bulk price update state
    const [bulkPriceMap, setBulkPriceMap] = useState<Record<string, Partial<Product['price']>>>({});
    const [bulkPriceSearch, setBulkPriceSearch] = useState('');
    const [bulkPriceCategory, setBulkPriceCategory] = useState('');
    const [bulkPriceOperator, setBulkPriceOperator] = useState('');
    const [bulkPriceProductType, setBulkPriceProductType] = useState('');
    const [bulkPriceLoading, setBulkPriceLoading] = useState(false);

    // Tokovoucher import state
    const [tvCategories, setTvCategories] = useState<TvCategory[]>([]);
    const [tvOperators, setTvOperators] = useState<TvOperator[]>([]);
    const [tvJenis, setTvJenis] = useState<TvJenis[]>([]);
    const [tvProducts, setTvProducts] = useState<TvProduct[]>([]);
    const [tvSelectedCategory, setTvSelectedCategory] = useState('');
    const [tvSelectedOperator, setTvSelectedOperator] = useState('');
    const [tvSelectedJenis, setTvSelectedJenis] = useState('');
    const [tvLoading, setTvLoading] = useState(false);
    const [tvSearch, setTvSearch] = useState('');
    const [tvSelectedMap, setTvSelectedMap] = useState<Record<string, TvSelected>>({});

    // Internal mapping for vendor import
    const [mapCategoryId, setMapCategoryId] = useState('');
    const [mapOperatorId, setMapOperatorId] = useState('');
    const [mapProductTypeId, setMapProductTypeId] = useState('');

    // Digiflazz import state
    const [isDgImportOpen, setIsDgImportOpen] = useState(false);
    const [dgCategories, setDgCategories] = useState<string[]>([]);
    const [dgBrands, setDgBrands] = useState<string[]>([]);
    const [dgProducts, setDgProducts] = useState<DgProduct[]>([]);
    const [dgSelectedCategory, setDgSelectedCategory] = useState('');
    const [dgSelectedBrand, setDgSelectedBrand] = useState('');
    const [dgLoading, setDgLoading] = useState(false);
    const [dgSearch, setDgSearch] = useState('');
    const [dgSelectedMap, setDgSelectedMap] = useState<Record<string, TvSelected>>({});
    const [dgMapCategoryId, setDgMapCategoryId] = useState('');
    const [dgMapOperatorId, setDgMapOperatorId] = useState('');
    const [dgMapProductTypeId, setDgMapProductTypeId] = useState('');

    const fetchData = useCallback(async () => {
        const requestId = latestRequestId.current + 1;
        latestRequestId.current = requestId;
        try {
            setLoading(true);
            const productsRequest = apiV2.get('/products/admin/all')
                .then((response) => {
                    setDataSource('api-v2');
                    return response;
                });
            const categoriesRequest = apiV2.get('/categories/admin/all');
            const operatorsRequest = apiV2.get('/operators/admin/all');
            const productTypesRequest = apiV2.get('/product-types/admin/all').catch(() => ({ data: [] }));
            const [productsRes, categoriesRes, operatorsRes, productTypesRes, marginsRes] = await Promise.all([
                productsRequest,
                categoriesRequest,
                operatorsRequest,
                productTypesRequest,
                apiV2
                    .get('/margins')
                    .catch(() => ({ data: { success: true, data: { basic: 10, gold: 5, platinum: 0 } } }))
            ]);
            if (requestId !== latestRequestId.current) return;
            setProducts(productsRes.data);
            setCategories(categoriesRes.data);
            const normOps = (operatorsRes.data || []).map((o: any) => ({
                ...o,
                categoryId: typeof o.categoryId === 'object' ? (o.categoryId?._id || '') : o.categoryId
            }));
            const normPT = (productTypesRes.data || []).map((pt: any) => ({
                ...pt,
                categoryId: typeof pt.categoryId === 'object' ? (pt.categoryId?._id || '') : pt.categoryId,
                operatorId: typeof pt.operatorId === 'object' ? (pt.operatorId?._id || '') : pt.operatorId
            }));
            setOperatorsAll(normOps);
            setProductTypesAll(normPT);
            if (marginsRes.data?.success && marginsRes.data?.data) {
                setMarginConfig({
                    basic: marginsRes.data.data.basic ?? 10,
                    gold: marginsRes.data.data.gold ?? 5,
                    platinum: marginsRes.data.data.platinum ?? 0
                });
            }
        } catch (error: any) {
            if (requestId !== latestRequestId.current) return;
            console.error('Failed to fetch data', error);
            setMessage({ type: 'error', text: error.response?.data?.message || 'Gagal memuat data produk terbaru' });
        } finally {
            if (requestId === latestRequestId.current) {
                setLoading(false);
            }
        }
    }, []);

    useEffect(() => {
        fetchData();
    }, [fetchData]);

    useEffect(() => {
        const handleRefresh = () => fetchData();
        window.addEventListener('admin:refresh-current-page', handleRefresh);
        return () => window.removeEventListener('admin:refresh-current-page', handleRefresh);
    }, [fetchData]);

    // Auto-hide message
    useEffect(() => {
        if (message) {
            const timer = setTimeout(() => setMessage(null), 3000);
            return () => clearTimeout(timer);
        }
    }, [message]);

    const handleAddProduct = () => {
        if (!canManageProducts) {
            setMessage({ type: 'error', text: 'Akun ini hanya dapat melihat produk. Perlu izin kelola produk untuk menambah.' });
            return;
        }
        setIsAddTypeModalOpen(true);
    };

    const handleSingleAdd = () => {
        if (!canManageProducts) return;
        setIsAddTypeModalOpen(false);
        setSelectedProduct(null);
        setIsModalOpen(true);
    };

    const handleBulkAdd = () => {
        if (!canManageProducts) return;
        setIsAddTypeModalOpen(false);
        setBulkData('');
        setBulkCategoryId('');
        setBulkOperatorId('');
        setBulkProductTypeId('');
        setIsBulkModalOpen(true);
    };

    const handleVendorImportFromSelector = () => {
        if (!canManageProducts || !canManageVendors) {
            setMessage({ type: 'error', text: 'Import vendor membutuhkan izin kelola produk dan kelola vendor' });
            return;
        }
        setIsAddTypeModalOpen(false);
        handleVendorImportOpen();
    };

    const handleDgImportFromSelector = () => {
        if (!canManageProducts || !canManageVendors) {
            setMessage({ type: 'error', text: 'Import vendor membutuhkan izin kelola produk dan kelola vendor' });
            return;
        }
        setIsAddTypeModalOpen(false);
        handleDgImportOpen();
    };

    const handleDgImportOpen = async () => {
        if (!canManageProducts || !canManageVendors) {
            setMessage({ type: 'error', text: 'Import Digiflazz membutuhkan izin kelola produk dan kelola vendor' });
            return;
        }
        setIsDgImportOpen(true);
        setDgSelectedCategory('');
        setDgSelectedBrand('');
        setDgProducts([]);
        setDgSelectedMap({});
        setDgSearch('');
        setDgMapCategoryId('');
        setDgMapOperatorId('');
        setDgMapProductTypeId('');
        try {
            setDgLoading(true);
            const res = await apiV2
                .get('/vendors/digiflazz/pricelist?limit=1');
            if (res.data?.success === false) {
                setMessage({ type: 'error', text: res.data?.message || 'Gagal memuat data Digiflazz' });
            } else {
                setDgCategories(res.data?.filters?.categories || res.data?.categories || []);
                setDgBrands(res.data?.filters?.brands || res.data?.brands || []);
            }
        } catch (error) {
            console.error('Failed to load DG data', error);
            setMessage({ type: 'error', text: 'Gagal memuat data Digiflazz' });
        } finally {
            setDgLoading(false);
        }
    };

    const fetchDgProducts = async (category: string, brand: string) => {
        const requestId = dgProductsRequestId.current + 1;
        dgProductsRequestId.current = requestId;
        try {
            setDgLoading(true);
            const params = new URLSearchParams();
            if (category) params.set('category', category);
            if (brand) params.set('brand', brand);
            params.set('limit', '500');
            const path = `/vendors/digiflazz/pricelist?${params.toString()}`;
            const res = await apiV2.get(path);
            if (requestId !== dgProductsRequestId.current) return;
            if (res.data?.success === false) {
                setMessage({ type: 'error', text: res.data?.message || 'Gagal memuat produk Digiflazz' });
                setDgProducts([]);
            } else {
                setDgProducts(res.data?.data || []);
                setDgCategories(res.data?.filters?.categories || res.data?.categories || []);
                setDgBrands(res.data?.filters?.brands || res.data?.brands || []);
            }
        } catch (error) {
            if (requestId !== dgProductsRequestId.current) return;
            console.error('Failed to load DG products', error);
            setMessage({ type: 'error', text: 'Gagal memuat produk Digiflazz' });
        } finally {
            if (requestId === dgProductsRequestId.current) {
                setDgLoading(false);
            }
        }
    };

    const handleDgSelect = (item: DgProduct, checked: boolean) => {
        const sku = item.buyer_sku_code || '';
        if (!sku) {
            setMessage({ type: 'error', text: 'Produk Digiflazz tanpa SKU tidak bisa dipilih' });
            return;
        }
        const name = item.product_name || sku || 'Produk Tanpa Nama';
        const cost = item.buyer_product_price || item.price || 0;
        if (!checked) {
            const next = { ...dgSelectedMap };
            delete next[sku];
            setDgSelectedMap(next);
            return;
        }
        setDgSelectedMap({
            ...dgSelectedMap,
            [sku]: {
                sku,
                code: sku,
                name,
                costPrice: sanitizeAmount(cost),
                price: computePrices(cost)
            }
        });
    };

    const handleDgFieldChange = (sku: string, field: 'code' | 'basic' | 'gold' | 'platinum', value: string) => {
        const next = { ...dgSelectedMap };
        const row = next[sku];
        if (!row) return;
        if (field === 'code') {
            row.code = value;
        } else {
            const num = sanitizeAmount(value);
            if (field === 'basic') row.price.basic = num;
            if (field === 'gold') row.price.gold = num;
            if (field === 'platinum') row.price.platinum = num;
        }
        setDgSelectedMap(next);
    };

    const handleDgImport = async () => {
        if (!canManageProducts || !canManageVendors) {
            setMessage({ type: 'error', text: 'Import Digiflazz membutuhkan izin kelola produk dan kelola vendor' });
            return;
        }
        const items = Object.values(dgSelectedMap);
        if (items.length === 0) {
            setMessage({ type: 'error', text: 'Pilih minimal satu produk Digiflazz' });
            return;
        }
        if (!dgMapCategoryId || !dgMapOperatorId || !dgMapProductTypeId) {
            setMessage({ type: 'error', text: 'Pilih kategori, operator, dan jenis produk internal terlebih dahulu' });
            return;
        }
        const categoryName = categories.find((c) => c._id === dgMapCategoryId)?.name;
        const operatorName = operatorsAll.find((o) => o._id === dgMapOperatorId)?.name;
        if (!categoryName || !operatorName) {
            setMessage({ type: 'error', text: 'Kategori atau operator tidak ditemukan' });
            return;
        }
        setDgLoading(true);
        let success = 0;
        let fail = 0;
        let skipped = 0;
        for (const item of items) {
            if (!item.code || !item.name) {
                skipped++;
                continue;
            }
            try {
                const payload = {
                    code: item.code,
                    name: item.name,
                    category: categoryName,
                    categoryId: dgMapCategoryId || undefined,
                    operatorId: dgMapOperatorId || undefined,
                    productTypeId: dgMapProductTypeId,
                    paymentType: 'prabayar',
                    brand: operatorName,
                    costPrice: item.costPrice,
                    price: item.price,
                    vendor: { name: 'Digiflazz', sku: item.sku },
                    status: true
                };
                await apiV2.post('/products', payload);
                success++;
            } catch (error: any) {
                console.error('Import failed', error);
                if (error?.response?.status === 409) {
                    skipped++;
                } else {
                    fail++;
                }
            }
        }
        setDgLoading(false);
        setIsDgImportOpen(false);
        fetchData();
        let msg = `Import selesai: ${success} berhasil`;
        if (skipped > 0) msg += `, ${skipped} duplikat/dilewati`;
        if (fail > 0) msg += `, ${fail} gagal`;
        setMessage({
            type: success > 0 ? 'success' : 'error',
            text: msg
        });
    };

    const filteredDgMapOperators = useMemo(() => {
        return operatorsAll.filter((o) => !dgMapCategoryId || o.categoryId === dgMapCategoryId);
    }, [operatorsAll, dgMapCategoryId]);

    const filteredDgMapProductTypes = useMemo(() => {
        return productTypesAll.filter((pt) => {
            const matchCat = !dgMapCategoryId || pt.categoryId === dgMapCategoryId;
            const matchOp = !dgMapOperatorId || pt.operatorId === dgMapOperatorId;
            return matchCat && matchOp;
        });
    }, [productTypesAll, dgMapCategoryId, dgMapOperatorId]);

    const filteredDgProducts = useMemo(() => {
        const term = dgSearch.toLowerCase();
        return dgProducts.filter((p) => {
            const sku = (p.buyer_sku_code || '').toLowerCase();
            const name = (p.product_name || '').toLowerCase();
            return !term || sku.includes(term) || name.includes(term);
        });
    }, [dgProducts, dgSearch]);

    const handleVendorImportOpen = async () => {
        if (!canManageProducts || !canManageVendors) {
            setMessage({ type: 'error', text: 'Import Tokovoucher membutuhkan izin kelola produk dan kelola vendor' });
            return;
        }
        setIsVendorImportOpen(true);
        setTvSelectedCategory('');
        setTvSelectedOperator('');
        setTvSelectedJenis('');
        setTvProducts([]);
        setTvSelectedMap({});
        setTvSearch('');
        setMapCategoryId('');
        setMapOperatorId('');
        setMapProductTypeId('');
        try {
            setTvLoading(true);
            const res = await apiV2.get('/vendors/tokovoucher/categories');
            if (res.data?.success === false) {
                setMessage({ type: 'error', text: res.data?.message || 'Gagal memuat kategori Tokovoucher' });
                setTvCategories([]);
            } else {
                setTvCategories(normCategories(toArray<any>(res.data)));
            }
        } catch (error) {
            console.error('Failed to load TV categories', error);
            setMessage({ type: 'error', text: 'Gagal memuat kategori Tokovoucher' });
        } finally {
            setTvLoading(false);
        }
    };

    const handleEdit = (product: Product) => {
        if (!canManageProducts) return;
        setSelectedProduct(product);
        setIsModalOpen(true);
    };

    const handleToggleStatus = async (product: Product) => {
        if (!canManageProducts) return;
        try {
            setActionLoadingId(product._id);
            const payload = { status: !product.status };
            await apiV2.put(`/products/${product._id}`, payload);
            setMessage({
                type: 'success',
                text: `Produk ${!product.status ? 'diaktifkan' : 'dinonaktifkan'}`
            });
            fetchData();
        } catch (error: any) {
            console.error('Failed to toggle product status', error);
            setMessage({ type: 'error', text: error.response?.data?.message || 'Gagal mengubah status produk' });
        } finally {
            setActionLoadingId(null);
        }
    };

    const handleDeleteProduct = async () => {
        if (!selectedDeleteProduct || !canManageProducts) return;

        try {
            setActionLoadingId(selectedDeleteProduct._id);
            await apiV2
                .delete(`/products/${selectedDeleteProduct._id}`);
            setMessage({
                type: 'success',
                text: selectedDeleteProduct.status
                    ? 'Produk berhasil diarsipkan'
                    : 'Produk nonaktif berhasil dihapus permanen'
            });
            setShowDeleteModal(false);
            setSelectedDeleteProduct(null);
            fetchData();
        } catch (error: any) {
            console.error('Failed to delete product', error);
            setMessage({ type: 'error', text: error.response?.data?.message || 'Gagal menghapus produk' });
        } finally {
            setActionLoadingId(null);
        }
    };



    const fetchTvOperators = async (categoryId: string) => {
        const requestId = tvOperatorsRequestId.current + 1;
        tvOperatorsRequestId.current = requestId;
        try {
            setTvLoading(true);
            const res = await apiV2.get(`/vendors/tokovoucher/operators?categoryId=${categoryId}`);
            if (requestId !== tvOperatorsRequestId.current) return;
            if (res.data?.success === false) {
                setMessage({ type: 'error', text: res.data?.message || 'Gagal memuat operator Tokovoucher' });
                setTvOperators([]);
            } else {
                setTvOperators(normOperators(toArray<any>(res.data), categoryId));
            }
        } catch (error) {
            if (requestId !== tvOperatorsRequestId.current) return;
            console.error('Failed to load operators', error);
            setMessage({ type: 'error', text: 'Gagal memuat operator Tokovoucher' });
        } finally {
            if (requestId === tvOperatorsRequestId.current) {
                setTvLoading(false);
            }
        }
    };

    const fetchTvJenis = async (operatorId: string) => {
        const requestId = tvJenisRequestId.current + 1;
        tvJenisRequestId.current = requestId;
        try {
            setTvLoading(true);
            const res = await apiV2.get(`/vendors/tokovoucher/jenis?operatorId=${operatorId}`);
            if (requestId !== tvJenisRequestId.current) return;
            if (res.data?.success === false) {
                setMessage({ type: 'error', text: res.data?.message || 'Gagal memuat jenis Tokovoucher' });
                setTvJenis([]);
            } else {
                setTvJenis(normJenis(toArray<any>(res.data), operatorId));
            }
        } catch (error) {
            if (requestId !== tvJenisRequestId.current) return;
            console.error('Failed to load jenis', error);
            setMessage({ type: 'error', text: 'Gagal memuat jenis Tokovoucher' });
        } finally {
            if (requestId === tvJenisRequestId.current) {
                setTvLoading(false);
            }
        }
    };

    const fetchTvProducts = async (jenisId: string) => {
        const requestId = tvProductsRequestId.current + 1;
        tvProductsRequestId.current = requestId;
        try {
            setTvLoading(true);
            const res = await apiV2.get(`/vendors/tokovoucher/products?jenisId=${jenisId}`);
            if (requestId !== tvProductsRequestId.current) return;
            if (res.data?.success === false) {
                setMessage({ type: 'error', text: res.data?.message || 'Gagal memuat produk Tokovoucher' });
                setTvProducts([]);
            } else {
                setTvProducts(toArray<TvProduct>(res.data));
            }
        } catch (error) {
            if (requestId !== tvProductsRequestId.current) return;
            console.error('Failed to load products', error);
            setMessage({ type: 'error', text: 'Gagal memuat produk Tokovoucher' });
        } finally {
            if (requestId === tvProductsRequestId.current) {
                setTvLoading(false);
            }
        }
    };

    const toArray = <T,>(val: any): T[] => {
        if (Array.isArray(val)) return val as T[];
        if (val?.data && Array.isArray(val.data)) return val.data as T[];
        return [];
    };

    const normCategories = (list: any[]): TvCategory[] =>
        list
            .map((c: any) => ({
                _id: String(c.id ?? c._id ?? c.categoryId ?? ''),
                name: c.name ?? c.category ?? c.nama ?? 'Kategori'
            }))
            .filter((c) => c._id);

    const normOperators = (list: any[], categoryIdFallback: string): TvOperator[] =>
        list
            .map((o: any) => ({
                _id: String(o.id ?? o._id ?? o.operatorId ?? ''),
                name: o.name ?? o.operator ?? o.nama ?? 'Operator',
                categoryId: String(o.category_id ?? o.categoryId ?? categoryIdFallback)
            }))
            .filter((o) => o._id);

    const normJenis = (list: any[], operatorIdFallback: string): TvJenis[] =>
        list
            .map((j: any) => ({
                _id: String(j.id ?? j._id ?? j.jenisId ?? ''),
                name: j.name ?? j.jenis ?? j.nama ?? 'Jenis',
                operatorId: String(j.operator_id ?? j.operatorId ?? operatorIdFallback)
            }))
            .filter((j) => j._id);

    const sanitizeAmount = (value: unknown) => Math.max(0, Math.round(Number(value) || 0));

    const hasLossPrice = (costPrice: number, price: Partial<Product['price']>) => (
        (price.basic ?? 0) < costPrice ||
        (price.gold ?? 0) < costPrice ||
        (price.platinum ?? 0) < costPrice
    );

    const computePrices = (cost: number) => {
        const safeCost = sanitizeAmount(cost);
        return {
            basic: Math.round(safeCost * (1 + marginConfig.basic / 100)),
            gold: Math.round(safeCost * (1 + marginConfig.gold / 100)),
            platinum: Math.round(safeCost * (1 + marginConfig.platinum / 100))
        };
    };

    const handleTvSelect = (item: TvProduct, checked: boolean) => {
        const sku = item.buyer_sku_code || item.code || item.kode || '';
        if (!sku) {
            setMessage({ type: 'error', text: 'Produk Tokovoucher tanpa SKU tidak bisa dipilih' });
            return;
        }
        const name = item.product_name || item.nama_produk || item.name || item.nama || sku || 'Produk Tanpa Nama';
        const cost = item.buyer_product_price || item.price || item.harga || 0;
        if (!checked) {
            const next = { ...tvSelectedMap };
            delete next[sku];
            setTvSelectedMap(next);
            return;
        }
        setTvSelectedMap({
            ...tvSelectedMap,
            [sku]: {
                sku,
                code: sku,
                name,
                costPrice: sanitizeAmount(cost),
                price: computePrices(cost)
            }
        });
    };

    const handleTvFieldChange = (sku: string, field: 'code' | 'basic' | 'gold' | 'platinum', value: string) => {
        const next = { ...tvSelectedMap };
        const row = next[sku];
        if (!row) return;
        if (field === 'code') {
            row.code = value;
        } else {
            const num = sanitizeAmount(value);
            if (field === 'basic') row.price.basic = num;
            if (field === 'gold') row.price.gold = num;
            if (field === 'platinum') row.price.platinum = num;
        }
        setTvSelectedMap(next);
    };

    const handleTvImport = async () => {
        if (!canManageProducts || !canManageVendors) {
            setMessage({ type: 'error', text: 'Import Tokovoucher membutuhkan izin kelola produk dan kelola vendor' });
            return;
        }
        const items = Object.values(tvSelectedMap);
        if (items.length === 0) {
            setMessage({ type: 'error', text: 'Pilih minimal satu produk Tokovoucher' });
            return;
        }
        if (!mapCategoryId || !mapOperatorId || !mapProductTypeId) {
            setMessage({ type: 'error', text: 'Pilih kategori, operator, dan jenis produk internal terlebih dahulu' });
            return;
        }
        const categoryName = categories.find((c) => c._id === mapCategoryId)?.name;
        const operatorName = operatorsAll.find((o) => o._id === mapOperatorId)?.name;
        if (!categoryName || !operatorName) {
            setMessage({ type: 'error', text: 'Kategori atau operator tidak ditemukan' });
            return;
        }
        setTvLoading(true);
        let success = 0;
        let fail = 0;
        let skipped = 0;
        for (const item of items) {
            if (!item.code || !item.name) {
                skipped++;
                continue;
            }
            try {
                const payload = {
                    code: item.code,
                    name: item.name,
                    category: categoryName,
                    categoryId: mapCategoryId || undefined,
                    operatorId: mapOperatorId || undefined,
                    productTypeId: mapProductTypeId,
                    paymentType: 'prabayar',
                    brand: operatorName,
                    costPrice: item.costPrice,
                    price: item.price,
                    vendor: { name: 'Tokovoucher', sku: item.sku },
                    status: true
                };
                await apiV2.post('/products', payload);
                success++;
            } catch (error: any) {
                console.error('Import failed', error);
                if (error?.response?.status === 409) {
                    skipped++;
                } else {
                    fail++;
                }
            }
        }
        setTvLoading(false);
        setIsVendorImportOpen(false);
        fetchData();
        let msg = `Import selesai: ${success} berhasil`;
        if (skipped > 0) msg += `, ${skipped} duplikat (dilewati)`;
        if (fail > 0) msg += `, ${fail} gagal`;
        setMessage({
            type: success > 0 ? 'success' : 'error',
            text: msg
        });
    };

    const handleTvCategoryChange = async (val: string) => {
        setTvSelectedCategory(val);
        setTvSelectedOperator('');
        setTvSelectedJenis('');
        setTvOperators([]);
        setTvJenis([]);
        setTvProducts([]);
        setTvSelectedMap({});
        if (val) await fetchTvOperators(val);
    };

    const handleTvOperatorChange = async (val: string) => {
        setTvSelectedOperator(val);
        setTvSelectedJenis('');
        setTvJenis([]);
        setTvProducts([]);
        setTvSelectedMap({});
        if (val) await fetchTvJenis(val);
    };

    const handleTvJenisChange = async (val: string) => {
        setTvSelectedJenis(val);
        setTvProducts([]);
        setTvSelectedMap({});
        if (val) await fetchTvProducts(val);
    };

    const handleSubmit = async (productData: any) => {
        if (!canManageProducts) {
            const messageText = 'Akun ini hanya dapat melihat produk. Perlu izin kelola produk untuk menyimpan.';
            setMessage({ type: 'error', text: messageText });
            throw new Error(messageText);
        }

        const categoryId = typeof productData.categoryId === 'object' ? productData.categoryId?._id : productData.categoryId;
        const operatorId = typeof productData.operatorId === 'object' ? productData.operatorId?._id : productData.operatorId;
        const productTypeId = typeof productData.productTypeId === 'object' ? productData.productTypeId?._id : productData.productTypeId;

        if (!categoryId || !operatorId || !productTypeId) {
            const messageText = 'Kategori, operator, dan jenis produk wajib dipilih sebelum produk disimpan';
            setMessage({
                type: 'error',
                text: messageText
            });
            throw new Error(messageText);
        }

        const costPrice = sanitizeAmount(productData.costPrice);
        const price = {
            basic: sanitizeAmount(productData.price?.basic),
            gold: sanitizeAmount(productData.price?.gold),
            platinum: sanitizeAmount(productData.price?.platinum)
        };
        const rewardPoints = sanitizeAmount(productData.rewardPoints);
        const payload = {
            ...productData,
            categoryId,
            operatorId,
            productTypeId,
            costPrice,
            price,
            rewardPoints
        };

        if (hasLossPrice(costPrice, price)) {
            const messageText = 'Harga jual tidak boleh lebih kecil dari harga modal';
            setMessage({ type: 'error', text: messageText });
            throw new Error(messageText);
        }

        try {
            if (selectedProduct) {
                await apiV2
                    .put(`/products/${selectedProduct._id}`, payload);
                setMessage({ type: 'success', text: 'Produk berhasil diperbarui' });
            } else {
                await apiV2.post('/products', payload);
                setMessage({ type: 'success', text: 'Produk berhasil ditambahkan' });
            }
            await fetchData();
        } catch (error) {
            console.error('Failed to save product', error);
            const respMsg = (error as any)?.response?.data?.message || (error as any)?.message;
            setMessage({ type: 'error', text: respMsg || 'Gagal menyimpan produk' });
            throw error;
        }
    };

    const handleBulkSubmit = async () => {
        if (!canManageProducts) {
            setMessage({ type: 'error', text: 'Akun ini hanya dapat melihat produk. Perlu izin kelola produk untuk bulk upload.' });
            return;
        }

        if (!bulkData.trim()) {
            setMessage({ type: 'error', text: 'Data tidak boleh kosong' });
            return;
        }

        if (!bulkCategoryId || !bulkOperatorId || !bulkProductTypeId) {
            setMessage({
                type: 'error',
                text: 'Pilih kategori, operator, dan jenis produk internal sebelum upload bulk'
            });
            return;
        }

        setBulkLoading(true);
        try {
            const lines = bulkData.trim().split('\n');
            const products: any[] = [];
            const categoryName = categories.find((c) => c._id === bulkCategoryId)?.name;
            const operatorName = operatorsAll.find((o) => o._id === bulkOperatorId)?.name;

            if (!categoryName || !operatorName) {
                setMessage({ type: 'error', text: 'Kategori atau operator internal tidak ditemukan' });
                setBulkLoading(false);
                return;
            }

            for (const line of lines) {
                const parts = line.split(',').map(p => p.trim());
                if (parts.length >= 8) {
                    products.push({
                        code: parts[0],
                        name: parts[1],
                        category: categoryName,
                        categoryId: bulkCategoryId,
                        operatorId: bulkOperatorId,
                        productTypeId: bulkProductTypeId,
                        brand: operatorName,
                        costPrice: parseInt(parts[4]) || 0,
                        price: {
                            basic: parseInt(parts[5]) || 0,
                            gold: parseInt(parts[6]) || parseInt(parts[5]) || 0,
                            platinum: parseInt(parts[7]) || parseInt(parts[5]) || 0,
                        },
                        status: true
                    });
                } else if (parts.length >= 6) {
                    products.push({
                        code: parts[0],
                        name: parts[1],
                        category: categoryName,
                        categoryId: bulkCategoryId,
                        operatorId: bulkOperatorId,
                        productTypeId: bulkProductTypeId,
                        brand: operatorName,
                        costPrice: parseInt(parts[2]) || 0,
                        price: {
                            basic: parseInt(parts[3]) || 0,
                            gold: parseInt(parts[4]) || parseInt(parts[3]) || 0,
                            platinum: parseInt(parts[5]) || parseInt(parts[3]) || 0,
                        },
                        status: true
                    });
                }
            }

            if (products.length === 0) {
                setMessage({ type: 'error', text: 'Format data tidak valid' });
                setBulkLoading(false);
                return;
            }

            // Send bulk create request
            let successCount = 0;
            let errorCount = 0;
            for (const product of products) {
                try {
                    await apiV2.post('/products', product);
                    successCount++;
                } catch {
                    errorCount++;
                }
            }

            setMessage({
                type: successCount > 0 ? 'success' : 'error',
                text: `${successCount} produk berhasil ditambahkan${errorCount > 0 ? `, ${errorCount} gagal` : ''}`
            });
            setIsBulkModalOpen(false);
            fetchData();
        } catch (error) {
            console.error('Bulk upload failed', error);
            setMessage({ type: 'error', text: 'Gagal upload bulk' });
        } finally {
            setBulkLoading(false);
        }
    };

    const handleBulkPriceChange = (id: string, field: keyof Product['price'], value: string) => {
        const num = value === '' ? undefined : Number(value);
        setBulkPriceMap((prev) => ({
            ...prev,
            [id]: {
                ...prev[id],
                [field]: Number.isNaN(num) ? prev[id]?.[field] : num
            }
        }));
    };

    const openBulkPriceModal = () => {
        if (!canManageProducts) {
            setMessage({ type: 'error', text: 'Akun ini hanya dapat melihat produk. Perlu izin kelola produk untuk update harga.' });
            return;
        }
        setBulkPriceMap({});
        setBulkPriceSearch('');
        setBulkPriceCategory('');
        setBulkPriceOperator('');
        setBulkPriceProductType('');
        setIsBulkPriceOpen(true);
    };

    const handleBulkPriceSubmit = async () => {
        if (!canManageProducts) {
            setMessage({ type: 'error', text: 'Akun ini hanya dapat melihat produk. Perlu izin kelola produk untuk update harga.' });
            return;
        }

        if (Object.keys(bulkPriceMap).length === 0) {
            setMessage({ type: 'error', text: 'Isi minimal satu kolom harga' });
            return;
        }

        const invalidLossCount = Object.entries(bulkPriceMap).filter(([productId, priceChanges]) => {
            const product = products.find((p) => p._id === productId);
            if (!product) return false;
            const candidatePrice = { ...(product.price || {}), ...priceChanges };
            return hasLossPrice(product.costPrice || 0, candidatePrice);
        }).length;

        if (invalidLossCount > 0) {
            setMessage({ type: 'error', text: `${invalidLossCount} produk memiliki harga jual di bawah modal. Perbaiki sebelum menyimpan.` });
            return;
        }

        setBulkPriceLoading(true);
        let success = 0;
        let notFound = 0;
        let noChange = 0;
        let failed = 0;

        for (const [productId, priceChanges] of Object.entries(bulkPriceMap)) {
            const product = products.find((p) => p._id === productId);
            if (!product) {
                notFound++;
                continue;
            }

            const updates: Partial<Product['price']> = {};
            (['basic', 'gold', 'platinum'] as const).forEach((tier) => {
                const value = priceChanges[tier];
                if (value !== undefined && !Number.isNaN(value as number)) {
                    updates[tier] = Number(value);
                }
            });

            if (Object.keys(updates).length === 0) {
                noChange++;
                continue;
            }

            try {
                const payload = {
                    price: updates,
                };
                await apiV2.put(`/products/${product._id}`, payload);
                success++;
            } catch (error) {
                console.error('Bulk price update failed', error);
                failed++;
            }
        }

        setBulkPriceLoading(false);
        setIsBulkPriceOpen(false);
        setBulkPriceMap({});
        fetchData();

        const summaryParts = [] as string[];
        if (success) summaryParts.push(`${success} produk diperbarui`);
        if (noChange) summaryParts.push(`${noChange} tanpa perubahan`);
        if (notFound) summaryParts.push(`${notFound} tidak ditemukan`);
        if (failed) summaryParts.push(`${failed} gagal`);

        setMessage({
            type: success > 0 ? 'success' : 'error',
            text: summaryParts.length ? `Update harga selesai: ${summaryParts.join(', ')}` : 'Tidak ada perubahan dikirim'
        });
    };

    const filteredTvProducts = useMemo(() => {
        const term = tvSearch.toLowerCase();
        return tvProducts.filter((p) => {
            const sku = (p.buyer_sku_code || p.code || p.kode || '').toLowerCase();
            const name = (p.product_name || p.nama || '').toLowerCase();
            return !term || sku.includes(term) || name.includes(term);
        });
    }, [tvProducts, tvSearch]);

    const filteredBulkOperators = useMemo(() => {
        return operatorsAll.filter((o) => !bulkPriceCategory || o.categoryId === bulkPriceCategory);
    }, [operatorsAll, bulkPriceCategory]);

    const filteredBulkProductTypes = useMemo(() => {
        return productTypesAll.filter((pt) => {
            const matchCat = !bulkPriceCategory || pt.categoryId === bulkPriceCategory;
            const matchOp = !bulkPriceOperator || pt.operatorId === bulkPriceOperator;
            return matchCat && matchOp;
        });
    }, [productTypesAll, bulkPriceCategory, bulkPriceOperator]);

    const filteredProducts = useMemo(() => {
        return products.filter((p) => {
            const matchesSearch =
                p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                p.code.toLowerCase().includes(searchTerm.toLowerCase()) ||
                p.brand.toLowerCase().includes(searchTerm.toLowerCase());

            const selectedCategory = categories.find(c => c._id === categoryFilter);
            const matchesCategory = categoryFilter
                ? (p.categoryId?._id === categoryFilter || (selectedCategory && p.category?.toLowerCase() === selectedCategory.name.toLowerCase()))
                : true;

            const opId = typeof p.operatorId === 'object' ? (p.operatorId as any)?._id : p.operatorId;
            const selectedOperator = operatorsAll.find(o => o._id === operatorFilter);
            const matchesOperator = operatorFilter
                ? (opId === operatorFilter || (selectedOperator && p.brand?.toLowerCase() === selectedOperator.name?.toLowerCase()))
                : true;

            const ptId = typeof p.productTypeId === 'object' ? (p.productTypeId as any)?._id : p.productTypeId;
            const selectedProductType = productTypesAll.find(pt => pt._id === productTypeFilter);
            const matchesProductType = productTypeFilter
                ? (ptId === productTypeFilter || (selectedProductType && p.name?.toLowerCase().includes(selectedProductType.name?.toLowerCase())))
                : true;

            const matchesStatus = statusFilter === 'all'
                ? true
                : statusFilter === 'active' ? p.status : !p.status;

            return matchesSearch && matchesCategory && matchesOperator && matchesProductType && matchesStatus;
        });
    }, [products, searchTerm, categoryFilter, operatorFilter, productTypeFilter, statusFilter, operatorsAll, productTypesAll, categories]);

    const activeProductsCount = useMemo(
        () => products.filter((p) => p.status).length,
        [products]
    );
    const inactiveProductsCount = useMemo(
        () => products.filter((p) => !p.status).length,
        [products]
    );
    const hiddenByHierarchyCount = useMemo(
        () => products.filter((p) => p.status && p.canPurchase === false).length,
        [products]
    );
    const vendorLinkedCount = useMemo(
        () => products.filter((p) => Boolean(p.vendor?.name)).length,
        [products]
    );

    const hasActiveFilters = Boolean(
        searchTerm || categoryFilter || operatorFilter || productTypeFilter || statusFilter !== 'all'
    );
    const activeFilterCount = [
        Boolean(searchTerm),
        Boolean(categoryFilter),
        Boolean(operatorFilter),
        Boolean(productTypeFilter),
        statusFilter !== 'all',
    ].filter(Boolean).length;

    const totalPages = Math.max(1, Math.ceil(filteredProducts.length / pageSize));
    const resolvedCurrentPage = Math.min(currentPage, totalPages);

    const paginatedProducts = useMemo(() => {
        const start = (resolvedCurrentPage - 1) * pageSize;
        return filteredProducts.slice(start, start + pageSize);
    }, [filteredProducts, resolvedCurrentPage, pageSize]);

    const visibleStart = filteredProducts.length === 0 ? 0 : (resolvedCurrentPage - 1) * pageSize + 1;
    const visibleEnd = Math.min(resolvedCurrentPage * pageSize, filteredProducts.length);

    const filteredOperators = useMemo(() => {
        return operatorsAll.filter((o) => !categoryFilter || o.categoryId === categoryFilter);
    }, [operatorsAll, categoryFilter]);

    const filteredProductTypes = useMemo(() => {
        return productTypesAll.filter((pt) => {
            const matchCat = !categoryFilter || pt.categoryId === categoryFilter;
            const matchOp = !operatorFilter || pt.operatorId === operatorFilter;
            return matchCat && matchOp;
        });
    }, [productTypesAll, categoryFilter, operatorFilter]);



    const filteredMapOperators = useMemo(() => {
        return operatorsAll.filter((o) => !mapCategoryId || o.categoryId === mapCategoryId);
    }, [operatorsAll, mapCategoryId]);

    const filteredMapProductTypes = useMemo(() => {
        return productTypesAll.filter((pt) => {
            const matchCat = !mapCategoryId || pt.categoryId === mapCategoryId;
            const matchOp = !mapOperatorId || pt.operatorId === mapOperatorId;
            return matchCat && matchOp;
        });
    }, [productTypesAll, mapCategoryId, mapOperatorId]);

    const filteredBulkMapOperators = useMemo(() => {
        return operatorsAll.filter((o) => !bulkCategoryId || o.categoryId === bulkCategoryId);
    }, [operatorsAll, bulkCategoryId]);

    const filteredBulkMapProductTypes = useMemo(() => {
        return productTypesAll.filter((pt) => {
            const matchCat = !bulkCategoryId || pt.categoryId === bulkCategoryId;
            const matchOp = !bulkOperatorId || pt.operatorId === bulkOperatorId;
            return matchCat && matchOp;
        });
    }, [productTypesAll, bulkCategoryId, bulkOperatorId]);

    const getId = (val: any) => {
        if (!val) return '';
        if (typeof val === 'object') return val._id || '';
        return val;
    };

    const bulkPriceRows = useMemo(() => {
        const term = bulkPriceSearch.toLowerCase();
        const selectedOperator = operatorsAll.find((o) => o._id === bulkPriceOperator);
        const selectedOperatorName = selectedOperator?.name?.toLowerCase();
        const filtered = products.filter((p) => {
            const code = (p.code || '').toLowerCase();
            const name = (p.name || '').toLowerCase();
            const matchesSearch = !term || code.includes(term) || name.includes(term);

            const catId = getId(p.categoryId) || p.category;
            const opId = getId((p as any).operatorId);
            const ptId = getId((p as any).productTypeId);

            const matchesCategory = !bulkPriceCategory || catId === bulkPriceCategory;
            const matchesOperator = !bulkPriceOperator
                || opId === bulkPriceOperator
                || (p.brand && selectedOperatorName && p.brand.toLowerCase() === selectedOperatorName);
            const matchesProductType = !bulkPriceProductType
                || ptId === bulkPriceProductType
                || (!ptId && bulkPriceProductType && matchesOperator);

            return matchesSearch && matchesCategory && matchesOperator && matchesProductType;
        });
        return filtered.slice(0, 300);
    }, [products, bulkPriceSearch, bulkPriceCategory, bulkPriceOperator, bulkPriceProductType, operatorsAll]);

    useEffect(() => {
        setCurrentPage(1);
    }, [searchTerm, categoryFilter, operatorFilter, productTypeFilter, statusFilter, pageSize, viewMode]);

    useEffect(() => {
        if (currentPage !== resolvedCurrentPage) {
            setCurrentPage(resolvedCurrentPage);
        }
    }, [currentPage, resolvedCurrentPage]);

    useEffect(() => {
        if (hasActiveFilters) {
            setShowFilters(true);
        }
    }, [hasActiveFilters]);

    const handleResetProductFilters = () => {
        setSearchTerm('');
        setCategoryFilter('');
        setOperatorFilter('');
        setProductTypeFilter('');
        setStatusFilter('all');
        setCurrentPage(1);
    };

    return (
        <div className="space-y-6">
            {canManageProducts && (
                <div className="ui-panel-muted border ui-border rounded-xl p-4 flex flex-wrap gap-2">
                    <button
                        onClick={() => setIsSortingOpen(true)}
                        className="ui-muted-action inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border text-sm font-semibold transition-colors"
                    >
                        <ArrowUpDown className="w-4 h-4" /> Sorting Produk
                    </button>
                    <button
                        onClick={openBulkPriceModal}
                        className="ui-muted-action inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border text-sm font-semibold transition-colors"
                    >
                        <FileSpreadsheet className="w-4 h-4" /> Update Harga Bulk
                    </button>
                    <button
                        onClick={handleAddProduct}
                        className="ui-accent-solid inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors"
                    >
                        <Plus className="w-4 h-4" /> Tambah Produk
                    </button>
                </div>
            )}

            {!canManageProducts && (
                <div className="ui-warning-chip rounded-xl border p-4 text-sm">
                    Akun ini hanya dapat melihat produk. Aksi tambah, edit, hapus, sorting, import, dan update harga disembunyikan.
                </div>
            )}

            {/* Message */}
            {message && (
                <div className={`p-4 rounded-lg flex items-center gap-2 border ${message.type === 'success' ? 'ui-success-chip' : 'ui-danger-chip'}`} role="alert" aria-live="polite">
                    <AlertCircle className="w-5 h-5" />
                    {message.text}
                </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-xl border ui-border ui-panel-muted p-4">
                    <p className="text-sm ui-text-muted">Total Produk</p>
                    <p className="mt-2 text-2xl font-bold ui-text">{products.length}</p>
                    <p className="mt-1 text-xs ui-text-muted">{filteredProducts.length} sesuai filter aktif</p>
                </div>
                <div className="rounded-xl border ui-border ui-panel-muted p-4">
                    <p className="text-sm ui-text-muted">Status Publik</p>
                    <p className="mt-2 text-2xl font-bold ui-success-text">{activeProductsCount}</p>
                    <p className="mt-1 text-xs ui-text-muted">{inactiveProductsCount} nonaktif / diarsipkan</p>
                </div>
                <div className="rounded-xl border ui-border ui-panel-muted p-4">
                    <p className="text-sm ui-text-muted">Tersembunyi Parent</p>
                    <p className="mt-2 text-2xl font-bold ui-warning-text">{hiddenByHierarchyCount}</p>
                    <p className="mt-1 text-xs ui-text-muted">Produk aktif tapi parent kategori/operator/jenis nonaktif</p>
                </div>
                <div className="rounded-xl border ui-border ui-panel-muted p-4">
                    <p className="text-sm ui-text-muted">Vendor Terhubung</p>
                    <p className="mt-2 text-2xl font-bold ui-text">{vendorLinkedCount}</p>
                    <p className="mt-1 text-xs ui-text-muted">Produk dengan SKU vendor terhubung</p>
                </div>
            </div>

            {/* Filters */}
            <div className="ui-panel-muted border ui-border rounded-xl p-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                    <div>
                        <p className="text-sm font-semibold ui-text">Filter Produk</p>
                        <p className="mt-1 text-xs ui-text-muted">
                            {hasActiveFilters
                                ? `${activeFilterCount} filter aktif sedang dipakai`
                                : 'Sembunyikan filter saat tidak dipakai agar halaman lebih ringkas.'}
                        </p>
                    </div>

                    <button
                        onClick={() => setShowFilters((value) => !value)}
                        className="inline-flex w-full sm:w-auto items-center justify-center gap-2 rounded-xl border ui-border ui-panel px-4 py-2.5 text-sm font-semibold ui-text hover:border-[color-mix(in_srgb,var(--ui-accent)_34%,transparent)] hover:bg-[var(--ui-accent-soft)] transition-colors"
                    >
                        <SlidersHorizontal className="h-4 w-4" />
                        {showFilters ? 'Sembunyikan Filter' : 'Tampilkan Filter'}
                        {activeFilterCount > 0 && (
                            <span className="rounded-full border border-[color-mix(in_srgb,var(--ui-accent)_24%,transparent)] bg-[var(--ui-accent-soft)] px-2 py-0.5 text-xs ui-accent-text">
                                {activeFilterCount}
                            </span>
                        )}
                        {showFilters ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                    </button>
                </div>

                {showFilters && (
                    <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                        <div className="relative">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ui-text-muted" />
                            <input
                                placeholder="Cari Kode/Nama/Brand..."
                                value={searchTerm}
                                onChange={(e) => setSearchTerm(e.target.value)}
                                className="w-full pl-9 pr-3 py-2 rounded-lg ui-panel border ui-border text-sm ui-text focus:outline-none focus:border-[var(--ui-accent)] placeholder-[var(--ui-text-muted)]"
                            />
                        </div>

                        <select
                            value={categoryFilter}
                            onChange={(e) => {
                                setCategoryFilter(e.target.value);
                                setOperatorFilter('');
                                setProductTypeFilter('');
                            }}
                            className="w-full rounded-lg ui-panel border ui-border px-3 py-2 text-sm ui-text focus:outline-none focus:border-[var(--ui-accent)]"
                        >
                            <option value="">Semua Kategori</option>
                            {categories.map(c => (
                                <option key={c._id} value={c._id}>{c.name}</option>
                            ))}
                        </select>

                        <select
                            value={operatorFilter}
                            onChange={(e) => {
                                setOperatorFilter(e.target.value);
                                setProductTypeFilter('');
                            }}
                            className="w-full rounded-lg ui-panel border ui-border px-3 py-2 text-sm ui-text focus:outline-none focus:border-[var(--ui-accent)] disabled:opacity-50"
                            disabled={!categoryFilter}
                        >
                            <option value="">Semua Operator</option>
                            {filteredOperators.map(o => (
                                <option key={o._id} value={o._id}>{o.name}</option>
                            ))}
                        </select>

                        <select
                            value={productTypeFilter}
                            onChange={(e) => setProductTypeFilter(e.target.value)}
                            className="w-full rounded-lg ui-panel border ui-border px-3 py-2 text-sm ui-text focus:outline-none focus:border-[var(--ui-accent)] disabled:opacity-50"
                            disabled={!operatorFilter}
                        >
                            <option value="">Semua Tipe</option>
                            {filteredProductTypes.map(pt => (
                                <option key={pt._id} value={pt._id}>{pt.name}</option>
                            ))}
                        </select>

                        <select
                            value={statusFilter}
                            onChange={(e) => setStatusFilter(e.target.value)}
                            className="w-full rounded-lg ui-panel border ui-border px-3 py-2 text-sm ui-text focus:outline-none focus:border-[var(--ui-accent)]"
                        >
                            <option value="all">Semua Status</option>
                            <option value="active">Aktif</option>
                            <option value="inactive">Nonaktif</option>
                        </select>
                    </div>
                )}
            </div>

            {/* View Toggle & Count */}
            <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
                <div className="flex flex-wrap gap-4 text-sm">
                    <span className="ui-text-muted">
                        Total: <span className="font-semibold ui-text">{products.length}</span> produk
                    </span>
                    <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${dataSource === 'api-v2' ? 'ui-success-chip' : 'ui-warning-chip'}`}>
                        {dataSource === 'api-v2' ? 'API v2' : 'Fallback v1'}
                    </span>
                    <span className="ui-text-muted">
                        Aktif: <span className="font-semibold ui-accent-text">{activeProductsCount}</span>
                    </span>
                    {hasActiveFilters && (
                        <span className="ui-text-muted">
                            Ditemukan: <span className="font-semibold ui-info-text">{filteredProducts.length}</span>
                        </span>
                    )}
                    {!loading && filteredProducts.length > 0 && (
                        <span className="ui-text-muted">
                            Tampil: <span className="font-semibold ui-text">{visibleStart}-{visibleEnd}</span>
                        </span>
                    )}
                </div>

                <div className="flex flex-wrap items-center gap-3">
                    {hasActiveFilters && (
                        <button
                            onClick={handleResetProductFilters}
                            className="px-3 py-2 rounded-lg border ui-border ui-panel text-sm font-semibold ui-text hover:border-[color-mix(in_srgb,var(--ui-accent)_34%,transparent)] hover:bg-[var(--ui-accent-soft)] transition-colors"
                        >
                            Reset Filter
                        </button>
                    )}

                    <label className="flex items-center gap-2 rounded-lg border ui-border ui-panel-muted px-3 py-2 text-sm ui-text-muted">
                        <span className="text-xs uppercase tracking-wide ui-text-muted">Per Halaman</span>
                        <select
                            value={pageSize}
                            onChange={(e) => setPageSize(Number(e.target.value))}
                            className="bg-transparent text-sm ui-text focus:outline-none"
                        >
                            {[10, 20, 50, 100].map((size) => (
                                <option key={size} value={size} className="ui-panel">
                                    {size}
                                </option>
                            ))}
                        </select>
                    </label>

                    <div className="flex ui-panel-muted rounded-lg p-1 border ui-border">
                        <button
                            onClick={() => setViewMode('list')}
                            className={`p-2 rounded-md transition-all ${viewMode === 'list' ? 'ui-panel-muted ui-accent-text shadow-sm' : 'ui-text-muted hover:text-[var(--ui-text)]'}`}
                            title="List View"
                        >
                            <List className="w-4 h-4" />
                        </button>
                        <button
                            onClick={() => setViewMode('grid')}
                            className={`p-2 rounded-md transition-all ${viewMode === 'grid' ? 'ui-panel-muted ui-accent-text shadow-sm' : 'ui-text-muted hover:text-[var(--ui-text)]'}`}
                            title="Grid View"
                        >
                            <LayoutGrid className="w-4 h-4" />
                        </button>
                    </div>
                </div>
            </div>

            {/* Content Area */}
            {viewMode === 'list' ? (
                // LIST VIEW
                <div className="ui-panel-muted rounded-xl shadow-sm border ui-border overflow-hidden">
                    <div className="overflow-x-auto">
                        <table className="min-w-full">
                            <thead>
                                <tr className="ui-panel ui-text-muted text-xs uppercase">
                                    <th className="px-4 py-3 text-left font-semibold tracking-wider w-16">#ID</th>
                                    <th className="px-4 py-3 text-left font-semibold tracking-wider">Info Produk</th>
                                    <th className="hidden 2xl:table-cell px-4 py-3 text-left font-semibold tracking-wider">Tipe/Vendor</th>
                                    <th className="px-4 py-3 text-left font-semibold tracking-wider">Kode</th>
                                    <th className="px-4 py-3 text-left font-semibold tracking-wider">Harga</th>
                                    <th className="px-4 py-3 text-center font-semibold tracking-wider">Status</th>
                                    <th className="hidden 2xl:table-cell px-4 py-3 text-left font-semibold tracking-wider">Dibuat</th>
                                    <th className="px-4 py-3 text-right font-semibold tracking-wider">Action</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-[var(--ui-border)]">
                                {loading ? (
                                    <tr>
                                        <td colSpan={8} className="px-4 py-8 text-center ui-text-muted">
                                            <div className="flex items-center justify-center gap-2">
                                                <div className="h-5 w-5 border-2 border-[color-mix(in_srgb,var(--ui-accent)_34%,transparent)] border-t-[var(--ui-accent)] rounded-full animate-spin" />
                                                Memuat data...
                                            </div>
                                        </td>
                                    </tr>
                                ) : filteredProducts.length === 0 ? (
                                    <tr>
                                        <td colSpan={8} className="px-4 py-12 text-center">
                                            <Package className="w-12 h-12 ui-text-muted mx-auto mb-3" />
                                            <p className="ui-text-muted font-medium">
                                                {products.length === 0 ? 'Belum ada produk' : 'Tidak ada produk yang sesuai'}
                                            </p>
                                        </td>
                                    </tr>
                                ) : (
                                    paginatedProducts.map((product) => {
                                        const cost = product.costPrice || 0;
                                        const profitBasic = product.price.basic - cost;
                                        const productType = typeof product.productTypeId === 'object' ? (product.productTypeId as any)?.name : '';
                                        const categoryIcon = product.categoryId && typeof product.categoryId !== 'string' ? (product.categoryId as any).icon : null;

                                        return (
                                            <tr key={product._id} className="hover:bg-[var(--ui-card-bg)] transition-colors group">
                                                <td className="px-4 py-3.5 align-top">
                                                    <span className="text-sm font-mono ui-accent-text">#{product.productId || '-'}</span>
                                                </td>
                                                <td className="px-4 py-3.5">
                                                    <div className="flex items-start gap-3">
                                                        <div className="w-10 h-10 rounded-lg ui-panel border ui-border ui-text-muted flex items-center justify-center overflow-hidden flex-shrink-0">
                                                            {product.icon ? (
                                                                <img src={product.icon} alt={product.name} className="w-full h-full object-cover" />
                                                            ) : (categoryIcon ? (
                                                                <img src={categoryIcon} alt="cat" className="w-6 h-6 object-contain opacity-50" />
                                                            ) : (
                                                                <Package className="w-5 h-5" />
                                                            ))}
                                                        </div>
                                                        <div className="min-w-0">
                                                            <p className="text-sm font-semibold ui-text group-hover:text-[var(--ui-accent-strong)] transition-colors line-clamp-1">{product.name}</p>
                                                            <div className="mt-1 flex flex-wrap items-center gap-2">
                                                                <span className="text-[10px] uppercase ui-panel border ui-border ui-text-muted px-1.5 py-0.5 rounded">
                                                                    {productType || product.categoryId?.name || product.category}
                                                                </span>
                                                                {product.brand && (
                                                                    <span className="text-[10px] ui-text-muted">{product.brand}</span>
                                                                )}
                                                                {product.status && product.canPurchase === false && (
                                                                    <span className="ui-warning-chip text-[10px] border px-1.5 py-0.5 rounded">
                                                                        {product.visibilityIssues?.[0] || 'Parent nonaktif'}
                                                                    </span>
                                                                )}
                                                            </div>
                                                        </div>
                                                    </div>
                                                </td>
                                                <td className="hidden 2xl:table-cell px-4 py-3.5 align-top">
                                                    <div className="space-y-1">
                                                        <div className="flex items-center gap-2">
                                                            <span className={`w-1.5 h-1.5 rounded-full ${product.paymentType === 'pascabayar' ? 'bg-[var(--ui-accent)]' : 'bg-[var(--ui-info)]'}`}></span>
                                                            <span className="text-xs ui-text-muted capitalize">{product.paymentType}</span>
                                                        </div>
                                                        {product.vendor?.name && (
                                                            <div className="flex items-center gap-2 text-xs ui-text-muted">
                                                                <Download className="w-3 h-3" />
                                                                {product.vendor.name}
                                                            </div>
                                                        )}
                                                    </div>
                                                </td>
                                                <td className="px-4 py-3.5 align-top">
                                                    <div className="space-y-1">
                                                        <div className="flex items-center gap-1.5">
                                                            <span className="text-xs font-mono ui-accent-text bg-[var(--ui-accent-soft)] px-2 py-0.5 rounded border border-[color-mix(in_srgb,var(--ui-accent)_24%,transparent)] select-all">
                                                                {product.code}
                                                            </span>
                                                        </div>
                                                        {product.vendor?.sku && (
                                                            <div className="text-[10px] ui-text-muted font-mono">
                                                                V: {product.vendor.sku}
                                                            </div>
                                                        )}
                                                    </div>
                                                </td>
                                                <td className="px-4 py-3.5 align-top">
                                                    <div className="space-y-1">
                                                        <div className="flex items-center justify-between gap-4 text-xs">
                                                            <span className="ui-text-muted">Modal</span>
                                                            <span className="font-medium ui-text-muted">Rp{cost.toLocaleString('id-ID')}</span>
                                                        </div>
                                                        <div className="flex items-center justify-between gap-4 text-xs">
                                                            <span className="ui-accent-text">Jual</span>
                                                            <div className="text-right">
                                                                <span className="font-bold ui-text">Rp{product.price.basic.toLocaleString('id-ID')}</span>
                                                                {cost > 0 && profitBasic > 0 && <span className="text-[10px] ui-success-text ml-1">(+{Math.round((profitBasic / cost) * 100)}%)</span>}
                                                            </div>
                                                        </div>
                                                        {product.rewardPoints && product.rewardPoints > 0 && (
                                                            <div className="flex items-center gap-2 text-[10px] ui-accent-text">
                                                                <Sparkles className="w-3 h-3 ui-accent-text" />
                                                                <span className="font-semibold">+{product.rewardPoints.toLocaleString('id-ID')} poin</span>
                                                            </div>
                                                        )}
                                                    </div>
                                                </td>
                                                <td className="px-4 py-3.5 text-center align-top">
                                                    <div className="space-y-1">
                                                        <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border ${product.status
                                                            ? 'ui-success-chip'
                                                            : 'ui-danger-chip'
                                                            }`}>
                                                            <div className={`w-1.5 h-1.5 rounded-full ${product.status ? 'bg-[var(--ui-success)] animate-pulse' : 'bg-[var(--ui-danger)]'}`} />
                                                            <span className="text-[10px] font-semibold uppercase tracking-wide">{product.status ? 'Active' : 'Inactive'}</span>
                                                        </div>
                                                        {product.status && product.canPurchase === false && (
                                                            <p className="text-[10px] ui-warning-text">
                                                                {product.visibilityIssues?.join(', ') || 'Parent nonaktif'}
                                                            </p>
                                                        )}
                                                    </div>
                                                </td>
                                                <td className="hidden 2xl:table-cell px-4 py-3.5 align-top">
                                                    <span className="text-xs ui-text-muted">
                                                        {product.createdAt ? new Date(product.createdAt).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' }) : '-'}
                                                    </span>
                                                </td>
                                                <td className="px-4 py-3.5 text-right align-top">
                                                    <div className="flex items-center justify-end gap-2">
                                                        {canManageProducts ? (
                                                            <>
                                                                <button
                                                                    onClick={() => handleEdit(product)}
                                                                    className="p-2 ui-text-muted hover:text-[var(--ui-text)] hover:bg-[var(--ui-card-muted)] rounded-lg transition-all"
                                                                    title="Edit Produk"
                                                                    aria-label={`Edit produk ${product.name}`}
                                                                >
                                                                    <Edit2 className="w-4 h-4" />
                                                                </button>
                                                                <button
                                                                    onClick={() => handleToggleStatus(product)}
                                                                    disabled={actionLoadingId === product._id}
                                                                    className={`p-2 rounded-lg transition-all ${product.status ? 'ui-accent-text hover:text-[var(--ui-accent-strong)] hover:bg-[var(--ui-accent-soft)]' : 'ui-success-action'} disabled:opacity-50`}
                                                                    title={product.status ? 'Nonaktifkan Produk' : 'Aktifkan Produk'}
                                                                    aria-label={`${product.status ? 'Nonaktifkan' : 'Aktifkan'} produk ${product.name}`}
                                                                >
                                                                    <Power className="w-4 h-4" />
                                                                </button>
                                                                <button
                                                                    onClick={() => {
                                                                        setSelectedDeleteProduct(product);
                                                                        setShowDeleteModal(true);
                                                                    }}
                                                                    disabled={actionLoadingId === product._id}
                                                                    className="p-2 ui-danger-action rounded-lg transition-all disabled:opacity-50"
                                                                    title={product.status ? 'Arsipkan Produk' : 'Hapus Permanen'}
                                                                    aria-label={`${product.status ? 'Arsipkan' : 'Hapus permanen'} produk ${product.name}`}
                                                                >
                                                                    <Trash2 className="w-4 h-4" />
                                                                </button>
                                                            </>
                                                        ) : (
                                                            <span className="text-xs ui-text-muted">Lihat saja</span>
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
            ) : (
                // GRID VIEW
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {loading ? (
                        [...Array(8)].map((_, i) => (
                            <div key={i} className="ui-panel-muted rounded-xl p-4 border ui-border animate-pulse h-48"></div>
                        ))
                    ) : filteredProducts.length === 0 ? (
                        <div className="col-span-full py-12 text-center ui-text-muted">
                            <Package className="w-12 h-12 mx-auto mb-3 opacity-20" />
                            <p>Tidak ada produk yang ditemukan</p>
                        </div>
                    ) : (
                        paginatedProducts.map((product) => {
                            const cost = product.costPrice || 0;

                            const categoryIcon = product.categoryId && typeof product.categoryId !== 'string' ? (product.categoryId as any).icon : null;

                            return (
                                <div key={product._id} className="group ui-panel-muted hover:bg-[var(--ui-card-bg)] border ui-border hover:border-[color-mix(in_srgb,var(--ui-accent)_34%,transparent)] rounded-xl p-4 transition-all duration-300 hover:shadow-[0_8px_30px_rgba(0,0,0,0.12)] hover:-translate-y-1 relative overflow-hidden">
                                    <div className="absolute top-0 right-0 p-3">
                                        <div className={`w-2 h-2 rounded-full ${product.status ? 'bg-[var(--ui-success)] shadow-[0_0_8px_var(--ui-success-soft)]' : 'bg-[var(--ui-danger)]'}`} />
                                    </div>

                                    <div className="flex items-start gap-4 mb-4">
                                        <div className="w-12 h-12 rounded-xl ui-panel border ui-border flex items-center justify-center overflow-hidden flex-shrink-0 group-hover:border-[color-mix(in_srgb,var(--ui-accent)_24%,transparent)] transition-colors">
                                            {product.icon ? (
                                                <img src={product.icon} alt={product.name} className="w-full h-full object-cover" />
                                            ) : (categoryIcon ? (
                                                <img src={categoryIcon} alt="cat" className="w-7 h-7 object-contain opacity-50" />
                                            ) : (
                                                <Package className="w-6 h-6 ui-text-muted" />
                                            ))}
                                        </div>
                                        <div className="flex-1 min-w-0 pt-0.5">
                                            <h3 className="font-semibold ui-text text-sm leading-tight line-clamp-2 mb-1 group-hover:text-[var(--ui-accent-strong)] transition-colors">{product.name}</h3>
                                            <div className="flex items-center gap-2 text-[10px] ui-text-muted">
                                                <span className="ui-panel px-1.5 py-0.5 rounded border ui-border">{product.code}</span>
                                                {product.brand && <span>{product.brand}</span>}
                                            </div>
                                        </div>
                                    </div>

                                    <div className="space-y-2 mb-4 pt-3 border-t ui-border">
                                        <div className="flex justify-between items-center text-xs">
                                            <span className="ui-text-muted">Modal</span>
                                            <span className="ui-text-muted">Rp{cost.toLocaleString('id-ID')}</span>
                                        </div>
                                        <div className="flex justify-between items-center text-sm">
                                            <span className="ui-accent-text font-medium">Harga Jual</span>
                                            <div className="text-right">
                                                <span className="block font-bold ui-text">Rp{product.price.basic.toLocaleString('id-ID')}</span>
                                            </div>
                                        </div>
                                        {product.rewardPoints && product.rewardPoints > 0 && (
                                            <div className="flex items-center gap-2 text-[11px] ui-accent-text">
                                                <Sparkles className="w-3.5 h-3.5 ui-accent-text" />
                                                <span className="font-semibold">+{product.rewardPoints.toLocaleString('id-ID')} poin</span>
                                            </div>
                                        )}
                                        {product.status && product.canPurchase === false && (
                                            <div className="ui-warning-chip rounded-lg border px-2.5 py-2 text-[11px]">
                                                {product.visibilityIssues?.join(', ') || 'Produk aktif tetapi parent nonaktif'}
                                            </div>
                                        )}
                                    </div>

                                    {canManageProducts ? (
                                        <div className="grid grid-cols-3 gap-2">
                                            <button
                                                onClick={() => handleEdit(product)}
                                                className="col-span-1 rounded-lg ui-panel border ui-border py-2 text-xs font-semibold ui-text-muted transition-all hover:border-[var(--ui-accent)] hover:bg-[var(--ui-accent-soft)] hover:text-[var(--ui-accent-strong)] flex items-center justify-center gap-2"
                                                aria-label={`Edit produk ${product.name}`}
                                            >
                                                <Edit2 className="w-3.5 h-3.5" /> Edit
                                            </button>
                                            <button
                                                onClick={() => handleToggleStatus(product)}
                                                disabled={actionLoadingId === product._id}
                                                className={`col-span-1 rounded-lg border py-2 text-xs font-semibold transition-all disabled:opacity-50 ${product.status ? 'border-[color-mix(in_srgb,var(--ui-accent)_24%,transparent)] bg-[var(--ui-accent-soft)] ui-accent-text hover:bg-[var(--ui-accent-soft)]' : 'ui-success-action'}`}
                                                aria-label={`${product.status ? 'Nonaktifkan' : 'Aktifkan'} produk ${product.name}`}
                                            >
                                                <span className="inline-flex items-center justify-center gap-2">
                                                    <Power className="w-3.5 h-3.5" />
                                                    {product.status ? 'Off' : 'On'}
                                                </span>
                                            </button>
                                            <button
                                                onClick={() => {
                                                    setSelectedDeleteProduct(product);
                                                    setShowDeleteModal(true);
                                                }}
                                                disabled={actionLoadingId === product._id}
                                                className="ui-danger-action col-span-1 rounded-lg border py-2 text-xs font-semibold transition-all disabled:opacity-50"
                                                aria-label={`${product.status ? 'Arsipkan' : 'Hapus permanen'} produk ${product.name}`}
                                            >
                                                <span className="inline-flex items-center justify-center gap-2">
                                                    <Trash2 className="w-3.5 h-3.5" />
                                                    {product.status ? 'Arsip' : 'Hapus'}
                                                </span>
                                            </button>
                                        </div>
                                    ) : (
                                        <div className="rounded-lg border ui-border py-2 text-center text-xs font-semibold ui-text-muted">
                                            Mode lihat saja
                                        </div>
                                    )}
                                </div>
                            );
                        })
                    )}
                </div>
            )}

            {!loading && filteredProducts.length > 0 && (
                <div className="flex flex-col gap-3 rounded-xl border ui-border ui-panel-muted p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="text-sm ui-text-muted">
                        Menampilkan <span className="font-semibold ui-text">{visibleStart}-{visibleEnd}</span> dari{' '}
                        <span className="font-semibold ui-text">{filteredProducts.length}</span> produk
                    </div>

                    <div className="flex items-center gap-2 self-end sm:self-auto">
                        <button
                            onClick={() => setCurrentPage(Math.max(1, resolvedCurrentPage - 1))}
                            disabled={resolvedCurrentPage === 1}
                            className="inline-flex items-center gap-2 rounded-lg border ui-border ui-panel px-3 py-2 text-sm font-semibold ui-text hover:border-[color-mix(in_srgb,var(--ui-accent)_34%,transparent)] hover:bg-[var(--ui-accent-soft)] disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
                        >
                            <ChevronLeft className="h-4 w-4" />
                            Prev
                        </button>

                        <div className="min-w-[120px] text-center text-sm ui-text-muted">
                            Halaman <span className="font-semibold ui-text">{resolvedCurrentPage}</span> / {totalPages}
                        </div>

                        <button
                            onClick={() => setCurrentPage(Math.min(totalPages, resolvedCurrentPage + 1))}
                            disabled={resolvedCurrentPage === totalPages}
                            className="inline-flex items-center gap-2 rounded-lg border ui-border ui-panel px-3 py-2 text-sm font-semibold ui-text hover:border-[color-mix(in_srgb,var(--ui-accent)_34%,transparent)] hover:bg-[var(--ui-accent-soft)] disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
                        >
                            Next
                            <ChevronRight className="h-4 w-4" />
                        </button>
                    </div>
                </div>
            )}

            {/* Add Type Selection Modal */}
            {isAddTypeModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
                    <div className="w-full max-w-lg rounded-2xl border border-[var(--ui-accent)]/25 ui-panel shadow-[0_30px_90px_rgba(0,0,0,0.55)] overflow-hidden">
                        <div className="ui-card-gradient relative p-5 border-b ui-border">
                            <div className="absolute inset-0 pointer-events-none opacity-30 bg-[radial-gradient(circle_at_18%_18%,rgba(255,141,70,0.22),transparent_32%),radial-gradient(circle_at_82%_8%,rgba(109,152,255,0.22),transparent_30%)]" />
                            <div className="relative flex items-start justify-between">
                                <div>
                                    <span className="ui-accent-chip inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] border px-3 py-1 rounded-full">
                                        <Sparkles className="h-3.5 w-3.5" />
                                        Tambah produk
                                    </span>
                                    <h3 className="text-2xl font-black ui-text leading-tight mt-2">Pilih metode penambahan produk</h3>
                                    <p className="text-sm ui-text-muted mt-1">Mulai dari form tunggal, unggah bulk, atau impor dari vendor.</p>
                                </div>
                                <button onClick={() => setIsAddTypeModalOpen(false)} className="p-2 ui-text-muted hover:text-[var(--ui-text)] hover:bg-[var(--ui-card-muted)] rounded-lg transition-colors">
                                    <X className="w-5 h-5" />
                                </button>
                            </div>
                        </div>

                        <div className="p-5 space-y-3">
                            <button
                                onClick={handleSingleAdd}
                                className="w-full flex items-center gap-4 p-4 border ui-border rounded-xl ui-panel hover:border-[var(--ui-accent)] hover:bg-[var(--ui-accent-soft)] transition-colors text-left"
                            >
                                <div className="w-12 h-12 rounded-lg bg-[var(--ui-accent-soft)] flex items-center justify-center">
                                    <Plus className="w-6 h-6 ui-accent-text" />
                                </div>
                                <div>
                                    <p className="font-semibold ui-text">Single</p>
                                    <p className="text-sm ui-text-muted">Tambah satu produk dengan form</p>
                                </div>
                            </button>

                            <button
                                onClick={handleBulkAdd}
                                className="w-full flex items-center gap-4 p-4 border ui-border rounded-xl ui-panel hover:border-[var(--ui-accent)] hover:bg-[var(--ui-accent-soft)] transition-colors text-left"
                            >
                                <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-cyan-500/25 to-blue-500/20 flex items-center justify-center">
                                    <FileSpreadsheet className="w-6 h-6 ui-info-text" />
                                </div>
                                <div>
                                    <p className="font-semibold ui-text">Bulk</p>
                                    <p className="text-sm ui-text-muted">Tambah banyak produk sekaligus</p>
                                </div>
                            </button>

                            <button
                                onClick={handleVendorImportFromSelector}
                                className="w-full flex items-center gap-4 p-4 border ui-border rounded-xl ui-panel hover:border-[var(--ui-accent)] hover:bg-[var(--ui-accent-soft)] transition-colors text-left"
                            >
                                <div className="w-12 h-12 rounded-lg bg-[var(--ui-accent-soft)] flex items-center justify-center">
                                    <Download className="w-6 h-6 ui-accent-text" />
                                </div>
                                <div>
                                    <p className="font-semibold ui-text">Import Tokovoucher</p>
                                    <p className="text-sm ui-text-muted">Ambil dari pricelist Tokovoucher</p>
                                </div>
                            </button>

                            <button
                                onClick={handleDgImportFromSelector}
                                className="w-full flex items-center gap-4 p-4 border ui-border rounded-xl ui-panel hover:border-[var(--ui-accent)] hover:bg-[var(--ui-accent-soft)] transition-colors text-left"
                            >
                                <div className="w-12 h-12 rounded-lg bg-gradient-to-br from-blue-500/30 to-indigo-400/25 flex items-center justify-center">
                                    <Download className="w-6 h-6 ui-info-text" />
                                </div>
                                <div>
                                    <p className="font-semibold ui-text">Import Digiflazz</p>
                                    <p className="text-sm ui-text-muted">Ambil dari pricelist Digiflazz</p>
                                </div>
                            </button>

                            <button
                                onClick={() => setIsAddTypeModalOpen(false)}
                                className="w-full mt-1 px-4 py-3 border ui-border ui-text rounded-xl hover:bg-[var(--ui-card-muted)] transition-colors"
                            >
                                Batal
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Bulk Price Update Modal */}
            {isBulkPriceOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
                    <div className="w-full max-w-6xl rounded-2xl border border-[var(--ui-accent)]/25 ui-panel shadow-[0_30px_90px_rgba(0,0,0,0.55)] overflow-hidden">
                        <div className="ui-card-gradient relative p-5 border-b ui-border">
                            <div className="absolute inset-0 pointer-events-none opacity-30 bg-[radial-gradient(circle_at_18%_18%,rgba(255,141,70,0.22),transparent_32%),radial-gradient(circle_at_82%_8%,rgba(109,152,255,0.22),transparent_30%)]" />
                            <div className="relative flex items-center justify-between">
                                <div className="space-y-1">
                                    <span className="ui-accent-chip inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] border px-3 py-1 rounded-full">
                                        <Sparkles className="h-3.5 w-3.5" />
                                        Bulk pricing
                                    </span>
                                    <div className="flex items-center gap-3">
                                        <h2 className="text-2xl font-black ui-text leading-tight">Update Harga Bulk</h2>
                                        <span className="text-xs ui-text-muted ui-panel border ui-border px-3 py-1 rounded-full">Max 300 baris</span>
                                    </div>
                                    <p className="text-sm ui-text-muted">Edit harga Basic/Gold/Platinum langsung di tabel; kosongkan jika tidak ingin mengubah.</p>
                                </div>
                                <button onClick={() => setIsBulkPriceOpen(false)} className="p-2 ui-text-muted hover:text-[var(--ui-text)] hover:bg-[var(--ui-card-muted)] rounded-lg transition-colors">
                                    <X className="w-5 h-5" />
                                </button>
                            </div>
                        </div>
                        <div className="p-5 space-y-4">
                            <div className="ui-panel border ui-border rounded-xl p-4 text-sm ui-text">
                                <p className="font-semibold mb-2 ui-text">Panduan cepat</p>
                                <p className="text-xs ui-text-muted">Gunakan filter kategori/operator/jenis untuk memperkecil hasil. Isi kolom harga sesuai kebutuhan tier.</p>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                                <div>
                                    <label className="block text-xs font-semibold ui-text mb-1">Kategori</label>
                                    <select
                                        value={bulkPriceCategory}
                                        onChange={(e) => { setBulkPriceCategory(e.target.value); setBulkPriceOperator(''); setBulkPriceProductType(''); }}
                                        className="w-full rounded-xl border ui-border ui-panel px-3 py-2 text-sm ui-text focus:border-[var(--ui-accent)] focus:ring-[var(--ui-accent)]"
                                    >
                                        <option value="">Semua</option>
                                        {categories.map((c) => (
                                            <option key={c._id} value={c._id}>{c.name}</option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-xs font-semibold ui-text mb-1">Operator</label>
                                    <select
                                        value={bulkPriceOperator}
                                        onChange={(e) => { setBulkPriceOperator(e.target.value); setBulkPriceProductType(''); }}
                                        disabled={!bulkPriceCategory}
                                        className="w-full rounded-xl border ui-border ui-panel px-3 py-2 text-sm ui-text focus:border-[var(--ui-accent)] focus:ring-[var(--ui-accent)] disabled:ui-panel"
                                    >
                                        <option value="">Semua</option>
                                        {filteredBulkOperators.map((o) => (
                                            <option key={o._id} value={o._id}>{o.name}</option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-xs font-semibold ui-text mb-1">Jenis Produk</label>
                                    <select
                                        value={bulkPriceProductType}
                                        onChange={(e) => setBulkPriceProductType(e.target.value)}
                                        disabled={!bulkPriceOperator}
                                        className="w-full rounded-xl border ui-border ui-panel px-3 py-2 text-sm ui-text focus:border-[var(--ui-accent)] focus:ring-[var(--ui-accent)] disabled:ui-panel"
                                    >
                                        <option value="">Semua</option>
                                        {filteredBulkProductTypes.map((pt) => (
                                            <option key={pt._id} value={pt._id}>{pt.name}</option>
                                        ))}
                                    </select>
                                </div>
                                <div className="flex flex-col justify-end">
                                    <div className="relative w-full">
                                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ui-text-muted" />
                                        <input
                                            type="text"
                                            value={bulkPriceSearch}
                                            onChange={(e) => setBulkPriceSearch(e.target.value)}
                                            className="pl-9 pr-3 py-2 w-full border ui-border ui-panel rounded-xl text-sm ui-text focus:border-[var(--ui-accent)] focus:ring-[var(--ui-accent)]"
                                            placeholder="Cari kode / nama produk"
                                        />
                                    </div>
                                    <p className="text-[11px] ui-text-muted mt-1">Menampilkan {bulkPriceRows.length} produk pertama (max 300)</p>
                                </div>
                            </div>

                            <div className="ui-panel overflow-hidden rounded-2xl border ui-border">
                                <div className="max-h-80 overflow-y-auto">
                                    <table className="min-w-full text-sm">
                                        <thead className="ui-panel-muted text-left text-xs font-semibold ui-text-muted">
                                            <tr>
                                                <th className="px-3 py-2">Kode</th>
                                                <th className="px-3 py-2">Nama</th>
                                                <th className="px-3 py-2 text-right">Basic</th>
                                                <th className="px-3 py-2 text-right">Gold</th>
                                                <th className="px-3 py-2 text-right">Platinum</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {bulkPriceRows.map((p) => {
                                                const current = p.price || { basic: 0, gold: 0, platinum: 0 };
                                                const edited = bulkPriceMap[p._id] || {};
                                                const getVal = (tier: keyof Product['price']) =>
                                                    edited[tier] ?? '';
                                                return (
                                                    <tr key={p._id} className="border-t ui-border hover:bg-[var(--ui-card-bg)]">
                                                        <td className="px-3 py-2 align-top">
                                                            <code className="text-xs ui-panel-muted px-2 py-1 rounded ui-accent-text">{p.code}</code>
                                                        </td>
                                                        <td className="px-3 py-2 align-top">
                                                            <div className="font-medium ui-text">{p.name}</div>
                                                            <p className="text-xs ui-text-muted">Modal: Rp{(p.costPrice || 0).toLocaleString('id-ID')}</p>
                                                        </td>
                                                        {(['basic', 'gold', 'platinum'] as const).map((tier) => (
                                                            <td key={tier} className="px-3 py-2 align-top">
                                                                <input
                                                                    type="number"
                                                                    min="0"
                                                                    value={getVal(tier)}
                                                                    placeholder={current[tier]?.toString() || '0'}
                                                                    onChange={(e) => handleBulkPriceChange(p._id, tier, e.target.value)}
                                                                    className="w-full border ui-border ui-panel rounded-lg px-2 py-2 text-sm ui-text focus:border-[var(--ui-accent)] focus:ring-[var(--ui-accent)]"
                                                                />
                                                                <p className="text-[10px] ui-text-muted">Saat ini: Rp{current[tier].toLocaleString('id-ID')}</p>
                                                            </td>
                                                        ))}
                                                    </tr>
                                                );
                                            })}
                                            {bulkPriceRows.length === 0 && (
                                                <tr>
                                                    <td colSpan={5} className="px-3 py-6 text-center text-sm ui-text-muted">Produk tidak ditemukan</td>
                                                </tr>
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            </div>

                            <div className="flex gap-3">
                                <button
                                    onClick={() => setIsBulkPriceOpen(false)}
                                    className="flex-1 px-4 py-2 border ui-border ui-text rounded-xl hover:bg-[var(--ui-card-muted)] transition-colors"
                                >
                                    Batal
                                </button>
                                <button
                                    onClick={handleBulkPriceSubmit}
                                    disabled={bulkPriceLoading || Object.keys(bulkPriceMap).length === 0}
                                    className="flex-1 px-4 py-2 ui-accent-solid rounded-xl hover:shadow-[0_14px_46px_rgba(255,140,66,0.36)] transition-all disabled:opacity-50"
                                >
                                    {bulkPriceLoading ? 'Memperbarui...' : 'Update Harga'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Bulk Upload Modal */}
            {isBulkModalOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
                    <div className="w-full max-w-3xl rounded-2xl border border-[var(--ui-accent)]/25 ui-panel shadow-[0_30px_90px_rgba(0,0,0,0.55)] overflow-hidden">
                        <div className="ui-card-gradient relative p-5 border-b ui-border">
                            <div className="absolute inset-0 pointer-events-none opacity-30 bg-[radial-gradient(circle_at_18%_18%,rgba(255,141,70,0.22),transparent_32%),radial-gradient(circle_at_82%_8%,rgba(109,152,255,0.22),transparent_30%)]" />
                            <div className="relative flex items-center justify-between">
                                <div className="space-y-1">
                                    <span className="ui-accent-chip inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] border px-3 py-1 rounded-full">
                                        <Sparkles className="h-3.5 w-3.5" />
                                        Upload CSV
                                    </span>
                                    <h2 className="text-2xl font-black ui-text leading-tight">Bulk Upload Produk</h2>
                                    <p className="text-sm ui-text-muted">Tambahkan banyak produk sekaligus dengan mapping kategori, operator, dan jenis produk internal yang lengkap.</p>
                                </div>
                                <button onClick={() => setIsBulkModalOpen(false)} className="p-2 ui-text-muted hover:text-[var(--ui-text)] hover:bg-[var(--ui-card-muted)] rounded-lg transition-colors">
                                    <X className="w-5 h-5" />
                                </button>
                            </div>
                        </div>

                        <div className="p-6 space-y-6">
                            {/* Formatting Guide */}
                            <div className="ui-info-chip rounded-xl border p-4 text-sm">
                                <div className="flex items-center gap-2 mb-2 font-semibold">
                                    <AlertCircle className="w-4 h-4" />
                                    Mapping internal wajib
                                </div>
                                <p className="text-xs opacity-85 mb-3">
                                    Semua produk di upload ini akan dipasang ke satu kategori, operator, dan jenis produk internal. Kolom legacy kategori/brand tidak lagi dipakai sebagai sumber relasi.
                                </p>
                                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
                                    <div>
                                        <label className="block text-xs font-semibold mb-1">Kategori (internal)</label>
                                        <select
                                            value={bulkCategoryId}
                                            onChange={(e) => { setBulkCategoryId(e.target.value); setBulkOperatorId(''); setBulkProductTypeId(''); }}
                                            className="w-full rounded-xl border ui-border ui-panel px-3 py-2 text-sm ui-text focus:border-[var(--ui-accent)] focus:ring-[var(--ui-accent)]"
                                        >
                                            <option value="">Pilih kategori</option>
                                            {categories.map((c) => (
                                                <option key={c._id} value={c._id}>{c.name}</option>
                                            ))}
                                        </select>
                                    </div>
                                    <div>
                                        <label className="block text-xs font-semibold mb-1">Operator (internal)</label>
                                        <select
                                            value={bulkOperatorId}
                                            onChange={(e) => { setBulkOperatorId(e.target.value); setBulkProductTypeId(''); }}
                                            disabled={!bulkCategoryId}
                                            className="w-full rounded-xl border ui-border ui-panel px-3 py-2 text-sm ui-text focus:border-[var(--ui-accent)] focus:ring-[var(--ui-accent)] disabled:ui-panel"
                                        >
                                            <option value="">Pilih operator</option>
                                            {filteredBulkMapOperators.map((o) => (
                                                <option key={o._id} value={o._id}>{o.name}</option>
                                            ))}
                                        </select>
                                    </div>
                                    <div>
                                        <label className="block text-xs font-semibold mb-1">Jenis Produk (internal)</label>
                                        <select
                                            value={bulkProductTypeId}
                                            onChange={(e) => setBulkProductTypeId(e.target.value)}
                                            disabled={!bulkOperatorId}
                                            className="w-full rounded-xl border ui-border ui-panel px-3 py-2 text-sm ui-text focus:border-[var(--ui-accent)] focus:ring-[var(--ui-accent)] disabled:ui-panel"
                                        >
                                            <option value="">Pilih jenis produk</option>
                                            {filteredBulkMapProductTypes.map((pt) => (
                                                <option key={pt._id} value={pt._id}>{pt.name}</option>
                                            ))}
                                        </select>
                                    </div>
                                </div>
                                <div className="flex items-center gap-2 mb-2 font-semibold">
                                    <AlertCircle className="w-4 h-4" />
                                    Format CSV (satu produk per baris)
                                </div>
                                <code className="block ui-panel p-3 rounded-lg text-xs font-mono ui-text mb-3 border ui-border overflow-x-auto">
                                    kode,nama,harga_modal,harga_basic,harga_gold,harga_platinum
                                </code>
                                <div className="flex items-center gap-2 mb-1 text-xs ui-info-text">
                                    <span className="w-1 h-1 rounded-full bg-[var(--ui-info)]" />
                                    Format lama tetap didukung:
                                </div>
                                <code className="block bg-black/30 p-3 rounded-lg text-xs font-mono ui-text-muted border ui-border overflow-x-auto">
                                    TSEL10,Pulsa Telkomsel 10rb,Pulsa,Telkomsel,10200,10500,10400,10300
                                </code>
                                <code className="block bg-black/30 p-3 rounded-lg text-xs font-mono ui-text-muted border ui-border overflow-x-auto mt-2">
                                    TSEL10,Pulsa Telkomsel 10rb,10200,10500,10400,10300
                                </code>
                            </div>

                            {/* Input Area */}
                            <div>
                                <label className="block text-sm font-semibold ui-text-muted mb-2">Data Produk (CSV)</label>
                                <textarea
                                    value={bulkData}
                                    onChange={(e) => setBulkData(e.target.value)}
                                    className="w-full px-4 py-3 ui-panel border ui-border rounded-xl focus:outline-none focus:border-[var(--ui-accent)] focus:ring-1 focus:ring-[var(--ui-accent)] font-mono text-xs sm:text-sm ui-text placeholder-[var(--ui-text-muted)] min-h-[200px]"
                                    placeholder="Paste data CSV anda disini..."
                                />
                            </div>

                            {/* Actions */}
                            <div className="flex gap-3 pt-2">
                                <button
                                    onClick={() => setIsBulkModalOpen(false)}
                                    className="flex-1 px-4 py-2.5 border ui-border ui-text-muted rounded-xl hover:bg-[var(--ui-card-bg)] transition-colors font-medium"
                                >
                                    Batal
                                </button>
                                <button
                                    onClick={handleBulkSubmit}
                                    disabled={bulkLoading || !bulkData.trim() || !bulkCategoryId || !bulkOperatorId || !bulkProductTypeId}
                                    className="flex-1 px-4 py-2.5 ui-accent-solid rounded-xl hover:shadow-[0_4px_20px_rgba(255,140,66,0.3)] transition-all font-semibold disabled:opacity-50 disabled:shadow-none"
                                >
                                    {bulkLoading ? 'Mengupload...' : 'Upload Produk'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Tokovoucher Import Modal */}
            {isVendorImportOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
                    <div className="w-full max-w-6xl rounded-2xl border border-[var(--ui-accent)]/25 ui-panel shadow-[0_30px_90px_rgba(0,0,0,0.55)] overflow-hidden">
                        <div className="ui-card-gradient relative p-5 border-b ui-border">
                            <div className="absolute inset-0 pointer-events-none opacity-30 bg-[radial-gradient(circle_at_18%_18%,rgba(255,141,70,0.22),transparent_32%),radial-gradient(circle_at_82%_8%,rgba(109,152,255,0.22),transparent_30%)]" />
                            <div className="relative flex items-center justify-between">
                                <div className="space-y-1">
                                    <span className="ui-accent-chip inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] border px-3 py-1 rounded-full">
                                        <Sparkles className="h-3.5 w-3.5" />
                                        Tokovoucher import
                                    </span>
                                    <div className="flex items-center gap-3">
                                        <h3 className="text-2xl font-black ui-text leading-tight">Import Produk Tokovoucher</h3>
                                        <span className="text-xs ui-text-muted ui-panel border ui-border px-3 py-1 rounded-full">Filter & pilih produk</span>
                                    </div>
                                    <p className="text-sm ui-text-muted">Pilih kategori → operator → jenis, centang produk, lalu mapping ke kategori, operator, dan jenis produk internal.</p>
                                </div>
                                <button onClick={() => setIsVendorImportOpen(false)} className="p-2 ui-text-muted hover:text-[var(--ui-text)] hover:bg-[var(--ui-card-muted)] rounded-lg transition-colors">
                                    <X className="w-5 h-5" />
                                </button>
                            </div>
                        </div>

                        <div className="p-5 space-y-4">
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                <div>
                                    <label className="block text-xs font-semibold ui-text mb-1">Kategori (internal)</label>
                                    <select
                                        value={mapCategoryId}
                                        onChange={(e) => { setMapCategoryId(e.target.value); setMapOperatorId(''); setMapProductTypeId(''); }}
                                        className="w-full rounded-xl border ui-border ui-panel px-3 py-2 text-sm ui-text focus:border-[var(--ui-accent)] focus:ring-[var(--ui-accent)]"
                                    >
                                        <option value="">Pilih kategori</option>
                                        {categories.map((c) => (
                                            <option key={c._id} value={c._id}>{c.name}</option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-xs font-semibold ui-text mb-1">Operator (internal)</label>
                                    <select
                                        value={mapOperatorId}
                                        onChange={(e) => { setMapOperatorId(e.target.value); setMapProductTypeId(''); }}
                                        disabled={!mapCategoryId}
                                        className="w-full rounded-xl border ui-border ui-panel px-3 py-2 text-sm ui-text focus:border-[var(--ui-accent)] focus:ring-[var(--ui-accent)] disabled:ui-panel"
                                    >
                                        <option value="">Pilih operator</option>
                                        {filteredMapOperators.map((o) => (
                                            <option key={o._id} value={o._id}>{o.name}</option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-xs font-semibold ui-text mb-1">Jenis Produk (internal)</label>
                                    <select
                                        value={mapProductTypeId}
                                        onChange={(e) => setMapProductTypeId(e.target.value)}
                                        disabled={!mapOperatorId}
                                        className="w-full rounded-xl border ui-border ui-panel px-3 py-2 text-sm ui-text focus:border-[var(--ui-accent)] focus:ring-[var(--ui-accent)] disabled:ui-panel"
                                    >
                                        <option value="">Pilih jenis produk</option>
                                        {filteredMapProductTypes.map((pt) => (
                                            <option key={pt._id} value={pt._id}>{pt.name}</option>
                                        ))}
                                    </select>
                                </div>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                <div>
                                    <label className="block text-xs font-semibold ui-text mb-1">Kategori</label>
                                    <select
                                        value={tvSelectedCategory}
                                        onChange={(e) => handleTvCategoryChange(e.target.value)}
                                        className="w-full rounded-xl border ui-border ui-panel px-3 py-2 text-sm ui-text focus:border-[var(--ui-accent)] focus:ring-[var(--ui-accent)]"
                                    >
                                        <option value="">Pilih kategori</option>
                                        {tvCategories.map((c) => (
                                            <option key={c._id} value={c._id}>{c.name}</option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-xs font-semibold ui-text mb-1">Operator</label>
                                    <select
                                        value={tvSelectedOperator}
                                        onChange={(e) => handleTvOperatorChange(e.target.value)}
                                        disabled={!tvSelectedCategory}
                                        className="w-full rounded-xl border ui-border ui-panel px-3 py-2 text-sm ui-text focus:border-[var(--ui-accent)] focus:ring-[var(--ui-accent)] disabled:ui-panel"
                                    >
                                        <option value="">Pilih operator</option>
                                        {tvOperators.map((o) => (
                                            <option key={o._id} value={o._id}>{o.name}</option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-xs font-semibold ui-text mb-1">Jenis Produk</label>
                                    <select
                                        value={tvSelectedJenis}
                                        onChange={(e) => handleTvJenisChange(e.target.value)}
                                        disabled={!tvSelectedOperator}
                                        className="w-full rounded-xl border ui-border ui-panel px-3 py-2 text-sm ui-text focus:border-[var(--ui-accent)] focus:ring-[var(--ui-accent)] disabled:ui-panel"
                                    >
                                        <option value="">Pilih jenis</option>
                                        {tvJenis.map((j) => (
                                            <option key={j._id} value={j._id}>{j.name}</option>
                                        ))}
                                    </select>
                                </div>
                            </div>

                            <div className="flex items-center gap-3">
                                <div className="relative w-full md:w-80">
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ui-text-muted" />
                                    <input
                                        type="text"
                                        value={tvSearch}
                                        onChange={(e) => setTvSearch(e.target.value)}
                                        className="pl-9 pr-3 py-2 w-full border ui-border ui-panel rounded-xl text-sm ui-text focus:border-[var(--ui-accent)] focus:ring-[var(--ui-accent)]"
                                        placeholder="Cari SKU atau nama produk"
                                    />
                                </div>
                                {tvLoading && <span className="text-xs ui-text-muted">Memuat...</span>}
                                <div className="text-xs ui-text-muted">Terpilih: <span className="font-semibold">{Object.keys(tvSelectedMap).length}</span></div>
                            </div>

                            <div className="ui-panel overflow-hidden rounded-2xl border ui-border">
                                <div className="max-h-80 overflow-y-auto">
                                    <table className="min-w-full text-sm">
                                        <thead className="ui-panel-muted text-left text-xs font-semibold ui-text-muted">
                                            <tr>
                                                <th className="px-3 py-2 w-10">Pilih</th>
                                                <th className="px-3 py-2">SKU Vendor</th>
                                                <th className="px-3 py-2">Nama</th>
                                                <th className="px-3 py-2">Harga Modal</th>
                                                <th className="px-3 py-2">Kode Custom</th>
                                                <th className="px-3 py-2">Harga Basic/Gold/Platinum</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {filteredTvProducts.map((p, idx) => {
                                                const sku = p.buyer_sku_code || p.code || p.kode || '';
                                                const name = p.product_name || p.nama_produk || p.name || p.nama || sku || 'Produk Tanpa Nama';
                                                const cost = p.buyer_product_price || p.price || p.harga || 0;
                                                const selected = tvSelectedMap[sku];
                                                return (
                                                    <tr key={`${sku}-${idx}`} className="border-t ui-border hover:bg-[var(--ui-card-bg)]">
                                                        <td className="px-3 py-2 align-top">
                                                            <input
                                                                type="checkbox"
                                                                checked={!!selected}
                                                                onChange={(e) => handleTvSelect(p, e.target.checked)}
                                                                className="h-4 w-4 ui-accent-text"
                                                            />
                                                        </td>
                                                        <td className="px-3 py-2 align-top">
                                                            <code className="text-xs ui-panel-muted px-2 py-1 rounded ui-accent-text">{sku}</code>
                                                        </td>
                                                        <td className="px-3 py-2 align-top">
                                                            <div className="font-medium ui-text">{name}</div>
                                                        </td>
                                                        <td className="px-3 py-2 align-top ui-accent-text font-semibold">Rp{cost.toLocaleString('id-ID')}</td>
                                                        <td className="px-3 py-2 align-top">
                                                            <input
                                                                type="text"
                                                                value={selected?.code || sku}
                                                                onChange={(e) => handleTvFieldChange(sku, 'code', e.target.value)}
                                                                disabled={!selected}
                                                                className="w-32 border ui-border ui-panel rounded-lg px-2 py-1 text-sm ui-text disabled:ui-panel"
                                                            />
                                                        </td>
                                                        <td className="px-3 py-2 align-top">
                                                            <div className="grid grid-cols-3 gap-2">
                                                                {(['basic', 'gold', 'platinum'] as const).map((tier) => (
                                                                    <div key={tier}>
                                                                        <input
                                                                            type="number"
                                                                            min="0"
                                                                            value={selected ? selected.price[tier] : ''}
                                                                            onChange={(e) => handleTvFieldChange(sku, tier, e.target.value)}
                                                                            disabled={!selected}
                                                                            className="w-full border ui-border ui-panel rounded-lg px-2 py-2 text-xs ui-text disabled:ui-panel"
                                                                        />
                                                                        <p className="text-[10px] ui-text-muted capitalize">{tier}</p>
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                            {filteredTvProducts.length === 0 && (
                                                <tr>
                                                    <td colSpan={6} className="px-3 py-6 text-center text-sm ui-text-muted">Tidak ada data</td>
                                                </tr>
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            </div>

                            <div className="flex justify-between items-center">
                                <div className="text-xs ui-text-muted">Harga jual otomatis: Basic +{marginConfig.basic}%, Gold +{marginConfig.gold}%, Platinum +{marginConfig.platinum}% dari modal (bisa diedit per produk).</div>
                                <div className="flex gap-2">
                                    <button
                                        onClick={() => setIsVendorImportOpen(false)}
                                        className="px-4 py-2 rounded-xl border ui-border text-sm font-semibold ui-text hover:bg-[var(--ui-card-muted)]"
                                    >
                                        Batal
                                    </button>
                                    <button
                                        onClick={handleTvImport}
                                        disabled={tvLoading || Object.keys(tvSelectedMap).length === 0 || !mapCategoryId || !mapOperatorId || !mapProductTypeId}
                                        className="px-4 py-2 rounded-xl ui-accent-solid text-sm font-semibold shadow-sm hover:shadow-[0_14px_46px_rgba(255,140,66,0.36)] disabled:opacity-50"
                                    >
                                        {tvLoading ? 'Mengimpor...' : 'Import ke Produk'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Digiflazz Import Modal */}
            {isDgImportOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
                    <div className="w-full max-w-6xl rounded-2xl border border-[var(--ui-accent)]/25 ui-panel shadow-[0_30px_90px_rgba(0,0,0,0.55)] overflow-hidden max-h-[90vh]">
                        <div className="ui-card-gradient relative p-5 border-b ui-border">
                            <div className="absolute inset-0 pointer-events-none opacity-30 bg-[radial-gradient(circle_at_18%_18%,rgba(255,141,70,0.22),transparent_32%),radial-gradient(circle_at_82%_8%,rgba(109,152,255,0.22),transparent_30%)]" />
                            <div className="relative flex items-center justify-between">
                                <div className="space-y-1">
                                    <span className="ui-accent-chip inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.18em] border px-3 py-1 rounded-full">
                                        <Sparkles className="h-3.5 w-3.5" />
                                        Digiflazz import
                                    </span>
                                    <div className="flex items-center gap-3">
                                        <h3 className="text-2xl font-black ui-text leading-tight">Import Produk Digiflazz</h3>
                                        <span className="text-xs ui-text-muted ui-panel border ui-border px-3 py-1 rounded-full">Pilih & mapping</span>
                                    </div>
                                    <p className="text-sm ui-text-muted">Pilih kategori/brand Digiflazz, centang produk, lalu mapping ke kategori, operator, dan jenis produk internal.</p>
                                </div>
                                <button onClick={() => setIsDgImportOpen(false)} className="p-2 ui-text-muted hover:text-[var(--ui-text)] hover:bg-[var(--ui-card-muted)] rounded-lg transition-colors">
                                    <X className="w-5 h-5" />
                                </button>
                            </div>
                        </div>

                        <div className="p-5 space-y-4 overflow-y-auto max-h-[calc(90vh-40px)]">
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                <div>
                                    <label className="block text-xs font-semibold ui-text mb-1">Kategori (internal)</label>
                                    <select
                                        value={dgMapCategoryId}
                                        onChange={(e) => { setDgMapCategoryId(e.target.value); setDgMapOperatorId(''); setDgMapProductTypeId(''); }}
                                        className="w-full rounded-xl border ui-border ui-panel px-3 py-2 text-sm ui-text focus:border-[var(--ui-accent)] focus:ring-[var(--ui-accent-soft)]"
                                    >
                                        <option value="">Pilih kategori</option>
                                        {categories.map((c) => (
                                            <option key={c._id} value={c._id}>{c.name}</option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-xs font-semibold ui-text mb-1">Operator (internal)</label>
                                    <select
                                        value={dgMapOperatorId}
                                        onChange={(e) => { setDgMapOperatorId(e.target.value); setDgMapProductTypeId(''); }}
                                        disabled={!dgMapCategoryId}
                                        className="w-full rounded-xl border ui-border ui-panel px-3 py-2 text-sm ui-text focus:border-[var(--ui-accent)] focus:ring-[var(--ui-accent-soft)] disabled:ui-panel"
                                    >
                                        <option value="">Pilih operator</option>
                                        {filteredDgMapOperators.map((o) => (
                                            <option key={o._id} value={o._id}>{o.name}</option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-xs font-semibold ui-text mb-1">Jenis Produk (internal)</label>
                                    <select
                                        value={dgMapProductTypeId}
                                        onChange={(e) => setDgMapProductTypeId(e.target.value)}
                                        disabled={!dgMapOperatorId}
                                        className="w-full rounded-xl border ui-border ui-panel px-3 py-2 text-sm ui-text focus:border-[var(--ui-accent)] focus:ring-[var(--ui-accent-soft)] disabled:ui-panel"
                                    >
                                        <option value="">Pilih jenis produk</option>
                                        {filteredDgMapProductTypes.map((pt) => (
                                            <option key={pt._id} value={pt._id}>{pt.name}</option>
                                        ))}
                                    </select>
                                </div>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                <div>
                                    <label className="block text-xs font-semibold ui-text mb-1">Kategori Digiflazz</label>
                                    <select
                                        value={dgSelectedCategory}
                                        onChange={(e) => { setDgSelectedCategory(e.target.value); fetchDgProducts(e.target.value, dgSelectedBrand); }}
                                        className="w-full rounded-xl border ui-border ui-panel px-3 py-2 text-sm ui-text focus:border-[var(--ui-accent)] focus:ring-[var(--ui-accent-soft)]"
                                    >
                                        <option value="">Semua kategori</option>
                                        {dgCategories.map((c) => (
                                            <option key={c} value={c}>{c}</option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label className="block text-xs font-semibold ui-text mb-1">Brand Digiflazz</label>
                                    <select
                                        value={dgSelectedBrand}
                                        onChange={(e) => { setDgSelectedBrand(e.target.value); fetchDgProducts(dgSelectedCategory, e.target.value); }}
                                        className="w-full rounded-xl border ui-border ui-panel px-3 py-2 text-sm ui-text focus:border-[var(--ui-accent)] focus:ring-[var(--ui-accent-soft)]"
                                    >
                                        <option value="">Semua brand</option>
                                        {dgBrands.map((b) => (
                                            <option key={b} value={b}>{b}</option>
                                        ))}
                                    </select>
                                </div>
                            </div>

                            <div className="flex items-center gap-3">
                                <div className="relative w-full md:w-80">
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ui-text-muted" />
                                    <input
                                        type="text"
                                        value={dgSearch}
                                        onChange={(e) => setDgSearch(e.target.value)}
                                        className="pl-9 pr-3 py-2 w-full border ui-border ui-panel rounded-xl text-sm ui-text focus:border-[var(--ui-accent)] focus:ring-[var(--ui-accent-soft)]"
                                        placeholder="Cari SKU atau nama produk"
                                    />
                                </div>
                                {dgLoading && <span className="text-xs ui-text-muted">Memuat...</span>}
                                <div className="text-xs ui-text-muted">Terpilih: <span className="font-semibold">{Object.keys(dgSelectedMap).length}</span></div>
                            </div>

                            <div className="ui-panel overflow-hidden rounded-2xl border ui-border">
                                <div className="max-h-80 overflow-y-auto">
                                    <table className="min-w-full text-sm">
                                        <thead className="ui-panel-muted text-left text-xs font-semibold ui-text-muted">
                                            <tr>
                                                <th className="px-3 py-2 w-10">Pilih</th>
                                                <th className="px-3 py-2">SKU Vendor</th>
                                                <th className="px-3 py-2">Nama</th>
                                                <th className="px-3 py-2">Harga Modal</th>
                                                <th className="px-3 py-2">Kode Custom</th>
                                                <th className="px-3 py-2">Harga Basic/Gold/Platinum</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {filteredDgProducts.map((p, idx) => {
                                                const sku = p.buyer_sku_code || '';
                                                const name = p.product_name || sku || 'Produk Tanpa Nama';
                                                const cost = p.buyer_product_price || p.price || 0;
                                                const selected = dgSelectedMap[sku];
                                                return (
                                                    <tr key={`${sku}-${idx}`} className="border-t ui-border hover:bg-[var(--ui-card-bg)]">
                                                        <td className="px-3 py-2 align-top">
                                                            <input
                                                                type="checkbox"
                                                                checked={!!selected}
                                                                onChange={(e) => handleDgSelect(p, e.target.checked)}
                                                                className="h-4 w-4 ui-accent-text"
                                                            />
                                                        </td>
                                                        <td className="px-3 py-2 align-top">
                                                            <code className="text-xs ui-panel-muted px-2 py-1 rounded ui-accent-text">{sku}</code>
                                                        </td>
                                                        <td className="px-3 py-2 align-top">
                                                            <div className="font-medium ui-text">{name}</div>
                                                        </td>
                                                        <td className="px-3 py-2 align-top ui-accent-text font-semibold">Rp{cost.toLocaleString('id-ID')}</td>
                                                        <td className="px-3 py-2 align-top">
                                                            <input
                                                                type="text"
                                                                value={selected?.code || sku}
                                                                onChange={(e) => handleDgFieldChange(sku, 'code', e.target.value)}
                                                                disabled={!selected}
                                                                className="w-32 border ui-border ui-panel rounded-lg px-2 py-1 text-sm ui-text disabled:ui-panel"
                                                            />
                                                        </td>
                                                        <td className="px-3 py-2 align-top">
                                                            <div className="grid grid-cols-3 gap-2">
                                                                {(['basic', 'gold', 'platinum'] as const).map((tier) => (
                                                                    <div key={tier}>
                                                                        <input
                                                                            type="number"
                                                                            min="0"
                                                                            value={selected ? selected.price[tier] : ''}
                                                                            onChange={(e) => handleDgFieldChange(sku, tier, e.target.value)}
                                                                            disabled={!selected}
                                                                            className="w-full border ui-border ui-panel rounded-lg px-2 py-2 text-xs ui-text disabled:ui-panel"
                                                                        />
                                                                        <p className="text-[10px] ui-text-muted capitalize">{tier}</p>
                                                                    </div>
                                                                ))}
                                                            </div>
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                            {filteredDgProducts.length === 0 && (
                                                <tr>
                                                    <td colSpan={6} className="px-3 py-6 text-center text-sm ui-text-muted">
                                                        {dgSelectedCategory || dgSelectedBrand ? 'Tidak ada data' : 'Pilih kategori atau brand untuk memuat produk'}
                                                    </td>
                                                </tr>
                                            )}
                                        </tbody>
                                    </table>
                                </div>
                            </div>

                            <div className="flex justify-between items-center">
                                <div className="text-xs ui-text-muted">Harga jual otomatis: Basic +{marginConfig.basic}%, Gold +{marginConfig.gold}%, Platinum +{marginConfig.platinum}% dari modal (bisa diedit per produk).</div>
                                <div className="flex gap-2">
                                    <button
                                        onClick={() => setIsDgImportOpen(false)}
                                        className="px-4 py-2 rounded-xl border ui-border text-sm font-semibold ui-text hover:bg-[var(--ui-card-muted)]"
                                    >
                                        Batal
                                    </button>
                                    <button
                                        onClick={handleDgImport}
                                        disabled={dgLoading || Object.keys(dgSelectedMap).length === 0 || !dgMapCategoryId || !dgMapOperatorId || !dgMapProductTypeId}
                                        className="px-4 py-2 rounded-xl bg-gradient-to-r from-blue-500 to-cyan-500 ui-text text-sm font-semibold shadow-sm hover:shadow-[0_14px_46px_rgba(80,180,255,0.36)] disabled:opacity-50"
                                    >
                                        {dgLoading ? 'Mengimpor...' : 'Import ke Produk'}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {showDeleteModal && selectedDeleteProduct && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
                    <div className="w-full max-w-md rounded-2xl border ui-border ui-panel shadow-[0_30px_90px_rgba(0,0,0,0.55)] overflow-hidden">
                        <div className="ui-card-gradient border-b ui-border p-5">
                            <div className="flex items-start justify-between gap-4">
                                <div>
                                    <span className="ui-danger-chip inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] uppercase tracking-[0.18em]">
                                        <Trash2 className="h-3.5 w-3.5" />
                                        {selectedDeleteProduct.status ? 'Arsip produk' : 'Hapus permanen'}
                                    </span>
                                    <h3 className="mt-2 text-xl font-black ui-text">
                                        {selectedDeleteProduct.status ? 'Arsipkan produk ini?' : 'Hapus permanen produk ini?'}
                                    </h3>
                                </div>
                                <button
                                    onClick={() => {
                                        setShowDeleteModal(false);
                                        setSelectedDeleteProduct(null);
                                    }}
                                    className="rounded-lg p-2 ui-text-muted hover:bg-[var(--ui-card-muted)] hover:text-[var(--ui-text)]"
                                >
                                    <X className="h-5 w-5" />
                                </button>
                            </div>
                        </div>

                        <div className="space-y-4 p-5">
                            <div className="rounded-xl border ui-border ui-panel p-4">
                                <p className="text-sm font-semibold ui-text">{selectedDeleteProduct.name}</p>
                                <p className="mt-1 text-xs ui-text-muted">Kode: {selectedDeleteProduct.code}</p>
                                <p className="mt-2 text-sm ui-text-muted">
                                    {selectedDeleteProduct.status
                                        ? 'Produk aktif akan diubah menjadi nonaktif terlebih dahulu. Produk tetap tersimpan dan bisa diaktifkan lagi nanti.'
                                        : 'Produk nonaktif akan dihapus permanen dari database. Tindakan ini tidak bisa dibatalkan.'}
                                </p>
                            </div>

                            {selectedDeleteProduct.status && selectedDeleteProduct.canPurchase === false && (
                                <div className="ui-warning-chip rounded-xl border p-4 text-sm">
                                    Produk ini juga sedang tersembunyi karena: {selectedDeleteProduct.visibilityIssues?.join(', ') || 'parent nonaktif'}.
                                </div>
                            )}

                            <div className="flex gap-3">
                                <button
                                    onClick={() => {
                                        setShowDeleteModal(false);
                                        setSelectedDeleteProduct(null);
                                    }}
                                    className="flex-1 rounded-xl border ui-border px-4 py-2.5 ui-text hover:bg-[var(--ui-card-muted)] transition-colors"
                                >
                                    Batal
                                </button>
                                <button
                                    onClick={handleDeleteProduct}
                                    disabled={actionLoadingId === selectedDeleteProduct._id}
                                    className="ui-danger-action flex-1 rounded-xl px-4 py-2.5 font-semibold transition-colors disabled:opacity-50"
                                >
                                    {actionLoadingId === selectedDeleteProduct._id
                                        ? 'Memproses...'
                                        : selectedDeleteProduct.status ? 'Arsipkan' : 'Hapus Permanen'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {canManageProducts && (
                <ProductModal
                    isOpen={isModalOpen}
                    onClose={() => setIsModalOpen(false)}
                    onSubmit={handleSubmit}
                    initialData={selectedProduct}
                />
            )}

            {canManageProducts && (
                <ProductSorting
                    isOpen={isSortingOpen}
                    onClose={() => setIsSortingOpen(false)}
                    categories={categories}
                    operators={operatorsAll}
                    productTypes={productTypesAll}
                />
            )}
        </div>
    );
}
