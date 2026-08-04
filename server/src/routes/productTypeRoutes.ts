import { FastifyInstance } from 'fastify';
import {
    getProductTypes,
    getAllProductTypes,
    getProductTypeById,
    createProductType,
    updateProductType,
    deleteProductType,
    updateSortOrder
} from '../controllers/productTypeController';
import { authenticate, hasPermission } from '../middlewares/authMiddleware';

export default async function productTypeRoutes(fastify: FastifyInstance) {
    // Public routes
    fastify.get('/', getProductTypes);
    fastify.get('/:id', getProductTypeById);

    // Admin routes
    fastify.get('/admin/all', {
        preHandler: [authenticate, hasPermission('manageProducts')]
    }, getAllProductTypes);

    fastify.get('/admin/:id', {
        preHandler: [authenticate, hasPermission('manageProducts')]
    }, getProductTypeById);

    fastify.post('/admin/create', {
        preHandler: [authenticate, hasPermission('manageProducts')]
    }, createProductType);

    fastify.put('/admin/:id', {
        preHandler: [authenticate, hasPermission('manageProducts')]
    }, updateProductType);

    fastify.delete('/admin/:id', {
        preHandler: [authenticate, hasPermission('manageProducts')]
    }, deleteProductType);

    fastify.put('/admin/sort-order', {
        preHandler: [authenticate, hasPermission('manageProducts')]
    }, updateSortOrder);
}
