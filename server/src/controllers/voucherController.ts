import crypto from 'crypto';
import mongoose from 'mongoose';
import { FastifyReply } from 'fastify';
import Voucher from '../models/Voucher';
import User from '../models/User';
import { AuthRequest } from '../middlewares/authMiddleware';

type VoucherStatusFilter = 'available' | 'redeemed' | 'archived';

type VoucherAdminQuery = {
    page?: string | number;
    limit?: string | number;
    search?: string;
    status?: string;
    startDate?: string;
    endDate?: string;
};

class VoucherControllerError extends Error {
    statusCode: number;

    constructor(statusCode: number, message: string) {
        super(message);
        this.statusCode = statusCode;
    }
}

const ALLOWED_STATUS_FILTERS: VoucherStatusFilter[] = ['available', 'redeemed', 'archived'];
const CUSTOM_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{3,31}$/;

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

const parseDateBoundary = (value: unknown, endOfDay = false) => {
    const text = normalizeText(value);
    if (!text) {
        return null;
    }

    const date = new Date(`${text}${endOfDay ? 'T23:59:59.999' : 'T00:00:00.000'}`);
    if (Number.isNaN(date.getTime())) {
        throw new VoucherControllerError(400, 'Format tanggal voucher tidak valid');
    }

    return date;
};

const normalizeAmount = (value: unknown) => {
    const amount = Number(value);

    if (!Number.isFinite(amount) || amount <= 0) {
        throw new VoucherControllerError(400, 'Nominal voucher harus lebih besar dari 0');
    }

    if (amount > 100_000_000) {
        throw new VoucherControllerError(400, 'Nominal voucher terlalu besar');
    }

    return Math.round(amount);
};

const normalizeQuantity = (value: unknown) => {
    const quantity = normalizePositiveInt(value, 1, 200);

    if (quantity < 1) {
        throw new VoucherControllerError(400, 'Jumlah voucher minimal 1');
    }

    return quantity;
};

const normalizeVoucherCode = (value: unknown) => {
    const code = normalizeText(value).toUpperCase();

    if (!code) {
        return '';
    }

    if (!CUSTOM_CODE_PATTERN.test(code)) {
        throw new VoucherControllerError(
            400,
            'Kode voucher hanya boleh berisi huruf besar, angka, garis bawah, atau strip, minimal 4 karakter'
        );
    }

    return code;
};

const normalizeArchiveReason = (value: unknown) => {
    if (value === undefined) {
        return '';
    }

    const reason = normalizeText(value);
    if (reason.length > 500) {
        throw new VoucherControllerError(400, 'Catatan arsip voucher maksimal 500 karakter');
    }

    return reason;
};

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const isTransactionSupportError = (error: unknown) => {
    if (!(error instanceof Error)) {
        return false;
    }

    return /transaction numbers are only allowed on a replica set member or mongos|does not support transactions|transaction support/i.test(error.message);
};

const handleControllerError = (reply: FastifyReply, error: unknown) => {
    console.error(error);

    if (error instanceof VoucherControllerError) {
        return reply.status(error.statusCode).send({ message: error.message });
    }

    return reply.status(500).send({ message: 'Internal Server Error' });
};

const getVoucherStatusMatch = (status: VoucherStatusFilter) => {
    if (status === 'available') {
        return { isArchived: false, isRedeemed: false };
    }

    if (status === 'redeemed') {
        return { isRedeemed: true };
    }

    return { isArchived: true };
};

