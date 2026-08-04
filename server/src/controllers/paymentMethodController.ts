import { FastifyRequest, FastifyReply } from 'fastify';
import mongoose from 'mongoose';
import { Deposit, GuestTransaction, PaymentCategory, PaymentMethod } from '../models';
import { isOperationalNow, isValidTimeString } from '../utils/paymentMethodUtils';

type MethodStatus = 'active' | 'inactive';

class HttpError extends Error {
    statusCode: number;

    constructor(statusCode: number, message: string) {
        super(message);
        this.statusCode = statusCode;
    }
}

const isMethodStatus = (value: unknown): value is MethodStatus =>
    value === 'active' || value === 'inactive';

const normalizeText = (value: unknown) =>
    typeof value === 'string' ? value.trim() : '';

const normalizeNumber = (value: unknown, fieldLabel: string) => {
    const normalized = Number(value);
    if (!Number.isFinite(normalized)) {
        throw new HttpError(400, `${fieldLabel} tidak valid`);
    }

    return normalized;
};

const handleControllerError = (reply: FastifyReply, error: unknown) => {
    console.error(error);

    if (error instanceof HttpError) {
        return reply.status(error.statusCode).send({ message: error.message });
    }

    return reply.status(500).send({ message: 'Internal Server Error' });
};

const validatePayload = async (
    payload: Record<string, unknown>,
    current?: any
) => {
    const name = normalizeText(payload.name ?? current?.name);
    const categoryId = normalizeText(payload.category ?? current?.category?._id ?? current?.category);
    const accountNumber = normalizeText(payload.accountNumber ?? current?.accountNumber);
    const accountName = normalizeText(payload.accountName ?? current?.accountName);
    const icon = normalizeText(payload.icon ?? current?.icon ?? '');
    const operationalStart = normalizeText(payload.operationalStart ?? current?.operationalStart ?? '00:00');
    const operationalEnd = normalizeText(payload.operationalEnd ?? current?.operationalEnd ?? '23:59');
    const status = (payload.status ?? current?.status ?? 'active') as MethodStatus;
    const useUniqueCode = payload.useUniqueCode ?? current?.useUniqueCode ?? true;

    if (!name) {
        throw new HttpError(400, 'Nama metode pembayaran wajib diisi');
    }

    if (!categoryId || !mongoose.Types.ObjectId.isValid(categoryId)) {
        throw new HttpError(400, 'Kategori metode pembayaran wajib dipilih');
    }

    if (!accountNumber) {
        throw new HttpError(400, 'Nomor rekening wajib diisi');
    }

    if (!accountName) {
        throw new HttpError(400, 'Atas nama rekening wajib diisi');
    }

    if (!isMethodStatus(status)) {
        throw new HttpError(400, 'Status metode pembayaran tidak valid');
    }

    if (typeof useUniqueCode !== 'boolean') {
        throw new HttpError(400, 'Format kode unik tidak valid');
    }

    if (!isValidTimeString(operationalStart) || !isValidTimeString(operationalEnd)) {
        throw new HttpError(400, 'Jam operasional harus berformat HH:mm');
    }

    const minAmount = normalizeNumber(payload.minAmount ?? current?.minAmount ?? 10000, 'Minimum amount');
    const maxAmount = normalizeNumber(payload.maxAmount ?? current?.maxAmount ?? 5000000, 'Maximum amount');
    const adminFee = normalizeNumber(payload.adminFee ?? current?.adminFee ?? 0, 'Biaya admin tetap');
    const adminPercent = normalizeNumber(payload.adminPercent ?? current?.adminPercent ?? 0, 'Biaya admin persen');

    if (minAmount < 0) {
        throw new HttpError(400, 'Minimum amount tidak boleh negatif');
    }

    if (maxAmount <= 0) {
        throw new HttpError(400, 'Maximum amount harus lebih besar dari 0');
    }

    if (maxAmount < minAmount) {
        throw new HttpError(400, 'Maximum amount tidak boleh lebih kecil dari minimum amount');
    }

    if (adminFee < 0) {
        throw new HttpError(400, 'Biaya admin tetap tidak boleh negatif');
    }

    if (adminPercent < 0 || adminPercent > 100) {
        throw new HttpError(400, 'Biaya admin persen harus di antara 0 sampai 100');
    }

    const category = await PaymentCategory.findById(categoryId).select('name slug status icon').lean();
    if (!category) {
        throw new HttpError(400, 'Kategori pembayaran tidak ditemukan');
    }

    return {
        name,
        category: categoryId,
        categorySnapshot: category,
        accountNumber,
        accountName,
        icon,
        minAmount,
        maxAmount,
        adminFee,
        adminPercent,
        operationalStart,
        operationalEnd,
        useUniqueCode,
        status
    };
};

