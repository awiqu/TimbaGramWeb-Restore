import type { TicketDTO, TicketDetailDTO, TicketMessageDTO, TicketStatus, TicketType } from '@timba/shared';
import { ADMIN_USERNAME, EV } from '@timba/shared';
import { db, now } from '../db.js';
import { forbidden, notFound } from '../errors.js';
import { askGigaChat, gigachatAvailable, type ChatMessage } from '../gigachat.js';
import { notifyUser } from '../push.js';
import { isUserActive, toUser } from '../realtime.js';
import { type UserRow, displayName, getUserByUsername, getUserRow, userDTO } from '../serialize.js';
import { getSettings } from '../settings.js';
import { txt } from '../strings.js';
import { notify } from '../notifications.js';

/**
 * Support tickets. The user describes the problem and picks its type; the support team's
 * automatic answers (GigaChat with the guide from supportGuide.ts) come at once. "Позвать
 * оператора" hands the ticket to the admin: support stops answering and the admin replies from
 * the admin panel.
 */

interface TicketRow {
  id: number;
  user_id: number;
  type: TicketType;
  subject: string;
  status: TicketStatus;
  operator_requested_at: number | null;
  user_unread: number;
  admin_unread: number;
  created_at: number;
  updated_at: number;
}

interface TicketMessageRow {
  id: number;
  ticket_id: number;
  author: TicketMessageDTO['author'];
  author_id: number | null;
  text: string;
  created_at: number;
}

const getTicket = (id: number) => db.prepare('SELECT * FROM support_tickets WHERE id = ?').get(id) as TicketRow | undefined;
const admin = () => getUserByUsername(ADMIN_USERNAME);

const messageDTO = (r: TicketMessageRow): TicketMessageDTO => ({
  id: r.id,
  ticketId: r.ticket_id,
  author: r.author,
  text: r.text,
  createdAt: r.created_at,
});

/** tickets whose answer is being written */
const typing = new Set<number>();

function ticketDTO(r: TicketRow, forAdmin: boolean): TicketDTO {
  const last = db.prepare('SELECT * FROM support_ticket_messages WHERE ticket_id = ? ORDER BY id DESC LIMIT 1').get(r.id) as
    | TicketMessageRow
    | undefined;
  const owner = forAdmin ? getUserRow(r.user_id) : undefined;
  return {
    id: r.id,
    type: r.type,
    subject: r.subject,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    unread: forAdmin ? r.admin_unread : r.user_unread,
    lastMessage: last ? messageDTO(last) : null,
    ...(owner ? { user: userDTO(owner, { self: true }) } : {}),
    typing: typing.has(r.id),
  };
}

function detail(r: TicketRow, forAdmin: boolean): TicketDetailDTO {
  const rows = db.prepare('SELECT * FROM support_ticket_messages WHERE ticket_id = ? ORDER BY id').all(r.id) as TicketMessageRow[];
  return { ...ticketDTO(r, forAdmin), messages: rows.map(messageDTO) };
}

/** The owner and the admin see the change live (the new message, the status, "печатает…"). */
function publish(ticketId: number, message?: TicketMessageRow) {
  const r = getTicket(ticketId);
  if (!r) return;
  const m = message ? messageDTO(message) : undefined;
  toUser(r.user_id, EV.supportTicket, { ticket: ticketDTO(r, false), message: m });
  const a = admin();
  if (a && a.id !== r.user_id) toUser(a.id, EV.supportTicket, { ticket: ticketDTO(r, true), message: m, admin: true });
}

