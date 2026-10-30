import type { NotificationKind } from '@timba/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { listNotifications, markNotificationsRead, unreadCounts } from '../notifications.js';
import { parse } from '../util.js';

const kindSchema = z.enum(['bank', 'support']);

/** The bank and support notifications: the list, the unread counters, "seen". */
export default async function notificationRoutes(app: FastifyInstance) {
  app.get('/api/notifications/unread', { preHandler: requireAuth }, async (req) => unreadCounts(req.auth.user.id));

  app.get<{ Params: { kind: string } }>('/api/notifications/:kind', { preHandler: requireAuth }, async (req) =>
    listNotifications(req.auth.user.id, parse(kindSchema, req.params.kind) as NotificationKind),
  );

  app.post<{ Params: { kind: string } }>('/api/notifications/:kind/read', { preHandler: requireAuth }, async (req) =>
    markNotificationsRead(req.auth.user.id, parse(kindSchema, req.params.kind) as NotificationKind),
  );
}
