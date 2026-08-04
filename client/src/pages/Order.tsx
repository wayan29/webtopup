import { useEffect, useState, useCallback, useRef } from 'react';
import { useSearchParams, useNavigate, useParams } from 'react-router-dom';
import { 
    ArrowLeft, 
    Zap, 
    Send, 
    Loader2, 
    Check,
    Sparkles,
    ChevronDown,
    ChevronUp,
    Wallet,
    AlertCircle,
    Copy,
    CheckCircle,
    X,
    AlertTriangle,
    User
} from 'lucide-react';
import {
    apiV2,
    attachIdempotencyKey,
    createIdempotencyKey,
    CRITICAL_MUTATION_AMBIGUOUS_MESSAGE,
    isAmbiguousMutationFailure,
    isIdempotencyConflictFailure,
    isIdempotencyInProgressFailure,
} from '../api';
import {
    guestCheckoutSubmissionTransition,
    type GuestCheckoutSubmissionState,
} from '../api/guestCheckoutSubmission';
import { useAuthStore } from '../store/useAuthStore';
import OperatorIcon from '../components/OperatorIcon';

interface ServerOption {
    label: string;
    value: string;
}

interface Operator {
    _id: string;
    name: string;
    slug: string;
    icon?: string;
    checkUsername: boolean;
    usernameLabel?: string;
    validationType?: 'none' | 'freefire' | 'mobilelegends' | 'operator';
    userIdLabel?: string;
    userIdType?: 'number' | 'text' | 'email';
    hasServerId?: boolean;
    serverIdLabel?: string;
    serverIdDropdown?: boolean;
    serverIdType?: 'number' | 'text' | 'email';
    serverOptions?: ServerOption[];
    instructionImage?: string;
    description?: string;
}

interface ValidationResult {
    success: boolean;
    data?: {
        userId?: string;
        zoneId?: string;
        nickname?: string;
        // For operator validation
        phoneNumber?: string;
        operator?: string;
        prefix?: string;
        color?: string;
    };
    message?: string;
}

interface ProductType {
    _id: string;
    name: string;
    slug: string;
    icon?: string;
    cover?: string;
    description?: string;
    processType?: 'auto' | 'manual';
    estimatedDelivery?: string;
    popupInfo?: {
        title: string;
        content: string;
        image: string;
        buttonText: string;
        buttonLink: string;
        enabled: boolean;
    };
}

interface Product {
    _id: string;
    code: string;
    name: string;
    productTypeId?: string | { _id: string; name?: string } | null;
    price: {
        basic: number;
        gold: number;
        platinum: number;
    };
    status: boolean;
    canPurchase?: boolean;
    icon?: string;
    rewardPoints?: number;
    validation?: {
        enabled: boolean;
        type: 'nickname' | 'operator';
        game?: 'freefire' | 'mobilelegends' | '';
        targetLabel?: string;
        secondaryTargetLabel?: string;
        resultLabel?: string;
    };
}

const getEntityId = (value: unknown): string => {
    if (!value) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'object' && value && '_id' in value) {
        return String((value as { _id?: unknown })._id || '');
    }
    return '';
};

interface FlashSaleInfo {
    hasFlashSale: boolean;
    flashSaleId?: string;
    flashSaleName?: string;
    originalPrice?: number;
    flashPrice?: number;
    discountType?: 'percentage' | 'fixed';
    discountValue?: number;
    stock?: number;
    soldCount?: number;
    remainingStock?: number;
    endDate?: string;
}

interface PaymentCategory {
    _id: string;
    name: string;
    slug?: string;
}

interface PaymentMethod {
    _id: string;
    name: string;
    type: string;
    category?: PaymentCategory | string;
    accountNumber?: string;
    accountName?: string;
    adminFee?: number;
    adminPercent?: number;
    icon?: string;
    useUniqueCode?: boolean;
    minAmount?: number;
    maxAmount?: number;
    status: 'active' | 'inactive' | boolean;
}

const getCategoryName = (category?: PaymentCategory | string): string => {
    if (!category) return 'other';
    if (typeof category === 'string') return category;
    return category.name;
};

const getCategorySlug = (category?: PaymentCategory | string): string => {
    if (!category) return '';
    if (typeof category === 'string') return category.toLowerCase().replace(/\s+/g, '-');
    return category.slug || category.name.toLowerCase().replace(/\s+/g, '-');
};

const isBankTransferCategory = (category?: PaymentCategory | string): boolean => {
    const name = getCategoryName(category).toLowerCase();
    const slug = getCategorySlug(category).toLowerCase();
    return name.includes('bank') || name.includes('transfer') || 
           slug.includes('bank') || slug.includes('transfer');
};

const getRewardPoints = (value: unknown): number => {
    const points = typeof value === 'number' ? value : Number(value || 0);
    return Number.isFinite(points) && points > 0 ? points : 0;
};

interface PaymentInfo {
    bankName: string;
    accountNumber: string;
    accountName: string;
    amount: number;
    adminFee: number;
    uniqueCode: number;
    totalAmount: number;
    expiredAt: string;
    invoiceNumber: string;
}