const buildVoucherAdminQuery = async (query: VoucherAdminQuery) => {
    const currentPage = normalizePositiveInt(query.page, 1, 100000);
    const pageSize = normalizePositiveInt(query.limit, 20, 100);
    const normalizedSearch = normalizeText(query.search);
    const normalizedStatus = normalizeText(query.status) as VoucherStatusFilter | '';
    const startBoundary = parseDateBoundary(query.startDate, false);
    const endBoundary = parseDateBoundary(query.endDate, true);

    if (normalizedStatus && !ALLOWED_STATUS_FILTERS.includes(normalizedStatus)) {
        throw new VoucherControllerError(400, 'Status voucher tidak valid');
    }

    if (startBoundary && endBoundary && startBoundary > endBoundary) {
        throw new VoucherControllerError(400, 'Rentang tanggal voucher tidak valid');
    }

    const match: Record<string, unknown> = {};

    if (normalizedStatus) {
        Object.assign(match, getVoucherStatusMatch(normalizedStatus));
    }

    if (startBoundary || endBoundary) {
        match.createdAt = {};
        if (startBoundary) {
            (match.createdAt as Record<string, Date>).$gte = startBoundary;
        }
        if (endBoundary) {
            (match.createdAt as Record<string, Date>).$lte = endBoundary;
        }
    }

    if (normalizedSearch) {
        const regex = new RegExp(escapeRegExp(normalizedSearch), 'i');
        const matchedUsers = await User.find({
            $or: [
                { name: regex },
                { email: regex }
            ]
        }).select('_id').limit(50).lean();

        const userIds = matchedUsers.map((user) => user._id);

        match.$or = [
            { code: regex },
            { redeemedBy: { $in: userIds } },
            { createdBy: { $in: userIds } },
            { archivedBy: { $in: userIds } }
        ];
    }

    return {
        currentPage,
        pageSize,
        match
    };
};

const populateVoucherQuery = <T extends mongoose.Query<any, any>>(query: T) => (
    query
        .populate('redeemedBy', 'name email role')
        .populate('createdBy', 'name email role')
        .populate('archivedBy', 'name email role')
);

const randomVoucherCode = () => crypto.randomBytes(5).toString('hex').toUpperCase();

const generateVoucherCodes = async (quantity: number) => {
    const codes = new Set<string>();
    let attempts = 0;

    while (codes.size < quantity) {
        codes.add(randomVoucherCode());
        attempts += 1;

        if (attempts > quantity * 25) {
            throw new VoucherControllerError(500, 'Gagal membuat kode voucher unik');
        }
    }

    const candidateCodes = Array.from(codes);
    const existing = await Voucher.find({ code: { $in: candidateCodes } }).select('code').lean();
    if (existing.length === 0) {
        return candidateCodes;
    }

    return generateVoucherCodes(quantity);
};

const getVoucherRedeemErrorMessage = async (code: string, session?: mongoose.ClientSession | null) => {
    const voucherQuery = Voucher.findOne({ code }).select('isRedeemed isArchived');
    const voucher = session ? await voucherQuery.session(session) : await voucherQuery;

    if (!voucher) {
        throw new VoucherControllerError(404, 'Kode voucher tidak valid');
    }

    if (voucher.isArchived) {
        throw new VoucherControllerError(400, 'Voucher sudah diarsipkan dan tidak bisa diredeem');
    }

    if (voucher.isRedeemed) {
        throw new VoucherControllerError(400, 'Voucher sudah pernah diredeem');
    }

    throw new VoucherControllerError(400, 'Voucher tidak bisa diredeem');
};

const redeemVoucherWithTransaction = async (userId: string, code: string) => {
    const session = await mongoose.startSession();

    try {
        let result: { amount: number; newBalance: number; code: string } | null = null;

        await session.withTransaction(async () => {
            const claimedVoucher = await Voucher.findOneAndUpdate(
                { code, isRedeemed: false, isArchived: false },
                {
                    $set: {
                        isRedeemed: true,
                        redeemedBy: userId,
                        redeemedAt: new Date()
                    }
                },
                { new: false, session }
            ).select('amount code');

            if (!claimedVoucher) {
                await getVoucherRedeemErrorMessage(code, session);
            }

            const updatedUser = await User.findByIdAndUpdate(
                userId,
                { $inc: { balance: claimedVoucher!.amount } },
                { new: true, session }
            ).select('balance');

            if (!updatedUser) {
                throw new VoucherControllerError(404, 'User tidak ditemukan');
            }

            await Voucher.updateOne(
                { _id: claimedVoucher!._id },
                {
                    $set: {
                        redeemedBalanceBefore: updatedUser.balance - claimedVoucher!.amount,
                        redeemedBalanceAfter: updatedUser.balance
                    }
                },
                { session }
            );

            result = {
                amount: claimedVoucher!.amount,
                newBalance: updatedUser.balance,
                code: claimedVoucher!.code
            };
        });

        if (!result) {
            throw new Error('Voucher redeem transaction did not complete');
        }

        return result;
    } finally {
        await session.endSession();
    }
};

