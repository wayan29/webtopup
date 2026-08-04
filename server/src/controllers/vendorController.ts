import { FastifyRequest, FastifyReply } from 'fastify';
import mongoose from 'mongoose';
import { Vendor, Product, Transaction, WebhookEventLog, DigiflazzSellerOrder } from '../models';
import { AuthRequest } from '../middlewares/authMiddleware';
import { DigiflazzAdapter } from '../vendors/digiflazz';
import { TokovoucherAdapter } from '../vendors/tokovoucher';

const normalizeInput = (value: unknown) => typeof value === 'string' ? value.trim() : '';

const normalizeNonNegativeNumber = (value: unknown, fallback = 0) => {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue) || numericValue < 0) {
        return fallback;
    }

    return Math.floor(numericValue);
};

const csvEscape = (value: unknown) => {
    const text = value === null || value === undefined ? '' : String(value);
    const trimmedStart = text.replace(/^[\s\u0000-\u001f\u007f]+/, '');
    const safe = /^[=+\-@]/.test(trimmedStart) ? `'${text}` : text;
    return `"${safe.replace(/"/g, '""')}"`;
};

const formatCsvDate = (value: unknown) => {
    if (!value) return '';
    const date = new Date(value as string | Date);
    if (Number.isNaN(date.getTime())) return '';
    return date.toISOString();
};

const startOfToday = () => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    return date;
};

const resolveHealthState = (input: {
    configured: boolean;
    balanceOk: boolean;
    lowBalance: boolean;
    pendingCount: number;
    failedCount: number;
    rejectedWebhookCount: number;
}) => {
    if (!input.configured || !input.balanceOk) {
        return 'critical';
    }

    if (input.lowBalance || input.pendingCount > 10 || input.failedCount > 5 || input.rejectedWebhookCount > 0) {
        return 'warning';
    }

    return 'healthy';
};

const getDigiflazzCredentials = (vendor?: { config?: Record<string, any> } | null) => ({
    username: normalizeInput(vendor?.config?.username) || normalizeInput(process.env.DIGIFLAZZ_USERNAME),
    apiKey: normalizeInput(vendor?.config?.apiKey) || normalizeInput(process.env.DIGIFLAZZ_API_KEY)
});

const getTokovoucherCredentials = (vendor?: { config?: Record<string, any> } | null) => ({
    memberCode: normalizeInput(vendor?.config?.memberCode || vendor?.config?.apiKey) || normalizeInput(process.env.TOKOVOUCHER_MEMBER_CODE || process.env.TOKOVOUCHER_API_KEY),
    secret: normalizeInput(vendor?.config?.secret) || normalizeInput(process.env.TOKOVOUCHER_SECRET)
});

// Get Digiflazz balance directly
export const getDigiflazzBalance = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        // First try to get from Vendor collection
        const vendor = await Vendor.findOne({ name: { $regex: /digiflazz/i } });
        const { username, apiKey } = getDigiflazzCredentials(vendor);
        
        if (!username || !apiKey) {
            return reply.status(400).send({ 
                message: 'Digiflazz credentials not configured',
                balance: 0 
            });
        }

        const adapter = new DigiflazzAdapter(username, apiKey);
        const balance = await adapter.getBalance();

        return reply.send({
            success: true,
            balance,
            username: username.substring(0, 4) + '***'
        });
    } catch (error: any) {
        console.error('Error getting Digiflazz balance:', error);
        return reply.status(500).send({ 
            message: error.message || 'Failed to get balance',
            balance: 0 
        });
    }
};

// Get Digiflazz settings
export const getDigiflazzSettings = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const vendor = await Vendor.findOne({ name: { $regex: /digiflazz/i } });
        const { username, apiKey } = getDigiflazzCredentials(vendor);
        
        if (vendor) {
            return reply.send({
                configured: !!(username && apiKey),
                vendorId: vendor._id,
                username,
                apiKey: apiKey ? '***' + apiKey.slice(-4) : '',
                status: vendor.status
            });
        }

        // Fallback to env
        return reply.send({
            configured: !!(username && apiKey),
            vendorId: null,
            username,
            apiKey: apiKey ? '***' + apiKey.slice(-4) : '',
            status: true,
            source: 'env'
        });
    } catch (error) {
        console.error('Error getting Digiflazz settings:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Save Digiflazz settings
export const saveDigiflazzSettings = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { username, apiKey } = request.body as { username?: string; apiKey?: string };
        let vendor = await Vendor.findOne({ name: { $regex: /digiflazz/i } });
        const current = getDigiflazzCredentials(vendor);
        const nextUsername = normalizeInput(username) || current.username;
        const nextApiKey = normalizeInput(apiKey) || current.apiKey;

        if (!nextUsername || !nextApiKey) {
            return reply.status(400).send({ message: 'Username dan API Key wajib tersedia. Lengkapi field yang masih kosong.' });
        }

        // Test connection first
        const adapter = new DigiflazzAdapter(nextUsername, nextApiKey);
        const balance = await adapter.getBalance();

        // Find or create Digiflazz vendor
        if (vendor) {
            vendor.config = {
                ...(vendor.config || {}),
                username: nextUsername,
                apiKey: nextApiKey
            };
            vendor.status = true;
            await vendor.save();
        } else {
            vendor = await Vendor.create({
                name: 'Digiflazz',
                apiBaseUrl: 'https://api.digiflazz.com/v1',
                config: { username: nextUsername, apiKey: nextApiKey },
                status: true
            });
        }

        return reply.send({
            success: true,
            message: 'Settings saved successfully',
            balance,
            vendorId: vendor._id
        });
    } catch (error: any) {
        console.error('Error saving Digiflazz settings:', error);
        return reply.status(400).send({ 
            message: 'Failed to save settings. Check your credentials.',
            error: error.message
        });
    }
};

