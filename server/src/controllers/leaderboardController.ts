import mongoose from 'mongoose';
import { FastifyRequest, FastifyReply } from 'fastify';
import { Transaction, User } from '../models';
import { verifyJwtToken } from '../utils/jwt';

type LeaderboardPeriod = 'weekly' | 'monthly' | 'alltime';

const resolvePeriodStart = (period: LeaderboardPeriod) => {
    const now = new Date();

    if (period === 'weekly') {
        const startOfWeek = new Date(now);
        const day = startOfWeek.getDay();
        const diffToMonday = day === 0 ? 6 : day - 1;
        startOfWeek.setDate(startOfWeek.getDate() - diffToMonday);
        startOfWeek.setHours(0, 0, 0, 0);
        return startOfWeek;
    }

    if (period === 'monthly') {
        return new Date(now.getFullYear(), now.getMonth(), 1);
    }

    return null;
};

const buildBasePipeline = (period: LeaderboardPeriod) => {
    const startDate = resolvePeriodStart(period);
    const matchStage = startDate
        ? { status: 'success', createdAt: { $gte: startDate } }
        : { status: 'success' };

    return [
        {
            $match: matchStage
        },
        {
            $group: {
                _id: '$user',
                totalTransactions: { $sum: 1 },
                totalAmount: { $sum: '$amount' }
            }
        },
        {
            $lookup: {
                from: 'users',
                localField: '_id',
                foreignField: '_id',
                as: 'userInfo'
            }
        },
        {
            $unwind: '$userInfo'
        },
        {
            $match: {
                'userInfo.role': 'member',
                'userInfo.active': { $ne: false }
            }
        }
    ];
};

const resolveOptionalCurrentMember = async (request: FastifyRequest) => {
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return null;
    }

    try {
        const token = authHeader.split(' ')[1];
        const decoded = verifyJwtToken<{ id?: string }>(token);

        if (!decoded?.id || !mongoose.Types.ObjectId.isValid(decoded.id)) {
            return null;
        }

        const user = await User.findById(decoded.id).select('_id name role active');

        if (!user || user.role !== 'member' || user.active === false) {
            return null;
        }

        return {
            id: user._id.toString(),
            name: user.name
        };
    } catch (error) {
        return null;
    }
};

export const getLeaderboard = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { period: rawPeriod } = request.query as { period?: string };
        const period: LeaderboardPeriod = rawPeriod === 'weekly' || rawPeriod === 'monthly' ? rawPeriod : 'alltime';
        const currentMember = await resolveOptionalCurrentMember(request);
        const basePipeline = buildBasePipeline(period);

        const [topItems, totals, currentUserTotals] = await Promise.all([
            Transaction.aggregate([
                ...basePipeline,
                {
                    $sort: {
                        totalAmount: -1,
                        totalTransactions: -1,
                        'userInfo.createdAt': 1
                    }
                },
                {
                    $limit: 10
                },
                {
                    $project: {
                        _id: 1,
                        name: '$userInfo.name',
                        level: '$userInfo.level',
                        totalTransactions: 1,
                        totalAmount: 1
                    }
                }
            ]),
            Transaction.aggregate([
                ...basePipeline,
                {
                    $group: {
                        _id: null,
                        participantCount: { $sum: 1 },
                        totalTransactions: { $sum: '$totalTransactions' },
                        totalAmount: { $sum: '$totalAmount' }
                    }
                }
            ]),
            currentMember
                ? Transaction.aggregate([
                    {
                        $match: {
                            status: 'success',
                            user: new mongoose.Types.ObjectId(currentMember.id),
                            ...(resolvePeriodStart(period)
                                ? { createdAt: { $gte: resolvePeriodStart(period) as Date } }
                                : {})
                        }
                    },
                    {
                        $group: {
                            _id: '$user',
                            totalTransactions: { $sum: 1 },
                            totalAmount: { $sum: '$amount' }
                        }
                    }
                ])
                : Promise.resolve([])
        ]);

        const items = topItems.map((item, index) => ({
            ...item,
            rank: index + 1,
            isCurrentUser: currentMember ? item._id?.toString() === currentMember.id : false
        }));

        let currentUser: {
            id: string;
            name: string;
            rank: number;
            totalTransactions: number;
            totalAmount: number;
            inTopList: boolean;
        } | null = null;

        if (currentMember && currentUserTotals[0]) {
            const currentTotalAmount = Number(currentUserTotals[0].totalAmount || 0);
            const currentTotalTransactions = Number(currentUserTotals[0].totalTransactions || 0);

            const higherCount = await Transaction.aggregate([
                ...basePipeline,
                {
                    $match: {
                        $or: [
                            { totalAmount: { $gt: currentTotalAmount } },
                            {
                                totalAmount: currentTotalAmount,
                                totalTransactions: { $gt: currentTotalTransactions }
                            }
                        ]
                    }
                },
                {
                    $count: 'count'
                }
            ]);

            const inTopList = items.some((item) => item._id?.toString() === currentMember.id);

            currentUser = {
                id: currentMember.id,
                name: currentMember.name,
                rank: Number(higherCount[0]?.count || 0) + 1,
                totalTransactions: currentTotalTransactions,
                totalAmount: currentTotalAmount,
                inTopList
            };
        }

        const summary = totals[0] || {
            participantCount: 0,
            totalTransactions: 0,
            totalAmount: 0
        };

        return reply.send({
            items,
            currentUser,
            meta: {
                period,
                participantCount: Number(summary.participantCount || 0),
                totalTransactions: Number(summary.totalTransactions || 0),
                totalAmount: Number(summary.totalAmount || 0),
                generatedAt: new Date().toISOString()
            }
        });
    } catch (error) {
        console.error('Error fetching leaderboard:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};
