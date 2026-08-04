import { FastifyInstance } from 'fastify';
import { createProduct, getProducts, getAllProducts, getProduct, updateProduct, deleteProduct, getProductsForSorting, updateSortOrder, sortProductsByPrice, getCatalogAuditReport } from '../controllers/productController';
import { authenticate, hasPermission } from '../middlewares/authMiddleware';

export default async function productRoutes(fastify: FastifyInstance) {
    // Public Routes
    fastify.get('/', getProducts);
    fastify.get('/admin/catalog-audit', { preHandler: [authenticate, hasPermission('manageProducts')] }, getCatalogAuditReport);
    fastify.get('/:id', getProduct);

    // Admin Routes
    fastify.get('/admin/all', { preHandler: [authenticate, hasPermission('manageProducts')] }, getAllProducts);
    fastify.get('/admin/sorting', { preHandler: [authenticate, hasPermission('manageProducts')] }, getProductsForSorting);
    fastify.post('/admin/sort-order', { preHandler: [authenticate, hasPermission('manageProducts')] }, updateSortOrder);
    fastify.post('/admin/sort-by-price', { preHandler: [authenticate, hasPermission('manageProducts')] }, sortProductsByPrice);
    fastify.post('/', { preHandler: [authenticate, hasPermission('manageProducts')] }, createProduct);
    fastify.put('/:id', { preHandler: [authenticate, hasPermission('manageProducts')] }, updateProduct);
    fastify.delete('/:id', { preHandler: [authenticate, hasPermission('manageProducts')] }, deleteProduct);
}
