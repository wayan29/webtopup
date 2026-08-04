import mongoose from 'mongoose';
import { FastifyReply } from 'fastify';
import { Deposit, User, PaymentMethod } from '../models';
import { AuthRequest } from '../middlewares/authMiddleware';
import { isOperationalNow } from '../utils/paymentMethodUtils';
import { getSiteSettings } from '../services/siteSettingsService';
import { buildMaintenanceMessage } from '../utils/siteSettingsRuntime';

type DepositStatus = 'pending' | 'approved' | 'rejected';
type DepositPermission = 'viewDeposits' | 'approveDeposits';

type AdminDepositsQuery = {
    page?: string | number;
    limit?: string | number;
    invoiceId?: string;
    userQuery?: string;
    totalTransfer?: string;
    status?: string;
    assignment?: string;
};

type AdminDepositsListOptions = {
    pageSizeMax?: number;
    actorId?: string;
};

class DepositControllerError extends Error {
    statusCode: number;

    constructor(statusCode: number, message: string) {
        super(message);
        this.statusCode = statusCode;
    }
}

const ALLOWED_STATUSES: DepositStatus[] = ['pending', 'approved', 'rejected'];
const ALLOWED_ASSIGNMENT_FILTERS = ['unassigned', 'mine', 'locked'];

const generateUniqueCode = (): number => {
    return Math.floor(Math.random() * 999) + 1;
};

const isTransactionSupportError = (error: unknown) => {
    if (!(error instanceof Error)) {
        return false;
    }

    return /transaction numbers are only allowed on a replica set member or mongos|does not support transactions|transaction support/i.test(error.message);
};

const handleControllerError = (reply: FastifyReply, error: unknown) => {
    console.error(error);

    if (error instanceof DepositControllerError) {
        return reply.status(error.statusCode).send({ message: error.message });
    }

    return reply.status(500).send({ message: 'Internal Server Error' });
};

const normalizeText = (value: unknown) => (
    typeof value === 'string' ? value.trim() : ''
);