export default function Order() {
    const [searchParams] = useSearchParams();
    const params = useParams<{ operator?: string; type?: string }>();
    const navigate = useNavigate();
    const { user, isAuthenticated } = useAuthStore();
    
    const operatorId = params.operator || searchParams.get('operator');
    const typeId = params.type || searchParams.get('type');
    const preselectedProductCode = searchParams.get('pvc');

    const [operator, setOperator] = useState<Operator | null>(null);
    const [productType, setProductType] = useState<ProductType | null>(null);
    const [products, setProducts] = useState<Product[]>([]);
    const [paymentMethods, setPaymentMethods] = useState<PaymentMethod[]>([]);
    
    const [loading, setLoading] = useState(true);
    const [submitting, setSubmitting] = useState(false);
    const [fetchError, setFetchError] = useState<string | null>(null);
    const [guestCheckoutState, setGuestCheckoutState] = useState<GuestCheckoutSubmissionState>({
        key: null,
        fingerprint: null,
        reconciliationVisible: false,
    });
    const guestCheckoutStateRef = useRef(guestCheckoutState);
    guestCheckoutStateRef.current = guestCheckoutState;
    
    // Form state
    const [target, setTarget] = useState('');
    const [serverId, setServerId] = useState('');
    const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
    const [selectedFlashSale, setSelectedFlashSale] = useState(false);
    const [selectedPayment, setSelectedPayment] = useState<PaymentMethod | null>(null);
    const [voucher, setVoucher] = useState('');
    const [whatsapp, setWhatsapp] = useState('');
    const [showFullDescription, setShowFullDescription] = useState(false);
    const [flashSaleMap, setFlashSaleMap] = useState<Record<string, FlashSaleInfo>>({});
    
    // Validation state
    const [validating, setValidating] = useState(false);
    const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
    const [validationChecked, setValidationChecked] = useState(false);
    
    // UI state
    const [expandedPayment, setExpandedPayment] = useState<string | null>(isAuthenticated ? 'saldo' : 'Bank Transfer');
    const [showPaymentModal, setShowPaymentModal] = useState(false);
    const [paymentInfo, setPaymentInfo] = useState<PaymentInfo | null>(null);
    const [copied, setCopied] = useState<string | null>(null);
    const [showPopup, setShowPopup] = useState(false);
    const [showInstructionModal, setShowInstructionModal] = useState(false);

    useEffect(() => {
        const fetchData = async () => {
            if (!operatorId) {
                navigate('/');
                return;
            }

            try {
                setFetchError(null);
                const opRes = await apiV2
                    .get(`/operators/${operatorId}`);
                setOperator(opRes.data);

                let resolvedProductType: ProductType | null = null;

                if (typeId) {
                    try {
                        const typeRes = await apiV2
                            .get(`/product-types/${typeId}`);
                        resolvedProductType = typeRes.data;
                        setProductType(typeRes.data);

                        if (typeRes.data.popupInfo?.enabled) {
                            setShowPopup(true);
                        } else {
                            setShowPopup(false);
                        }
                    } catch (typeError: any) {
                        setShowPopup(false);

                        if (typeError?.response?.status === 404) {
                            setProductType(null);
                            setFetchError('Jenis produk tidak ditemukan. Menampilkan semua produk operator yang tersedia.');
                        } else {
                            throw typeError;
                        }
                    }
                } else {
                    setProductType(null);
                    setShowPopup(false);
                }

                // Fetch products - try productTypeId first, then operator, then legacy brand
                const operatorName = opRes.data.name;
                const operatorObjectId = opRes.data._id;
                const productTypeIdParam = resolvedProductType?._id;
                
                const fetchProductsByQuery = async (params: Record<string, string | undefined>) => {
                    const queryParams = new URLSearchParams();
                    queryParams.set('status', 'all');
                    Object.entries(params).forEach(([key, value]) => {
                        if (value) queryParams.set(key, value);
                    });
                    const path = `/products?${queryParams.toString()}`;
                    const response = await apiV2.get(path);
                    return Array.isArray(response.data) ? response.data as Product[] : [];
                };

                let productsData = productTypeIdParam
                    ? await fetchProductsByQuery({
                        productTypeId: productTypeIdParam
                    })
                    : [];

                if ((!productTypeIdParam || productsData.length === 0) && operatorObjectId) {
                    const operatorProducts = await fetchProductsByQuery({
                        operatorId: operatorObjectId
                    });

                    productsData = productTypeIdParam
                        ? operatorProducts.filter((product) => {
                            const productTypeId = getEntityId((product as any).productTypeId);
                            return !productTypeId || productTypeId === productTypeIdParam;
                        })
                        : operatorProducts;
                }

                if (productsData.length === 0) {
                    productsData = await fetchProductsByQuery({
                        brand: operatorName
                    });
                }
                
                setProducts(productsData);

                try {
                    const payRes = await apiV2.get('/payment-methods');
                    const paymentData = Array.isArray(payRes.data) ? payRes.data : [];
                    setPaymentMethods(paymentData.filter((method) => isBankTransferCategory(method.category)));
                } catch (paymentError) {
                    console.error('Failed to fetch payment methods', paymentError);
                    setPaymentMethods([]);
                    setFetchError((prev) => prev || 'Metode pembayaran belum bisa dimuat. Coba refresh halaman.');
                }

                // Fetch flash sale info for all products
                const flashSalePromises = productsData.map(async (product: Product) => {
                    try {
                        const fsRes = await apiV2.get(`/flash-sales/price/${product._id}`)
                        return { productId: product._id, data: fsRes.data };
                    } catch {
                        return { productId: product._id, data: { hasFlashSale: false } };
                    }
                });
                const flashSaleResults = await Promise.all(flashSalePromises);
                const fsMap: Record<string, FlashSaleInfo> = {};
                flashSaleResults.forEach(({ productId, data }) => {
                    fsMap[productId] = data;
                });
                setFlashSaleMap(fsMap);
            } catch (error: any) {
                console.error('Failed to fetch data', error);
                setFetchError(error?.response?.data?.message || 'Data order belum bisa dimuat. Coba refresh halaman.');
            } finally {
                setLoading(false);
            }
        };

        fetchData();
    }, [operatorId, typeId, navigate]);

    // Auto-select product from URL parameter (pvc)
    useEffect(() => {
        if (preselectedProductCode && products.length > 0 && !selectedProduct) {
            const product = products.find(p => p.code === preselectedProductCode);
            if (product && product.status && product.canPurchase !== false) {
                const flashSale = flashSaleMap[product._id];
                const hasActiveFlashSale = flashSale?.hasFlashSale && (flashSale.remainingStock || 0) > 0;
                setSelectedProduct(product);
                setSelectedFlashSale(!!hasActiveFlashSale);
                setTimeout(() => {
                    document.getElementById('payment-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }, 300);
            }
        }
    }, [preselectedProductCode, products, selectedProduct, flashSaleMap]);

    const getUserPrice = (product: Product, useFlashSale = selectedFlashSale) => {
        const flashSale = flashSaleMap[product._id];
        if (useFlashSale && flashSale?.hasFlashSale && flashSale.flashPrice !== undefined && (flashSale.remainingStock || 0) > 0) {
            return flashSale.flashPrice;
        }
        
        if (!user) return product.price.basic;
        const level = user.level || 'basic';
        return product.price[level as keyof typeof product.price] || product.price.basic;
    };

    const getOriginalPrice = (product: Product) => {
        if (!user) return product.price.basic;
        const level = user.level || 'basic';
        return product.price[level as keyof typeof product.price] || product.price.basic;
    };

    const formatPrice = (price: number) => {
        return new Intl.NumberFormat('id-ID').format(price);
    };

    const basePrice = selectedProduct ? getUserPrice(selectedProduct, selectedFlashSale) : 0;
    const estimatedAdminFee = selectedPayment && selectedPayment._id !== 'saldo'
        ? (selectedPayment.adminFee || 0) + Math.ceil(basePrice * ((selectedPayment.adminPercent || 0) / 100))
        : 0;
    const estimatedTransferTotal = basePrice + estimatedAdminFee;
    const displayPrice = paymentInfo?.amount ?? basePrice;
    const originalPrice = selectedProduct ? getOriginalPrice(selectedProduct) : displayPrice;
    const savings = selectedFlashSale ? Math.max(0, originalPrice - displayPrice) : 0;
    const rewardPoints = getRewardPoints(selectedProduct?.rewardPoints);
    const selectedValidation = selectedProduct?.validation?.enabled ? selectedProduct.validation : null;
    const targetLabel = selectedValidation?.targetLabel || operator?.userIdLabel || 'Nomor Tujuan';
    const secondaryTargetLabel = selectedValidation?.secondaryTargetLabel || (selectedValidation?.game === 'mobilelegends' ? 'Zone ID' : operator?.serverIdLabel) || 'Server ID';
    const requiresSecondaryTarget = Boolean(selectedValidation?.secondaryTargetLabel) || selectedValidation?.game === 'mobilelegends' || Boolean(operator?.hasServerId);

    const handleCopy = (text: string, field: string) => {
        navigator.clipboard.writeText(text);
        setCopied(field);
        setTimeout(() => setCopied(null), 2000);
    };

    // Validation function
    const handleValidation = useCallback(async () => {
        if (!operator || operator.validationType === 'none' || !target.trim()) {
            return;
        }

        // For ML, also need serverId
        if (operator.validationType === 'mobilelegends' && !serverId.trim()) {
            return;
        }

        setValidating(true);
        setValidationResult(null);

        try {
            let endpoint = '';
            let payload: Record<string, string> = {};

            switch (operator.validationType) {
                case 'freefire':
                    endpoint = '/validate/freefire';
                    payload = { userId: target.trim() };
                    break;
                case 'mobilelegends':
                    endpoint = '/validate/mobilelegends';
                    payload = { userId: target.trim(), zoneId: serverId.trim() };
                    break;
                case 'operator':
                    endpoint = '/validate/operator';
                    payload = { phoneNumber: target.trim() };
                    break;
                default:
                    setValidationChecked(true);
                    setValidating(false);
                    return;
            }

            const res = await apiV2.post(endpoint, payload);
            setValidationResult(res.data);
            setValidationChecked(true);
        } catch (error: any) {
            setValidationResult({
                success: false,
                message: error.response?.data?.message || 'Validasi gagal'
            });
            setValidationChecked(true);
        } finally {
            setValidating(false);
        }
    }, [operator, target, serverId]);

    // Reset validation when target or serverId changes
    const transitionGuestCheckoutSubmission = useCallback((event: Parameters<typeof guestCheckoutSubmissionTransition>[1]) => {
        const next = guestCheckoutSubmissionTransition(guestCheckoutStateRef.current, event);
        guestCheckoutStateRef.current = next;
        setGuestCheckoutState(next);
    }, []);

    const clearGuestCheckoutSubmission = useCallback(() => {
        transitionGuestCheckoutSubmission({ type: 'form-changed' });
    }, [transitionGuestCheckoutSubmission]);

    const handleTargetChange = (value: string) => {
        clearGuestCheckoutSubmission();
        setTarget(value);
        setValidationResult(null);
        setValidationChecked(false);
    };

    const handleServerIdChange = (value: string) => {
        clearGuestCheckoutSubmission();
        setServerId(value);
        setValidationResult(null);
        setValidationChecked(false);
    };

    // Check if validation is required and ready
    const needsValidation = operator?.validationType && operator.validationType !== 'none';
    const getMinLength = () => {
        if (operator?.validationType === 'operator') return 10; // Phone number min 10 digits
        return 5; // User ID min 5 chars
    };
    const canValidate = needsValidation && target.trim().length >= getMinLength() &&
        (operator?.validationType !== 'mobilelegends' || serverId.trim().length >= 1);
    const handleSubmit = async () => {
        const normalizedTarget = target.trim();
        const normalizedServerId = serverId.trim();
        const normalizedWhatsapp = whatsapp.trim();

        if (!selectedProduct || !normalizedTarget) {
            alert('Mohon lengkapi data');
            return;
        }

        if (requiresSecondaryTarget && !normalizedServerId) {
            alert(`Mohon isi ${secondaryTargetLabel}`);
            return;
        }

        if (selectedProduct.status === false) {
            alert('Produk sedang gangguan, pilih produk lain');
            return;
        }

        if (!selectedPayment) {
            alert('Mohon pilih metode pembayaran');
            return;
        }

        setSubmitting(true);
        try {
            if (selectedPayment._id !== 'saldo') {
                if (!normalizedWhatsapp) {
                    alert('Mohon masukkan nomor WhatsApp');
                    setSubmitting(false);
                    return;
                }

                const payload = {
                    productCode: selectedProduct.code,
                    target: normalizedTarget,
                    serverId: normalizedServerId || undefined,
                    whatsapp: normalizedWhatsapp,
                    paymentMethodId: selectedPayment._id,
                    useFlashSale: selectedFlashSale
                };
                const fingerprint = JSON.stringify([
                    selectedProduct.code,
                    normalizedTarget,
                    normalizedServerId,
                    normalizedWhatsapp,
                    '',
                    selectedPayment._id,
                    selectedFlashSale,
                    user?.id ?? '',
                ]);
                const current = guestCheckoutStateRef.current;
                const submissionKey = current.fingerprint === fingerprint && current.key
                    ? current.key
                    : createIdempotencyKey();
                transitionGuestCheckoutSubmission({ type: 'start', key: submissionKey, fingerprint });
                const res = await apiV2.post(
                    '/guest-transactions',
                    payload,
                    attachIdempotencyKey({} as never, submissionKey) as never,
                );

                setPaymentInfo({
                    ...res.data.paymentInfo,
                    invoiceNumber: res.data.transaction.invoiceNumber
                });
                transitionGuestCheckoutSubmission({ type: 'success' });
                setShowPaymentModal(true);
            } else {
                if (!isAuthenticated) {
                    alert('Silakan login terlebih dahulu untuk membayar dengan saldo');
                    navigate('/login');
                    return;
                }

                const payload = {
                    productCode: selectedProduct.code,
                    target: normalizedTarget,
                    serverId: normalizedServerId || undefined,
                    useFlashSale: selectedFlashSale
                };
                await apiV2.post('/transactions', payload);
                alert('Transaksi berhasil dibuat!');
                navigate('/transactions');
            }
        } catch (error: any) {
            if (selectedPayment?._id !== 'saldo' && isIdempotencyInProgressFailure(error)) {
                transitionGuestCheckoutSubmission({ type: 'in-progress' });
                alert(`${CRITICAL_MUTATION_AMBIGUOUS_MESSAGE}. Permintaan masih direkonsiliasi; coba lagi dengan kunci yang sama.`);
            } else if (selectedPayment?._id !== 'saldo' && isAmbiguousMutationFailure(error)) {
                transitionGuestCheckoutSubmission({ type: 'ambiguous' });
                alert(`${CRITICAL_MUTATION_AMBIGUOUS_MESSAGE}. Gunakan tombol coba lagi untuk merekonsiliasi dengan kunci pengiriman yang sama.`);
            } else {
                transitionGuestCheckoutSubmission({
                    type: isIdempotencyConflictFailure(error) ? 'conflict' : 'definite-failure',
                });
                alert(error.response?.data?.message || 'Gagal membuat transaksi');
            }
        } finally {
            setSubmitting(false);
        }
    };

    // Group payment methods by category
    const groupedPayments = paymentMethods.reduce((acc, method) => {
        const category = getCategoryName(method.category) || method.type || 'other';
        if (!acc[category]) acc[category] = [];
        acc[category].push(method);
        return acc;
    }, {} as Record<string, PaymentMethod[]>);

    const shellClass = 'min-h-screen ui-shell ui-text-muted';
    const panelClass = 'overflow-hidden rounded-[30px] border ui-border ui-panel shadow-xl';
    const panelHeaderClass = 'flex items-center gap-3 border-b ui-border bg-[var(--ui-card-muted)] px-5 py-4';
    const stepBadgeClass = 'flex h-7 w-7 items-center justify-center rounded-full ui-accent-solid text-xs font-bold ui-text shadow-lg shadow-orange-500/20';
    const labelClass = 'mb-2 block text-sm font-medium ui-text-muted';
    const helperTextClass = 'text-xs ui-text-muted';
    const inputClass = 'w-full rounded-[20px] border ui-border ui-shell px-4 py-3 ui-text placeholder-[var(--ui-text-muted)] outline-none transition focus:border-orange-500 focus:ring-4 focus:ring-orange-500/20';



    if (loading) {
        return (
            <div className={`${shellClass} flex items-center justify-center`}>
                <div className="rounded-[28px] border ui-border ui-panel p-6 shadow-2xl">
                    <Loader2 className="h-8 w-8 animate-spin text-orange-500" />
                </div>
            </div>
        );
    }

    return (
        <div className={shellClass}>
            {/* Header */}
            <div className="sticky top-0 z-10 border-b ui-border bg-[var(--ui-body-bg)]/80 backdrop-blur-xl">
                <div className="mx-auto flex max-w-5xl items-center gap-4 px-4 py-4">
                    <button 
                        onClick={() => navigate(-1)}
                        className="flex h-11 w-11 items-center justify-center rounded-2xl border ui-border ui-panel ui-text-muted transition hover:bg-[var(--ui-card-muted)] hover:text-[var(--ui-text)]"
                    >
                        <ArrowLeft className="h-5 w-5" />
                    </button>
                    <div className="flex items-center gap-3">
                        <div className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-[18px] border ui-border ui-panel-muted text-xl">
                            <OperatorIcon icon={productType?.icon || operator?.icon} fallback="📱" size="lg" />
                        </div>
                        <div>
                            <p className="text-[11px] font-semibold uppercase tracking-[0.3em] ui-text-muted">Order</p>
                            <h1 className="font-semibold ui-text">{productType?.name || 'Produk'}</h1>
                            <p className="text-xs ui-text-muted">{operator?.name}</p>
                        </div>
                    </div>
                </div>
            </div>

            <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 pb-36">
                {/* Cover Image */}
                {productType?.cover && (
                    <div className="overflow-hidden rounded-[30px] border ui-border ui-panel p-3 shadow-xl">
                        <img 
                            src={productType.cover} 
                            alt={productType.name} 
                            className="h-auto w-full rounded-[24px] object-cover"
                        />
                    </div>
                )}

                {/* Product Info Header */}
                <div className="rounded-[30px] border ui-border ui-panel p-5 shadow-xl">
                    <div className="flex items-start gap-4">
                    {/* Icon */}
                    <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-[20px] border ui-border ui-panel-muted">
                        <OperatorIcon icon={productType?.icon || operator?.icon} fallback="📱" size="xl" />
                    </div>
                    <div className="flex-1">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.34em] ui-text-muted">Checkout Flow</p>
                        <h2 className="mt-2 text-2xl font-bold ui-text">{productType?.name || operator?.name}</h2>
                        {/* Badge */}
                        <div className="flex flex-wrap gap-2 mt-2">
                            <span className="flex items-center gap-1 rounded-full border border-orange-500/30 bg-orange-500/10 px-3 py-1 text-xs font-medium ui-accent-text">
                                <Zap className="h-3 w-3" /> Proses Instan
                            </span>
                            <span className="flex items-center gap-1 rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1 text-xs font-medium text-blue-400">
                                <Send className="h-3 w-3" /> {productType?.processType === 'manual' ? 'Dikirim Manual' : 'Dikirim Otomatis'}
                            </span>
                        </div>
                    </div>
                </div>
                </div>

                {/* Deskripsi dari ProductType */}
                {(productType?.description || operator?.description) && (
                    <div className="space-y-2 rounded-[28px] border ui-border ui-panel p-5 text-sm ui-text-muted shadow-xl">
                        <div
                            className={`relative ${!showFullDescription && (productType?.description || operator?.description || '').length > 220 ? 'max-h-32 overflow-hidden' : ''}`}
                        >
                            {productType?.description ? (
                                <div 
                                    className="prose prose-sm prose-invert max-w-none leading-relaxed prose-headings:text-[var(--ui-text)] prose-p:text-[var(--ui-text-muted)] prose-strong:text-[var(--ui-text)] prose-li:text-[var(--ui-text-muted)]"
                                    dangerouslySetInnerHTML={{ __html: productType.description.replace(/\n/g, '<br/>') }}
                                />
                            ) : (
                                <p className="whitespace-pre-line leading-relaxed">{operator?.description}</p>
                            )}
                            {!showFullDescription && (productType?.description || operator?.description || '').length > 220 && (
                                <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-[#1a1a2e] to-transparent" />
                            )}
                        </div>
                        {(productType?.description || operator?.description || '').length > 220 && (
                            <button
                                type="button"
                                onClick={() => setShowFullDescription(!showFullDescription)}
                                className="text-xs font-medium ui-accent-text hover:text-[var(--ui-accent-strong)]"
                            >
                                {showFullDescription ? 'Tampilkan lebih sedikit' : 'Tampilkan lebih banyak'}
                            </button>
                        )}
                    </div>
                )}

                {fetchError && (
                    <div className="rounded-[24px] border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-500">
                        {fetchError}
                    </div>
                )}

                {/* Step 1: Data Akun */}
                <div className={panelClass}>
                    <div className={panelHeaderClass}>
                        <span className={stepBadgeClass}>1</span>
                        <span className="font-semibold ui-text">Data Akun</span>
                    </div>
                    <div className="p-4 space-y-4">
                        {/* User ID Input */}
                        <div>
                            <label className={labelClass}>{targetLabel}</label>
                            <div className="relative">
                                <User className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 ui-text-muted" />
                                <input
                                    type={operator?.userIdType === 'email' ? 'email' : operator?.userIdType === 'text' ? 'text' : 'tel'}
                                    inputMode={operator?.userIdType === 'number' ? 'numeric' : operator?.userIdType === 'email' ? 'email' : 'text'}
                                    value={target}
                                    onChange={(e) => handleTargetChange(e.target.value)}
                                    placeholder={`Masukkan ${targetLabel}`}
                                    className={`${inputClass} pl-10`}
                                />
                            </div>
                        </div>

                        {/* Server ID Input (for games that need it) */}
                        {requiresSecondaryTarget && (
                            <div>
                                <label className={labelClass}>{secondaryTargetLabel}</label>
                                {operator?.serverIdDropdown && operator?.serverOptions && operator.serverOptions.length > 0 ? (
                                    <select
                                        value={serverId}
                                        onChange={(e) => handleServerIdChange(e.target.value)}
                                        className={inputClass}
                                    >
                                        <option value="">Pilih {secondaryTargetLabel}</option>
                                        {operator.serverOptions.map((opt, idx) => (
                                            <option key={idx} value={opt.value}>{opt.label}</option>
                                        ))}
                                    </select>
                                ) : (
                                    <input
                                        type={operator?.serverIdType === 'email' ? 'email' : operator?.serverIdType === 'text' ? 'text' : 'tel'}
                                        inputMode={operator?.serverIdType === 'number' ? 'numeric' : operator?.serverIdType === 'email' ? 'email' : 'text'}
                                        value={serverId}
                                        onChange={(e) => handleServerIdChange(e.target.value)}
                                        placeholder={`Masukkan ${secondaryTargetLabel}`}
                                        className={inputClass}
                                    />
                                )}
                            </div>
                        )}

                        {/* Validation Button & Result */}
                        {needsValidation && (
                            <div className="space-y-3">
                                <button
                                    type="button"
                                    onClick={handleValidation}
                                    disabled={validating || !canValidate}
                                    className="flex w-full items-center justify-center gap-2 rounded-[20px] bg-gradient-to-r from-blue-600 to-indigo-600 px-4 py-3 font-medium ui-text disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    {validating ? (
                                        <>
                                            <Loader2 className="w-5 h-5 animate-spin" />
                                            Memvalidasi...
                                        </>
                                    ) : (
                                        <>
                                            <CheckCircle className="w-5 h-5" />
                                            Cek Akun
                                        </>
                                    )}
                                </button>

                                {/* Validation Result */}
                                {validationResult && (
                                    <div className={`p-4 rounded-xl border ${
                                        validationResult.success 
                                            ? 'border-emerald-500/30 bg-emerald-500/10' 
                                            : 'border-amber-500/30 bg-amber-500/10'
                                    }`}>
                                        <div className="flex items-start gap-3">
                                            {validationResult.success ? (
                                                <CheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
                                            ) : (
                                                <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
                                            )}
                                            <div className="flex-1">
                                                <p className={`font-semibold ${validationResult.success ? 'text-emerald-400' : 'text-amber-500'}`}>
                                                    {validationResult.success 
                                                        ? (operator?.validationType === 'operator' ? 'Operator Terdeteksi' : 'Akun Ditemukan') 
                                                        : 'Validasi Gagal'}
                                                </p>
                                                {validationResult.success && validationResult.data ? (
                                                    operator?.validationType === 'operator' ? (
                                                        <div className="mt-1 space-y-1 ui-text">
                                                            <p>Operator: <span className="font-bold">{validationResult.data.operator}</span></p>
                                                            <p className="text-sm ui-text-muted">Prefix: {validationResult.data.prefix}</p>
                                                        </div>
                                                    ) : (
                                                        <p className="mt-1 ui-text">
                                                            Nickname: <span className="font-bold">{validationResult.data.nickname}</span>
                                                        </p>
                                                    )
                                                ) : (
                                                    <div className="mt-1">
                                                        <p className="text-sm ui-text-muted">{validationResult.message}</p>
                                                        <p className="mt-2 text-xs text-amber-500/80">
                                                            Anda tetap dapat melanjutkan pembelian, namun pastikan data sudah benar
                                                        </p>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                )}

                                {/* Warning if not validated but can proceed */}
                                {!validationChecked && canValidate && (
                                    <p className={helperTextClass}>
                                        Klik "Cek Akun" untuk memvalidasi ID sebelum melanjutkan
                                    </p>
                                )}
                            </div>
                        )}

                        {!needsValidation && (
                            <p className={helperTextClass}>
                                Silahkan masukan {targetLabel.toLowerCase()} kamu
                            </p>
                        )}

                        {/* Tombol Petunjuk */}
                        {operator?.instructionImage && (
                            <button
                                type="button"
                                onClick={() => setShowInstructionModal(true)}
                                className="mt-4 rounded-xl border ui-border ui-panel-muted px-4 py-2 text-sm font-medium ui-text-muted transition hover:bg-[var(--ui-card-muted)] hover:text-[var(--ui-text)]"
                            >
                                Petunjuk
                            </button>
                        )}
                    </div>
                </div>

                {/* Step 2: Pilih Produk */}
                <div className={panelClass}>
                    <div className={panelHeaderClass}>
                        <span className={stepBadgeClass}>2</span>
                        <span className="font-semibold ui-text">Pilih Produk</span>
                    </div>
                    <div className="p-4 space-y-6">
                        {products.length === 0 ? (
                            <div className="py-8 text-center ui-text-muted">
                                <AlertCircle className="mx-auto mb-3 h-12 w-12 ui-text-muted" />
                                <p>Belum ada produk tersedia</p>
                            </div>
                        ) : (
                            <>
                                {(() => {
                                    const flashSaleProducts = products.filter(p => {
                                        const fs = flashSaleMap[p._id];
                                        return fs?.hasFlashSale;
                                    });

                                    if (flashSaleProducts.length === 0) return null;

                                    return (
                                        <div className="space-y-3">
                                            <div className="flex items-center gap-2">
                                                <Zap className="h-5 w-5 text-orange-500" />
                                                <h4 className="font-bold ui-text">Flash Sale</h4>
                                                <span className="text-xs ui-text-muted">Harga spesial, stok terbatas!</span>
                                            </div>
                                            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                                                {flashSaleProducts.map((product) => {
                                                    const flashSale = flashSaleMap[product._id];
                                                    const flashPrice = flashSale?.flashPrice || product.price.basic;
                                                    const originalPrice = getOriginalPrice(product);
                                                    const isSelected = selectedProduct?._id === product._id && selectedFlashSale;
                                                    const isDown = product.status === false || product.canPurchase === false;
                                                    const isSoldOut = (flashSale?.remainingStock || 0) <= 0;
                                                    const progress = ((flashSale?.soldCount || 0) / (flashSale?.stock || 1)) * 100;

                                                    return (
                                                        <button
                                                            key={`fs-${product._id}`}
                                                            onClick={() => {
                                                                if (!isDown && !isSoldOut) {
                                                                    clearGuestCheckoutSubmission();
                                                                    setSelectedProduct(product);
                                                                    setSelectedFlashSale(true);
                                                                }
                                                            }}
                                                            disabled={isDown || isSoldOut}
                                                            className={`relative p-4 rounded-xl border-2 transition-all text-left ${
                                                                isDown || isSoldOut
                                                                    ? 'cursor-not-allowed ui-border bg-[var(--ui-card-muted)] opacity-60'
                                                                    : isSelected 
                                                                        ? 'border-orange-500 bg-orange-500/10 shadow-lg shadow-orange-500/20' 
                                                                        : 'ui-border ui-panel hover:bg-[var(--ui-card-muted)]'
                                                            }`}
                                                        >
                                                            <div className="absolute -left-2 -top-2 flex items-center gap-1 rounded-full bg-gradient-to-r from-orange-400 to-orange-600 px-2 py-0.5 text-[10px] font-bold ui-text shadow-lg">
                                                                <Zap className="h-3 w-3" />
                                                                {flashSale?.discountType === 'percentage' ? `-${flashSale.discountValue}%` : 'SALE'}
                                                            </div>
                                                            {isSelected && !isDown && !isSoldOut && (
                                                                <div className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-orange-500">
                                                                    <Check className="h-3 w-3 ui-text" />
                                                                </div>
                                                            )}
                                                            <div className="flex items-center gap-2 mt-1">
                                                                <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-lg border ui-border ui-shell">
                                                                    <OperatorIcon icon={product.icon || productType?.icon || operator?.icon} fallback="🛒" size="lg" />
                                                                </div>
                                                                <div>
                                                                    <div className="text-xs ui-text-muted line-through">
                                                                        Rp {formatPrice(originalPrice)}
                                                                    </div>
                                                                    <div className="flex flex-wrap items-center gap-2">
                                                                        <div className="text-lg font-bold ui-accent-text">
                                                                            Rp {formatPrice(flashPrice)}
                                                                        </div>
                                                                        {getRewardPoints(product.rewardPoints) > 0 && (
                                                                            <span className="inline-flex items-center gap-1 rounded-full border border-[var(--ui-accent)]/25 bg-[var(--ui-accent-soft)] px-2 py-0.5 text-[10px] font-bold ui-accent-text">
                                                                                <Sparkles className="h-3 w-3 text-orange-500" />
                                                                                +{getRewardPoints(product.rewardPoints).toLocaleString('id-ID')}
                                                                            </span>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                            </div>
                                                            <div className="mt-1 line-clamp-2 text-sm ui-text-muted">
                                                                {product.name}
                                                            </div>

                                                            {isSoldOut ? (
                                                                <div className="mt-2 text-center">
                                                                    <span className="rounded-full bg-[var(--ui-card-muted)] px-2 py-1 text-xs font-semibold ui-text-muted">
                                                                        Habis
                                                                    </span>
                                                                </div>
                                                            ) : (
                                                                <div className="mt-2">
                                                                    <div className="mb-1 flex items-center justify-between text-[10px] ui-text-muted">
                                                                        <span>{flashSale?.soldCount || 0} / {flashSale?.stock || 0} terjual</span>
                                                                        <span>Sisa {flashSale?.remainingStock || 0}</span>
                                                                    </div>
                                                                    <div className="h-1.5 overflow-hidden rounded-full bg-[var(--ui-card-muted)]">
                                                                        <div 
                                                                            className="h-full bg-gradient-to-r from-orange-400 to-orange-600"
                                                                            style={{ width: `${Math.min(progress, 100)}%` }}
                                                                        />
                                                                    </div>
                                                                </div>
                                                            )}
                                                        </button>
                                                    );
                                                })}
                                            </div>
                                        </div>
                                    );
                                })()}

                                <div className="space-y-3">
                                    {products.some(p => flashSaleMap[p._id]?.hasFlashSale) && (
                                        <div className="flex items-center gap-2">
                                            <span className="font-bold ui-text">Harga Normal</span>
                                        </div>
                                    )}
                                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                                        {products.map((product) => {
                                            const price = getOriginalPrice(product);
                                            const isSelected = selectedProduct?._id === product._id && !selectedFlashSale;
                                            const isDown = product.status === false || product.canPurchase === false;

                                            return (
                                                <button
                                                    key={`normal-${product._id}`}
                                                    onClick={() => {
                                                        if (!isDown) {
                                                            clearGuestCheckoutSubmission();
                                                            setSelectedProduct(product);
                                                            setSelectedFlashSale(false);
                                                        }
                                                    }}
                                                    disabled={isDown}
                                                    className={`relative p-4 rounded-xl border-2 transition-all text-left ${
                                                        isDown
                                                            ? 'cursor-not-allowed ui-border bg-[var(--ui-card-muted)] opacity-60'
                                                            : isSelected 
                                                                ? 'border-orange-500 bg-orange-500/10 shadow-lg shadow-orange-500/20' 
                                                                : 'ui-border ui-panel hover:bg-[var(--ui-card-muted)]'
                                                    }`}
                                                >
                                                    {isSelected && !isDown && (
                                                        <div className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-orange-500">
                                                            <Check className="h-3 w-3 ui-text" />
                                                        </div>
                                                    )}
                                                    <div className="flex items-center justify-between gap-2">
                                                        <div className="flex items-center gap-2">
                                                            <div className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-lg border ui-border ui-shell">
                                                                <OperatorIcon icon={product.icon || productType?.icon || operator?.icon} fallback="🛒" size="lg" />
                                                            </div>
                                                            <div className="flex flex-wrap items-center gap-2">
                                                                <div className="text-lg font-bold ui-accent-text">
                                                                    Rp {formatPrice(price)}
                                                                </div>
                                                                {getRewardPoints(product.rewardPoints) > 0 && (
                                                                    <span className="inline-flex items-center gap-1 rounded-full border border-[var(--ui-accent)]/25 bg-[var(--ui-accent-soft)] px-2 py-0.5 text-[10px] font-bold ui-accent-text">
                                                                        <Sparkles className="h-3 w-3 text-orange-500" />
                                                                        +{getRewardPoints(product.rewardPoints).toLocaleString('id-ID')}
                                                                    </span>
                                                                )}
                                                            </div>
                                                        </div>
                                                        {isDown && (
                                                            <span className="rounded-full bg-rose-500/20 px-2 py-1 text-[11px] font-semibold text-rose-400">
                                                                Gangguan
                                                            </span>
                                                        )}
                                                    </div>
                                                    <div className="mt-1 line-clamp-2 text-sm ui-text-muted">
                                                        {product.name}
                                                    </div>

                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            </>
                        )}
                    </div>
                </div>

                {/* Step 3: Metode Pembayaran */}
                <div id="payment-section" className={panelClass}>
                    <div className={panelHeaderClass}>
                        <span className={stepBadgeClass}>3</span>
                        <span className="font-semibold ui-text">Metode Pembayaran</span>
                    </div>
                    <div className="p-4 space-y-3">
                        {/* Saldo */}
                                {isAuthenticated && (
                            <div className="overflow-hidden rounded-[24px] border ui-border">
                                <button
                                    onClick={() => setExpandedPayment(expandedPayment === 'saldo' ? null : 'saldo')}
                                    className="flex w-full items-center justify-between bg-[var(--ui-card-muted)] px-4 py-3 hover:bg-[var(--ui-card-muted)]"
                                >
                                    <div className="flex items-center gap-3">
                                        <Wallet className="h-5 w-5 text-orange-500" />
                                        <span className="font-medium ui-text">Saldo</span>
                                        <span className="text-sm ui-text-muted">
                                            (Rp {formatPrice(user?.balance || 0)})
                                        </span>
                                    </div>
                                    {expandedPayment === 'saldo' ? <ChevronUp className="h-5 w-5 ui-text-muted" /> : <ChevronDown className="h-5 w-5 ui-text-muted" />}
                                </button>
                                {expandedPayment === 'saldo' && (
                                    <div className="border-t ui-border p-3">
                                        <button
                                            onClick={() => {
                                                clearGuestCheckoutSubmission();
                                                setSelectedPayment({ _id: 'saldo', name: 'Saldo', type: 'saldo', status: true });
                                            }}
                                            className={`flex w-full items-center gap-3 rounded-[20px] border-2 p-3 transition-all ${
                                                selectedPayment?._id === 'saldo'
                                                    ? 'border-orange-500 bg-orange-500/10'
                                                    : 'ui-border ui-panel hover:bg-[var(--ui-card-muted)]'
                                            }`}
                                        >
                                            <Wallet className="h-8 w-8 text-orange-500" />
                                            <div className="text-left">
                                                <div className="font-medium ui-text">Bayar dengan Saldo</div>
                                                <div className="text-xs text-emerald-400">OPEN</div>
                                            </div>
                                            {selectedPayment?._id === 'saldo' && (
                                                <Check className="ml-auto h-5 w-5 text-orange-500" />
                                            )}
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Other Payment Methods */}
                        {Object.entries(groupedPayments).map(([type, methods]) => (
                            <div key={type} className="overflow-hidden rounded-[24px] border ui-border">
                                <button
                                    onClick={() => setExpandedPayment(expandedPayment === type ? null : type)}
                                    className="flex w-full items-center justify-between bg-[var(--ui-card-muted)] px-4 py-3 hover:bg-[var(--ui-card-muted)]"
                                >
                                    <div className="flex items-center gap-3">
                                        <span className="font-medium capitalize ui-text">{type}</span>
                                    </div>
                                    {expandedPayment === type ? <ChevronUp className="h-5 w-5 ui-text-muted" /> : <ChevronDown className="h-5 w-5 ui-text-muted" />}
                                </button>
                                {expandedPayment === type && (
                                    <div className="grid grid-cols-2 gap-2 border-t ui-border p-3">
                                        {methods.map((method) => (
                                            <button
                                                key={method._id}
                                                onClick={() => {
                                                    clearGuestCheckoutSubmission();
                                                    setSelectedPayment(method);
                                                }}
                                                className={`flex items-center gap-3 rounded-[20px] border-2 p-3 transition-all ${
                                                    selectedPayment?._id === method._id
                                                        ? 'border-orange-500 bg-orange-500/10'
                                                        : 'ui-border ui-panel hover:bg-[var(--ui-card-muted)]'
                                                }`}
                                            >
                                                <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg border ui-border ui-shell">
                                                    {method.icon ? (
                                                        <img src={method.icon} alt={method.name} className="w-full h-full object-cover" />
                                                    ) : (
                                                        <span className="text-[10px] ui-text-muted">ICON</span>
                                                    )}
                                                </div>
                                                <div className="text-left flex-1">
                                                    <div className="text-sm font-medium ui-text">{method.name}</div>
                                                    <div className="text-xs text-blue-400">Transfer Bank</div>
                                                </div>
                                                {selectedPayment?._id === method._id && (
                                                    <Check className="h-4 w-4 text-orange-500" />
                                                )}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                </div>

                {/* Step 4: Voucher */}
                <div className={panelClass}>
                    <div className={panelHeaderClass}>
                        <span className={stepBadgeClass}>4</span>
                        <span className="font-semibold ui-text">Voucher</span>
                    </div>
                    <div className="p-4">
                        <div className="flex gap-2">
                            <input
                                type="text"
                                value={voucher}
                                onChange={(e) => setVoucher(e.target.value)}
                                placeholder="Voucher checkout belum tersedia"
                                disabled
                                className="flex-1 cursor-not-allowed rounded-[20px] border ui-border ui-panel px-4 py-3 ui-text-muted placeholder-[var(--ui-text-muted)] outline-none"
                            />
                            <button disabled className="cursor-not-allowed rounded-[20px] border ui-border bg-[var(--ui-card-muted)] px-4 py-3 font-medium ui-text-muted">
                                Belum Aktif
                            </button>
                        </div>
                        <p className="mt-2 text-xs ui-text-muted">
                            Voucher diskon checkout belum terhubung. Gunakan halaman redeem voucher untuk top up saldo.
                        </p>
                    </div>
                </div>

                {/* Step 5: Kontak */}
                <div className={panelClass}>
                    <div className={panelHeaderClass}>
                        <span className={stepBadgeClass}>5</span>
                        <span className="font-semibold ui-text">Kontak</span>
                    </div>
                    <div className="p-4">
                        <label className={labelClass}>
                            Nomor Whatsapp
                        </label>
                        <input
                            type="text"
                            value={whatsapp}
                            onChange={(e) => {
                                clearGuestCheckoutSubmission();
                                setWhatsapp(e.target.value);
                            }}
                            placeholder="08xxxxxxxxxx"
                            className={inputClass}
                        />
                        <p className="mt-2 text-xs ui-text-muted">
                            Format: 08XXXXXXX
                        </p>
                    </div>
                </div>
            </div>

            {/* Fixed Bottom */}
            <div className="fixed bottom-0 left-0 right-0 z-20 border-t ui-border bg-[var(--ui-body-bg)]/90 p-4 backdrop-blur-xl">
                <div className="mx-auto max-w-5xl">
                    <div className="flex items-center justify-between mb-3">
                        <div>
                            <p className="text-xs ui-text-muted">Total</p>
                            <div className="flex flex-wrap items-center gap-2">
                                <p className="text-2xl font-bold ui-text">
                                    Rp {selectedProduct ? formatPrice(selectedPayment?._id === 'saldo' ? basePrice : estimatedTransferTotal) : '0'}
                                </p>
                                {rewardPoints > 0 && (
                                    <span className="inline-flex items-center gap-1 rounded-full border border-[var(--ui-accent)]/25 bg-[var(--ui-accent-soft)] px-2.5 py-1 text-xs font-bold ui-accent-text">
                                        <Sparkles className="h-3.5 w-3.5 text-orange-500" />
                                        +{rewardPoints.toLocaleString('id-ID')}
                                    </span>
                                )}
                            </div>
                            {selectedPayment?._id !== 'saldo' && estimatedAdminFee > 0 && (
                                <p className="text-xs ui-text-muted">
                                    Estimasi fee Rp {formatPrice(estimatedAdminFee)}
                                </p>
                            )}
                            {selectedPayment?._id !== 'saldo' && selectedPayment?.useUniqueCode !== false && (
                                <p className="text-xs ui-text-muted">
                                    Kode unik transfer ditambahkan saat invoice dibuat
                                </p>
                            )}
                        </div>
                        <p className="max-w-[150px] text-right text-xs ui-text-muted">
                            {selectedPayment?._id === 'saldo' ? 'Bayar via saldo' : 'Estimasi transfer bank'}
                        </p>
                    </div>
                    {guestCheckoutState.reconciliationVisible && (
                        <div className="mb-3 rounded-[18px] border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-500">
                            <p>{CRITICAL_MUTATION_AMBIGUOUS_MESSAGE}. Invoice mungkin sudah dibuat.</p>
                            <div className="mt-2 flex gap-2">
                                <button type="button" onClick={handleSubmit} className="rounded-xl bg-amber-500 px-3 py-2 font-semibold text-black">
                                    Coba lagi dengan kunci yang sama
                                </button>
                                <button type="button" onClick={() => transitionGuestCheckoutSubmission({ type: 'cancel' })} className="rounded-xl border border-amber-500/40 px-3 py-2">
                                    Batalkan pengiriman
                                </button>
                            </div>
                        </div>
                    )}
                    <button
                        onClick={handleSubmit}
                        disabled={!selectedProduct || !target.trim() || (requiresSecondaryTarget && !serverId.trim()) || submitting}
                        className="flex w-full items-center justify-center gap-2 rounded-[22px] ui-accent-solid py-4 font-semibold shadow-lg shadow-orange-500/20 transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {submitting ? (
                            <>
                                <Loader2 className="w-5 h-5 animate-spin" />
                                Memproses...
                            </>
                        ) : (
                            'Beli Sekarang'
                        )}
                    </button>
                </div>
            </div>

            {/* Payment Modal */}
            {showPaymentModal && paymentInfo && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--ui-body-bg)]/80 p-4 backdrop-blur-sm">
                    <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-[30px] border ui-border ui-panel shadow-2xl">
                        <div className="flex items-center justify-between border-b ui-border bg-[var(--ui-card-muted)] p-4">
                            <h2 className="text-lg font-bold ui-text">Pembayaran</h2>
                            <button 
                                onClick={() => {
                                    setShowPaymentModal(false);
                                    navigate('/');
                                }}
                                className="rounded-lg p-2 ui-text-muted transition hover:bg-[var(--ui-card-muted)] hover:text-[var(--ui-text)]"
                            >
                                <X className="h-5 w-5" />
                            </button>
                        </div>
                        
                        <div className="p-4 space-y-4">
                            {/* Invoice Number */}
                            <div className="rounded-[22px] border border-orange-500/30 bg-orange-500/10 p-4 text-center">
                                <p className="mb-1 text-sm ui-text-muted">Invoice</p>
                                <p className="text-lg font-bold ui-accent-text">{paymentInfo.invoiceNumber}</p>
                                {whatsapp.trim() && (
                                    <button
                                        type="button"
                                        onClick={() => navigate(`/check-transaction?invoice=${encodeURIComponent(paymentInfo.invoiceNumber)}&whatsapp=${encodeURIComponent(whatsapp.trim())}`)}
                                        className="mt-3 inline-flex items-center justify-center rounded-lg border ui-border ui-panel-muted px-3 py-2 text-xs font-medium ui-accent-text hover:bg-[var(--ui-card-muted)]/80"
                                    >
                                        Cek status transaksi
                                    </button>
                                )}
                            </div>

                            {/* Bank Info */}
                            <div className="space-y-3 rounded-[22px] border ui-border bg-[var(--ui-card-muted)] p-4">
                                <div className="flex items-center justify-between">
                                    <span className="text-sm ui-text-muted">Bank</span>
                                    <span className="font-medium ui-text">{paymentInfo.bankName}</span>
                                </div>
                                <div className="flex items-center justify-between">
                                    <span className="text-sm ui-text-muted">No. Rekening</span>
                                    <div className="flex items-center gap-2">
                                        <span className="font-medium ui-accent-text">{paymentInfo.accountNumber}</span>
                                        <button 
                                            onClick={() => handleCopy(paymentInfo.accountNumber, 'account')}
                                            className="rounded p-1 hover:bg-[var(--ui-card-muted)]"
                                        >
                                            {copied === 'account' ? <CheckCircle className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4 ui-text-muted" />}
                                        </button>
                                    </div>
                                </div>
                                <div className="flex items-center justify-between">
                                    <span className="text-sm ui-text-muted">Atas Nama</span>
                                    <span className="font-medium ui-text">{paymentInfo.accountName}</span>
                                </div>
                            </div>

                            {/* Payment Summary */}
                            <div className="space-y-2 rounded-[22px] border ui-border bg-[var(--ui-card-muted)] p-4 text-center">
                                <p className="text-sm ui-text-muted">Total Pembayaran</p>
                                {savings > 0 && (
                                    <p className="text-xs font-semibold text-emerald-400">Hemat Rp {formatPrice(savings)}</p>
                                )}
                                <div className="flex flex-wrap items-center justify-center gap-2">
                                    <p className="text-2xl font-bold ui-accent-text">
                                        Rp {formatPrice(paymentInfo?.totalAmount ?? displayPrice)}
                                    </p>
                                    {rewardPoints > 0 && (
                                        <span className="inline-flex items-center gap-1 rounded-full border border-[var(--ui-accent)]/25 bg-[var(--ui-accent-soft)] px-2.5 py-1 text-xs font-bold ui-accent-text">
                                            <Sparkles className="h-3.5 w-3.5 text-orange-500" />
                                            +{rewardPoints.toLocaleString('id-ID')}
                                        </span>
                                    )}
                                </div>
                            </div>

                            {/* Amount Details */}
                            <div className="space-y-3 rounded-[22px] border ui-border bg-[var(--ui-card-muted)] p-4">
                                <div className="flex items-center justify-between">
                                    <span className="text-sm ui-text-muted">Harga Produk</span>
                                    <span className="ui-text">Rp {formatPrice(paymentInfo.amount)}</span>
                                </div>
                                <div className="flex items-center justify-between">
                                    <span className="text-sm ui-text-muted">Biaya Admin</span>
                                    <span className="ui-text">Rp {formatPrice(paymentInfo.adminFee)}</span>
                                </div>
                                <div className="flex items-center justify-between">
                                    <span className="text-sm ui-text-muted">Kode Unik</span>
                                    <span className="ui-accent-text">{paymentInfo.uniqueCode}</span>
                                </div>
                                <div className="flex items-center justify-between border-t ui-border pt-3">
                                    <span className="font-medium ui-text">Total Transfer</span>
                                    <div className="flex items-center gap-2">
                                        <span className="text-xl font-bold ui-accent-text">Rp {formatPrice(paymentInfo.totalAmount)}</span>
                                        <button 
                                            onClick={() => handleCopy(paymentInfo.totalAmount.toString(), 'amount')}
                                            className="rounded p-1 hover:bg-[var(--ui-card-muted)]"
                                        >
                                            {copied === 'amount' ? <CheckCircle className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4 ui-text-muted" />}
                                        </button>
                                    </div>
                                </div>
                            </div>

                            {/* Important Notes */}
                            <div className="rounded-[22px] border border-amber-500/30 bg-amber-500/10 p-4">
                                <p className="mb-2 text-sm font-medium text-amber-500">Penting!</p>
                                <ul className="space-y-1 text-xs text-amber-500/80">
                                    <li>• Transfer sesuai nominal termasuk kode unik</li>
                                    <li>• Transaksi akan diproses setelah pembayaran dikonfirmasi</li>
                                    <li>• Batas waktu pembayaran: 24 jam</li>
                                </ul>
                            </div>

                            {/* Expiry */}
                            <div className="text-center text-sm ui-text-muted">
                                Bayar sebelum: {new Date(paymentInfo.expiredAt).toLocaleString('id-ID')}
                            </div>

                            {/* Actions */}
                            <div className="flex gap-3">
                                <button
                                    onClick={() => {
                                        setShowPaymentModal(false);
                                        navigate('/');
                                    }}
                                    className="flex-1 rounded-xl border ui-border ui-panel py-3 font-medium ui-text-muted transition hover:bg-[var(--ui-card-muted)] hover:text-[var(--ui-text)]"
                                >
                                    Kembali
                                </button>
                                <button
                                    onClick={() => navigate(`/check-transaction?invoice=${encodeURIComponent(paymentInfo.invoiceNumber)}&whatsapp=${encodeURIComponent(whatsapp.trim())}`)}
                                    className="flex-1 rounded-xl ui-accent-solid py-3 font-medium shadow-lg shadow-orange-500/20 transition hover:brightness-105"
                                >
                                    Cek Status
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Info Popup Modal */}
            {showPopup && productType?.popupInfo?.enabled && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--ui-body-bg)]/80 p-4 backdrop-blur-sm">
                    <div className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-[30px] border ui-border ui-panel shadow-2xl">
                        {/* Close button */}
                        <div className="flex justify-end p-3">
                            <button 
                                onClick={() => setShowPopup(false)}
                                className="rounded-lg p-2 ui-text-muted transition hover:bg-[var(--ui-card-muted)]"
                            >
                                <X className="h-5 w-5" />
                            </button>
                        </div>
                        
                        <div className="space-y-4 px-6 pb-6">
                            {/* Image */}
                            {productType.popupInfo.image && (
                                <img 
                                    src={productType.popupInfo.image} 
                                    alt={productType.popupInfo.title || 'Info'} 
                                    className="w-full rounded-xl object-cover"
                                />
                            )}

                            {/* Title */}
                            {productType.popupInfo.title && (
                                <h3 className="text-center text-xl font-bold ui-text">
                                    {productType.popupInfo.title}
                                </h3>
                            )}

                            {/* Content */}
                            {productType.popupInfo.content && (
                                <p className="whitespace-pre-line text-sm leading-relaxed ui-text-muted">
                                    {productType.popupInfo.content}
                                </p>
                            )}

                            {/* Button */}
                            {productType.popupInfo.buttonText && (
                                <button
                                    onClick={() => {
                                        if (productType.popupInfo?.buttonLink) {
                                            window.open(productType.popupInfo.buttonLink, '_blank');
                                        }
                                        setShowPopup(false);
                                    }}
                                    className="w-full rounded-xl ui-accent-solid py-3 font-semibold shadow-lg shadow-orange-500/20 transition hover:brightness-105"
                                >
                                    {productType.popupInfo.buttonText}
                                </button>
                            )}

                            {/* Close text if no button */}
                            {!productType.popupInfo.buttonText && (
                                <button
                                    onClick={() => setShowPopup(false)}
                                    className="w-full rounded-xl border ui-border ui-panel-muted py-3 font-medium ui-text-muted transition hover:bg-[var(--ui-card-muted)] hover:text-[var(--ui-text)]"
                                >
                                    Tutup
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Instruction Image Modal */}
            {showInstructionModal && operator?.instructionImage && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--ui-body-bg)]/80 p-4 backdrop-blur-sm">
                    <div className="w-full max-w-lg overflow-hidden rounded-[30px] border ui-border ui-panel shadow-2xl">
                        <div className="flex items-center justify-between border-b ui-border bg-[var(--ui-card-muted)] p-4">
                            <h3 className="font-semibold ui-text">Petunjuk</h3>
                            <button 
                                onClick={() => setShowInstructionModal(false)}
                                className="rounded-lg p-2 ui-text-muted transition hover:bg-[var(--ui-card-muted)] hover:text-[var(--ui-text)]"
                            >
                                <X className="h-5 w-5" />
                            </button>
                        </div>
                        <div className="p-4">
                            <img 
                                src={operator.instructionImage} 
                                alt="Petunjuk" 
                                className="w-full rounded-xl"
                            />
                        </div>
                        <div className="border-t ui-border p-4">
                            <button
                                onClick={() => setShowInstructionModal(false)}
                                className="w-full rounded-xl border ui-border ui-panel-muted py-3 font-medium ui-text-muted transition hover:bg-[var(--ui-card-muted)] hover:text-[var(--ui-text)]"
                            >
                                Tutup
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
