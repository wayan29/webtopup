import { useEffect, useMemo, useRef, useState } from 'react';
import { apiV2 } from '../../api';
import { Search, User, Loader, CheckCircle, XCircle, Gamepad2, MapPin, Phone, Plus, Pencil, Save, Trash2 } from 'lucide-react';
import {
    applyProductHydrationSettled,
    applySingleHydrationOutcome,
    commitProductHydrationState,
    INVALID_PRODUCT_VERSION_MESSAGE,
    isProductVersionMutable,
    mapValidationHttpError,
    mutationVersionForProduct,
    PRODUCT_HYDRATION_ENDPOINTS,
    shouldAcceptValidationOutcome,
    type HydrationSettledResult,
    type ProductHydrationResource,
    type ProductHydrationState,
    type ValidationProduct,
} from './validationHydrationHelpers';

type ValidationType = 'freefire' | 'mobilelegends' | 'operator';

interface GameValidationResult {
    success: boolean;
    data?: {
        userId: string;
        zoneId?: string;
        nickname: string;
    };
    message?: string;
}

interface OperatorValidationResult {
    success: boolean;
    data?: {
        phoneNumber: string;
        originalNumber: string;
        operator: string;
        prefix: string;
        color: string;
    };
    message?: string;
}

type ValidationResult = GameValidationResult | OperatorValidationResult;

type ValidationProductType = 'nickname' | 'operator';
type ValidationGame = '' | 'freefire' | 'mobilelegends';

interface CatalogItem {
    _id: string;
    name: string;
    categoryId?: string | { _id: string };
    operatorId?: string | { _id: string };
}

interface ValidationProductRow extends ValidationProduct {
    categoryId?: string | { _id: string; name?: string };
    operatorId?: string | { _id: string; name?: string };
    productTypeId?: string | { _id: string; name?: string };
    costPrice?: number;
    price?: { basic?: number; gold?: number; platinum?: number };
    validation?: {
        type?: ValidationProductType;
        game?: ValidationGame;
        targetLabel?: string;
        secondaryTargetLabel?: string;
        resultLabel?: string;
    };
}

interface ValidationProductForm {
    id?: string;
    version?: number | null;
    name: string;
    code: string;
    categoryId: string;
    operatorId: string;
    productTypeId: string;
    costPrice: number;
    price: { basic: number; gold: number; platinum: number };
    status: boolean;
    validationType: ValidationProductType;
    game: ValidationGame;
    targetLabel: string;
    secondaryTargetLabel: string;
    resultLabel: string;
}

const VALIDATION_PRODUCT_CONFLICT_MESSAGE =
    'Data produk telah berubah. Daftar dimuat ulang; periksa perubahan sebelum mencoba lagi.';

const emptyProductForm: ValidationProductForm = {
    name: '',
    code: '',
    categoryId: '',
    operatorId: '',
    productTypeId: '',
    costPrice: 0,
    price: { basic: 0, gold: 0, platinum: 0 },
    status: true,
    validationType: 'nickname',
    game: 'freefire',
    targetLabel: 'User ID',
    secondaryTargetLabel: '',
    resultLabel: 'Nickname',
};

const validationTypes = [
    { id: 'freefire' as ValidationType, name: 'Free Fire', color: 'orange', icon: Gamepad2 },
    { id: 'mobilelegends' as ValidationType, name: 'Mobile Legends', color: 'blue', icon: Gamepad2 },
    { id: 'operator' as ValidationType, name: 'Cek Operator', color: 'green', icon: Phone },
];

const operatorColors: Record<string, string> = {
    red: 'ui-danger-chip',
    yellow: 'ui-warning-chip',
    blue: 'ui-info-chip',
    gray: 'ui-muted-action',
    purple: 'ui-accent-chip',
    green: 'ui-success-chip',
};