const normalizePositiveInt = (value: unknown, fallback: number, max: number) => {
    const normalized = Number(value);

    if (!Number.isFinite(normalized) || normalized <= 0) {
        return fallback;
    }

    return Math.min(Math.floor(normalized), max);
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

const ensureTeamPermission = async (request: AuthRequest, permission: DepositPermission) => {
    const user = request.user;
    if (!user) {
        throw new DepositControllerError(401, 'Unauthorized');
    }

    if (user.role === 'owner') {
        return;
    }

    if (!['admin', 'cs'].includes(user.role)) {
        throw new DepositControllerError(403, 'Forbidden');
    }

    const activeUser = await User.findById(user.id).select('permissions active').lean();
    if (!activeUser || activeUser.active === false) {
        throw new DepositControllerError(403, 'Forbidden: Account inactive');
    }

    if (!activeUser.permissions || !activeUser.permissions[permission]) {
        throw new DepositControllerError(403, 'Forbidden: Permission denied');
    }
};

const getNetDepositValue = (deposit: { amount: number; adminFee?: number | null }) => {
    const adminFee = Math.max(0, Number(deposit.adminFee ?? 0));
    const netAmount = Number(deposit.amount ?? 0) - adminFee;

    if (netAmount <= 0) {
        throw new DepositControllerError(
            400,
            'Nominal bersih deposit tidak valid. Periksa biaya admin metode pembayaran ini.'
        );
    }

    return {
        adminFee,
        netAmount
    };
};

const normalizeProcessingNote = (value: unknown, required = false) => {
    const note = normalizeText(value);

    if (required && !note) {
        throw new DepositControllerError(400, 'Catatan penolakan wajib diisi');
    }

    if (note.length > 500) {
        throw new DepositControllerError(400, 'Catatan proses maksimal 500 karakter');
    }

    return note;
};

const buildProcessingUpdate = (
    status: Extract<DepositStatus, 'approved' | 'rejected'>,
    processorId: string,
    note: string
) => {
    const update: Record<string, any> = {
        $set: {
            status,
            processedBy: processorId,
            processedAt: new Date()
        }
    };

    if (note) {
        update.$set.processingNote = note;
    } else {
        update.$unset = { processingNote: 1 };
    }

    return update;
};

const buildAssignmentAccessFilter = (depositId: string, processorId: string, isOwner: boolean) => {
    const filter: Record<string, unknown> = {
        _id: depositId,
        status: 'pending'
    };

    if (!isOwner) {
        filter.$or = [
            { assignedTo: { $exists: false } },
            { assignedTo: null },
            { assignedTo: new mongoose.Types.ObjectId(processorId) }
        ];
    }

    return filter;
};

const buildResetProcessingUpdate = () => ({
    $set: { status: 'pending' },
    $unset: {
        processedBy: 1,
        processedAt: 1,
        processingNote: 1,
        assignedTo: 1,
        assignedAt: 1
    }
});

const getPopulateConfig = () => ([
    { path: 'user', select: 'name email' },
    { path: 'paymentMethod', select: 'name accountNumber accountName' },
    { path: 'assignedTo', select: 'name email role' },
    { path: 'processedBy', select: 'name email role' }
]);

const approveDepositWithTransaction = async (depositId: string, processorId: string, note: string, isOwner: boolean) => {
    const session = await mongoose.startSession();

    try {
        let result: {
            depositId: string;
            adminFee: number;
            netAmount: number;
            newBalance: number;
        } | null = null;

        await session.withTransaction(async () => {
            const claimedDeposit = await Deposit.findOneAndUpdate(
                buildAssignmentAccessFilter(depositId, processorId, isOwner),
                buildProcessingUpdate('approved', processorId, note),
                { new: true, session }
            );

            if (!claimedDeposit) {
                throw new DepositControllerError(409, 'Deposit sudah diproses, tidak ditemukan, atau sedang di-claim admin lain');
            }

            const { adminFee, netAmount } = getNetDepositValue(claimedDeposit);

            const updatedUser = await User.findByIdAndUpdate(
                claimedDeposit.user,
                { $inc: { balance: netAmount } },
                { new: true, session }
            );

            if (!updatedUser) {
                throw new DepositControllerError(404, 'User tidak ditemukan');
            }

            result = {
                depositId: claimedDeposit._id.toString(),
                adminFee,
                netAmount,
                newBalance: updatedUser.balance
            };
        });

        if (!result) {
            throw new Error('Deposit approval transaction did not complete');
        }

        return result;
    } finally {
        await session.endSession();
    }
};

const approveDepositWithCompensation = async (depositId: string, processorId: string, note: string, isOwner: boolean) => {
    const claimedDeposit = await Deposit.findOneAndUpdate(
        buildAssignmentAccessFilter(depositId, processorId, isOwner),
        buildProcessingUpdate('approved', processorId, note),
        { new: true }
    );

    if (!claimedDeposit) {
        throw new DepositControllerError(409, 'Deposit sudah diproses, tidak ditemukan, atau sedang di-claim admin lain');
    }

    let updatedUser: { balance: number } | null = null;

    try {
        const { adminFee, netAmount } = getNetDepositValue(claimedDeposit);

        updatedUser = await User.findByIdAndUpdate(
            claimedDeposit.user,
            { $inc: { balance: netAmount } },
            { new: true }
        ).select('balance');

        if (!updatedUser) {
            await Deposit.findByIdAndUpdate(depositId, buildResetProcessingUpdate());
            throw new DepositControllerError(404, 'User tidak ditemukan');
        }

        return {
            depositId: claimedDeposit._id.toString(),
            adminFee,
            netAmount,
            newBalance: updatedUser.balance
        };
    } catch (error) {
        if (!updatedUser) {
            try {
                await Deposit.findByIdAndUpdate(depositId, buildResetProcessingUpdate());
            } catch (rollbackError) {
                console.error('Failed to roll back claimed deposit approval', rollbackError);
            }
        }

        throw error;
    }
};

const populateDepositById = async (depositId: string) => {
    let query = Deposit.findById(depositId);
    for (const populateItem of getPopulateConfig()) {
        query = query.populate(populateItem.path, populateItem.select);
    }

    return query.lean();
};

const listAdminDeposits = async (
    query: AdminDepositsQuery,
    options: AdminDepositsListOptions = {}
) => {
    const {
        page,
        limit,
        invoiceId,
        userQuery,
        totalTransfer,
        status,
        assignment
    } = query;

    const currentPage = normalizePositiveInt(page, 1, 100000);
    const pageSize = normalizePositiveInt(limit, 20, options.pageSizeMax ?? 100);
    const normalizedInvoiceId = normalizeText(invoiceId);
    const normalizedUserQuery = normalizeText(userQuery);
    const normalizedTotalTransfer = normalizeText(totalTransfer);
    const normalizedStatus = normalizeText(status) as DepositStatus | '';
    const normalizedAssignment = normalizeText(assignment);

    if (normalizedStatus && !ALLOWED_STATUSES.includes(normalizedStatus)) {
        throw new DepositControllerError(400, 'Status deposit tidak valid');
    }

    if (normalizedAssignment && !ALLOWED_ASSIGNMENT_FILTERS.includes(normalizedAssignment)) {
        throw new DepositControllerError(400, 'Filter claim deposit tidak valid');
    }

    if (normalizedAssignment && !options.actorId) {
        throw new DepositControllerError(401, 'Unauthorized');
    }

    const matchStages: Record<string, unknown>[] = [];
    if (normalizedStatus) {
        matchStages.push({ status: normalizedStatus });
    }

    if (normalizedAssignment === 'unassigned') {
        matchStages.push({
            status: 'pending',
            $or: [
                { assignedTo: { $exists: false } },
                { assignedTo: null }
            ]
        });
    } else if (normalizedAssignment === 'mine') {
        matchStages.push({
            status: 'pending',
            assignedTo: new mongoose.Types.ObjectId(options.actorId)
        });
    } else if (normalizedAssignment === 'locked') {
        matchStages.push({
            status: 'pending',
            assignedTo: { $nin: [null, new mongoose.Types.ObjectId(options.actorId)] }
        });
    }

    const pipeline: mongoose.PipelineStage[] = [];

    if (matchStages.length > 0) {
        pipeline.push({ $match: Object.assign({}, ...matchStages) });
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
                from: PaymentMethod.collection.name,
                localField: 'paymentMethod',
                foreignField: '_id',
                as: 'paymentMethod'
            }
        },
        {
            $unwind: {
                path: '$paymentMethod',
                preserveNullAndEmptyArrays: true
            }
        },
        {
            $lookup: {
                from: User.collection.name,
                localField: 'assignedTo',
                foreignField: '_id',
                as: 'assignedToUser'
            }
        },
        {
            $unwind: {
                path: '$assignedToUser',
                preserveNullAndEmptyArrays: true
            }
        },
        {
            $lookup: {
                from: User.collection.name,
                localField: 'processedBy',
                foreignField: '_id',
                as: 'processedByUser'
            }
        },
        {
            $unwind: {
                path: '$processedByUser',
                preserveNullAndEmptyArrays: true
            }
        },
        {
            $addFields: {
                idString: { $toString: '$_id' },
                invoiceCode: {
                    $concat: [
                        'INV',
                        {
                            $toUpper: {
                                $substrBytes: [{ $toString: '$_id' }, 16, 8]
                            }
                        }
                    ]
                },
                effectiveTotalAmount: { $ifNull: ['$totalAmount', '$amount'] },
                effectiveTotalAmountString: {
                    $toString: { $ifNull: ['$totalAmount', '$amount'] }
                },
                netAmount: {
                    $subtract: ['$amount', { $ifNull: ['$adminFee', 0] }]
                }
            }
        }
    );

    const searchFilters: Record<string, unknown>[] = [];

    if (normalizedInvoiceId) {
        const safeInvoice = escapeRegExp(normalizedInvoiceId);
        searchFilters.push({
            $or: [
                { idString: { $regex: safeInvoice, $options: 'i' } },
                { invoiceCode: { $regex: safeInvoice, $options: 'i' } }
            ]
        });
    }

    if (normalizedUserQuery) {
        const safeUser = escapeRegExp(normalizedUserQuery);
        searchFilters.push({
            $or: [
                { 'user.name': { $regex: safeUser, $options: 'i' } },
                { 'user.email': { $regex: safeUser, $options: 'i' } }
            ]
        });
    }

    if (normalizedTotalTransfer) {
        searchFilters.push({
            effectiveTotalAmountString: { $regex: escapeRegExp(normalizedTotalTransfer) }
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
                            amount: 1,
                            uniqueCode: { $ifNull: ['$uniqueCode', 0] },
                            adminFee: { $ifNull: ['$adminFee', 0] },
                            totalAmount: '$effectiveTotalAmount',
                            netAmount: 1,
                            status: 1,
                            createdAt: 1,
                            updatedAt: 1,
                            assignedAt: 1,
                            processedAt: 1,
                            processingNote: { $ifNull: ['$processingNote', ''] },
                            invoiceCode: 1,
                            user: {
                                _id: '$user._id',
                                name: '$user.name',
                                email: '$user.email'
                            },
                            paymentMethod: {
                                _id: '$paymentMethod._id',
                                name: '$paymentMethod.name',
                                accountNumber: '$paymentMethod.accountNumber',
                                accountName: '$paymentMethod.accountName'
                            },
                            assignedTo: {
                                _id: '$assignedToUser._id',
                                name: '$assignedToUser.name',
                                email: '$assignedToUser.email',
                                role: '$assignedToUser.role'
                            },
                            processedBy: {
                                _id: '$processedByUser._id',
                                name: '$processedByUser.name',
                                email: '$processedByUser.email',
                                role: '$processedByUser.role'
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
                            approved: {
                                $sum: {
                                    $cond: [{ $eq: ['$status', 'approved'] }, 1, 0]
                                }
                            },
                            rejected: {
                                $sum: {
                                    $cond: [{ $eq: ['$status', 'rejected'] }, 1, 0]
                                }
                            }
                        }
                    }
                ]
            }
        }
    );

    const [result] = await Deposit.aggregate(pipeline);
    const total = Number(result?.meta?.[0]?.total ?? 0);
    const totalPages = total > 0 ? Math.ceil(total / pageSize) : 1;
    const summary = result?.summary?.[0] ?? {
        total: 0,
        pending: 0,
        approved: 0,
        rejected: 0
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
            approved: Number(summary.approved ?? 0),
            rejected: Number(summary.rejected ?? 0)
        }
    };
};

