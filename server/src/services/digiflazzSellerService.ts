import axios from 'axios';
import crypto from 'crypto';
import net from 'net';
import DigiflazzSellerOrder, { IDigiflazzSellerOrder } from '../models/DigiflazzSellerOrder';
import DigiflazzSellerProductMap, { IDigiflazzSellerProductMap } from '../models/DigiflazzSellerProductMap';
import Product from '../models/Product';
import Settings from '../models/Settings';
import WebhookEventLog from '../models/WebhookEventLog';

type SellerOrderStatus = 'pending' | 'success' | 'failed';

type SellerResponseSnapshot = {
    refId: string;
    trId: string;
    pulsaCode: string;
    target: string;
    price: number;
    status: SellerOrderStatus;
    rc: string;
    message: string;
    sn?: string;
};

type SellerStatusUpdateInput = {
    status: SellerOrderStatus;
    rc?: string;
    message?: string;
    sn?: string;
    vendorTrxId?: string;
};

type PersistedSellerConfig = {
    username?: string;
    apiKey?: string;
    publicBaseUrl?: string;
    digiflazzCallbackUrl?: string;
    serverIp?: string;
    reportedBalance?: number;
    sellerMarginFlat?: number;
    allowedIps?: string[] | string;
    callbackEnabled?: boolean;
};

export type DigiflazzSellerConfig = {
    username: string;
    apiKey: string;
    publicBaseUrl: string;
    digiflazzCallbackUrl: string;
    serverIp: string;
    reportedBalance: number;
    sellerMarginFlat: number;
    allowedIps: string[];
    callbackEnabled: boolean;
    prepaidEndpointPath: string;
    prepaidEndpointUrl: string;
};

export type DigiflazzSellerMappingSyncResult = {
    success: boolean;
    rc: string;
    message: string;
};

export type DigiflazzSellerRetryQueueHealth = {
    status: 'never' | 'success' | 'partial' | 'failed';
    source: 'admin' | 'scheduler' | 'unknown';
    lastRunAt: Date | null;
    processed: number;
    successCount: number;
    failedCount: number;
    remainingDue: number;
    lastError: string;
};

const DIGIFLAZZ_SELLER_CONFIG_KEY = 'digiflazzSellerConfig';
const DIGIFLAZZ_SELLER_RETRY_QUEUE_HEALTH_KEY = 'digiflazzSellerRetryQueueHealth';
const DIGIFLAZZ_SELLER_DEFAULT_CALLBACK_URL = 'https://api.digiflazz.com/v1/seller/callback';
const DIGIFLAZZ_SELLER_PRODUCT_UPDATE_URL = 'https://api.digiflazz.com/v1/seller/api/prepaid/product/update';
const DIGIFLAZZ_SELLER_DEFAULT_ALLOWED_IPS = ['52.74.250.133'];
const DIGIFLAZZ_SELLER_PREPAID_PATH = '/api/v2/digiflazz-seller/prepaid';

const DEFAULT_MESSAGES: Record<SellerOrderStatus, string> = {
    pending: 'Process',
    success: 'Success',
    failed: 'Failed'
};

const DEFAULT_RESPONSE_CODES: Record<SellerOrderStatus, string> = {
    pending: '39',
    success: '00',
    failed: '07'
};

const CALLBACK_RETRY_BACKOFF_MINUTES = [1, 5, 15, 60];
export const DIGIFLAZZ_SELLER_HIGH_CALLBACK_ATTEMPT_THRESHOLD = 5;

const normalizeText = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

const normalizeUrl = (value: unknown) => {
    const text = normalizeText(value);
    if (!text) {
        return '';
    }

    return text.replace(/\/+$/, '');
};

const normalizeAllowedIps = (value: unknown) => {
    const list = Array.isArray(value)
        ? value
        : typeof value === 'string'
            ? value.split(/[\n,;]+/)
            : [];

    const unique = new Set(
        list
            .map((item) => normalizeText(item))
            .filter(Boolean)
    );

    return Array.from(unique);
};

