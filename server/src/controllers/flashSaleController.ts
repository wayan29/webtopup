import { FastifyRequest, FastifyReply } from 'fastify';
import mongoose from 'mongoose';
import FlashSale from '../models/FlashSale';
import { Product } from '../models';

type DiscountType = 'percentage' | 'fixed';

type FlashSaleProductPayload = {
    productId: string;
    discountType: DiscountType;
    discountValue: number;
    stock: number;
    soldCount?: number;
};

type FlashSalePayload = {
    name?: string;
    description?: string;
    startDate?: string;
    endDate?: string;
    products?: FlashSaleProductPayload[];
    isActive?: boolean;
    banner?: string;
};

type PopulatedFlashSaleProduct = {
    productRefId?: string;
    productId?: {
        _id: mongoose.Types.ObjectId | string;
        name?: string;
        code?: string;
        price?: { basic?: number };
        icon?: string;
        status?: boolean;
        categoryId?: mongoose.Types.ObjectId | string;
        operatorId?: mongoose.Types.ObjectId | string;
        productTypeId?: mongoose.Types.ObjectId | string;
        costPrice?: number;
    } | null;
    discountType: DiscountType;
    discountValue: number;
    stock: number;
    soldCount: number;
};

type PopulatedFlashSale = {
    _id: mongoose.Types.ObjectId | string;
    name: string;
    description?: string;
    startDate: Date | string;
    endDate: Date | string;
    products: PopulatedFlashSaleProduct[];
    isActive: boolean;
    banner?: string;
    createdAt?: Date | string;
};

type NormalizedFlashSaleProduct = {
    productId: mongoose.Types.ObjectId;
    discountType: DiscountType;
    discountValue: number;
    stock: number;
    soldCount: number;
};

type FlashSaleStatusKey = 'inactive' | 'upcoming' | 'live' | 'ended';

const flashSaleStatusLabels: Record<FlashSaleStatusKey, string> = {
    inactive: 'Nonaktif',
    upcoming: 'Akan Datang',
    live: 'Berlangsung',
    ended: 'Berakhir'
};

class HttpError extends Error {
    statusCode: number;

    constructor(statusCode: number, message: string) {
        super(message);
        this.statusCode = statusCode;
    }
}

const isDiscountType = (value: unknown): value is DiscountType =>
    value === 'percentage' || value === 'fixed';

const toDate = (value: Date | string | undefined, fieldLabel: string): Date => {
    if (!value) {
        throw new HttpError(400, `${fieldLabel} wajib diisi`);
    }

    const parsed = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        throw new HttpError(400, `${fieldLabel} tidak valid`);
    }

    return parsed;
};

const toProductIdString = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object' && 'toString' in value) {
        return value.toString();
    }
    return '';
};

const calculateFlashPrice = (
    basePrice: number,
    discountType: DiscountType,
    discountValue: number
) => {
    if (discountType === 'percentage') {
        return Math.max(0, Math.round(basePrice - (basePrice * discountValue) / 100));
    }

    return Math.max(0, basePrice - discountValue);
};

const getFlashSaleStatus = (
    sale: Pick<PopulatedFlashSale, 'isActive' | 'startDate' | 'endDate'>,
    now = new Date()
): FlashSaleStatusKey => {
    const start = new Date(sale.startDate);
    const end = new Date(sale.endDate);

    if (!sale.isActive) return 'inactive';
    if (now < start) return 'upcoming';
    if (now > end) return 'ended';
    return 'live';
};

const timeRangesOverlap = (
    startA: Date | string,
    endA: Date | string,
    startB: Date | string,
    endB: Date | string
) => {
    return new Date(startA) < new Date(endB) && new Date(endA) > new Date(startB);
};

const formatProductLabel = (product: { name?: string; code?: string }, fallbackId: string) => {
    const name = product.name?.trim();
    const code = product.code?.trim();

    if (name && code) return `${name} (${code})`;
    if (name) return name;
    if (code) return code;
    return `Produk ${fallbackId.slice(-6)}`;
};