// Fetch pricelist from Digiflazz API and save to dgcache collection
export const fetchDigiflazzPricelist = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const vendor = await Vendor.findOne({ name: { $regex: /digiflazz/i } });
        const { username, apiKey } = getDigiflazzCredentials(vendor);

        if (!username || !apiKey) {
            return reply.status(400).send({ message: 'Digiflazz credentials not configured' });
        }

        const adapter = new DigiflazzAdapter(username, apiKey);
        const pricelist = await adapter.getPriceList();

        if (!pricelist || pricelist.length === 0) {
            return reply.status(400).send({ message: 'Gagal mengambil pricelist dari Digiflazz' });
        }

        // Get dgcache collection from main database
        const db = mongoose.connection.db;
        if (!db) {
            return reply.status(500).send({ message: 'Database connection failed' });
        }

        const collection = db.collection('dgcache');

        // Clear old data and insert new
        await collection.deleteMany({});
        await collection.insertMany(pricelist);

        // Create indexes for faster queries
        await collection.createIndex({ category: 1 });
        await collection.createIndex({ brand: 1 });
        await collection.createIndex({ buyer_sku_code: 1 });
        await collection.createIndex({ product_name: 'text' });

        return reply.send({
            success: true,
            message: `Berhasil mengambil ${pricelist.length} produk dari Digiflazz`,
            total: pricelist.length
        });
    } catch (error: any) {
        console.error('Error fetching Digiflazz pricelist:', error);
        return reply.status(500).send({
            message: 'Gagal mengambil pricelist dari Digiflazz',
            error: error.message
        });
    }
};

// Get Digiflazz pricelist from dgcache collection (main database)
export const getDigiflazzPricelist = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { category, brand, sku, search, page = 1, limit = 50 } = request.query as {
            category?: string;
            brand?: string;
            sku?: string;
            search?: string;
            page?: number;
            limit?: number;
        };

        const db = mongoose.connection.db;
        if (!db) {
            return reply.status(500).send({ message: 'Database connection failed' });
        }

        const collection = db.collection('dgcache');
        const total = await collection.countDocuments({});

        if (total === 0) {
            return reply.send({
                success: false,
                message: 'Pricelist kosong. Klik "Get Pricelist" di halaman settings Digiflazz untuk mengambil data.',
                data: [],
                total: 0,
                filters: { categories: [], brands: [] }
            });
        }

        // Build query
        const query: any = {};
        if (category) query.category = { $regex: category, $options: 'i' };
        if (brand) query.brand = { $regex: brand, $options: 'i' };
        if (sku) query.buyer_sku_code = { $regex: sku, $options: 'i' };
        if (search) {
            query.$or = [
                { product_name: { $regex: search, $options: 'i' } },
                { buyer_sku_code: { $regex: search, $options: 'i' } },
                { brand: { $regex: search, $options: 'i' } }
            ];
        }

        const skip = (Number(page) - 1) * Number(limit);

        // Build filter queries
        const categoryFilterQuery: any = {};
        if (brand) categoryFilterQuery.brand = { $regex: brand, $options: 'i' };

        const brandFilterQuery: any = {};
        if (category) brandFilterQuery.category = { $regex: category, $options: 'i' };

        const [data, filteredTotal, categories, brands] = await Promise.all([
            collection.find(query).skip(skip).limit(Number(limit)).toArray(),
            collection.countDocuments(query),
            collection.distinct('category', categoryFilterQuery),
            collection.distinct('brand', brandFilterQuery)
        ]);

        return reply.send({
            success: true,
            data,
            total: filteredTotal,
            page: Number(page),
            limit: Number(limit),
            totalPages: Math.ceil(filteredTotal / Number(limit)),
            filters: {
                categories,
                brands
            }
        });
    } catch (error: any) {
        console.error('Error fetching Digiflazz pricelist:', error);
        return reply.status(500).send({
            message: 'Failed to fetch pricelist',
            error: error.message
        });
    }
};

