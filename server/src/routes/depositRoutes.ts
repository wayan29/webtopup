import { FastifyInstance } from 'fastify';
import {
    requestDeposit,
    getDeposits,
    getAdminDeposits,
    exportAdminDepositsCsv,
    claimDeposit,
    approveDeposit,
    releaseDepositClaim,
    rejectDeposit
} from '../controllers/depositController';
import { authenticate, hasPermission } from '../middlewares/authMiddleware';
import { legacyFinanceWriteGate } from '../middlewares/legacyFinanceGate';

export default async function depositRoutes(fastify: FastifyInstance) {
    // User route - members can view their own deposits
    fastify.post('/', { preHandler: [legacyFinanceWriteGate, authenticate] }, requestDeposit);
    fastify.get('/', { preHandler: [authenticate] }, getDeposits);

    // Admin Routes
    fastify.get('/admin/export', { preHandler: [authenticate, hasPermission('viewDeposits')] }, exportAdminDepositsCsv);
    fastify.get('/admin/all', { preHandler: [authenticate, hasPermission('viewDeposits')] }, getAdminDeposits);
    fastify.post('/:id/claim', { preHandler: [legacyFinanceWriteGate, authenticate, hasPermission('approveDeposits')] }, claimDeposit);
    fastify.post('/:id/release-claim', { preHandler: [legacyFinanceWriteGate, authenticate, hasPermission('approveDeposits')] }, releaseDepositClaim);
    fastify.put('/:id/approve', { preHandler: [legacyFinanceWriteGate, authenticate, hasPermission('approveDeposits')] }, approveDeposit);
    fastify.put('/:id/reject', { preHandler: [legacyFinanceWriteGate, authenticate, hasPermission('approveDeposits')] }, rejectDeposit);
}