const validateHttpUrl = (value: string, errorCode = 'DIGIFLAZZ_SELLER_PUBLIC_BASE_URL_INVALID') => {
    if (!value) {
        return '';
    }

    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error(errorCode);
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error(errorCode);
    }

    return parsed.toString().replace(/\/+$/, '');
};

const validateAllowedIps = (value: unknown) => {
    const ips = normalizeAllowedIps(value);
    const invalidIp = ips.find((ip) => net.isIP(ip) === 0);
    if (invalidIp) {
        throw new Error('DIGIFLAZZ_SELLER_ALLOWED_IP_INVALID');
    }

    return ips;
};

const joinUrl = (baseUrl: string, path: string) => {
    if (!baseUrl) {
        return '';
    }

    return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
};

const toNonNegativeNumber = (value: unknown, fallback = 0) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        return fallback;
    }

    return parsed;
};

const toBoolean = (value: unknown, fallback = true) => {
    if (typeof value === 'boolean') {
        return value;
    }

    if (typeof value === 'string') {
        if (value === 'true') return true;
        if (value === 'false') return false;
    }

    return fallback;
};

const getCallbackRetryDelayMinutes = (attemptCount: number) => {
    const index = Math.max(0, Math.min(attemptCount - 1, CALLBACK_RETRY_BACKOFF_MINUTES.length - 1));
    return CALLBACK_RETRY_BACKOFF_MINUTES[index];
};

export const getDigiflazzSellerCallbackDueRetryQuery = (now = new Date()) => ({
    status: { $ne: 'pending' },
    callbackRequired: true,
    $or: [
        { callbackNextRetryAt: { $exists: false } },
        { callbackNextRetryAt: null },
        { callbackNextRetryAt: { $lte: now } }
    ]
});

export const getDigiflazzSellerRetryQueueHealth = async (): Promise<DigiflazzSellerRetryQueueHealth> => {
    const setting = await Settings.findOne({ key: DIGIFLAZZ_SELLER_RETRY_QUEUE_HEALTH_KEY }).lean();
    const value = (setting?.value || {}) as Partial<DigiflazzSellerRetryQueueHealth>;

    return {
        status: value.status || 'never',
        source: value.source || 'unknown',
        lastRunAt: value.lastRunAt ? new Date(value.lastRunAt) : null,
        processed: Number(value.processed || 0),
        successCount: Number(value.successCount || 0),
        failedCount: Number(value.failedCount || 0),
        remainingDue: Number(value.remainingDue || 0),
        lastError: normalizeText(value.lastError)
    };
};

export const saveDigiflazzSellerRetryQueueHealth = async (
    input: Partial<DigiflazzSellerRetryQueueHealth>
) => {
    const value: DigiflazzSellerRetryQueueHealth = {
        status: input.status || 'success',
        source: input.source || 'unknown',
        lastRunAt: input.lastRunAt || new Date(),
        processed: Number(input.processed || 0),
        successCount: Number(input.successCount || 0),
        failedCount: Number(input.failedCount || 0),
        remainingDue: Number(input.remainingDue || 0),
        lastError: normalizeText(input.lastError)
    };

    await Settings.findOneAndUpdate(
        { key: DIGIFLAZZ_SELLER_RETRY_QUEUE_HEALTH_KEY },
        {
            $set: {
                key: DIGIFLAZZ_SELLER_RETRY_QUEUE_HEALTH_KEY,
                value,
                description: 'Status terakhir scheduler retry callback Digiflazz Seller'
            }
        },
        { upsert: true, new: true }
    );

    return value;
};

const buildProductUpdateSignature = (username: string, pulsaCode: string, apiKey: string) => (
    crypto.createHash('md5').update(`${username}${pulsaCode}${apiKey}update_product`).digest('hex')
);

export const buildDigiflazzSellerRequestSignature = (username: string, apiKey: string, refId: string) => (
    crypto.createHash('md5').update(`${username}${apiKey}${refId}`).digest('hex')
);

const getStoredConfig = async (): Promise<PersistedSellerConfig> => {
    const setting = await Settings.findOne({ key: DIGIFLAZZ_SELLER_CONFIG_KEY }).lean();
    return ((setting?.value || {}) as PersistedSellerConfig);
};

