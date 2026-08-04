import { FastifyInstance } from 'fastify';
import { authenticate, hasPermission } from '../middlewares/authMiddleware';
import {
    getPublicSettings,
    getAllSettings,
    updateSettings,
    getSetting,
    setSetting
} from '../controllers/settingsController';

export default async function settingsRoutes(fastify: FastifyInstance) {
    // Public route
    fastify.get('/public', getPublicSettings);

    // Admin routes
    fastify.get('/admin/all', { preHandler: [authenticate, hasPermission('manageSettings')] }, getAllSettings);
    fastify.put('/admin/update', { preHandler: [authenticate, hasPermission('manageSettings')] }, updateSettings);
    fastify.get('/admin/:key', { preHandler: [authenticate, hasPermission('manageSettings')] }, getSetting);
    fastify.put('/admin/:key', { preHandler: [authenticate, hasPermission('manageSettings')] }, setSetting);
}
