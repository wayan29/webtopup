import { FastifyReply } from 'fastify';
import { AuthRequest } from './authMiddleware';
import { createPublicRateLimit } from './publicRateLimit';

const userIdValue = (request: AuthRequest) => request.user?.id || 'unknown';

const adminFinancialMutationBase = createPublicRateLimit({
    name: 'admin-financial-mutation',
    windowMs: 60 * 1000,
    max: 20,
    blockMs: 5 * 60 * 1000,
    keyParts: [userIdValue]
});

export const adminFinancialMutationRateLimit = async (request: AuthRequest, reply: FastifyReply) => {
    return adminFinancialMutationBase(request, reply);
};
