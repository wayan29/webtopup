import mongoose from 'mongoose';
import { FastifyReply } from 'fastify';
import { Transaction, Product, User, GuestTransaction, UserBalanceAdjustment } from '../models';
import { getFlashSalePriceForProduct, reserveFlashSaleStock } from '../services/flashSaleService';
import { generateRefId } from '../services/idGeneratorService';
import { AuthRequest } from '../middlewares/authMiddleware';
import vendorService from '../services/vendorService';
import { awardPoints, revokeAwardedPoints } from '../services/pointsService';
import { getSiteSettings } from '../services/siteSettingsService';
import { buildMaintenanceMessage } from '../utils/siteSettingsRuntime';
import { getProductPurchaseIssues } from '../utils/productPurchaseUtils';

type TransactionStatus = 'pending' | 'processing' | 'success' | 'failed';
type TransactionSource = 'web' | 'api';

type TransactionListQuery = {
    page?: string | number;
    limit?: string | number;
    search?: string;
    status?: string;
    source?: string;
    category?: string;
    brand?: string;
    vendor?: string;
    startDate?: string;
    endDate?: string;
    scope?: string;
};

type StuckTransactionQuery = {
    thresholdMinutes?: string | number;
    limit?: string | number;
};

type TransactionListOptions = {
    defaultStatuses?: TransactionStatus[];
    pageSizeMax?: number;
};

type StatusUpdatePayload = {
    status: TransactionStatus;
    vendorTrxId?: string;
    sn?: string;
    note: string;
};

type RefundPayload = {
    reason?: string;
};

type TransitionPlan = {
    balanceDelta: number;
    shouldAwardPoints: boolean;
    shouldRevokePoints: boolean;
    nextRefunded: boolean;
};

type TransactionAuditSnapshot = {
    status: TransactionStatus;
    refunded: boolean;
    vendorTrxId?: string;
    sn?: string;
    statusUpdatedBy?: mongoose.Types.ObjectId;
    statusUpdatedAt?: Date;
    statusUpdateNote?: string;
    updatedAt: Date;
};

class TransactionControllerError extends Error {
    statusCode: number;

    constructor(statusCode: number, message: string) {
        super(message);
        this.statusCode = statusCode;
    }
}

const ALLOWED_STATUSES: TransactionStatus[] = ['pending', 'processing', 'success', 'failed'];
const ALLOWED_SOURCES: TransactionSource[] = ['web', 'api'];
const STUCK_TRANSACTION_DEFAULT_MINUTES = 15;
const STUCK_TRANSACTION_MAX_LIMIT = 50;

const normalizeText = (value: unknown) => (
    typeof value === 'string' ? value.trim() : ''
);

const normalizePositiveInt = (value: unknown, fallback: number, max: number) => {
    const numericValue = Number(value);

    if (!Number.isFinite(numericValue) || numericValue <= 0) {
        return fallback;
    }

    return Math.min(Math.floor(numericValue), max);
};

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

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const parseDateBoundary = (value: unknown, endOfDay = false) => {
    const text = normalizeText(value);
    if (!text) {
        return null;
    }

    const date = new Date(`${text}${endOfDay ? 'T23:59:59.999' : 'T00:00:00.000'}`);
    if (Number.isNaN(date.getTime())) {
        throw new TransactionControllerError(400, 'Format tanggal transaksi tidak valid');
    }

    return date;
};

const normalizeStatusList = (
    value: unknown,
    fallbackStatuses: TransactionStatus[] = []
) => {
    const text = normalizeText(value);
    if (!text) {
        return fallbackStatuses;
    }

    const statuses = Array.from(
        new Set(
            text
                .split(',')
                .map((item) => normalizeText(item) as TransactionStatus)
                .filter(Boolean)
        )
    );

    if (statuses.length === 0) {
        return fallbackStatuses;
    }

    const invalidStatus = statuses.find((item) => !ALLOWED_STATUSES.includes(item));
    if (invalidStatus) {
        throw new TransactionControllerError(400, 'Status transaksi tidak valid');
    }

    return statuses;
};

const normalizeOptionalText = (value: unknown, maxLength: number, fieldLabel: string) => {
    if (value === undefined) {
        return undefined;
    }

    const text = normalizeText(value);
    if (text.length > maxLength) {
        throw new TransactionControllerError(400, `${fieldLabel} maksimal ${maxLength} karakter`);
    }

    return text;
};

const normalizeStatusUpdatePayload = (body: unknown): StatusUpdatePayload => {
    const payload = (body ?? {}) as Record<string, unknown>;
    const status = normalizeText(payload.status) as TransactionStatus;

    if (!ALLOWED_STATUSES.includes(status)) {
        throw new TransactionControllerError(400, 'Status transaksi tidak valid');
    }

    const note = normalizeOptionalText(payload.note ?? payload.message, 500, 'Catatan status') ?? '';
    const vendorTrxId = normalizeOptionalText(payload.vendorTrxId, 120, 'Vendor Trx ID');
    const sn = normalizeOptionalText(payload.sn, 300, 'SN / Token');

    return {
        status,
        vendorTrxId,
        sn,
        note
    };
};

const normalizeRefundPayload = (body: unknown): { reason: string } => {
    const payload = (body ?? {}) as RefundPayload;
    const reason = normalizeText(payload.reason);

    if (reason.length < 5 || reason.length > 300) {
        throw new TransactionControllerError(400, 'Alasan refund wajib 5-300 karakter');
    }

    return { reason };
};

