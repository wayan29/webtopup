import { FastifyInstance } from 'fastify';
import {
    getRewards,
    getAllRewards,
    getRewardById,
    createReward,
    updateReward,
    deleteReward,
    redeemReward
} from '../controllers/rewardController';
import { authenticate, hasPermission } from '../middlewares/authMiddleware';
import { legacyRewardsPointsReadGate, legacyRewardsPointsWriteGate } from '../middlewares/legacyRewardsPointsGate';

export default async function rewardRoutes(fastify: FastifyInstance) {
    // Public routes
    fastify.get('/', { preHandler: [legacyRewardsPointsReadGate] }, getRewards);
    fastify.get('/:id', { preHandler: [legacyRewardsPointsReadGate] }, getRewardById);

    // User routes
    fastify.post('/redeem', {
        preHandler: [legacyRewardsPointsWriteGate, authenticate]
    }, redeemReward);

    // Admin routes
    fastify.get('/admin/all', {
        preHandler: [legacyRewardsPointsReadGate, authenticate, hasPermission('manageProducts')]
    }, getAllRewards);

    fastify.post('/admin/create', {
        preHandler: [legacyRewardsPointsWriteGate, authenticate, hasPermission('manageProducts')]
    }, createReward);

    fastify.put('/admin/:id', {
        preHandler: [legacyRewardsPointsWriteGate, authenticate, hasPermission('manageProducts')]
    }, updateReward);

    fastify.delete('/admin/:id', {
        preHandler: [legacyRewardsPointsWriteGate, authenticate, hasPermission('manageProducts')]
    }, deleteReward);
}
