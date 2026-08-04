import { FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'crypto';
import mongoose from 'mongoose';
import { Transaction, User, Settings, Vendor, WebhookEventLog } from '../models';
import { awardPoints } from '../services/pointsService';
import { updateDigiflazzSellerOrderByVendorTrxId } from '../services/digiflazzSellerService';
import { getRequestClientIp } from '../utils/requestIp';

type WebhookProvider = 'digiflazz' | 'tokovoucher';

interface PersistedWebhookLogInput {
    event?: string;
    refId: string;
    status: string;
    message: string;
    verified: boolean;
    requestIp?: string;
    raw?: Record<string, unknown>;
}

interface DigiflazzWebhookPayload {
    data: {
        ref_id: string;
        customer_no: string;
        buyer_sku_code: string;
        message: string;
        status: string;
        rc: string;
        buyer_last_saldo: number;
        sn?: string;
        price: number;
        tele?: string;
        wa?: string;
    };
}

const getWebhookSecret = async (): Promise<string> => {
    const setting = await Settings.findOne({ key: 'digiflazzWebhookSecret' }).lean();
    return setting?.value || process.env.DIGIFLAZZ_WEBHOOK_SECRET || '';
};

const getWhitelistIPs = async (): Promise<string[]> => {
    const setting = await Settings.findOne({ key: 'digiflazzWhitelistIP' }).lean();
    if (!setting?.value) return [];
    return (setting.value as string).split(',').map((ip: string) => ip.trim()).filter(Boolean);
};

const getClientIP = (request: FastifyRequest): string => getRequestClientIp(request);

const getRawWebhookBody = (request: FastifyRequest) => {
    const rawBody = (request as any).rawBody;
    if (Buffer.isBuffer(rawBody) || typeof rawBody === 'string') {
        return rawBody;
    }
    return JSON.stringify(request.body ?? {});
};

const ipv4ToNumber = (ip: string) => {
    const parts = ip.split('.').map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
        return null;
    }
    return parts.reduce((acc, part) => (acc << 8) + part, 0) >>> 0;
};

const matchesIpRule = (clientIp: string, rule: string) => {
    const normalizedRule = rule.trim();
    if (!normalizedRule) return false;
    if (!normalizedRule.includes('/')) return clientIp === normalizedRule;
    const [rangeIp, prefixText] = normalizedRule.split('/');
    const prefix = Number(prefixText);
    const client = ipv4ToNumber(clientIp);
    const range = ipv4ToNumber(rangeIp);
    if (client === null || range === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
        return false;
    }
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    return (client & mask) === (range & mask);
};

const isIpAllowed = (clientIp: string, rules: string[]) => rules.some((rule) => matchesIpRule(clientIp, rule));

const shouldUseMongoTransactions = () => process.env.MONGO_TRANSACTIONS_ENABLED !== 'false';

const applyWebhookTransactionStatus = async (
    transaction: any,
    newStatus: 'pending' | 'processing' | 'success' | 'failed',
    updates: { sn?: string; message?: string }
) => {
    const oldStatus = transaction.status as 'pending' | 'processing' | 'success' | 'failed';
    const transactionUpdates: Record<string, unknown> = { status: newStatus };
    if (updates.sn) transactionUpdates.sn = updates.sn;
    if (updates.message) transactionUpdates.message = updates.message;

    const shouldRefund = newStatus === 'failed' && !transaction.refunded;
    const shouldRecharge = newStatus !== 'failed' && oldStatus === 'failed' && transaction.refunded;

    if (shouldUseMongoTransactions()) {
        const session = await mongoose.startSession();
        try {
            await session.withTransaction(async () => {
                if (shouldRefund) {
                    const updatedTransaction = await Transaction.findOneAndUpdate(
                        { _id: transaction._id, refunded: { $ne: true } },
                        { $set: { ...transactionUpdates, refunded: true } },
                        { new: true, session }
                    );
                    if (!updatedTransaction) return;
                    await User.updateOne(
                        { _id: transaction.user },
                        { $inc: { balance: transaction.amount } },
                        { session }
                    );
                    return;
                }

                if (shouldRecharge) {
                    const debited = await User.updateOne(
                        { _id: transaction.user, balance: { $gte: transaction.amount } },
                        { $inc: { balance: -transaction.amount } },
                        { session }
                    );
                    if (debited.modifiedCount !== 1) {
                        throw new Error('Saldo member tidak cukup untuk koreksi webhook vendor');
                    }
                    await Transaction.updateOne(
                        { _id: transaction._id, refunded: true },
                        { $set: { ...transactionUpdates, refunded: false } },
                        { session }
                    );
                    return;
                }

                await Transaction.updateOne(
                    { _id: transaction._id },
                    { $set: transactionUpdates },
                    { session }
                );
            });
        } finally {
            await session.endSession();
        }
        return;
    }

    if (shouldRefund) {
        const updatedTransaction = await Transaction.findOneAndUpdate(
            { _id: transaction._id, refunded: { $ne: true } },
            { $set: { ...transactionUpdates, refunded: true } },
            { new: true }
        );
        if (updatedTransaction) {
            await User.updateOne({ _id: transaction.user }, { $inc: { balance: transaction.amount } });
        }
        return;
    }

    if (shouldRecharge) {
        const debited = await User.updateOne(
            { _id: transaction.user, balance: { $gte: transaction.amount } },
            { $inc: { balance: -transaction.amount } }
        );
        if (debited.modifiedCount !== 1) {
            throw new Error('Saldo member tidak cukup untuk koreksi webhook vendor');
        }
        await Transaction.updateOne(
            { _id: transaction._id, refunded: true },
            { $set: { ...transactionUpdates, refunded: false } }
        );
        return;
    }

    await Transaction.updateOne({ _id: transaction._id }, { $set: transactionUpdates });
};