// ===================== TOKOVOUCHER =====================

// Get Tokovoucher balance
export const getTokovoucherBalance = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const vendor = await Vendor.findOne({ name: { $regex: /tokovoucher/i } });
        const { memberCode, secret } = getTokovoucherCredentials(vendor);
        
        if (!memberCode || !secret) {
            return reply.status(400).send({ 
                message: 'Tokovoucher credentials not configured',
                balance: 0 
            });
        }

        const adapter = new TokovoucherAdapter(memberCode, secret);
        const balance = await adapter.getBalance();

        return reply.send({
            success: true,
            balance,
            memberCode: memberCode.substring(0, 4) + '***'
        });
    } catch (error: any) {
        console.error('Error getting Tokovoucher balance:', error);
        return reply.status(500).send({ 
            message: error.message || 'Failed to get balance',
            balance: 0 
        });
    }
};

const buildVendorHealthPayload = async () => {
    const today = startOfToday();
    const [digiflazzVendor, tokovoucherVendor] = await Promise.all([
            Vendor.findOne({ name: { $regex: /digiflazz/i } }).lean(),
            Vendor.findOne({ name: { $regex: /tokovoucher/i } }).lean()
        ]);

        const digiflazzCredentials = getDigiflazzCredentials(digiflazzVendor);
        const tokovoucherCredentials = getTokovoucherCredentials(tokovoucherVendor);

        const getBalanceSafe = async (name: 'digiflazz' | 'tokovoucher') => {
            try {
                if (name === 'digiflazz') {
                    if (!digiflazzCredentials.username || !digiflazzCredentials.apiKey) {
                        return { success: false, balance: 0, message: 'Credentials belum dikonfigurasi' };
                    }

                    const adapter = new DigiflazzAdapter(
                        digiflazzCredentials.username,
                        digiflazzCredentials.apiKey,
                        digiflazzVendor?.apiBaseUrl || process.env.DIGIFLAZZ_BASE_URL
                    );
                    return { success: true, balance: await adapter.getBalance(), message: 'OK' };
                }

                if (!tokovoucherCredentials.memberCode || !tokovoucherCredentials.secret) {
                    return { success: false, balance: 0, message: 'Credentials belum dikonfigurasi' };
                }

                const adapter = new TokovoucherAdapter(
                    tokovoucherCredentials.memberCode,
                    tokovoucherCredentials.secret,
                    tokovoucherVendor?.apiBaseUrl || process.env.TOKOVOUCHER_BASE_URL
                );
                return { success: true, balance: await adapter.getBalance(), message: 'OK' };
            } catch (error: any) {
                return {
                    success: false,
                    balance: 0,
                    message: error?.message || 'Gagal cek saldo'
                };
            }
        };

        const [balances, transactionStats, webhookStats, lastWebhookLogs, sellerSummary] = await Promise.all([
            Promise.all([
                getBalanceSafe('digiflazz'),
                getBalanceSafe('tokovoucher')
            ]),
            Transaction.aggregate([
                { $match: { createdAt: { $gte: today } } },
                {
                    $lookup: {
                        from: Product.collection.name,
                        localField: 'product',
                        foreignField: '_id',
                        as: 'product'
                    }
                },
                { $unwind: { path: '$product', preserveNullAndEmptyArrays: true } },
                {
                    $group: {
                        _id: { $ifNull: ['$product.vendor.name', 'Unknown'] },
                        total: { $sum: 1 },
                        success: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
                        failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
                        pending: { $sum: { $cond: [{ $in: ['$status', ['pending', 'processing']] }, 1, 0] } },
                        amountTotal: { $sum: '$amount' }
                    }
                }
            ]),
            WebhookEventLog.aggregate([
                { $match: { createdAt: { $gte: today } } },
                {
                    $group: {
                        _id: '$provider',
                        total: { $sum: 1 },
                        rejected: { $sum: { $cond: [{ $eq: ['$status', 'rejected'] }, 1, 0] } },
                        failed: { $sum: { $cond: [{ $in: ['$status', ['failed', 'error']] }, 1, 0] } },
                        delivered: { $sum: { $cond: ['$verified', 1, 0] } }
                    }
                }
            ]),
            WebhookEventLog.aggregate([
                { $sort: { createdAt: -1 } },
                {
                    $group: {
                        _id: '$provider',
                        lastAt: { $first: '$createdAt' },
                        lastStatus: { $first: '$status' },
                        lastMessage: { $first: '$message' }
                    }
                }
            ]),
            DigiflazzSellerOrder.aggregate([
                {
                    $group: {
                        _id: null,
                        total: { $sum: 1 },
                        pending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
                        failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
                        callbackPending: { $sum: { $cond: [{ $eq: ['$callbackRequired', true] }, 1, 0] } },
                        callbackDelivered: { $sum: { $cond: [{ $ne: [{ $ifNull: ['$callbackDeliveredAt', null] }, null] }, 1, 0] } }
                    }
                }
            ])
        ]);

        const transactionByVendor = new Map(transactionStats.map((item: any) => [String(item._id).toLowerCase(), item]));
        const webhookByProvider = new Map(webhookStats.map((item: any) => [String(item._id), item]));
        const lastWebhookByProvider = new Map(lastWebhookLogs.map((item: any) => [String(item._id), item]));
        const seller = sellerSummary[0] || { total: 0, pending: 0, failed: 0, callbackPending: 0, callbackDelivered: 0 };

        const buildVendor = (
            key: 'digiflazz' | 'tokovoucher',
            label: string,
            configured: boolean,
            active: boolean,
            lowBalanceThreshold: number,
            balance: { success: boolean; balance: number; message: string }
        ) => {
            const tx = Array.from(transactionByVendor.entries()).find(([name]) => name.includes(key))?.[1] || {};
            const hook = webhookByProvider.get(key) || {};
            const lastHook = lastWebhookByProvider.get(key) || {};
            const total = Number(tx.total || 0);
            const success = Number(tx.success || 0);
            const failed = Number(tx.failed || 0);
            const pending = Number(tx.pending || 0);
            const successRate = total > 0 ? Math.round((success / total) * 100) : 0;
            const lowBalance = balance.success && lowBalanceThreshold > 0 && balance.balance <= lowBalanceThreshold;

            return {
                key,
                label,
                configured,
                active,
                balance: balance.balance,
                balanceOk: balance.success,
                lowBalanceThreshold,
                lowBalance,
                balanceMessage: balance.message,
                health: resolveHealthState({
                    configured,
                    balanceOk: balance.success,
                    lowBalance,
                    pendingCount: pending,
                    failedCount: failed,
                    rejectedWebhookCount: Number(hook.rejected || 0)
                }),
                transactionsToday: {
                    total,
                    success,
                    failed,
                    pending,
                    successRate,
                    amountTotal: Number(tx.amountTotal || 0)
                },
                webhookToday: {
                    total: Number(hook.total || 0),
                    rejected: Number(hook.rejected || 0),
                    failed: Number(hook.failed || 0),
                    delivered: Number(hook.delivered || 0),
                    lastAt: lastHook.lastAt || null,
                    lastStatus: lastHook.lastStatus || '',
                    lastMessage: lastHook.lastMessage || ''
                }
            };
        };

    return {
        generatedAt: new Date(),
        vendors: [
            buildVendor(
                'digiflazz',
                'Digiflazz',
                Boolean(digiflazzCredentials.username && digiflazzCredentials.apiKey),
                digiflazzVendor?.status !== false,
                normalizeNonNegativeNumber(digiflazzVendor?.lowBalanceThreshold),
                balances[0]
            ),
            buildVendor(
                'tokovoucher',
                'Tokovoucher',
                Boolean(tokovoucherCredentials.memberCode && tokovoucherCredentials.secret),
                tokovoucherVendor?.status !== false,
                normalizeNonNegativeNumber(tokovoucherVendor?.lowBalanceThreshold),
                balances[1]
            )
        ],
        seller: {
            total: Number(seller.total || 0),
            pending: Number(seller.pending || 0),
            failed: Number(seller.failed || 0),
            callbackPending: Number(seller.callbackPending || 0),
            callbackDelivered: Number(seller.callbackDelivered || 0),
            health: Number(seller.callbackPending || 0) > 0 || Number(seller.failed || 0) > 5 ? 'warning' : 'healthy'
        }
    };
};

