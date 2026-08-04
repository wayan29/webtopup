import { FastifyInstance } from 'fastify';
import { exportAdminAuditLogsCsv, getAdminAuditLogs } from '../controllers/adminAuditController';
import { authenticate, hasPermission } from '../middlewares/authMiddleware';

export default async function adminAuditRoutes(fastify: FastifyInstance) {
    fastify.get('/export', {
        preHandler: [authenticate, hasPermission('viewTeam')]
    }, exportAdminAuditLogsCsv);

    fastify.get('/', {
        preHandler: [authenticate, hasPermission('viewTeam')]
    }, getAdminAuditLogs);
}
