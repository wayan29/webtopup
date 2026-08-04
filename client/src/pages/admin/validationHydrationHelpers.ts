interface CatalogItem {
    _id: string;
    name: string;
}

export interface ValidationProduct {
    _id: string;
    version: number | null;
    name: string;
    code: string;
    status: boolean;
}

export const MAX_JS_SAFE_INTEGER = 9_007_199_254_740_991;

export const INVALID_PRODUCT_VERSION_MESSAGE =
    'Versi produk tidak valid. Muat ulang daftar sebelum mencoba lagi.';

export type ProductHydrationResource = 'products' | 'categories' | 'operators' | 'productTypes';

export type HydrationRejectReason = { response?: { status?: number; data?: { message?: string } } };

export type HydrationSettledResult =
    | { status: 'fulfilled'; value: { data?: unknown } }
    | { status: 'rejected'; reason?: HydrationRejectReason };

export type ProductHydrationState = {
    products: ValidationProduct[];
    categories: CatalogItem[];
    operators: CatalogItem[];
    productTypes: CatalogItem[];
    resourceErrors: Partial<Record<ProductHydrationResource, string>>;
};

export const EMPTY_PRODUCT_HYDRATION_STATE: ProductHydrationState = {
    products: [],
    categories: [],
    operators: [],
    productTypes: [],
    resourceErrors: {},
};

export const PRODUCT_HYDRATION_ENDPOINTS: Record<ProductHydrationResource, string> = {
    products: '/validation-products',
    categories: '/validation-products/taxonomy/categories',
    operators: '/validation-products/taxonomy/operators',
    productTypes: '/validation-products/taxonomy/product-types',
};

const HYDRATION_RESOURCE_LABELS: Record<Exclude<ProductHydrationResource, 'products'>, string> = {
    categories: 'Kategori',
    operators: 'Operator',
    productTypes: 'Tipe produk',
};

export const shouldAcceptValidationOutcome = (requestId: number, latestRequestId: number) =>
    requestId === latestRequestId;

export const shouldAcceptHydrationOutcome = shouldAcceptValidationOutcome;

export const mapValidationHttpError = (status?: number, _upstreamMessage?: string): string => {
    if (status === 502 || status === 503) {
        return 'Layanan validasi provider sedang mengalami gangguan. Silakan coba lagi.';
    }
    if (status === 404) {
        return 'Akun atau data tidak ditemukan. Periksa input Anda.';
    }
    if (status === 400) {
        return 'Input tidak valid. Periksa User ID, Zone ID, atau nomor HP.';
    }
    return 'Validasi gagal. Silakan coba lagi.';
};

export const parseHydratedProductVersion = (value: unknown): number | null => {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
        return null;
    }
    if (value < 0 || value > MAX_JS_SAFE_INTEGER) {
        return null;
    }
    return value;
};

export const isProductVersionMutable = (version: number | null | undefined): version is number =>
    parseHydratedProductVersion(version) !== null;

export const mutationVersionForProduct = (version: number | null | undefined): number | null =>
    parseHydratedProductVersion(version);

const mapProductsHydrationError = (reason?: HydrationRejectReason): string => {
    const status = reason?.response?.status;
    if (status === 502 || status === 503) {
        return 'Daftar produk: layanan sedang gangguan. Gunakan tombol coba lagi.';
    }
    return 'Daftar produk: gagal dimuat. Gunakan tombol coba lagi.';
};

const mapHydrationResourceError = (
    resource: Exclude<ProductHydrationResource, 'products'>,
    reason?: HydrationRejectReason,
): string => {
    const status = reason?.response?.status;
    if (status === 502 || status === 503) {
        return `${HYDRATION_RESOURCE_LABELS[resource]}: layanan sedang gangguan. Gunakan tombol coba lagi.`;
    }
    return `${HYDRATION_RESOURCE_LABELS[resource]}: gagal dimuat. Gunakan tombol coba lagi.`;
};

