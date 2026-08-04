import { FastifyInstance } from 'fastify';
import {
    register,
    login,
    me,
    verifyTwoFactorLogin,
    getTwoFactorStatus,
    setupTwoFactor,
    confirmTwoFactor,
    disableTwoFactor,
    revokeMySessions
} from '../controllers/authController';
import { authenticate } from '../middlewares/authMiddleware';
import { authRateLimit } from '../middlewares/authRateLimit';

export default async function authRoutes(fastify: FastifyInstance) {
    fastify.post('/register', { preHandler: [authRateLimit] }, register);
    fastify.post('/login', { preHandler: [authRateLimit] }, login);
    fastify.post('/2fa/login-verify', { preHandler: [authRateLimit] }, verifyTwoFactorLogin);
    fastify.get('/me', { preHandler: [authenticate] }, me);
    fastify.get('/2fa/status', { preHandler: [authenticate] }, getTwoFactorStatus);
    fastify.post('/2fa/setup', { preHandler: [authRateLimit, authenticate] }, setupTwoFactor);
    fastify.post('/2fa/confirm', { preHandler: [authRateLimit, authenticate] }, confirmTwoFactor);
    fastify.post('/2fa/disable', { preHandler: [authRateLimit, authenticate] }, disableTwoFactor);
    fastify.post('/sessions/revoke', { preHandler: [authRateLimit, authenticate] }, revokeMySessions);
}
