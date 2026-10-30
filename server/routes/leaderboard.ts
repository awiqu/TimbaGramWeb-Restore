import { gameSavesSchema, gameScoreSchema } from '@timba/shared';
import type { FastifyInstance } from 'fastify';
import { rateLimit, requireAuth } from '../auth.js';
import { now } from '../db.js';
import { forbidden } from '../errors.js';
import { clickerBackups, restoreClickerBackup, syncSaves } from '../gameSaves.js';
import { leaderboard, submitScore } from '../leaderboard.js';
import { isPremium } from '../serialize.js';
import { txt } from '../strings.js';
import { parse } from '../util.js';

/** Game progress per account and the monthly top 5 of the mini-games. Everyone can look; only Премиум players, who can play, send results. */
export default async function leaderboardRoutes(app: FastifyInstance) {
  app.get<{ Params: { game: string } }>('/api/games/:game/leaderboard', { preHandler: requireAuth }, async (req) =>
    leaderboard(req.params.game, req.auth.user),
  );

  app.post('/api/games/score', { preHandler: requireAuth }, async (req) => {
    rateLimit(`game-score:${req.auth.user.id}`, 60, 60_000);
    if (!isPremium(req.auth.user)) throw forbidden(txt.leaderboard.premiumOnly, 'premium_required');
    const { game, score } = parse(gameScoreSchema, req.body);
    submitScore(req.auth.user.id, game, score);
    return { ok: true };
  });

  // a device sends what it has and gets back the best of everything; also the way to just fetch (send {}).
  // `at` is when this answer was made: the device keeps it and sends it back as `since`, so that something an admin
  // set later is told from progress the device has already seen (the moment is taken before the saves are read)
  app.post('/api/games/saves/sync', { preHandler: requireAuth }, async (req) => {
    rateLimit(`game-saves:${req.auth.user.id}`, 60, 60_000);
    const at = now();
    const body = parse(gameSavesSchema, req.body);
    return { saves: syncSaves(req.auth.user.id, body.saves, body.since), at };
  });

  // earlier saves of the clicker: take back a progress that a reset or a bad save has lost
  app.get('/api/games/clicker/backups', { preHandler: requireAuth }, async (req) => clickerBackups(req.auth.user.id));
  app.post<{ Params: { id: string } }>('/api/games/clicker/backups/:id/restore', { preHandler: requireAuth }, async (req) => {
    rateLimit(`game-restore:${req.auth.user.id}`, 10, 60_000);
    return { saves: restoreClickerBackup(req.auth.user.id, Number(req.params.id) || 0) };
  });
}
