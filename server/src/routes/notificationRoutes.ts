import { FastifyInstance } from 'fastify';
import {
    dismissAdminNotification,
    getAdminNotifications,
    markAdminNotificationRead,
    markAllAdminNotificationsRead
} from '../controllers/notificationController';
import { authenticate, hasPermission } from '../middlewares/authMiddleware';

export default async function notificationRoutes(fastify: FastifyInstance) {
    fastify.get('/admin', {
        preHandler: [authenticate, hasPermission('viewDashboard')]
    }, getAdminNotifications);

    fastify.post('/admin/read-all', {
        preHandler: [authenticate, hasPermission('viewDashboard')]
    }, markAllAdminNotificationsRead);

    fastify.post('/admin/:id/read', {
        preHandler: [authenticate, hasPermission('viewDashboard')]
    }, markAdminNotificationRead);

    fastify.post('/admin/:id/dismiss', {
        preHandler: [authenticate, hasPermission('viewDashboard')]
    }, dismissAdminNotification);
}
