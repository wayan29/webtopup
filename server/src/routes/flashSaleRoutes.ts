import { FastifyInstance } from 'fastify';
import { authenticate, hasPermission } from '../middlewares/authMiddleware';
import {
    getActiveFlashSales,
    getAllFlashSales,
    getFlashSale,
    createFlashSale,
    updateFlashSale,
    deleteFlashSale,
    addProductToFlashSale,
    removeProductFromFlashSale,
    getFlashSalePrice
} from '../controllers/flashSaleController';

export default async function flashSaleRoutes(fastify: FastifyInstance) {
    // Public routes
    fastify.get('/active', getActiveFlashSales);
    fastify.get('/price/:productId', getFlashSalePrice);

    // Admin routes
    fastify.get('/admin/all', { preHandler: [authenticate, hasPermission('manageProducts')] }, getAllFlashSales);
    fastify.get('/admin/:id', { preHandler: [authenticate, hasPermission('manageProducts')] }, getFlashSale);
    fastify.post('/admin/create', { preHandler: [authenticate, hasPermission('manageProducts')] }, createFlashSale);
    fastify.put('/admin/:id', { preHandler: [authenticate, hasPermission('manageProducts')] }, updateFlashSale);
    fastify.delete('/admin/:id', { preHandler: [authenticate, hasPermission('manageProducts')] }, deleteFlashSale);
    fastify.post('/admin/:id/products', { preHandler: [authenticate, hasPermission('manageProducts')] }, addProductToFlashSale);
    fastify.delete('/admin/:id/products/:productId', { preHandler: [authenticate, hasPermission('manageProducts')] }, removeProductFromFlashSale);
}