const isTransactionSupportError = (error: unknown) => {
    if (!(error instanceof Error)) {
        return false;
    }

    return /transaction numbers are only allowed on a replica set member or mongos|does not support transactions|transaction support/i.test(error.message);
};

const handleControllerError = (reply: FastifyReply, error: unknown) => {
    console.error(error);

    if (error instanceof TransactionControllerError) {
        return reply.status(error.statusCode).send({ message: error.message });
    }

    return reply.status(500).send({ message: 'Internal Server Error' });
};

const applyTransitionPlan = (
    currentStatus: TransactionStatus,
    refunded: boolean,
    amount: number,
    nextStatus: TransactionStatus
): TransitionPlan => {
    let balanceDelta = 0;
    let nextRefunded = refunded;

    if (nextStatus === 'failed' && !refunded) {
        balanceDelta = amount;
        nextRefunded = true;
    } else if (nextStatus !== 'failed' && refunded) {
        balanceDelta = -amount;
        nextRefunded = false;
    }

    return {
        balanceDelta,
        shouldAwardPoints: currentStatus !== 'success' && nextStatus === 'success',
        shouldRevokePoints: currentStatus === 'success' && nextStatus !== 'success',
        nextRefunded
    };
};

const buildAdminStatusNote = (
    previousStatus: TransactionStatus,
    nextStatus: TransactionStatus,
    note: string
) => (
    note || `Manual status update: ${previousStatus} -> ${nextStatus}`
);

const buildRefundReason = (transactionId: string, reason: string) => (
    `Refund transaksi ${transactionId.slice(-8).toUpperCase()}: ${reason}`
);

const updateUserBalance = async (
    userId: string,
    balanceDelta: number,
    session?: mongoose.ClientSession | null
) => {
    if (balanceDelta === 0) {
        return;
    }

    if (balanceDelta > 0) {
        const query = User.findByIdAndUpdate(
            userId,
            { $inc: { balance: balanceDelta } },
            { new: true }
        ).select('_id balance');

        const updatedUser = session ? await query.session(session) : await query;
        if (!updatedUser) {
            throw new TransactionControllerError(404, 'User transaksi tidak ditemukan');
        }

        return;
    }

    const absoluteAmount = Math.abs(balanceDelta);
    const query = User.findOneAndUpdate(
        { _id: userId, balance: { $gte: absoluteAmount } },
        { $inc: { balance: balanceDelta } },
        { new: true }
    ).select('_id balance');

    const updatedUser = session ? await query.session(session) : await query;
    if (updatedUser) {
        return;
    }

    const existingUserQuery = User.findById(userId).select('_id');
    const existingUser = session ? await existingUserQuery.session(session) : await existingUserQuery;
    if (!existingUser) {
        throw new TransactionControllerError(404, 'User transaksi tidak ditemukan');
    }

    throw new TransactionControllerError(
        400,
        `Saldo user tidak cukup untuk memproses ulang transaksi. Dibutuhkan Rp${absoluteAmount.toLocaleString('id-ID')}.`
    );
};

const buildTransactionUpdateMutation = (
    payload: StatusUpdatePayload,
    processorId: string,
    nextRefunded: boolean
) => {
    const now = new Date();
    const setFields: Record<string, unknown> = {
        status: payload.status,
        refunded: nextRefunded,
        statusUpdatedBy: processorId,
        statusUpdatedAt: now
    };
    const unsetFields: Record<string, 1> = {};

    if (payload.vendorTrxId) {
        setFields.vendorTrxId = payload.vendorTrxId;
    } else if (payload.vendorTrxId !== undefined) {
        unsetFields.vendorTrxId = 1;
    }

    if (payload.sn) {
        setFields.sn = payload.sn;
    } else if (payload.sn !== undefined) {
        unsetFields.sn = 1;
    }

    if (payload.note) {
        setFields.statusUpdateNote = payload.note;
    } else {
        unsetFields.statusUpdateNote = 1;
    }

    const update: Record<string, unknown> = { $set: setFields };
    if (Object.keys(unsetFields).length > 0) {
        update.$unset = unsetFields;
    }

    return update;
};

const buildTransactionRollbackMutation = (snapshot: TransactionAuditSnapshot) => {
    const setFields: Record<string, unknown> = {
        status: snapshot.status,
        refunded: snapshot.refunded
    };
    const unsetFields: Record<string, 1> = {};

    if (snapshot.vendorTrxId) {
        setFields.vendorTrxId = snapshot.vendorTrxId;
    } else {
        unsetFields.vendorTrxId = 1;
    }

    if (snapshot.sn) {
        setFields.sn = snapshot.sn;
    } else {
        unsetFields.sn = 1;
    }

    if (snapshot.statusUpdatedBy) {
        setFields.statusUpdatedBy = snapshot.statusUpdatedBy;
    } else {
        unsetFields.statusUpdatedBy = 1;
    }

    if (snapshot.statusUpdatedAt) {
        setFields.statusUpdatedAt = snapshot.statusUpdatedAt;
    } else {
        unsetFields.statusUpdatedAt = 1;
    }

    if (snapshot.statusUpdateNote) {
        setFields.statusUpdateNote = snapshot.statusUpdateNote;
    } else {
        unsetFields.statusUpdateNote = 1;
    }

    const update: Record<string, unknown> = { $set: setFields };
    if (Object.keys(unsetFields).length > 0) {
        update.$unset = unsetFields;
    }

    return update;
};

const populateTransactionById = async (transactionId: string) => {
    const query = Transaction.findById(transactionId)
        .populate('product', 'name code category brand vendor')
        .populate('user', 'name email')
        .populate('statusUpdatedBy', 'name email role')
        .lean();

    const transaction = await query;
    if (!transaction) {
        throw new TransactionControllerError(404, 'Transaction not found');
    }

    return transaction;
};