const buildVendorHealthCsv = (payload: Awaited<ReturnType<typeof buildVendorHealthPayload>>) => {
    const header = [
        'Vendor',
        'Health',
        'Configured',
        'Active',
        'Balance',
        'Balance OK',
        'Low Balance Threshold',
        'Low Balance',
        'Balance Message',
        'Transactions Today',
        'Success Today',
        'Failed Today',
        'Pending Today',
        'Success Rate',
        'Amount Total',
        'Webhook Total',
        'Webhook Rejected',
        'Webhook Failed',
        'Webhook Delivered',
        'Last Webhook At',
        'Last Webhook Status',
        'Last Webhook Message',
        'Generated At'
    ];

    const rows = payload.vendors.map((vendor) => ([
        vendor.label,
        vendor.health,
        vendor.configured ? 'yes' : 'no',
        vendor.active ? 'yes' : 'no',
        vendor.balance,
        vendor.balanceOk ? 'yes' : 'no',
        vendor.lowBalanceThreshold,
        vendor.lowBalance ? 'yes' : 'no',
        vendor.balanceMessage,
        vendor.transactionsToday.total,
        vendor.transactionsToday.success,
        vendor.transactionsToday.failed,
        vendor.transactionsToday.pending,
        vendor.transactionsToday.successRate,
        vendor.transactionsToday.amountTotal,
        vendor.webhookToday.total,
        vendor.webhookToday.rejected,
        vendor.webhookToday.failed,
        vendor.webhookToday.delivered,
        formatCsvDate(vendor.webhookToday.lastAt),
        vendor.webhookToday.lastStatus,
        vendor.webhookToday.lastMessage,
        formatCsvDate(payload.generatedAt)
    ]));

    return [header, ...rows]
        .map((row) => row.map(csvEscape).join(','))
        .join('\n');
};