const getDependencyMaps = async () => {
    const [depositStats, guestStats] = await Promise.all([
        Deposit.aggregate([
            {
                $match: {
                    paymentMethod: { $type: 'objectId' }
                }
            },
            {
                $group: {
                    _id: '$paymentMethod',
                    depositCount: { $sum: 1 },
                    pendingDepositCount: {
                        $sum: {
                            $cond: [{ $eq: ['$status', 'pending'] }, 1, 0]
                        }
                    }
                }
            }
        ]),
        GuestTransaction.aggregate([
            {
                $group: {
                    _id: '$paymentMethod',
                    guestTransactionCount: { $sum: 1 },
                    waitingPaymentCount: {
                        $sum: {
                            $cond: [{ $eq: ['$paymentStatus', 'waiting_payment'] }, 1, 0]
                        }
                    }
                }
            }
        ])
    ]);

    const depositMap = new Map(
        depositStats.map((item) => [item._id.toString(), item])
    );
    const guestMap = new Map(
        guestStats.map((item) => [item._id.toString(), item])
    );

    return { depositMap, guestMap };
};

const buildVisibilityIssues = (
    method: any,
    category: any,
    now = new Date()
) => {
    const issues: string[] = [];

    if (!category) {
        issues.push('Kategori metode tidak ditemukan');
    } else if (category.status !== 'active') {
        issues.push('Kategori sedang nonaktif');
    }

    if (method.status !== 'active') {
        issues.push('Metode pembayaran sedang nonaktif');
    }

    if (!isOperationalNow(method.operationalStart, method.operationalEnd, now)) {
        issues.push(`Di luar jam operasional ${method.operationalStart}-${method.operationalEnd}`);
    }

    return issues;
};

export const getPaymentMethods = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const now = new Date();
        const [{ depositMap, guestMap }, methods] = await Promise.all([
            getDependencyMaps(),
            PaymentMethod.find()
                .populate('category', 'name slug icon status')
                .sort({ createdAt: -1 })
                .lean()
        ]);

        const enrichedMethods = methods.map((method: any) => {
            const methodId = method._id.toString();
            const depositStats = depositMap.get(methodId);
            const guestStats = guestMap.get(methodId);
            const depositCount = Number(depositStats?.depositCount ?? 0);
            const pendingDepositCount = Number(depositStats?.pendingDepositCount ?? 0);
            const guestTransactionCount = Number(guestStats?.guestTransactionCount ?? 0);
            const waitingPaymentCount = Number(guestStats?.waitingPaymentCount ?? 0);
            const totalUsageCount = depositCount + guestTransactionCount;
            const visibilityIssues = buildVisibilityIssues(method, method.category, now);

            return {
                ...method,
                dependency: {
                    depositCount,
                    pendingDepositCount,
                    guestTransactionCount,
                    waitingPaymentCount,
                    totalUsageCount
                },
                canDelete: totalUsageCount === 0,
                deleteBlockedReason: totalUsageCount > 0
                    ? `Metode ini sudah dipakai ${totalUsageCount} transaksi/deposit historis.`
                    : '',
                isOperationalNow: isOperationalNow(method.operationalStart, method.operationalEnd, now),
                isVisibleToUsers: visibilityIssues.length === 0,
                visibilityIssues
            };
        });

        return reply.send(enrichedMethods);
    } catch (error) {
        return handleControllerError(reply, error);
    }
};