const buildDepositsCsv = (items: any[]) => {
    const header = [
        'Deposit ID',
        'Invoice',
        'Tanggal',
        'User',
        'Email',
        'Amount',
        'Unique Code',
        'Admin Fee',
        'Net Amount',
        'Total Transfer',
        'Payment Method',
        'Account Number',
        'Account Name',
        'Status',
        'Assigned To',
        'Assigned At',
        'Processed By',
        'Processed At',
        'Processing Note',
        'Updated At'
    ];

    const rows = items.map((deposit) => ([
        deposit._id,
        deposit.invoiceCode || '',
        formatCsvDate(deposit.createdAt),
        deposit.user?.name || '',
        deposit.user?.email || '',
        deposit.amount || 0,
        deposit.uniqueCode || 0,
        deposit.adminFee || 0,
        deposit.netAmount || 0,
        deposit.totalAmount || deposit.amount || 0,
        deposit.paymentMethod?.name || '',
        deposit.paymentMethod?.accountNumber || '',
        deposit.paymentMethod?.accountName || '',
        deposit.status || '',
        deposit.assignedTo?.email || deposit.assignedTo?.name || '',
        formatCsvDate(deposit.assignedAt),
        deposit.processedBy?.email || deposit.processedBy?.name || '',
        formatCsvDate(deposit.processedAt),
        deposit.processingNote || '',
        formatCsvDate(deposit.updatedAt)
    ]));

    return [header, ...rows]
        .map((row) => row.map(csvEscape).join(','))
        .join('\n');
};