const attachProductSnapshots = async (flashSales: any[]) => {
    const productIds = [
        ...new Set(
            flashSales.flatMap((sale) =>
                sale.products
                    .map((item: any) => toProductIdString(item.productId))
                    .filter(Boolean)
            )
        )
    ];

    if (productIds.length === 0) {
        return flashSales.map((sale) => ({
            ...sale,
            products: sale.products.map((item: any) => ({
                ...item,
                productRefId: toProductIdString(item.productId),
                productId: null
            }))
        }));
    }

    const productDocs = await Product.find({ _id: { $in: productIds } })
        .select('name code price icon status costPrice')
        .lean();

    const productMap = new Map(
        productDocs.map((product: any) => [product._id.toString(), product])
    );

    return flashSales.map((sale) => ({
        ...sale,
        products: sale.products.map((item: any) => {
            const productRefId = toProductIdString(item.productId);
            return {
                ...item,
                productRefId,
                productId: productMap.get(productRefId) ?? null
            };
        })
    }));
};

const ensureNoActiveOverlap = async ({
    products,
    startDate,
    endDate,
    excludeFlashSaleId
}: {
    products: NormalizedFlashSaleProduct[];
    startDate: Date;
    endDate: Date;
    excludeFlashSaleId?: string;
}) => {
    if (products.length === 0) return;

    const productIds = products.map((product) => product.productId);
    const overlapQuery: Record<string, unknown> = {
        isActive: true,
        startDate: { $lt: endDate },
        endDate: { $gt: startDate },
        'products.productId': { $in: productIds }
    };

    if (excludeFlashSaleId) {
        overlapQuery._id = { $ne: excludeFlashSaleId };
    }

    const overlappingSales = await FlashSale.find(overlapQuery)
        .populate('products.productId', 'name code')
        .select('name startDate endDate products.productId')
        .lean();

    if (overlappingSales.length === 0) return;

    const requestedIdSet = new Set(productIds.map((value) => value.toString()));
    const conflicts: string[] = [];

    overlappingSales.forEach((sale: any) => {
        sale.products.forEach((item: any) => {
            const productId = toProductIdString(item.productId?._id ?? item.productId);
            if (!requestedIdSet.has(productId)) return;

            const productLabel = formatProductLabel(item.productId ?? {}, productId);
            conflicts.push(`${productLabel} di "${sale.name}"`);
        });
    });

    if (conflicts.length > 0) {
        throw new HttpError(
            400,
            `Beberapa produk sudah dipakai di flash sale aktif lain pada rentang waktu yang overlap: ${[...new Set(conflicts)].slice(0, 4).join(', ')}`
        );
    }
};

const validateFlashSaleProducts = async ({
    products,
    startDate,
    endDate,
    isActive,
    excludeFlashSaleId
}: {
    products: FlashSaleProductPayload[];
    startDate: Date;
    endDate: Date;
    isActive: boolean;
    excludeFlashSaleId?: string;
}) => {
    if (!Array.isArray(products)) {
        throw new HttpError(400, 'Format produk flash sale tidak valid');
    }

    if (products.length === 0) {
        return [] as NormalizedFlashSaleProduct[];
    }

    const duplicateCheck = new Set<string>();
    products.forEach((product, index) => {
        const productId = toProductIdString(product.productId);
        if (!mongoose.Types.ObjectId.isValid(productId)) {
            throw new HttpError(400, `Produk pada item #${index + 1} tidak valid`);
        }

        if (duplicateCheck.has(productId)) {
            throw new HttpError(400, 'Satu produk tidak boleh muncul lebih dari sekali dalam flash sale yang sama');
        }

        duplicateCheck.add(productId);
    });

    const productDocs = await Product.find({
        _id: { $in: [...duplicateCheck] }
    })
        .select('name code price status costPrice')
        .lean();

    if (productDocs.length !== duplicateCheck.size) {
        throw new HttpError(400, 'Ada produk yang tidak ditemukan');
    }

    const productMap = new Map(
        productDocs.map((product: any) => [product._id.toString(), product])
    );

    const normalizedProducts = products.map((item, index) => {
        const productId = toProductIdString(item.productId);
        const product = productMap.get(productId);

        if (!product) {
            throw new HttpError(400, `Produk pada item #${index + 1} tidak ditemukan`);
        }

        if (!product.status) {
            throw new HttpError(400, `${product.name} sedang nonaktif dan tidak bisa dipakai di flash sale`);
        }

        if (!isDiscountType(item.discountType)) {
            throw new HttpError(400, `Jenis diskon untuk ${product.name} tidak valid`);
        }

        const basePrice = Number(product.price?.basic ?? 0);
        const costPrice = Number(product.costPrice ?? 0);
        const discountValue = Number(item.discountValue);
        const stock = Number(item.stock);
        const soldCount = Number(item.soldCount ?? 0);

        if (!Number.isFinite(basePrice) || basePrice <= 0) {
            throw new HttpError(400, `Harga dasar ${product.name} tidak valid`);
        }

        if (!Number.isFinite(discountValue) || discountValue <= 0) {
            throw new HttpError(400, `Diskon ${product.name} harus lebih besar dari 0`);
        }

        if (!Number.isInteger(stock) || stock < 1) {
            throw new HttpError(400, `Stok flash sale ${product.name} minimal 1`);
        }

        if (!Number.isInteger(soldCount) || soldCount < 0) {
            throw new HttpError(400, `Jumlah terjual ${product.name} tidak valid`);
        }

        if (soldCount > stock) {
            throw new HttpError(400, `Jumlah terjual ${product.name} tidak boleh melebihi stok`);
        }

        if (item.discountType === 'percentage' && discountValue > 100) {
            throw new HttpError(400, `Diskon persentase ${product.name} maksimal 100%`);
        }

        if (item.discountType === 'fixed' && discountValue > basePrice) {
            throw new HttpError(400, `Potongan tetap ${product.name} tidak boleh melebihi harga normal`);
        }

        const flashPrice = calculateFlashPrice(basePrice, item.discountType, discountValue);
        if (flashPrice >= basePrice) {
            throw new HttpError(400, `${product.name} harus punya harga promo yang lebih rendah dari harga normal`);
        }
        if (costPrice > 0 && flashPrice < costPrice) {
            throw new HttpError(400, `Harga promo ${product.name} tidak boleh di bawah modal`);
        }

        return {
            productId: new mongoose.Types.ObjectId(productId),
            discountType: item.discountType,
            discountValue,
            stock,
            soldCount
        };
    });

    if (isActive) {
        await ensureNoActiveOverlap({
            products: normalizedProducts,
            startDate,
            endDate,
            excludeFlashSaleId
        });
    }

    return normalizedProducts;
};

