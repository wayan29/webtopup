import mongoose from 'mongoose';
import { User, PointTransaction, Settings } from '../models';

type PointsMutationOptions = {
    session?: mongoose.ClientSession | null;
    description?: string;
    throwOnError?: boolean;
};

const applySession = <T extends { session: (session: mongoose.ClientSession) => T }>(
    query: T,
    session?: mongoose.ClientSession | null
) => {
    if (session) {
        query.session(session);
    }
    return query;
};

const getPointsPerUnit = async (session?: mongoose.ClientSession | null) => {
    const query = Settings.findOne({ key: 'points_per_transaction' });
    const setting = await applySession(query, session).lean();
    return Number(setting?.value) || 100;
};

const getRelatedTransactionNetPoints = async (
    userId: string,
    transactionId: string,
    session?: mongoose.ClientSession | null
) => {
    if (!mongoose.Types.ObjectId.isValid(transactionId)) {
        return 0;
    }

    const pipeline = [
        {
            $match: {
                user: new mongoose.Types.ObjectId(userId),
                relatedTransaction: new mongoose.Types.ObjectId(transactionId)
            }
        },
        {
            $group: {
                _id: null,
                total: { $sum: '$points' }
            }
        }
    ];

    const aggregate = PointTransaction.aggregate(pipeline);
    if (session) {
        aggregate.session(session);
    }

    const [result] = await aggregate;
    return Number(result?.total ?? 0);
};

const applyPointMutation = async (
    userId: string,
    delta: number,
    type: 'earn' | 'admin_adjustment',
    description: string,
    transactionId?: string,
    options: PointsMutationOptions = {}
) => {
    const { session } = options;
    const absDelta = Math.abs(delta);

    if (absDelta <= 0) {
        return 0;
    }

    const userFilter: Record<string, unknown> = { _id: userId };
    if (delta < 0) {
        userFilter.points = { $gte: absDelta };
    }

    const updateQuery = User.findOneAndUpdate(
        userFilter,
        { $inc: { points: delta } },
        { new: true }
    ).select('_id points');

    const updatedUser = await applySession(updateQuery, session);

    if (!updatedUser) {
        const existsQuery = User.findById(userId).select('_id');
        const existingUser = await applySession(existsQuery, session);
        if (!existingUser) {
            throw new Error('User not found');
        }

        throw new Error('Insufficient points balance');
    }

    const pointTransaction = {
        user: userId,
        type,
        points: delta,
        description,
        relatedTransaction: transactionId && mongoose.Types.ObjectId.isValid(transactionId)
            ? new mongoose.Types.ObjectId(transactionId)
            : undefined
    };

    try {
        if (session) {
            await PointTransaction.create([pointTransaction], { session });
        } else {
            await PointTransaction.create(pointTransaction);
        }
    } catch (error) {
        if (!session) {
            try {
                await User.findByIdAndUpdate(userId, { $inc: { points: -delta } });
            } catch (rollbackError) {
                console.error('Failed to roll back user points mutation:', rollbackError);
            }
        }

        throw error;
    }

    return absDelta;
};

/**
 * Award points to user based on transaction amount
 */
export async function awardPoints(
    userId: string,
    transactionAmount: number,
    transactionId?: string,
    options: PointsMutationOptions = {}
): Promise<number> {
    try {
        const { description, session } = options;

        if (transactionId) {
            const existingNetPoints = await getRelatedTransactionNetPoints(userId, transactionId, session);
            if (existingNetPoints > 0) {
                return 0;
            }
        }

        const pointsPerUnit = await getPointsPerUnit(session); // Default: 100 points per Rp 10,000

        // Calculate points earned
        // Formula: (amount / 10000) * pointsPerUnit
        const pointsEarned = Math.floor(transactionAmount / 10000) * pointsPerUnit;

        if (pointsEarned <= 0) {
            return 0;
        }

        return await applyPointMutation(
            userId,
            pointsEarned,
            'earn',
            description || `Earned from transaction - Rp ${transactionAmount.toLocaleString('id-ID')}`,
            transactionId,
            options
        );
    } catch (error) {
        console.error('Error awarding points:', error);
        if (options.throwOnError) {
            throw error;
        }
        return 0;
    }
}

export async function revokeAwardedPoints(
    userId: string,
    transactionId: string,
    options: PointsMutationOptions = {}
): Promise<number> {
    try {
        const { description, session } = options;
        const netPoints = await getRelatedTransactionNetPoints(userId, transactionId, session);

        if (netPoints <= 0) {
            return 0;
        }

        return await applyPointMutation(
            userId,
            -netPoints,
            'admin_adjustment',
            description || 'Points revoked because transaction outcome changed',
            transactionId,
            options
        );
    } catch (error) {
        console.error('Error revoking points:', error);
        if (options.throwOnError) {
            throw error;
        }
        return 0;
    }
}

/**
 * Get points that would be earned for a given amount
 */
export async function calculatePoints(amount: number): Promise<number> {
    try {
        const pointsPerUnit = await getPointsPerUnit();
        return Math.floor(amount / 10000) * pointsPerUnit;
    } catch (error) {
        console.error('Error calculating points:', error);
        return 0;
    }
}