export default function Validation() {
    const [activeType, setActiveType] = useState<ValidationType>('freefire');
    const [userId, setUserId] = useState('');
    const [zoneId, setZoneId] = useState('');
    const [phoneNumber, setPhoneNumber] = useState('');
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState<ValidationResult | null>(null);
    const [products, setProducts] = useState<ValidationProductRow[]>([]);
    const [categories, setCategories] = useState<CatalogItem[]>([]);
    const [operators, setOperators] = useState<CatalogItem[]>([]);
    const [productTypes, setProductTypes] = useState<CatalogItem[]>([]);
    const [productLoading, setProductLoading] = useState(false);
    const [productSaving, setProductSaving] = useState(false);
    const [productError, setProductError] = useState('');
    const [productMessage, setProductMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const [confirmAction, setConfirmAction] = useState<{ type: 'toggle' | 'archive'; product: ValidationProductRow } | null>(null);
    const [productForm, setProductForm] = useState<ValidationProductForm>(emptyProductForm);
    const [productResourceErrors, setProductResourceErrors] = useState<Partial<Record<ProductHydrationResource, string>>>({});
    const latestProductRequestId = useRef(0);
    const latestValidationRequestId = useRef(0);
    const hydrationSnapshotRef = useRef<ProductHydrationState>({
        products: [],
        categories: [],
        operators: [],
        productTypes: [],
        resourceErrors: {},
    });

    useEffect(() => {
        hydrationSnapshotRef.current = {
            products,
            categories,
            operators,
            productTypes,
            resourceErrors: productResourceErrors,
        };
    }, [products, categories, operators, productTypes, productResourceErrors]);

    const applyHydrationState = (state: ProductHydrationState) => {
        hydrationSnapshotRef.current = state;
        commitProductHydrationState(state, {
            setProducts,
            setCategories,
            setOperators,
            setProductTypes,
            setProductResourceErrors,
        });
    };

    const invalidateValidationRequest = () => {
        latestValidationRequestId.current += 1;
        setLoading(false);
    };

    const getId = (value: unknown): string => {
        if (!value) return '';
        if (typeof value === 'object' && '_id' in value) return String((value as { _id?: string })._id || '');
        return String(value);
    };

    const filteredOperators = useMemo(
        () => operators.filter((operator) => getId(operator.categoryId) === productForm.categoryId),
        [operators, productForm.categoryId],
    );
    const filteredProductTypes = useMemo(
        () => productTypes.filter((type) => getId(type.operatorId) === productForm.operatorId),
        [productTypes, productForm.operatorId],
    );

    const sanitizeNumericInput = (value: string, maxLength: number) =>
        value.replace(/\D/g, '').slice(0, maxLength);

    const fetchValidationProducts = async () => {
        const requestId = latestProductRequestId.current + 1;
        latestProductRequestId.current = requestId;
        setProductLoading(true);
        setProductError('');
        try {
            const settled = await Promise.allSettled([
                apiV2.get(PRODUCT_HYDRATION_ENDPOINTS.products),
                apiV2.get(PRODUCT_HYDRATION_ENDPOINTS.categories),
                apiV2.get(PRODUCT_HYDRATION_ENDPOINTS.operators),
                apiV2.get(PRODUCT_HYDRATION_ENDPOINTS.productTypes),
            ]);
            if (requestId !== latestProductRequestId.current) return;
            const merged = applyProductHydrationSettled(
                hydrationSnapshotRef.current,
                settled as HydrationSettledResult[],
            );
            applyHydrationState(merged);
        } finally {
            if (requestId === latestProductRequestId.current) {
                setProductLoading(false);
            }
        }
    };

    const retryHydrationResource = async (resource: ProductHydrationResource) => {
        const requestId = latestProductRequestId.current + 1;
        latestProductRequestId.current = requestId;
        setProductLoading(true);
        try {
            const response = await apiV2.get(PRODUCT_HYDRATION_ENDPOINTS[resource]);
            if (requestId !== latestProductRequestId.current) return;
            const outcome: HydrationSettledResult = { status: 'fulfilled', value: response };
            applyHydrationState(
                applySingleHydrationOutcome(hydrationSnapshotRef.current, resource, outcome),
            );
        } catch (error: unknown) {
            if (requestId !== latestProductRequestId.current) return;
            const outcome: HydrationSettledResult = {
                status: 'rejected',
                reason: error as { response?: { status?: number; data?: { message?: string } } },
            };
            applyHydrationState(
                applySingleHydrationOutcome(hydrationSnapshotRef.current, resource, outcome),
            );
        } finally {
            if (requestId === latestProductRequestId.current) {
                setProductLoading(false);
            }
        }
    };

    useEffect(() => {
        fetchValidationProducts();
        const handleRefresh = () => fetchValidationProducts();
        window.addEventListener('admin:refresh-current-page', handleRefresh);
        return () => {
            latestProductRequestId.current += 1;
            window.removeEventListener('admin:refresh-current-page', handleRefresh);
        };
    }, []);

    useEffect(() => () => {
        latestValidationRequestId.current += 1;
    }, []);

    const resetProductForm = () => {
        setProductForm(emptyProductForm);
        setProductError('');
    };

    const handleValidationProductConflict = async () => {
        setConfirmAction(null);
        resetProductForm();
        setProductError(VALIDATION_PRODUCT_CONFLICT_MESSAGE);
        setProductMessage(null);
        await fetchValidationProducts();
    };

    const isValidationProductConflict = (error: unknown) => {
        const err = error as { response?: { status?: number; data?: { code?: string } } };
        return (
            err.response?.status === 409 &&
            err.response?.data?.code === 'VALIDATION_PRODUCT_CONFLICT'
        );
    };

    const editProduct = (product: ValidationProductRow) => {
        if (!isProductVersionMutable(product.version)) {
            setProductError(INVALID_PRODUCT_VERSION_MESSAGE);
            return;
        }
        setProductForm({
            id: product._id,
            version: product.version,
            name: product.name,
            code: product.code,
            categoryId: getId(product.categoryId),
            operatorId: getId(product.operatorId),
            productTypeId: getId(product.productTypeId),
            costPrice: product.costPrice || 0,
            price: {
                basic: product.price?.basic || 0,
                gold: product.price?.gold || 0,
                platinum: product.price?.platinum || 0,
            },
            status: product.status,
            validationType: product.validation?.type || 'nickname',
            game: product.validation?.game || (product.validation?.type === 'operator' ? '' : 'freefire'),
            targetLabel: product.validation?.targetLabel || 'User ID',
            secondaryTargetLabel: product.validation?.secondaryTargetLabel || '',
            resultLabel: product.validation?.resultLabel || 'Nickname',
        });
        setProductError('');
    };

    const updateProductForm = (patch: Partial<ValidationProductForm>) => {
        setProductForm((current) => ({ ...current, ...patch }));
    };

    const parseMoneyInput = (value: string) => {
        const digits = value.replace(/\D/g, '').slice(0, 9);
        return Math.min(Number(digits || 0), 100_000_000);
    };

    const updateProductPrice = (tier: keyof ValidationProductForm['price'], value: number) => {
        setProductForm((current) => ({
            ...current,
            price: { ...current.price, [tier]: value },
        }));
    };

    const validateProductForm = () => {
        if (!productForm.name.trim()) return 'Nama produk wajib diisi';
        if (!productForm.code.trim()) return 'Kode SKU wajib diisi';
        if (!productForm.categoryId || !productForm.operatorId || !productForm.productTypeId) return 'Kategori, operator, dan tipe produk wajib dipilih';
        if (productForm.costPrice < 0 || productForm.costPrice > 100_000_000) return 'Harga modal wajib 0 sampai Rp100.000.000';
        const { basic, gold, platinum } = productForm.price;
        if ([basic, gold, platinum].some((value) => value < 0 || value > 100_000_000)) return 'Harga jual wajib 0 sampai Rp100.000.000';
        if (gold < basic || platinum < gold) return 'Urutan harga wajib Basic <= Gold <= Platinum';
        if (productForm.validationType === 'nickname' && !['freefire', 'mobilelegends'].includes(productForm.game)) return 'Game validasi wajib dipilih';
        return null;
    };

    const saveProduct = async (e: React.FormEvent) => {
        e.preventDefault();
        const validationError = validateProductForm();
        if (validationError) {
            setProductError(validationError);
            return;
        }
        if (productForm.id) {
            const mutationVersion = mutationVersionForProduct(productForm.version);
            if (mutationVersion === null) {
                setProductError(INVALID_PRODUCT_VERSION_MESSAGE);
                return;
            }
        }
        setProductSaving(true);
        setProductError('');
        setProductMessage(null);
        try {
            const payload = {
                name: productForm.name,
                code: productForm.code,
                categoryId: productForm.categoryId,
                operatorId: productForm.operatorId,
                productTypeId: productForm.productTypeId,
                costPrice: productForm.costPrice,
                price: productForm.price,
                status: productForm.status,
                validationType: productForm.validationType,
                game: productForm.validationType === 'operator' ? '' : productForm.game,
                targetLabel: productForm.targetLabel,
                secondaryTargetLabel: productForm.validationType === 'operator' ? '' : productForm.secondaryTargetLabel,
                resultLabel: productForm.resultLabel,
            };
            if (productForm.id) {
                const mutationVersion = mutationVersionForProduct(productForm.version);
                if (mutationVersion === null) {
                    setProductError(INVALID_PRODUCT_VERSION_MESSAGE);
                    return;
                }
                await apiV2.put(`/validation-products/${productForm.id}`, {
                    ...payload,
                    version: mutationVersion,
                });
            } else {
                await apiV2.post('/validation-products', payload);
            }
            resetProductForm();
            setProductMessage({ type: 'success', text: productForm.id ? 'Produk validasi berhasil diperbarui' : 'Produk validasi berhasil dibuat' });
            await fetchValidationProducts();
        } catch (error: unknown) {
            if (isValidationProductConflict(error)) {
                await handleValidationProductConflict();
                return;
            }
            const err = error as { response?: { data?: { message?: string } } };
            setProductError(err.response?.data?.message || 'Gagal menyimpan produk validasi');
        } finally {
            setProductSaving(false);
        }
    };

    const toggleProductStatus = (product: ValidationProductRow) => {
        if (!isProductVersionMutable(product.version)) {
            setProductError(INVALID_PRODUCT_VERSION_MESSAGE);
            return;
        }
        setConfirmAction({ type: 'toggle', product });
    };

    const archiveProduct = (product: ValidationProductRow) => {
        if (!isProductVersionMutable(product.version)) {
            setProductError(INVALID_PRODUCT_VERSION_MESSAGE);
            return;
        }
        setConfirmAction({ type: 'archive', product });
    };

    const runConfirmedProductAction = async () => {
        if (!confirmAction) return;
        const { type, product } = confirmAction;
        setProductSaving(true);
        setProductError('');
        setProductMessage(null);
        const mutationVersion = mutationVersionForProduct(product.version);
        if (mutationVersion === null) {
            setProductError(INVALID_PRODUCT_VERSION_MESSAGE);
            setProductSaving(false);
            return;
        }
        try {
            if (type === 'toggle') {
                await apiV2.put(`/validation-products/${product._id}`, {
                    status: !product.status,
                    version: mutationVersion,
                });
                setProductMessage({ type: 'success', text: `Produk "${product.name}" ${product.status ? 'dinonaktifkan' : 'diaktifkan'}` });
            } else {
                await apiV2.delete(`/validation-products/${product._id}`, {
                    params: { version: mutationVersion },
                });
                setProductMessage({ type: 'success', text: `Produk "${product.name}" berhasil diarsipkan` });
            }
            setConfirmAction(null);
            await fetchValidationProducts();
        } catch (error: unknown) {
            if (isValidationProductConflict(error)) {
                await handleValidationProductConflict();
                return;
            }
            const err = error as { response?: { data?: { message?: string } } };
            setProductError(err.response?.data?.message || (type === 'toggle' ? 'Gagal mengubah status produk' : 'Gagal mengarsipkan produk'));
        } finally {
            setProductSaving(false);
        }
    };

    const handleValidate = async (e: React.FormEvent) => {
        e.preventDefault();

        if (activeType === 'operator') {
            if (!phoneNumber.trim()) return;
        } else {
            if (!userId.trim()) return;
            if (activeType === 'mobilelegends' && !zoneId.trim()) return;
        }

        const requestId = latestValidationRequestId.current + 1;
        latestValidationRequestId.current = requestId;
        setLoading(true);
        setResult(null);

        try {
            let endpoint = '';
            let payload = {};

            if (activeType === 'freefire') {
                endpoint = '/validate/freefire';
                payload = { userId: userId.trim() };
            } else if (activeType === 'mobilelegends') {
                endpoint = '/validate/mobilelegends';
                payload = { userId: userId.trim(), zoneId: zoneId.trim() };
            } else {
                endpoint = '/validate/operator';
                payload = { phoneNumber: phoneNumber.trim() };
            }

            const res = await apiV2.post(endpoint, payload);
            if (!shouldAcceptValidationOutcome(requestId, latestValidationRequestId.current)) return;
            setResult(res.data);
        } catch (error: any) {
            if (!shouldAcceptValidationOutcome(requestId, latestValidationRequestId.current)) return;
            const status = error.response?.status as number | undefined;
            const upstreamMessage = error.response?.data?.message as string | undefined;
            setResult({
                success: false,
                message: mapValidationHttpError(status, upstreamMessage),
            });
        } finally {
            if (shouldAcceptValidationOutcome(requestId, latestValidationRequestId.current)) {
                setLoading(false);
            }
        }
    };

    const handleReset = () => {
        invalidateValidationRequest();
        setUserId('');
        setZoneId('');
        setPhoneNumber('');
        setResult(null);
    };

    const handleTypeChange = (type: ValidationType) => {
        invalidateValidationRequest();
        setActiveType(type);
        setUserId('');
        setZoneId('');
        setPhoneNumber('');
        setResult(null);
    };

    const isFormValid = () => {
        if (activeType === 'operator') {
            return phoneNumber.replace(/\D/g, '').length >= 10;
        } else if (activeType === 'freefire') {
            return userId.length >= 5;
        } else {
            return userId.length >= 5 && zoneId.length >= 1;
        }
    };

    const getButtonColor = () => {
        if (activeType === 'freefire') return 'ui-warning-action';
        if (activeType === 'mobilelegends') return 'ui-info-action';
        return 'ui-success-action';
    };

    const getIconBgColor = () => {
        if (activeType === 'freefire') return 'ui-warning-chip';
        if (activeType === 'mobilelegends') return 'ui-info-chip';
        return 'ui-success-chip';
    };

    const getIconColor = () => {
        if (activeType === 'freefire') return 'ui-warning-text';
        if (activeType === 'mobilelegends') return 'ui-info-text';
        return 'ui-success-text';
    };

    const getTitle = () => {
        if (activeType === 'freefire') return 'Free Fire';
        if (activeType === 'mobilelegends') return 'Mobile Legends';
        return 'Cek Operator';
    };

    const getDescription = () => {
        if (activeType === 'freefire') return 'Validasi nickname akun Free Fire';
        if (activeType === 'mobilelegends') return 'Validasi nickname akun Mobile Legends';
        return 'Cek operator seluler dari nomor HP';
    };

    const ActiveIcon = activeType === 'operator' ? Phone : Gamepad2;

    return (
        <div className="space-y-6 max-w-4xl mx-auto">
            {/* Type Tabs */}
            <div className="flex flex-wrap gap-2">
                {validationTypes.map((type) => (
                    <button
                        key={type.id}
                        onClick={() => handleTypeChange(type.id)}
                        className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                            activeType === type.id
                                ? type.color === 'orange' 
                                    ? 'ui-warning-chip'
                                    : type.color === 'blue'
                                    ? 'ui-info-chip'
                                    : 'ui-success-chip'
                                : 'ui-panel ui-text-muted hover:bg-[var(--ui-card-muted)]'
                        }`}
                    >
                        {type.name}
                    </button>
                ))}
            </div>

            {/* Validation Form */}
            <div className="ui-panel-muted rounded-xl border ui-border p-6">
                <div className="flex items-center gap-3 mb-6">
                    <div className={`h-12 w-12 rounded-xl flex items-center justify-center ${getIconBgColor()}`}>
                        <ActiveIcon className={`h-6 w-6 ${getIconColor()}`} />
                    </div>
                    <div>
                        <h2 className="text-lg font-semibold ui-text">{getTitle()}</h2>
                        <p className="text-sm ui-text-muted">{getDescription()}</p>
                    </div>
                </div>

                <form id="validation-check-form" onSubmit={handleValidate} className="space-y-4">
                    {activeType === 'operator' ? (
                        <div>
                            <label className="block text-sm font-medium ui-text mb-2">
                                Nomor HP
                            </label>
                            <div className="relative">
                                <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 ui-text-muted" />
                                <input
                                    type="text"
                                    value={phoneNumber}
                                    onChange={(e) => setPhoneNumber(e.target.value)}
                                    placeholder="Masukkan nomor HP (contoh: 081234567890)"
                                    className="w-full rounded-lg border pl-10 pr-4 py-3 ui-field"
                                    required
                                    minLength={10}
                                    maxLength={18}
                                    inputMode="tel"
                                />
                            </div>
                            <p className="text-xs ui-text-muted mt-1">Format: 08xx, +62xx, atau 62xx</p>
                        </div>
                    ) : (
                        <>
                            <div>
                                <label className="block text-sm font-medium ui-text mb-2">
                                    User ID
                                </label>
                                <div className="relative">
                                    <User className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 ui-text-muted" />
                                    <input
                                        type="text"
                                        value={userId}
                                        onChange={(e) => setUserId(sanitizeNumericInput(e.target.value, 20))}
                                        placeholder={`Masukkan User ID ${activeType === 'freefire' ? 'Free Fire' : 'Mobile Legends'}`}
                                        className="w-full rounded-lg border pl-10 pr-4 py-3 ui-field"
                                        required
                                        minLength={5}
                                        maxLength={20}
                                        inputMode="numeric"
                                    />
                                </div>
                                <p className="text-xs ui-text-muted mt-1">User ID minimal 5 karakter</p>
                            </div>

                            {activeType === 'mobilelegends' && (
                                <div>
                                    <label className="block text-sm font-medium ui-text mb-2">
                                        Zone ID (Server)
                                    </label>
                                    <div className="relative">
                                        <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 h-5 w-5 ui-text-muted" />
                                        <input
                                            type="text"
                                            value={zoneId}
                                            onChange={(e) => setZoneId(sanitizeNumericInput(e.target.value, 10))}
                                            placeholder="Masukkan Zone ID (contoh: 2345)"
                                            className="w-full rounded-lg border pl-10 pr-4 py-3 ui-field"
                                            required
                                            maxLength={10}
                                            inputMode="numeric"
                                        />
                                    </div>
                                    <p className="text-xs ui-text-muted mt-1">Zone ID bisa dilihat di profil game (angka dalam kurung)</p>
                                </div>
                            )}
                        </>
                    )}

                    <div className="flex gap-3">
                        <button
                            type="submit"
                            disabled={loading || !isFormValid()}
                            className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-lg border font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${getButtonColor()}`}
                        >
                            {loading ? (
                                <>
                                    <Loader className="h-5 w-5 animate-spin" />
                                    Memvalidasi...
                                </>
                            ) : (
                                <>
                                    <Search className="h-5 w-5" />
                                    Validasi
                                </>
                            )}
                        </button>
                        {result && (
                            <button
                                type="button"
                                onClick={handleReset}
                                className="px-4 py-3 border rounded-lg ui-muted-action transition-colors"
                            >
                                Reset
                            </button>
                        )}
                    </div>
                </form>

                {/* Result */}
                {result && (
                    <div className={`mt-6 p-4 rounded-lg border ${
                        result.success 
                            ? 'ui-success-chip' 
                            : 'ui-danger-chip'
                    }`}>
                        <div className="flex items-start gap-3">
                            {result.success ? (
                                <CheckCircle className="h-6 w-6 ui-success-text flex-shrink-0" />
                            ) : (
                                <XCircle className="h-6 w-6 ui-danger-text flex-shrink-0" />
                            )}
                            <div className="flex-1">
                                <p className={`font-semibold ${result.success ? 'ui-success-text' : 'ui-danger-text'}`}>
                                    {result.success ? 'Validasi Berhasil' : 'Validasi Gagal'}
                                </p>
                                {result.success && result.data ? (
                                    <div className="mt-2 space-y-1">
                                        {activeType === 'operator' && 'operator' in result.data ? (
                                            <>
                                                <p className="ui-text">
                                                    <span className="ui-text-muted">Nomor HP:</span> {result.data.phoneNumber}
                                                </p>
                                                <p className="ui-text flex items-center gap-2">
                                                    <span className="ui-text-muted">Operator:</span>
                                                    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded border font-semibold ${operatorColors[result.data.color] || 'ui-muted-action'}`}>
                                                        {result.data.operator}
                                                    </span>
                                                </p>
                                                <p className="ui-text">
                                                    <span className="ui-text-muted">Prefix:</span> {result.data.prefix}
                                                </p>
                                            </>
                                        ) : 'nickname' in result.data ? (
                                            <>
                                                <p className="ui-text">
                                                    <span className="ui-text-muted">User ID:</span> {result.data.userId}
                                                </p>
                                                {'zoneId' in result.data && result.data.zoneId && (
                                                    <p className="ui-text">
                                                        <span className="ui-text-muted">Zone ID:</span> {result.data.zoneId}
                                                    </p>
                                                )}
                                                <p className="ui-text">
                                                    <span className="ui-text-muted">Nickname:</span>{' '}
                                                    <span className="font-semibold ui-text">{result.data.nickname}</span>
                                                </p>
                                            </>
                                        ) : null}
                                    </div>
                                ) : (
                                    <div className="mt-1 space-y-2">
                                        <p className="ui-text-muted">{result.message}</p>
                                        {result.message?.includes('gangguan') && (
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    const form = document.getElementById('validation-check-form') as HTMLFormElement | null;
                                                    form?.requestSubmit();
                                                }}
                                                className="text-sm font-semibold underline ui-text"
                                            >
                                                Coba lagi
                                            </button>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* Info */}
            <div className="ui-panel-muted rounded-xl border ui-border p-4">
                <h3 className="text-sm font-semibold ui-text mb-2">Informasi</h3>
                <ul className="text-sm ui-text-muted space-y-1">
                    {activeType === 'operator' ? (
                        <>
                            <li>• Deteksi operator berdasarkan prefix nomor HP</li>
                            <li>• Mendukung format: 08xx, +62xx, 62xx</li>
                            <li>• Operator yang didukung: Telkomsel, Indosat, XL, Tri, Smartfren, Axis</li>
                        </>
                    ) : (
                        <>
                            <li>• Validasi menggunakan API Codashop dan GoPay sebagai fallback</li>
                            <li>• Pastikan User ID yang dimasukkan benar</li>
                            {activeType === 'mobilelegends' && (
                                <li>• Zone ID Mobile Legends bisa dilihat di profil game (angka di dalam kurung setelah User ID)</li>
                            )}
                            <li>• Request validasi dibatasi singkat untuk mencegah abuse ke provider</li>
                            <li>• Jika gagal, coba beberapa saat lagi</li>
                        </>
                    )}
                </ul>
            </div>

            {confirmAction && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
                    <div role="dialog" aria-modal="true" aria-labelledby="validation-product-confirm-title" className="w-full max-w-md rounded-xl border ui-border ui-panel shadow-xl">
                        <div className="border-b ui-border p-4 ui-card-gradient">
                            <h2 id="validation-product-confirm-title" className="text-lg font-semibold ui-text">
                                {confirmAction.type === 'toggle' ? (confirmAction.product.status ? 'Nonaktifkan produk?' : 'Aktifkan produk?') : 'Arsipkan produk validasi?'}
                            </h2>
                            <p className="mt-1 text-sm ui-text-muted">
                                {confirmAction.type === 'toggle'
                                    ? 'Perubahan status akan memengaruhi ketersediaan produk validasi berbayar.'
                                    : 'Produk akan disembunyikan dari daftar dan dinonaktifkan. Gunakan ini untuk SKU yang salah atau tidak dipakai lagi.'}
                            </p>
                        </div>
                        <div className="p-4">
                            <div className="rounded-lg border p-3 ui-warning-chip">
                                <div className="font-semibold">{confirmAction.product.name}</div>
                                <div className="mt-1 text-xs font-mono opacity-80">{confirmAction.product.code}</div>
                            </div>
                            <div className="mt-5 flex justify-end gap-3">
                                <button type="button" disabled={productSaving} onClick={() => setConfirmAction(null)} className="rounded-lg border px-4 py-2 text-sm font-medium ui-muted-action disabled:opacity-50">Batal</button>
                                <button type="button" disabled={productSaving} onClick={runConfirmedProductAction} className={`rounded-lg border px-4 py-2 text-sm font-semibold disabled:opacity-50 ${confirmAction.type === 'archive' ? 'ui-danger-chip' : 'ui-accent-solid'}`}>
                                    {productSaving ? 'Memproses...' : confirmAction.type === 'archive' ? 'Arsipkan' : 'Konfirmasi'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            <div className="ui-panel-muted rounded-xl border ui-border p-6 space-y-5">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                        <h2 className="text-xl font-bold ui-text">Produk Validasi Berbayar</h2>
                        <p className="text-sm ui-text-muted">Buat produk validasi yang bisa dibeli member/public dan dipetakan ke Digiflazz Seller.</p>
                    </div>
                    <button type="button" onClick={resetProductForm} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border ui-muted-action text-sm font-semibold">
                        <Plus className="h-4 w-4" /> Produk Baru
                    </button>
                </div>

                {productError && <div className="rounded-lg border px-4 py-3 text-sm ui-danger-chip">{productError}</div>}
                {(['products', 'categories', 'operators', 'productTypes'] as const).map((resource) => {
                    const message = productResourceErrors[resource];
                    if (!message) return null;
                    const isProduct = resource === 'products';
                    return (
                        <div
                            key={resource}
                            className={`rounded-lg border px-4 py-3 text-sm flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between ${isProduct ? 'ui-danger-chip' : 'ui-warning-chip'}`}
                        >
                            <span>{message}</span>
                            <button
                                type="button"
                                disabled={productLoading}
                                onClick={() => retryHydrationResource(resource)}
                                className="text-sm font-semibold underline shrink-0 disabled:opacity-50"
                            >
                                Coba lagi
                            </button>
                        </div>
                    );
                })}
                {productMessage && <div className={`rounded-lg border px-4 py-3 text-sm ${productMessage.type === 'success' ? 'ui-success-chip' : 'ui-danger-chip'}`}>{productMessage.text}</div>}

                <form onSubmit={saveProduct} className="ui-panel rounded-xl border ui-border p-4 space-y-4">
                    <div className="flex items-center gap-2 font-semibold ui-text">
                        {productForm.id ? <Pencil className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                        {productForm.id ? 'Edit Produk Validasi' : 'Tambah Produk Validasi'}
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label className="block text-xs font-medium ui-text-muted mb-1">Nama Produk</label>
                            <input required value={productForm.name} onChange={(e) => updateProductForm({ name: e.target.value })} className="w-full rounded-lg border px-3 py-2 ui-field" />
                        </div>
                        <div>
                            <label className="block text-xs font-medium ui-text-muted mb-1">Kode SKU</label>
                            <input required value={productForm.code} onChange={(e) => updateProductForm({ code: e.target.value })} className="w-full rounded-lg border px-3 py-2 ui-field font-mono" />
                        </div>
                        <div>
                            <label className="block text-xs font-medium ui-text-muted mb-1">Kategori</label>
                            <select required value={productForm.categoryId} onChange={(e) => updateProductForm({ categoryId: e.target.value, operatorId: '', productTypeId: '' })} className="w-full rounded-lg border px-3 py-2 ui-field">
                                <option value="">Pilih kategori</option>
                                {categories.map((category) => <option key={category._id} value={category._id}>{category.name}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className="block text-xs font-medium ui-text-muted mb-1">Operator</label>
                            <select required value={productForm.operatorId} onChange={(e) => updateProductForm({ operatorId: e.target.value, productTypeId: '' })} className="w-full rounded-lg border px-3 py-2 ui-field" disabled={!productForm.categoryId}>
                                <option value="">Pilih operator</option>
                                {filteredOperators.map((operator) => <option key={operator._id} value={operator._id}>{operator.name}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className="block text-xs font-medium ui-text-muted mb-1">Tipe Produk</label>
                            <select required value={productForm.productTypeId} onChange={(e) => updateProductForm({ productTypeId: e.target.value })} className="w-full rounded-lg border px-3 py-2 ui-field" disabled={!productForm.operatorId}>
                                <option value="">Pilih tipe produk</option>
                                {filteredProductTypes.map((type) => <option key={type._id} value={type._id}>{type.name}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className="block text-xs font-medium ui-text-muted mb-1">Tipe Validasi</label>
                            <select value={productForm.validationType} onChange={(e) => {
                                const validationType = e.target.value as ValidationProductType;
                                updateProductForm({
                                    validationType,
                                    game: validationType === 'operator' ? '' : productForm.game || 'freefire',
                                    targetLabel: validationType === 'operator' ? 'Nomor HP' : 'User ID',
                                    secondaryTargetLabel: validationType === 'operator' ? '' : productForm.secondaryTargetLabel,
                                    resultLabel: validationType === 'operator' ? 'Operator' : 'Nickname',
                                });
                            }} className="w-full rounded-lg border px-3 py-2 ui-field">
                                <option value="nickname">Nickname Game</option>
                                <option value="operator">Operator Nomor HP</option>
                            </select>
                        </div>
                        {productForm.validationType === 'nickname' && (
                            <div>
                                <label className="block text-xs font-medium ui-text-muted mb-1">Game</label>
                                <select value={productForm.game} onChange={(e) => {
                                    const game = e.target.value as ValidationGame;
                                    updateProductForm({
                                        game,
                                        secondaryTargetLabel: game === 'mobilelegends' ? (productForm.secondaryTargetLabel || 'Zone ID') : '',
                                    });
                                }} className="w-full rounded-lg border px-3 py-2 ui-field">
                                    <option value="freefire">Free Fire</option>
                                    <option value="mobilelegends">Mobile Legends</option>
                                </select>
                            </div>
                        )}
                        <div>
                            <label className="block text-xs font-medium ui-text-muted mb-1">Label Target</label>
                            <input value={productForm.targetLabel} onChange={(e) => updateProductForm({ targetLabel: e.target.value })} className="w-full rounded-lg border px-3 py-2 ui-field" />
                        </div>
                        {productForm.validationType === 'nickname' && (
                            <div>
                                <label className="block text-xs font-medium ui-text-muted mb-1">Label Target Kedua</label>
                                <input value={productForm.secondaryTargetLabel} onChange={(e) => updateProductForm({ secondaryTargetLabel: e.target.value })} placeholder="Contoh: Zone ID" className="w-full rounded-lg border px-3 py-2 ui-field" />
                            </div>
                        )}
                        <div>
                            <label className="block text-xs font-medium ui-text-muted mb-1">Label Hasil</label>
                            <input value={productForm.resultLabel} onChange={(e) => updateProductForm({ resultLabel: e.target.value })} className="w-full rounded-lg border px-3 py-2 ui-field" />
                        </div>
                        <div>
                            <label className="block text-xs font-medium ui-text-muted mb-1">Harga Modal</label>
                            <input type="text" inputMode="numeric" value={productForm.costPrice} onChange={(e) => updateProductForm({ costPrice: parseMoneyInput(e.target.value) })} className="w-full rounded-lg border px-3 py-2 ui-field" />
                        </div>
                        {(['basic', 'gold', 'platinum'] as const).map((tier) => (
                            <div key={tier}>
                                <label className="block text-xs font-medium ui-text-muted mb-1">Harga {tier}</label>
                                <input type="text" inputMode="numeric" value={productForm.price[tier]} onChange={(e) => updateProductPrice(tier, parseMoneyInput(e.target.value))} className="w-full rounded-lg border px-3 py-2 ui-field" />
                            </div>
                        ))}
                    </div>
                    <label className="inline-flex items-center gap-2 text-sm ui-text">
                        <input type="checkbox" checked={productForm.status} onChange={(e) => updateProductForm({ status: e.target.checked })} />
                        Produk aktif dan bisa dibeli
                    </label>
                    <div className="flex justify-end gap-2">
                        {productForm.id && <button type="button" onClick={resetProductForm} className="px-4 py-2 rounded-lg border ui-muted-action text-sm">Batal Edit</button>}
                        <button disabled={productSaving} className="inline-flex items-center gap-2 px-4 py-2 rounded-lg ui-accent-solid text-sm font-semibold disabled:opacity-50">
                            {productSaving ? <Loader className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                            Simpan Produk
                        </button>
                    </div>
                </form>

                <div className="overflow-x-auto rounded-xl border ui-border">
                    <table className="min-w-full divide-y ui-border text-sm">
                        <thead className="ui-panel">
                            <tr>
                                <th className="px-4 py-3 text-left ui-text-muted font-semibold">Produk</th>
                                <th className="px-4 py-3 text-left ui-text-muted font-semibold">Validasi</th>
                                <th className="px-4 py-3 text-left ui-text-muted font-semibold">Harga</th>
                                <th className="px-4 py-3 text-left ui-text-muted font-semibold">Status</th>
                                <th className="px-4 py-3 text-right ui-text-muted font-semibold">Aksi</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y ui-border">
                            {productLoading ? (
                                <tr><td colSpan={5} className="px-4 py-6 text-center ui-text-muted">Memuat produk...</td></tr>
                            ) : products.length === 0 ? (
                                <tr><td colSpan={5} className="px-4 py-6 text-center ui-text-muted">Belum ada produk validasi.</td></tr>
                            ) : products.map((product) => {
                                const mutable = isProductVersionMutable(product.version);
                                return (
                                <tr key={product._id} className="ui-panel-muted">
                                    <td className="px-4 py-3">
                                        <div className="font-semibold ui-text">{product.name}</div>
                                        <div className="text-xs ui-text-muted font-mono">{product.code}</div>
                                    </td>
                                    <td className="px-4 py-3 ui-text-muted">
                                        {product.validation?.type === 'operator' ? 'Operator' : `Nickname ${product.validation?.game || ''}`}
                                    </td>
                                    <td className="px-4 py-3 ui-text">Rp{(product.price?.basic || 0).toLocaleString('id-ID')}</td>
                                    <td className="px-4 py-3">
                                        <span className={`inline-flex rounded-full border px-2 py-1 text-xs ${product.status ? 'ui-success-chip' : 'ui-danger-chip'}`}>
                                            {product.status ? 'Aktif' : 'Nonaktif'}
                                        </span>
                                    </td>
                                    <td className="px-4 py-3 text-right space-x-2">
                                        <button type="button" disabled={productSaving || !mutable} onClick={() => editProduct(product)} className="px-3 py-1.5 rounded-lg border ui-muted-action text-xs disabled:opacity-50">Edit</button>
                                        <button type="button" disabled={productSaving || !mutable} onClick={() => toggleProductStatus(product)} className="px-3 py-1.5 rounded-lg border ui-muted-action text-xs disabled:opacity-50">
                                            {product.status ? 'Nonaktifkan' : 'Aktifkan'}
                                        </button>
                                        <button type="button" disabled={productSaving || !mutable} onClick={() => archiveProduct(product)} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border ui-danger-chip text-xs disabled:opacity-50">
                                            <Trash2 className="h-3.5 w-3.5" /> Arsipkan
                                        </button>
                                    </td>
                                </tr>
                            );})}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
