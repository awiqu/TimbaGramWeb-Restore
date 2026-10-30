import {
  chatTransferSchema,
  checklistAddSchema,
  createChecklistSchema,
  createFundSchema,
  fundContributeSchema,
  remindSchema,
} from '@timba/shared';
import type { FastifyInstance } from 'fastify';
import { rateLimit, requireAuth } from '../auth.js';
import {
  addChecklistItem,
  closeFund,
  contributeToFund,
  createChecklist,
  createFund,
  sendChatTransfer,
  toggleChecklistItem,
} from '../services/cards.js';
import { createReminder } from '../services/reminders.js';
import { transcribe } from '../services/transcribe.js';
import { intParam, parse } from '../util.js';

type IdParams = { Params: { id: string } };

/** ТК in chats, fundraisers, checklists, reminders and voice transcripts. */
export default async function cardRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.post<IdParams>('/api/chats/:id/send-coins', async (req) =>
    sendChatTransfer(intParam(req.params.id), req.auth.user, parse(chatTransferSchema, req.body)),
  );

  app.post<IdParams>('/api/chats/:id/funds', async (req) => createFund(intParam(req.params.id), req.auth.user, parse(createFundSchema, req.body)));

  app.post<IdParams>('/api/funds/:id/contribute', async (req) =>
    contributeToFund(intParam(req.params.id), req.auth.user, parse(fundContributeSchema, req.body).amount),
  );

  app.post<IdParams>('/api/funds/:id/close', async (req) => closeFund(intParam(req.params.id), req.auth.user));

  app.post<IdParams>('/api/chats/:id/checklists', async (req) =>
    createChecklist(intParam(req.params.id), req.auth.user, parse(createChecklistSchema, req.body)),
  );

  app.post<{ Params: { id: string; itemId: string } }>('/api/checklists/:id/items/:itemId/toggle', async (req) =>
    toggleChecklistItem(intParam(req.params.id), intParam(req.params.itemId), req.auth.user),
  );

  app.post<IdParams>('/api/checklists/:id/items', async (req) =>
    addChecklistItem(intParam(req.params.id), req.auth.user, parse(checklistAddSchema, req.body).text),
  );

  app.post<IdParams>('/api/messages/:id/remind', async (req) =>
    createReminder(intParam(req.params.id), req.auth.user, parse(remindSchema, req.body).at),
  );

  app.post<IdParams>('/api/files/:id/transcribe', async (req) => {
    rateLimit(`transcribe:${req.auth.user.id}`, 30, 60 * 60_000);
    return transcribe(req.params.id, req.auth.user);
  });
}