function addMessage(ticketId: number, author: TicketMessageDTO['author'], authorId: number | null, text: string) {
  const t = now();
  const res = db
    .prepare('INSERT INTO support_ticket_messages (ticket_id, author, author_id, text, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(ticketId, author, authorId, text, t);
  // the other side gets an unread mark
  const col = author === 'user' ? 'admin_unread' : author === 'system' ? null : 'user_unread';
  db.prepare(`UPDATE support_tickets SET updated_at = ?${col ? `, ${col} = ${col} + 1` : ''} WHERE id = ?`).run(t, ticketId);
  const row = db.prepare('SELECT * FROM support_ticket_messages WHERE id = ?').get(res.lastInsertRowid) as TicketMessageRow;
  publish(ticketId, row);
  // a new message for the operator while the admin's app is closed
  const ticket = getTicket(ticketId);
  const a = author === 'user' && ticket?.status === 'operator' ? admin() : undefined;
  if (a && ticket && a.id !== ticket.user_id && !isUserActive(a.id)) {
    notifyUser(a.id, {
      title: txt.tickets.pushAdmin(ticket.id),
      body: text.length > 180 ? `${text.slice(0, 177)}…` : text,
      chatId: 0,
      url: `/support/${ticket.id}`,
      tag: `ticket-admin-${ticket.id}`,
    });
  }
  // an answer while the app is closed or in the background
  const owner = author === 'support' || author === 'operator' ? ticket?.user_id : undefined;
  if (owner && !isUserActive(owner)) {
    notifyUser(owner, {
      title: author === 'operator' ? txt.tickets.pushOperator : txt.tickets.pushSupport,
      body: text.length > 180 ? `${text.slice(0, 177)}…` : text,
      chatId: 0,
      url: `/support/${ticketId}`,
      tag: `ticket-${ticketId}`,
    });
  }
  return row;
}

function setStatus(ticketId: number, status: TicketStatus) {
  db.prepare('UPDATE support_tickets SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), ticketId);
}

function own(user: UserRow, id: number): TicketRow {
  const r = getTicket(id);
  if (!r) throw notFound(txt.tickets.notFound);
  if (r.user_id !== user.id) throw forbidden();
  return r;
}

// ---------- the user ----------

export function listTickets(user: UserRow): TicketDTO[] {
  const rows = db.prepare('SELECT * FROM support_tickets WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100').all(user.id) as TicketRow[];
  return rows.map((r) => ticketDTO(r, false));
}

export function openTicket(user: UserRow, id: number): TicketDetailDTO {
  const r = own(user, id);
  if (r.user_unread) db.prepare('UPDATE support_tickets SET user_unread = 0 WHERE id = ?').run(r.id);
  return detail(getTicket(r.id)!, false);
}

export function createTicket(user: UserRow, type: TicketType, text: string): TicketDetailDTO {
  const firstLine = text.split('\n').find((l) => l.trim())?.trim() ?? text;
  const subject = firstLine.length > 80 ? `${firstLine.slice(0, 77).trimEnd()}…` : firstLine;
  const t = now();
  const res = db
    .prepare('INSERT INTO support_tickets (user_id, type, subject, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(user.id, type, subject, t, t);
  const id = Number(res.lastInsertRowid);
  addMessage(id, 'user', user.id, text);
  const bot = getSettings().supportBot;
  if (!bot) {
    // automatic answers are off: straight to the operator
    db.prepare("UPDATE support_tickets SET status = 'operator', operator_requested_at = ? WHERE id = ?").run(now(), id);
    addMessage(id, 'system', null, txt.tickets.operatorAuto);
  }
  // the admin hears about every new ticket in the support notifications (with a push)
  const a = admin();
  if (a && a.id !== user.id) {
    notify('support', a.id, txt.tickets.adminNewTicket(id, txt.tickets.types[type], displayName(user), user.username, subject, !bot), null, `/support/${id}`);
  }
  if (bot) scheduleAnswer(id);
  return detail(getTicket(id)!, false);
}

/** The admin removes a ticket with its messages; both sides' lists drop it. */
export function deleteTicket(id: number) {
  const r = getTicket(id);
  if (!r) throw notFound(txt.tickets.notFound);
  db.prepare('DELETE FROM support_tickets WHERE id = ?').run(id);
  toUser(r.user_id, EV.supportTicket, { deleted: id });
  const a = admin();
  if (a && a.id !== r.user_id) toUser(a.id, EV.supportTicket, { deleted: id, admin: true });
}

export function userReply(user: UserRow, id: number, text: string): TicketMessageDTO {
  const r = own(user, id);
  if (r.status === 'closed') {
    setStatus(r.id, 'open');
    addMessage(r.id, 'system', null, txt.tickets.reopened);
  }
  // the user writes after the operator's answer, or support is off: a person has to look at it again
  const current = getTicket(r.id)!.status;
  if (current === 'answered' || (current === 'open' && !getSettings().supportBot)) setStatus(r.id, 'operator');
  const row = addMessage(r.id, 'user', user.id, text);
  if (getTicket(r.id)!.status === 'open') scheduleAnswer(r.id);
  return messageDTO(row);
}

export function callOperator(user: UserRow, id: number): TicketDTO {
  const r = own(user, id);
  if (r.status === 'operator') return ticketDTO(r, false);
  // (an answered ticket goes back to the operator the same way)
  db.prepare("UPDATE support_tickets SET status = 'operator', operator_requested_at = ? WHERE id = ?").run(now(), r.id);
  addMessage(r.id, 'system', null, txt.tickets.operatorCalled);
  // the admin hears about it in the support notifications, with a push
  const a = admin();
  if (a && a.id !== user.id) {
    notify('support', a.id, txt.tickets.adminOperatorCall(r.id, txt.tickets.types[r.type], displayName(user), user.username, r.subject), null, `/support/${r.id}`);
  }
  return ticketDTO(getTicket(r.id)!, false);
}

export function closeTicket(user: UserRow, id: number, byAdmin = false): TicketDTO {
  const r = byAdmin ? getTicket(id) : own(user, id);
  if (!r) throw notFound(txt.tickets.notFound);
  if (r.status !== 'closed') {
    setStatus(r.id, 'closed');
    addMessage(r.id, 'system', null, byAdmin ? txt.tickets.closedByOperator : txt.tickets.closed);
  }
  return ticketDTO(getTicket(r.id)!, byAdmin);
}

// ---------- the admin ----------

export function adminTickets(status: 'active' | 'closed' | 'all'): TicketDTO[] {
  const where = status === 'active' ? "WHERE status != 'closed'" : status === 'closed' ? "WHERE status = 'closed'" : '';
  const rows = db
    .prepare(
      // tickets waiting for a person first
      `SELECT * FROM support_tickets ${where} ORDER BY CASE status WHEN 'operator' THEN 0 WHEN 'open' THEN 1 WHEN 'answered' THEN 2 ELSE 3 END, updated_at DESC LIMIT 200`,
    )
    .all() as TicketRow[];
  return rows.map((r) => ticketDTO(r, true));
}

export function adminOpenTicket(id: number): TicketDetailDTO {
  const r = getTicket(id);
  if (!r) throw notFound(txt.tickets.notFound);
  if (r.admin_unread) db.prepare('UPDATE support_tickets SET admin_unread = 0 WHERE id = ?').run(r.id);
  return detail(getTicket(r.id)!, true);
}

export function adminMarkTicketRead(id: number) {
  const r = getTicket(id);
  if (!r) throw notFound(txt.tickets.notFound);
  if (!r.admin_unread) return;
  db.prepare('UPDATE support_tickets SET admin_unread = 0 WHERE id = ?').run(r.id);
  const a = admin();
  if (a) toUser(a.id, EV.supportTicket, { ticket: ticketDTO(getTicket(r.id)!, true), admin: true });
}

/** The admin answers as an operator: support stays quiet, and the ticket is "answered" until the user writes again. */
export function operatorReply(adminUser: UserRow, id: number, text: string): TicketMessageDTO {
  const r = getTicket(id);
  if (!r) throw notFound(txt.tickets.notFound);
  if (r.status !== 'answered') setStatus(r.id, 'answered');
  const row = addMessage(r.id, 'operator', adminUser.id, text);
  db.prepare('UPDATE support_tickets SET admin_unread = 0 WHERE id = ?').run(r.id);
  return messageDTO(row);
}

/** Admin's badge: tickets with new messages or waiting for an operator. */
export function adminTicketBadge(): number {
  return (
    db.prepare("SELECT COUNT(*) n FROM support_tickets WHERE status != 'closed' AND (admin_unread > 0 OR status = 'operator')").get() as {
      n: number;
    }
  ).n;
}

// ---------- the automatic answers ----------

/** ticket id -> a newer message arrived while the answer was being written */
const pending = new Map<number, boolean>();
const inFlight = new Set<Promise<void>>();

function scheduleAnswer(ticketId: number) {
  if (pending.has(ticketId)) {
    pending.set(ticketId, true);
    return;
  }
  pending.set(ticketId, false);
  const run = (async () => {
    try {
      do {
        pending.set(ticketId, false);
        await answer(ticketId);
      } while (pending.get(ticketId));
    } catch {
      /* the ticket or the user is gone */
    } finally {
      pending.delete(ticketId);
      typing.delete(ticketId);
    }
  })();
  inFlight.add(run);
  void run.finally(() => inFlight.delete(run));
}

/** Tests: wait for the answers being written. */
export async function ticketsIdle() {
  while (inFlight.size) await Promise.all([...inFlight]);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function conversation(r: TicketRow, user: UserRow): ChatMessage[] {
  const rows = (
    db.prepare("SELECT * FROM support_ticket_messages WHERE ticket_id = ? AND author != 'system' ORDER BY id DESC LIMIT 20").all(r.id) as TicketMessageRow[]
  ).reverse();
  const system = txt.tickets.prompt(getSettings().appName, displayName(user), txt.tickets.types[r.type]);
  const out: ChatMessage[] = [{ role: 'system', content: system }];
  for (const m of rows) {
    const role = m.author === 'user' ? 'user' : 'assistant';
    const last = out[out.length - 1]!;
    // GigaChat wants user and assistant turns to alternate
    if (last.role === role) last.content += `\n${m.text}`;
    else out.push({ role, content: m.text });
  }
  if (out[1]?.role === 'assistant') out.splice(1, 1);
  return out;
}

async function answer(ticketId: number) {
  const r = getTicket(ticketId);
  const user = r ? getUserRow(r.user_id) : undefined;
  if (!r || !user || r.status !== 'open' || !getSettings().supportBot) return;

  let text: string;
  if (gigachatAvailable()) {
    typing.add(r.id);
    publish(r.id);
    const started = Date.now();
    try {
      text = await askGigaChat(conversation(r, user), 700);
    } catch {
      text = txt.tickets.fallback(r.id);
    }
    // a person needs a moment to type
    await sleep(Math.max(0, 1200 - (Date.now() - started)));
    typing.delete(r.id);
  } else {
    // nobody to answer right now: say it once, not after every message
    const lastSupport = db
      .prepare("SELECT text FROM support_ticket_messages WHERE ticket_id = ? AND author = 'support' ORDER BY id DESC LIMIT 1")
      .get(r.id) as { text: string } | undefined;
    if (lastSupport) return;
    text = txt.tickets.fallback(r.id);
  }
  // the operator took over (or the ticket was closed) while the answer was being written
  if (getTicket(r.id)?.status !== 'open') return publish(r.id);
  addMessage(r.id, 'support', null, text.trim() || txt.tickets.fallback(r.id));
}
