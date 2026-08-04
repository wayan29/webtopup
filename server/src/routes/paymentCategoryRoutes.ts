import { FastifyInstance } from 'fastify';
import { 
    getPaymentCategories, 
    getActivePaymentCategories, 
    createPaymentCategory, 
    updatePaymentCategory, 
    deletePaymentCategory,
    reorderPaymentCategories
} from '../controllers/paymentCategoryController';
import { authenticate, hasPermission } from '../middlewares/authMiddleware';

export default async function paymentCategoryRoutes(fastify: FastifyInstance) {
    fastify.get('/', getActivePaymentCategories);
    fastify.get('/active', { preHandler: [authenticate] }, getActivePaymentCategories);
    
    fastify.get('/admin/all', { preHandler: [authenticate, hasPermission('viewPayment')] }, getPaymentCategories);
    fastify.post('/', { preHandler: [authenticate, hasPermission('managePayment')] }, createPaymentCategory);
    fastify.put('/reorder', { preHandler: [authenticate, hasPermission('managePayment')] }, reorderPaymentCategories);
    fastify.put('/:id', { preHandler: [authenticate, hasPermission('managePayment')] }, updatePaymentCategory);
    fastify.delete('/:id', { preHandler: [authenticate, hasPermission('managePayment')] }, deletePaymentCategory);
}