const sanitizeFlashSalePayload = async ({
    current,
    payload,
    requireIdentityFields
}: {
    current?: any;
    payload: FlashSalePayload;
    requireIdentityFields: boolean;
}) => {
    const nameInput = payload.name ?? current?.name;
    const startInput = payload.startDate ?? current?.startDate;
    const endInput = payload.endDate ?? current?.endDate;

    const name = typeof nameInput === 'string' ? nameInput.trim() : '';
    if (!name && requireIdentityFields) {
        throw new HttpError(400, 'Nama flash sale wajib diisi');
    }
    if (!name) {
        throw new HttpError(400, 'Nama flash sale wajib diisi');
    }

    const startDate = toDate(startInput, 'Tanggal mulai');
    const endDate = toDate(endInput, 'Tanggal selesai');

    if (endDate <= startDate) {
        throw new HttpError(400, 'Tanggal selesai harus setelah tanggal mulai');
    }

    const isActive = payload.isActive ?? current?.isActive ?? true;
    const rawProducts =
        payload.products ??
        current?.products?.map((item: any) => ({
            productId: toProductIdString(item.productId?._id ?? item.productId),
            discountType: item.discountType,
            discountValue: item.discountValue,
            stock: item.stock,
            soldCount: item.soldCount
        })) ??
        [];

    const products = await validateFlashSaleProducts({
        products: rawProducts,
        startDate,
        endDate,
        isActive,
        excludeFlashSaleId: current?._id?.toString()
    });

    return {
        name,
        description: typeof (payload.description ?? current?.description) === 'string'
            ? (payload.description ?? current?.description ?? '').trim()
            : '',
        startDate,
        endDate,
        products,
        isActive,
        banner: typeof (payload.banner ?? current?.banner) === 'string'
            ? (payload.banner ?? current?.banner ?? '').trim()
            : ''
    };
};

