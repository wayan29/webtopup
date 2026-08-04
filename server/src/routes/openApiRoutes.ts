import { FastifyInstance } from 'fastify';
import { authenticate } from '../middlewares/authMiddleware';
import { legacyFinanceWriteGate } from '../middlewares/legacyFinanceGate';
import {
    generateUserApiKey,
    getUserApiKey,
    revokeApiKey,
    authenticateApiKey,
    apiGetProfile,
    apiGetProducts,
    apiCreateTransaction,
    apiCheckTransaction,
    apiGetTransactions
} from '../controllers/openApiController';

export default async function openApiRoutes(fastify: FastifyInstance) {
    // User API key management (requires JWT auth)
    fastify.post('/key/generate', { preHandler: [authenticate] }, generateUserApiKey);
    fastify.get('/key', { preHandler: [authenticate] }, getUserApiKey);
    fastify.delete('/key/revoke', { preHandler: [authenticate] }, revokeApiKey);

    // Open API endpoints (requires API key auth)
    fastify.get('/profile', { preHandler: [authenticateApiKey] }, apiGetProfile);
    fastify.get('/products', { preHandler: [authenticateApiKey] }, apiGetProducts);
    fastify.post('/transaction', { preHandler: [legacyFinanceWriteGate, authenticateApiKey] }, apiCreateTransaction);
    fastify.get('/transaction/check', { preHandler: [authenticateApiKey] }, apiCheckTransaction);
    fastify.get('/transactions', { preHandler: [authenticateApiKey] }, apiGetTransactions);
}