const listTransactions = async (
    query: TransactionListQuery,
    options: TransactionListOptions = {}
) => {
    const {
        page,
        limit,
        search,
        status,
        source,
        category,
        brand,
        vendor,
        startDate,
        endDate
    } = query;

    const currentPage = normalizePositiveInt(page, 1, 100000);
    const pageSize = normalizePositiveInt(limit, 20, options.pageSizeMax ?? 100);
    const normalizedSearch = normalizeText(search);
    const normalizedStatuses = normalizeStatusList(status, options.defaultStatuses ?? []);
    const normalizedSource = normalizeText(source) as TransactionSource | '';
    const normalizedCategory = normalizeText(category);
    const normalizedBrand = normalizeText(brand);
    const normalizedVendor = normalizeText(vendor);
    const startBoundary = parseDateBoundary(startDate, false);
    const endBoundary = parseDateBoundary(endDate, true);

    if (normalizedSource && !ALLOWED_SOURCES.includes(normalizedSource)) {
        throw new TransactionControllerError(400, 'Sumber transaksi tidak valid');
    }

    if (startBoundary && endBoundary && startBoundary > endBoundary) {
        throw new TransactionControllerError(400, 'Rentang tanggal transaksi tidak valid');
    }

    const baseMatch: Record<string, unknown> = {};
    if (normalizedStatuses.length === 1) {
        baseMatch.status = normalizedStatuses[0];
    } else if (normalizedStatuses.length > 1) {
        baseMatch.status = { $in: normalizedStatuses };
    }

    if (normalizedSource) {
        baseMatch.source = normalizedSource;
    }

    if (startBoundary || endBoundary) {
        baseMatch.createdAt = {};
        if (startBoundary) {
            (baseMatch.createdAt as Record<string, Date>).$gte = startBoundary;
        }
        if (endBoundary) {
            (baseMatch.createdAt as Record<string, Date>).$lte = endBoundary;
        }
    }

    const pipeline: mongoose.PipelineStage[] = [];
    if (Object.keys(baseMatch).length > 0) {
        pipeline.push({ $match: baseMatch });
    }

    pipeline.push(
        {
            $lookup: {
                from: User.collection.name,
                localField: 'user',
                foreignField: '_id',
                as: 'user'
            }
        },
        {
            $unwind: {
                path: '$user',
                preserveNullAndEmptyArrays: true
            }
        },
        {
            $lookup: {
                from: Product.collection.name,
                localField: 'product',
                foreignField: '_id',
                as: 'product'
            }
        },
        {
            $unwind: {
                path: '$product',
                preserveNullAndEmptyArrays: true
            }
        },
        {
            $lookup: {
                from: User.collection.name,
                localField: 'statusUpdatedBy',
                foreignField: '_id',
                as: 'statusUpdatedByUser'
            }
        },
        {
            $unwind: {
                path: '$statusUpdatedByUser',
                preserveNullAndEmptyArrays: true
            }
        },
        {
            $addFields: {
                idString: { $toString: '$_id' },
                sourceValue: { $ifNull: ['$source', 'web'] }
            }
        }
    );

    const searchFilters: Record<string, unknown>[] = [];

    if (normalizedSearch) {
        const safeSearch = escapeRegExp(normalizedSearch);
        searchFilters.push({
            $or: [
                { idString: { $regex: safeSearch, $options: 'i' } },
                { vendorTrxId: { $regex: safeSearch, $options: 'i' } },
                { customerRefId: { $regex: safeSearch, $options: 'i' } },
                { target: { $regex: safeSearch, $options: 'i' } },
                { 'user.name': { $regex: safeSearch, $options: 'i' } },
                { 'user.email': { $regex: safeSearch, $options: 'i' } },
                { 'product.name': { $regex: safeSearch, $options: 'i' } },
                { 'product.code': { $regex: safeSearch, $options: 'i' } }
            ]
        });
    }

    if (normalizedCategory) {
        searchFilters.push({
            'product.category': { $regex: escapeRegExp(normalizedCategory), $options: 'i' }
        });
    }

    if (normalizedBrand) {
        searchFilters.push({
            'product.brand': { $regex: escapeRegExp(normalizedBrand), $options: 'i' }
        });
    }

    if (normalizedVendor) {
        searchFilters.push({
            'product.vendor.name': { $regex: escapeRegExp(normalizedVendor), $options: 'i' }
        });
    }

    if (searchFilters.length > 0) {
        pipeline.push({
            $match: {
                $and: searchFilters
            }
        });
    }

    pipeline.push(
        { $sort: { createdAt: -1 } },
        {
            $facet: {
                items: [
                    { $skip: (currentPage - 1) * pageSize },
                    { $limit: pageSize },
                    {
                        $project: {
                            _id: 1,
                            target: 1,
                            amount: 1,
                            status: 1,
                            vendorTrxId: { $ifNull: ['$vendorTrxId', ''] },
                            customerRefId: { $ifNull: ['$customerRefId', ''] },
                            sn: { $ifNull: ['$sn', ''] },
                            message: { $ifNull: ['$message', ''] },
                            refunded: { $ifNull: ['$refunded', false] },
                            refundedAt: 1,
                            refundReason: { $ifNull: ['$refundReason', ''] },
                            source: '$sourceValue',
                            createdAt: 1,
                            updatedAt: 1,
                            statusUpdatedAt: 1,
                            statusUpdateNote: { $ifNull: ['$statusUpdateNote', ''] },
                            user: {
                                _id: '$user._id',
                                name: '$user.name',
                                email: '$user.email'
                            },
                            product: {
                                _id: '$product._id',
                                name: '$product.name',
                                code: '$product.code',
                                category: '$product.category',
                                brand: '$product.brand',
                                vendorName: '$product.vendor.name'
                            },
                            statusUpdatedBy: {
                                _id: '$statusUpdatedByUser._id',
                                name: '$statusUpdatedByUser.name',
                                email: '$statusUpdatedByUser.email',
                                role: '$statusUpdatedByUser.role'
                            }
                        }
                    }
                ],
                meta: [
                    { $count: 'total' }
                ],
                summary: [
                    {
                        $group: {
                            _id: null,
                            total: { $sum: 1 },
                            pending: {
                                $sum: {
                                    $cond: [{ $eq: ['$status', 'pending'] }, 1, 0]
                                }
                            },
                            processing: {
                                $sum: {
                                    $cond: [{ $eq: ['$status', 'processing'] }, 1, 0]
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
                            amountTotal: { $sum: '$amount' }
                        }
                    }
                ]
            }
        }
    );

    const [result] = await Transaction.aggregate(pipeline);
    const total = Number(result?.meta?.[0]?.total ?? 0);
    const totalPages = total > 0 ? Math.ceil(total / pageSize) : 1;
    const summary = result?.summary?.[0] ?? {
        total: 0,
        pending: 0,
        processing: 0,
        success: 0,
        failed: 0,
        amountTotal: 0
    };

    return {
        items: result?.items ?? [],
        meta: {
            page: currentPage,
            limit: pageSize,
            total,
            totalPages
        },
        summary: {
            total: Number(summary.total ?? 0),
            pending: Number(summary.pending ?? 0),
            processing: Number(summary.processing ?? 0),
            success: Number(summary.success ?? 0),
            failed: Number(summary.failed ?? 0),
            amountTotal: Number(summary.amountTotal ?? 0)
        }
    };
};

const buildTransactionCsv = (items: any[]) => {
    const header = [
        'Internal ID',
        'Vendor Trx ID',
        'Customer Ref ID',
        'Member',
        'Email',
        'Produk',
        'Kode Produk',
        'Kategori',
        'Brand',
        'Vendor',
        'Target',
        'Nominal',
        'Status',
        'Sumber',
        'Refunded',
        'Refunded At',
        'Refund Reason',
        'SN',
        'Vendor Message',
        'Catatan Admin',
        'Dibuat',
        'Diupdate',
        'Update Manual',
        'Updated By'
    ];

    const rows = items.map((trx) => ([
        trx._id,
        trx.vendorTrxId || '',
        trx.customerRefId || '',
        trx.user?.name || '',
        trx.user?.email || '',
        trx.product?.name || '',
        trx.product?.code || '',
        trx.product?.category || '',
        trx.product?.brand || '',
        trx.product?.vendorName || '',
        trx.target || '',
        trx.amount || 0,
        trx.status || '',
        trx.source || '',
        trx.refunded ? 'yes' : 'no',
        formatCsvDate(trx.refundedAt),
        trx.refundReason || '',
        trx.sn || '',
        trx.message || '',
        trx.statusUpdateNote || '',
        formatCsvDate(trx.createdAt),
        formatCsvDate(trx.updatedAt),
        formatCsvDate(trx.statusUpdatedAt),
        trx.statusUpdatedBy?.email || trx.statusUpdatedBy?.name || ''
    ]));

    return [header, ...rows]
        .map((row) => row.map(csvEscape).join(','))
        .join('\n');
};

const listStuckTransactions = async (query: StuckTransactionQuery) => {
    const thresholdMinutes = normalizePositiveInt(
        query.thresholdMinutes,
        STUCK_TRANSACTION_DEFAULT_MINUTES,
        24 * 60
    );
    const limit = normalizePositiveInt(query.limit, 10, STUCK_TRANSACTION_MAX_LIMIT);
    const cutoff = new Date(Date.now() - thresholdMinutes * 60 * 1000);

    const baseMatch = {
        status: { $in: ['pending', 'processing'] },
        updatedAt: { $lte: cutoff }
    };

    const [items, total] = await Promise.all([
        Transaction.find(baseMatch)
            .populate('product', 'name code category brand vendor')
            .populate('user', 'name email')
            .sort({ updatedAt: 1 })
            .limit(limit)
            .lean(),
        Transaction.countDocuments(baseMatch)
    ]);

    return {
        thresholdMinutes,
        total,
        items: items.map((transaction) => ({
            _id: transaction._id,
            target: transaction.target,
            amount: transaction.amount,
            status: transaction.status,
            vendorTrxId: transaction.vendorTrxId || '',
            customerRefId: transaction.customerRefId || '',
            source: transaction.source || 'web',
            createdAt: transaction.createdAt,
            updatedAt: transaction.updatedAt,
            ageMinutes: Math.max(0, Math.floor((Date.now() - new Date(transaction.updatedAt).getTime()) / 60000)),
            user: transaction.user,
            product: transaction.product
        }))
    };
};

const updateTransactionStatusWithTransaction = async (
    transactionId: string,
    processorId: string,
    payload: StatusUpdatePayload
) => {
    const session = await mongoose.startSession();

    try {
        let updatedTransactionId: string | null = null;

        await session.withTransaction(async () => {
            const query = Transaction.findById(transactionId);
            const transaction = await query.session(session);

            if (!transaction) {
                throw new TransactionControllerError(404, 'Transaction not found');
            }

            const previousStatus = transaction.status as TransactionStatus;
            const transitionPlan = applyTransitionPlan(
                previousStatus,
                Boolean(transaction.refunded),
                transaction.amount,
                payload.status
            );
            const auditNote = buildAdminStatusNote(previousStatus, payload.status, payload.note);

            if (transitionPlan.balanceDelta !== 0) {
                await updateUserBalance(transaction.user.toString(), transitionPlan.balanceDelta, session);
            }

            if (transitionPlan.shouldRevokePoints) {
                await revokeAwardedPoints(
                    transaction.user.toString(),
                    transaction._id.toString(),
                    {
                        session,
                        throwOnError: true,
                        description: auditNote
                    }
                );
            }

            transaction.status = payload.status;
            transaction.refunded = transitionPlan.nextRefunded;

            if (payload.vendorTrxId !== undefined) {
                transaction.vendorTrxId = payload.vendorTrxId || undefined;
            }

            if (payload.sn !== undefined) {
                transaction.sn = payload.sn || undefined;
            }

            transaction.statusUpdatedBy = new mongoose.Types.ObjectId(processorId);
            transaction.statusUpdatedAt = new Date();
            transaction.statusUpdateNote = payload.note || undefined;

            await transaction.save({ session });

            if (transitionPlan.shouldAwardPoints) {
                await awardPoints(
                    transaction.user.toString(),
                    transaction.amount,
                    transaction._id.toString(),
                    {
                        session,
                        throwOnError: true,
                        description: auditNote
                    }
                );
            }

            updatedTransactionId = transaction._id.toString();
        });

        if (!updatedTransactionId) {
            throw new Error('Transaction status update did not complete');
        }

        return updatedTransactionId;
    } finally {
        await session.endSession();
    }
};

const updateTransactionStatusWithCompensation = async (
    transactionId: string,
    processorId: string,
    payload: StatusUpdatePayload
) => {
    const transaction = await Transaction.findById(transactionId);
    if (!transaction) {
        throw new TransactionControllerError(404, 'Transaction not found');
    }

    const previousStatus = transaction.status as TransactionStatus;
    const transitionPlan = applyTransitionPlan(
        previousStatus,
        Boolean(transaction.refunded),
        transaction.amount,
        payload.status
    );
    const auditNote = buildAdminStatusNote(previousStatus, payload.status, payload.note);
    const snapshot: TransactionAuditSnapshot = {
        status: previousStatus,
        refunded: Boolean(transaction.refunded),
        vendorTrxId: transaction.vendorTrxId || undefined,
        sn: transaction.sn || undefined,
        statusUpdatedBy: transaction.statusUpdatedBy,
        statusUpdatedAt: transaction.statusUpdatedAt,
        statusUpdateNote: transaction.statusUpdateNote || undefined,
        updatedAt: transaction.updatedAt
    };

    let balanceDeltaApplied = 0;
    let pointsRevoked = 0;
    let claimed = false;
    let pointsAwarded = 0;

    try {
        if (transitionPlan.balanceDelta !== 0) {
            await updateUserBalance(transaction.user.toString(), transitionPlan.balanceDelta);
            balanceDeltaApplied = transitionPlan.balanceDelta;
        }

        if (transitionPlan.shouldRevokePoints) {
            pointsRevoked = await revokeAwardedPoints(
                transaction.user.toString(),
                transaction._id.toString(),
                {
                    throwOnError: true,
                    description: auditNote
                }
            );
        }

        const updatedTransaction = await Transaction.findOneAndUpdate(
            {
                _id: transactionId,
                status: snapshot.status,
                refunded: snapshot.refunded,
                updatedAt: snapshot.updatedAt
            },
            buildTransactionUpdateMutation(payload, processorId, transitionPlan.nextRefunded),
            { new: true }
        );

        if (!updatedTransaction) {
            throw new TransactionControllerError(
                409,
                'Transaksi sedang diperbarui oleh proses lain. Muat ulang halaman lalu coba lagi.'
            );
        }

        claimed = true;

        if (transitionPlan.shouldAwardPoints) {
            pointsAwarded = await awardPoints(
                updatedTransaction.user.toString(),
                updatedTransaction.amount,
                updatedTransaction._id.toString(),
                {
                    throwOnError: true,
                    description: auditNote
                }
            );
        }

        return updatedTransaction._id.toString();
    } catch (error) {
        if (claimed) {
            try {
                await Transaction.findByIdAndUpdate(transactionId, buildTransactionRollbackMutation(snapshot));
            } catch (rollbackError) {
                console.error('Failed to roll back transaction status update', rollbackError);
            }
        }

        if (pointsAwarded > 0) {
            try {
                await revokeAwardedPoints(
                    transaction.user.toString(),
                    transaction._id.toString(),
                    {
                        description: 'Rollback points after failed transaction status update'
                    }
                );
            } catch (rollbackError) {
                console.error('Failed to roll back awarded points', rollbackError);
            }
        }

        if (pointsRevoked > 0) {
            try {
                await awardPoints(
                    transaction.user.toString(),
                    transaction.amount,
                    transaction._id.toString(),
                    {
                        description: 'Rollback points after failed transaction status update'
                    }
                );
            } catch (rollbackError) {
                console.error('Failed to restore revoked points', rollbackError);
            }
        }

        if (balanceDeltaApplied !== 0) {
            try {
                await updateUserBalance(transaction.user.toString(), -balanceDeltaApplied);
            } catch (rollbackError) {
                console.error('Failed to roll back user balance mutation', rollbackError);
            }
        }

        throw error;
    }
};

const refundTransactionWithTransaction = async (
    transactionId: string,
    processorId: string,
    reason: string
) => {
    const session = await mongoose.startSession();

    try {
        let updatedTransactionId: string | null = null;

        await session.withTransaction(async () => {
            const transaction = await Transaction.findById(transactionId).session(session);
            if (!transaction) {
                throw new TransactionControllerError(404, 'Transaction not found');
            }

            if (transaction.refunded) {
                throw new TransactionControllerError(409, 'Transaksi ini sudah direfund');
            }

            if (transaction.status === 'success') {
                throw new TransactionControllerError(400, 'Transaksi sukses harus diubah ke failed dari edit status agar poin ikut direkonsiliasi');
            }

            const user = await User.findById(transaction.user).select('_id balance').session(session);
            if (!user) {
                throw new TransactionControllerError(404, 'User transaksi tidak ditemukan');
            }

            const balanceBefore = Number(user.balance || 0);
            const balanceAfter = balanceBefore + Number(transaction.amount || 0);
            const refundReason = buildRefundReason(transaction._id.toString(), reason);

            user.balance = balanceAfter;
            await user.save({ session });

            await UserBalanceAdjustment.create([{
                user: transaction.user,
                adjustedBy: processorId,
                type: 'add',
                amount: transaction.amount,
                balanceBefore,
                balanceAfter,
                reason: refundReason
            }], { session });

            transaction.status = 'failed';
            transaction.refunded = true;
            transaction.refundedBy = new mongoose.Types.ObjectId(processorId);
            transaction.refundedAt = new Date();
            transaction.refundReason = reason;
            transaction.statusUpdatedBy = new mongoose.Types.ObjectId(processorId);
            transaction.statusUpdatedAt = new Date();
            transaction.statusUpdateNote = refundReason;
            await transaction.save({ session });

            updatedTransactionId = transaction._id.toString();
        });

        if (!updatedTransactionId) {
            throw new Error('Transaction refund did not complete');
        }

        return updatedTransactionId;
    } finally {
        await session.endSession();
    }
};

const refundTransactionWithCompensation = async (
    transactionId: string,
    processorId: string,
    reason: string
) => {
    const transaction = await Transaction.findById(transactionId);
    if (!transaction) {
        throw new TransactionControllerError(404, 'Transaction not found');
    }

    if (transaction.refunded) {
        throw new TransactionControllerError(409, 'Transaksi ini sudah direfund');
    }

    if (transaction.status === 'success') {
        throw new TransactionControllerError(400, 'Transaksi sukses harus diubah ke failed dari edit status agar poin ikut direkonsiliasi');
    }

    const refundReason = buildRefundReason(transaction._id.toString(), reason);
    const previousStatus = transaction.status as TransactionStatus;
    const previousUpdatedAt = transaction.updatedAt;
    let balanceApplied = false;
    let adjustmentId: mongoose.Types.ObjectId | null = null;
    let claimed = false;

    try {
        const updatedTransaction = await Transaction.findOneAndUpdate(
            {
                _id: transactionId,
                refunded: { $ne: true },
                updatedAt: previousUpdatedAt
            },
            {
                $set: {
                    status: 'failed',
                    refunded: true,
                    refundedBy: processorId,
                    refundedAt: new Date(),
                    refundReason: reason,
                    statusUpdatedBy: processorId,
                    statusUpdatedAt: new Date(),
                    statusUpdateNote: refundReason
                }
            },
            { new: true }
        );

        if (!updatedTransaction) {
            throw new TransactionControllerError(409, 'Transaksi sedang diperbarui oleh proses lain. Muat ulang halaman lalu coba lagi.');
        }

        claimed = true;

        const user = await User.findById(transaction.user).select('_id balance');
        if (!user) {
            throw new TransactionControllerError(404, 'User transaksi tidak ditemukan');
        }

        const balanceBefore = Number(user.balance || 0);
        const balanceAfter = balanceBefore + Number(transaction.amount || 0);
        user.balance = balanceAfter;
        await user.save();
        balanceApplied = true;

        const adjustment = await UserBalanceAdjustment.create({
            user: transaction.user,
            adjustedBy: processorId,
            type: 'add',
            amount: transaction.amount,
            balanceBefore,
            balanceAfter,
            reason: refundReason
        });
        adjustmentId = adjustment._id;

        return updatedTransaction._id.toString();
    } catch (error) {
        if (adjustmentId) {
            try {
                await UserBalanceAdjustment.findByIdAndDelete(adjustmentId);
            } catch (rollbackError) {
                console.error('Failed to remove refund adjustment after rollback', rollbackError);
            }
        }

        if (balanceApplied) {
            try {
                await updateUserBalance(transaction.user.toString(), -transaction.amount);
            } catch (rollbackError) {
                console.error('Failed to roll back refund balance mutation', rollbackError);
            }
        }

        if (claimed) {
            try {
                await Transaction.findByIdAndUpdate(transactionId, {
                    $set: {
                        status: previousStatus,
                        refunded: false,
                        updatedAt: previousUpdatedAt
                    },
                    $unset: {
                        refundedBy: 1,
                        refundedAt: 1,
                        refundReason: 1,
                        statusUpdatedBy: 1,
                        statusUpdatedAt: 1,
                        statusUpdateNote: 1
                    }
                });
            } catch (rollbackError) {
                console.error('Failed to roll back transaction refund flag', rollbackError);
            }
        }

        throw error;
    }
};

const recheckTransactionWithVendor = async (
    transactionId: string,
    processorId: string
) => {
    const transaction = await Transaction.findById(transactionId)
        .populate('product', 'name code vendor')
        .lean();

    if (!transaction) {
        throw new TransactionControllerError(404, 'Transaction not found');
    }

    if (!['pending', 'processing'].includes(transaction.status)) {
        throw new TransactionControllerError(400, 'Hanya transaksi pending/proses yang bisa dicek ulang ke vendor');
    }

    const product = transaction.product as { code?: string; vendor?: { name?: string; sku?: string } } | null;
    const vendorStatus = await vendorService.checkStatus(
        transaction.vendorTrxId || transaction._id.toString(),
        transaction.vendorTrxId,
        product?.vendor?.name,
        product?.vendor?.sku || product?.code,
        transaction.target
    );

    if (!vendorStatus || vendorStatus.status === 'pending') {
        return {
            changed: false,
            status: transaction.status as TransactionStatus,
            message: vendorStatus?.message || 'Vendor masih mengembalikan status pending'
        };
    }

    const payload: StatusUpdatePayload = {
        status: vendorStatus.status,
        sn: vendorStatus.sn,
        note: `Vendor recheck: ${vendorStatus.message || vendorStatus.status}`
    };

    let updatedTransactionId: string;
    try {
        updatedTransactionId = await updateTransactionStatusWithTransaction(transactionId, processorId, payload);
    } catch (error) {
        if (!isTransactionSupportError(error)) {
            throw error;
        }

        updatedTransactionId = await updateTransactionStatusWithCompensation(transactionId, processorId, payload);
    }

    return {
        changed: true,
        status: vendorStatus.status,
        message: vendorStatus.message || `Status vendor ${vendorStatus.status}`,
        transactionId: updatedTransactionId
    };
};

export const createTransaction = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { productId, productCode, target, serverId, useFlashSale } = request.body as any;
        const userId = request.user!.id;
        const siteSettings = await getSiteSettings(['maintenanceMode', 'maintenanceMessage']);
        const normalizedTarget = normalizeText(target);
        const normalizedServerId = normalizeText(serverId);

        // Only members can create transactions (not admin/cs/owner)
        if (['owner', 'admin', 'cs'].includes(request.user!.role)) {
            return reply.status(403).send({ message: 'Team accounts cannot create transactions' });
        }

        if (siteSettings.maintenanceMode) {
            return reply.status(503).send({ message: buildMaintenanceMessage(siteSettings.maintenanceMessage) });
        }

        // 1. Get Product by ID or Code
        if (!normalizedTarget) {
            return reply.status(400).send({ message: 'Target wajib diisi' });
        }

        let product;
        if (productId) {
            product = await Product.findById(productId);
        } else if (productCode) {
            product = await Product.findOne({ code: productCode });
        }
        if (!product) return reply.status(404).send({ message: 'Product not found' });
        if (!product.status) return reply.status(400).send({ message: 'Product is unavailable' });

        const visibilityIssues = await getProductPurchaseIssues(product);
        if (visibilityIssues.length > 0) {
            return reply.status(400).send({
                message: `Produk tidak tersedia untuk dibeli: ${visibilityIssues.join(', ')}`
            });
        }

        // 2. Get User & Check Balance
        const user = await User.findById(userId);
        if (!user) return reply.status(404).send({ message: 'User not found' });

        // Determine price based on user level
        const basePrice = product.price[user.level as 'basic' | 'gold' | 'platinum'];
        let price = basePrice;

        if (useFlashSale) {
            const flashSale = await getFlashSalePriceForProduct(product._id.toString(), basePrice);
            if (flashSale) {
                price = flashSale.flashPrice;
                await reserveFlashSaleStock(flashSale.flashSaleId, product._id.toString());
            }
        }

        if (user.balance < price) {
            return reply.status(400).send({ message: 'Insufficient balance' });
        }

        // 3. Generate ref_id for vendor
        const refId = await generateRefId();

        // 4. Deduct Balance & Create Transaction (Atomic-like)
        user.balance -= price;
        await user.save();

        const transaction = await Transaction.create({
            user: userId,
            product: product._id,
            target: normalizedTarget,
            serverId: normalizedServerId || undefined,
            amount: price,
            status: 'pending',
            vendorTrxId: refId
        });

        // 5. Trigger Vendor API
        try {
            const vendorRes = await vendorService.topUp(
                refId,
                product.vendor?.sku || product.code,
                normalizedTarget,
                product.vendor?.name,
                normalizedServerId || undefined
            );

            transaction.status = vendorRes.status;
            if (vendorRes.vendorTrxId) transaction.vendorTrxId = vendorRes.vendorTrxId;
            if (vendorRes.sn) transaction.sn = vendorRes.sn;
            await transaction.save();

            // If failed immediately, refund
            if (transaction.status === 'failed') {
                user.balance += price;
                await user.save();
                transaction.refunded = true;
                transaction.refundedAt = new Date();
                transaction.refundReason = 'Vendor returned failed during initial processing';
                await transaction.save();
            }

            // If success, award points
            if (transaction.status === 'success') {
                await awardPoints(userId, price, transaction._id.toString());
            }
        } catch (err) {
            console.error('Vendor processing error:', err);
            // Keep transaction pending so it can be reconciled later.
        }

        return reply.status(201).send({
            message: 'Transaction created',
            transaction,
            remainingBalance: user.balance
        });

    } catch (error) {
        console.error(error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const getTransactions = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const userId = request.user!.id;
        const role = request.user!.role;

        const query: Record<string, unknown> = {};
        // Owner, admin, cs can see all transactions; members see only their own
        if (!['owner', 'admin', 'cs'].includes(role)) {
            query.user = userId;
        }

        // Get balance transactions
        const balanceTransactions = (await Transaction.find(query)
            .populate('product', 'name code category brand vendor')
            .populate('user', 'name email')
            .sort({ createdAt: -1 })
            .lean()).map((transaction) => ({
                ...transaction,
                source: 'balance'
            }));

        // For members, also get their payment gateway transactions from GuestTransaction
        let paymentTransactions: any[] = [];
        if (!['owner', 'admin', 'cs'].includes(role)) {
            const guestTrx = await GuestTransaction.find({ user: userId })
                .populate('product', 'name code category brand vendor')
                .sort({ createdAt: -1 })
                .lean();

            // Transform GuestTransaction to match Transaction format
            paymentTransactions = guestTrx.map((gt) => ({
                _id: gt._id,
                user: { _id: userId },
                product: gt.product,
                target: gt.target,
                amount: gt.totalAmount,
                status: gt.transactionStatus,
                vendorTrxId: gt.vendorTrxId,
                sn: gt.sn,
                paymentStatus: gt.paymentStatus,
                invoiceNumber: gt.invoiceNumber,
                source: 'payment_gateway',
                createdAt: gt.createdAt,
                updatedAt: gt.updatedAt
            }));
        }

        // Merge and sort by createdAt
        const allTransactions = [...balanceTransactions, ...paymentTransactions]
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

        return reply.send(allTransactions);
    } catch (error) {
        console.error(error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const getAdminTransactions = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const result = await listTransactions(request.query as TransactionListQuery);
        return reply.send(result);
    } catch (error) {
        return handleControllerError(reply, error);
    }
};

export const getStuckTransactions = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const result = await listStuckTransactions(request.query as StuckTransactionQuery);
        return reply.send(result);
    } catch (error) {
        return handleControllerError(reply, error);
    }
};