const extractProducts = (outcome: HydrationSettledResult): ValidationProduct[] => {
    if (outcome.status !== 'fulfilled') return [];
    const data = outcome.value.data as { items?: Array<Record<string, unknown>> } | undefined;
    return (data?.items || []).map((item) => ({
        _id: String(item._id ?? ''),
        name: String(item.name ?? ''),
        code: String(item.code ?? ''),
        status: Boolean(item.status),
        version: parseHydratedProductVersion(item.version),
    }));
};

const extractCatalog = (outcome: HydrationSettledResult): CatalogItem[] => {
    if (outcome.status !== 'fulfilled') return [];
    return (outcome.value.data as CatalogItem[]) || [];
};

const applyResourceOutcome = (
    prior: ProductHydrationState,
    resource: ProductHydrationResource,
    outcome: HydrationSettledResult | undefined,
): ProductHydrationState => {
    const resourceErrors = { ...prior.resourceErrors };
    const next: ProductHydrationState = {
        products: prior.products,
        categories: prior.categories,
        operators: prior.operators,
        productTypes: prior.productTypes,
        resourceErrors,
    };

    if (!outcome) {
        return next;
    }

    if (resource === 'products') {
        if (outcome.status === 'fulfilled') {
            next.products = extractProducts(outcome);
            delete resourceErrors.products;
        } else {
            resourceErrors.products = mapProductsHydrationError(outcome.reason);
        }
        return next;
    }

    if (resource === 'categories') {
        if (outcome.status === 'fulfilled') {
            next.categories = extractCatalog(outcome);
            delete resourceErrors.categories;
        } else {
            resourceErrors.categories = mapHydrationResourceError('categories', outcome.reason);
        }
        return next;
    }

    if (resource === 'operators') {
        if (outcome.status === 'fulfilled') {
            next.operators = extractCatalog(outcome);
            delete resourceErrors.operators;
        } else {
            resourceErrors.operators = mapHydrationResourceError('operators', outcome.reason);
        }
        return next;
    }

    if (outcome.status === 'fulfilled') {
        next.productTypes = extractCatalog(outcome);
        delete resourceErrors.productTypes;
    } else {
        resourceErrors.productTypes = mapHydrationResourceError('productTypes', outcome.reason);
    }
    return next;
};

/** Merge a full four-way settled batch onto prior hydration; rejected resources keep last-known data. */
export const applyProductHydrationSettled = (
    prior: ProductHydrationState,
    settled: HydrationSettledResult[],
): ProductHydrationState => {
    let state = prior;
    const resources: ProductHydrationResource[] = ['products', 'categories', 'operators', 'productTypes'];
    resources.forEach((resource, index) => {
        state = applyResourceOutcome(state, resource, settled[index]);
    });
    return state;
};

/** Apply one resource outcome for targeted retry; other resources and their errors are preserved. */
export const applySingleHydrationOutcome = (
    prior: ProductHydrationState,
    resource: ProductHydrationResource,
    outcome: HydrationSettledResult,
): ProductHydrationState => applyResourceOutcome(prior, resource, outcome);

/** @deprecated Use applyProductHydrationSettled(EMPTY_PRODUCT_HYDRATION_STATE, settled) for fresh loads. */
export const mergeProductHydrationSettled = (settled: HydrationSettledResult[]) =>
    applyProductHydrationSettled(EMPTY_PRODUCT_HYDRATION_STATE, settled);

export const commitProductHydrationState = (
    state: ProductHydrationState,
    setters: {
        setProducts: (value: ValidationProduct[]) => void;
        setCategories: (value: CatalogItem[]) => void;
        setOperators: (value: CatalogItem[]) => void;
        setProductTypes: (value: CatalogItem[]) => void;
        setProductResourceErrors: (value: Partial<Record<ProductHydrationResource, string>>) => void;
    },
) => {
    setters.setProducts(state.products);
    setters.setCategories(state.categories);
    setters.setOperators(state.operators);
    setters.setProductTypes(state.productTypes);
    setters.setProductResourceErrors(state.resourceErrors);
};