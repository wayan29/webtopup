import { FastifyInstance } from 'fastify';
import {
    getPointsSettings,
    updatePointsSettings,
    getPointsHistory,
    getAllPointTransactions,
    adjustUserPoints,
    getPointsStats
} from '../controllers/pointsController';
import { authenticate, hasPermission } from '../middlewares/authMiddleware';
import { legacyRewardsPointsReadGate, legacyRewardsPointsWriteGate } from '../middlewares/legacyRewardsPointsGate';

export default async function pointsRoutes(fastify: FastifyInstance) {
    // Public/User routes
    fastify.get('/history', {
        preHandler: [legacyRewardsPointsReadGate, authenticate]
    }, getPointsHistory);

    // Admin routes
    fastify.get('/settings', {
        preHandler: [legacyRewardsPointsReadGate, authenticate, hasPermission('manageProducts')]
    }, getPointsSettings);

    fastify.put('/settings', {
        preHandler: [legacyRewardsPointsWriteGate, authenticate, hasPermission('manageProducts')]
    }, updatePointsSettings);

    fastify.get('/transactions', {
        preHandler: [legacyRewardsPointsReadGate, authenticate, hasPermission('manageProducts')]
    }, getAllPointTransactions);

    fastify.post('/adjust', {
        preHandler: [legacyRewardsPointsWriteGate, authenticate, hasPermission('manageProducts')]
    }, adjustUserPoints);

    fastify.get('/stats', {
        preHandler: [legacyRewardsPointsReadGate, authenticate, hasPermission('manageProducts')]
    }, getPointsStats);
}
