import { FastifyReply } from 'fastify';
import mongoose from 'mongoose';
import { AdminNotificationState, Deposit, DigiflazzSellerOrder, Transaction, Vendor } from '../models';
import { AuthRequest } from '../middlewares/authMiddleware';
import {
    DIGIFLAZZ_SELLER_HIGH_CALLBACK_ATTEMPT_THRESHOLD,
    getDigiflazzSellerCallbackDueRetryQuery,
    getDigiflazzSellerRetryQueueHealth
} from '../services/digiflazzSellerService';
import { DigiflazzAdapter } from '../vendors/digiflazz';
import { TokovoucherAdapter } from '../vendors/tokovoucher';

type NotificationSeverity = 'critical' | 'warning' | 'info';

type AdminNotification = {
    id: string;
    severity: NotificationSeverity;
    category: 'transactions' | 'deposits' | 'vendors' | 'callbacks';
    title: string;
    message: string;
    count: number;
    actionLabel: string;
    actionPath: string;
    fingerprint?: string;
    readAt?: Date | null;
    dismissedAt?: Date | null;
    unread?: boolean;
};

const STUCK_TRANSACTION_MINUTES = 15;
const startOfToday = () => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    return date;
};

const normalizeText = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const normalizeNonNegativeNumber = (value: unknown) => {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) && numericValue > 0 ? Math.floor(numericValue) : 0;
};

const getDigiflazzCredentials = (vendor?: { config?: Record<string, any> } | null) => ({
    username: normalizeText(vendor?.config?.username) || normalizeText(process.env.DIGIFLAZZ_USERNAME),
    apiKey: normalizeText(vendor?.config?.apiKey) || normalizeText(process.env.DIGIFLAZZ_API_KEY)
});

const getTokovoucherCredentials = (vendor?: { config?: Record<string, any> } | null) => ({
    memberCode: normalizeText(vendor?.config?.memberCode || vendor?.config?.apiKey) || normalizeText(process.env.TOKOVOUCHER_MEMBER_CODE || process.env.TOKOVOUCHER_API_KEY),
    secret: normalizeText(vendor?.config?.secret) || normalizeText(process.env.TOKOVOUCHER_SECRET)
});

const buildNotification = (input: AdminNotification) => ({
    ...input,
    fingerprint: `${input.id}:${input.count}:${input.message}`
});

