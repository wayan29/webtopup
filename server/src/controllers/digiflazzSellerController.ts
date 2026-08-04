import { FastifyReply, FastifyRequest } from 'fastify';
import mongoose from 'mongoose';
import { Product } from '../models';
import DigiflazzSellerOrder from '../models/DigiflazzSellerOrder';
import DigiflazzSellerProductMap from '../models/DigiflazzSellerProductMap';
import { generateRefId } from '../services/idGeneratorService';
import { getRequestClientIp } from '../utils/requestIp';
import {
    buildDigiflazzSellerErrorResponse,
    buildDigiflazzSellerResponse,
    DIGIFLAZZ_SELLER_HIGH_CALLBACK_ATTEMPT_THRESHOLD,
    getDigiflazzSellerConfig,
    getDigiflazzSellerCallbackDueRetryQuery,
    getDigiflazzSellerEffectiveMargin,
    getDigiflazzSellerRecommendedPrice,
    getDigiflazzSellerRecentLogs,
    getDigiflazzSellerRecentOrders,
    getDigiflazzSellerRetryQueueHealth,
    logDigiflazzSellerEvent,
    maskDigiflazzSellerApiKey,
    saveDigiflazzSellerConfig,
    saveDigiflazzSellerRetryQueueHealth,
    sendDigiflazzSellerCallback,
    syncDigiflazzSellerProductMapping,
    updateDigiflazzSellerOrderStatus,
    verifyDigiflazzSellerRequest
} from '../services/digiflazzSellerService';
import vendorService from '../services/vendorService';

const normalizeText = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const toPositiveInt = (value: unknown, fallback: number, max: number) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return fallback;
    }

    return Math.min(Math.floor(parsed), max);
};

const toNonNegativeNumber = (value: unknown, fallback = 0) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return fallback;
    }

    return Math.round(parsed);
};

const getClientIP = (request: FastifyRequest) => getRequestClientIp(request);

const isValidPulsaCode = (value: string) => /^[a-z0-9._-]+$/.test(value);
const isValidTarget = (value: string) => /^[0-9]{5,20}$/.test(value);
const DIGIFLAZZ_SELLER_ORDER_EXPORT_LIMIT = 5000;
const isDuplicateKeyError = (error: unknown) => {
    if (!error || typeof error !== 'object') {
        return false;
    }

    return (error as { code?: number }).code === 11000;
};

type DigiflazzSellerRequestPayload = {
    username?: string;
    commands?: string;
    ref_id?: string;
    hp?: string;
    pulsa_code?: string;
    price?: number | string;
    sign?: string;
};

type DigiflazzSellerAdminOrdersQuery = {
    page?: string | number;
    limit?: string | number;
    search?: string;
    status?: string;
    callback?: string;
    startDate?: string;
    endDate?: string;
};

type DigiflazzSellerRetryRequestBody = {
    limit?: number | string;
};

type DigiflazzSellerRetrySource = 'admin' | 'scheduler';

