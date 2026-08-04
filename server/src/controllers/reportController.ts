import mongoose from 'mongoose';
import { FastifyReply } from 'fastify';
import { DigiflazzSellerOrder, Product, Transaction, User } from '../models';
import { AuthRequest } from '../middlewares/authMiddleware';
import {
    DIGIFLAZZ_SELLER_HIGH_CALLBACK_ATTEMPT_THRESHOLD,
    getDigiflazzSellerCallbackDueRetryQuery,
    getDigiflazzSellerRetryQueueHealth
} from '../services/digiflazzSellerService';

interface SalesReportQuery {
    startDate?: string;
    endDate?: string;
}

type SummaryResult = {
    totalTransactions: number;
    successTransactions: number;
    pendingTransactions: number;
    failedTransactions: number;
    totalOmset: number;
    totalProfit: number;
    averageTransaction: number;
};

type RevenuePoint = {
    omset: number;
    profit: number;
};

class ReportControllerError extends Error {
    statusCode: number;

    constructor(statusCode: number, message: string) {
        super(message);
        this.statusCode = statusCode;
    }
}

const REPORT_TIMEZONE = 'Asia/Jakarta';
const REPORT_OFFSET = '+07:00';
const SALES_REPORT_EXPORT_LIMIT = 5000;

const normalizeText = (value: unknown) => (
    typeof value === 'string' ? value.trim() : ''
);

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

const formatDateKey = (date: Date) => {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: REPORT_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(date);

    const year = parts.find((part) => part.type === 'year')?.value ?? '0000';
    const month = parts.find((part) => part.type === 'month')?.value ?? '01';
    const day = parts.find((part) => part.type === 'day')?.value ?? '01';

    return `${year}-${month}-${day}`;
};

const formatMonthKey = (date: Date) => formatDateKey(date).slice(0, 7);

const parseDateBoundary = (value: unknown, endOfDay = false) => {
    const text = normalizeText(value);
    if (!text) {
        return null;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        throw new ReportControllerError(400, 'Format tanggal laporan tidak valid');
    }

    const date = new Date(`${text}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}${REPORT_OFFSET}`);
    if (Number.isNaN(date.getTime())) {
        throw new ReportControllerError(400, 'Format tanggal laporan tidak valid');
    }

    return date;
};

const buildDateMatch = (query: SalesReportQuery) => {
    const startBoundary = parseDateBoundary(query.startDate, false);
    const endBoundary = parseDateBoundary(query.endDate, true);

    if (startBoundary && endBoundary && startBoundary > endBoundary) {
        throw new ReportControllerError(400, 'Rentang tanggal laporan tidak valid');
    }

    if (!startBoundary && !endBoundary) {
        return {};
    }

    const match: Record<string, unknown> = {
        createdAt: {}
    };

    if (startBoundary) {
        (match.createdAt as Record<string, Date>).$gte = startBoundary;
    }

    if (endBoundary) {
        (match.createdAt as Record<string, Date>).$lte = endBoundary;
    }

    return match;
};

const trackedProfitExpression = {
    $cond: [
        {
            $and: [
                { $eq: ['$status', 'success'] },
                { $gt: [{ $ifNull: ['$product.costPrice', 0] }, 0] }
            ]
        },
        {
            $subtract: ['$amount', { $ifNull: ['$product.costPrice', 0] }]
        },
        0
    ]
};

const buildBasePipeline = (
    match: Record<string, unknown>,
    includeUser = false
) => {
    const pipeline: mongoose.PipelineStage[] = [];

    if (Object.keys(match).length > 0) {
        pipeline.push({ $match: match });
    }

    pipeline.push(
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
        }
    );

    if (includeUser) {
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
            }
        );
    }

    pipeline.push({
        $addFields: {
            trackedProfit: trackedProfitExpression
        }
    });

    return pipeline;
};