export const exportAdminTransactionsCsv = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const query = request.query as TransactionListQuery;
        const result = await listTransactions(
            {
                ...query,
                page: 1,
                limit: 5000
            },
            { pageSizeMax: 5000 }
        );
        const csv = buildTransactionCsv(result.items);
        const filename = `admin-transactions-${new Date().toISOString().slice(0, 10)}.csv`;

        return reply
            .header('Content-Type', 'text/csv; charset=utf-8')
            .header('Content-Disposition', `attachment; filename="${filename}"`)
            .send(`\uFEFF${csv}`);
    } catch (error) {
        return handleControllerError(reply, error);
    }
};

export const getManualTransactions = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const query = request.query as TransactionListQuery;
        const normalizedScope = normalizeText(query.scope);
        const defaultStatuses: TransactionStatus[] = normalizedScope === 'all'
            ? []
            : ['pending', 'processing', 'failed'];

        const result = await listTransactions(query, { defaultStatuses });
        return reply.send(result);
    } catch (error) {
        return handleControllerError(reply, error);
    }
};

export const updateTransactionStatus = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };
        if (!mongoose.Types.ObjectId.isValid(id)) {
            throw new TransactionControllerError(400, 'ID transaksi tidak valid');
        }

        const processorId = request.user?.id;
        if (!processorId) {
            throw new TransactionControllerError(401, 'Unauthorized');
        }

        const payload = normalizeStatusUpdatePayload(request.body);

        let updatedTransactionId: string;
        try {
            updatedTransactionId = await updateTransactionStatusWithTransaction(id, processorId, payload);
        } catch (error) {
            if (!isTransactionSupportError(error)) {
                throw error;
            }

            updatedTransactionId = await updateTransactionStatusWithCompensation(id, processorId, payload);
        }

        const populatedTransaction = await populateTransactionById(updatedTransactionId);

        return reply.send({
            message: 'Transaction updated',
            transaction: populatedTransaction
        });
    } catch (error) {
        return handleControllerError(reply, error);
    }
};