const parseDateBoundary = (value: unknown, endOfDay = false) => {
    const text = normalizeText(value);
    if (!text) {
        return null;
    }

    const date = new Date(`${text}${endOfDay ? 'T23:59:59.999' : 'T00:00:00.000'}`);
    if (Number.isNaN(date.getTime())) {
        throw new Error('INVALID_DATE');
    }

    return date;
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const csvEscape = (value: unknown) => {
    const text = value === null || value === undefined ? '' : String(value);
    return `"${text.replace(/"/g, '""')}"`;
};

const formatCsvDate = (value: unknown) => {
    if (!value) return '';
    const date = new Date(value as string | Date);
    if (Number.isNaN(date.getTime())) return '';
    return date.toISOString();
};

const getSellerCallbackPendingQuery = () => ({
    $or: [
        { callbackRequired: true },
        {
            $and: [
                { status: { $ne: 'pending' } },
                { callbackDeliveredAt: null },
                { callbackAttemptCount: { $lte: 0 } },
                { callbackLastMessage: { $in: ['', null] } }
            ]
        }
    ]
});

const sellerCallbackPendingSummaryExpression = {
    $or: [
        { $eq: ['$callbackRequired', true] },
        {
            $and: [
                { $ne: ['$status', 'pending'] },
                { $eq: [{ $ifNull: ['$callbackDeliveredAt', null] }, null] },
                { $lte: [{ $ifNull: ['$callbackAttemptCount', 0] }, 0] },
                { $eq: [{ $ifNull: ['$callbackLastMessage', ''] }, ''] }
            ]
        }
    ]
};

const getSellerOrderSummary = async () => {
    const now = new Date();
    const summary = await DigiflazzSellerOrder.aggregate([
        {
            $group: {
                _id: null,
                total: { $sum: 1 },
                pending: {
                    $sum: {
                        $cond: [{ $eq: ['$status', 'pending'] }, 1, 0]
                    }
                },
                callbackPending: {
                    $sum: {
                        $cond: [sellerCallbackPendingSummaryExpression, 1, 0]
                    }
                },
                callbackDueRetry: {
                    $sum: {
                        $cond: [
                            {
                                $and: [
                                    { $eq: ['$callbackRequired', true] },
                                    { $ne: ['$status', 'pending'] },
                                    {
                                        $or: [
                                            { $eq: [{ $ifNull: ['$callbackNextRetryAt', null] }, null] },
                                            { $lte: ['$callbackNextRetryAt', now] }
                                        ]
                                    }
                                ]
                            },
                            1,
                            0
                        ]
                    }
                },
                callbackHighAttempt: {
                    $sum: {
                        $cond: [
                            {
                                $and: [
                                    { $eq: ['$callbackRequired', true] },
                                    { $gte: [{ $ifNull: ['$callbackAttemptCount', 0] }, DIGIFLAZZ_SELLER_HIGH_CALLBACK_ATTEMPT_THRESHOLD] }
                                ]
                            },
                            1,
                            0
                        ]
                    }
                }
            }
        }
    ]);

    const row = summary[0] || { total: 0, pending: 0, callbackPending: 0, callbackDueRetry: 0, callbackHighAttempt: 0 };

    return {
        total: Number(row.total || 0),
        pending: Number(row.pending || 0),
        callbackPending: Number(row.callbackPending || 0),
        callbackDueRetry: Number(row.callbackDueRetry || 0),
        callbackHighAttempt: Number(row.callbackHighAttempt || 0)
    };
};

const replyWithExistingSellerOrder = async (
    reply: FastifyReply,
    config: Awaited<ReturnType<typeof getDigiflazzSellerConfig>>,
    requestIp: string,
    body: Record<string, unknown>,
    refId: string
) => {
    const existingOrder = await DigiflazzSellerOrder.findOne({ refId });
    if (!existingOrder) {
        return null;
    }

    if (existingOrder.status === 'pending' && existingOrder.vendorName) {
        try {
            const vendorStatus = await vendorService.checkStatus(
                existingOrder.trId,
                existingOrder.vendorTrxId,
                existingOrder.vendorName,
                existingOrder.pulsaCode,
                existingOrder.target
            );

            await updateDigiflazzSellerOrderStatus(existingOrder, {
                status: vendorStatus.status,
                message: vendorStatus.message,
                sn: vendorStatus.sn
            });
        } catch (statusError) {
            console.error('Failed to poll vendor status for Digiflazz Seller order:', statusError);
        }
    }

    const latestOrder = await DigiflazzSellerOrder.findById(existingOrder._id);
    const payload = buildDigiflazzSellerResponse({
        refId: latestOrder?.refId || existingOrder.refId,
        trId: latestOrder?.trId || existingOrder.trId,
        pulsaCode: latestOrder?.pulsaCode || existingOrder.pulsaCode,
        target: latestOrder?.target || existingOrder.target,
        price: latestOrder?.digiflazzPrice || existingOrder.digiflazzPrice,
        status: latestOrder?.status || existingOrder.status,
        rc: latestOrder?.rc || existingOrder.rc,
        message: latestOrder?.message || existingOrder.message,
        sn: latestOrder?.sn || existingOrder.sn
    }, config.reportedBalance);

    await logDigiflazzSellerEvent({
        event: 'request',
        refId,
        status: latestOrder?.status || existingOrder.status,
        message: 'Status order dikembalikan dari data existing',
        verified: true,
        requestIp,
        raw: body
    });

    return reply.send(payload);
};

export const getDigiflazzSellerSettings = async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
        const [config, totalMappings, activeMappings, orderSummary, retryQueueHealth] = await Promise.all([
            getDigiflazzSellerConfig(),
            DigiflazzSellerProductMap.countDocuments({}),
            DigiflazzSellerProductMap.countDocuments({ isActive: true }),
            getSellerOrderSummary(),
            getDigiflazzSellerRetryQueueHealth()
        ]);

        const configured = Boolean(config.username && config.apiKey);
        const hasPublicBaseUrl = Boolean(config.publicBaseUrl);

        return reply.send({
            configured,
            ready: configured && hasPublicBaseUrl && activeMappings > 0,
            username: config.username,
            apiKeyMasked: maskDigiflazzSellerApiKey(config.apiKey),
            publicBaseUrl: config.publicBaseUrl,
            digiflazzCallbackUrl: config.digiflazzCallbackUrl,
            serverIp: config.serverIp,
            reportedBalance: config.reportedBalance,
            sellerMarginFlat: config.sellerMarginFlat,
            allowedIps: config.allowedIps,
            callbackEnabled: config.callbackEnabled,
            prepaidEndpointPath: config.prepaidEndpointPath,
            prepaidEndpointUrl: config.prepaidEndpointUrl,
            mappingSummary: {
                total: totalMappings,
                active: activeMappings
            },
            orderSummary,
            retryQueueHealth
        });
    } catch (error) {
        console.error('Failed to load Digiflazz Seller settings:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const getDigiflazzSellerRetrySchedulerConfig = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const protocol = request.protocol || 'http';
        const host = request.headers.host || 'localhost:9005';
        const path = '/api/v2/digiflazz-seller/orders/process-callback-retries/scheduler';

        return reply.send({
            tokenConfigured: Boolean(normalizeText(process.env.DIGIFLAZZ_SELLER_RETRY_QUEUE_TOKEN)),
            endpointPath: path,
            endpointUrl: `${protocol}://${host}${path}`,
            tokenHeader: 'X-Scheduler-Token',
            recommendedIntervalMinutes: 1,
            maxLimit: 50,
            exampleLimit: 20
        });
    } catch (error) {
        console.error('Failed to load Digiflazz Seller retry scheduler config:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const saveDigiflazzSellerSettings = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const payload = (request.body || {}) as Record<string, unknown>;
        const savedConfig = await saveDigiflazzSellerConfig({
            username: typeof payload.username === 'string' ? payload.username : undefined,
            apiKey: typeof payload.apiKey === 'string' ? payload.apiKey : undefined,
            publicBaseUrl: typeof payload.publicBaseUrl === 'string' ? payload.publicBaseUrl : undefined,
            digiflazzCallbackUrl: typeof payload.digiflazzCallbackUrl === 'string' ? payload.digiflazzCallbackUrl : undefined,
            serverIp: typeof payload.serverIp === 'string' ? payload.serverIp : undefined,
            reportedBalance: typeof payload.reportedBalance === 'number' || typeof payload.reportedBalance === 'string'
                ? Number(payload.reportedBalance)
                : undefined,
            sellerMarginFlat: typeof payload.sellerMarginFlat === 'number' || typeof payload.sellerMarginFlat === 'string'
                ? Number(payload.sellerMarginFlat)
                : undefined,
            allowedIps: Array.isArray(payload.allowedIps) || typeof payload.allowedIps === 'string'
                ? payload.allowedIps
                : undefined,
            callbackEnabled: typeof payload.callbackEnabled === 'boolean' ? payload.callbackEnabled : undefined
        });

        return reply.send({
            success: true,
            message: 'Konfigurasi Digiflazz Seller berhasil disimpan',
            configured: true,
            username: savedConfig.username,
            apiKeyMasked: maskDigiflazzSellerApiKey(savedConfig.apiKey),
            publicBaseUrl: savedConfig.publicBaseUrl,
            digiflazzCallbackUrl: savedConfig.digiflazzCallbackUrl,
            serverIp: savedConfig.serverIp,
            reportedBalance: savedConfig.reportedBalance,
            sellerMarginFlat: savedConfig.sellerMarginFlat,
            allowedIps: savedConfig.allowedIps,
            callbackEnabled: savedConfig.callbackEnabled,
            prepaidEndpointUrl: savedConfig.prepaidEndpointUrl
        });
    } catch (error: any) {
        const message = error?.message === 'DIGIFLAZZ_SELLER_CREDENTIALS_REQUIRED'
            ? 'Username dan API Key Digiflazz Seller wajib diisi'
            : error?.message === 'DIGIFLAZZ_SELLER_PUBLIC_BASE_URL_INVALID'
                ? 'Public Base URL wajib format http:// atau https:// yang valid'
                : error?.message === 'DIGIFLAZZ_SELLER_CALLBACK_URL_INVALID'
                    ? 'Report / callback URL Digiflazz wajib format http:// atau https:// yang valid'
                : error?.message === 'DIGIFLAZZ_SELLER_ALLOWED_IP_INVALID'
                    ? 'Whitelist IP hanya boleh berisi alamat IP valid, pisahkan dengan koma atau baris baru'
            : 'Gagal menyimpan konfigurasi Digiflazz Seller';

        return reply.status(400).send({ message });
    }
};

export const getDigiflazzSellerMappings = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { search, page, limit, mapped } = request.query as {
            search?: string;
            page?: string | number;
            limit?: string | number;
            mapped?: 'all' | 'mapped' | 'unmapped';
        };

        const currentPage = toPositiveInt(page, 1, 100000);
        const pageSize = toPositiveInt(limit, 20, 100);
        const keyword = normalizeText(search);
        const mappedFilter = normalizeText(mapped || 'all');
        const config = await getDigiflazzSellerConfig();

        const productQuery: Record<string, unknown> = {};
        if (keyword) {
            const safeKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            productQuery.$or = [
                { name: { $regex: safeKeyword, $options: 'i' } },
                { code: { $regex: safeKeyword, $options: 'i' } },
                { brand: { $regex: safeKeyword, $options: 'i' } },
                { category: { $regex: safeKeyword, $options: 'i' } }
            ];
        }

        const products = await Product.find(productQuery)
            .select('name code brand category status vendor price costPrice updatedAt')
            .sort({ updatedAt: -1, name: 1 })
            .lean();

        const productIds = products.map((product) => product._id);
        const mappings = productIds.length > 0
            ? await DigiflazzSellerProductMap.find({ product: { $in: productIds } })
                .select('product pulsaCode price sellerMarginFlat isActive lastSyncStatus lastSyncRc lastSyncMessage lastSyncAt updatedAt')
                .lean()
            : [];

        const mappingByProductId = new Map(
            mappings.map((mapping) => [mapping.product.toString(), mapping])
        );

        const mergedItems = products.map((product) => {
            const mapping = mappingByProductId.get(product._id.toString());

            return {
                _id: product._id.toString(),
                name: product.name,
                code: product.code,
                brand: product.brand,
                category: product.category,
                status: product.status,
                vendor: product.vendor,
                price: product.price,
                costPrice: product.costPrice || 0,
                recommendedPrice: getDigiflazzSellerRecommendedPrice(product.costPrice || 0, config.sellerMarginFlat),
                updatedAt: product.updatedAt,
                mapping: mapping ? {
                    id: mapping._id.toString(),
                    pulsaCode: mapping.pulsaCode,
                    price: getDigiflazzSellerRecommendedPrice(
                        product.costPrice || 0,
                        config.sellerMarginFlat,
                        mapping.sellerMarginFlat
                    ),
                    sellerMarginFlat: mapping.sellerMarginFlat,
                    effectiveMarginFlat: getDigiflazzSellerEffectiveMargin(
                        config.sellerMarginFlat,
                        mapping.sellerMarginFlat
                    ),
                    isActive: mapping.isActive,
                    lastSyncStatus: mapping.lastSyncStatus,
                    lastSyncRc: mapping.lastSyncRc || '',
                    lastSyncMessage: mapping.lastSyncMessage || '',
                    lastSyncAt: mapping.lastSyncAt || null,
                    updatedAt: mapping.updatedAt
                } : null
            };
        });

        const filteredItems = mergedItems.filter((item) => {
            if (mappedFilter === 'mapped') {
                return Boolean(item.mapping?.id);
            }

            if (mappedFilter === 'unmapped') {
                return !item.mapping?.id;
            }

            return true;
        });

        const total = filteredItems.length;
        const totalPages = total > 0 ? Math.ceil(total / pageSize) : 1;
        const paginatedItems = filteredItems.slice((currentPage - 1) * pageSize, currentPage * pageSize);
        const summary = {
            totalProducts: filteredItems.length,
            mappedProducts: filteredItems.filter((item) => Boolean(item.mapping?.id)).length,
            activeMappings: filteredItems.filter((item) => Boolean(item.mapping?.isActive)).length
        };

        return reply.send({
            items: paginatedItems,
            meta: {
                page: currentPage,
                limit: pageSize,
                total,
                totalPages
            },
            summary: {
                totalProducts: summary.totalProducts,
                mappedProducts: summary.mappedProducts,
                activeMappings: summary.activeMappings
            }
        });
    } catch (error) {
        console.error('Failed to load Digiflazz Seller mappings:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const upsertDigiflazzSellerMapping = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const payload = (request.body || {}) as Record<string, unknown>;
        const productId = normalizeText(payload.productId);
        const pulsaCode = normalizeText(payload.pulsaCode).toLowerCase();
        const syncNow = Boolean(payload.syncNow);

        if (!mongoose.Types.ObjectId.isValid(productId)) {
            return reply.status(400).send({ message: 'Produk tidak valid' });
        }

        if (!pulsaCode || !isValidPulsaCode(pulsaCode)) {
            return reply.status(400).send({ message: 'Pulsa code wajib huruf kecil, angka, titik, underscore, atau dash' });
        }

        const config = await getDigiflazzSellerConfig();
        const product = await Product.findById(productId).select('name code brand category price costPrice vendor status');
        if (!product) {
            return reply.status(404).send({ message: 'Produk tidak ditemukan' });
        }

        const existingByCode = await DigiflazzSellerProductMap.findOne({ pulsaCode });
        if (existingByCode && existingByCode.product.toString() !== productId) {
            return reply.status(409).send({ message: 'Pulsa code sudah dipakai produk lain' });
        }

        let mapping = await DigiflazzSellerProductMap.findOne({ product: product._id });
        const rawMarginProvided = payload.sellerMarginFlat !== undefined && payload.sellerMarginFlat !== null && payload.sellerMarginFlat !== '';
        const rawPriceProvided = payload.price !== undefined && payload.price !== null && payload.price !== '';
        const nextCustomMargin = rawMarginProvided
            ? toNonNegativeNumber(payload.sellerMarginFlat, 0)
            : rawPriceProvided
                ? Math.max(0, toNonNegativeNumber(payload.price, 0) - toNonNegativeNumber(product.costPrice || 0, 0))
                : mapping?.sellerMarginFlat;
        const recommendedPrice = getDigiflazzSellerRecommendedPrice(
            product.costPrice || 0,
            config.sellerMarginFlat,
            nextCustomMargin
        );
        const nextPrice = recommendedPrice;
        const nextStatus = payload.isActive === undefined
            ? Boolean(mapping?.isActive ?? true)
            : Boolean(payload.isActive);

        if (!mapping) {
            mapping = await DigiflazzSellerProductMap.create({
                product: product._id,
                pulsaCode,
                price: nextPrice,
                sellerMarginFlat: nextCustomMargin,
                isActive: nextStatus
            });
        } else {
            mapping.pulsaCode = pulsaCode;
            mapping.price = nextPrice;
            mapping.sellerMarginFlat = nextCustomMargin;
            mapping.isActive = nextStatus;
            await mapping.save();
        }

        let syncResult = null as any;
        if (syncNow) {
            syncResult = await syncDigiflazzSellerProductMapping(mapping);
        }

        return reply.send({
            success: true,
            message: 'Mapping Digiflazz Seller berhasil disimpan',
            mapping: {
                id: mapping._id,
                productId: product._id,
                productName: product.name,
                productCode: product.code,
                costPrice: product.costPrice || 0,
                recommendedPrice,
                sellerMarginFlat: mapping.sellerMarginFlat,
                effectiveMarginFlat: getDigiflazzSellerEffectiveMargin(
                    config.sellerMarginFlat,
                    mapping.sellerMarginFlat
                ),
                pulsaCode: mapping.pulsaCode,
                price: mapping.price,
                isActive: mapping.isActive,
                lastSyncStatus: mapping.lastSyncStatus,
                lastSyncRc: mapping.lastSyncRc || '',
                lastSyncMessage: mapping.lastSyncMessage || '',
                lastSyncAt: mapping.lastSyncAt || null
            },
            syncResult
        });
    } catch (error) {
        console.error('Failed to save Digiflazz Seller mapping:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const deleteDigiflazzSellerMapping = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return reply.status(400).send({ message: 'Mapping tidak valid' });
        }

        const deleted = await DigiflazzSellerProductMap.findByIdAndDelete(id);
        if (!deleted) {
            return reply.status(404).send({ message: 'Mapping tidak ditemukan' });
        }

        return reply.send({
            success: true,
            message: 'Mapping Digiflazz Seller berhasil dihapus'
        });
    } catch (error) {
        console.error('Failed to delete Digiflazz Seller mapping:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const syncDigiflazzSellerMappingById = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return reply.status(400).send({ message: 'Mapping tidak valid' });
        }

        const mapping = await DigiflazzSellerProductMap.findById(id);
        if (!mapping) {
            return reply.status(404).send({ message: 'Mapping tidak ditemukan' });
        }

        const result = await syncDigiflazzSellerProductMapping(mapping);
        return reply.send({
            success: result.success,
            rc: result.rc,
            message: result.message
        });
    } catch (error: any) {
        const message = error?.message === 'DIGIFLAZZ_SELLER_CREDENTIALS_REQUIRED'
            ? 'Konfigurasi Digiflazz Seller belum lengkap'
            : 'Gagal sinkronisasi mapping';

        return reply.status(400).send({ message });
    }
};

