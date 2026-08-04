import { FastifyInstance } from 'fastify';
import {
    getCategories,
    getAllCategories,
    getCategoryById,
    createCategory,
    updateCategory,
    deleteCategory,
    updateSortOrder
} from '../controllers/categoryController';
import { authenticate, hasPermission } from '../middlewares/authMiddleware';

export default async function categoryRoutes(fastify: FastifyInstance) {
    // Public routes
    fastify.get('/', getCategories);
    fastify.get('/:id', getCategoryById);

    // Admin routes
    fastify.get('/admin/all', {
        preHandler: [authenticate, hasPermission('manageProducts')]
    }, getAllCategories);

    fastify.post('/admin/create', {
        preHandler: [authenticate, hasPermission('manageProducts')]
    }, createCategory);

    fastify.put('/admin/:id', {
        preHandler: [authenticate, hasPermission('manageProducts')]
    }, updateCategory);

    fastify.delete('/admin/:id', {
        preHandler: [authenticate, hasPermission('manageProducts')]
    }, deleteCategory);

    fastify.put('/admin/sort-order', {
        preHandler: [authenticate, hasPermission('manageProducts')]
    }, updateSortOrder);
}