const normalizeSummary = (row: Record<string, unknown> | undefined): SummaryResult => {
    const totalTransactions = Number(row?.totalTransactions ?? 0);
    const successTransactions = Number(row?.successTransactions ?? 0);
    const totalOmset = Number(row?.totalOmset ?? 0);

    return {
        totalTransactions,
        successTransactions,
        pendingTransactions: Number(row?.pendingTransactions ?? 0),
        failedTransactions: Number(row?.failedTransactions ?? 0),
        totalOmset,
        totalProfit: Number(row?.totalProfit ?? 0),
        averageTransaction: successTransactions > 0 ? totalOmset / successTransactions : 0
    };
};

const buildReportPayload = async (match: Record<string, unknown>) => {
    const pipeline: mongoose.PipelineStage[] = [
        ...buildBasePipeline(match, true),
        {
            $facet: {
                summary: [
                    {
                        $group: {
                            _id: null,
                            totalTransactions: { $sum: 1 },
                            successTransactions: {
                                $sum: {
                                    $cond: [{ $eq: ['$status', 'success'] }, 1, 0]
                                }
                            },
                            pendingTransactions: {
                                $sum: {
                                    $cond: [{ $in: ['$status', ['pending', 'processing']] }, 1, 0]
                                }
                            },
                            failedTransactions: {
                                $sum: {
                                    $cond: [{ $eq: ['$status', 'failed'] }, 1, 0]
                                }
                            },
                            totalOmset: {
                                $sum: {
                                    $cond: [{ $eq: ['$status', 'success'] }, '$amount', 0]
                                }
                            },
                            totalProfit: {
                                $sum: '$trackedProfit'
                            }
                        }
                    }
                ],
                categoryData: [
                    {
                        $match: {
                            status: 'success'
                        }
                    },
                    {
                        $group: {
                            _id: {
                                $ifNull: ['$product.category', 'Uncategorized']
                            },
                            count: { $sum: 1 },
                            omset: { $sum: '$amount' },
                            profit: { $sum: '$trackedProfit' }
                        }
                    },
                    {
                        $project: {
                            _id: 0,
                            category: '$_id',
                            count: 1,
                            omset: 1,
                            profit: 1
                        }
                    },
                    {
                        $sort: {
                            omset: -1,
                            category: 1
                        }
                    }
                ],
                dailyData: [
                    {
                        $match: {
                            status: 'success'
                        }
                    },
                    {
                        $group: {
                            _id: {
                                $dateToString: {
                                    format: '%Y-%m-%d',
                                    date: '$createdAt',
                                    timezone: REPORT_TIMEZONE
                                }
                            },
                            count: { $sum: 1 },
                            omset: { $sum: '$amount' },
                            profit: { $sum: '$trackedProfit' }
                        }
                    },
                    {
                        $project: {
                            _id: 0,
                            date: '$_id',
                            count: 1,
                            omset: 1,
                            profit: 1
                        }
                    },
                    {
                        $sort: {
                            date: 1
                        }
                    }
                ],
                recentTransactions: [
                    {
                        $sort: {
                            createdAt: -1
                        }
                    },
                    {
                        $limit: 10
                    },
                    {
                        $project: {
                            _id: 1,
                            product: {
                                $ifNull: ['$product.name', 'Unknown']
                            },
                            category: {
                                $ifNull: ['$product.category', 'Unknown']
                            },
                            user: {
                                $ifNull: ['$user.name', 'Unknown']
                            },
                            target: 1,
                            amount: 1,
                            status: 1,
                            createdAt: 1
                        }
                    }
                ]
            }
        }
    ];

    const [result] = await Transaction.aggregate(pipeline);
    const summary = normalizeSummary(result?.summary?.[0]);

    return {
        summary,
        categoryData: result?.categoryData ?? [],
        dailyData: result?.dailyData ?? [],
        recentTransactions: result?.recentTransactions ?? []
    };
};

