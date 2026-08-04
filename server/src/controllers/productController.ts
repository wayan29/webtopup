import { FastifyRequest, FastifyReply } from 'fastify';
import mongoose from 'mongoose';
import { Product, Category, Operator, ProductType } from '../models';
import { runCatalogAudit } from '../services/catalogAuditService';

const normalizeString = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const getFieldId = (value: unknown): string => {
    if (!value) return '';
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'object' && value && '_id' in value) {
        return normalizeString(String((value as { _id?: unknown })._id || ''));
    }
    return '';
};

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const getExactNameQuery = (value: string) => ({
    $regex: `^${escapeRegex(value)}$`,
    $options: 'i'
});

const buildMissingRelationFilter = (field: string) => ({
    $or: [{ [field]: { $exists: false } }, { [field]: null }]
});

const buildLegacyCategoryFilter = (categoryId?: string, categoryName?: string) => {
    const clauses: Record<string, unknown>[] = [];

    if (categoryId) {
        clauses.push({ categoryId });
    }

    if (categoryName) {
        clauses.push({ category: getExactNameQuery(categoryName) });
    }

    if (clauses.length === 0) {
        return null;
    }

    return clauses.length === 1 ? clauses[0] : { $or: clauses };
};

const buildLegacyOperatorFilter = (operatorName: string, categoryId?: string, categoryName?: string) => {
    const andClauses: Record<string, unknown>[] = [
        { brand: getExactNameQuery(operatorName) },
        buildMissingRelationFilter('operatorId')
    ];

    const categoryFilter = buildLegacyCategoryFilter(categoryId, categoryName);
    if (categoryFilter) {
        andClauses.push(categoryFilter as Record<string, unknown>);
    }

    return { $and: andClauses };
};

const normalizeNonNegativeNumber = (value: unknown, fallback = 0): number => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.max(0, parsed);
};

const normalizePrice = (
    value: unknown,
    fallback: { basic: number; gold: number; platinum: number } = { basic: 0, gold: 0, platinum: 0 }
) => {
    const price = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;

    return {
        basic: normalizeNonNegativeNumber(price.basic, fallback.basic),
        gold: normalizeNonNegativeNumber(price.gold, fallback.gold),
        platinum: normalizeNonNegativeNumber(price.platinum, fallback.platinum)
    };
};