export const requestDeposit = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { amount, paymentMethodId } = request.body as any;
        const userId = request.user!.id;
        const numericAmount = Number(amount);

        if (['owner', 'admin', 'cs'].includes(request.user!.role)) {
            return reply.status(403).send({ message: 'Team accounts cannot request deposit' });
        }

        if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
            return reply.status(400).send({ message: 'Nominal deposit tidak valid' });
        }

        if (!paymentMethodId) {
            return reply.status(400).send({ message: 'Payment method is required' });
        }

        const siteSettings = await getSiteSettings([
            'maintenanceMode',
            'maintenanceMessage',
            'minDeposit',
            'maxDeposit',
            'depositFee',
            'depositFeeType'
        ]);

        if (siteSettings.maintenanceMode) {
            return reply.status(503).send({ message: buildMaintenanceMessage(siteSettings.maintenanceMessage) });
        }

        if (numericAmount < siteSettings.minDeposit || numericAmount > siteSettings.maxDeposit) {
            return reply.status(400).send({
                message: `Nominal deposit global harus di antara Rp ${siteSettings.minDeposit.toLocaleString('id-ID')} dan Rp ${siteSettings.maxDeposit.toLocaleString('id-ID')}`
            });
        }

        const paymentMethod = await PaymentMethod.findById(paymentMethodId)
            .populate('category', 'name slug status');
        if (!paymentMethod) {
            return reply.status(404).send({ message: 'Payment method not found' });
        }

        if (paymentMethod.status !== 'active') {
            return reply.status(400).send({ message: 'Payment method is not active' });
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

        if (numericAmount < paymentMethod.minAmount || numericAmount > paymentMethod.maxAmount) {
            return reply.status(400).send({
                message: `Amount must be between Rp ${paymentMethod.minAmount.toLocaleString('id-ID')} and Rp ${paymentMethod.maxAmount.toLocaleString('id-ID')}`
            });
        }

        const adminFeeFixed = paymentMethod.adminFee || 0;
        const adminFeePercent = Math.round((numericAmount * (paymentMethod.adminPercent || 0)) / 100);
        const globalFee = siteSettings.depositFeeType === 'percent'
            ? Math.round((numericAmount * siteSettings.depositFee) / 100)
            : siteSettings.depositFee;
        const totalAdminFee = adminFeeFixed + adminFeePercent + globalFee;

        if (numericAmount - totalAdminFee <= 0) {
            throw new DepositControllerError(
                400,
                'Biaya admin metode pembayaran ini melebihi nominal deposit. Hubungi admin.'
            );
        }

        const uniqueCode = paymentMethod.useUniqueCode !== false ? generateUniqueCode() : 0;
        const totalAmount = numericAmount + uniqueCode;

        const deposit = await Deposit.create({
            user: userId,
            amount: numericAmount,
            uniqueCode,
            totalAmount,
            adminFee: totalAdminFee,
            paymentMethod: paymentMethodId,
            status: 'pending'
        });

        const populatedDeposit = await Deposit.findById(deposit._id).populate('paymentMethod');

        return reply.status(201).send({
            message: 'Deposit requested',
            deposit: populatedDeposit,
            paymentInfo: {
                bankName: paymentMethod.name,
                accountNumber: paymentMethod.accountNumber,
                accountName: paymentMethod.accountName,
                amount: numericAmount,
                uniqueCode,
                totalAmount,
                adminFee: totalAdminFee,
                netAmount: numericAmount - totalAdminFee,
                adminFeeBreakdown: {
                    paymentMethodFee: adminFeeFixed + adminFeePercent,
                    globalFee
                }
            }
        });
    } catch (error) {
        return handleControllerError(reply, error);
    }
};