const buildSalesReportCsv = (transactions: any[]) => {
    const header = [
        'Internal ID',
        'Tanggal',
        'Produk',
        'Kode Produk',
        'Kategori',
        'Brand',
        'Vendor',
        'Member',
        'Email',
        'Target',
        'Omset',
        'Modal',
        'Profit',
        'Status'
    ];

    const rows = transactions.map((transaction) => {
        const product = transaction.product ?? {};
        const user = transaction.user ?? {};
        const amount = Number(transaction.amount ?? 0);
        const costPrice = Number(product.costPrice ?? 0);
        const profit = transaction.status === 'success' && costPrice > 0 ? amount - costPrice : 0;

        return [
            transaction._id,
            formatCsvDate(transaction.createdAt),
            product.name || 'Unknown',
            product.code || '',
            product.category || 'Unknown',
            product.brand || '',
            product.vendor?.name || '',
            user.name || 'Unknown',
            user.email || '',
            transaction.target || '',
            amount,
            costPrice,
            profit,
            transaction.status || ''
        ];
    });

    return [header, ...rows]
        .map((row) => row.map(csvEscape).join(','))
        .join('\n');
};

const buildStatusDateCondition = (format: string, value: string) => ({
    $and: [
        { $eq: ['$status', 'success'] },
        {
            $eq: [
                {
                    $dateToString: {
                        format,
                        date: '$createdAt',
                        timezone: REPORT_TIMEZONE
                    }
                },
                value
            ]
        }
    ]
});

const normalizeRevenue = (omset: unknown, profit: unknown): RevenuePoint => ({
    omset: Number(omset ?? 0),
    profit: Number(profit ?? 0)
});