const enrichFlashSalesForAdmin = (flashSales: PopulatedFlashSale[]) => {
    const now = new Date();

    const overlapMap = new Map<string, Map<string, Set<string>>>();
    const activeSales = flashSales.filter((sale) => sale.isActive);

    for (let index = 0; index < activeSales.length; index += 1) {
        for (let compareIndex = index + 1; compareIndex < activeSales.length; compareIndex += 1) {
            const currentSale = activeSales[index];
            const compareSale = activeSales[compareIndex];

            if (!timeRangesOverlap(currentSale.startDate, currentSale.endDate, compareSale.startDate, compareSale.endDate)) {
                continue;
            }

            const currentProducts = new Map(
                currentSale.products
                    .filter((item) => item.productId || item.productRefId)
                    .map((item) => [
                        item.productRefId ?? toProductIdString(item.productId?._id),
                        formatProductLabel(item.productId ?? {}, item.productRefId ?? toProductIdString(item.productId?._id))
                    ])
            );

            compareSale.products
                .filter((item) => item.productId || item.productRefId)
                .forEach((item) => {
                    const productId = item.productRefId ?? toProductIdString(item.productId?._id);
                    if (!currentProducts.has(productId)) return;

                    const currentSaleId = currentSale._id.toString();
                    const compareSaleId = compareSale._id.toString();
                    const productLabel = currentProducts.get(productId) ?? formatProductLabel(item.productId ?? {}, productId);

                    if (!overlapMap.has(currentSaleId)) overlapMap.set(currentSaleId, new Map());
                    if (!overlapMap.has(compareSaleId)) overlapMap.set(compareSaleId, new Map());

                    const currentSaleProducts = overlapMap.get(currentSaleId)!;
                    const compareSaleProducts = overlapMap.get(compareSaleId)!;

                    if (!currentSaleProducts.has(productId)) currentSaleProducts.set(productId, new Set());
                    if (!compareSaleProducts.has(productId)) compareSaleProducts.set(productId, new Set());

                    currentSaleProducts.get(productId)!.add(`${productLabel} di "${compareSale.name}"`);
                    compareSaleProducts.get(productId)!.add(`${productLabel} di "${currentSale.name}"`);
                });
        }
    }

    return flashSales.map((sale) => {
        const statusKey = getFlashSaleStatus(sale, now);
        const summary = sale.products.reduce(
            (accumulator, item) => {
                const remainingStock = Math.max((item.stock ?? 0) - (item.soldCount ?? 0), 0);
                const product = item.productId;

                accumulator.productCount += 1;
                accumulator.totalStock += item.stock ?? 0;
                accumulator.soldCount += item.soldCount ?? 0;
                accumulator.remainingStock += remainingStock;

                if (remainingStock <= 0) {
                    accumulator.soldOutCount += 1;
                }

                if (!product) {
                    accumulator.missingProductCount += 1;
                    return accumulator;
                }

                if (product.status === false) {
                    accumulator.inactiveProductCount += 1;
                }

                const basePrice = Number(product.price?.basic ?? 0);
                const flashPrice = calculateFlashPrice(basePrice, item.discountType, item.discountValue);
                if (!Number.isFinite(basePrice) || basePrice <= 0 || flashPrice >= basePrice) {
                    accumulator.pricingIssueCount += 1;
                }

                if (remainingStock > 0 && remainingStock <= 5) {
                    accumulator.lowStockCount += 1;
                }

                return accumulator;
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
                pricingIssueCount: 0
            }
        );

        const overlaps = overlapMap.get(sale._id.toString());
        const overlappingProducts = overlaps
            ? [...overlaps.entries()].map(([productId, conflictSet]) => ({
                productId,
                detail: [...conflictSet]
            }))
            : [];

        const canDelete = statusKey !== 'live';

        return {
            ...sale,
            statusKey,
            statusLabel: flashSaleStatusLabels[statusKey],
            productCount: summary.productCount,
            summary: {
                ...summary,
                overlapCount: overlappingProducts.length
            },
            overlappingProducts,
            canDelete,
            deleteBlockedReason: canDelete
                ? ''
                : 'Flash sale yang sedang berlangsung harus dinonaktifkan atau tunggu sampai selesai sebelum dihapus.',
            hasIssues:
                summary.missingProductCount > 0 ||
                summary.inactiveProductCount > 0 ||
                summary.pricingIssueCount > 0 ||
                overlappingProducts.length > 0
        };
    });
};

const handleControllerError = (
    reply: FastifyReply,
    context: string,
    error: unknown
) => {
    console.error(`${context}:`, error);

    if (error instanceof HttpError) {
        return reply.status(error.statusCode).send({ message: error.message });
    }

    return reply.status(500).send({ message: 'Internal Server Error' });
};

const isEntityActive = (entity: any) => {
    if (!entity) {
        return false;
    }

    if (typeof entity.status === 'boolean') {
        return entity.status;
    }

    if (typeof entity.isActive === 'boolean') {
        return entity.isActive;
    }

    return true;
};