const mapDigiflazzStatus = (status: string): 'pending' | 'processing' | 'success' | 'failed' => {
    const s = status.toLowerCase();
    if (s === 'sukses') return 'success';
    if (s === 'gagal') return 'failed';
    if (s === 'pending') return 'pending';
    return 'processing';
};

const persistWebhookLog = (provider: WebhookProvider, log: PersistedWebhookLogInput) => {
    void WebhookEventLog.create({
        provider,
        event: log.event,
        refId: log.refId,
        status: log.status,
        message: log.message,
        verified: log.verified,
        requestIp: log.requestIp,
        raw: log.raw
    }).catch((error) => {
        console.error(`Failed to persist ${provider} webhook log:`, error);
    });
};

const addWebhookLog = (log: PersistedWebhookLogInput) => {
    persistWebhookLog('digiflazz', log);
};

const addTokovoucherLog = (log: PersistedWebhookLogInput) => {
    persistWebhookLog('tokovoucher', log);
};

const getRecentWebhookLogs = async (provider: WebhookProvider) => {
    const logs = await WebhookEventLog.find({ provider })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean();

    return logs.map((log) => ({
        id: log._id.toString(),
        timestamp: log.createdAt,
        event: log.event || provider,
        refId: log.refId,
        status: log.status,
        message: log.message,
        verified: log.verified
    }));
};

