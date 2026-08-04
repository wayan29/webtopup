import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import path from 'path';
import apiV2ProxyRoutes from './routes/apiV2ProxyRoutes';
import { createCorsDelegator, getConfiguredCorsOrigins } from './utils/cors';
import { recordAdminAuditLog } from './services/adminAuditService';
import { applyApiV1DeprecationHeaders, blockApiV1WhenDisabled, logApiV1Usage } from './middlewares/apiV1Deprecation';
import { gatewayFastifyServerOptions, registerGatewayCorrelationLifecycle } from './utils/correlation';

export async function buildApp(): Promise<FastifyInstance> {
    const apiV2Prefix = '/api/v2';
    const configuredCorsOrigins = getConfiguredCorsOrigins();
    const app = Fastify({
        ...gatewayFastifyServerOptions(),
        logger: true
    });

    app.log.info({ corsOrigins: Array.from(configuredCorsOrigins) }, 'Resolved CORS origin allowlist');

    registerGatewayCorrelationLifecycle(app);

    await app.register(cors, {
        delegator: createCorsDelegator(configuredCorsOrigins),
        credentials: true,
        exposedHeaders: ['x-trace-id']
    });

    await app.register(cookie);

    await app.register(multipart, {
        limits: {
            fileSize: 5 * 1024 * 1024
        }
    });

    await app.register(helmet, {
        contentSecurityPolicy: {
            useDefaults: false,
            directives: {
                defaultSrc: ["'self'"],
                styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
                scriptSrc: ["'self'"],
                imgSrc: ["'self'", 'data:'],
                fontSrc: ["'self'", 'https:', 'data:'],
                baseUri: ["'self'"],
                formAction: ["'self'"],
                frameAncestors: ["'self'"],
                objectSrc: ["'none'"],
            }
        },
        crossOriginEmbedderPolicy: false,
        crossOriginOpenerPolicy: false,
        crossOriginResourcePolicy: false,
        hsts: process.env.NODE_ENV === 'production'
            ? {
                maxAge: 15552000,
                includeSubDomains: true
            }
            : false,
        originAgentCluster: false,
    });

    app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
        (request as { rawBody?: Buffer }).rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body);
        try {
            done(null, JSON.parse(body.toString('utf8')));
        } catch (error) {
            const parseError = error as Error & { statusCode?: number };
            parseError.statusCode = 400;
            done(parseError, undefined);
        }
    });

    app.addHook('onResponse', async (request, reply) => {
        await recordAdminAuditLog(request, reply.statusCode);
        await logApiV1Usage(request, reply);
    });

    app.addHook('onRequest', applyApiV1DeprecationHeaders);
    app.addHook('onRequest', blockApiV1WhenDisabled);

    await app.register(apiV2ProxyRoutes, { prefix: apiV2Prefix });

    const uploadsPath = process.env.UPLOAD_DIR || path.join(__dirname, '../uploads');
    await app.register(fastifyStatic, {
        root: uploadsPath,
        prefix: '/uploads/',
        decorateReply: false
    });

    const clientDistPath = path.join(__dirname, '../../client/dist');
    await app.register(fastifyStatic, {
        root: clientDistPath,
        prefix: '/',
        decorateReply: true
    });

    app.setNotFoundHandler((request, reply) => {
        const url = request.raw.url || '';
        if (url === '/v1' || url.startsWith('/v1/') || url.startsWith('/api/')) {
            return reply.status(404).send({ message: 'API route not found' });
        }
        return reply.sendFile('index.html');
    });

    return app;
}