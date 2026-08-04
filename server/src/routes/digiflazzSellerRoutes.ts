import crypto from 'crypto';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { authenticate, hasPermission } from '../middlewares/authMiddleware';
import { legacyFinanceWriteGate } from '../middlewares/legacyFinanceGate';
import {
    exportDigiflazzSellerAdminOrdersCsv,
    getDigiflazzSellerAdminOrders,
    deleteDigiflazzSellerMapping,
    getDigiflazzSellerMappings,
    getDigiflazzSellerOrders,
    getDigiflazzSellerRetrySchedulerConfig,
    getDigiflazzSellerSettings,
    getDigiflazzSellerWebhookLogs,
    handleDigiflazzSellerPrepaid,
    processDueDigiflazzSellerCallbackRetries,
    retryPendingDigiflazzSellerCallbacks,
    retryDigiflazzSellerCallback,
    saveDigiflazzSellerSettings,
    syncAllDigiflazzSellerMappings,
    syncDigiflazzSellerMappingById,
    upsertDigiflazzSellerMapping
} from '../controllers/digiflazzSellerController';

const normalizeHeaderValue = (value: string | string[] | undefined) => (
    Array.isArray(value) ? value[0] : value || ''
).trim();

const isSecureTokenMatch = (providedToken: string, expectedToken: string) => {
    if (!providedToken || !expectedToken || providedToken.length !== expectedToken.length) {
        return false;
    }

    return crypto.timingSafeEqual(Buffer.from(providedToken), Buffer.from(expectedToken));
};

const verifyRetryQueueSchedulerToken = async (request: FastifyRequest, reply: FastifyReply) => {
    const expectedToken = (process.env.DIGIFLAZZ_SELLER_RETRY_QUEUE_TOKEN || '').trim();
    if (!expectedToken) {
        return reply.status(503).send({ message: 'Scheduler token retry queue belum dikonfigurasi' });
    }

    const headerToken = normalizeHeaderValue(request.headers['x-scheduler-token']);
    const authHeader = normalizeHeaderValue(request.headers.authorization);
    const bearerToken = authHeader.toLowerCase().startsWith('bearer ')
        ? authHeader.slice(7).trim()
        : '';

    if (!isSecureTokenMatch(headerToken || bearerToken, expectedToken)) {
        return reply.status(401).send({ message: 'Scheduler token tidak valid' });
    }
};

export default async function digiflazzSellerRoutes(fastify: FastifyInstance) {
    // Public endpoint for Digiflazz Seller prepaid transaction / check status
    fastify.post('/prepaid', { preHandler: [legacyFinanceWriteGate] }, handleDigiflazzSellerPrepaid);

    // Admin endpoints
    fastify.get('/settings', {
        preHandler: [authenticate, hasPermission('manageVendors')]
    }, getDigiflazzSellerSettings);

    fastify.post('/settings', {
        preHandler: [authenticate, hasPermission('manageVendors')]
    }, saveDigiflazzSellerSettings);

    fastify.get('/mappings', {
        preHandler: [authenticate, hasPermission('manageVendors')]
    }, getDigiflazzSellerMappings);

    fastify.post('/mappings', {
        preHandler: [authenticate, hasPermission('manageVendors')]
    }, upsertDigiflazzSellerMapping);

    fastify.delete('/mappings/:id', {
        preHandler: [authenticate, hasPermission('manageVendors')]
    }, deleteDigiflazzSellerMapping);

    fastify.post('/mappings/:id/sync', {
        preHandler: [authenticate, hasPermission('manageVendors')]
    }, syncDigiflazzSellerMappingById);

    fastify.post('/mappings/sync', {
        preHandler: [authenticate, hasPermission('manageVendors')]
    }, syncAllDigiflazzSellerMappings);

    fastify.get('/logs', {
        preHandler: [authenticate, hasPermission('manageVendors')]
    }, getDigiflazzSellerWebhookLogs);

    fastify.get('/orders/admin', {
        preHandler: [authenticate, hasPermission('viewTransactions')]
    }, getDigiflazzSellerAdminOrders);

    fastify.get('/orders/admin/export', {
        preHandler: [authenticate, hasPermission('viewTransactions')]
    }, exportDigiflazzSellerAdminOrdersCsv);

    fastify.get('/orders', {
        preHandler: [authenticate, hasPermission('manageVendors')]
    }, getDigiflazzSellerOrders);

    fastify.post('/orders/retry-callbacks', {
        preHandler: [authenticate, hasPermission('manageVendors')]
    }, retryPendingDigiflazzSellerCallbacks);

    fastify.post('/orders/process-callback-retries', {
        preHandler: [authenticate, hasPermission('manageVendors')]
    }, processDueDigiflazzSellerCallbackRetries);

    fastify.get('/orders/process-callback-retries/scheduler/config', {
        preHandler: [authenticate, hasPermission('manageVendors')]
    }, getDigiflazzSellerRetrySchedulerConfig);

    fastify.post('/orders/process-callback-retries/scheduler', {
        preHandler: [verifyRetryQueueSchedulerToken]
    }, processDueDigiflazzSellerCallbackRetries);

    fastify.post('/orders/:id/retry-callback', {
        preHandler: [authenticate, hasPermission('manageVendors')]
    }, retryDigiflazzSellerCallback);
}