const buildAdminNotificationsPayload = async (userId: string) => {
    const now = new Date();
        const today = startOfToday();
        const stuckCutoff = new Date(now.getTime() - STUCK_TRANSACTION_MINUTES * 60 * 1000);

        const [
            stuckTransactions,
            failedTransactionsToday,
            pendingDeposits,
            callbackPending,
            callbackDueRetry,
            callbackHighAttempt,
            retryQueueHealth,
            callbackFailed,
            digiflazzVendor,
            tokovoucherVendor
        ] = await Promise.all([
            Transaction.countDocuments({ status: { $in: ['pending', 'processing'] }, updatedAt: { $lte: stuckCutoff } }),
            Transaction.countDocuments({ status: 'failed', createdAt: { $gte: today } }),
            Deposit.countDocuments({ status: 'pending' }),
            DigiflazzSellerOrder.countDocuments({ callbackRequired: true }),
            DigiflazzSellerOrder.countDocuments(getDigiflazzSellerCallbackDueRetryQuery(now)),
            DigiflazzSellerOrder.countDocuments({
                callbackRequired: true,
                callbackAttemptCount: { $gte: DIGIFLAZZ_SELLER_HIGH_CALLBACK_ATTEMPT_THRESHOLD }
            }),
            getDigiflazzSellerRetryQueueHealth(),
            DigiflazzSellerOrder.countDocuments({ status: 'failed', createdAt: { $gte: today } }),
            Vendor.findOne({ name: { $regex: /digiflazz/i } }).lean(),
            Vendor.findOne({ name: { $regex: /tokovoucher/i } }).lean()
        ]);

        const notifications: AdminNotification[] = [];

        if (stuckTransactions > 0) {
            notifications.push(buildNotification({
                id: 'transactions-stuck',
                severity: 'critical',
                category: 'transactions',
                title: 'Transaksi macet perlu dicek',
                message: `${stuckTransactions} transaksi pending/proses tidak berubah lebih dari ${STUCK_TRANSACTION_MINUTES} menit.`,
                count: stuckTransactions,
                actionLabel: 'Buka transaksi',
                actionPath: '/admin/transactions?status=pending,processing'
            }));
        }

        if (pendingDeposits > 0) {
            notifications.push(buildNotification({
                id: 'deposits-pending',
                severity: pendingDeposits > 10 ? 'warning' : 'info',
                category: 'deposits',
                title: 'Deposit menunggu approval',
                message: `${pendingDeposits} deposit masih pending dan perlu diverifikasi admin.`,
                count: pendingDeposits,
                actionLabel: 'Buka deposits',
                actionPath: '/admin/deposits?status=pending'
            }));
        }

        if (failedTransactionsToday > 0) {
            notifications.push(buildNotification({
                id: 'transactions-failed-today',
                severity: failedTransactionsToday > 10 ? 'warning' : 'info',
                category: 'transactions',
                title: 'Transaksi gagal hari ini',
                message: `${failedTransactionsToday} transaksi gagal sejak awal hari ini.`,
                count: failedTransactionsToday,
                actionLabel: 'Review transaksi',
                actionPath: '/admin/transactions?status=failed'
            }));
        }

        if (callbackPending > 0) {
            notifications.push(buildNotification({
                id: 'seller-callback-pending',
                severity: 'warning',
                category: 'callbacks',
                title: 'Callback seller pending',
                message: `${callbackPending} callback Digiflazz Seller masih perlu dikirim ulang. ${callbackDueRetry} sudah jatuh tempo retry.`,
                count: callbackPending,
                actionLabel: 'Buka seller center',
                actionPath: '/admin/addons/digiflazz-seller'
            }));
        }

        if (callbackHighAttempt > 0) {
            notifications.push(buildNotification({
                id: 'seller-callback-high-attempt',
                severity: 'critical',
                category: 'callbacks',
                title: 'Callback seller gagal berulang',
                message: `${callbackHighAttempt} callback Digiflazz Seller sudah gagal minimal ${DIGIFLAZZ_SELLER_HIGH_CALLBACK_ATTEMPT_THRESHOLD} kali.`,
                count: callbackHighAttempt,
                actionLabel: 'Buka retry due',
                actionPath: '/admin/transactions?mode=seller&callback=due'
            }));
        }

        if (retryQueueHealth.status === 'failed') {
            notifications.push(buildNotification({
                id: 'seller-callback-scheduler-failed',
                severity: 'warning',
                category: 'callbacks',
                title: 'Scheduler callback bermasalah',
                message: retryQueueHealth.lastError || 'Scheduler retry callback terakhir gagal diproses.',
                count: 1,
                actionLabel: 'Buka seller center',
                actionPath: '/admin/addons/digiflazz-seller'
            }));
        }

        if (callbackFailed > 0) {
            notifications.push(buildNotification({
                id: 'seller-order-failed-today',
                severity: callbackFailed > 5 ? 'warning' : 'info',
                category: 'callbacks',
                title: 'Order seller gagal hari ini',
                message: `${callbackFailed} order Digiflazz Seller gagal sejak awal hari ini.`,
                count: callbackFailed,
                actionLabel: 'Review seller order',
                actionPath: '/admin/addons/digiflazz-seller'
            }));
        }

        const checkVendorBalance = async (
            key: 'digiflazz' | 'tokovoucher',
            label: string,
            vendor: any
        ) => {
            const threshold = normalizeNonNegativeNumber(vendor?.lowBalanceThreshold);
            if (!threshold) return;

            try {
                let balance = 0;
                if (key === 'digiflazz') {
                    const credentials = getDigiflazzCredentials(vendor);
                    if (!credentials.username || !credentials.apiKey) return;
                    const adapter = new DigiflazzAdapter(credentials.username, credentials.apiKey, vendor?.apiBaseUrl || process.env.DIGIFLAZZ_BASE_URL);
                    balance = await adapter.getBalance();
                } else {
                    const credentials = getTokovoucherCredentials(vendor);
                    if (!credentials.memberCode || !credentials.secret) return;
                    const adapter = new TokovoucherAdapter(credentials.memberCode, credentials.secret, vendor?.apiBaseUrl || process.env.TOKOVOUCHER_BASE_URL);
                    balance = await adapter.getBalance();
                }

                if (balance <= threshold) {
                    notifications.push(buildNotification({
                        id: `vendor-low-balance-${key}`,
                        severity: 'warning',
                        category: 'vendors',
                        title: `${label} saldo rendah`,
                        message: `Saldo ${label} Rp${balance.toLocaleString('id-ID')} berada di bawah threshold Rp${threshold.toLocaleString('id-ID')}.`,
                        count: 1,
                        actionLabel: 'Buka vendor health',
                        actionPath: '/admin/vendor-health'
                    }));
                }
            } catch {
                notifications.push(buildNotification({
                    id: `vendor-balance-check-failed-${key}`,
                    severity: 'warning',
                    category: 'vendors',
                    title: `${label} gagal cek saldo`,
                    message: `Sistem tidak berhasil mengambil saldo ${label}. Periksa credential atau koneksi vendor.`,
                    count: 1,
                    actionLabel: 'Buka vendor health',
                    actionPath: '/admin/vendor-health'
                }));
            }
        };

        await Promise.all([
            checkVendorBalance('digiflazz', 'Digiflazz', digiflazzVendor),
            checkVendorBalance('tokovoucher', 'Tokovoucher', tokovoucherVendor)
        ]);

        const states = await AdminNotificationState.find({
            user: userId,
            notificationId: { $in: notifications.map((item) => item.id) }
        }).lean();
        const stateByKey = new Map(states.map((state) => [
            `${state.notificationId}:${state.fingerprint}`,
            state
        ]));
        const visibleNotifications = notifications
            .map((notification) => {
                const state = stateByKey.get(`${notification.id}:${notification.fingerprint}`);
                return {
                    ...notification,
                    readAt: state?.readAt || null,
                    dismissedAt: state?.dismissedAt || null,
                    unread: !state?.readAt
                };
            })
            .filter((notification) => !notification.dismissedAt);

        const severityRank: Record<NotificationSeverity, number> = { critical: 0, warning: 1, info: 2 };
        visibleNotifications.sort((left, right) => severityRank[left.severity] - severityRank[right.severity] || right.count - left.count);

    return {
        generatedAt: now,
        total: visibleNotifications.length,
        unread: visibleNotifications.filter((item) => item.unread).length,
        critical: visibleNotifications.filter((item) => item.severity === 'critical').length,
        warning: visibleNotifications.filter((item) => item.severity === 'warning').length,
        info: visibleNotifications.filter((item) => item.severity === 'info').length,
        notifications: visibleNotifications
    };
};