export const getVendorHealth = async (_request: AuthRequest, reply: FastifyReply) => {
    try {
        return reply.send(await buildVendorHealthPayload());
    } catch (error) {
        console.error('Error fetching vendor health:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const exportVendorHealthCsv = async (_request: AuthRequest, reply: FastifyReply) => {
    try {
        const payload = await buildVendorHealthPayload();
        const csv = buildVendorHealthCsv(payload);
        const filename = `vendor-health-${new Date().toISOString().slice(0, 10)}.csv`;

        return reply
            .header('Content-Type', 'text/csv; charset=utf-8')
            .header('Content-Disposition', `attachment; filename="${filename}"`)
            .send(`\uFEFF${csv}`);
    } catch (error) {
        console.error('Error exporting vendor health:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Get Tokovoucher settings
export const getTokovoucherSettings = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const vendor = await Vendor.findOne({ name: { $regex: /tokovoucher/i } });
        const { memberCode, secret } = getTokovoucherCredentials(vendor);
        
        if (vendor) {
            return reply.send({
                configured: !!(memberCode && secret),
                vendorId: vendor._id,
                memberCode,
                secret: secret ? '***' + secret.slice(-4) : '',
                status: vendor.status
            });
        }

        // Fallback to env
        return reply.send({
            configured: !!(memberCode && secret),
            vendorId: null,
            memberCode,
            secret: secret ? '***' + secret.slice(-4) : '',
            status: true,
            source: 'env'
        });
    } catch (error) {
        console.error('Error getting Tokovoucher settings:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Save Tokovoucher settings
export const saveTokovoucherSettings = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { memberCode, secret } = request.body as { memberCode?: string; secret?: string };
        let vendor = await Vendor.findOne({ name: { $regex: /tokovoucher/i } });
        const current = getTokovoucherCredentials(vendor);
        const nextMemberCode = normalizeInput(memberCode) || current.memberCode;
        const nextSecret = normalizeInput(secret) || current.secret;

        if (!nextMemberCode || !nextSecret) {
            return reply.status(400).send({ message: 'Member Code dan Secret wajib tersedia. Lengkapi field yang masih kosong.' });
        }

        // Test connection first
        const adapter = new TokovoucherAdapter(nextMemberCode, nextSecret);
        const balance = await adapter.getBalance();

        // Find or create Tokovoucher vendor
        if (vendor) {
            vendor.config = {
                ...(vendor.config || {}),
                memberCode: nextMemberCode,
                secret: nextSecret
            };
            vendor.status = true;
            await vendor.save();
        } else {
            vendor = await Vendor.create({
                name: 'Tokovoucher',
                slug: 'tokovoucher',
                apiBaseUrl: 'https://api.tokovoucher.id',
                config: { memberCode: nextMemberCode, secret: nextSecret },
                status: true
            });
        }

        return reply.send({
            success: true,
            message: 'Settings saved successfully',
            balance,
            vendorId: vendor._id
        });
    } catch (error: any) {
        console.error('Error saving Tokovoucher settings:', error);
        return reply.status(400).send({ 
            message: 'Failed to save settings. Check your credentials.',
            error: error.message
        });
    }
};

// Get Tokovoucher categories
export const getTokovoucherCategories = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const vendor = await Vendor.findOne({ name: { $regex: /tokovoucher/i } });
        const { memberCode, secret } = getTokovoucherCredentials(vendor);
        
        if (!memberCode || !secret) {
            return reply.status(400).send({ 
                success: false,
                message: 'Tokovoucher credentials not configured',
                data: []
            });
        }

        const adapter = new TokovoucherAdapter(memberCode, secret);
        const categories = await adapter.getCategories();

        return reply.send({
            success: true,
            data: categories
        });
    } catch (error: any) {
        console.error('Error fetching Tokovoucher categories:', error);
        return reply.status(500).send({ 
            success: false,
            message: 'Failed to fetch categories',
            error: error.message 
        });
    }
};

// Get Tokovoucher operators by category
export const getTokovoucherOperators = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { categoryId } = request.query as { categoryId: string };
        
        if (!categoryId) {
            return reply.status(400).send({ 
                success: false,
                message: 'categoryId is required',
                data: []
            });
        }

        const vendor = await Vendor.findOne({ name: { $regex: /tokovoucher/i } });
        const { memberCode, secret } = getTokovoucherCredentials(vendor);
        
        if (!memberCode || !secret) {
            return reply.status(400).send({ 
                success: false,
                message: 'Tokovoucher credentials not configured',
                data: []
            });
        }

        const adapter = new TokovoucherAdapter(memberCode, secret);
        const operators = await adapter.getOperators(Number(categoryId));

        return reply.send({
            success: true,
            data: operators
        });
    } catch (error: any) {
        console.error('Error fetching Tokovoucher operators:', error);
        return reply.status(500).send({ 
            success: false,
            message: 'Failed to fetch operators',
            error: error.message 
        });
    }
};