const redeemVoucherWithCompensation = async (userId: string, code: string) => {
    const claimedVoucher = await Voucher.findOneAndUpdate(
        { code, isRedeemed: false, isArchived: false },
        {
            $set: {
                isRedeemed: true,
                redeemedBy: userId,
                redeemedAt: new Date()
            }
        },
        { new: false }
    ).select('amount code');

    if (!claimedVoucher) {
        await getVoucherRedeemErrorMessage(code);
    }

    let updatedUser: { balance: number } | null = null;

    try {
        updatedUser = await User.findByIdAndUpdate(
            userId,
            { $inc: { balance: claimedVoucher!.amount } },
            { new: true }
        ).select('balance');

        if (!updatedUser) {
            await Voucher.updateOne(
                { _id: claimedVoucher!._id },
                {
                    $set: {
                        isRedeemed: false
                    },
                    $unset: {
                        redeemedBy: 1,
                        redeemedAt: 1,
                        redeemedBalanceBefore: 1,
                        redeemedBalanceAfter: 1
                    }
                }
            );
            throw new VoucherControllerError(404, 'User tidak ditemukan');
        }

        await Voucher.updateOne(
            { _id: claimedVoucher!._id },
            {
                $set: {
                    redeemedBalanceBefore: updatedUser.balance - claimedVoucher!.amount,
                    redeemedBalanceAfter: updatedUser.balance
                }
            }
        );

        return {
            amount: claimedVoucher!.amount,
            newBalance: updatedUser.balance,
            code: claimedVoucher!.code
        };
    } catch (error) {
        if (updatedUser) {
            const rollbackResults = await Promise.allSettled([
                User.updateOne({ _id: userId }, { $inc: { balance: -claimedVoucher!.amount } }),
                Voucher.updateOne(
                    { _id: claimedVoucher!._id },
                    {
                        $set: { isRedeemed: false },
                        $unset: {
                            redeemedBy: 1,
                            redeemedAt: 1,
                            redeemedBalanceBefore: 1,
                            redeemedBalanceAfter: 1
                        }
                    }
                )
            ]);

            const rollbackFailed = rollbackResults.some((result) => result.status === 'rejected');
            if (rollbackFailed) {
                console.error('Failed to roll back voucher redeem compensation', rollbackResults);
            }
        }

        throw error;
    }
};

export const createVoucher = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { amount, code, quantity } = request.body as { amount: number; code?: string; quantity?: number };
        const normalizedAmount = normalizeAmount(amount);
        const normalizedCode = normalizeVoucherCode(code);
        const normalizedQuantity = normalizedCode ? 1 : normalizeQuantity(quantity);
        const creatorId = request.user?.id;

        if (!creatorId) {
            throw new VoucherControllerError(401, 'Unauthorized');
        }

        if (normalizedCode) {
            const existing = await Voucher.exists({ code: normalizedCode });
            if (existing) {
                throw new VoucherControllerError(400, 'Kode voucher sudah dipakai');
            }

            const voucher = await Voucher.create({
                code: normalizedCode,
                amount: normalizedAmount,
                createdBy: creatorId
            });

            return reply.status(201).send({
                message: 'Voucher berhasil dibuat',
                items: [voucher],
                createdCount: 1
            });
        }

        const codes = await generateVoucherCodes(normalizedQuantity);
        const vouchers = codes.map((generatedCode) => ({
            code: generatedCode,
            amount: normalizedAmount,
            createdBy: creatorId
        }));

        const created = await Voucher.insertMany(vouchers, { ordered: true });

        return reply.status(201).send({
            message: `${created.length} voucher berhasil dibuat`,
            items: created,
            createdCount: created.length
        });
    } catch (error) {
        return handleControllerError(reply, error);
    }
};

