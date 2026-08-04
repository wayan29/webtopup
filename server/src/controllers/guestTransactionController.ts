import mongoose from 'mongoose';
import { FastifyRequest, FastifyReply } from 'fastify';
import { GuestTransaction, Product, PaymentMethod, User } from '../models';
import { getFlashSalePriceForProduct, reserveFlashSaleStock } from '../services/flashSaleService';
import { generateInvoiceNumber } from '../services/idGeneratorService';
import vendorService from '../services/vendorService';
import { AuthRequest } from '../middlewares/authMiddleware';
import { isBankTransferCategory, isOperationalNow } from '../utils/paymentMethodUtils';
import { getSiteSettings } from '../services/siteSettingsService';
import { buildMaintenanceMessage } from '../utils/siteSettingsRuntime';
import { getProductPurchaseIssues } from '../utils/productPurchaseUtils';
import { verifyJwtToken } from '../utils/jwt';

type GuestPaymentStatus = 'waiting_payment' | 'paid' | 'expired' | 'cancelled';
type GuestTransactionStatus = 'pending' | 'processing' | 'success' | 'failed';

type GuestAdminListQuery = {
    page?: string | number;
    limit?: string | number;
    search?: string;
    paymentStatus?: string;
    transactionStatus?: string;
    startDate?: string;
    endDate?: string;
    scope?: string;
};

type GuestStatusUpdatePayload = {
    transactionStatus: GuestTransactionStatus;
    note: string;
    vendorTrxId?: string;
    sn?: string;
};

class GuestTransactionControllerError extends Error {
    statusCode: number;

    constructor(statusCode: number, message: string) {
        super(message);
        this.statusCode = statusCode;
    }
}

const ALLOWED_PAYMENT_STATUSES: GuestPaymentStatus[] = ['waiting_payment', 'paid', 'expired', 'cancelled'];
const ALLOWED_TRANSACTION_STATUSES: GuestTransactionStatus[] = ['pending', 'processing', 'success', 'failed'];

const normalizeText = (value: unknown) => (
    typeof value === 'string' ? value.trim() : ''
);

const normalizePhone = (value: unknown) => normalizeText(value).replace(/\D/g, '');

const normalizePositiveInt = (value: unknown, fallback: number, max: number) => {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue) || numericValue <= 0) {
        return fallback;
    }

    return Math.min(Math.floor(numericValue), max);
};

const normalizeOptionalText = (value: unknown, maxLength: number, fieldLabel: string) => {
    if (value === undefined) {
        return undefined;
    }

    const text = normalizeText(value);
    if (text.length > maxLength) {
        throw new GuestTransactionControllerError(400, `${fieldLabel} maksimal ${maxLength} karakter`);
    }

    return text;
};

const parseDateBoundary = (value: unknown, endOfDay = false) => {
    const text = normalizeText(value);
    if (!text) {
        return null;
    }

    const date = new Date(`${text}${endOfDay ? 'T23:59:59.999' : 'T00:00:00.000'}`);
    if (Number.isNaN(date.getTime())) {
        throw new GuestTransactionControllerError(400, 'Format tanggal guest transaction tidak valid');
    }

    return date;
};

const ensureObjectId = (value: string, label: string) => {
    if (!mongoose.Types.ObjectId.isValid(value)) {
        throw new GuestTransactionControllerError(400, `${label} tidak valid`);
    }
};

const buildActionNote = (fallbackNote: string, note?: string) => (
    note && note.trim() ? note.trim() : fallbackNote
);

const handleControllerError = (reply: FastifyReply, error: unknown) => {
    console.error(error);

    if (error instanceof GuestTransactionControllerError) {
        return reply.status(error.statusCode).send({ message: error.message });
    }

    return reply.status(500).send({ message: 'Internal Server Error' });
};