const buildProductPayload = async (payload: any, existingProduct?: any) => {
    const name = payload.name !== undefined ? normalizeString(payload.name) : normalizeString(existingProduct?.name);
    if (!name) {
        throw new Error('PRODUCT_NAME_REQUIRED');
    }

    const code = payload.code !== undefined ? normalizeString(payload.code) : normalizeString(existingProduct?.code);
    if (!code) {
        throw new Error('PRODUCT_CODE_REQUIRED');
    }

    const categoryIdInput = payload.categoryId !== undefined
        ? getFieldId(payload.categoryId)
        : getFieldId(existingProduct?.categoryId);
    const operatorIdInput = payload.operatorId !== undefined
        ? getFieldId(payload.operatorId)
        : getFieldId(existingProduct?.operatorId);
    const productTypeIdInput = payload.productTypeId !== undefined
        ? getFieldId(payload.productTypeId)
        : getFieldId(existingProduct?.productTypeId);

    const categoryNameInput = payload.category !== undefined
        ? normalizeString(payload.category)
        : normalizeString(existingProduct?.category);
    const brandInput = payload.brand !== undefined
        ? normalizeString(payload.brand)
        : normalizeString(existingProduct?.brand);

    let category = null as any;
    let operator = null as any;
    let productType = null as any;

    if (categoryIdInput) {
        if (!mongoose.Types.ObjectId.isValid(categoryIdInput)) {
            throw new Error('INVALID_CATEGORY_ID');
        }
        category = await Category.findById(categoryIdInput).select('name status');
        if (!category) {
            throw new Error('CATEGORY_NOT_FOUND');
        }
    } else if (categoryNameInput) {
        category = await Category.findOne({ name: getExactNameQuery(categoryNameInput) }).select('name status');
    }

    if (operatorIdInput) {
        if (!mongoose.Types.ObjectId.isValid(operatorIdInput)) {
            throw new Error('INVALID_OPERATOR_ID');
        }
        operator = await Operator.findById(operatorIdInput).select('name categoryId status');
        if (!operator) {
            throw new Error('OPERATOR_NOT_FOUND');
        }
    }

    if (productTypeIdInput) {
        if (!mongoose.Types.ObjectId.isValid(productTypeIdInput)) {
            throw new Error('INVALID_PRODUCT_TYPE_ID');
        }
        productType = await ProductType.findById(productTypeIdInput).select('name categoryId operatorId status');
        if (!productType) {
            throw new Error('PRODUCT_TYPE_NOT_FOUND');
        }
    }

    if (!operator && productType) {
        operator = await Operator.findById(productType.operatorId).select('name categoryId status');
        if (!operator) {
            throw new Error('OPERATOR_NOT_FOUND');
        }
    }

    if (!category && operator) {
        category = await Category.findById(operator.categoryId).select('name status');
        if (!category) {
            throw new Error('CATEGORY_NOT_FOUND');
        }
    }

    if (!category && productType) {
        category = await Category.findById(productType.categoryId).select('name status');
        if (!category) {
            throw new Error('CATEGORY_NOT_FOUND');
        }
    }

    if (!operator && brandInput && category) {
        operator = await Operator.findOne({
            name: getExactNameQuery(brandInput),
            categoryId: category._id
        }).select('name categoryId status');
    }

    if (!operator && brandInput) {
        operator = await Operator.findOne({
            name: getExactNameQuery(brandInput)
        }).select('name categoryId status').sort({ sortOrder: 1, name: 1 });
    }

    if (!category && operator) {
        category = await Category.findById(operator.categoryId).select('name status');
        if (!category) {
            throw new Error('CATEGORY_NOT_FOUND');
        }
    }

    if (!category) {
        throw new Error('CATEGORY_REQUIRED');
    }

    if (!operator) {
        throw new Error('OPERATOR_REQUIRED');
    }

    if (!productType) {
        throw new Error('PRODUCT_TYPE_REQUIRED');
    }

    if (operator.categoryId.toString() !== category._id.toString()) {
        throw new Error('OPERATOR_CATEGORY_MISMATCH');
    }

    if (productType && productType.operatorId.toString() !== operator._id.toString()) {
        throw new Error('PRODUCT_TYPE_OPERATOR_MISMATCH');
    }

    if (productType && productType.categoryId.toString() !== category._id.toString()) {
        throw new Error('PRODUCT_TYPE_CATEGORY_MISMATCH');
    }

    const paymentTypeValue = payload.paymentType !== undefined ? payload.paymentType : existingProduct?.paymentType;
    const paymentType = paymentTypeValue || 'prabayar';
    if (!['prabayar', 'pascabayar'].includes(paymentType)) {
        throw new Error('INVALID_PAYMENT_TYPE');
    }

    const fallbackPrice = normalizePrice(existingProduct?.price);
    const price = payload.price !== undefined ? normalizePrice(payload.price, fallbackPrice) : fallbackPrice;
    const costPrice = payload.costPrice !== undefined
        ? normalizeNonNegativeNumber(payload.costPrice, existingProduct?.costPrice || 0)
        : normalizeNonNegativeNumber(existingProduct?.costPrice, 0);

    const rewardPoints = payload.rewardPoints !== undefined
        ? Math.max(0, Math.round(Number(payload.rewardPoints) || 0))
        : Math.max(0, Math.round(Number(existingProduct?.rewardPoints) || 0));

    const vendorName = payload.vendor !== undefined
        ? normalizeString(payload.vendor?.name)
        : normalizeString(existingProduct?.vendor?.name);
    const vendorSku = payload.vendor !== undefined
        ? normalizeString(payload.vendor?.sku)
        : normalizeString(existingProduct?.vendor?.sku);

    const resolvedPayload: Record<string, unknown> = {
        name,
        code,
        category: category.name,
        categoryId: category._id,
        operatorId: operator._id,
        paymentType,
        brand: operator.name,
        costPrice,
        price,
        rewardPoints,
        icon: payload.icon !== undefined ? normalizeString(payload.icon) : normalizeString(existingProduct?.icon),
        vendor: {
            name: vendorName,
            sku: vendorSku
        },
        status: payload.status !== undefined ? Boolean(payload.status) : Boolean(existingProduct?.status ?? true)
    };

    if (payload.sortOrder !== undefined) {
        resolvedPayload.sortOrder = normalizeNonNegativeNumber(payload.sortOrder, 0);
    } else if (existingProduct?.sortOrder !== undefined) {
        resolvedPayload.sortOrder = normalizeNonNegativeNumber(existingProduct.sortOrder, 0);
    }

    if (productType) {
        resolvedPayload.productTypeId = productType._id;
    } else if (existingProduct?.productTypeId !== undefined && payload.productTypeId === undefined) {
        resolvedPayload.productTypeId = existingProduct.productTypeId;
    }

    return resolvedPayload;
};

