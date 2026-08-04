import { FastifyInstance } from 'fastify';
import { authenticate, hasPermission } from '../middlewares/authMiddleware';
import {
    getSliders,
    getAllSliders,
    createSlider,
    updateSlider,
    deleteSlider,
    updateSortOrder
} from '../controllers/sliderController';

export default async function sliderRoutes(fastify: FastifyInstance) {
    // Public route
    fastify.get('/', getSliders);

    // Admin routes
    fastify.get('/admin/all', { preHandler: [authenticate, hasPermission('manageSettings')] }, getAllSliders);
    fastify.post('/admin/create', { preHandler: [authenticate, hasPermission('manageSettings')] }, createSlider);
    fastify.put('/admin/:id', { preHandler: [authenticate, hasPermission('manageSettings')] }, updateSlider);
    fastify.delete('/admin/:id', { preHandler: [authenticate, hasPermission('manageSettings')] }, deleteSlider);
    fastify.put('/admin/sort-order', { preHandler: [authenticate, hasPermission('manageSettings')] }, updateSortOrder);
}
