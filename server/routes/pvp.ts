import { pvpCreateSchema, pvpMoveSchema } from '@timba/shared';
import type { FastifyInstance } from 'fastify';
import { rateLimit, requireAuth } from '../auth.js';
import { acceptMatch, createMatch, declineMatch, getMatch, listMatches, makeMove, surrender } from '../bank/pvp.js';
import { parse } from '../util.js';

/** Multiplayer games on ТК: the duel and the dice. */
export default async function pvpRoutes(app: FastifyInstance) {
  app.get('/api/pvp', { preHandler: requireAuth }, async (req) => listMatches(req.auth.user));

  app.get<{ Params: { id: string } }>('/api/pvp/:id', { preHandler: requireAuth }, async (req) =>
    getMatch(req.auth.user, Number(req.params.id)),
  );

  app.post('/api/pvp', { preHandler: requireAuth }, async (req) => {
    rateLimit(`pvp-invite:${req.auth.user.id}`, 20, 10 * 60_000);
    const { game, userId, stake } = parse(pvpCreateSchema, req.body);
    return createMatch(req.auth.user, game, userId, stake);
  });

  app.post<{ Params: { id: string } }>('/api/pvp/:id/accept', { preHandler: requireAuth }, async (req) =>
    acceptMatch(req.auth.user, Number(req.params.id)),
  );

  app.post<{ Params: { id: string } }>('/api/pvp/:id/decline', { preHandler: requireAuth }, async (req) =>
    declineMatch(req.auth.user, Number(req.params.id)),
  );

  app.post<{ Params: { id: string } }>('/api/pvp/:id/move', { preHandler: requireAuth }, async (req) => {
    rateLimit(`pvp-move:${req.auth.user.id}`, 120, 60_000);
    const { action, value } = parse(pvpMoveSchema, req.body);
    return makeMove(req.auth.user, Number(req.params.id), action, value);
  });

  app.post<{ Params: { id: string } }>('/api/pvp/:id/surrender', { preHandler: requireAuth }, async (req) =>
    surrender(req.auth.user, Number(req.params.id)),
  );
}
