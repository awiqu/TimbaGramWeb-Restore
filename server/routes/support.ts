import { createTicketSchema, ticketMessageSchema } from '@timba/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isAdmin, rateLimit, requireAdmin, requireAuth } from '../auth.js';
import { pendingTopups } from '../bank/bank.js';
import {
  adminMarkTicketRead,
  adminOpenTicket,
  adminTicketBadge,
  adminTickets,
  callOperator,
  closeTicket,
  createTicket,
  deleteTicket,
  listTickets,
  openTicket,
  operatorReply,
  userReply,
} from '../services/tickets.js';
import { intParam, parse } from '../util.js';

type IdParams = { Params: { id: string } };

/** Support tickets: the user's side and the operator's (admin) side. */
export default async function supportRoutes(app: FastifyInstance) {
  app.get('/api/support/tickets', { preHandler: requireAuth }, async (req) => listTickets(req.auth.user));

  /** Counters for the badges on "Профиль": answers in own tickets, and for the admin what waits for them. */
  app.get('/api/support/badge', { preHandler: requireAuth }, async (req) => {
    const unread = listTickets(req.auth.user).reduce((n, x) => n + x.unread, 0);
    if (!isAdmin(req.auth.user)) return { unread, admin: 0, adminSupport: 0, adminTopups: 0 };
    // the panel shows both parts on their own sections
    const adminSupport = adminTicketBadge();
    const adminTopups = pendingTopups().length;
    return { unread, admin: adminSupport + adminTopups, adminSupport, adminTopups };
  });

  app.post('/api/support/tickets', { preHandler: requireAuth }, async (req) => {
    rateLimit(`ticket:${req.auth.user.id}`, 10, 60 * 60_000);
    const { type, text } = parse(createTicketSchema, req.body);
    return createTicket(req.auth.user, type, text);
  });

  app.get<IdParams>('/api/support/tickets/:id', { preHandler: requireAuth }, async (req) => openTicket(req.auth.user, intParam(req.params.id)));

  app.post<IdParams>('/api/support/tickets/:id/messages', { preHandler: requireAuth }, async (req) => {
    rateLimit(`ticket-msg:${req.auth.user.id}`, 30, 60_000);
    return userReply(req.auth.user, intParam(req.params.id), parse(ticketMessageSchema, req.body).text);
  });

  app.post<IdParams>('/api/support/tickets/:id/operator', { preHandler: requireAuth }, async (req) =>
    callOperator(req.auth.user, intParam(req.params.id)),
  );

  app.post<IdParams>('/api/support/tickets/:id/close', { preHandler: requireAuth }, async (req) =>
    closeTicket(req.auth.user, intParam(req.params.id)),
  );

  // ---------- operator ----------
  app.get<{ Querystring: { status?: string } }>('/api/admin/support/tickets', { preHandler: requireAdmin }, async (req) => {
    const status = z.enum(['active', 'closed', 'all']).catch('active').parse(req.query.status);
    return { tickets: adminTickets(status), badge: adminTicketBadge() };
  });

  app.get<IdParams>('/api/admin/support/tickets/:id', { preHandler: requireAdmin }, async (req) => adminOpenTicket(intParam(req.params.id)));

  /** The ticket is open on the operator's screen: what came into it meanwhile is read. */
  app.post<IdParams>('/api/admin/support/tickets/:id/read', { preHandler: requireAdmin }, async (req) => {
    adminMarkTicketRead(intParam(req.params.id));
    return { ok: true };
  });

  app.post<IdParams>('/api/admin/support/tickets/:id/messages', { preHandler: requireAdmin }, async (req) =>
    operatorReply(req.auth.user, intParam(req.params.id), parse(ticketMessageSchema, req.body).text),
  );

  app.post<IdParams>('/api/admin/support/tickets/:id/close', { preHandler: requireAdmin }, async (req) =>
    closeTicket(req.auth.user, intParam(req.params.id), true),
  );

  app.delete<IdParams>('/api/admin/support/tickets/:id', { preHandler: requireAdmin }, async (req) => {
    deleteTicket(intParam(req.params.id));
    return { ok: true };
  });
}