const buildDashboardPayload = async (match: Record<string, unknown>) => {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const lastMonth = new Date(now);
    lastMonth.setMonth(lastMonth.getMonth() - 1, 1);

    const todayKey = formatDateKey(now);
    const yesterdayKey = formatDateKey(yesterday);
    const thisMonthKey = formatMonthKey(now);
    const lastMonthKey = formatMonthKey(lastMonth);

    const quickPipeline: mongoose.PipelineStage[] = [
        ...buildBasePipeline({}, false),
        {
            $group: {
                _id: null,
                today: {
                    $sum: {
                        $cond: [buildStatusDateCondition('%Y-%m-%d', todayKey), 1, 0]
                    }
                },
                yesterday: {
                    $sum: {
                        $cond: [buildStatusDateCondition('%Y-%m-%d', yesterdayKey), 1, 0]
                    }
                },
                thisMonth: {
                    $sum: {
                        $cond: [buildStatusDateCondition('%Y-%m', thisMonthKey), 1, 0]
                    }
                },
                lastMonth: {
                    $sum: {
                        $cond: [buildStatusDateCondition('%Y-%m', lastMonthKey), 1, 0]
                    }
                },
                todayOmset: {
                    $sum: {
                        $cond: [buildStatusDateCondition('%Y-%m-%d', todayKey), '$amount', 0]
                    }
                },
                todayProfit: {
                    $sum: {
                        $cond: [buildStatusDateCondition('%Y-%m-%d', todayKey), '$trackedProfit', 0]
                    }
                },
                yesterdayOmset: {
                    $sum: {
                        $cond: [buildStatusDateCondition('%Y-%m-%d', yesterdayKey), '$amount', 0]
                    }
                },
                yesterdayProfit: {
                    $sum: {
                        $cond: [buildStatusDateCondition('%Y-%m-%d', yesterdayKey), '$trackedProfit', 0]
                    }
                },
                thisMonthOmset: {
                    $sum: {
                        $cond: [buildStatusDateCondition('%Y-%m', thisMonthKey), '$amount', 0]
                    }
                },
                thisMonthProfit: {
                    $sum: {
                        $cond: [buildStatusDateCondition('%Y-%m', thisMonthKey), '$trackedProfit', 0]
                    }
                },
                lastMonthOmset: {
                    $sum: {
                        $cond: [buildStatusDateCondition('%Y-%m', lastMonthKey), '$amount', 0]
                    }
                },
                lastMonthProfit: {
                    $sum: {
                        $cond: [buildStatusDateCondition('%Y-%m', lastMonthKey), '$trackedProfit', 0]
                    }
                }
            }
        }
    ];

    const [quickRows, reportPayload, callbackPending, callbackDueRetry, callbackHighAttempt, retryQueueHealth] = await Promise.all([
        Transaction.aggregate(quickPipeline),
        buildReportPayload(match),
        DigiflazzSellerOrder.countDocuments({ callbackRequired: true }),
        DigiflazzSellerOrder.countDocuments(getDigiflazzSellerCallbackDueRetryQuery(now)),
        DigiflazzSellerOrder.countDocuments({
            callbackRequired: true,
            callbackAttemptCount: { $gte: DIGIFLAZZ_SELLER_HIGH_CALLBACK_ATTEMPT_THRESHOLD }
        }),
        getDigiflazzSellerRetryQueueHealth()
    ]);
    const quickRow = quickRows[0];

    return {
        ...reportPayload,
        quickStats: {
            today: Number(quickRow?.today ?? 0),
            yesterday: Number(quickRow?.yesterday ?? 0),
            thisMonth: Number(quickRow?.thisMonth ?? 0),
            lastMonth: Number(quickRow?.lastMonth ?? 0)
        },
        revenueBreakdown: {
            today: normalizeRevenue(quickRow?.todayOmset, quickRow?.todayProfit),
            yesterday: normalizeRevenue(quickRow?.yesterdayOmset, quickRow?.yesterdayProfit),
            thisMonth: normalizeRevenue(quickRow?.thisMonthOmset, quickRow?.thisMonthProfit),
            lastMonth: normalizeRevenue(quickRow?.lastMonthOmset, quickRow?.lastMonthProfit)
        },
        sellerCallbackQueue: {
            pending: callbackPending,
            due: callbackDueRetry,
            highAttempt: callbackHighAttempt,
            highAttemptThreshold: DIGIFLAZZ_SELLER_HIGH_CALLBACK_ATTEMPT_THRESHOLD,
            schedulerHealth: retryQueueHealth
        },
        lastUpdatedAt: new Date().toISOString()
    };
};

const handleControllerError = (reply: FastifyReply, error: unknown) => {
    console.error(error);

    if (error instanceof ReportControllerError) {
        return reply.status(error.statusCode).send({ message: error.message });
    }

    return reply.status(500).send({ message: 'Internal Server Error' });
};

export const getDashboardOverview = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const match = buildDateMatch(request.query as SalesReportQuery);
        const payload = await buildDashboardPayload(match);
        return reply.send(payload);
    } catch (error) {
        return handleControllerError(reply, error);
    }
};

export const getSalesReport = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const match = buildDateMatch(request.query as SalesReportQuery);
        const payload = await buildReportPayload(match);
        return reply.send(payload);
    } catch (error) {
        return handleControllerError(reply, error);
    }
};

export const exportSalesReport = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const match = buildDateMatch(request.query as SalesReportQuery);
        const transactions = await Transaction.find({
            ...match,
            status: 'success'
        })
            .populate('product')
            .populate('user', 'name email')
            .sort({ createdAt: -1 })
            .limit(SALES_REPORT_EXPORT_LIMIT)
            .lean();

        const csv = buildSalesReportCsv(transactions);
        const filename = `sales-report-${formatDateKey(new Date())}.csv`;

        return reply
            .header('Content-Type', 'text/csv; charset=utf-8')
            .header('Content-Disposition', `attachment; filename="${filename}"`)
            .send(`\uFEFF${csv}`);
    } catch (error) {
        return handleControllerError(reply, error);
    }
};