export const getActivePaymentMethods = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const now = new Date();
        const methods = await PaymentMethod.find({ status: 'active' })
            .populate({
                path: 'category',
                select: 'name slug icon status',
                match: { status: 'active' }
            })
            .sort({ name: 1 })
            .lean();

        const availableMethods = methods.filter((method: any) =>
            method.category &&
            isOperationalNow(method.operationalStart, method.operationalEnd, now)
        );

        return reply.send(availableMethods);
    } catch (error) {
        return handleControllerError(reply, error);
    }
};

export const createPaymentMethod = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const payload = await validatePayload(request.body as Record<string, unknown>);

        const method = await PaymentMethod.create({
            name: payload.name,
            category: payload.category,
            accountNumber: payload.accountNumber,
            accountName: payload.accountName,
            icon: payload.icon,
            minAmount: payload.minAmount,
            maxAmount: payload.maxAmount,
            adminFee: payload.adminFee,
            adminPercent: payload.adminPercent,
            operationalStart: payload.operationalStart,
            operationalEnd: payload.operationalEnd,
            useUniqueCode: payload.useUniqueCode,
            status: payload.status
        });

        return reply.status(201).send({ message: 'Payment method created', method });
    } catch (error) {
        return handleControllerError(reply, error);
    }
};

export const updatePaymentMethod = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };

        if (!mongoose.Types.ObjectId.isValid(id)) {
            throw new HttpError(400, 'ID metode pembayaran tidak valid');
        }

        const currentMethod = await PaymentMethod.findById(id).populate('category', 'name slug icon status').lean();
        if (!currentMethod) {
            return reply.status(404).send({ message: 'Payment method not found' });
        }

        const payload = await validatePayload(request.body as Record<string, unknown>, currentMethod);

        const method = await PaymentMethod.findByIdAndUpdate(
            id,
            {
                $set: {
                    name: payload.name,
                    category: payload.category,
                    accountNumber: payload.accountNumber,
                    accountName: payload.accountName,
                    icon: payload.icon,
                    minAmount: payload.minAmount,
                    maxAmount: payload.maxAmount,
                    adminFee: payload.adminFee,
                    adminPercent: payload.adminPercent,
                    operationalStart: payload.operationalStart,
                    operationalEnd: payload.operationalEnd,
                    useUniqueCode: payload.useUniqueCode,
                    status: payload.status
                }
            },
            { new: true }
        );

        return reply.send({ message: 'Payment method updated', method });
    } catch (error) {
        return handleControllerError(reply, error);
    }
};

export const deletePaymentMethod = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };

        if (!mongoose.Types.ObjectId.isValid(id)) {
            throw new HttpError(400, 'ID metode pembayaran tidak valid');
        }

        const method = await PaymentMethod.findById(id).select('name').lean();
        if (!method) {
            return reply.status(404).send({ message: 'Payment method not found' });
        }

        const [depositCount, guestTransactionCount] = await Promise.all([
            Deposit.countDocuments({ paymentMethod: id }),
            GuestTransaction.countDocuments({ paymentMethod: id })
        ]);

        const totalUsageCount = depositCount + guestTransactionCount;
        if (totalUsageCount > 0) {
            throw new HttpError(
                400,
                `Metode "${method.name}" sudah dipakai ${totalUsageCount} transaksi/deposit dan tidak bisa dihapus.`
            );
        }

        await PaymentMethod.findByIdAndDelete(id);

        return reply.send({ message: 'Payment method deleted' });
    } catch (error) {
        return handleControllerError(reply, error);
    }
};
