import { FastifyInstance } from 'fastify';
import {
    createTransaction,
    exportAdminTransactionsCsv,
    getAdminTransactions,
    getManualTransactions,
    getStuckTransactions,
    getTransactions,
    recheckTransactionStatus,
    refundTransaction,
    updateTransactionStatus
} from '../controllers/transactionController';
import { authenticate, hasPermission } from '../middlewares/authMiddleware';
import { legacyFinanceWriteGate } from '../middlewares/legacyFinanceGate';

export default async function transactionRoutes(fastify: FastifyInstance) {
    // User Routes - members can view their own transactions, team can view all
    fastify.post('/', { preHandler: [legacyFinanceWriteGate, authenticate] }, createTransaction);
    fastify.get('/', { preHandler: [authenticate] }, getTransactions);

    // Admin Routes
    fastify.get('/manual', { preHandler: [authenticate, hasPermission('processManualTransaction')] }, getManualTransactions);
    fastify.get('/admin/export', { preHandler: [authenticate, hasPermission('viewTransactions')] }, exportAdminTransactionsCsv);
    fastify.get('/admin/stuck', { preHandler: [authenticate, hasPermission('viewTransactions')] }, getStuckTransactions);
    fastify.get('/admin', { preHandler: [authenticate, hasPermission('viewTransactions')] }, getAdminTransactions);
    fastify.post('/:id/recheck', { preHandler: [legacyFinanceWriteGate, authenticate, hasPermission('processManualTransaction')] }, recheckTransactionStatus);
    fastify.post('/:id/refund', { preHandler: [legacyFinanceWriteGate, authenticate, hasPermission('processManualTransaction')] }, refundTransaction);
    fastify.put('/:id/status', { preHandler: [legacyFinanceWriteGate, authenticate, hasPermission('processManualTransaction')] }, updateTransactionStatus);
}
