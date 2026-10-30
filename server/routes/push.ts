import { pushSubscriptionSchema } from '@timba/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { deleteSubscription, saveSubscription, vapidKeys } from '../push.js';
import { parse } from '../util.js';

export default async function pushRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/push/key', async () => ({ publicKey: vapidKeys().publicKey }));

  app.post('/api/push/subscribe', async (req) => {
    const sub = parse(pushSubscriptionSchema, req.body);
    // the admin signed in as a user must not steal their notifications
    if (req.auth.session.impersonator_id) return { ok: true };
    saveSubscription(req.auth.user.id, req.auth.session.id, sub);
    return { ok: true };
  });

  app.post('/api/push/unsubscribe', async (req) => {
    const { endpoint } = parse(z.object({ endpoint: z.string().max(1000) }), req.body);
    if (req.auth.session.impersonator_id) return { ok: true };
    deleteSubscription(req.auth.user.id, endpoint);
    return { ok: true };
  });
}
