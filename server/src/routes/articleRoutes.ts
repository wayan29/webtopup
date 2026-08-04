import { FastifyInstance } from 'fastify';
import { getArticles, getArticleBySlug, createArticle, updateArticle, deleteArticle } from '../controllers/articleController';
import { authenticate, hasPermission } from '../middlewares/authMiddleware';

export default async function articleRoutes(fastify: FastifyInstance) {
    // Public routes
    fastify.get('/', getArticles);
    fastify.get('/:slug', getArticleBySlug);

    // Admin routes
    fastify.post('/', { preHandler: [authenticate, hasPermission('manageSettings')] }, createArticle);
    fastify.put('/:id', { preHandler: [authenticate, hasPermission('manageSettings')] }, updateArticle);
    fastify.delete('/:id', { preHandler: [authenticate, hasPermission('manageSettings')] }, deleteArticle);
}
