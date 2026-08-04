import { useState, useEffect, useMemo } from 'react';
import { X, Search, Image as ImageIcon, Loader2, LayoutGrid, DollarSign, Settings, Box, Tag, Globe, Database, FolderOpen } from 'lucide-react';
import { apiV2 } from '../../api';
import ImagePicker from './ImagePicker';

interface Category {
    _id: string;
    name: string;
    icon: string;
    status?: boolean;
}

interface Operator {
    _id: string;
    name: string;
    icon?: string;
    categoryId: string | { _id: string };
}

interface ProductType {
    _id: string;
    name: string;
    operatorId: string | { _id: string };
    categoryId: string | { _id: string };
}

interface VendorProduct {
    code?: string;
    sku_code?: string;
    buyer_sku_code?: string;
    kode?: string;
    product_name?: string;
    nama?: string;
    nama_produk?: string;
    price?: number;
    harga?: number;
    buyer_product_price?: number;
    category?: string;
    brand?: string;
    operator?: string;
    operator_produk?: string;
    category_name?: string;
}

interface Product {
    _id?: string;
    name: string;
    code: string;
    category: string;
    categoryId?: string | { _id: string; name: string; icon: string } | null;
    operatorId?: string | { _id: string; name: string } | null;
    productTypeId?: string | { _id: string; name: string } | null;
    paymentType?: 'prabayar' | 'pascabayar';
    icon?: string;
    rewardPoints?: number;
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
    status: boolean;
}

interface ProductModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSubmit: (product: Product) => Promise<void>;
    initialData?: Product | null;
}