export const getVouchers = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { currentPage, pageSize, match } = await buildVoucherAdminQuery(request.query as VoucherAdminQuery);
        const skip = (currentPage - 1) * pageSize;

        const [vouchers, total, summaryRows] = await Promise.all([
            populateVoucherQuery(
                Voucher.find(match)
            )
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(pageSize)
                .lean(),
            Voucher.countDocuments(match),
            Voucher.aggregate([
                { $match: match },
                {
                    $group: {
                        _id: null,
                        total: { $sum: 1 },
                        totalAmount: { $sum: '$amount' },
                        available: {
                            $sum: {
                                $cond: [
                                    { $and: [{ $eq: ['$isRedeemed', false] }, { $eq: ['$isArchived', false] }] },
                                    1,
                                    0
                                ]
                            }
                        },
                        redeemed: {
                            $sum: {
                                $cond: [{ $eq: ['$isRedeemed', true] }, 1, 0]
                            }
                        },
                        archived: {
                            $sum: {
                                $cond: [{ $eq: ['$isArchived', true] }, 1, 0]
                            }
                        }
                    }
                }
            ])
        ]);

        const summary = summaryRows[0] || {
            total: 0,
            totalAmount: 0,
            available: 0,
            redeemed: 0,
            archived: 0
        };

        return reply.send({
            items: vouchers,
            meta: {
                page: currentPage,
                limit: pageSize,
                total,
                totalPages: Math.max(1, Math.ceil(total / pageSize))
            },
            summary: {
                total: summary.total || 0,
                totalAmount: summary.totalAmount || 0,
                available: summary.available || 0,
                redeemed: summary.redeemed || 0,
                archived: summary.archived || 0
            }
        });
    } catch (error) {
        return handleControllerError(reply, error);
    }
};

export const deleteVoucher = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };
        const reason = normalizeArchiveReason((request.body as any)?.reason);
        const processorId = request.user?.id;

        if (!processorId) {
            throw new VoucherControllerError(401, 'Unauthorized');
        }

        if (!mongoose.Types.ObjectId.isValid(id)) {
            throw new VoucherControllerError(400, 'ID voucher tidak valid');
        }

        const voucher = await Voucher.findById(id);
        if (!voucher) {
            throw new VoucherControllerError(404, 'Voucher tidak ditemukan');
        }

        if (voucher.isArchived) {
            return reply.send({
                message: 'Voucher sudah diarsipkan',
                archived: true
            });
        }

        voucher.isArchived = true;
        voucher.archivedBy = processorId as any;
        voucher.archivedAt = new Date();
        voucher.archiveReason = reason || (voucher.isRedeemed
            ? 'Voucher redeemed diarsipkan untuk audit'
            : 'Voucher diarsipkan manual oleh admin');

        await voucher.save();

        return reply.send({
            message: voucher.isRedeemed
                ? 'Voucher redeemed diarsipkan agar histori audit tetap tersimpan'
                : 'Voucher berhasil diarsipkan',
            archived: true
        });
    } catch (error) {
        return handleControllerError(reply, error);
    }
};

export const restoreVoucher = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };

        if (!mongoose.Types.ObjectId.isValid(id)) {
            throw new VoucherControllerError(400, 'ID voucher tidak valid');
        }

        const voucher = await Voucher.findById(id);
        if (!voucher) {
            throw new VoucherControllerError(404, 'Voucher tidak ditemukan');
        }

        if (!voucher.isArchived) {
            return reply.send({ message: 'Voucher sudah aktif' });
        }

        if (voucher.isRedeemed) {
            throw new VoucherControllerError(400, 'Voucher yang sudah diredeem tidak bisa diaktifkan kembali');
        }

        voucher.isArchived = false;
        voucher.archivedBy = undefined;
        voucher.archivedAt = undefined;
        voucher.archiveReason = undefined;
        await voucher.save();

        return reply.send({ message: 'Voucher berhasil diaktifkan kembali' });
    } catch (error) {
        return handleControllerError(reply, error);
    }
};

export const redeemVoucher = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { code } = request.body as { code: string };
        const normalizedCode = normalizeVoucherCode(code);
        const userId = request.user?.id;

        if (!normalizedCode) {
            throw new VoucherControllerError(400, 'Kode voucher wajib diisi');
        }

        if (!userId) {
            throw new VoucherControllerError(401, 'Unauthorized');
        }

        let result: { amount: number; newBalance: number; code: string };

        try {
            result = await redeemVoucherWithTransaction(userId, normalizedCode);
        } catch (error) {
            if (!isTransactionSupportError(error)) {
                throw error;
            }

            result = await redeemVoucherWithCompensation(userId, normalizedCode);
        }

        return reply.send({
            message: 'Voucher berhasil diredeem',
            code: result.code,
            amount: result.amount,
            newBalance: result.newBalance
        });
    } catch (error) {
        return handleControllerError(reply, error);
    }
};