export const getDeposits = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const userId = request.user!.id;
        const role = request.user!.role;

        let query: Record<string, unknown> = {};
        if (['owner', 'admin', 'cs'].includes(role)) {
            if (role !== 'owner') {
                await ensureTeamPermission(request, 'viewDeposits');
            }
        } else {
            query.user = userId;
        }

        let depositsQuery = Deposit.find(query);

        if (['owner', 'admin', 'cs'].includes(role)) {
            for (const populateItem of getPopulateConfig()) {
                depositsQuery = depositsQuery.populate(populateItem.path, populateItem.select);
            }
        } else {
            depositsQuery = depositsQuery
                .populate('user', 'name email')
                .populate('paymentMethod', 'name accountNumber accountName');
        }

        const deposits = await depositsQuery
            .sort({ createdAt: -1 });

        return reply.send(deposits);
    } catch (error) {
        return handleControllerError(reply, error);
    }
};

export const getAdminDeposits = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const result = await listAdminDeposits(request.query as AdminDepositsQuery, { actorId: request.user?.id });
        return reply.send(result);
    } catch (error) {
        return handleControllerError(reply, error);
    }
};

export const exportAdminDepositsCsv = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const query = request.query as AdminDepositsQuery;
        const result = await listAdminDeposits(
            {
                ...query,
                page: 1,
                limit: 5000
            },
            { pageSizeMax: 5000, actorId: request.user?.id }
        );
        const csv = buildDepositsCsv(result.items);
        const filename = `admin-deposits-${new Date().toISOString().slice(0, 10)}.csv`;

        return reply
            .header('Content-Type', 'text/csv; charset=utf-8')
            .header('Content-Disposition', `attachment; filename="${filename}"`)
            .send(`\uFEFF${csv}`);
    } catch (error) {
        return handleControllerError(reply, error);
    }
};