const buildGuestAdminQuery = (query: GuestAdminListQuery) => {
    const currentPage = normalizePositiveInt(query.page, 1, 100000);
    const pageSize = normalizePositiveInt(query.limit, 20, 100);
    const normalizedSearch = normalizeText(query.search);
    const normalizedPaymentStatus = normalizeText(query.paymentStatus) as GuestPaymentStatus | '';
    const normalizedTransactionStatus = normalizeText(query.transactionStatus) as GuestTransactionStatus | '';
    const normalizedScope = normalizeText(query.scope).toLowerCase() === 'all' ? 'all' : 'actionable';
    const startBoundary = parseDateBoundary(query.startDate, false);
    const endBoundary = parseDateBoundary(query.endDate, true);

    if (normalizedPaymentStatus && !ALLOWED_PAYMENT_STATUSES.includes(normalizedPaymentStatus)) {
        throw new GuestTransactionControllerError(400, 'Status pembayaran guest tidak valid');
    }

    if (normalizedTransactionStatus && !ALLOWED_TRANSACTION_STATUSES.includes(normalizedTransactionStatus)) {
        throw new GuestTransactionControllerError(400, 'Status transaksi guest tidak valid');
    }

    if (startBoundary && endBoundary && startBoundary > endBoundary) {
        throw new GuestTransactionControllerError(400, 'Rentang tanggal guest transaction tidak valid');
    }

    const clauses: Record<string, unknown>[] = [];

    if (normalizedScope !== 'all') {
        clauses.push({
            $or: [
                { paymentStatus: 'waiting_payment' },
                {
                    paymentStatus: 'paid',
                    transactionStatus: { $ne: 'success' }
                }
            ]
        });
    }

    if (normalizedPaymentStatus) {
        clauses.push({ paymentStatus: normalizedPaymentStatus });
    }

    if (normalizedTransactionStatus) {
        clauses.push({ transactionStatus: normalizedTransactionStatus });
    }

    if (startBoundary || endBoundary) {
        const createdAt: Record<string, Date> = {};
        if (startBoundary) {
            createdAt.$gte = startBoundary;
        }
        if (endBoundary) {
            createdAt.$lte = endBoundary;
        }
        clauses.push({ createdAt });
    }

    if (normalizedSearch) {
        const regex = new RegExp(normalizedSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        clauses.push({
            $or: [
                { invoiceNumber: regex },
                { target: regex },
                { whatsapp: regex },
                { email: regex },
                { vendorTrxId: regex },
                { sn: regex }
            ]
        });
    }

    const match = clauses.length === 0
        ? {}
        : clauses.length === 1
            ? clauses[0]
            : { $and: clauses };

    return {
        currentPage,
        pageSize,
        match,
        scope: normalizedScope
    };
};

const populateGuestTransactionQuery = <T extends mongoose.Query<any, any>>(query: T) => (
    query
        .populate('product', 'name code category brand vendor')
        .populate('user', 'name email')
        .populate({
            path: 'paymentMethod',
            select: 'name category accountName accountNumber',
            populate: {
                path: 'category',
                select: 'name slug status'
            }
        })
        .populate('statusUpdatedBy', 'name email role')
);

const mapGuestTransactionForAdmin = (transaction: any) => {
    const product = transaction.product && typeof transaction.product === 'object' ? transaction.product : null;
    const user = transaction.user && typeof transaction.user === 'object' ? transaction.user : null;
    const paymentMethod = transaction.paymentMethod && typeof transaction.paymentMethod === 'object' ? transaction.paymentMethod : null;
    const paymentCategory = paymentMethod?.category && typeof paymentMethod.category === 'object'
        ? paymentMethod.category
        : null;
    const statusUpdatedBy = transaction.statusUpdatedBy && typeof transaction.statusUpdatedBy === 'object'
        ? transaction.statusUpdatedBy
        : null;

    return {
        _id: transaction._id?.toString?.() || transaction._id,
        invoiceNumber: transaction.invoiceNumber,
        target: transaction.target,
        whatsapp: transaction.whatsapp,
        email: transaction.email || undefined,
        amount: transaction.amount,
        adminFee: transaction.adminFee,
        uniqueCode: transaction.uniqueCode,
        totalAmount: transaction.totalAmount,
        paymentStatus: transaction.paymentStatus,
        transactionStatus: transaction.transactionStatus,
        vendorTrxId: transaction.vendorTrxId || undefined,
        sn: transaction.sn || undefined,
        paidAt: transaction.paidAt || undefined,
        expiredAt: transaction.expiredAt,
        createdAt: transaction.createdAt,
        updatedAt: transaction.updatedAt,
        statusUpdatedAt: transaction.statusUpdatedAt || undefined,
        statusUpdateNote: transaction.statusUpdateNote || undefined,
        product: product ? {
            _id: product._id?.toString?.() || product._id,
            name: product.name,
            code: product.code,
            category: product.category,
            brand: product.brand,
            vendorName: product.vendor?.name || undefined
        } : undefined,
        user: user ? {
            _id: user._id?.toString?.() || user._id,
            name: user.name,
            email: user.email
        } : undefined,
        paymentMethod: paymentMethod ? {
            _id: paymentMethod._id?.toString?.() || paymentMethod._id,
            name: paymentMethod.name,
            categoryName: paymentCategory?.name || undefined,
            accountName: paymentMethod.accountName || undefined,
            accountNumber: paymentMethod.accountNumber || undefined
        } : undefined,
        statusUpdatedBy: statusUpdatedBy ? {
            _id: statusUpdatedBy._id?.toString?.() || statusUpdatedBy._id,
            name: statusUpdatedBy.name,
            email: statusUpdatedBy.email,
            role: statusUpdatedBy.role
        } : undefined
    };
};

const loadGuestTransactionForAdmin = async (transactionId: string) => {
    const transaction = await populateGuestTransactionQuery(
        GuestTransaction.findById(transactionId)
    ).lean();

    if (!transaction) {
        throw new GuestTransactionControllerError(404, 'Transaksi guest tidak ditemukan');
    }

    return mapGuestTransactionForAdmin(transaction);
};

const normalizeGuestStatusUpdatePayload = (body: unknown): GuestStatusUpdatePayload => {
    const payload = (body ?? {}) as Record<string, unknown>;
    const transactionStatus = normalizeText(payload.transactionStatus) as GuestTransactionStatus;

    if (!ALLOWED_TRANSACTION_STATUSES.includes(transactionStatus)) {
        throw new GuestTransactionControllerError(400, 'Status transaksi guest tidak valid');
    }

    return {
        transactionStatus,
        note: normalizeOptionalText(payload.note, 500, 'Catatan tindakan') ?? '',
        vendorTrxId: normalizeOptionalText(payload.vendorTrxId, 120, 'Vendor Trx ID'),
        sn: normalizeOptionalText(payload.sn, 300, 'SN / Token')
    };
};

const validateGuestManualStatusTransition = (
    paymentStatus: GuestPaymentStatus,
    nextStatus: GuestTransactionStatus
) => {
    if (paymentStatus === 'waiting_payment' && nextStatus !== 'pending') {
        throw new GuestTransactionControllerError(
            400,
            'Transaksi guest yang belum dibayar hanya boleh tetap berstatus pending. Konfirmasi pembayaran terlebih dahulu.'
        );
    }

    if (paymentStatus === 'paid' && !['processing', 'success', 'failed'].includes(nextStatus)) {
        throw new GuestTransactionControllerError(
            400,
            'Transaksi guest yang sudah dibayar hanya bisa diubah ke processing, success, atau failed.'
        );
    }

    if ((paymentStatus === 'expired' || paymentStatus === 'cancelled') && nextStatus !== 'failed') {
        throw new GuestTransactionControllerError(
            400,
            'Transaksi guest yang sudah expired atau dibatalkan hanya boleh berstatus failed.'
        );
    }
};

// Generate unique code (3 digit random for transfer identification)
const generateUniqueCode = (): number => {
    return Math.floor(Math.random() * 900) + 100; // 100-999
};

// Create guest transaction
export const createGuestTransaction = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { productCode, target, serverId, whatsapp, email, paymentMethodId, useFlashSale } = request.body as any;
        const settings = await getSiteSettings(['maintenanceMode', 'maintenanceMessage', 'guestCheckoutEnabled']);
        const normalizedTarget = normalizeText(target);
        const normalizedServerId = normalizeText(serverId);
        const normalizedWhatsapp = normalizePhone(whatsapp);
        const normalizedEmail = normalizeText(email);

        if (settings.maintenanceMode) {
            return reply.status(503).send({ message: buildMaintenanceMessage(settings.maintenanceMessage) });
        }

        if (!settings.guestCheckoutEnabled) {
            return reply.status(403).send({ message: 'Guest checkout sedang dinonaktifkan' });
        }

        // Validate required fields
        if (!productCode || !normalizedTarget || !normalizedWhatsapp || !paymentMethodId) {
            return reply.status(400).send({ message: 'Missing required fields' });
        }

        // Check if user is authenticated (optional)
        let userId: string | undefined;
        let userLevel: 'basic' | 'gold' | 'platinum' = 'basic';
        const authHeader = request.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            try {
                const token = authHeader.split(' ')[1];
                const decoded = verifyJwtToken<any>(token);
                userId = decoded.id;
                const user = await User.findById(userId).select('level');
                if (user) {
                    userLevel = user.level as 'basic' | 'gold' | 'platinum';
                }
            } catch {
                // Token invalid, proceed as guest
            }
        }

        // Get product
        const product = await Product.findOne({ code: productCode });
        if (!product) {
            return reply.status(404).send({ message: 'Product not found' });
        }
        if (!product.status) {
            return reply.status(400).send({ message: 'Product is unavailable' });
        }

        const visibilityIssues = await getProductPurchaseIssues(product);
        if (visibilityIssues.length > 0) {
            return reply.status(400).send({
                message: `Produk tidak tersedia untuk dibeli: ${visibilityIssues.join(', ')}`
            });
        }

        // Get payment method
        const paymentMethod = await PaymentMethod.findById(paymentMethodId)
            .populate('category', 'name slug status');
        if (!paymentMethod) {
            return reply.status(404).send({ message: 'Payment method not found' });
        }
        if (paymentMethod.status !== 'active') {
            return reply.status(400).send({ message: 'Payment method is not available' });
        }

        const category = paymentMethod.category as any;
        if (!category || category.status !== 'active') {
            return reply.status(400).send({ message: 'Payment category is not available' });
        }

        if (!isOperationalNow(paymentMethod.operationalStart, paymentMethod.operationalEnd)) {
            return reply.status(400).send({
                message: `Payment method is available only between ${paymentMethod.operationalStart} and ${paymentMethod.operationalEnd}`
            });
        }

        // Only allow Bank Transfer for guest
        if (!isBankTransferCategory(category)) {
            return reply.status(400).send({ message: 'Only bank transfer is allowed for guest checkout' });
        }

        // Use price based on user level
        const basePrice = product.price[userLevel];
        let price = basePrice;

        if (useFlashSale) {
            const flashSale = await getFlashSalePriceForProduct(product._id.toString(), basePrice);
            if (flashSale) {
                price = flashSale.flashPrice;
                await reserveFlashSaleStock(flashSale.flashSaleId, product._id.toString());
            }
        }

        // Calculate admin fee
        let adminFee = paymentMethod.adminFee || 0;
        if (paymentMethod.adminPercent > 0) {
            adminFee += Math.ceil(price * paymentMethod.adminPercent / 100);
        }

        // Generate unique code
        const uniqueCode = generateUniqueCode();
        const totalAmount = price + adminFee + uniqueCode;

        // Validate min/max amount
        if (totalAmount < paymentMethod.minAmount) {
            return reply.status(400).send({ message: `Minimum amount is Rp ${paymentMethod.minAmount.toLocaleString()}` });
        }
        if (totalAmount > paymentMethod.maxAmount) {
            return reply.status(400).send({ message: `Maximum amount is Rp ${paymentMethod.maxAmount.toLocaleString()}` });
        }

        // Generate invoice number
        const invoiceNumber = await generateInvoiceNumber();

        // Set expiry (24 hours from now)
        const expiredAt = new Date();
        expiredAt.setHours(expiredAt.getHours() + 24);

        // Create guest transaction
        const guestTransaction = await GuestTransaction.create({
            invoiceNumber,
            user: userId,
            product: product._id,
            target: normalizedTarget,
            serverId: normalizedServerId || undefined,
            whatsapp: normalizedWhatsapp,
            email: normalizedEmail || undefined,
            amount: price,
            adminFee,
            uniqueCode,
            totalAmount,
            paymentMethod: paymentMethod._id,
            paymentStatus: 'waiting_payment',
            transactionStatus: 'pending',
            expiredAt
        });

        // Populate for response
        await guestTransaction.populate('product', 'name code');
        await guestTransaction.populate('paymentMethod', 'name category accountNumber accountName');

        return reply.status(201).send({
            message: 'Transaction created, please complete payment',
            transaction: guestTransaction,
            paymentInfo: {
                bankName: paymentMethod.name,
                accountNumber: paymentMethod.accountNumber,
                accountName: paymentMethod.accountName,
                amount: price,
                adminFee,
                uniqueCode,
                totalAmount,
                expiredAt
            }
        });

    } catch (error) {
        console.error('Create guest transaction error:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Check transaction status by invoice number
export const checkGuestTransaction = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { invoiceNumber } = request.params as any;
        const { whatsapp } = request.query as { whatsapp?: string };
        const normalizedWhatsapp = normalizePhone(whatsapp);

        if (!normalizedWhatsapp) {
            return reply.status(400).send({ message: 'Nomor WhatsApp wajib diisi untuk cek transaksi' });
        }

        const transaction = await GuestTransaction.findOne({ invoiceNumber })
            .populate('product', 'name code')
            .populate('paymentMethod', 'name category accountNumber accountName');

        if (!transaction) {
            return reply.status(404).send({ message: 'Transaction not found' });
        }

        if (normalizePhone(transaction.whatsapp) !== normalizedWhatsapp) {
            return reply.status(404).send({ message: 'Transaction not found' });
        }

        return reply.send(transaction);
    } catch (error) {
        console.error(error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Get guest transactions for admin
export const getGuestTransactions = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { currentPage, pageSize, match } = buildGuestAdminQuery(request.query as GuestAdminListQuery);
        const skip = (currentPage - 1) * pageSize;

        const [transactions, total, summaryRows] = await Promise.all([
            populateGuestTransactionQuery(
                GuestTransaction.find(match)
            )
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(pageSize)
                .lean(),
            GuestTransaction.countDocuments(match),
            GuestTransaction.aggregate([
                { $match: match },
                {
                    $group: {
                        _id: null,
                        total: { $sum: 1 },
                        amountTotal: { $sum: '$totalAmount' },
                        waitingPayment: {
                            $sum: {
                                $cond: [{ $eq: ['$paymentStatus', 'waiting_payment'] }, 1, 0]
                            }
                        },
                        paid: {
                            $sum: {
                                $cond: [{ $eq: ['$paymentStatus', 'paid'] }, 1, 0]
                            }
                        },
                        expired: {
                            $sum: {
                                $cond: [{ $eq: ['$paymentStatus', 'expired'] }, 1, 0]
                            }
                        },
                        cancelled: {
                            $sum: {
                                $cond: [{ $eq: ['$paymentStatus', 'cancelled'] }, 1, 0]
                            }
                        },
                        processing: {
                            $sum: {
                                $cond: [{ $eq: ['$transactionStatus', 'processing'] }, 1, 0]
                            }
                        },
                        success: {
                            $sum: {
                                $cond: [{ $eq: ['$transactionStatus', 'success'] }, 1, 0]
                            }
                        },
                        failed: {
                            $sum: {
                                $cond: [{ $eq: ['$transactionStatus', 'failed'] }, 1, 0]
                            }
                        }
                    }
                }
            ])
        ]);

        const summary = summaryRows[0] || {
            total: 0,
            amountTotal: 0,
            waitingPayment: 0,
            paid: 0,
            expired: 0,
            cancelled: 0,
            processing: 0,
            success: 0,
            failed: 0
        };
        const transactionItems = Array.isArray(transactions) ? transactions : [];

        return reply.send({
            items: transactionItems.map(mapGuestTransactionForAdmin),
            meta: {
                page: currentPage,
                limit: pageSize,
                total,
                totalPages: Math.max(1, Math.ceil(total / pageSize))
            },
            summary: {
                total: summary.total || 0,
                amountTotal: summary.amountTotal || 0,
                waitingPayment: summary.waitingPayment || 0,
                paid: summary.paid || 0,
                expired: summary.expired || 0,
                cancelled: summary.cancelled || 0,
                processing: summary.processing || 0,
                success: summary.success || 0,
                failed: summary.failed || 0
            }
        });
    } catch (error) {
        return handleControllerError(reply, error);
    }
};

// Confirm payment (admin) - marks as paid and processes to vendor
export const confirmGuestPayment = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };
        ensureObjectId(id, 'ID transaksi guest');

        const note = normalizeOptionalText((request.body as any)?.note, 500, 'Catatan tindakan');
        const processorId = request.user?.id;

        if (!processorId) {
            return reply.status(401).send({ message: 'Unauthorized' });
        }

        const now = new Date();
        const day = String(now.getDate()).padStart(2, '0');
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const year = now.getFullYear();
        const random = Math.random().toString(36).substring(2, 6).toUpperCase();
        const refId = `GUEST${day}${month}${year}${random}`;

        const claimedTransaction = await GuestTransaction.findOneAndUpdate(
            {
                _id: id,
                paymentStatus: 'waiting_payment',
                transactionStatus: 'pending'
            },
            {
                $set: {
                    paymentStatus: 'paid',
                    paidAt: now,
                    transactionStatus: 'processing',
                    vendorTrxId: refId,
                    statusUpdatedBy: processorId,
                    statusUpdatedAt: now,
                    statusUpdateNote: buildActionNote(
                        'Pembayaran guest dikonfirmasi manual dan dikirim ke vendor',
                        note
                    )
                }
            },
            { new: true }
        ).populate('product');

        if (!claimedTransaction) {
            const existingTransaction = await GuestTransaction.findById(id)
                .select('paymentStatus transactionStatus expiredAt')
                .lean();

            if (!existingTransaction) {
                throw new GuestTransactionControllerError(404, 'Transaksi guest tidak ditemukan');
            }

            if (existingTransaction.paymentStatus === 'paid') {
                throw new GuestTransactionControllerError(400, 'Pembayaran guest sudah dikonfirmasi sebelumnya');
            }

            if (existingTransaction.paymentStatus === 'cancelled') {
                throw new GuestTransactionControllerError(400, 'Transaksi guest sudah dibatalkan');
            }

            if (existingTransaction.paymentStatus === 'expired') {
                throw new GuestTransactionControllerError(400, 'Transaksi guest sudah expired');
            }

            throw new GuestTransactionControllerError(400, 'Transaksi guest tidak bisa dikonfirmasi');
        }

        try {
            const product = claimedTransaction.product as any;
            const vendorRes = await vendorService.topUp(
                refId,
                product.vendor?.sku || product.code,
                claimedTransaction.target,
                product.vendor?.name,
                claimedTransaction.serverId || undefined
            );

            claimedTransaction.transactionStatus = vendorRes.status;
            if (vendorRes.vendorTrxId) {
                claimedTransaction.vendorTrxId = vendorRes.vendorTrxId;
            }
            if (vendorRes.sn) {
                claimedTransaction.sn = vendorRes.sn;
            }
            claimedTransaction.statusUpdatedBy = processorId as any;
            claimedTransaction.statusUpdatedAt = new Date();
            claimedTransaction.statusUpdateNote = buildActionNote(
                `Pembayaran guest dikonfirmasi manual. Respons vendor: ${vendorRes.status.toUpperCase()}`,
                note
            );
            await claimedTransaction.save();
        } catch (vendorError) {
            console.error('Vendor processing error:', vendorError);
            claimedTransaction.statusUpdatedBy = processorId as any;
            claimedTransaction.statusUpdatedAt = new Date();
            claimedTransaction.statusUpdateNote = buildActionNote(
                'Pembayaran guest dikonfirmasi manual, tetapi pengiriman ke vendor gagal dan perlu dicek ulang.',
                note
            );
            await claimedTransaction.save();
        }

        const transaction = await loadGuestTransactionForAdmin(id);

        return reply.send({
            message: 'Pembayaran guest berhasil dikonfirmasi',
            transaction
        });
    } catch (error) {
        return handleControllerError(reply, error);
    }
};

