import { FastifyInstance } from 'fastify';
import { exportSalesReport, getDashboardOverview, getSalesReport } from '../controllers/reportController';
import { authenticate, hasPermission } from '../middlewares/authMiddleware';

export default async function reportRoutes(fastify: FastifyInstance) {
    fastify.get('/dashboard', {
        preHandler: [authenticate, hasPermission('viewDashboard')]
    }, getDashboardOverview);

    fastify.get('/sales', {
        preHandler: [authenticate, hasPermission('viewReports')]
    }, getSalesReport);

    fastify.get('/sales/export', {
        preHandler: [authenticate, hasPermission('viewReports')]
    }, exportSalesReport);
}