export default function ProductModal({ isOpen, onClose, onSubmit, initialData }: ProductModalProps) {
    const [categories, setCategories] = useState<Category[]>([]);
    const [operators, setOperators] = useState<Operator[]>([]);
    const [productTypes, setProductTypes] = useState<ProductType[]>([]);
    const [formData, setFormData] = useState<Product>({
        name: '',
        code: '',
        category: '',
        categoryId: '',
        operatorId: '',
        productTypeId: '',
        paymentType: 'prabayar',
        icon: '',
        rewardPoints: 0,
        brand: '',
        costPrice: 0,
        price: { basic: 0, gold: 0, platinum: 0 },
        vendor: { name: '', sku: '' },
        status: true
    });
    const [loading, setLoading] = useState(false);
    const [uploadingIcon, setUploadingIcon] = useState(false);
    const [showIconPicker, setShowIconPicker] = useState(false);
    const [submitError, setSubmitError] = useState<string | null>(null);

    // Vendor integration state
    const [selectedVendor, setSelectedVendor] = useState<'manual' | 'digiflazz' | 'tokovoucher'>('manual');
    const [vendorSkuSearch, setVendorSkuSearch] = useState('');
    const [vendorSearchResults, setVendorSearchResults] = useState<VendorProduct[]>([]);
    const [vendorSearchLoading, setVendorSearchLoading] = useState(false);
    const [showVendorResults, setShowVendorResults] = useState(false);
    const [vendorAvailability, setVendorAvailability] = useState({ digiflazz: false, tokovoucher: false });

    // Margin state
    const [showMarginModal, setShowMarginModal] = useState(false);
    const [margins, setMargins] = useState({ basic: 10, gold: 5, platinum: 0 });
    const [globalMargins, setGlobalMargins] = useState({ basic: 10, gold: 5, platinum: 0 });

    const vendorOptions = useMemo(() => [
        { key: 'manual', label: 'Manual', color: 'gray', visible: true },
        { key: 'digiflazz', label: 'Digiflazz', color: 'blue', visible: vendorAvailability.digiflazz },
        { key: 'tokovoucher', label: 'Tokovoucher', color: 'orange', visible: vendorAvailability.tokovoucher }
    ].filter(v => v.visible), [vendorAvailability]);

    useEffect(() => {
        if (isOpen) {
            fetchData();
        }
    }, [isOpen]);

    useEffect(() => {
        if (initialData) {
            const catId = typeof initialData.categoryId === 'object'
                ? initialData.categoryId?._id
                : initialData.categoryId;
            const opId = typeof initialData.operatorId === 'object'
                ? initialData.operatorId?._id
                : initialData.operatorId;
            const ptId = typeof initialData.productTypeId === 'object'
                ? initialData.productTypeId?._id
                : initialData.productTypeId;
            setFormData({
                ...initialData,
                categoryId: catId || '',
                operatorId: opId || '',
                productTypeId: ptId || '',
                paymentType: initialData.paymentType || 'prabayar',
                icon: initialData.icon || '',
                rewardPoints: initialData.rewardPoints ?? 0,
                costPrice: initialData.costPrice || 0,
                vendor: initialData.vendor || { name: '', sku: '' }
            });
            setSubmitError(null);
        } else {
            setSelectedVendor('manual');
            setVendorSkuSearch('');
            setVendorSearchResults([]);
            setShowVendorResults(false);
            setSubmitError(null);
            setFormData({
                name: '',
                code: '',
                category: '',
                categoryId: '',
                operatorId: '',
                productTypeId: '',
                paymentType: 'prabayar',
                icon: '',
                rewardPoints: 0,
                brand: '',
                costPrice: 0,
                price: { basic: 0, gold: 0, platinum: 0 },
                vendor: { name: '', sku: '' },
                status: true
            });
        }
    }, [initialData, isOpen]);

    const fetchData = async () => {
        try {
            const [catRes, opRes, ptRes, digiRes, tokoRes, marginsRes] = await Promise.all([
                apiV2.get('/categories/admin/all'),
                apiV2.get('/operators/admin/all'),
                apiV2.get('/product-types/admin/all').catch(() => ({ data: [] })),
                apiV2.get('/vendors/digiflazz/settings').catch(() => null),
                apiV2.get('/vendors/tokovoucher/settings').catch(() => null),
                apiV2.get('/margins').catch(() => ({ data: { success: true, data: { basic: 10, gold: 5, platinum: 0 } } }))
            ]);
            setCategories(catRes.data);
            setOperators(opRes.data);
            setProductTypes(ptRes.data || []);

            setVendorAvailability({
                digiflazz: !!(digiRes?.data?.configured && digiRes?.data?.status !== false),
                tokovoucher: !!(tokoRes?.data?.configured && tokoRes?.data?.status !== false)
            });

            if (marginsRes?.data?.success && marginsRes?.data?.data) {
                const m = marginsRes.data.data;
                const defaultMargins = {
                    basic: m.basic ?? 10,
                    gold: m.gold ?? 5,
                    platinum: m.platinum ?? 0
                };
                setGlobalMargins(defaultMargins);
                setMargins(defaultMargins);
            }
        } catch (error) {
            console.error('Failed to fetch data', error);
        }
    };

    const handleIconUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (!file.type.startsWith('image/')) {
            setSubmitError('File icon harus berupa gambar.');
            e.target.value = '';
            return;
        }
        setUploadingIcon(true);
        setSubmitError(null);
        try {
            const fd = new FormData();
            fd.append('file', file);
            const res = await apiV2
                .post('/upload?type=icons', fd, {
                    headers: { 'Content-Type': 'multipart/form-data' }
                });
            if (res.data?.url) {
                setFormData({ ...formData, icon: res.data.url });
            }
        } catch (error: any) {
            console.error('Icon upload failed', error);
            setSubmitError(error?.response?.data?.message || 'Gagal upload icon produk.');
        } finally {
            setUploadingIcon(false);
            e.target.value = '';
        }
    };

    // Helper to get ID from populated or string field
    const getId = (field: any): string => {
        if (!field) return '';
        if (typeof field === 'object') return field._id;
        return field;
    };

    // Filter operators by selected category
    const filteredOperators = useMemo(() => {
        const catId = getId(formData.categoryId);
        if (!catId) return [];
        return operators.filter(op => getId(op.categoryId) === catId);
    }, [operators, formData.categoryId]);

    // Filter product types by selected operator
    const filteredProductTypes = useMemo(() => {
        const opId = getId(formData.operatorId);
        if (!opId) return [];
        return productTypes.filter(pt => getId(pt.operatorId) === opId);
    }, [productTypes, formData.operatorId]);

    // Search vendor products
    const handleVendorSearch = async () => {
        if (!vendorSkuSearch.trim() || selectedVendor === 'manual') return;

        try {
            setVendorSearchLoading(true);
            setSubmitError(null);
            setShowVendorResults(true);

            let endpoint = '';
            if (selectedVendor === 'digiflazz') {
                endpoint = `/vendors/digiflazz/pricelist?sku=${encodeURIComponent(vendorSkuSearch.trim())}&limit=20`;
            } else if (selectedVendor === 'tokovoucher') {
                endpoint = `/vendors/tokovoucher/search?kode=${encodeURIComponent(vendorSkuSearch.trim())}`;
            }

            const res = await apiV2.get(endpoint);
            const data = res.data.data || [];
            setVendorSearchResults(data);
        } catch (error: any) {
            console.error('Vendor search failed:', error);
            setVendorSearchResults([]);
            setSubmitError(error?.response?.data?.message || 'Gagal mencari produk vendor.');
        } finally {
            setVendorSearchLoading(false);
        }
    };

    // Select product from vendor search results
    const sanitizeAmount = (value: unknown) => Math.max(0, Math.round(Number(value) || 0));

    const handleSelectVendorProduct = (vp: VendorProduct) => {
        const vendorSku = vp.buyer_sku_code || vp.sku_code || vp.code || vp.kode || '';
        const name = vp.product_name || vp.nama || vp.nama_produk || '';
        const vendorPrice = sanitizeAmount(vp.buyer_product_price || vp.price || vp.harga || 0);

        if (!vendorSku) {
            setSubmitError('Produk vendor tanpa SKU tidak bisa dipilih.');
            return;
        }

        setFormData({
            ...formData,
            name: name,
            code: formData.code || vendorSku,
            costPrice: vendorPrice,
            price: {
                basic: Math.round(vendorPrice * (1 + globalMargins.basic / 100)),
                gold: Math.round(vendorPrice * (1 + globalMargins.gold / 100)),
                platinum: Math.round(vendorPrice * (1 + globalMargins.platinum / 100))
            },
            vendor: {
                name: selectedVendor === 'digiflazz' ? 'Digiflazz' : 'Tokovoucher',
                sku: vendorSku
            }
        });
        setShowVendorResults(false);
        setVendorSkuSearch('');
    };

    // Apply margin to prices
    const applyMargins = () => {
        if (formData.costPrice <= 0) return;

        const basic = Math.round(formData.costPrice * (1 + margins.basic / 100));
        const gold = Math.round(formData.costPrice * (1 + margins.gold / 100));
        const platinum = Math.round(formData.costPrice * (1 + margins.platinum / 100));

        setFormData({
            ...formData,
            price: { basic, gold, platinum }
        });
        setShowMarginModal(false);
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        const categoryId = getId(formData.categoryId);
        const operatorId = getId(formData.operatorId);
        const productTypeId = getId(formData.productTypeId);

        if (!categoryId) {
            setSubmitError('Kategori produk wajib dipilih.');
            return;
        }

        if (!operatorId) {
            setSubmitError('Operator produk wajib dipilih.');
            return;
        }

        if (!productTypeId) {
            setSubmitError('Jenis produk wajib dipilih.');
            return;
        }

        setSubmitError(null);
        setLoading(true);
        try {
            await onSubmit(formData);
            onClose();
        } catch (error: any) {
            console.error(error);
            setSubmitError(error?.response?.data?.message || error?.message || 'Gagal menyimpan produk. Periksa kembali data produk.');
        } finally {
            setLoading(false);
        }
    };

    // Fallback to manual when vendor disabled
    useEffect(() => {
        if (selectedVendor !== 'manual') {
            if (selectedVendor === 'digiflazz' && !vendorAvailability.digiflazz) {
                setSelectedVendor('manual');
            }
            if (selectedVendor === 'tokovoucher' && !vendorAvailability.tokovoucher) {
                setSelectedVendor('manual');
            }
        }
    }, [vendorAvailability, selectedVendor]);

    // Auto-select vendor when editing if configured and available
    useEffect(() => {
        if (!initialData?.vendor?.name) return;
        const name = initialData.vendor.name.toLowerCase();
        let target: 'manual' | 'digiflazz' | 'tokovoucher' = 'manual';
        if (name.includes('digi')) target = 'digiflazz';
        else if (name.includes('toko')) target = 'tokovoucher';

        if (target === 'digiflazz' && vendorAvailability.digiflazz) {
            setSelectedVendor('digiflazz');
        } else if (target === 'tokovoucher' && vendorAvailability.tokovoucher) {
            setSelectedVendor('tokovoucher');
        }
    }, [initialData, vendorAvailability]);

    if (!isOpen) return null;

    const handleCategoryChange = (categoryId: string) => {
        const category = categories.find(c => c._id === categoryId);
        setSubmitError(null);
        setFormData({
            ...formData,
            categoryId,
            category: category?.name || '',
            operatorId: '',
            productTypeId: '',
            brand: ''
        });
    };

    const handleOperatorChange = (operatorId: string) => {
        const operator = operators.find(o => o._id === operatorId);
        setSubmitError(null);
        setFormData(prev => ({
            ...prev,
            operatorId,
            brand: operator?.name || '',
            productTypeId: '',
            icon: prev.icon || operator?.icon || ''
        }));
    };

    const handleProductTypeChange = (productTypeId: string) => {
        setSubmitError(null);
        setFormData({
            ...formData,
            productTypeId
        });
    };

    return (
        <div className="fixed inset-0 z-[60] overflow-y-auto" role="dialog" aria-modal="true" aria-labelledby="product-modal-title">
            <div className="flex items-center justify-center min-h-screen px-4 pt-4 pb-20 text-center sm:block sm:p-0">
                <div className="fixed inset-0 transition-opacity" aria-hidden="true">
                    <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose}></div>
                </div>

                <span className="hidden sm:inline-block sm:align-middle sm:h-screen" aria-hidden="true">&#8203;</span>

                <div className="inline-block align-bottom ui-panel rounded-xl text-left overflow-hidden shadow-2xl transform transition-all sm:my-8 sm:align-middle sm:max-w-4xl sm:w-full relative z-10">
                    {/* Header */}
                    <div className="ui-card-gradient px-6 py-4 border-b ui-border flex justify-between items-center">
                        <h3 id="product-modal-title" className="text-xl font-bold ui-text flex items-center gap-2">
                            {initialData ? <Settings className="w-5 h-5 ui-accent-text" /> : <Box className="w-5 h-5 ui-accent-text" />}
                            {initialData ? 'Edit Produk' : 'Tambah Produk Baru'}
                        </h3>
                        <button onClick={onClose} className="ui-text-muted hover:text-[var(--ui-text)] transition-colors rounded-full p-1 hover:bg-[var(--ui-card-muted)]" aria-label="Tutup modal produk">
                            <X className="w-6 h-6" />
                        </button>
                    </div>

                    <form onSubmit={handleSubmit} className="flex flex-col max-h-[85vh]">
                        <div className="flex-1 overflow-y-auto p-6 space-y-6">

                            {/* Top Section: Data Source / Vendor */}
                            <div className="ui-panel-muted border ui-border rounded-xl p-4">
                                <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between mb-4">
                                    <div className="flex items-center gap-2">
                                        <Database className="w-4 h-4 ui-accent-text" />
                                        <label className="text-sm font-medium ui-text">Sumber Data Vendor</label>
                                    </div>
                                    <div className="flex-1 w-full sm:max-w-md flex gap-2">
                                        <select
                                            value={selectedVendor}
                                            onChange={(e) => setSelectedVendor(e.target.value as 'manual' | 'digiflazz' | 'tokovoucher')}
                                            className="w-1/3 border rounded-lg py-2 px-3 ui-field text-sm"
                                        >
                                            {vendorOptions.map((opt) => (
                                                <option key={opt.key} value={opt.key}>{opt.label}</option>
                                            ))}
                                        </select>

                                        {selectedVendor !== 'manual' && (
                                            <div className="relative flex-1">
                                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ui-text-muted" />
                                                <input
                                                    type="text"
                                                    value={vendorSkuSearch}
                                                    onChange={(e) => setVendorSkuSearch(e.target.value)}
                                                    onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleVendorSearch())}
                                                    placeholder="Cari SKU / Nama Produk..."
                                                    className="w-full pl-10 pr-16 py-2 border rounded-lg ui-field text-sm"
                                                />
                                                <button
                                                    type="button"
                                                    onClick={handleVendorSearch}
                                                    disabled={vendorSearchLoading || !vendorSkuSearch.trim()}
                                                    className="absolute right-1 top-1 bottom-1 px-3 ui-accent-solid rounded-md disabled:opacity-50 text-xs font-medium"
                                                >
                                                    {vendorSearchLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Cari'}
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                </div>

                                {/* Vendor Results */}
                                {showVendorResults && vendorSearchResults.length > 0 && (
                                    <div className="border ui-border rounded-lg ui-panel max-h-60 overflow-y-auto scrollbar-thin">
                                        {vendorSearchResults.map((vp, idx) => {
                                            const sku = vp.buyer_sku_code || vp.sku_code || vp.code || vp.kode || '';
                                            const name = vp.product_name || vp.nama || vp.nama_produk || '';
                                            const price = vp.buyer_product_price || vp.price || vp.harga || 0;
                                            return (
                                                <div
                                                    key={idx}
                                                    onClick={() => handleSelectVendorProduct(vp)}
                                                    className="p-3 border-b ui-border last:border-0 hover:bg-[var(--ui-card-muted)] cursor-pointer flex justify-between items-center group transition-colors"
                                                >
                                                    <div>
                                                        <div className="flex items-center gap-2">
                                                            <span className="text-xs font-mono ui-info-chip border px-1.5 py-0.5 rounded">{sku}</span>
                                                            <span className="text-sm font-medium ui-text group-hover:text-[var(--ui-accent-strong)] transition-colors">{name}</span>
                                                        </div>
                                                        <div className="text-xs ui-text-muted mt-1">Klik untuk menggunakan data ini</div>
                                                    </div>
                                                    <div className="text-right">
                                                        <span className="block text-sm font-bold ui-accent-text">Rp{price.toLocaleString('id-ID')}</span>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}

                                {/* Selected Vendor Info */}
                                {formData.vendor?.name && formData.vendor?.name !== 'Custom Vendor' && (
                                    <div className="mt-3 flex items-center gap-3 text-xs border p-2.5 rounded-lg ui-info-chip">
                                        <Database className="w-4 h-4" />
                                        <span>Terhubung dengan <strong>{formData.vendor.name}</strong></span>
                                        <span className="w-px h-3 bg-[var(--ui-border)]"></span>
                                        <span>SKU: <code className="font-mono">{formData.vendor.sku}</code></span>
                                        <div className="ml-auto">
                                            <button
                                                type="button"
                                                onClick={() => setFormData({ ...formData, vendor: { name: '', sku: '' } })}
                                                className="ui-info-text hover:opacity-80 underline"
                                            >
                                                Putus Hubungan
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </div>

                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                                {/* Left Column: Identity & Classifier */}
                                <div className="space-y-6">
                                    {/* Identity Section */}
                                    <div className="ui-panel border ui-border rounded-xl p-5">
                                        <h4 className="flex items-center gap-2 text-sm font-semibold ui-text mb-4 pb-2 border-b ui-border">
                                            <Tag className="w-4 h-4 ui-accent-text" /> Identitas Produk
                                        </h4>
                                        <div className="space-y-4">
                                            <div>
                                                <label className="block text-xs font-medium ui-text-muted mb-1">Nama Produk</label>
                                                <input
                                                    type="text"
                                                    required
                                                    value={formData.name}
                                                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                                                    className="block w-full border rounded-lg py-2 px-3 ui-field text-sm"
                                                    placeholder="Contoh: Pulsa Telkomsel 10rb"
                                                />
                                            </div>
                                            <div>
                                                <label className="block text-xs font-medium ui-text-muted mb-1">Kode Produk (SKU Toko)</label>
                                                <input
                                                    type="text"
                                                    required
                                                    value={formData.code}
                                                    onChange={(e) => setFormData({ ...formData, code: e.target.value })}
                                                    className="block w-full border rounded-lg py-2 px-3 ui-field text-sm font-mono"
                                                    placeholder="Contoh: TSEL10"
                                                />
                                                <p className="text-[10px] ui-text-muted mt-1">Kode unik untuk transaksi internal</p>
                                            </div>

                                            {/* Icon Upload */}
                                            <div>
                                                <label className="block text-xs font-medium ui-text-muted mb-2">Icon Produk</label>
                                                <div className="flex gap-4">
                                                    <div className="flex-shrink-0">
                                                        <div className="w-20 h-20 rounded-lg border-2 border-dashed ui-border ui-panel-muted flex items-center justify-center overflow-hidden relative group">
                                                            {formData.icon ? (
                                                                <>
                                                                    <img src={formData.icon} alt="icon" className="w-full h-full object-cover" />
                                                                    <div className="absolute inset-0 bg-black/50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                                                                        <button type="button" onClick={() => setFormData({ ...formData, icon: '' })} className="ui-danger-action rounded-full p-1">
                                                                            <X className="w-4 h-4" />
                                                                        </button>
                                                                    </div>
                                                                </>
                                                            ) : (
                                                                <ImageIcon className="w-8 h-8 ui-text-muted" />
                                                            )}
                                                        </div>
                                                    </div>
                                                <div className="flex-1 space-y-3">
                                                    <button
                                                        type="button"
                                                        onClick={() => setShowIconPicker(true)}
                                                        className="flex items-center justify-center gap-2 w-full px-4 py-2.5 border rounded-lg text-sm ui-soft-action hover:bg-[var(--ui-accent-soft)] transition-all"
                                                    >
                                                        <FolderOpen className="w-4 h-4" />
                                                        Pilih dari Galeri
                                                    </button>

                                                    <label className={`block w-full text-center px-4 py-2 border rounded-lg text-sm ui-muted-action cursor-pointer transition-colors ${uploadingIcon ? 'opacity-50 cursor-wait' : ''}`}>
                                                        {uploadingIcon ? <div className="flex items-center justify-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Uploading...</div> : 'Upload File Baru'}
                                                        <input type="file" accept="image/*" className="hidden" onChange={handleIconUpload} disabled={uploadingIcon} />
                                                    </label>

                                                </div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Classification Section */}
                                    <div className="ui-panel border ui-border rounded-xl p-5">
                                        <h4 className="flex items-center gap-2 text-sm font-semibold ui-text mb-4 pb-2 border-b ui-border">
                                            <LayoutGrid className="w-4 h-4 ui-accent-text" /> Klasifikasi
                                        </h4>
                                        <div className="space-y-4">
                                            <div className="grid grid-cols-2 gap-4">
                                                <div>
                                                    <label className="block text-xs font-medium ui-text-muted mb-1">Kategori</label>
                                                    <select
                                                        value={getId(formData.categoryId)}
                                                        onChange={(e) => handleCategoryChange(e.target.value)}
                                                        className="block w-full border rounded-lg py-2 px-3 ui-field text-sm"
                                                        required
                                                    >
                                                        <option value="">Pilih...</option>
                                                        {categories.map((cat) => (
                                                            <option key={cat._id} value={cat._id}>{cat.name}{cat.status === false ? ' (Nonaktif)' : ''}</option>
                                                        ))}
                                                    </select>
                                                </div>
                                                <div>
                                                    <label className="block text-xs font-medium ui-text-muted mb-1">Operator</label>
                                                    <select
                                                        value={getId(formData.operatorId)}
                                                        onChange={(e) => handleOperatorChange(e.target.value)}
                                                        className="block w-full border rounded-lg py-2 px-3 ui-field text-sm disabled:opacity-50"
                                                        required
                                                        disabled={!formData.categoryId}
                                                    >
                                                        <option value="">Pilih...</option>
                                                        {filteredOperators.map((op) => (
                                                            <option key={op._id} value={op._id}>{op.name}</option>
                                                        ))}
                                                    </select>
                                                </div>
                                            </div>
                                            <div className="grid grid-cols-2 gap-4">
                                                <div>
                                                    <label className="block text-xs font-medium ui-text-muted mb-1">Jenis Produk</label>
                                                    <select
                                                        value={getId(formData.productTypeId)}
                                                        onChange={(e) => handleProductTypeChange(e.target.value)}
                                                        className="block w-full border rounded-lg py-2 px-3 ui-field text-sm disabled:opacity-50"
                                                        disabled={!formData.operatorId}
                                                        required
                                                    >
                                                        <option value="">Pilih...</option>
                                                        {filteredProductTypes.map((pt) => (
                                                            <option key={pt._id} value={pt._id}>{pt.name}</option>
                                                        ))}
                                                    </select>
                                                </div>
                                                <div>
                                                    <label className="block text-xs font-medium ui-text-muted mb-1">Brand Label</label>
                                                    <input
                                                        type="text"
                                                        value={formData.brand}
                                                        readOnly
                                                        className="block w-full border rounded-lg py-2 px-3 ui-field text-sm opacity-80"
                                                        placeholder="Otomatis dari Operator"
                                                    />
                                                    <p className="mt-1 text-[10px] ui-text-muted">Brand mengikuti operator untuk menjaga konsistensi katalog.</p>
                                                </div>
                                            </div>
                                            <div>
                                                <label className="block text-xs font-medium ui-text-muted mb-1">Status Publik</label>
                                                <label className="flex items-center p-3 ui-panel-muted rounded-lg border ui-border cursor-pointer hover:border-[var(--ui-accent)] transition-colors">
                                                    <div className="relative inline-flex items-center cursor-pointer">
                                                        <input
                                                            type="checkbox"
                                                            className="sr-only peer"
                                                            checked={formData.status}
                                                            onChange={(e) => setFormData({ ...formData, status: e.target.checked })}
                                                        />
                                                        <div className="w-11 h-6 bg-[var(--ui-card-bg)] peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-[var(--ui-accent-soft)] rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-[var(--ui-border)] after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-[var(--ui-text)] after:border-[var(--ui-border)] after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-[var(--ui-accent)]"></div>
                                                    </div>
                                                    <span className="ml-3 text-sm font-medium ui-text">
                                                        {formData.status ? 'Produk Aktif (Muncul)' : 'Produk Non-Aktif (Sembunyi)'}
                                                    </span>
                                                </label>
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                {/* Right Column: Pricing & Settings */}
                                <div className="space-y-6">
                                    {/* Pricing Section */}
                                    <div className="ui-panel border ui-border rounded-xl p-5">
                                        <div className="flex items-center justify-between mb-4 pb-2 border-b ui-border">
                                            <h4 className="flex items-center gap-2 text-sm font-semibold ui-text">
                                                <DollarSign className="w-4 h-4 ui-accent-text" /> Konfigurasi Harga
                                            </h4>
                                            <button
                                                type="button"
                                                onClick={() => setShowMarginModal(true)}
                                                disabled={formData.costPrice <= 0}
                                                className="text-xs ui-accent-chip px-2 py-1 rounded hover:bg-[var(--ui-accent-soft)] disabled:opacity-50"
                                            >
                                                Setup Margin Otomatis
                                            </button>
                                        </div>

                                        {/* Margin Modal Overlay (Inline) */}
                                        {showMarginModal && (
                                            <div className="mb-4 p-4 ui-panel-muted border border-[color-mix(in_srgb,var(--ui-accent)_34%,transparent)] rounded-lg relative animate-in fade-in slide-in-from-top-2">
                                                <button onClick={() => setShowMarginModal(false)} className="absolute top-2 right-2 ui-text-muted hover:text-[var(--ui-text)]"><X className="w-4 h-4" /></button>
                                                <h5 className="text-sm font-medium ui-accent-text mb-3">Setup Margin (%)</h5>
                                                <div className="grid grid-cols-3 gap-2 mb-3">
                                                    {['basic', 'gold', 'platinum'].map((tier) => (
                                                        <div key={tier}>
                                                            <label className="text-[10px] uppercase ui-text-muted block mb-1">{tier}</label>
                                                            <input
                                                                type="number"
                                                                step="0.1"
                                                                value={margins[tier as keyof typeof margins]}
                                                                onChange={(e) => {
                                                                    const value = Number(e.target.value);
                                                                    if (!Number.isFinite(value)) return;
                                                                    setMargins({ ...margins, [tier]: Math.min(Math.max(value, 0), 500) });
                                                                }}
                                                                min={0}
                                                                max={500}
                                                                className="w-full border rounded px-2 py-1 text-sm ui-field"
                                                            />
                                                        </div>
                                                    ))}
                                                </div>
                                                <button type="button" onClick={applyMargins} className="w-full py-1.5 ui-accent-solid rounded text-xs font-medium">Terapkan Kalkulasi</button>
                                            </div>
                                        )}

                                        <div className="space-y-4">
                                            <div className="ui-panel-muted p-3 rounded-lg border ui-border">
                                                <label className="block text-xs font-medium ui-text-muted mb-1">Harga Modal (Dasar)</label>
                                                <div className="relative">
                                                    <span className="absolute left-3 top-1/2 -translate-y-1/2 ui-text-muted text-sm">Rp</span>
                                                    <input
                                                        type="number"
                                                        value={formData.costPrice}
                                                        onChange={(e) => setFormData({ ...formData, costPrice: sanitizeAmount(e.target.value) })}
                                                        min={0}
                                                        step={1}
                                                        className="block w-full pl-8 border rounded-lg py-2 px-3 ui-field font-mono text-sm"
                                                    />
                                                </div>
                                            </div>

                                            <div className="grid grid-cols-1 gap-3">
                                                {['basic', 'gold', 'platinum'].map((tier) => {
                                                    const price = formData.price[tier as keyof typeof formData.price];
                                                    const profit = price - formData.costPrice;
                                                    const percent = formData.costPrice > 0 ? (profit / formData.costPrice * 100).toFixed(1) : '0';
                                                    return (
                                                        <div key={tier} className="relative">
                                                            <label className="block text-xs font-medium ui-text-muted mb-1 capitalize">Harga {tier}</label>
                                                            <div className="relative">
                                                                <span className="absolute left-3 top-1/2 -translate-y-1/2 ui-text-muted text-sm">Rp</span>
                                                                <input
                                                                    type="number"
                                                                    value={price}
                                                                    onChange={(e) => setFormData({ ...formData, price: { ...formData.price, [tier]: sanitizeAmount(e.target.value) } })}
                                                                    min={0}
                                                                    step={1}
                                                                    className="block w-full pl-8 pr-24 border rounded-lg py-2 px-3 ui-field font-mono text-sm"
                                                                />
                                                                <div className={`absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium ${profit >= 0 ? 'ui-success-text' : 'ui-danger-text'}`}>
                                                                    +{profit.toLocaleString('id-ID')} ({percent}%)
                                                                </div>
                                                            </div>
                                                        </div>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    </div>

                                    {/* More Settings */}
                                    <div className="ui-panel border ui-border rounded-xl p-5">
                                        <h4 className="flex items-center gap-2 text-sm font-semibold ui-text mb-4 pb-2 border-b ui-border">
                                            <Globe className="w-4 h-4 ui-accent-text" /> Lainnya
                                        </h4>
                                        <div className="grid grid-cols-2 gap-4">
                                            <div>
                                                <label className="block text-xs font-medium ui-text-muted mb-2">Sistem Pembayaran</label>
                                                <div className="flex flex-col gap-2">
                                                    <label className="inline-flex items-center">
                                                        <input
                                                            type="radio"
                                                            name="paymentType"
                                                            value="prabayar"
                                                            checked={formData.paymentType === 'prabayar'}
                                                            onChange={() => setFormData({ ...formData, paymentType: 'prabayar' })}
                                                            className="text-[var(--ui-accent)] focus:ring-[var(--ui-accent)] bg-[var(--ui-card-bg)] border-[var(--ui-border)]"
                                                        />
                                                        <span className="ml-2 text-sm ui-text">Prabayar</span>
                                                    </label>
                                                    <label className="inline-flex items-center">
                                                        <input
                                                            type="radio"
                                                            name="paymentType"
                                                            value="pascabayar"
                                                            checked={formData.paymentType === 'pascabayar'}
                                                            onChange={() => setFormData({ ...formData, paymentType: 'pascabayar' })}
                                                            className="text-[var(--ui-accent)] focus:ring-[var(--ui-accent)] bg-[var(--ui-card-bg)] border-[var(--ui-border)]"
                                                        />
                                                        <span className="ml-2 text-sm ui-text">Pascabayar</span>
                                                    </label>
                                                </div>
                                            </div>
                                            <div>
                                                <label className="block text-xs font-medium ui-text-muted mb-1">Reward Poin</label>
                                                <input
                                                    type="number"
                                                    value={formData.rewardPoints}
                                                    onChange={(e) => setFormData({ ...formData, rewardPoints: sanitizeAmount(e.target.value) })}
                                                    min={0}
                                                    step={1}
                                                    className="block w-full border rounded-lg py-2 px-3 ui-field text-sm"
                                                    placeholder="0"
                                                />
                                                <p className="text-[10px] ui-text-muted mt-1">Poin per transaksi sukses</p>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Footer / Actions */}
                        <div className="ui-card-gradient px-6 py-4 border-t ui-border space-y-3 z-10">
                            {submitError && (
                                <div className="rounded-lg border px-4 py-3 text-sm ui-danger-chip" role="alert">
                                    {submitError}
                                </div>
                            )}
                            <div className="flex items-center justify-end gap-3">
                            <button
                                type="button"
                                onClick={onClose}
                                className="px-5 py-2.5 rounded-lg border font-medium ui-muted-action transition-all text-sm"
                            >
                                Batal
                            </button>
                            <button
                                type="submit"
                                disabled={loading || (!initialData && !formData.operatorId)}
                                className="px-6 py-2.5 rounded-lg ui-accent-solid font-medium shadow-lg transition-all text-sm flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {loading && <Loader2 className="w-4 h-4 animate-spin" />}
                                {initialData ? 'Simpan Perubahan' : 'Buat Produk Baru'}
                            </button>
                            </div>
                        </div>
                    </form>
                </div>
            </div>
            <ImagePicker
                isOpen={showIconPicker}
                onClose={() => setShowIconPicker(false)}
                onSelect={(url) => setFormData({ ...formData, icon: url })}
                currentValue={formData.icon}
                type="icons"
                title="Pilih Icon Produk"
            />
        </div>
    );
}