export const syncAllDigiflazzSellerMappings = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { limit } = (request.body || {}) as { limit?: number | string };
        const syncLimit = toPositiveInt(limit, 50, 60);
        const mappings = await DigiflazzSellerProductMap.find({})
            .sort({ updatedAt: -1 })
            .limit(syncLimit);

        const results = [];
        for (const mapping of mappings) {
            const syncResult = await syncDigiflazzSellerProductMapping(mapping);
            results.push({
                id: mapping._id,
                pulsaCode: mapping.pulsaCode,
                success: syncResult.success,
                rc: syncResult.rc,
                message: syncResult.message
            });
        }

        return reply.send({
            success: true,
            total: results.length,
            successCount: results.filter((item) => item.success).length,
            failedCount: results.filter((item) => !item.success).length,
            results
        });
    } catch (error: any) {
        const message = error?.message === 'DIGIFLAZZ_SELLER_CREDENTIALS_REQUIRED'
            ? 'Konfigurasi Digiflazz Seller belum lengkap'
            : 'Gagal sinkronisasi mapping';

        return reply.status(400).send({ message });
    }
};

export const getDigiflazzSellerWebhookLogs = async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
        const logs = await getDigiflazzSellerRecentLogs();
        return reply.send(logs);
    } catch (error) {
        console.error('Failed to load Digiflazz Seller logs:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const getDigiflazzSellerOrders = async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
        const orders = await getDigiflazzSellerRecentOrders();
        return reply.send(orders);
    } catch (error) {
        console.error('Failed to load Digiflazz Seller orders:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

const buildSellerAdminOrdersQuery = async (input: DigiflazzSellerAdminOrdersQuery) => {
    const keyword = normalizeText(input.search);
    const statusFilter = normalizeText(input.status);
    const callbackFilter = normalizeText(input.callback);
    const start = parseDateBoundary(input.startDate);
    const end = parseDateBoundary(input.endDate, true);

    if (statusFilter && !['pending', 'success', 'failed'].includes(statusFilter)) {
        throw new Error('INVALID_STATUS');
    }

    if (callbackFilter && !['pending', 'due', 'delivered'].includes(callbackFilter)) {
        throw new Error('INVALID_CALLBACK');
    }

    const query: Record<string, any> = {};
    const andConditions: Record<string, any>[] = [];

    if (statusFilter) {
        query.status = statusFilter;
    }

    if (callbackFilter === 'pending') {
        andConditions.push(getSellerCallbackPendingQuery());
    } else if (callbackFilter === 'due') {
        andConditions.push(getDigiflazzSellerCallbackDueRetryQuery());
    } else if (callbackFilter === 'delivered') {
        andConditions.push({ callbackDeliveredAt: { $exists: true, $ne: null } });
    }

    if (start || end) {
        query.createdAt = {};
        if (start) {
            query.createdAt.$gte = start;
        }
        if (end) {
            query.createdAt.$lte = end;
        }
    }

    if (keyword) {
        const safeKeyword = escapeRegExp(keyword);
        const productIds = await Product.find({
            $or: [
                { name: { $regex: safeKeyword, $options: 'i' } },
                { code: { $regex: safeKeyword, $options: 'i' } },
                { brand: { $regex: safeKeyword, $options: 'i' } },
                { category: { $regex: safeKeyword, $options: 'i' } },
                { 'vendor.name': { $regex: safeKeyword, $options: 'i' } },
                { 'vendor.sku': { $regex: safeKeyword, $options: 'i' } }
            ]
        }).distinct('_id');

        const searchCondition: Record<string, any> = {
            $or: [
                { refId: { $regex: safeKeyword, $options: 'i' } },
                { trId: { $regex: safeKeyword, $options: 'i' } },
                { pulsaCode: { $regex: safeKeyword, $options: 'i' } },
                { target: { $regex: safeKeyword, $options: 'i' } },
                { vendorTrxId: { $regex: safeKeyword, $options: 'i' } },
                { vendorName: { $regex: safeKeyword, $options: 'i' } },
                { vendorSku: { $regex: safeKeyword, $options: 'i' } },
                { sn: { $regex: safeKeyword, $options: 'i' } },
                { message: { $regex: safeKeyword, $options: 'i' } },
                { requestIp: { $regex: safeKeyword, $options: 'i' } }
            ]
        };

        if (productIds.length > 0) {
            searchCondition.$or.push({ product: { $in: productIds } });
        }

        andConditions.push(searchCondition);
    }

    if (andConditions.length > 0) {
        query.$and = andConditions;
    }

    return query;
};

const buildSellerOrdersCsv = (orders: any[]) => {
    const header = [
        'Order ID',
        'Ref ID',
        'TR ID',
        'Pulsa Code',
        'Produk',
        'Kode Produk',
        'Kategori',
        'Brand',
        'Vendor Supplier',
        'Vendor SKU',
        'Vendor Trx ID',
        'Target',
        'Harga Seller',
        'Status',
        'RC',
        'Message',
        'SN',
        'Callback Required',
        'Callback Attempts',
        'Callback Delivered At',
        'Callback Last Attempt At',
        'Callback Next Retry At',
        'Callback Status Code',
        'Callback Message',
        'Request IP',
        'Created At',
        'Updated At'
    ];

    const rows = orders.map((order) => ([
        order._id?.toString?.() || '',
        order.refId || '',
        order.trId || '',
        order.pulsaCode || '',
        order.product?.name || '',
        order.product?.code || '',
        order.product?.category || '',
        order.product?.brand || '',
        order.vendorName || order.product?.vendor?.name || '',
        order.vendorSku || order.product?.vendor?.sku || '',
        order.vendorTrxId || '',
        order.target || '',
        order.digiflazzPrice || 0,
        order.status || '',
        order.rc || '',
        order.message || '',
        order.sn || '',
        order.callbackRequired ? 'yes' : 'no',
        Number(order.callbackAttemptCount || 0),
        formatCsvDate(order.callbackDeliveredAt),
        formatCsvDate(order.callbackLastAttemptAt),
        formatCsvDate(order.callbackNextRetryAt),
        order.callbackLastStatusCode || '',
        order.callbackLastMessage || '',
        order.requestIp || '',
        formatCsvDate(order.createdAt),
        formatCsvDate(order.updatedAt)
    ]));

    return [header, ...rows]
        .map((row) => row.map(csvEscape).join(','))
        .join('\n');
};

export const getDigiflazzSellerAdminOrders = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { page, limit } = request.query as DigiflazzSellerAdminOrdersQuery;

        const currentPage = toPositiveInt(page, 1, 100000);
        const pageSize = toPositiveInt(limit, 20, 100);
        const query = await buildSellerAdminOrdersQuery(request.query as DigiflazzSellerAdminOrdersQuery);

        const [orders, summaryRows] = await Promise.all([
            DigiflazzSellerOrder.find(query)
                .sort({ createdAt: -1 })
                .skip((currentPage - 1) * pageSize)
                .limit(pageSize)
                .populate('product', 'name code brand category vendor status')
                .lean(),
            DigiflazzSellerOrder.aggregate([
                { $match: query },
                {
                    $group: {
                        _id: null,
                        total: { $sum: 1 },
                        pending: {
                            $sum: {
                                $cond: [{ $eq: ['$status', 'pending'] }, 1, 0]
                            }
                        },
                        success: {
                            $sum: {
                                $cond: [{ $eq: ['$status', 'success'] }, 1, 0]
                            }
                        },
                        failed: {
                            $sum: {
                                $cond: [{ $eq: ['$status', 'failed'] }, 1, 0]
                            }
                        },
                        callbackPending: {
                            $sum: {
                                $cond: [sellerCallbackPendingSummaryExpression, 1, 0]
                            }
                        },
                        callbackDueRetry: {
                            $sum: {
                                $cond: [
                                    {
                                        $and: [
                                            { $eq: ['$callbackRequired', true] },
                                            { $ne: ['$status', 'pending'] },
                                            {
                                                $or: [
                                                    { $eq: [{ $ifNull: ['$callbackNextRetryAt', null] }, null] },
                                                    { $lte: ['$callbackNextRetryAt', new Date()] }
                                                ]
                                            }
                                        ]
                                    },
                                    1,
                                    0
                                ]
                            }
                        },
                        amountTotal: { $sum: '$digiflazzPrice' }
                    }
                }
            ])
        ]);

        const summary = summaryRows[0] || {
            total: 0,
            pending: 0,
            success: 0,
            failed: 0,
            callbackPending: 0,
            callbackDueRetry: 0,
            amountTotal: 0
        };

        const items = orders.map((order: any) => ({
            id: order._id.toString(),
            refId: order.refId,
            trId: order.trId,
            pulsaCode: order.pulsaCode,
            target: order.target,
            price: order.digiflazzPrice,
            status: order.status,
            rc: order.rc,
            message: order.message,
            sn: order.sn || '',
            vendorName: order.vendorName || '',
            vendorSku: order.vendorSku || '',
            vendorTrxId: order.vendorTrxId || '',
            callbackRequired: Boolean(order.callbackRequired),
            callbackAttemptCount: Number(order.callbackAttemptCount || 0),
            callbackDeliveredAt: order.callbackDeliveredAt || null,
            callbackLastAttemptAt: order.callbackLastAttemptAt || null,
            callbackNextRetryAt: order.callbackNextRetryAt || null,
            callbackLastStatusCode: order.callbackLastStatusCode || null,
            callbackLastMessage: order.callbackLastMessage || '',
            requestIp: order.requestIp || '',
            rawRequest: order.rawRequest || null,
            createdAt: order.createdAt,
            updatedAt: order.updatedAt,
            product: order.product ? {
                _id: order.product._id?.toString?.() || '',
                name: order.product.name,
                code: order.product.code,
                brand: order.product.brand,
                category: order.product.category,
                vendorName: order.product.vendor?.name || '',
                vendorSku: order.product.vendor?.sku || '',
                active: Boolean(order.product.status)
            } : null
        }));

        const total = Number(summary.total || 0);
        const totalPages = total > 0 ? Math.ceil(total / pageSize) : 1;

        return reply.send({
            items,
            meta: {
                page: currentPage,
                limit: pageSize,
                total,
                totalPages
            },
            summary: {
                total,
                pending: Number(summary.pending || 0),
                success: Number(summary.success || 0),
                failed: Number(summary.failed || 0),
                callbackPending: Number(summary.callbackPending || 0),
                callbackDueRetry: Number(summary.callbackDueRetry || 0),
                amountTotal: Number(summary.amountTotal || 0)
            }
        });
    } catch (error: any) {
        if (error?.message === 'INVALID_DATE') {
            return reply.status(400).send({ message: 'Format tanggal transaksi seller tidak valid' });
        }

        if (error?.message === 'INVALID_STATUS') {
            return reply.status(400).send({ message: 'Status transaksi seller tidak valid' });
        }

        if (error?.message === 'INVALID_CALLBACK') {
            return reply.status(400).send({ message: 'Filter callback seller tidak valid' });
        }

        console.error('Failed to load Digiflazz Seller admin orders:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const exportDigiflazzSellerAdminOrdersCsv = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const query = await buildSellerAdminOrdersQuery(request.query as DigiflazzSellerAdminOrdersQuery);
        const orders = await DigiflazzSellerOrder.find(query)
            .sort({ createdAt: -1 })
            .limit(DIGIFLAZZ_SELLER_ORDER_EXPORT_LIMIT)
            .populate('product', 'name code brand category vendor status')
            .lean();
        const csv = buildSellerOrdersCsv(orders);
        const filename = `digiflazz-seller-orders-${new Date().toISOString().slice(0, 10)}.csv`;

        return reply
            .header('Content-Type', 'text/csv; charset=utf-8')
            .header('Content-Disposition', `attachment; filename="${filename}"`)
            .send(`\uFEFF${csv}`);
    } catch (error: any) {
        if (error?.message === 'INVALID_DATE') {
            return reply.status(400).send({ message: 'Format tanggal transaksi seller tidak valid' });
        }

        if (error?.message === 'INVALID_STATUS') {
            return reply.status(400).send({ message: 'Status transaksi seller tidak valid' });
        }

        if (error?.message === 'INVALID_CALLBACK') {
            return reply.status(400).send({ message: 'Filter callback seller tidak valid' });
        }

        console.error('Failed to export Digiflazz Seller admin orders:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const retryDigiflazzSellerCallback = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return reply.status(400).send({ message: 'Order tidak valid' });
        }

        const order = await DigiflazzSellerOrder.findById(id);
        if (!order) {
            return reply.status(404).send({ message: 'Order tidak ditemukan' });
        }

        const result = await sendDigiflazzSellerCallback(order);
        return reply.send({
            success: result.success,
            message: result.message
        });
    } catch (error) {
        console.error('Failed to retry Digiflazz Seller callback:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const retryPendingDigiflazzSellerCallbacks = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { limit } = request.body as DigiflazzSellerRetryRequestBody || {};
        const retryLimit = toPositiveInt(limit, 25, 50);
        const orders = await DigiflazzSellerOrder.find({
            status: { $ne: 'pending' },
            ...getSellerCallbackPendingQuery()
        })
            .sort({ updatedAt: 1 })
            .limit(retryLimit);

        const results = [];

        for (const order of orders) {
            const result = await sendDigiflazzSellerCallback(order);
            results.push({
                orderId: order._id.toString(),
                refId: order.refId,
                success: result.success,
                message: result.message
            });
        }

        return reply.send({
            processed: results.length,
            successCount: results.filter((item) => item.success).length,
            failedCount: results.filter((item) => !item.success).length,
            results
        });
    } catch (error) {
        console.error('Failed to retry pending Digiflazz Seller callbacks:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

const runDueDigiflazzSellerCallbackRetries = async (
    limit: unknown,
    source: DigiflazzSellerRetrySource
) => {
    const retryLimit = toPositiveInt(limit, 20, 50);
    const now = new Date();
    const orders = await DigiflazzSellerOrder.find(getDigiflazzSellerCallbackDueRetryQuery(now))
        .sort({ callbackNextRetryAt: 1, updatedAt: 1 })
        .limit(retryLimit);

    const results = [];

    for (const order of orders) {
        const result = await sendDigiflazzSellerCallback(order);
        results.push({
            orderId: order._id.toString(),
            refId: order.refId,
            success: result.success,
            message: result.message,
            nextRetryAt: order.callbackNextRetryAt || null
        });
    }

    const remainingDue = await DigiflazzSellerOrder.countDocuments(getDigiflazzSellerCallbackDueRetryQuery(new Date()));
    const successCount = results.filter((item) => item.success).length;
    const failedCount = results.filter((item) => !item.success).length;
    const health = await saveDigiflazzSellerRetryQueueHealth({
        status: failedCount > 0 ? 'partial' : 'success',
        source,
        lastRunAt: new Date(),
        processed: results.length,
        successCount,
        failedCount,
        remainingDue,
        lastError: failedCount > 0 ? `${failedCount} callback gagal diproses` : ''
    });

    return {
        processed: results.length,
        successCount,
        failedCount,
        remainingDue,
        health,
        results
    };
};

export const processDueDigiflazzSellerCallbackRetries = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { limit } = request.body as DigiflazzSellerRetryRequestBody || {};
        const source = request.url.includes('/scheduler') ? 'scheduler' : 'admin';
        return reply.send(await runDueDigiflazzSellerCallbackRetries(limit, source));
    } catch (error: any) {
        await saveDigiflazzSellerRetryQueueHealth({
            status: 'failed',
            source: request.url.includes('/scheduler') ? 'scheduler' : 'admin',
            lastRunAt: new Date(),
            lastError: normalizeText(error?.message) || 'Gagal memproses queue retry callback'
        });
        console.error('Failed to process Digiflazz Seller callback retry queue:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const handleDigiflazzSellerPrepaid = async (request: FastifyRequest, reply: FastifyReply) => {
    const body = (request.body || {}) as DigiflazzSellerRequestPayload;
    const refId = normalizeText(body.ref_id);
    const pulsaCode = normalizeText(body.pulsa_code).toLowerCase();
    const hp = normalizeText(body.hp);
    const price = toNonNegativeNumber(body.price, 0);
    const sign = normalizeText(body.sign);
    const username = normalizeText(body.username);
    const commands = normalizeText(body.commands).toLowerCase();
    const requestIp = getClientIP(request);

    try {
        const config = await getDigiflazzSellerConfig();

        const respond = async (
            payload: ReturnType<typeof buildDigiflazzSellerErrorResponse>,
            logInput?: {
                status: string;
                message: string;
                verified?: boolean;
            }
        ) => {
            if (logInput) {
                await logDigiflazzSellerEvent({
                    event: 'request',
                    refId: refId || '-',
                    status: logInput.status,
                    message: logInput.message,
                    verified: logInput.verified,
                    requestIp,
                    raw: body as Record<string, unknown>
                });
            }

            return reply.send(payload);
        };

        if (config.allowedIps.length > 0 && !config.allowedIps.includes(requestIp)) {
            return respond(
                buildDigiflazzSellerErrorResponse(
                    { refId, pulsaCode, target: hp, price },
                    { rc: '204', message: 'Wrong authentication' },
                    config.reportedBalance
                ),
                {
                    status: 'rejected',
                    message: `IP ${requestIp} tidak termasuk whitelist`,
                    verified: false
                }
            );
        }

        if (!config.username || !config.apiKey) {
            return respond(
                buildDigiflazzSellerErrorResponse(
                    { refId, pulsaCode, target: hp, price },
                    { rc: '204', message: 'Wrong authentication' },
                    config.reportedBalance
                ),
                {
                    status: 'rejected',
                    message: 'Konfigurasi Digiflazz Seller belum lengkap',
                    verified: false
                }
            );
        }

        if (!refId || !username || !sign) {
            return respond(
                buildDigiflazzSellerErrorResponse(
                    { refId, pulsaCode, target: hp, price },
                    { rc: '204', message: 'Wrong authentication' },
                    config.reportedBalance
                ),
                {
                    status: 'rejected',
                    message: 'Username, ref_id, atau sign tidak valid',
                    verified: false
                }
            );
        }

        if (
            username !== config.username
            || !verifyDigiflazzSellerRequest(config.username, config.apiKey, refId, sign)
        ) {
            return respond(
                buildDigiflazzSellerErrorResponse(
                    { refId, pulsaCode, target: hp, price },
                    { rc: '204', message: 'Wrong authentication' },
                    config.reportedBalance
                ),
                {
                    status: 'rejected',
                    message: 'Verifikasi signature Digiflazz Seller gagal',
                    verified: false
                }
            );
        }

        if (commands !== 'topup') {
            return respond(
                buildDigiflazzSellerErrorResponse(
                    { refId, pulsaCode, target: hp, price },
                    { rc: '07', message: 'Unsupported command' },
                    config.reportedBalance
                ),
                {
                    status: 'failed',
                    message: `Command ${commands || '-'} tidak didukung`,
                    verified: true
                }
            );
        }

        const duplicateReply = await replyWithExistingSellerOrder(
            reply,
            config,
            requestIp,
            body as Record<string, unknown>,
            refId
        );
        if (duplicateReply) {
            return duplicateReply;
        }

        if (!pulsaCode || !isValidPulsaCode(pulsaCode)) {
            return respond(
                buildDigiflazzSellerErrorResponse(
                    { refId, pulsaCode, target: hp, price },
                    { rc: '20', message: 'Code not found' },
                    config.reportedBalance
                ),
                {
                    status: 'failed',
                    message: 'Pulsa code tidak valid',
                    verified: true
                }
            );
        }

        if (!hp || !isValidTarget(hp)) {
            return respond(
                buildDigiflazzSellerErrorResponse(
                    { refId, pulsaCode, target: hp, price },
                    { rc: '14', message: 'Incorrect destination number' },
                    config.reportedBalance
                ),
                {
                    status: 'failed',
                    message: 'Nomor tujuan tidak valid',
                    verified: true
                }
            );
        }

        const mapping = await DigiflazzSellerProductMap.findOne({ pulsaCode }).populate('product');
        if (!mapping) {
            return respond(
                buildDigiflazzSellerErrorResponse(
                    { refId, pulsaCode, target: hp, price },
                    { rc: '20', message: 'Code not found' },
                    config.reportedBalance
                ),
                {
                    status: 'failed',
                    message: 'Mapping pulsa code tidak ditemukan',
                    verified: true
                }
            );
        }

        const product = mapping.product as any;
        const effectiveSellerPrice = getDigiflazzSellerRecommendedPrice(
            product?.costPrice || 0,
            config.sellerMarginFlat,
            mapping.sellerMarginFlat
        );
        if (!mapping.isActive || !product?.status) {
            return respond(
                buildDigiflazzSellerErrorResponse(
                    { refId, pulsaCode, target: hp, price },
                    { rc: '106', message: 'Product is temporarily out of service' },
                    config.reportedBalance
                ),
                {
                    status: 'failed',
                    message: 'Produk sedang nonaktif',
                    verified: true
                }
            );
        }

        if (price > 0 && price !== Math.round(effectiveSellerPrice)) {
            return respond(
                buildDigiflazzSellerErrorResponse(
                    { refId, pulsaCode, target: hp, price },
                    { rc: '07', message: 'Price mismatch' },
                    config.reportedBalance
                ),
                {
                    status: 'failed',
                    message: `Harga request ${price} tidak sama dengan harga seller ${effectiveSellerPrice}`,
                    verified: true
                }
            );
        }

        const trId = await generateRefId();
        const vendorName = normalizeText(product?.vendor?.name);
        const vendorSku = normalizeText(product?.vendor?.sku || product?.code);

        let order;
        try {
            order = await DigiflazzSellerOrder.create({
                refId,
                trId,
                mapping: mapping._id,
                product: product._id,
                pulsaCode,
                target: hp,
                digiflazzPrice: effectiveSellerPrice,
                status: 'pending',
                rc: '39',
                message: 'Process',
                vendorName,
                vendorSku,
                vendorTrxId: trId,
                requestIp,
                rawRequest: body as Record<string, unknown>,
                callbackRequired: Boolean(config.callbackEnabled)
            });
        } catch (createError) {
            if (isDuplicateKeyError(createError)) {
                const duplicateOrderReply = await replyWithExistingSellerOrder(
                    reply,
                    config,
                    requestIp,
                    body as Record<string, unknown>,
                    refId
                );

                if (duplicateOrderReply) {
                    return duplicateOrderReply;
                }
            }

            throw createError;
        }

        if (!vendorName || !vendorSku) {
            await updateDigiflazzSellerOrderStatus(order, {
                status: 'failed',
                rc: '106',
                message: 'Product is temporarily out of service'
            });

            await logDigiflazzSellerEvent({
                event: 'request',
                refId,
                status: 'failed',
                message: 'Produk belum punya vendor supplier yang bisa diproses',
                verified: true,
                requestIp,
                raw: body as Record<string, unknown>
            });

            return reply.send(buildDigiflazzSellerResponse({
                refId: order.refId,
                trId: order.trId,
                pulsaCode: order.pulsaCode,
                target: order.target,
                price: order.digiflazzPrice,
                status: order.status,
                rc: order.rc,
                message: order.message
            }, config.reportedBalance));
        }

        try {
            const vendorResult = await vendorService.topUp(
                trId,
                vendorSku,
                hp,
                vendorName
            );

            const nextStatus = vendorResult.status;
            await updateDigiflazzSellerOrderStatus(order, {
                status: nextStatus,
                message: vendorResult.message,
                sn: vendorResult.sn,
                vendorTrxId: vendorResult.vendorTrxId || trId
            });

            const refreshedOrder = await DigiflazzSellerOrder.findById(order._id);
            const payload = buildDigiflazzSellerResponse({
                refId,
                trId,
                pulsaCode,
                target: hp,
                price: order.digiflazzPrice,
                status: refreshedOrder?.status || nextStatus,
                rc: refreshedOrder?.rc || order.rc,
                message: refreshedOrder?.message || vendorResult.message || order.message,
                sn: refreshedOrder?.sn || vendorResult.sn
            }, config.reportedBalance);

            await logDigiflazzSellerEvent({
                event: 'request',
                refId,
                status: refreshedOrder?.status || nextStatus,
                message: refreshedOrder?.message || vendorResult.message || 'Order berhasil dibuat',
                verified: true,
                requestIp,
                raw: body as Record<string, unknown>
            });

            return reply.send(payload);
        } catch (vendorError: any) {
            await updateDigiflazzSellerOrderStatus(order, {
                status: 'failed',
                rc: '07',
                message: normalizeText(vendorError?.message) || 'Failed'
            });

            await logDigiflazzSellerEvent({
                event: 'request',
                refId,
                status: 'failed',
                message: normalizeText(vendorError?.message) || 'Gagal meneruskan order ke vendor',
                verified: true,
                requestIp,
                raw: body as Record<string, unknown>
            });

            return reply.send(buildDigiflazzSellerResponse({
                refId: order.refId,
                trId: order.trId,
                pulsaCode: order.pulsaCode,
                target: order.target,
                price: order.digiflazzPrice,
                status: 'failed',
                rc: '07',
                message: normalizeText(vendorError?.message) || 'Failed'
            }, config.reportedBalance));
        }
    } catch (error) {
        console.error('Digiflazz Seller prepaid error:', error);
        const fallbackConfig = await getDigiflazzSellerConfig().catch(() => ({
            reportedBalance: 0
        } as any));

        await logDigiflazzSellerEvent({
            event: 'request',
            refId: refId || '-',
            status: 'error',
            message: String(error),
            verified: false,
            requestIp,
            raw: body as Record<string, unknown>
        }).catch(() => undefined);

        return reply.send(buildDigiflazzSellerErrorResponse(
            { refId, pulsaCode, target: hp, price },
            { rc: '07', message: 'Failed' },
            Number(fallbackConfig.reportedBalance || 0)
        ));
    }
};
