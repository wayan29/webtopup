import { FastifyInstance } from 'fastify';
import { 
    getPaymentMethods, 
    getActivePaymentMethods, 
    createPaymentMethod, 
    updatePaymentMethod, 
    deletePaymentMethod 
} from '../controllers/paymentMethodController';
import { authenticate, hasPermission } from '../middlewares/authMiddleware';

export default async function paymentMethodRoutes(fastify: FastifyInstance) {
    // Public route for active payment methods (for order/deposit page)
    fastify.get('/', getActivePaymentMethods);
    fastify.get('/active', { preHandler: [authenticate] }, getActivePaymentMethods);
    
    // Admin routes
    fastify.get('/admin/all', { preHandler: [authenticate, hasPermission('viewPayment')] }, getPaymentMethods);
    fastify.post('/', { preHandler: [authenticate, hasPermission('managePayment')] }, createPaymentMethod);
    fastify.put('/:id', { preHandler: [authenticate, hasPermission('managePayment')] }, updatePaymentMethod);
    fastify.delete('/:id', { preHandler: [authenticate, hasPermission('managePayment')] }, deletePaymentMethod);
}