const buildVisibilityContext = async (products: any[]) => {
    const [inactiveCategories, inactiveOperators, inactiveProductTypes] = await Promise.all([
        Category.find({ status: false }).select('_id'),
        Operator.find({ status: false }).select('_id name'),
        ProductType.find({ status: false }).select('_id')
    ]);

    const inactiveCategoryIds = new Set(inactiveCategories.map(c => c._id.toString()));
    const inactiveOperatorIds = new Set(inactiveOperators.map(o => o._id.toString()));
    const inactiveOperatorNames = new Set(inactiveOperators.map(o => o.name.toLowerCase()));
    const inactiveProductTypeIds = new Set(inactiveProductTypes.map(pt => pt._id.toString()));

    return products.map((product) => {
        const productObj = product.toObject() as any;
        const visibilityIssues: string[] = [];

        const categoryId = (product.categoryId as any)?._id?.toString?.() || getFieldId(product.categoryId);
        const operatorId = (product.operatorId as any)?._id?.toString?.() || getFieldId(product.operatorId);
        const productTypeId = (product.productTypeId as any)?._id?.toString?.() || getFieldId(product.productTypeId);

        if (categoryId && inactiveCategoryIds.has(categoryId)) {
            visibilityIssues.push('Kategori nonaktif');
        }

        if (operatorId && inactiveOperatorIds.has(operatorId)) {
            visibilityIssues.push('Operator nonaktif');
        } else if (!operatorId && product.brand && inactiveOperatorNames.has(product.brand.toLowerCase())) {
            visibilityIssues.push('Operator nonaktif');
        }

        if (productTypeId && inactiveProductTypeIds.has(productTypeId)) {
            visibilityIssues.push('Jenis produk nonaktif');
        }

        productObj.canPurchase = visibilityIssues.length === 0;
        productObj.visibilityIssues = visibilityIssues;
        return productObj;
    });
};

const getCreateSuccessMessage = (product: any) => ({
    message: 'Product created',
    product
});

const getErrorMessage = (error: Error) => {
    switch (error.message) {
        case 'PRODUCT_NAME_REQUIRED':
            return 'Nama produk wajib diisi';
        case 'PRODUCT_CODE_REQUIRED':
            return 'Kode produk wajib diisi';
        case 'INVALID_CATEGORY_ID':
            return 'Kategori produk tidak valid';
        case 'INVALID_OPERATOR_ID':
            return 'Operator produk tidak valid';
        case 'INVALID_PRODUCT_TYPE_ID':
            return 'Jenis produk tidak valid';
        case 'PRODUCT_TYPE_REQUIRED':
            return 'Jenis produk wajib dipilih';
        case 'CATEGORY_NOT_FOUND':
            return 'Kategori produk tidak ditemukan';
        case 'CATEGORY_REQUIRED':
            return 'Kategori produk wajib dipilih';
        case 'OPERATOR_NOT_FOUND':
            return 'Operator produk tidak ditemukan';
        case 'OPERATOR_REQUIRED':
            return 'Operator produk wajib dipilih';
        case 'PRODUCT_TYPE_NOT_FOUND':
            return 'Jenis produk tidak ditemukan';
        case 'OPERATOR_CATEGORY_MISMATCH':
            return 'Operator tidak berada di kategori yang dipilih';
        case 'PRODUCT_TYPE_OPERATOR_MISMATCH':
            return 'Jenis produk tidak berada di operator yang dipilih';
        case 'PRODUCT_TYPE_CATEGORY_MISMATCH':
            return 'Jenis produk tidak berada di kategori yang dipilih';
        case 'INVALID_PAYMENT_TYPE':
            return 'Tipe pembayaran tidak valid';
        default:
            return null;
    }
};