// Cancel/reject guest transaction (admin)
export const cancelGuestTransaction = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };
        ensureObjectId(id, 'ID transaksi guest');

        const note = normalizeOptionalText((request.body as any)?.note, 500, 'Catatan tindakan');
        const processorId = request.user?.id;

        if (!processorId) {
            return reply.status(401).send({ message: 'Unauthorized' });
        }

        const now = new Date();

        const transaction = await GuestTransaction.findOneAndUpdate(
            {
                _id: id,
                $or: [
                    { paymentStatus: 'waiting_payment' },
                    { paymentStatus: 'paid', transactionStatus: 'failed' }
                ]
            },
            {
                $set: {
                    paymentStatus: 'cancelled',
                    transactionStatus: 'failed',
                    statusUpdatedBy: processorId,
                    statusUpdatedAt: now,
                    statusUpdateNote: buildActionNote(
                        'Transaksi guest dibatalkan manual oleh admin',
                        note
                    )
                }
            },
            { new: true }
        );

        if (!transaction) {
            const existingTransaction = await GuestTransaction.findById(id)
                .select('paymentStatus transactionStatus')
                .lean();

            if (!existingTransaction) {
                throw new GuestTransactionControllerError(404, 'Transaksi guest tidak ditemukan');
            }

            if (existingTransaction.paymentStatus === 'cancelled') {
                throw new GuestTransactionControllerError(400, 'Transaksi guest sudah dibatalkan');
            }

            if (existingTransaction.paymentStatus === 'expired') {
                throw new GuestTransactionControllerError(400, 'Transaksi guest sudah expired');
            }

            if (existingTransaction.paymentStatus === 'paid' && existingTransaction.transactionStatus === 'processing') {
                throw new GuestTransactionControllerError(
                    400,
                    'Transaksi guest yang sudah diproses vendor tidak bisa langsung dibatalkan. Selesaikan status fulfillment terlebih dahulu.'
                );
            }

            if (existingTransaction.paymentStatus === 'paid' && existingTransaction.transactionStatus === 'success') {
                throw new GuestTransactionControllerError(400, 'Transaksi guest yang sukses tidak bisa dibatalkan');
            }

            throw new GuestTransactionControllerError(400, 'Transaksi guest tidak bisa dibatalkan');
        }

        const responseTransaction = await loadGuestTransactionForAdmin(id);

        return reply.send({
            message: 'Transaksi guest dibatalkan',
            transaction: responseTransaction
        });
    } catch (error) {
        return handleControllerError(reply, error);
    }
};

