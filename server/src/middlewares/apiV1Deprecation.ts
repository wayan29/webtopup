import { FastifyReply, FastifyRequest } from 'fastify';

const DEFAULT_SUNSET_DAYS = 90;

const isApiV1Request = (url: string) => url === '/v1' || url.startsWith('/v1/') || url.startsWith('/v1?');

const sunsetDate = () => {
    const configured = process.env.API_V1_SUNSET_DATE?.trim();
    if (configured) {
        return configured;
    }

    const date = new Date();
    date.setUTCDate(date.getUTCDate() + DEFAULT_SUNSET_DAYS);
    return date.toUTCString();
};

export const blockApiV1WhenDisabled = async (request: FastifyRequest, reply: FastifyReply) => {
    const url = request.raw.url || '';
    if (!isApiV1Request(url) || process.env.API_V1_DISABLED !== 'true') {
        return;
    }

    return reply.status(410).send({
        success: false,
        message: 'API v1 sudah dinonaktifkan. Gunakan /api/v2.'
    });
};

export const applyApiV1DeprecationHeaders = async (request: FastifyRequest, reply: FastifyReply) => {
    const url = request.raw.url || '';
    if (!isApiV1Request(url)) {
        return;
    }

    reply.header('Deprecation', 'true');
    reply.header('Sunset', sunsetDate());
    reply.header('Link', '</api/v2>; rel="successor-version"');
};

export const logApiV1Usage = async (request: FastifyRequest, reply: FastifyReply) => {
    const url = request.raw.url || '';
    if (!isApiV1Request(url)) {
        return;
    }

    request.log.warn(
        {
            method: request.method,
            path: url.split('?')[0],
            statusCode: reply.statusCode,
            userAgent: request.headers['user-agent'] || '',
            ip: request.ip,
        },
        'Deprecated API v1 request observed',
    );
};
