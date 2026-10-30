import { createCallLinkSchema, type CallLinkDTO } from '@timba/shared';
import type { FastifyInstance } from 'fastify';
import { rateLimit, requireAuth } from '../auth.js';
import { HttpError } from '../errors.js';
import { createLinkCall, linkCall, linkCallCount } from '../groupCalls.js';
import { getUserRow, userDTOFor } from '../serialize.js';
import { callHistory, clearCallHistory } from '../services/callLog.js';
import { txt } from '../strings.js';
import { parse } from '../util.js';

function linkDTO(token: string, viewerId: number): CallLinkDTO {
  const link = linkCall(token);
  if (!link) throw new HttpError(404, 'not_found', txt.errors.callLinkInvalid);
  const creator = link.creator_id ? getUserRow(link.creator_id) : undefined;
  return {
    token: link.token,
    title: link.title,
    url: `/call/${link.token}`,
    creator: creator ? userDTOFor(creator, viewerId) : null,
    count: linkCallCount(link.token),
  };
}

/** Group calls by link: anybody signed in who has the link can join. */
export default async function callRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.post('/api/call-links', async (req) => {
    rateLimit(`call-link:${req.auth.user.id}`, 20, 3600_000);
    const { title } = parse(createCallLinkSchema, req.body ?? {});
    const link = createLinkCall(req.auth.user.id, title || txt.labels.callLinkTitle);
    return linkDTO(link.token, req.auth.user.id);
  });

  app.get<{ Querystring: { missed?: string } }>('/api/calls', async (req) => callHistory(req.auth.user.id, req.query.missed === '1'));

  app.delete('/api/calls', async (req) => {
    clearCallHistory(req.auth.user.id);
    return { ok: true };
  });

  app.get<{ Params: { token: string } }>('/api/call-links/:token', async (req) => linkDTO(req.params.token, req.auth.user.id));
}