// Update transaction status manually (admin)
export const updateGuestTransactionStatus = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };
        ensureObjectId(id, 'ID transaksi guest');

        const payload = normalizeGuestStatusUpdatePayload(request.body);
        const processorId = request.user?.id;

        if (!processorId) {
            return reply.status(401).send({ message: 'Unauthorized' });
        }

        const transaction = await GuestTransaction.findById(id);
        if (!transaction) {
            throw new GuestTransactionControllerError(404, 'Transaksi guest tidak ditemukan');
        }

        validateGuestManualStatusTransition(
            transaction.paymentStatus as GuestPaymentStatus,
            payload.transactionStatus
        );

        transaction.transactionStatus = payload.transactionStatus;
        transaction.statusUpdatedBy = processorId as any;
        transaction.statusUpdatedAt = new Date();
        transaction.statusUpdateNote = buildActionNote(
            `Status guest transaction diubah manual ke ${payload.transactionStatus.toUpperCase()}`,
            payload.note
        );

        if (payload.sn) {
            transaction.sn = payload.sn;
        } else if (payload.sn !== undefined) {
            transaction.sn = undefined;
        }

        if (payload.vendorTrxId) {
            transaction.vendorTrxId = payload.vendorTrxId;
        } else if (payload.vendorTrxId !== undefined) {
            transaction.vendorTrxId = undefined;
        }

        await transaction.save();

        const responseTransaction = await loadGuestTransactionForAdmin(id);

        return reply.send({
            message: 'Status transaksi guest diperbarui',
            transaction: responseTransaction
        });
    } catch (error) {
        return handleControllerError(reply, error);
    }
};
