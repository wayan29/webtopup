import { FastifyInstance } from 'fastify';
import { getMargins, updateMargins } from '../controllers/marginController';
import { authenticate, hasPermission } from '../middlewares/authMiddleware';

export default async function marginRoutes(fastify: FastifyInstance) {
    // Get margins - product management only
    fastify.get('/', {
        preHandler: [authenticate, hasPermission('manageProducts')]
    }, getMargins);

    // Update margins - product management only
    fastify.put('/', {
        preHandler: [authenticate, hasPermission('manageProducts')]
    }, updateMargins);
}
