import { FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'crypto';
import { User, Product, Transaction } from '../models';
import { AuthRequest } from '../middlewares/authMiddleware';
import vendorService from '../services/vendorService';
import { awardPoints } from '../services/pointsService';
import { generateRefId } from '../services/idGeneratorService';

// Generate unique API key
const generateApiKey = (): string => {
    const prefix = 'tv';
    const key = crypto.randomBytes(24).toString('hex');
    return `${prefix}_${key}`;
};

// Generate API Key for user
export const generateUserApiKey = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const userId = request.user!.id;

        const user = await User.findById(userId);
        if (!user) {
            return reply.status(404).send({ message: 'User not found' });
        }

        // Only members can have API keys
        if (user.role !== 'member') {
            return reply.status(403).send({ message: 'Only members can generate API keys' });
        }

        // Live traffic uses Rust key handlers. Keep this legacy path complete so a partial
        // credential (key without secret/memberCode) cannot be written if it is ever hit.
        const apiKey = generateApiKey();
        const apiSecret = crypto.randomBytes(24).toString('hex');
        const memberCode = user.memberCode || `MBR${String(user._id).slice(-8).toUpperCase()}`;
        user.apiKey = apiKey;
        user.apiSecret = apiSecret;
        user.memberCode = memberCode;
        await user.save();

        return reply.send({
            message: 'API key generated successfully',
            memberId: memberCode,
            apiKey,
            secret: apiSecret,
        });
    } catch (error) {
        console.error('Generate API key error:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Get user's API key
export const getUserApiKey = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const userId = request.user!.id;

        const user = await User.findById(userId).select('apiKey apiSecret memberCode');
        if (!user) {
            return reply.status(404).send({ message: 'User not found' });
        }

        // Do not re-expose apiSecret on status reads; secret is one-time at generate.
        return reply.send({
            memberId: user.memberCode || null,
            apiKey: user.apiKey || null,
            secret: null,
            hasApiKey: !!user.apiKey,
            hasSecret: !!user.apiSecret,
        });
    } catch (error) {
        console.error('Get API key error:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Revoke API key
export const revokeApiKey = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const userId = request.user!.id;

        const user = await User.findById(userId);
        if (!user) {
            return reply.status(404).send({ message: 'User not found' });
        }

        user.apiKey = undefined;
        user.apiSecret = undefined;
        await user.save();

        return reply.send({ message: 'API key revoked successfully' });
    } catch (error) {
        console.error('Revoke API key error:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// ============ Open API Endpoints (using API key auth) ============

export interface ApiKeyRequest extends FastifyRequest {
    apiUser?: {
        id: string;
        email: string;
        level: string;
        balance: number;
    };
    user?: AuthRequest['user'];
}

const firstString = (value: unknown): string | undefined => {
    if (Array.isArray(value)) {
        return firstString(value[0]);
    }
    return typeof value === 'string' ? value.trim() : undefined;
};

const requestValue = (request: FastifyRequest, keys: string[]): string | undefined => {
    const query = request.query as Record<string, unknown> | undefined;
    const body = request.body as Record<string, unknown> | undefined;
    const headers = request.headers as Record<string, unknown>;

    for (const key of keys) {
        const value = firstString(query?.[key]) || firstString(body?.[key]) || firstString(headers[key.toLowerCase()]);
        if (value) {
            return value;
        }
    }

    return undefined;
};

const md5 = (value: string) => crypto.createHash('md5').update(value).digest('hex');

const timingSafeEqualHex = (left: string, right: string) => {
    const leftBuffer = Buffer.from(left.toLowerCase(), 'hex');
    const rightBuffer = Buffer.from(right.toLowerCase(), 'hex');
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const setApiUser = (request: ApiKeyRequest, user: { _id: { toString(): string }; email: string; level: string; balance: number }) => {
    const id = user._id.toString();
    request.apiUser = {
        id,
        email: user.email,
        level: user.level,
        balance: user.balance
    };
    request.user = {
        id,
        email: user.email,
        role: 'member'
    };
};

// Middleware to authenticate via API key
export const authenticateApiKey = async (request: ApiKeyRequest, reply: FastifyReply) => {
    try {
        const apiKey = request.headers['x-api-key'] as string;

        if (!apiKey) {
            return reply.status(401).send({
                success: false,
                message: 'API key is required. Use X-API-Key header.'
            });
        }

        const user = await User.findOne({ apiKey, role: 'member', active: { $ne: false } })
            .select('_id email level balance');

        if (!user) {
            return reply.status(401).send({
                success: false,
                message: 'Invalid API key'
            });
        }

        setApiUser(request, user);
    } catch (error) {
        console.error('API key auth error:', error);
        return reply.status(500).send({
            success: false,
            message: 'Authentication error'
        });
    }
};

export const authenticateOpenApiSignature = async (request: ApiKeyRequest, reply: FastifyReply) => {
    try {
        const memberId = requestValue(request, ['member_id', 'memberId', 'memberCode']);
        const apiKey = requestValue(request, ['api_key', 'apiKey', 'x-api-key']);
        const signature = requestValue(request, ['signature']);
        const refId = requestValue(request, ['ref_id', 'refId']);

        if (!memberId || !apiKey || !signature) {
            return reply.status(401).send({
                success: false,
                message: 'member_id, api_key, and signature are required'
            });
        }

        if (!/^[a-f0-9]{32}$/i.test(signature)) {
            return reply.status(401).send({
                success: false,
                message: 'Invalid signature'
            });
        }

        const user = await User.findOne({
            memberCode: memberId,
            apiKey,
            role: 'member',
            active: { $ne: false }
        }).select('_id email level balance apiSecret');

        if (!user?.apiSecret) {
            return reply.status(401).send({
                success: false,
                message: 'Invalid member_id or api_key'
            });
        }

        const expected = md5(refId ? `${memberId}:${apiKey}:${user.apiSecret}:${refId}` : `${memberId}:${apiKey}:${user.apiSecret}`);
        if (!timingSafeEqualHex(signature, expected)) {
            return reply.status(401).send({
                success: false,
                message: 'Invalid signature'
            });
        }

        setApiUser(request, user);
    } catch (error) {
        console.error('Open API signature auth error:', error);
        return reply.status(500).send({
            success: false,
            message: 'Authentication error'
        });
    }
};

// API: Get profile/balance
export const apiGetProfile = async (request: ApiKeyRequest, reply: FastifyReply) => {
    try {
        const user = await User.findById(request.apiUser!.id)
            .select('name email level balance');

        return reply.send({
            success: true,
            data: {
                name: user?.name,
                email: user?.email,
                level: user?.level,
                balance: user?.balance
            }
        });
    } catch (error) {
        console.error('API get profile error:', error);
        return reply.status(500).send({ 
            success: false,
            message: 'Internal Server Error' 
        });
    }
};

// API: Get product list
export const apiGetProducts = async (request: ApiKeyRequest, reply: FastifyReply) => {
    try {
        const { category, operator, type } = request.query as any;
        const userLevel = request.apiUser!.level as 'basic' | 'gold' | 'platinum';

        const filter: any = { status: true };
        if (category) filter.categoryId = category;
        if (operator) filter.operatorId = operator;
        if (type) filter.productTypeId = type;

        const products = await Product.find(filter)
            .select('code name category categoryId operatorId productTypeId price status')
            .populate('categoryId', 'name slug')
            .populate('operatorId', 'name slug')
            .populate('productTypeId', 'name slug')
            .lean();

        const formattedProducts = products.map(p => ({
            code: p.code,
            name: p.name,
            category: (p.categoryId as any)?.name || p.category,
            operator: (p.operatorId as any)?.name || '',
            type: (p.productTypeId as any)?.name || '',
            price: p.price[userLevel],
            status: p.status ? 'available' : 'unavailable'
        }));

        return reply.send({
            success: true,
            data: formattedProducts
        });
    } catch (error) {
        console.error('API get products error:', error);
        return reply.status(500).send({ 
            success: false,
            message: 'Internal Server Error' 
        });
    }
};

// API: Create transaction
export const apiCreateTransaction = async (request: ApiKeyRequest, reply: FastifyReply) => {
    try {
        const { product_code, target, ref_id } = request.body as {
            product_code: string;
            target: string;
            ref_id?: string;
        };

        if (!product_code || !target) {
            return reply.status(400).send({
                success: false,
                message: 'product_code and target are required'
            });
        }

        const userId = request.apiUser!.id;
        const userLevel = request.apiUser!.level as 'basic' | 'gold' | 'platinum';

        // Get product
        const product = await Product.findOne({ code: product_code, status: true });
        if (!product) {
            return reply.status(404).send({
                success: false,
                message: 'Product not found or unavailable'
            });
        }

        // Get user and check balance
        const user = await User.findById(userId);
        if (!user) {
            return reply.status(404).send({
                success: false,
                message: 'User not found'
            });
        }

        const price = product.price[userLevel];

        if (user.balance < price) {
            return reply.status(400).send({
                success: false,
                message: 'Insufficient balance',
                data: {
                    required: price,
                    current_balance: user.balance
                }
            });
        }

        // Check duplicate ref_id if provided
        if (ref_id) {
            const existing = await Transaction.findOne({ customerRefId: ref_id, user: userId });
            if (existing) {
                return reply.status(400).send({
                    success: false,
                    message: 'Duplicate ref_id',
                    data: {
                        existing_trx_id: existing._id,
                        status: existing.status
                    }
                });
            }
        }

        // Generate internal ref_id
        const internalRefId = await generateRefId();

        // Deduct balance
        user.balance -= price;
        await user.save();

        // Create transaction
        const transaction = await Transaction.create({
            user: userId,
            product: product._id,
            target,
            amount: price,
            status: 'pending',
            vendorTrxId: internalRefId,
            customerRefId: ref_id || undefined,
            source: 'api'
        });

        // Process with vendor
        try {
            const vendorRes = await vendorService.topUp(
                internalRefId,
                product.vendor?.sku || product.code,
                target,
                product.vendor?.name
            );

            transaction.status = vendorRes.status;
            if (vendorRes.vendorTrxId) transaction.vendorTrxId = vendorRes.vendorTrxId;
            if (vendorRes.sn) transaction.sn = vendorRes.sn;
            await transaction.save();

            // Refund if failed
            if (transaction.status === 'failed') {
                user.balance += price;
                await user.save();
            }

            // Award points if success
            if (transaction.status === 'success') {
                await awardPoints(userId, price, transaction._id.toString());
            }
        } catch (err) {
            console.error('Vendor processing error:', err);
            // Leave as pending
        }

        // Get updated balance
        const updatedUser = await User.findById(userId).select('balance');

        return reply.send({
            success: true,
            message: 'Transaction created',
            data: {
                trx_id: transaction._id,
                ref_id: ref_id || null,
                product_code: product.code,
                product_name: product.name,
                target,
                price,
                status: transaction.status,
                sn: transaction.sn || null,
                balance: updatedUser?.balance || user.balance,
                created_at: transaction.createdAt
            }
        });
    } catch (error) {
        console.error('API create transaction error:', error);
        return reply.status(500).send({ 
            success: false,
            message: 'Internal Server Error' 
        });
    }
};

// API: Check transaction status
export const apiCheckTransaction = async (request: ApiKeyRequest, reply: FastifyReply) => {
    try {
        const { trx_id, ref_id } = request.query as { trx_id?: string; ref_id?: string };

        if (!trx_id && !ref_id) {
            return reply.status(400).send({
                success: false,
                message: 'trx_id or ref_id is required'
            });
        }

        const userId = request.apiUser!.id;

        let transaction;
        if (trx_id) {
            transaction = await Transaction.findOne({ _id: trx_id, user: userId })
                .populate('product', 'code name');
        } else {
            transaction = await Transaction.findOne({ customerRefId: ref_id, user: userId })
                .populate('product', 'code name');
        }

        if (!transaction) {
            return reply.status(404).send({
                success: false,
                message: 'Transaction not found'
            });
        }

        return reply.send({
            success: true,
            data: {
                trx_id: transaction._id,
                ref_id: transaction.customerRefId || null,
                product_code: (transaction.product as any)?.code,
                product_name: (transaction.product as any)?.name,
                target: transaction.target,
                price: transaction.amount,
                status: transaction.status,
                sn: transaction.sn || null,
                created_at: transaction.createdAt,
                updated_at: transaction.updatedAt
            }
        });
    } catch (error) {
        console.error('API check transaction error:', error);
        return reply.status(500).send({ 
            success: false,
            message: 'Internal Server Error' 
        });
    }
};

// API: Get transaction history
export const apiGetTransactions = async (request: ApiKeyRequest, reply: FastifyReply) => {
    try {
        const { page = 1, limit = 20, status } = request.query as any;
        const userId = request.apiUser!.id;

        const filter: any = { user: userId };
        if (status) filter.status = status;

        const skip = (parseInt(page) - 1) * parseInt(limit);

        const [transactions, total] = await Promise.all([
            Transaction.find(filter)
                .populate('product', 'code name')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(parseInt(limit))
                .lean(),
            Transaction.countDocuments(filter)
        ]);

        const formattedTrx = transactions.map(t => ({
            trx_id: t._id,
            ref_id: t.customerRefId || null,
            product_code: (t.product as any)?.code,
            product_name: (t.product as any)?.name,
            target: t.target,
            price: t.amount,
            status: t.status,
            sn: t.sn || null,
            created_at: t.createdAt
        }));

        return reply.send({
            success: true,
            data: formattedTrx,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                total_pages: Math.ceil(total / parseInt(limit))
            }
        });
    } catch (error) {
        console.error('API get transactions error:', error);
        return reply.status(500).send({ 
            success: false,
            message: 'Internal Server Error' 
        });
    }
};
