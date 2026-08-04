import { FastifyInstance } from 'fastify';
import { getLeaderboard } from '../controllers/leaderboardController';

export default async function leaderboardRoutes(fastify: FastifyInstance) {
    fastify.get('/', getLeaderboard);
}
