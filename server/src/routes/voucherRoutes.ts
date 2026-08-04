import { FastifyInstance } from 'fastify';
import { createVoucher, getVouchers, deleteVoucher, redeemVoucher, restoreVoucher } from '../controllers/voucherController';
import { authenticate, hasPermission } from '../middlewares/authMiddleware';

export default async function voucherRoutes(fastify: FastifyInstance) {
    // Admin Routes
    fastify.post('/', { preHandler: [authenticate, hasPermission('manageProducts')] }, createVoucher);
    fastify.get('/', { preHandler: [authenticate, hasPermission('manageProducts')] }, getVouchers);
    fastify.delete('/:id', { preHandler: [authenticate, hasPermission('manageProducts')] }, deleteVoucher);
    fastify.patch('/:id/restore', { preHandler: [authenticate, hasPermission('manageProducts')] }, restoreVoucher);

    // User Routes
    fastify.post('/redeem', { preHandler: [authenticate] }, redeemVoucher);
}
