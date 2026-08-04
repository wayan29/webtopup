import { FastifyReply, FastifyRequest } from 'fastify';

export const legacyRewardsPointsWriteGate = async (_request: FastifyRequest, reply: FastifyReply) => {
    if (process.env.LEGACY_REWARDS_POINTS_WRITES_DISABLED !== 'true') {
        return;
    }

    return reply.status(410).send({
        success: false,
        message: 'Endpoint rewards/points v1 sudah dinonaktifkan. Gunakan API v2.'
    });
};

export const legacyRewardsPointsReadGate = async (_request: FastifyRequest, reply: FastifyReply) => {
    if (process.env.LEGACY_REWARDS_POINTS_READS_DISABLED !== 'true') {
        return;
    }

    return reply.status(410).send({
        success: false,
        message: 'Endpoint rewards/points v1 sudah dinonaktifkan. Gunakan API v2.'
    });
};
