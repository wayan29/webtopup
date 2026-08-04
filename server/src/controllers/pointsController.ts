import mongoose from 'mongoose';
import { FastifyRequest, FastifyReply } from 'fastify';
import { User, PointTransaction, Settings } from '../models';
import { AuthRequest } from '../middlewares/authMiddleware';

const POINT_TRANSACTION_TYPES = ['earn', 'redeem', 'admin_adjustment'] as const;

const normalizePositiveInteger = (value: unknown, fieldName: string) => {
    if (value === undefined) return undefined;
    const normalized = Number(value);
    if (!Number.isInteger(normalized) || normalized < 1) {
        throw new Error(`${fieldName} must be at least 1`);
    }
    return normalized;
};

// Get points settings
export const getPointsSettings = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        let setting = await Settings.findOne({ key: 'points_per_transaction' });
        let rateSetting = await Settings.findOne({ key: 'point_value_rate' });

        if (!setting) {
            setting = await Settings.create({
                key: 'points_per_transaction',
                value: 100,
                description: 'Points earned per Rp 10,000 transaction'
            });
        }

        if (!rateSetting) {
            rateSetting = await Settings.create({
                key: 'point_value_rate',
                value: 1,
                description: 'Value of 1 point in Rupiah'
            });
        }

        return reply.send({
            _id: setting._id,
            key: setting.key,
            value: setting.value,
            description: setting.description,
            pointValueRate: rateSetting.value
        });
    } catch (error) {
        console.error('Error fetching points settings:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Update points settings
export const updatePointsSettings = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const body = request.body as { value?: unknown; pointValueRate?: unknown };
        let value: number | undefined;
        let pointValueRate: number | undefined;
        try {
            value = normalizePositiveInteger(body.value, 'Points per transaction');
            pointValueRate = normalizePositiveInteger(body.pointValueRate, 'Point value rate');
        } catch (error: any) {
            return reply.status(400).send({ message: error.message });
        }

        const results: any = {};
        const operations = [];

        if (value !== undefined) {
            operations.push(
                Settings.findOneAndUpdate(
                    { key: 'points_per_transaction' },
                    {
                        $set: {
                            value,
                            description: 'Points earned per Rp 10,000 transaction'
                        },
                        $setOnInsert: { key: 'points_per_transaction' }
                    },
                    { upsert: true, new: true, runValidators: true }
                ).then(setting => {
                    results.pointsPerTransaction = setting.value;
                })
            );
        }

        if (pointValueRate !== undefined) {
            operations.push(
                Settings.findOneAndUpdate(
                    { key: 'point_value_rate' },
                    {
                        $set: {
                            value: pointValueRate,
                            description: 'Value of 1 point in Rupiah'
                        },
                        $setOnInsert: { key: 'point_value_rate' }
                    },
                    { upsert: true, new: true, runValidators: true }
                ).then(setting => {
                    results.pointValueRate = setting.value;
                })
            );
        }

        await Promise.all(operations);

        return reply.send({
            message: 'Points settings updated successfully',
            ...results
        });
    } catch (error) {
        console.error('Error updating points settings:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Get user points history
export const getPointsHistory = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const userId = request.user?.id;
        const { type, page, limit } = request.query as {
            type?: string;
            page?: string | number;
            limit?: string | number;
        };

        if (type && type !== 'all' && !POINT_TRANSACTION_TYPES.includes(type as typeof POINT_TRANSACTION_TYPES[number])) {
            return reply.status(400).send({ message: 'Invalid transaction type' });
        }

        const currentPage = Math.max(parseInt(String(page ?? 1), 10) || 1, 1);
        const perPage = Math.min(Math.max(parseInt(String(limit ?? 15), 10) || 15, 1), 100);
        const filter = {
            user: userId,
            ...(type && type !== 'all' ? { type } : {})
        };

        const userObjectId = userId && mongoose.Types.ObjectId.isValid(userId)
            ? new mongoose.Types.ObjectId(userId)
            : null;

        const [
            items,
            total,
            user,
            pointValueRateSetting,
            pointsPerTransactionSetting,
            totalEarnedAggregate,
            totalRedeemedAggregate
        ] = await Promise.all([
            PointTransaction.find(filter)
                .populate('relatedReward', 'name')
                .populate({
                    path: 'relatedTransaction',
                    select: 'amount target status',
                    populate: {
                        path: 'product',
                        select: 'name'
                    }
                })
                .sort({ createdAt: -1 })
                .skip((currentPage - 1) * perPage)
                .limit(perPage),
            PointTransaction.countDocuments(filter),
            User.findById(userId).select('points'),
            Settings.findOne({ key: 'point_value_rate' }).lean(),
            Settings.findOne({ key: 'points_per_transaction' }).lean(),
            userObjectId
                ? PointTransaction.aggregate([
                    { $match: { user: userObjectId, type: 'earn' } },
                    { $group: { _id: null, total: { $sum: '$points' } } }
                ])
                : Promise.resolve([]),
            userObjectId
                ? PointTransaction.aggregate([
                    { $match: { user: userObjectId, type: 'redeem' } },
                    { $group: { _id: null, total: { $sum: { $abs: '$points' } } } }
                ])
                : Promise.resolve([])
        ]);

        const currentPoints = Number(user?.points || 0);
        const pointValueRate = Math.max(1, Number(pointValueRateSetting?.value) || 1);
        const pointsPerTransaction = Math.max(1, Number(pointsPerTransactionSetting?.value) || 100);
        const totalEarned = Number(totalEarnedAggregate[0]?.total || 0);
        const totalRedeemed = Number(totalRedeemedAggregate[0]?.total || 0);
        const totalPages = Math.max(1, Math.ceil(total / perPage));

        return reply.send({
            currentPoints,
            pointValueRate,
            pointsPerTransaction,
            estimatedValue: currentPoints * pointValueRate,
            items,
            history: items,
            summary: {
                currentPoints,
                totalEarned,
                totalRedeemed,
                activityCount: total,
                lastActivityAt: items[0]?.createdAt || null
            },
            meta: {
                page: currentPage,
                limit: perPage,
                total,
                totalPages,
                type: type || 'all'
            }
        });
    } catch (error) {
        console.error('Error fetching points history:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Get all point transactions (admin)
export const getAllPointTransactions = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { type, page, limit } = request.query as {
            type?: string;
            page?: string | number;
            limit?: string | number;
        };

        if (type && type !== 'all' && !POINT_TRANSACTION_TYPES.includes(type as typeof POINT_TRANSACTION_TYPES[number])) {
            return reply.status(400).send({ message: 'Invalid transaction type' });
        }

        const currentPage = Math.max(parseInt(String(page ?? 1), 10) || 1, 1);
        const perPage = Math.min(Math.max(parseInt(String(limit ?? 20), 10) || 20, 1), 100);
        const filter = type && type !== 'all' ? { type } : {};

        const total = await PointTransaction.countDocuments(filter);
        const transactions = await PointTransaction.find(filter)
            .populate('user', 'name email')
            .populate('relatedReward', 'name')
            .sort({ createdAt: -1 })
            .skip((currentPage - 1) * perPage)
            .limit(perPage);

        return reply.send({
            items: transactions,
            meta: {
                page: currentPage,
                limit: perPage,
                total,
                totalPages: Math.max(1, Math.ceil(total / perPage))
            }
        });
    } catch (error) {
        console.error('Error fetching all point transactions:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Adjust user points (admin)
export const adjustUserPoints = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { userId, points, description } = request.body as {
            userId: string;
            points: number;
            description: string;
        };

        if (!mongoose.Types.ObjectId.isValid(userId)) {
            return reply.status(404).send({ message: 'User not found' });
        }
        if (!Number.isInteger(points) || points === 0) {
            return reply.status(400).send({ message: 'Points adjustment must be a non-zero integer' });
        }
        if (!description?.trim()) {
            return reply.status(400).send({ message: 'Description is required' });
        }

        const filter: any = { _id: userId };
        if (points < 0) {
            filter.points = { $gte: Math.abs(points) };
        }

        const user = await User.findOneAndUpdate(
            filter,
            { $inc: { points } },
            { new: true }
        );

        if (!user) {
            const exists = await User.exists({ _id: userId });
            return reply.status(exists ? 400 : 404).send({ message: exists ? 'Insufficient points' : 'User not found' });
        }

        try {
            await PointTransaction.create({
                user: userId,
                type: 'admin_adjustment',
                points,
                description: description.trim()
            });
        } catch (error) {
            await User.updateOne({ _id: userId }, { $inc: { points: -points } });
            throw error;
        }

        return reply.send({
            message: 'Points adjusted successfully',
            newPoints: user.points
        });
    } catch (error) {
        console.error('Error adjusting user points:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Get points statistics (admin)
export const getPointsStats = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const totalPointsEarned = await PointTransaction.aggregate([
            { $match: { type: 'earn' } },
            { $group: { _id: null, total: { $sum: '$points' } } }
        ]);

        const totalPointsRedeemed = await PointTransaction.aggregate([
            { $match: { type: 'redeem' } },
            { $group: { _id: null, total: { $sum: { $abs: '$points' } } } }
        ]);

        const activeUsers = await User.countDocuments({ points: { $gt: 0 } });
        const totalUsers = await User.countDocuments({ role: 'member' });

        return reply.send({
            totalPointsEarned: totalPointsEarned[0]?.total || 0,
            totalPointsRedeemed: totalPointsRedeemed[0]?.total || 0,
            activeUsers,
            totalUsers,
            engagementRate: totalUsers > 0 ? Number(((activeUsers / totalUsers) * 100).toFixed(1)) : 0
        });
    } catch (error) {
        console.error('Error fetching points stats:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};
