import { FastifyInstance } from 'fastify';
import { authenticate, hasPermission } from '../middlewares/authMiddleware';
import {
    createTeamMember,
    deactivateTeamMember,
    deleteTeamMember,
    listTeamMembers,
    getTeamMember,
    resetTeamMemberTwoFactor,
    updateTeamMember,
    getLoginLogs,
    getAllLoginLogs,
    getTeamAuditLogs
} from '../controllers/teamController';

export default async function teamRoutes(fastify: FastifyInstance) {
    fastify.get('/', { preHandler: [authenticate, hasPermission('viewTeam')] }, listTeamMembers);
    fastify.get('/audit-logs', { preHandler: [authenticate, hasPermission('manageTeam')] }, getTeamAuditLogs);
    fastify.get('/login-logs/all', { preHandler: [authenticate, hasPermission('manageTeam')] }, getAllLoginLogs);
    fastify.get('/:id', { preHandler: [authenticate, hasPermission('viewTeam')] }, getTeamMember);
    fastify.get('/:id/login-logs', { preHandler: [authenticate, hasPermission('manageTeam')] }, getLoginLogs);

    fastify.post('/', { preHandler: [authenticate, hasPermission('manageTeam')] }, createTeamMember);
    fastify.put('/:id', { preHandler: [authenticate, hasPermission('manageTeam')] }, updateTeamMember);
    fastify.put('/:id/toggle', { preHandler: [authenticate, hasPermission('manageTeam')] }, deactivateTeamMember);
    fastify.put('/:id/reset-2fa', { preHandler: [authenticate, hasPermission('manageTeam')] }, resetTeamMemberTwoFactor);
    fastify.delete('/:id', { preHandler: [authenticate, hasPermission('manageTeam')] }, deleteTeamMember);
}