export const getDigiflazzSellerConfig = async (): Promise<DigiflazzSellerConfig> => {
    const storedConfig = await getStoredConfig();
    const publicBaseUrl = normalizeUrl(
        storedConfig.publicBaseUrl
        || process.env.DIGIFLAZZ_SELLER_PUBLIC_BASE_URL
        || process.env.PUBLIC_APP_URL
    );
    const digiflazzCallbackUrl = validateHttpUrl(normalizeUrl(
        storedConfig.digiflazzCallbackUrl
        || process.env.DIGIFLAZZ_SELLER_CALLBACK_URL
        || DIGIFLAZZ_SELLER_DEFAULT_CALLBACK_URL
    ), 'DIGIFLAZZ_SELLER_CALLBACK_URL_INVALID');

    const allowedIps = normalizeAllowedIps(
        storedConfig.allowedIps ?? process.env.DIGIFLAZZ_SELLER_ALLOWED_IPS
    );

    return {
        username: normalizeText(storedConfig.username || process.env.DIGIFLAZZ_SELLER_USERNAME),
        apiKey: normalizeText(storedConfig.apiKey || process.env.DIGIFLAZZ_SELLER_API_KEY),
        publicBaseUrl,
        digiflazzCallbackUrl,
        serverIp: normalizeText(storedConfig.serverIp || process.env.DIGIFLAZZ_SELLER_SERVER_IP),
        reportedBalance: toNonNegativeNumber(
            storedConfig.reportedBalance ?? process.env.DIGIFLAZZ_SELLER_REPORTED_BALANCE,
            0
        ),
        sellerMarginFlat: toNonNegativeNumber(
            storedConfig.sellerMarginFlat ?? process.env.DIGIFLAZZ_SELLER_MARGIN_FLAT,
            0
        ),
        allowedIps: allowedIps.length > 0 ? allowedIps : [...DIGIFLAZZ_SELLER_DEFAULT_ALLOWED_IPS],
        callbackEnabled: toBoolean(
            storedConfig.callbackEnabled ?? process.env.DIGIFLAZZ_SELLER_CALLBACK_ENABLED,
            true
        ),
        prepaidEndpointPath: DIGIFLAZZ_SELLER_PREPAID_PATH,
        prepaidEndpointUrl: joinUrl(publicBaseUrl, DIGIFLAZZ_SELLER_PREPAID_PATH)
    };
};

export const saveDigiflazzSellerConfig = async (input: PersistedSellerConfig) => {
    const current = await getStoredConfig();
    const apiKey = normalizeText(input.apiKey) || normalizeText(current.apiKey);
    const resolvedAllowedIps = validateAllowedIps(input.allowedIps ?? current.allowedIps);
    const nextConfig: PersistedSellerConfig = {
        username: normalizeText(input.username) || normalizeText(current.username),
        apiKey,
        publicBaseUrl: validateHttpUrl(normalizeUrl(input.publicBaseUrl ?? current.publicBaseUrl)),
        digiflazzCallbackUrl: validateHttpUrl(
            normalizeUrl(input.digiflazzCallbackUrl ?? current.digiflazzCallbackUrl),
            'DIGIFLAZZ_SELLER_CALLBACK_URL_INVALID'
        )
            || DIGIFLAZZ_SELLER_DEFAULT_CALLBACK_URL,
        serverIp: normalizeText(input.serverIp ?? current.serverIp),
        reportedBalance: toNonNegativeNumber(
            input.reportedBalance ?? current.reportedBalance,
            0
        ),
        sellerMarginFlat: toNonNegativeNumber(
            input.sellerMarginFlat ?? current.sellerMarginFlat,
            0
        ),
        allowedIps: resolvedAllowedIps.length > 0
            ? resolvedAllowedIps
            : [...DIGIFLAZZ_SELLER_DEFAULT_ALLOWED_IPS],
        callbackEnabled: toBoolean(input.callbackEnabled ?? current.callbackEnabled, true)
    };

    if (!nextConfig.username || !nextConfig.apiKey) {
        throw new Error('DIGIFLAZZ_SELLER_CREDENTIALS_REQUIRED');
    }

    await Settings.findOneAndUpdate(
        { key: DIGIFLAZZ_SELLER_CONFIG_KEY },
        {
            $set: {
                key: DIGIFLAZZ_SELLER_CONFIG_KEY,
                value: nextConfig,
                description: 'Konfigurasi Digiflazz Seller'
            }
        },
        { upsert: true, new: true }
    );

    return getDigiflazzSellerConfig();
};

