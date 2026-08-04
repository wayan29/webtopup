import { FastifyInstance } from 'fastify';
import { validateFreeFire, validateMobileLegends, validateOperator } from '../controllers/validateController';

export default async function validateRoutes(fastify: FastifyInstance) {
    fastify.post('/freefire', validateFreeFire);
    fastify.post('/mobilelegends', validateMobileLegends);
    fastify.post('/operator', validateOperator);
}