export const handleDigiflazzWebhook = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const event = request.headers['x-digiflazz-event'] as string || 'unknown';
        const signature = request.headers['x-hub-signature'] as string || '';
        const rawBody = getRawWebhookBody(request);
        const body = request.body as DigiflazzWebhookPayload;
        const clientIP = getClientIP(request);

        // Check IP whitelist
        const whitelistIPs = await getWhitelistIPs();
        if (whitelistIPs.length > 0 && !isIpAllowed(clientIP, whitelistIPs)) {
            addWebhookLog({
                event,
                refId: '-',
                status: 'rejected',
                message: `IP not whitelisted: ${clientIP}`,
                verified: false,
                requestIp: clientIP
            });
            return reply.status(403).send({ message: 'IP not allowed' });
        }

        if (!body?.data) {
            addWebhookLog({
                event,
                refId: '-',
                status: 'error',
                message: 'Invalid payload: missing data field',
                verified: false,
                requestIp: clientIP
            });
            return reply.status(400).send({ message: 'Invalid payload' });
        }

        const { data } = body;

        // Verify signature if secret is configured
        const secret = await getWebhookSecret();
        const hasWhitelistProtection = whitelistIPs.length > 0;
        let verified = false;

        if (!secret && !hasWhitelistProtection) {
            addWebhookLog({
                event,
                refId: data.ref_id || '-',
                status: 'rejected',
                message: 'Webhook protection belum dikonfigurasi',
                verified: false,
                requestIp: clientIP
            });
            return reply.status(503).send({ message: 'Webhook protection is not configured' });
        }

        if (secret) {
            if (!signature) {
                addWebhookLog({
                    event,
                    refId: data.ref_id || '-',
                    status: 'rejected',
                    message: 'Missing signature',
                    verified: false,
                    requestIp: clientIP
                });
                return reply.status(401).send({ message: 'Missing signature' });
            }

            const expectedSignature = 'sha1=' + crypto.createHmac('sha1', secret).update(rawBody).digest('hex');
            verified = signature.length === expectedSignature.length
                && crypto.timingSafeEqual(
                    Buffer.from(signature),
                    Buffer.from(expectedSignature)
                );

            if (!verified) {
                addWebhookLog({
                    event,
                    refId: data.ref_id || '-',
                    status: 'rejected',
                    message: 'Invalid signature',
                    verified: false,
                    requestIp: clientIP
                });
                return reply.status(401).send({ message: 'Invalid signature' });
            }
        } else {
            verified = true;
        }

        const newStatus = mapDigiflazzStatus(data.status);

        // Find transaction by vendorTrxId (ref_id)
        const transaction = await Transaction.findOne({ vendorTrxId: data.ref_id });

        if (!transaction) {
            const sellerOrder = await updateDigiflazzSellerOrderByVendorTrxId(data.ref_id, {
                status: newStatus === 'processing' ? 'pending' : newStatus,
                rc: data.rc,
                message: data.message,
                sn: data.sn,
                vendorTrxId: data.ref_id
            });

            if (sellerOrder) {
                addWebhookLog({
                    event,
                    refId: data.ref_id,
                    status: data.status,
                    message: `Digiflazz Seller order updated to ${newStatus}`,
                    verified,
                    requestIp: clientIP
                });
                return reply.send({ message: 'Seller order updated', status: newStatus });
            }

            addWebhookLog({
                event,
                refId: data.ref_id,
                status: data.status,
                message: `Transaction not found for ref_id: ${data.ref_id}`,
                verified,
                requestIp: clientIP
            });
            return reply.send({ message: 'Transaction not found, ignored' });
        }
        const oldStatus = transaction.status;

        // Skip if status hasn't changed
        if (oldStatus === newStatus) {
            addWebhookLog({
                event,
                refId: data.ref_id,
                status: data.status,
                message: `Status unchanged: ${oldStatus}`,
                verified,
                requestIp: clientIP
            });
            return reply.send({ message: 'Status unchanged' });
        }

        await applyWebhookTransactionStatus(transaction, newStatus, {
            sn: data.sn,
            message: data.message
        });

        // Award points on success
        if (newStatus === 'success' && oldStatus !== 'success') {
            try {
                await awardPoints(transaction.user.toString(), transaction.amount, transaction._id.toString());
            } catch (e) {
                console.error('Award points error:', e);
            }
        }

        addWebhookLog({
            event,
            refId: data.ref_id,
            status: data.status,
            message: `${oldStatus} -> ${newStatus}${data.sn ? `, SN: ${data.sn}` : ''}`,
            verified,
            requestIp: clientIP
        });

        return reply.send({ message: 'OK', status: newStatus });
    } catch (error) {
        console.error('Digiflazz webhook error:', error);
        addWebhookLog({
            event: 'error',
            refId: '-',
            status: 'error',
            message: String(error),
            verified: false,
            requestIp: getClientIP(request)
        });
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Get webhook logs (admin only)
export const getWebhookLogs = async (_request: FastifyRequest, reply: FastifyReply) => {
    const logs = await getRecentWebhookLogs('digiflazz');
    return reply.send(logs);
};

// Get webhook config (admin)
export const getWebhookConfig = async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
        const [secret, whitelist] = await Promise.all([
            Settings.findOne({ key: 'digiflazzWebhookSecret' }).lean(),
            Settings.findOne({ key: 'digiflazzWhitelistIP' }).lean()
        ]);
        const whitelistValue = typeof whitelist?.value === 'string' ? whitelist.value : '';
        const hasSecret = Boolean(secret?.value);
        const hasWhitelist = whitelistValue.split(',').map((ip) => ip.trim()).filter(Boolean).length > 0;

        return reply.send({
            secret: hasSecret ? '********' : '',
            configured: hasSecret,
            whitelistIP: whitelistValue,
            protected: hasSecret || hasWhitelist,
            protectionMode: hasSecret ? 'signature' : hasWhitelist ? 'ip_only' : 'unprotected'
        });
    } catch (error) {
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Save webhook config (admin)
export const saveWebhookConfig = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { secret, whitelistIP } = request.body as { secret?: string; whitelistIP?: string };
        const normalizedSecret = typeof secret === 'string' ? secret.trim() : undefined;
        const normalizedWhitelist = typeof whitelistIP === 'string'
            ? whitelistIP.split(',').map((ip) => ip.trim()).filter(Boolean).join(',')
            : undefined;
        const currentSecret = await Settings.findOne({ key: 'digiflazzWebhookSecret' }).lean();
        const nextSecret = normalizedSecret !== undefined && normalizedSecret !== ''
            ? normalizedSecret
            : String(currentSecret?.value || '');
        const nextWhitelist = normalizedWhitelist !== undefined ? normalizedWhitelist : '';

        if (!nextSecret && !nextWhitelist) {
            return reply.status(400).send({ message: 'Minimal atur secret atau whitelist IP untuk mengamankan webhook Digiflazz' });
        }

        const bulkOps: any[] = [];

        if (normalizedSecret !== undefined && normalizedSecret !== '') {
            bulkOps.push({
                updateOne: {
                    filter: { key: 'digiflazzWebhookSecret' },
                    update: { $set: { key: 'digiflazzWebhookSecret', value: normalizedSecret } },
                    upsert: true
                }
            });
        }

        if (normalizedWhitelist !== undefined) {
            bulkOps.push({
                updateOne: {
                    filter: { key: 'digiflazzWhitelistIP' },
                    update: { $set: { key: 'digiflazzWhitelistIP', value: normalizedWhitelist } },
                    upsert: true
                }
            });
        }

        if (bulkOps.length > 0) {
            await Settings.bulkWrite(bulkOps);
        }

        return reply.send({ message: 'Webhook config saved' });
    } catch (error) {
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// ===================== TOKOVOUCHER WEBHOOK =====================

interface TokovoucherWebhookPayload {
    status: string;
    message: string;
    sn: string;
    ref_id: string;
    trx_id: string;
    produk: string;
    sisa_saldo: number;
    price: number;
}

const getTokovoucherCredentials = async (): Promise<{ memberCode: string; secret: string }> => {
    const vendor = await Vendor.findOne({ name: /tokovoucher/i }).lean();
    return {
        memberCode: vendor?.config?.memberCode || vendor?.config?.apiKey || process.env.TOKOVOUCHER_MEMBER_CODE || '',
        secret: vendor?.config?.secret || process.env.TOKOVOUCHER_SECRET || ''
    };
};

const getTokovoucherWhitelistIPs = async (): Promise<string[]> => {
    const setting = await Settings.findOne({ key: 'tokovoucherWhitelistIP' }).lean();
    if (!setting?.value) return [];
    return (setting.value as string).split(',').map((ip: string) => ip.trim()).filter(Boolean);
};

export const handleTokovoucherWebhook = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const body = request.body as TokovoucherWebhookPayload;
        const clientIP = getClientIP(request);
        const authHeader = request.headers['x-tokovoucher-authorization'] as string || '';

        // Check IP whitelist
        const whitelistIPs = await getTokovoucherWhitelistIPs();
        if (whitelistIPs.length > 0 && !isIpAllowed(clientIP, whitelistIPs)) {
            addTokovoucherLog({
                refId: body?.ref_id || '-',
                status: 'rejected',
                message: `IP not whitelisted: ${clientIP}`,
                verified: false,
                requestIp: clientIP
            });
            return reply.status(403).send({ message: 'IP not allowed' });
        }

        if (!body?.ref_id) {
            addTokovoucherLog({
                refId: '-',
                status: 'error',
                message: 'Invalid payload: missing ref_id',
                verified: false,
                requestIp: clientIP
            });
            return reply.status(400).send({ message: 'Invalid payload' });
        }

        // Verify signature: md5(MEMBER_CODE:SECRET:REF_ID)
        const { memberCode, secret } = await getTokovoucherCredentials();
        let verified = false;
        if (!memberCode || !secret) {
            addTokovoucherLog({
                refId: body.ref_id,
                status: 'rejected',
                message: 'Tokovoucher credentials belum dikonfigurasi',
                verified: false,
                requestIp: clientIP
            });
            return reply.status(503).send({ message: 'Tokovoucher webhook credentials are not configured' });
        }

        if (!authHeader) {
            addTokovoucherLog({
                refId: body.ref_id,
                status: 'rejected',
                message: 'Missing signature',
                verified: false,
                requestIp: clientIP
            });
            return reply.status(401).send({ message: 'Missing signature' });
        }

        if (memberCode && secret && authHeader) {
            const expectedSignature = crypto.createHash('md5').update(`${memberCode}:${secret}:${body.ref_id}`).digest('hex');
            verified = authHeader.length === expectedSignature.length
                && crypto.timingSafeEqual(
                    Buffer.from(authHeader),
                    Buffer.from(expectedSignature)
                );

            if (!verified) {
                addTokovoucherLog({
                    refId: body.ref_id,
                    status: 'rejected',
                    message: 'Invalid signature',
                    verified: false,
                    requestIp: clientIP
                });
                return reply.status(401).send({ message: 'Invalid signature' });
            }
        }

        const s = (body.status || '').toLowerCase();
        const newStatus: 'pending' | 'processing' | 'success' | 'failed' =
            s === 'sukses' ? 'success' : s === 'gagal' ? 'failed' : s === 'pending' ? 'pending' : 'processing';

        // Find transaction
        const transaction = await Transaction.findOne({ vendorTrxId: body.ref_id });
        if (!transaction) {
            const sellerOrder = await updateDigiflazzSellerOrderByVendorTrxId(body.ref_id, {
                status: newStatus === 'processing' ? 'pending' : newStatus,
                message: body.message,
                sn: body.sn,
                vendorTrxId: body.ref_id
            });

            if (sellerOrder) {
                addTokovoucherLog({
                    refId: body.ref_id,
                    status: body.status,
                    message: `Digiflazz Seller order updated to ${newStatus}`,
                    verified,
                    requestIp: clientIP
                });
                return reply.send({ message: 'Seller order updated', status: newStatus });
            }

            addTokovoucherLog({
                refId: body.ref_id,
                status: body.status,
                message: `Transaction not found for ref_id: ${body.ref_id}`,
                verified,
                requestIp: clientIP
            });
            return reply.send({ message: 'Transaction not found, ignored' });
        }
        const oldStatus = transaction.status;

        if (oldStatus === newStatus) {
            addTokovoucherLog({
                refId: body.ref_id,
                status: body.status,
                message: `Status unchanged: ${oldStatus}`,
                verified,
                requestIp: clientIP
            });
            return reply.send({ message: 'Status unchanged' });
        }

        await applyWebhookTransactionStatus(transaction, newStatus, {
            sn: body.sn,
            message: body.message
        });

        // Award points on success
        if (newStatus === 'success' && oldStatus !== 'success') {
            try {
                await awardPoints(transaction.user.toString(), transaction.amount, transaction._id.toString());
            } catch (e) {
                console.error('Award points error:', e);
            }
        }

        addTokovoucherLog({
            refId: body.ref_id,
            status: body.status,
            message: `${oldStatus} -> ${newStatus}${body.sn ? `, SN: ${body.sn}` : ''}`,
            verified,
            requestIp: clientIP
        });

        return reply.send({ message: 'OK', status: newStatus });
    } catch (error) {
        console.error('Tokovoucher webhook error:', error);
        addTokovoucherLog({
            refId: '-',
            status: 'error',
            message: String(error),
            verified: false,
            requestIp: getClientIP(request)
        });
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const getTokovoucherWebhookLogs = async (_request: FastifyRequest, reply: FastifyReply) => {
    const logs = await getRecentWebhookLogs('tokovoucher');
    return reply.send(logs);
};

export const getTokovoucherWebhookConfig = async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
        const [whitelist, credentials] = await Promise.all([
            Settings.findOne({ key: 'tokovoucherWhitelistIP' }).lean(),
            getTokovoucherCredentials()
        ]);
        const whitelistValue = typeof whitelist?.value === 'string' ? whitelist.value : '';
        const hasWhitelist = whitelistValue.split(',').map((ip) => ip.trim()).filter(Boolean).length > 0;
        const hasSignature = Boolean(credentials.memberCode && credentials.secret);

        return reply.send({
            whitelistIP: whitelistValue,
            configured: hasSignature,
            protected: hasSignature || hasWhitelist,
            protectionMode: hasSignature ? 'signature' : hasWhitelist ? 'ip_only' : 'unprotected'
        });
    } catch (error) {
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const saveTokovoucherWebhookConfig = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { whitelistIP } = request.body as { whitelistIP?: string };
        const { memberCode, secret } = await getTokovoucherCredentials();
        const normalizedWhitelist = typeof whitelistIP === 'string'
            ? whitelistIP.split(',').map((ip) => ip.trim()).filter(Boolean).join(',')
            : undefined;

        if (!memberCode || !secret) {
            return reply.status(400).send({ message: 'Konfigurasi kredensial Tokovoucher terlebih dahulu sebelum mengatur webhook' });
        }

        if (normalizedWhitelist !== undefined) {
            await Settings.findOneAndUpdate(
                { key: 'tokovoucherWhitelistIP' },
                { $set: { key: 'tokovoucherWhitelistIP', value: normalizedWhitelist } },
                { upsert: true, new: true }
            );
        }

        return reply.send({ message: 'Webhook config saved' });
    } catch (error) {
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};