export const getDigiflazzSellerEffectiveMargin = (
    globalMarginFlat: number,
    customMarginFlat?: number
) => (
    customMarginFlat !== undefined && customMarginFlat !== null
        ? toNonNegativeNumber(customMarginFlat, 0)
        : toNonNegativeNumber(globalMarginFlat, 0)
);

export const getDigiflazzSellerRecommendedPrice = (
    costPrice: number,
    globalMarginFlat: number,
    customMarginFlat?: number
) => (
    Math.max(
        0,
        Math.round(
            toNonNegativeNumber(costPrice, 0)
            + getDigiflazzSellerEffectiveMargin(globalMarginFlat, customMarginFlat)
        )
    )
);

export const maskDigiflazzSellerApiKey = (apiKey: string) => (
    apiKey ? `${'*'.repeat(Math.max(apiKey.length - 4, 0))}${apiKey.slice(-4)}` : ''
);

export const verifyDigiflazzSellerRequest = (
    username: string,
    apiKey: string,
    refId: string,
    providedSignature: string
) => {
    if (!username || !apiKey || !refId || !providedSignature) {
        return false;
    }

    const expectedSignature = buildDigiflazzSellerRequestSignature(username, apiKey, refId);
    const normalizedProvidedSignature = normalizeText(providedSignature);

    if (expectedSignature.length !== normalizedProvidedSignature.length) {
        return false;
    }

    return crypto.timingSafeEqual(
        Buffer.from(expectedSignature),
        Buffer.from(normalizedProvidedSignature)
    );
};

export const getDigiflazzSellerStatusShape = (
    status: SellerOrderStatus,
    rc?: string,
    message?: string
) => ({
    statusCode: status === 'success' ? '1' : status === 'failed' ? '2' : '0',
    rc: rc || DEFAULT_RESPONSE_CODES[status],
    message: normalizeText(message) || DEFAULT_MESSAGES[status]
});

export const buildDigiflazzSellerResponse = (
    snapshot: SellerResponseSnapshot,
    reportedBalance: number
) => {
    const shape = getDigiflazzSellerStatusShape(snapshot.status, snapshot.rc, snapshot.message);

    return {
        data: {
            ref_id: snapshot.refId,
            status: shape.statusCode,
            code: snapshot.pulsaCode,
            hp: snapshot.target,
            price: String(Math.round(snapshot.price)),
            message: shape.message,
            balance: String(Math.round(reportedBalance)),
            tr_id: snapshot.trId,
            rc: shape.rc,
            sn: snapshot.sn || ''
        }
    };
};

export const buildDigiflazzSellerErrorResponse = (
    input: {
        refId: string;
        trId?: string;
        pulsaCode?: string;
        target?: string;
        price?: number;
    },
    response: {
        rc: string;
        message: string;
        status?: SellerOrderStatus;
    },
    reportedBalance: number
) => buildDigiflazzSellerResponse({
    refId: input.refId || '-',
    trId: input.trId || input.refId || '-',
    pulsaCode: normalizeText(input.pulsaCode).toLowerCase(),
    target: normalizeText(input.target),
    price: toNonNegativeNumber(input.price, 0),
    status: response.status || 'failed',
    rc: response.rc,
    message: response.message
}, reportedBalance);

export const logDigiflazzSellerEvent = async (input: {
    event: string;
    refId: string;
    status: string;
    message: string;
    verified?: boolean;
    requestIp?: string;
    raw?: Record<string, unknown>;
}) => {
    await WebhookEventLog.create({
        provider: 'digiflazz_seller',
        event: input.event,
        refId: input.refId,
        status: input.status,
        message: input.message,
        verified: Boolean(input.verified),
        requestIp: input.requestIp,
        raw: input.raw
    });
};