// Get Tokovoucher jenis by operator
export const getTokovoucherJenis = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { operatorId } = request.query as { operatorId: string };
        
        if (!operatorId) {
            return reply.status(400).send({ 
                success: false,
                message: 'operatorId is required',
                data: []
            });
        }

        const vendor = await Vendor.findOne({ name: { $regex: /tokovoucher/i } });
        const { memberCode, secret } = getTokovoucherCredentials(vendor);
        
        if (!memberCode || !secret) {
            return reply.status(400).send({ 
                success: false,
                message: 'Tokovoucher credentials not configured',
                data: []
            });
        }

        const adapter = new TokovoucherAdapter(memberCode, secret);
        const jenis = await adapter.getJenis(Number(operatorId));

        return reply.send({
            success: true,
            data: jenis
        });
    } catch (error: any) {
        console.error('Error fetching Tokovoucher jenis:', error);
        return reply.status(500).send({ 
            success: false,
            message: 'Failed to fetch jenis',
            error: error.message 
        });
    }
};

// Get Tokovoucher products by jenis
export const getTokovoucherProducts = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { jenisId } = request.query as { jenisId: string };
        
        if (!jenisId) {
            return reply.status(400).send({ 
                success: false,
                message: 'jenisId is required',
                data: []
            });
        }

        const vendor = await Vendor.findOne({ name: { $regex: /tokovoucher/i } });
        const { memberCode, secret } = getTokovoucherCredentials(vendor);
        
        if (!memberCode || !secret) {
            return reply.status(400).send({ 
                success: false,
                message: 'Tokovoucher credentials not configured',
                data: []
            });
        }

        const adapter = new TokovoucherAdapter(memberCode, secret);
        const products = await adapter.getProducts(Number(jenisId));

        return reply.send({
            success: true,
            data: products
        });
    } catch (error: any) {
        console.error('Error fetching Tokovoucher products:', error);
        return reply.status(500).send({ 
            success: false,
            message: 'Failed to fetch products',
            error: error.message 
        });
    }
};

// Search Tokovoucher products by SKU code or prefix
export const searchTokovoucherByCode = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { kode } = request.query as { kode: string };
        
        if (!kode) {
            return reply.status(400).send({ 
                success: false,
                message: 'kode is required',
                data: []
            });
        }

        const vendor = await Vendor.findOne({ name: { $regex: /tokovoucher/i } });
        const { memberCode, secret } = getTokovoucherCredentials(vendor);
        
        if (!memberCode || !secret) {
            return reply.status(400).send({ 
                success: false,
                message: 'Tokovoucher credentials not configured',
                data: []
            });
        }

        const adapter = new TokovoucherAdapter(memberCode, secret);
        const products = await adapter.searchByCode(kode);

        return reply.send({
            success: true,
            data: products,
            total: products.length
        });
    } catch (error: any) {
        console.error('Error searching Tokovoucher products:', error);
        return reply.status(500).send({ 
            success: false,
            message: 'Failed to search products',
            error: error.message 
        });
    }
};

