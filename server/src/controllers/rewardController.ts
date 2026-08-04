import mongoose from 'mongoose';
import { FastifyRequest, FastifyReply } from 'fastify';
import { Reward, User, PointTransaction } from '../models';
import { AuthRequest } from '../middlewares/authMiddleware';

type RewardSnapshot = {
    _id: mongoose.Types.ObjectId;
    name: string;
    pointsRequired: number;
    status: boolean;
    stock: number;
};

class RewardActionError extends Error {
    statusCode: number;
    payload?: Record<string, unknown>;

    constructor(statusCode: number, message: string, payload?: Record<string, unknown>) {
        super(message);
        this.statusCode = statusCode;
        this.payload = payload;
    }
}

const isValidHttpUrl = (value?: string) => {
    if (!value?.trim()) return true;
    try {
        const url = new URL(value.trim());
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
};

const normalizeRewardInput = (body: any, current?: Partial<RewardSnapshot & { description: string; imageUrl?: string; category: string; status: boolean }>) => {
    const name = body.name !== undefined ? String(body.name).trim() : current?.name;
    const description = body.description !== undefined ? String(body.description).trim() : current?.description;
    const category = body.category !== undefined ? String(body.category).trim() : current?.category;
    const imageUrl = body.imageUrl !== undefined ? String(body.imageUrl).trim() : current?.imageUrl || '';
    const pointsRequired = body.pointsRequired !== undefined ? Number(body.pointsRequired) : current?.pointsRequired;
    const stock = body.stock !== undefined ? Number(body.stock) : current?.stock;
    const status = body.status !== undefined ? Boolean(body.status) : current?.status ?? true;

    if (!name) throw new RewardActionError(400, 'Nama hadiah wajib diisi');
    if (!description) throw new RewardActionError(400, 'Deskripsi hadiah wajib diisi');
    if (!category) throw new RewardActionError(400, 'Kategori hadiah wajib diisi');
    if (!Number.isInteger(pointsRequired) || Number(pointsRequired) < 1) {
        throw new RewardActionError(400, 'Poin hadiah minimal 1');
    }
    if (!Number.isInteger(stock) || Number(stock) < 0) {
        throw new RewardActionError(400, 'Stok hadiah tidak boleh negatif');
    }
    if (!isValidHttpUrl(imageUrl)) {
        throw new RewardActionError(400, 'URL gambar harus diawali http:// atau https://');
    }

    return {
        name,
        description,
        category,
        imageUrl,
        pointsRequired: Number(pointsRequired),
        stock: Number(stock),
        status
    };
};

const handleRewardActionError = (error: unknown, reply: FastifyReply) => {
    if (error instanceof RewardActionError) {
        return reply.status(error.statusCode).send({ message: error.message, ...error.payload });
    }
    return null;
};

const isTransactionSupportError = (error: unknown) => {
    if (!(error instanceof Error)) {
        return false;
    }

    return /transaction numbers are only allowed on a replica set member or mongos|does not support transactions|transaction support/i.test(error.message);
};

const redeemWithTransaction = async (userId: string, reward: RewardSnapshot) => {
    const session = await mongoose.startSession();

    try {
        let result: { rewardName: string; pointsUsed: number; remainingPoints: number } | null = null;

        await session.withTransaction(async () => {
            const reservedReward = await Reward.findOneAndUpdate(
                { _id: reward._id, status: true, stock: { $gt: 0 } },
                { $inc: { stock: -1 } },
                { new: false, session }
            );

            if (!reservedReward) {
                throw new RewardActionError(409, 'Reward tidak lagi tersedia. Muat ulang halaman lalu coba lagi.');
            }

            const updatedUser = await User.findOneAndUpdate(
                { _id: userId, points: { $gte: reward.pointsRequired } },
                { $inc: { points: -reward.pointsRequired } },
                { new: true, session }
            );

            if (!updatedUser) {
                throw new RewardActionError(409, 'Poin pengguna berubah. Muat ulang halaman lalu coba lagi.', {
                    required: reward.pointsRequired
                });
            }

            await PointTransaction.create([{
                user: userId,
                type: 'redeem',
                points: -reward.pointsRequired,
                description: `Redeemed: ${reward.name}`,
                relatedReward: reward._id
            }], { session });

            result = {
                rewardName: reward.name,
                pointsUsed: reward.pointsRequired,
                remainingPoints: updatedUser.points
            };
        });

        if (!result) {
            throw new Error('Reward redemption transaction did not complete');
        }

        return result;
    } finally {
        await session.endSession();
    }
};

const redeemWithCompensation = async (userId: string, reward: RewardSnapshot) => {
    const reservedReward = await Reward.findOneAndUpdate(
        { _id: reward._id, status: true, stock: { $gt: 0 } },
        { $inc: { stock: -1 } },
        { new: false }
    );

    if (!reservedReward) {
        throw new RewardActionError(409, 'Reward tidak lagi tersedia. Muat ulang halaman lalu coba lagi.');
    }

    const updatedUser = await User.findOneAndUpdate(
        { _id: userId, points: { $gte: reward.pointsRequired } },
        { $inc: { points: -reward.pointsRequired } },
        { new: true }
    );

    if (!updatedUser) {
        await Reward.updateOne({ _id: reward._id }, { $inc: { stock: 1 } });
        throw new RewardActionError(409, 'Poin pengguna berubah. Muat ulang halaman lalu coba lagi.', {
            required: reward.pointsRequired
        });
    }

    try {
        await PointTransaction.create({
            user: userId,
            type: 'redeem',
            points: -reward.pointsRequired,
            description: `Redeemed: ${reward.name}`,
            relatedReward: reward._id
        });
    } catch (error) {
        const rollbackResults = await Promise.allSettled([
            Reward.updateOne({ _id: reward._id }, { $inc: { stock: 1 } }),
            User.updateOne({ _id: userId }, { $inc: { points: reward.pointsRequired } })
        ]);

        const rollbackFailed = rollbackResults.some(result => result.status === 'rejected');
        if (rollbackFailed) {
            console.error('Failed to roll back reward redemption after transaction log error', rollbackResults);
        }

        throw error;
    }

    return {
        rewardName: reward.name,
        pointsUsed: reward.pointsRequired,
        remainingPoints: updatedUser.points
    };
};

// Get all rewards (public)
export const getRewards = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const rewards = await Reward.find({ status: true }).sort({ pointsRequired: 1 });
        return reply.send(rewards);
    } catch (error) {
        console.error('Error fetching rewards:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Get all rewards including inactive (admin)
export const getAllRewards = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const rewards = await Reward.find().sort({ createdAt: -1 });
        return reply.send(rewards);
    } catch (error) {
        console.error('Error fetching all rewards:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Get reward by ID
export const getRewardById = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };
        const reward = await Reward.findOne({ _id: id, status: true });

        if (!reward) {
            return reply.status(404).send({ message: 'Reward not found' });
        }

        return reply.send(reward);
    } catch (error) {
        console.error('Error fetching reward:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Create reward (admin)
export const createReward = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const rewardInput = normalizeRewardInput(request.body as any);

        const reward = await Reward.create(rewardInput);

        return reply.status(201).send({
            message: 'Reward created successfully',
            reward
        });
    } catch (error) {
        const handled = handleRewardActionError(error, reply);
        if (handled) return handled;
        console.error('Error creating reward:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Update reward (admin)
export const updateReward = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };

        const reward = await Reward.findById(id);
        if (!reward) {
            return reply.status(404).send({ message: 'Reward not found' });
        }

        const rewardInput = normalizeRewardInput(request.body as any, {
            name: reward.name,
            description: reward.description,
            pointsRequired: reward.pointsRequired,
            stock: reward.stock,
            imageUrl: reward.imageUrl,
            category: reward.category,
            status: reward.status
        });

        reward.name = rewardInput.name;
        reward.description = rewardInput.description;
        reward.pointsRequired = rewardInput.pointsRequired;
        reward.stock = rewardInput.stock;
        reward.imageUrl = rewardInput.imageUrl;
        reward.category = rewardInput.category;
        reward.status = rewardInput.status;

        await reward.save();

        return reply.send({
            message: 'Reward updated successfully',
            reward
        });
    } catch (error) {
        const handled = handleRewardActionError(error, reply);
        if (handled) return handled;
        console.error('Error updating reward:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Delete reward (admin)
export const deleteReward = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { id } = request.params as { id: string };

        const reward = await Reward.findById(id);
        if (!reward) {
            return reply.status(404).send({ message: 'Reward not found' });
        }

        const hasRedemptionHistory = await PointTransaction.exists({
            relatedReward: id,
            type: 'redeem'
        });

        if (hasRedemptionHistory) {
            reward.status = false;
            reward.stock = 0;
            await reward.save();

            return reply.send({
                message: 'Reward has redemption history and was archived instead of deleted',
                archived: true
            });
        }

        await reward.deleteOne();

        return reply.send({ message: 'Reward deleted successfully' });
    } catch (error) {
        console.error('Error deleting reward:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

// Redeem reward
export const redeemReward = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const { rewardId } = request.body as { rewardId?: string };
        const userId = request.user?.id;

        if (!userId) {
            return reply.status(401).send({ message: 'Unauthorized' });
        }

        if (!rewardId || !mongoose.Types.ObjectId.isValid(rewardId)) {
            return reply.status(400).send({ message: 'Invalid reward ID' });
        }

        // Get reward
        const reward = await Reward.findById(rewardId)
            .select('_id name pointsRequired status stock')
            .lean<RewardSnapshot | null>();
        if (!reward) {
            return reply.status(404).send({ message: 'Reward not found' });
        }

        if (!reward.status) {
            return reply.status(400).send({ message: 'Reward is not available' });
        }

        if (reward.stock <= 0) {
            return reply.status(400).send({ message: 'Reward out of stock' });
        }

        // Get user
        const user = await User.findById(userId).select('points').lean<{ points: number } | null>();
        if (!user) {
            return reply.status(404).send({ message: 'User not found' });
        }

        // Check if user has enough points
        if (user.points < reward.pointsRequired) {
            return reply.status(400).send({
                message: 'Insufficient points',
                required: reward.pointsRequired,
                current: user.points
            });
        }

        let redemptionResult;

        try {
            redemptionResult = await redeemWithTransaction(userId, reward);
        } catch (error) {
            if (error instanceof RewardActionError) {
                return reply.status(error.statusCode).send({
                    message: error.message,
                    ...(error.payload || {})
                });
            }

            if (!isTransactionSupportError(error)) {
                throw error;
            }

            try {
                redemptionResult = await redeemWithCompensation(userId, reward);
            } catch (fallbackError) {
                if (fallbackError instanceof RewardActionError) {
                    return reply.status(fallbackError.statusCode).send({
                        message: fallbackError.message,
                        ...(fallbackError.payload || {})
                    });
                }

                throw fallbackError;
            }
        }

        return reply.send({
            message: 'Reward redeemed successfully',
            reward: {
                name: redemptionResult.rewardName,
                pointsUsed: redemptionResult.pointsUsed
            },
            remainingPoints: redemptionResult.remainingPoints
        });
    } catch (error) {
        console.error('Error redeeming reward:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};
