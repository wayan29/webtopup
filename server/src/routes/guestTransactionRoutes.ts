import { FastifyInstance } from 'fastify';
import {
    createGuestTransaction,
    checkGuestTransaction,
    getGuestTransactions,
    confirmGuestPayment,
    cancelGuestTransaction,
    updateGuestTransactionStatus
} from '../controllers/guestTransactionController';
import { authenticate, hasPermission } from '../middlewares/authMiddleware';
import { guestTransactionRateLimit } from '../middlewares/publicRateLimit';
import { legacyFinanceWriteGate } from '../middlewares/legacyFinanceGate';

export default async function guestTransactionRoutes(fastify: FastifyInstance) {
    // Public routes (no auth required)
    fastify.post('/', { preHandler: [legacyFinanceWriteGate, guestTransactionRateLimit] }, createGuestTransaction);
    fastify.get('/check/:invoiceNumber', { preHandler: [guestTransactionRateLimit] }, checkGuestTransaction);

    // Admin routes
    fastify.get('/', { preHandler: [authenticate, hasPermission('viewTransactions')] }, getGuestTransactions);
    fastify.post('/:id/confirm', { preHandler: [legacyFinanceWriteGate, authenticate, hasPermission('processManualTransaction')] }, confirmGuestPayment);
    fastify.post('/:id/cancel', { preHandler: [legacyFinanceWriteGate, authenticate, hasPermission('processManualTransaction')] }, cancelGuestTransaction);
    fastify.put('/:id/status', { preHandler: [legacyFinanceWriteGate, authenticate, hasPermission('processManualTransaction')] }, updateGuestTransactionStatus);
}