export const getAdminNotifications = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const userId = request.user?.id;
        if (!userId) {
            return reply.status(401).send({ message: 'Unauthorized' });
        }

        return reply.send(await buildAdminNotificationsPayload(userId));
    } catch (error) {
        console.error('Error fetching admin notifications:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

const updateNotificationState = async (request: AuthRequest, reply: FastifyReply, changes: { readAt?: Date; dismissedAt?: Date }) => {
    const userId = request.user?.id;
    if (!userId) {
        return reply.status(401).send({ message: 'Unauthorized' });
    }

    const { id } = request.params as { id: string };
    const { fingerprint } = request.body as { fingerprint?: string };
    if (!id || !fingerprint) {
        return reply.status(400).send({ message: 'Notifikasi tidak valid' });
    }

    await AdminNotificationState.findOneAndUpdate(
        {
            user: new mongoose.Types.ObjectId(userId),
            notificationId: id,
            fingerprint
        },
        {
            $set: changes,
            $setOnInsert: {
                user: new mongoose.Types.ObjectId(userId),
                notificationId: id,
                fingerprint
            }
        },
        { upsert: true, new: true }
    );

    return reply.send({ success: true });
};

export const markAdminNotificationRead = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        return await updateNotificationState(request, reply, { readAt: new Date() });
    } catch (error) {
        console.error('Error marking admin notification read:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const dismissAdminNotification = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const now = new Date();
        return await updateNotificationState(request, reply, { readAt: now, dismissedAt: now });
    } catch (error) {
        console.error('Error dismissing admin notification:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const markAllAdminNotificationsRead = async (request: AuthRequest, reply: FastifyReply) => {
    try {
        const userId = request.user?.id;
        if (!userId) {
            return reply.status(401).send({ message: 'Unauthorized' });
        }

        const now = new Date();
        const notificationsResponse = await buildAdminNotificationsPayload(userId);
        const notifications = Array.isArray(notificationsResponse?.notifications) ? notificationsResponse.notifications : [];
        await Promise.all(notifications.map((notification: AdminNotification) => AdminNotificationState.findOneAndUpdate(
            {
                user: new mongoose.Types.ObjectId(userId),
                notificationId: notification.id,
                fingerprint: notification.fingerprint
            },
            {
                $set: { readAt: now },
                $setOnInsert: {
                    user: new mongoose.Types.ObjectId(userId),
                    notificationId: notification.id,
                    fingerprint: notification.fingerprint
                }
            },
            { upsert: true }
        )));

        return reply.send({ success: true, updated: notifications.length });
    } catch (error) {
        console.error('Error marking all admin notifications read:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};