export const syncDigiflazzSellerProductMapping = async (
    mapping: IDigiflazzSellerProductMap
): Promise<DigiflazzSellerMappingSyncResult> => {
    const config = await getDigiflazzSellerConfig();
    if (!config.username || !config.apiKey) {
        throw new Error('DIGIFLAZZ_SELLER_CREDENTIALS_REQUIRED');
    }

    const product = await Product.findById(mapping.product).select('costPrice').lean();
    const effectivePrice = getDigiflazzSellerRecommendedPrice(
        product?.costPrice || 0,
        config.sellerMarginFlat,
        mapping.sellerMarginFlat
    );

    mapping.price = effectivePrice;

    const payload = {
        username: config.username,
        pulsa_code: mapping.pulsaCode,
        price: effectivePrice,
        status: mapping.isActive ? 1 : 0,
        sign: buildProductUpdateSignature(config.username, mapping.pulsaCode, config.apiKey)
    };

    try {
        const response = await axios.post(DIGIFLAZZ_SELLER_PRODUCT_UPDATE_URL, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 20000
        });
        const responseData = ((response.data as any)?.data || {}) as Record<string, unknown>;
        const rc = normalizeText(responseData.rc) || '00';
        const message = normalizeText(responseData.message) || 'Success';
        const success = rc === '00';

        mapping.lastSyncStatus = success ? 'success' : 'failed';
        mapping.lastSyncRc = rc;
        mapping.lastSyncMessage = message;
        mapping.lastSyncAt = new Date();
        await mapping.save();

        return { success, rc, message };
    } catch (error: any) {
        const rc = normalizeText(error?.response?.data?.data?.rc) || '07';
        const message = normalizeText(error?.response?.data?.data?.message)
            || normalizeText(error?.message)
            || 'Sync failed';

        mapping.lastSyncStatus = 'failed';
        mapping.lastSyncRc = rc;
        mapping.lastSyncMessage = message;
        mapping.lastSyncAt = new Date();
        await mapping.save();

        return { success: false, rc, message };
    }
};

export const sendDigiflazzSellerCallback = async (
    orderInput: IDigiflazzSellerOrder | string
) => {
    const order = typeof orderInput === 'string'
        ? await DigiflazzSellerOrder.findById(orderInput)
        : orderInput;

    if (!order) {
        return { success: false, message: 'Order not found' };
    }

    const config = await getDigiflazzSellerConfig();
    if (!config.callbackEnabled) {
        order.callbackRequired = true;
        order.callbackAttemptCount += 1;
        order.callbackLastAttemptAt = new Date();
        const retryDelayMinutes = getCallbackRetryDelayMinutes(order.callbackAttemptCount);
        order.callbackNextRetryAt = new Date(Date.now() + retryDelayMinutes * 60 * 1000);
        order.callbackLastMessage = 'Callback dinonaktifkan pada pengaturan Digiflazz Seller';
        await order.save();
        await logDigiflazzSellerEvent({
            event: 'callback-skipped',
            refId: order.refId,
            status: 'skipped',
            message: order.callbackLastMessage,
            verified: false
        });

        return { success: false, message: order.callbackLastMessage };
    }

    const payload = buildDigiflazzSellerResponse({
        refId: order.refId,
        trId: order.trId,
        pulsaCode: order.pulsaCode,
        target: order.target,
        price: order.digiflazzPrice,
        status: order.status,
        rc: order.rc,
        message: order.message,
        sn: order.sn
    }, config.reportedBalance);

    order.callbackAttemptCount += 1;
    order.callbackLastAttemptAt = new Date();

    try {
        const response = await axios.post(config.digiflazzCallbackUrl, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 20000
        });

        order.callbackRequired = false;
        order.callbackDeliveredAt = new Date();
        order.callbackNextRetryAt = undefined;
        order.callbackLastStatusCode = response.status;
        order.callbackLastMessage = normalizeText((response.data as any)?.message) || `HTTP ${response.status}`;
        await order.save();

        await logDigiflazzSellerEvent({
            event: 'callback',
            refId: order.refId,
            status: 'delivered',
            message: order.callbackLastMessage,
            verified: true,
            raw: payload
        });

        return { success: true, message: order.callbackLastMessage };
    } catch (error: any) {
        order.callbackRequired = true;
        const retryDelayMinutes = getCallbackRetryDelayMinutes(order.callbackAttemptCount);
        order.callbackNextRetryAt = new Date(Date.now() + retryDelayMinutes * 60 * 1000);
        order.callbackLastStatusCode = Number(error?.response?.status || 0) || undefined;
        order.callbackLastMessage = normalizeText(error?.response?.data?.message)
            || normalizeText(error?.message)
            || 'Callback failed';
        await order.save();

        await logDigiflazzSellerEvent({
            event: 'callback',
            refId: order.refId,
            status: 'failed',
            message: order.callbackLastMessage,
            verified: false,
            raw: payload
        });

        return { success: false, message: order.callbackLastMessage };
    }
};

