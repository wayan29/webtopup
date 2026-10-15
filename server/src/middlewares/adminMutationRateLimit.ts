import { FastifyReply } from 'fastify';
import { AuthRequest } from './authMiddleware';
import { createPublicRateLimit } from './publicRateLimit';

const userIdValue = (request: AuthRequest) => request.user?.id || 'unknown';

// Financial mutations fail closed: when Redis is unavailable the admin financial
// endpoints answer 503 instead of running unthrottled.
const adminFinancialMutationBase = createPublicRateLimit({
    name: 'admin-financial-mutation',
    windowMs: 60 * 1000,
    max: 20,
    blockMs: 5 * 60 * 1000,
    keyParts: [userIdValue],
    failureMode: 'closed'
});

export const adminFinancialMutationRateLimit = async (request: AuthRequest, reply: FastifyReply) => {
    return adminFinancialMutationBase(request, reply);
};
