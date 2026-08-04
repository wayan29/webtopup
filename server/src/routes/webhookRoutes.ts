import { FastifyInstance } from 'fastify';
import { authenticate, hasPermission } from '../middlewares/authMiddleware';
import {
    handleDigiflazzWebhook,
    getWebhookLogs,
    getWebhookConfig,
    saveWebhookConfig,
    handleTokovoucherWebhook,
    getTokovoucherWebhookLogs,
    getTokovoucherWebhookConfig,
    saveTokovoucherWebhookConfig
} from '../controllers/webhookController';

export default async function webhookRoutes(fastify: FastifyInstance) {
    // Public webhook endpoints (called by vendors)
    fastify.post('/digiflazz', handleDigiflazzWebhook);
    fastify.post('/tokovoucher', handleTokovoucherWebhook);

    // Digiflazz admin routes
    fastify.get('/digiflazz/logs', { preHandler: [authenticate, hasPermission('manageVendors')] }, getWebhookLogs);
    fastify.get('/digiflazz/config', { preHandler: [authenticate, hasPermission('manageVendors')] }, getWebhookConfig);
    fastify.post('/digiflazz/config', { preHandler: [authenticate, hasPermission('manageVendors')] }, saveWebhookConfig);

    // Tokovoucher admin routes
    fastify.get('/tokovoucher/logs', { preHandler: [authenticate, hasPermission('manageVendors')] }, getTokovoucherWebhookLogs);
    fastify.get('/tokovoucher/config', { preHandler: [authenticate, hasPermission('manageVendors')] }, getTokovoucherWebhookConfig);
    fastify.post('/tokovoucher/config', { preHandler: [authenticate, hasPermission('manageVendors')] }, saveTokovoucherWebhookConfig);
}