export const claimDeposit = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };

        if (!mongoose.Types.ObjectId.isValid(id)) {
            throw new DepositControllerError(400, 'ID deposit tidak valid');
        }

        const actorId = request.user!.id;
        const deposit = await Deposit.findOneAndUpdate(
            {
                _id: id,
                status: 'pending',
                $or: [
                    { assignedTo: { $exists: false } },
                    { assignedTo: null },
                    { assignedTo: new mongoose.Types.ObjectId(actorId) }
                ]
            },
            {
                $set: {
                    assignedTo: actorId,
                    assignedAt: new Date()
                }
            },
            { new: true }
        );

        if (!deposit) {
            throw new DepositControllerError(409, 'Deposit sudah diproses, tidak ditemukan, atau sedang di-claim admin lain');
        }

        const populatedDeposit = await populateDepositById(deposit._id.toString());
        return reply.send({ message: 'Deposit claimed', deposit: populatedDeposit });
    } catch (error) {
        return handleControllerError(reply, error);
    }
};

export const releaseDepositClaim = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };

        if (!mongoose.Types.ObjectId.isValid(id)) {
            throw new DepositControllerError(400, 'ID deposit tidak valid');
        }

        const actorId = request.user!.id;
        const isOwner = request.user!.role === 'owner';
        const filter = buildAssignmentAccessFilter(id, actorId, isOwner);
        const deposit = await Deposit.findOneAndUpdate(
            filter,
            {
                $unset: {
                    assignedTo: 1,
                    assignedAt: 1
                }
            },
            { new: true }
        );

        if (!deposit) {
            throw new DepositControllerError(409, 'Deposit sudah diproses, tidak ditemukan, atau sedang di-claim admin lain');
        }

        const populatedDeposit = await populateDepositById(deposit._id.toString());
        return reply.send({ message: 'Deposit claim released', deposit: populatedDeposit });
    } catch (error) {
        return handleControllerError(reply, error);
    }
};

export const approveDeposit = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };

        if (!mongoose.Types.ObjectId.isValid(id)) {
            throw new DepositControllerError(400, 'ID deposit tidak valid');
        }

        const note = normalizeProcessingNote((request.body as { note?: string } | undefined)?.note);
        const processorId = request.user!.id;
        const isOwner = request.user!.role === 'owner';

        let result: {
            depositId: string;
            adminFee: number;
            netAmount: number;
            newBalance: number;
        };

        try {
            result = await approveDepositWithTransaction(id, processorId, note, isOwner);
        } catch (error) {
            if (!isTransactionSupportError(error)) {
                throw error;
            }

            result = await approveDepositWithCompensation(id, processorId, note, isOwner);
        }

        const populatedDeposit = await populateDepositById(result.depositId);

        return reply.send({
            message: 'Deposit approved',
            deposit: populatedDeposit,
            adminFeeDeducted: result.adminFee,
            netAmountAdded: result.netAmount,
            newBalance: result.newBalance
        });
    } catch (error) {
        return handleControllerError(reply, error);
    }
};

export const rejectDeposit = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };

        if (!mongoose.Types.ObjectId.isValid(id)) {
            throw new DepositControllerError(400, 'ID deposit tidak valid');
        }

        const note = normalizeProcessingNote((request.body as { note?: string } | undefined)?.note, true);
        const processorId = request.user!.id;
        const isOwner = request.user!.role === 'owner';

        const deposit = await Deposit.findOneAndUpdate(
            buildAssignmentAccessFilter(id, processorId, isOwner),
            buildProcessingUpdate('rejected', processorId, note),
            { new: true }
        );

        if (!deposit) {
            throw new DepositControllerError(409, 'Deposit sudah diproses, tidak ditemukan, atau sedang di-claim admin lain');
        }

        const populatedDeposit = await populateDepositById(deposit._id.toString());

        return reply.send({ message: 'Deposit rejected', deposit: populatedDeposit });
    } catch (error) {
        return handleControllerError(reply, error);
    }
};