export const createProduct = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const productData = request.body as any;
        const normalizedPayload = await buildProductPayload(productData);

        if (normalizedPayload.productTypeId) {
            const maxSortProduct = await Product.findOne({ productTypeId: normalizedPayload.productTypeId })
                .sort({ sortOrder: -1 })
                .select('sortOrder');
            normalizedPayload.sortOrder = (maxSortProduct?.sortOrder || 0) + 1;
        } else if (normalizedPayload.operatorId) {
            const maxSortProduct = await Product.findOne({ operatorId: normalizedPayload.operatorId })
                .sort({ sortOrder: -1 })
                .select('sortOrder');
            normalizedPayload.sortOrder = (maxSortProduct?.sortOrder || 0) + 1;
        }

        const product = await Product.create(normalizedPayload);
        return reply.status(201).send(getCreateSuccessMessage(product));
    } catch (error) {
        if ((error as any)?.code === 11000 && (error as any)?.keyPattern?.code) {
            return reply.status(409).send({ message: 'Kode produk sudah digunakan, gunakan kode unik lain', field: 'code', duplicate: (error as any)?.keyValue?.code });
        }

        const message = getErrorMessage(error as Error);
        if (message) {
            return reply.status(400).send({ message });
        }

        console.error('Create Product Error:', error);
        return reply.status(500).send({ message: 'Internal Server Error', error });
    }
};