// Get all vendors
export const getVendors = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const vendors = await Vendor.find().sort({ createdAt: -1 });
        return reply.send(vendors);
    } catch (error) {
        console.error('Error fetching vendors:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Get vendor by ID
export const getVendorById = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };
        const vendor = await Vendor.findById(id);

        if (!vendor) {
            return reply.status(404).send({ message: 'Vendor not found' });
        }

        return reply.send(vendor);
    } catch (error) {
        console.error('Error fetching vendor:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Create new vendor
export const createVendor = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { name, apiBaseUrl, config, lowBalanceThreshold, status } = request.body as any;

        // Check if vendor already exists
        const existingVendor = await Vendor.findOne({ name });
        if (existingVendor) {
            return reply.status(400).send({ message: 'Vendor already exists' });
        }

        const vendor = await Vendor.create({
            name,
            apiBaseUrl,
            config,
            lowBalanceThreshold: normalizeNonNegativeNumber(lowBalanceThreshold),
            status: status !== undefined ? status : true
        });

        return reply.status(201).send({
            message: 'Vendor created successfully',
            vendor
        });
    } catch (error) {
        console.error('Error creating vendor:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Update vendor
export const updateVendor = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };
        const { name, apiBaseUrl, config, lowBalanceThreshold, status } = request.body as any;

        const vendor = await Vendor.findById(id);
        if (!vendor) {
            return reply.status(404).send({ message: 'Vendor not found' });
        }

        // Update fields
        if (name !== undefined) vendor.name = name;
        if (apiBaseUrl !== undefined) vendor.apiBaseUrl = apiBaseUrl;
        if (config !== undefined) vendor.config = config;
        if (lowBalanceThreshold !== undefined) vendor.lowBalanceThreshold = normalizeNonNegativeNumber(lowBalanceThreshold, vendor.lowBalanceThreshold || 0);
        if (status !== undefined) vendor.status = status;

        await vendor.save();

        return reply.send({
            message: 'Vendor updated successfully',
            vendor
        });
    } catch (error) {
        console.error('Error updating vendor:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Delete vendor
export const deleteVendor = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };

        // Check if vendor exists
        const vendor = await Vendor.findById(id);
        if (!vendor) {
            return reply.status(404).send({ message: 'Vendor not found' });
        }

        // Check if any products are using this vendor
        const productsCount = await Product.countDocuments({ 'vendor.name': vendor.name });
        if (productsCount > 0) {
            return reply.status(400).send({
                message: `Cannot delete vendor. ${productsCount} products are using this vendor.`
            });
        }

        await Vendor.findByIdAndDelete(id);

        return reply.send({ message: 'Vendor deleted successfully' });
    } catch (error) {
        console.error('Error deleting vendor:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Test vendor connection
export const testVendorConnection = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };

        const vendor = await Vendor.findById(id);
        if (!vendor) {
            return reply.status(404).send({ message: 'Vendor not found' });
        }

        let result: any = {
            success: false,
            message: 'Unknown vendor type',
            balance: 0
        };

        // Test connection based on vendor name
        if (vendor.name.toLowerCase().includes('digiflazz')) {
            try {
                const adapter = new DigiflazzAdapter(
                    vendor.config.username || process.env.DIGIFLAZZ_USERNAME || '',
                    vendor.config.apiKey || process.env.DIGIFLAZZ_API_KEY || '',
                    vendor.apiBaseUrl || process.env.DIGIFLAZZ_BASE_URL
                );

                const balance = await adapter.getBalance();
                result = {
                    success: true,
                    message: 'Connection successful',
                    balance: balance
                };
            } catch (error: any) {
                result = {
                    success: false,
                    message: 'Connection failed: ' + error.message,
                    balance: 0
                };
            }
        } else if (vendor.name.toLowerCase().includes('tokovoucher')) {
            try {
                const adapter = new TokovoucherAdapter(
                    vendor.config.memberCode || vendor.config.apiKey || process.env.TOKOVOUCHER_MEMBER_CODE || process.env.TOKOVOUCHER_API_KEY || '',
                    vendor.config.secret || process.env.TOKOVOUCHER_SECRET || '',
                    vendor.apiBaseUrl || process.env.TOKOVOUCHER_BASE_URL
                );
                const balance = await adapter.getBalance();
                result = {
                    success: true,
                    message: 'Connection successful',
                    balance
                };
            } catch (error: any) {
                result = {
                    success: false,
                    message: 'Connection failed: ' + error.message,
                    balance: 0
                };
            }
        }

        return reply.send(result);
    } catch (error) {
        console.error('Error testing vendor connection:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Sync products from vendor
export const syncVendorProducts = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };

        const vendor = await Vendor.findById(id);
        if (!vendor) {
            return reply.status(404).send({ message: 'Vendor not found' });
        }

        let syncedCount = 0;
        let errorMessage = '';

        // Sync products based on vendor name
        if (vendor.name.toLowerCase().includes('digiflazz')) {
            try {
                const adapter = new DigiflazzAdapter(
                    vendor.config.username || process.env.DIGIFLAZZ_USERNAME || '',
                    vendor.config.apiKey || process.env.DIGIFLAZZ_API_KEY || '',
                    vendor.apiBaseUrl || process.env.DIGIFLAZZ_BASE_URL
                );

                const priceList = await adapter.getPriceList();

                // Process and save products
                for (const item of priceList) {
                    const code = item.buyer_sku_code;
                    const name = item.product_name;
                    const category = item.category;
                    const brand = item.brand;
                    const price = item.price;
                    const status = item.seller_product_status;

                    // Check if product already exists
                    const existingProduct = await Product.findOne({ code });

                    if (existingProduct) {
                        // Update existing product
                        existingProduct.name = name;
                        existingProduct.category = category;
                        existingProduct.brand = brand;
                        existingProduct.price.basic = price;
                        existingProduct.price.gold = price * 0.98; // 2% discount for gold
                        existingProduct.price.platinum = price * 0.95; // 5% discount for platinum
                        existingProduct.vendor = {
                            name: vendor.name,
                            sku: code
                        };
                        existingProduct.status = status;
                        await existingProduct.save();
                    } else {
                        // Create new product
                        await Product.create({
                            code,
                            name,
                            category,
                            brand,
                            price: {
                                basic: price,
                                gold: price * 0.98,
                                platinum: price * 0.95
                            },
                            vendor: {
                                name: vendor.name,
                                sku: code
                            },
                            status
                        });
                    }
                    syncedCount++;
                }
            } catch (error: any) {
                errorMessage = error.message;
            }
        } else if (vendor.name.toLowerCase().includes('tokovoucher')) {
            try {
                const adapter = new TokovoucherAdapter(
                    vendor.config.memberCode || vendor.config.apiKey || process.env.TOKOVOUCHER_MEMBER_CODE || process.env.TOKOVOUCHER_API_KEY || '',
                    vendor.config.secret || process.env.TOKOVOUCHER_SECRET || '',
                    vendor.apiBaseUrl || process.env.TOKOVOUCHER_BASE_URL
                );
                const priceList = await adapter.getPriceList();

                for (const item of priceList) {
                    const code = item.buyer_sku_code || item.sku_code || item.code;
                    const name = item.product_name || item.name;
                    const category = item.category || item.type || 'others';
                    const brand = item.brand || item.provider || 'tokovoucher';
                    const price = item.price || item.price_default || 0;
                    const status = item.seller_product_status ?? item.status ?? item.active ?? false;

                    if (!code) continue;

                    const existingProduct = await Product.findOne({ code });

                    if (existingProduct) {
                        existingProduct.name = name;
                        existingProduct.category = category;
                        existingProduct.brand = brand;
                        existingProduct.price.basic = price;
                        existingProduct.price.gold = price * 0.98;
                        existingProduct.price.platinum = price * 0.95;
                        existingProduct.vendor = {
                            name: vendor.name,
                            sku: code
                        };
                        existingProduct.status = status;
                        await existingProduct.save();
                    } else {
                        await Product.create({
                            code,
                            name,
                            category,
                            brand,
                            price: {
                                basic: price,
                                gold: price * 0.98,
                                platinum: price * 0.95
                            },
                            vendor: {
                                name: vendor.name,
                                sku: code
                            },
                            status
                        });
                    }
                    syncedCount++;
                }
            } catch (error: any) {
                errorMessage = error.message;
            }
        } else {
            errorMessage = 'Vendor type not supported for sync';
        }

        if (errorMessage) {
            return reply.status(400).send({
                message: 'Sync failed: ' + errorMessage,
                syncedCount: 0
            });
        }

        return reply.send({
            message: `Successfully synced ${syncedCount} products from ${vendor.name}`,
            syncedCount
        });
    } catch (error) {
        console.error('Error syncing vendor products:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Get vendor statistics
export const getVendorStats = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };

        const vendor = await Vendor.findById(id);
        if (!vendor) {
            return reply.status(404).send({ message: 'Vendor not found' });
        }

        // Count products using this vendor
        const productsCount = await Product.countDocuments({ 'vendor.name': vendor.name });
        const activeProductsCount = await Product.countDocuments({
            'vendor.name': vendor.name,
            status: true
        });

        // Get categories
        const categories = await Product.distinct('category', { 'vendor.name': vendor.name });

        return reply.send({
            vendorName: vendor.name,
            totalProducts: productsCount,
            activeProducts: activeProductsCount,
            categories: categories,
            status: vendor.status
        });
    } catch (error) {
        console.error('Error fetching vendor stats:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};
