import { FastifyReply, FastifyRequest } from 'fastify';

export const legacyFinanceWriteGate = async (_request: FastifyRequest, reply: FastifyReply) => {
    if (process.env.LEGACY_FINANCE_WRITES_DISABLED !== 'true') {
        return;
    }

    return reply.status(410).send({
        success: false,
        message: 'Endpoint finance v1 sudah dinonaktifkan. Gunakan API v2.'
    });
};