export const getProducts = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { category, categoryId, operatorId, productTypeId, brand, search, status } = request.query as any;
        const filters: Record<string, unknown>[] = [];

        if (status === undefined) {
            filters.push({ status: true });
        } else if (status !== 'all') {
            filters.push({ status: status === 'true' });
        }

        if (search) {
            filters.push({
                $or: [
                { name: { $regex: search, $options: 'i' } },
                { code: { $regex: search, $options: 'i' } },
                { brand: { $regex: search, $options: 'i' } }
                ]
            });
        }

        const resolvedCategory = categoryId && mongoose.Types.ObjectId.isValid(String(categoryId))
            ? await Category.findById(categoryId).select('name')
            : category
                ? await Category.findOne({ name: getExactNameQuery(String(category)) }).select('name')
                : null;

        const resolvedOperator = operatorId && mongoose.Types.ObjectId.isValid(String(operatorId))
            ? await Operator.findById(operatorId).select('name categoryId')
            : brand
                ? await Operator.findOne({ name: getExactNameQuery(String(brand)) }).select('name categoryId')
                : null;

        const resolvedProductType = productTypeId && mongoose.Types.ObjectId.isValid(String(productTypeId))
            ? await ProductType.findById(productTypeId).select('name categoryId operatorId')
            : null;

        let scopedOperator = resolvedOperator;
        let scopedCategory = resolvedCategory;

        if (!scopedOperator && resolvedProductType) {
            scopedOperator = await Operator.findById(resolvedProductType.operatorId).select('name categoryId');
        }

        if (!scopedCategory && resolvedProductType) {
            scopedCategory = await Category.findById(resolvedProductType.categoryId).select('name');
        }

        if (!scopedCategory && scopedOperator?.categoryId) {
            scopedCategory = await Category.findById(scopedOperator.categoryId).select('name');
        }

        if (resolvedProductType && scopedOperator) {
            const categoryScopeId = scopedCategory?._id?.toString?.() || '';
            const categoryScopeName = scopedCategory?.name || '';

            filters.push({
                $or: [
                    { productTypeId: resolvedProductType._id },
                    {
                        $and: [
                            buildMissingRelationFilter('productTypeId'),
                            { operatorId: scopedOperator._id }
                        ]
                    },
                    {
                        $and: [
                            buildMissingRelationFilter('productTypeId'),
                            buildLegacyOperatorFilter(scopedOperator.name, categoryScopeId, categoryScopeName)
                        ]
                    }
                ]
            });
        } else if (scopedOperator) {
            const categoryScopeId = scopedCategory?._id?.toString?.() || scopedOperator.categoryId?.toString?.() || '';
            const categoryScopeName = scopedCategory?.name || '';

            filters.push({
                $or: [
                    { operatorId: scopedOperator._id },
                    buildLegacyOperatorFilter(scopedOperator.name, categoryScopeId, categoryScopeName)
                ]
            });
        } else if (brand) {
            filters.push({ brand: getExactNameQuery(String(brand)) });
        }

        if (!resolvedProductType && !scopedOperator) {
            const categoryFilter = buildLegacyCategoryFilter(
                resolvedCategory?._id?.toString?.() || (categoryId ? String(categoryId) : ''),
                resolvedCategory?.name || (category ? String(category) : '')
            );

            if (categoryFilter) {
                filters.push(categoryFilter as Record<string, unknown>);
            }
        }

        const query = filters.length === 0
            ? {}
            : filters.length === 1
                ? filters[0]
                : { $and: filters };

        const products = await Product.find(query)
            .populate('categoryId', 'name icon slug status')
            .populate('operatorId', 'name status')
            .populate('productTypeId', 'name status')
            .sort({ sortOrder: 1, createdAt: 1 });

        const productsWithPurchaseFlag = await buildVisibilityContext(products);
        return reply.send(productsWithPurchaseFlag);
    } catch (error) {
        console.error(error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const getAllProducts = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { category, categoryId, operatorId, productTypeId, brand, search, status } = request.query as any;
        const query: any = {};

        if (status && status !== 'all') {
            query.status = status === 'true';
        }
        if (category) query.category = category;
        if (categoryId) query.categoryId = categoryId;
        if (operatorId) query.operatorId = operatorId;
        if (productTypeId) query.productTypeId = productTypeId;
        if (brand) query.brand = getExactNameQuery(String(brand));
        if (search) {
            query.$or = [
                { name: { $regex: search, $options: 'i' } },
                { code: { $regex: search, $options: 'i' } },
                { brand: { $regex: search, $options: 'i' } },
                { 'vendor.sku': { $regex: search, $options: 'i' } }
            ];
        }

        const products = await Product.find(query)
            .populate('categoryId', 'name icon slug status')
            .populate('operatorId', 'name status')
            .populate('productTypeId', 'name status')
            .sort({ createdAt: -1 });

        const productsWithVisibility = await buildVisibilityContext(products);
        return reply.send(productsWithVisibility);
    } catch (error) {
        console.error(error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const getProduct = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as any;
        const product = await Product.findById(id);
        if (!product) return reply.status(404).send({ message: 'Product not found' });
        return reply.send(product);
    } catch (error) {
        console.error(error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const updateProduct = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as any;
        const updateData = request.body as any;

        const product = await Product.findById(id);
        if (!product) return reply.status(404).send({ message: 'Product not found' });

        const normalizedPayload = await buildProductPayload(updateData, product);

        product.name = normalizedPayload.name as string;
        product.code = normalizedPayload.code as string;
        product.category = normalizedPayload.category as string;
        product.categoryId = normalizedPayload.categoryId as any;
        product.operatorId = normalizedPayload.operatorId as any;
        product.productTypeId = (normalizedPayload.productTypeId ?? null) as any;
        product.paymentType = normalizedPayload.paymentType as 'prabayar' | 'pascabayar';
        product.brand = normalizedPayload.brand as string;
        product.costPrice = normalizedPayload.costPrice as number;
        product.price = normalizedPayload.price as any;
        product.rewardPoints = normalizedPayload.rewardPoints as number;
        product.icon = normalizedPayload.icon as string;
        product.vendor = normalizedPayload.vendor as any;
        product.status = normalizedPayload.status as boolean;

        if (normalizedPayload.sortOrder !== undefined) {
            product.sortOrder = normalizedPayload.sortOrder as number;
        }

        await product.save();

        const populatedProduct = await Product.findById(product._id)
            .populate('categoryId', 'name icon slug status')
            .populate('operatorId', 'name status')
            .populate('productTypeId', 'name status');

        return reply.send({ message: 'Product updated', product: populatedProduct });
    } catch (error) {
        if ((error as any)?.code === 11000 && (error as any)?.keyPattern?.code) {
            return reply.status(409).send({ message: 'Kode produk sudah digunakan, gunakan kode unik lain', field: 'code', duplicate: (error as any)?.keyValue?.code });
        }

        const message = getErrorMessage(error as Error);
        if (message) {
            return reply.status(400).send({ message });
        }

        console.error(error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const deleteProduct = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as any;
        const product = await Product.findById(id);
        if (!product) return reply.status(404).send({ message: 'Product not found' });

        if (product.status === false) {
            await product.deleteOne();
            return reply.send({ message: 'Product removed permanently', productId: id });
        }

        product.status = false;
        await product.save();
        return reply.send({ message: 'Product deactivated (soft delete)', product });
    } catch (error) {
        console.error('Delete Product Error:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const getProductsForSorting = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { categoryId, operatorId, productTypeId } = request.query as any;

        if (!categoryId && !operatorId && !productTypeId) {
            return reply.status(400).send({ message: 'Please provide categoryId, operatorId, or productTypeId' });
        }

        const query: any = {};
        if (categoryId) query.categoryId = categoryId;
        if (operatorId) query.operatorId = operatorId;
        if (productTypeId) query.productTypeId = productTypeId;

        const products = await Product.find(query)
            .select('_id code name price sortOrder status')
            .sort({ sortOrder: 1, createdAt: 1 });

        return reply.send(products);
    } catch (error) {
        console.error('Get Products For Sorting Error:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const updateSortOrder = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { products } = request.body as { products: { _id: string; sortOrder: number }[] };

        if (!products || !Array.isArray(products)) {
            return reply.status(400).send({ message: 'Products array is required' });
        }

        const bulkOps = products.map((product) => ({
            updateOne: {
                filter: { _id: product._id },
                update: { $set: { sortOrder: normalizeNonNegativeNumber(product.sortOrder, 0) } }
            }
        }));

        await Product.bulkWrite(bulkOps);

        return reply.send({ success: true, message: `${products.length} products updated` });
    } catch (error) {
        console.error('Update Sort Order Error:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const sortProductsByPrice = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { categoryId, operatorId, productTypeId, order = 'asc' } = request.body as any;

        if (!categoryId && !operatorId && !productTypeId) {
            return reply.status(400).send({ message: 'Please provide categoryId, operatorId, or productTypeId' });
        }

        const query: any = {};
        if (categoryId) query.categoryId = categoryId;
        if (operatorId) query.operatorId = operatorId;
        if (productTypeId) query.productTypeId = productTypeId;

        const products = await Product.find(query)
            .select('_id price.basic')
            .sort({ 'price.basic': order === 'asc' ? 1 : -1 });

        const bulkOps = products.map((product, index) => ({
            updateOne: {
                filter: { _id: product._id },
                update: { $set: { sortOrder: index + 1 } }
            }
        }));

        await Product.bulkWrite(bulkOps);

        return reply.send({ success: true, message: `${products.length} products sorted by price` });
    } catch (error) {
        console.error('Sort Products By Price Error:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const getCatalogAuditReport = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const query = request.query as { limit?: string };
        const limit = Math.max(1, Math.min(100, Number(query.limit) || 15));
        const report = await runCatalogAudit(limit);

        return reply.send(report);
    } catch (error) {
        console.error('Get Catalog Audit Report Error:', error);
        return reply.status(500).send({ message: 'Gagal memuat audit katalog' });
    }
};
