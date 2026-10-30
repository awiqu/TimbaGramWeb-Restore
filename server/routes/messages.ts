import {
  createPollSchema,
  deleteMessagesSchema,
  editMessageSchema,
  forwardSchema,
  reactionSchema,
  sendMessageSchema,
  votePollSchema,
} from '@timba/shared';
import type { FastifyInstance } from 'fastify';
import { rateLimit, requireAuth } from '../auth.js';
import { requireView } from '../permissions.js';
import {
  deleteMessages,
  editMessage,
  forwardMessages,
  listMessages,
  getMessage,
  messageReaders,
  requirePost,
  searchMessages,
  sendMessage,
} from '../services/messages.js';
import { createPoll, pollVoters, stopPoll, votePoll } from '../services/polls.js';
import { deleteScheduled, listScheduled, scheduleMessage, sendScheduledNow } from '../services/scheduled.js';
import { badRequest } from '../errors.js';
import { txt } from '../strings.js';
import { listReactors, setReaction } from '../services/reactions.js';
import { intParam, optInt, parse } from '../util.js';

type IdParams = { Params: { id: string } };

export default async function messageRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get<{
    Params: { id: string };
    Querystring: { before?: string; after?: string; around?: string; date?: string; limit?: string };
  }>('/api/chats/:id/messages', async (req) => {
    const chat = requireView(intParam(req.params.id), req.auth.user);
    return listMessages(chat.id, req.auth.user, {
      before: optInt(req.query.before),
      after: optInt(req.query.after),
      around: optInt(req.query.around),
      date: optInt(req.query.date),
      limit: optInt(req.query.limit),
    });
  });

  app.get<{
    Params: { id: string; postId: string };
    Querystring: { before?: string; after?: string; around?: string; limit?: string };
  }>('/api/chats/:id/threads/:postId', async (req) => {
    const chat = requireView(intParam(req.params.id), req.auth.user);
    const post = requirePost(chat, intParam(req.params.postId));
    return listMessages(chat.id, req.auth.user, {
      threadId: post.id,
      before: optInt(req.query.before),
      after: optInt(req.query.after),
      around: optInt(req.query.around),
      limit: optInt(req.query.limit),
    });
  });

  app.get<IdParams>('/api/messages/:id', async (req) => getMessage(intParam(req.params.id), req.auth.user));

  app.get<{ Params: { id: string }; Querystring: { q?: string; before?: string; from?: string } }>(
    '/api/chats/:id/search',
    async (req) =>
      searchMessages(req.auth.user, String(req.query.q ?? ''), {
        chatId: intParam(req.params.id),
        before: optInt(req.query.before),
        fromId: optInt(req.query.from),
      }),
  );

  app.get<{ Querystring: { q?: string; before?: string } }>('/api/search/messages', async (req) =>
    searchMessages(req.auth.user, String(req.query.q ?? ''), { before: optInt(req.query.before) }),
  );

  app.post<IdParams>('/api/chats/:id/messages', async (req) => {
    rateLimit(`send:${req.auth.user.id}`, 60, 10_000);
    const body = parse(sendMessageSchema, req.body);
    return sendMessage(intParam(req.params.id), req.auth.user, body);
  });

  app.get<IdParams>('/api/chats/:id/scheduled', async (req) => listScheduled(intParam(req.params.id), req.auth.user));

  app.post<IdParams>('/api/chats/:id/scheduled', async (req) => {
    const body = parse(sendMessageSchema, req.body);
    if (!body.sendAt) throw badRequest(txt.errors.scheduleTime);
    if (body.stickerId) throw badRequest(txt.stickers.noSchedule);
    return scheduleMessage(intParam(req.params.id), req.auth.user, { ...body, sendAt: body.sendAt });
  });

  app.post<IdParams>('/api/scheduled/:id/send', async (req) => sendScheduledNow(intParam(req.params.id), req.auth.user));

  app.delete<IdParams>('/api/scheduled/:id', async (req) => {
    deleteScheduled(intParam(req.params.id), req.auth.user);
    return { ok: true };
  });

  app.post<IdParams>('/api/chats/:id/polls', async (req) => {
    const body = parse(createPollSchema, req.body);
    return createPoll(intParam(req.params.id), req.auth.user, body);
  });

  app.post<IdParams>('/api/messages/:id/vote', async (req) => {
    const { options } = parse(votePollSchema, req.body);
    return votePoll(intParam(req.params.id), req.auth.user, options);
  });

  app.post<IdParams>('/api/messages/:id/poll/stop', async (req) => stopPoll(intParam(req.params.id), req.auth.user));

  app.get<IdParams>('/api/messages/:id/poll/voters', async (req) => pollVoters(intParam(req.params.id), req.auth.user));

  app.post<IdParams>('/api/messages/:id/reaction', async (req) => {
    const { emoji } = parse(reactionSchema, req.body);
    return setReaction(intParam(req.params.id), req.auth.user, emoji);
  });

  app.delete<IdParams>('/api/messages/:id/reaction', async (req) => setReaction(intParam(req.params.id), req.auth.user, null));

  app.get<IdParams>('/api/messages/:id/readers', async (req) => messageReaders(intParam(req.params.id), req.auth.user));

  app.get<IdParams>('/api/messages/:id/reactions', async (req) => listReactors(intParam(req.params.id), req.auth.user));

  app.patch<IdParams>('/api/messages/:id', async (req) => {
    const { text } = parse(editMessageSchema, req.body);
    return editMessage(intParam(req.params.id), req.auth.user, text);
  });

  app.post('/api/messages/delete', async (req) => {
    const { ids, forAll } = parse(deleteMessagesSchema, req.body);
    deleteMessages(ids, req.auth.user, forAll);
    return { ok: true };
  });

  app.post('/api/messages/forward', async (req) => {
    const { ids, fromChatId, toChatId, hideSender } = parse(forwardSchema, req.body);
    return forwardMessages(ids, fromChatId, toChatId, req.auth.user, hideSender);
  });
}