export const recheckTransactionStatus = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };
        if (!mongoose.Types.ObjectId.isValid(id)) {
            throw new TransactionControllerError(400, 'ID transaksi tidak valid');
        }

        const processorId = request.user?.id;
        if (!processorId) {
            throw new TransactionControllerError(401, 'Unauthorized');
        }

        const result = await recheckTransactionWithVendor(id, processorId);
        const populatedTransaction = result.transactionId
            ? await populateTransactionById(result.transactionId)
            : await populateTransactionById(id);

        return reply.send({
            changed: result.changed,
            status: result.status,
            message: result.changed ? 'Status transaksi diperbarui dari vendor' : result.message,
            vendorMessage: result.message,
            transaction: populatedTransaction
        });
    } catch (error) {
        return handleControllerError(reply, error);
    }
};

export const refundTransaction = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };
        if (!mongoose.Types.ObjectId.isValid(id)) {
            throw new TransactionControllerError(400, 'ID transaksi tidak valid');
        }

        const processorId = request.user?.id;
        if (!processorId) {
            throw new TransactionControllerError(401, 'Unauthorized');
        }

        const { reason } = normalizeRefundPayload(request.body);

        let updatedTransactionId: string;
        try {
            updatedTransactionId = await refundTransactionWithTransaction(id, processorId, reason);
        } catch (error) {
            if (!isTransactionSupportError(error)) {
                throw error;
            }

            updatedTransactionId = await refundTransactionWithCompensation(id, processorId, reason);
        }

        const populatedTransaction = await populateTransactionById(updatedTransactionId);

        return reply.send({
            message: 'Saldo transaksi berhasil direfund',
            transaction: populatedTransaction
        });
    } catch (error) {
        return handleControllerError(reply, error);
    }
};