// Public - Get active flash sales
export const getActiveFlashSales = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const now = new Date();
        const flashSales = await FlashSale.find({
            isActive: true,
            startDate: { $lte: now },
            endDate: { $gte: now }
        })
            .populate({
                path: 'products.productId',
                select: 'name code price icon status categoryId operatorId productTypeId',
                populate: [
                    { path: 'categoryId', select: 'name slug status isActive' },
                    { path: 'operatorId', select: 'name slug icon status' },
                    { path: 'productTypeId', select: 'name slug status' }
                ]
            })
            .sort({ startDate: 1 })
            .lean();

        const sanitizedSales = flashSales
            .map((sale: any) => ({
                ...sale,
                products: sale.products.filter((item: any) => {
                    const product = item.productId;

                    if (!product || product.status === false) {
                        return false;
                    }

                    if (!product.operatorId || !product.productTypeId) {
                        return false;
                    }

                    return (
                        isEntityActive(product.categoryId) &&
                        isEntityActive(product.operatorId) &&
                        isEntityActive(product.productTypeId)
                    );
                })
            }))
            .filter((sale: any) => sale.products.length > 0);

        return reply.send(sanitizedSales);
    } catch (error) {
        return handleControllerError(reply, 'Get active flash sales error', error);
    }
};

// Admin - Get all flash sales
export const getAllFlashSales = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const flashSales = await FlashSale.find()
            .sort({ createdAt: -1 })
            .lean();

        const flashSalesWithProducts = await attachProductSnapshots(flashSales);

        return reply.send(enrichFlashSalesForAdmin(flashSalesWithProducts as unknown as PopulatedFlashSale[]));
    } catch (error) {
        return handleControllerError(reply, 'Get all flash sales error', error);
    }
};

// Admin - Get single flash sale
export const getFlashSale = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };
        const flashSale = await FlashSale.findById(id)
            .populate('products.productId', 'name code price icon costPrice status')
            .lean();

        if (!flashSale) {
            return reply.status(404).send({ message: 'Flash Sale not found' });
        }

        return reply.send(flashSale);
    } catch (error) {
        return handleControllerError(reply, 'Get flash sale error', error);
    }
};

// Admin - Create flash sale
export const createFlashSale = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const payload = request.body as FlashSalePayload;
        const sanitized = await sanitizeFlashSalePayload({
            payload,
            requireIdentityFields: true
        });

        const flashSale = await FlashSale.create(sanitized);

        return reply.status(201).send({
            message: 'Flash Sale created',
            flashSale
        });
    } catch (error) {
        return handleControllerError(reply, 'Create flash sale error', error);
    }
};

// Admin - Update flash sale
export const updateFlashSale = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };
        const payload = request.body as FlashSalePayload;

        const flashSale = await FlashSale.findById(id);
        if (!flashSale) {
            return reply.status(404).send({ message: 'Flash Sale not found' });
        }

        const updatesProducts = Object.prototype.hasOwnProperty.call(payload, 'products');
        const activatesSale = payload.isActive === true && flashSale.isActive !== true;
        const requiresProductValidation = updatesProducts || activatesSale;

        if (requiresProductValidation) {
            const sanitized = await sanitizeFlashSalePayload({
                current: flashSale.toObject(),
                payload,
                requireIdentityFields: false
            });

            flashSale.name = sanitized.name;
            flashSale.description = sanitized.description;
            flashSale.startDate = sanitized.startDate;
            flashSale.endDate = sanitized.endDate;
            flashSale.products = sanitized.products as any;
            flashSale.isActive = sanitized.isActive;
            flashSale.banner = sanitized.banner;
        } else {
            if (typeof payload.name === 'string') flashSale.name = payload.name.trim();
            if (typeof payload.description === 'string') flashSale.description = payload.description.trim();
            if (typeof payload.banner === 'string') flashSale.banner = payload.banner.trim();
            if (payload.startDate !== undefined) flashSale.startDate = toDate(payload.startDate, 'Tanggal mulai');
            if (payload.endDate !== undefined) flashSale.endDate = toDate(payload.endDate, 'Tanggal selesai');
            if (payload.isActive !== undefined) flashSale.isActive = Boolean(payload.isActive);
            if (flashSale.endDate <= flashSale.startDate) {
                throw new HttpError(400, 'Tanggal selesai harus setelah tanggal mulai');
            }
        }

        await flashSale.save();

        return reply.send({
            message: 'Flash Sale updated',
            flashSale
        });
    } catch (error) {
        return handleControllerError(reply, 'Update flash sale error', error);
    }
};