export const updateDigiflazzSellerOrderStatus = async (
    orderInput: IDigiflazzSellerOrder | string,
    update: SellerStatusUpdateInput
) => {
    const order = typeof orderInput === 'string'
        ? await DigiflazzSellerOrder.findById(orderInput)
        : orderInput;

    if (!order) {
        return null;
    }

    const previousStatus = order.status;
    const shape = getDigiflazzSellerStatusShape(update.status, update.rc, update.message);

    order.status = update.status;
    order.rc = shape.rc;
    order.message = shape.message;

    if (update.sn !== undefined) {
        order.sn = normalizeText(update.sn) || undefined;
    }

    if (update.vendorTrxId !== undefined) {
        order.vendorTrxId = normalizeText(update.vendorTrxId) || undefined;
    }

    await order.save();

    const hasCallbackHistory = Boolean(order.callbackDeliveredAt)
        || Number(order.callbackAttemptCount || 0) > 0;

    if (previousStatus === 'pending' && update.status !== 'pending' && (order.callbackRequired || !hasCallbackHistory)) {
        await sendDigiflazzSellerCallback(order);
    }

    return order;
};

export const updateDigiflazzSellerOrderByVendorTrxId = async (
    vendorTrxId: string,
    update: SellerStatusUpdateInput
) => {
    const normalizedVendorTrxId = normalizeText(vendorTrxId);
    if (!normalizedVendorTrxId) {
        return null;
    }

    const order = await DigiflazzSellerOrder.findOne({ vendorTrxId: normalizedVendorTrxId });
    if (!order) {
        return null;
    }

    return updateDigiflazzSellerOrderStatus(order, update);
};

export const getDigiflazzSellerRecentLogs = async (limit = 100) => {
    const logs = await WebhookEventLog.find({ provider: 'digiflazz_seller' })
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();

    return logs.map((log) => ({
        id: log._id.toString(),
        timestamp: log.createdAt,
        event: log.event || 'digiflazz_seller',
        refId: log.refId,
        status: log.status,
        message: log.message,
        delivered: log.verified
    }));
};

export const getDigiflazzSellerRecentOrders = async (limit = 50) => {
    const orders = await DigiflazzSellerOrder.find({})
        .sort({ createdAt: -1 })
        .limit(limit)
        .populate('product', 'name code brand vendor status')
        .lean();

    return orders.map((order: any) => ({
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
        vendorTrxId: order.vendorTrxId || '',
        callbackRequired: Boolean(order.callbackRequired),
        callbackAttemptCount: Number(order.callbackAttemptCount || 0),
        callbackDeliveredAt: order.callbackDeliveredAt || null,
        callbackLastAttemptAt: order.callbackLastAttemptAt || null,
        callbackNextRetryAt: order.callbackNextRetryAt || null,
        callbackLastStatusCode: order.callbackLastStatusCode || null,
        callbackLastMessage: order.callbackLastMessage || '',
        requestIp: order.requestIp || '',
        createdAt: order.createdAt,
        updatedAt: order.updatedAt,
        product: order.product ? {
            _id: order.product._id?.toString?.() || '',
            name: order.product.name,
            code: order.product.code,
            brand: order.product.brand,
            vendorName: order.product.vendor?.name || '',
            vendorSku: order.product.vendor?.sku || ''
        } : null
    }));
};
