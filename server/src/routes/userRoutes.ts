import { FastifyInstance } from 'fastify';
import { 
    changeMyPassword,
    getMyLoginActivity,
    getMyPreferences,
    getMyProfile,
    getMyBalanceHistory,
    getUsers, 
    getUserById, 
    updateMyPreferences,
    updateMyProfile,
    updateUser, 
    deleteUser, 
    adjustUserBalance,
    getUserBalanceAdjustments,
    updateUserStatus
} from '../controllers/userController';
import { authenticate, hasPermission } from '../middlewares/authMiddleware';

export default async function userRoutes(fastify: FastifyInstance) {
    fastify.get('/me/profile', { preHandler: [authenticate] }, getMyProfile);
    fastify.put('/me/profile', { preHandler: [authenticate] }, updateMyProfile);
    fastify.put('/me/password', { preHandler: [authenticate] }, changeMyPassword);
    fastify.get('/me/preferences', { preHandler: [authenticate] }, getMyPreferences);
    fastify.put('/me/preferences', { preHandler: [authenticate] }, updateMyPreferences);
    fastify.get('/me/login-activity', { preHandler: [authenticate] }, getMyLoginActivity);
    fastify.get('/me/balance-history', { preHandler: [authenticate] }, getMyBalanceHistory);
    fastify.get('/', { preHandler: [authenticate, hasPermission('viewUsers')] }, getUsers);
    fastify.get('/:id', { preHandler: [authenticate, hasPermission('viewUsers')] }, getUserById);
    fastify.get('/:id/balance-adjustments', { preHandler: [authenticate, hasPermission('viewUsers')] }, getUserBalanceAdjustments);
    fastify.put('/:id', { preHandler: [authenticate, hasPermission('manageUsers')] }, updateUser);
    fastify.patch('/:id/status', { preHandler: [authenticate, hasPermission('manageUsers')] }, updateUserStatus);
    fastify.delete('/:id', { preHandler: [authenticate, hasPermission('manageUsers')] }, deleteUser);
    fastify.post('/:id/balance', { preHandler: [authenticate, hasPermission('manageUsers')] }, adjustUserBalance);
}