// Admin - Delete flash sale
export const deleteFlashSale = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };

        const flashSale = await FlashSale.findById(id);
        if (!flashSale) {
            return reply.status(404).send({ message: 'Flash Sale not found' });
        }

        const statusKey = getFlashSaleStatus(flashSale as any);
        if (statusKey === 'live') {
            throw new HttpError(
                400,
                'Flash sale yang sedang berlangsung tidak bisa dihapus. Nonaktifkan dulu atau tunggu sampai selesai.'
            );
        }

        await flashSale.deleteOne();

        return reply.send({ message: 'Flash Sale deleted' });
    } catch (error) {
        return handleControllerError(reply, 'Delete flash sale error', error);
    }
};

// Admin - Add product to flash sale
export const addProductToFlashSale = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };
        const payload = request.body as FlashSaleProductPayload;

        const flashSale = await FlashSale.findById(id);
        if (!flashSale) {
            return reply.status(404).send({ message: 'Flash Sale not found' });
        }

        const nextProducts = [
            ...flashSale.products.map((item: any) => ({
                productId: toProductIdString(item.productId),
                discountType: item.discountType,
                discountValue: item.discountValue,
                stock: item.stock,
                soldCount: item.soldCount
            })),
            payload
        ];

        const normalizedProducts = await validateFlashSaleProducts({
            products: nextProducts,
            startDate: flashSale.startDate,
            endDate: flashSale.endDate,
            isActive: flashSale.isActive,
            excludeFlashSaleId: flashSale._id.toString()
        });

        flashSale.products = normalizedProducts as any;
        await flashSale.save();

        return reply.send({
            message: 'Product added to flash sale',
            flashSale
        });
    } catch (error) {
        return handleControllerError(reply, 'Add product to flash sale error', error);
    }
};

// Admin - Remove product from flash sale
export const removeProductFromFlashSale = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { id, productId } = request.params as { id: string; productId: string };

        const flashSale = await FlashSale.findById(id);
        if (!flashSale) {
            return reply.status(404).send({ message: 'Flash Sale not found' });
        }

        const statusKey = getFlashSaleStatus(flashSale as any);
        if (statusKey === 'live') {
            throw new HttpError(400, 'Produk tidak bisa dihapus saat flash sale sedang berlangsung');
        }

        const productToRemove = flashSale.products.find(
            (product) => product.productId.toString() === productId
        );
        if (!productToRemove) {
            throw new HttpError(404, 'Produk tidak ditemukan di flash sale');
        }
        if ((productToRemove.soldCount ?? 0) > 0) {
            throw new HttpError(400, 'Produk sudah memiliki penjualan promo dan tidak bisa dihapus');
        }

        flashSale.products = flashSale.products.filter(
            (product) => product.productId.toString() !== productId
        );

        await flashSale.save();

        return reply.send({
            message: 'Product removed from flash sale',
            flashSale
        });
    } catch (error) {
        return handleControllerError(reply, 'Remove product from flash sale error', error);
    }
};

// Public - Get flash sale price for product
export const getFlashSalePrice = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { productId } = request.params as { productId: string };
        const now = new Date();

        const flashSale = await FlashSale.findOne({
            isActive: true,
            startDate: { $lte: now },
            endDate: { $gte: now },
            'products.productId': productId
        }).lean();

        if (!flashSale) {
            return reply.send({ hasFlashSale: false });
        }

        const flashProduct = flashSale.products.find(
            (product) => product.productId.toString() === productId
        );

        if (!flashProduct || flashProduct.soldCount >= flashProduct.stock) {
            return reply.send({ hasFlashSale: false });
        }

        const product = await Product.findById(productId).lean();
        if (!product || !product.status) {
            return reply.send({ hasFlashSale: false });
        }

        const flashPrice = calculateFlashPrice(
            product.price.basic,
            flashProduct.discountType,
            flashProduct.discountValue
        );

        return reply.send({
            hasFlashSale: true,
            flashSaleId: flashSale._id,
            flashSaleName: flashSale.name,
            originalPrice: product.price.basic,
            flashPrice,
            discountType: flashProduct.discountType,
            discountValue: flashProduct.discountValue,
            stock: flashProduct.stock,
            soldCount: flashProduct.soldCount,
            remainingStock: flashProduct.stock - flashProduct.soldCount,
            endDate: flashSale.endDate
        });
    } catch (error) {
        return handleControllerError(reply, 'Get flash sale price error', error);
    }
};
