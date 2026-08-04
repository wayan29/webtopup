import { FastifyInstance } from 'fastify';
import {
    getOperators,
    getAllOperators,
    getOperatorById,
    createOperator,
    updateOperator,
    deleteOperator,
    updateSortOrder
} from '../controllers/operatorController';
import { authenticate, hasPermission } from '../middlewares/authMiddleware';

export default async function operatorRoutes(fastify: FastifyInstance) {
    // Public routes
    fastify.get('/', getOperators);
    fastify.get('/:id', getOperatorById);

    // Admin routes
    fastify.get('/admin/all', {
        preHandler: [authenticate, hasPermission('manageProducts')]
    }, getAllOperators);

    fastify.get('/admin/:id', {
        preHandler: [authenticate, hasPermission('manageProducts')]
    }, getOperatorById);

    fastify.post('/admin/create', {
        preHandler: [authenticate, hasPermission('manageProducts')]
    }, createOperator);

    fastify.put('/admin/:id', {
        preHandler: [authenticate, hasPermission('manageProducts')]
    }, updateOperator);

    fastify.delete('/admin/:id', {
        preHandler: [authenticate, hasPermission('manageProducts')]
    }, deleteOperator);

    fastify.put('/admin/sort-order', {
        preHandler: [authenticate, hasPermission('manageProducts')]
    }, updateSortOrder);
}
