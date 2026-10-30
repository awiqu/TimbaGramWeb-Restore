import type { ScheduledMessageDTO } from '@timba/shared';
import { EV, SCHEDULE_MAX_MS, SCHEDULE_MIN_MS } from '@timba/shared';
import { db, now } from '../db.js';
import { HttpError, badRequest, forbidden, notFound } from '../errors.js';
import { type ChatRow, membership, requireView } from '../permissions.js';
import { toUser } from '../realtime.js';
import { type FileRow, type UserRow, fileDTO, getUserRow } from '../serialize.js';
import { txt } from '../strings.js';
import { encryptText } from '../crypt.js';
import { chatDTO } from './chats.js';
import { assertNotBlocked, loadOwnFiles, sendMessage } from './messages.js';

/** Scheduled messages ("Отправить позже"): kept until their time, then sent as usual. */
interface ScheduledRow {
  id: number;
  chat_id: number;
  user_id: number;
  text: string;
  reply_to_id: number | null;
  file_ids: string;
  silent: number;
  send_at: number;
  created_at: number;
}

function toDTO(rows: ScheduledRow[]): ScheduledMessageDTO[] {
  const ids = [...new Set(rows.flatMap((r) => JSON.parse(r.file_ids) as string[]))];
  const files = new Map(
    ids.length
      ? (db.prepare(`SELECT * FROM files WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as FileRow[]).map((f) => [f.id, f])
      : [],
  );
  return rows.map((r) => ({
    id: r.id,
    chatId: r.chat_id,
    text: r.text,
    replyToId: r.reply_to_id,
    attachments: (JSON.parse(r.file_ids) as string[]).filter((id) => files.has(id)).map((id) => fileDTO(files.get(id)!)),
    silent: !!r.silent,
    sendAt: r.send_at,
    createdAt: r.created_at,
  }));
}

/** The chat list shows how many messages wait in each chat. */
function chatChanged(chat: ChatRow, user: UserRow) {
  toUser(user.id, EV.chatUpdate, chatDTO(chat, user));
}

export function scheduleMessage(
  chatId: number,
  user: UserRow,
  input: { text: string; replyToId?: number | null; fileIds: string[]; silent?: boolean; sendAt: number; threadId?: number | null },
): ScheduledMessageDTO {
  const chat = requireView(chatId, user);
  if (input.threadId) throw badRequest(txt.errors.scheduledThread);
  const t = now();
  if (input.sendAt < t + SCHEDULE_MIN_MS || input.sendAt > t + SCHEDULE_MAX_MS) throw badRequest(txt.errors.scheduleTime);
  const me = membership(chat, user);
  if (!me.canSend) throw forbidden(txt.errors.cannotWrite);
  if (input.fileIds.length && !me.canSendMedia) throw forbidden(txt.errors.mediaForbidden);
  assertNotBlocked(chat, user);
  loadOwnFiles(input.fileIds, user);
  const res = db
    .prepare(
      `INSERT INTO scheduled_messages (chat_id, user_id, text, reply_to_id, file_ids, silent, send_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(chat.id, user.id, encryptText(input.text.trim()), input.replyToId ?? null, JSON.stringify(input.fileIds), input.silent ? 1 : 0, input.sendAt, t);
  chatChanged(chat, user);
  return toDTO([db.prepare('SELECT * FROM scheduled_messages WHERE id = ?').get(res.lastInsertRowid) as ScheduledRow])[0]!;
}

export function listScheduled(chatId: number, user: UserRow): ScheduledMessageDTO[] {
  requireView(chatId, user);
  return toDTO(
    db.prepare('SELECT * FROM scheduled_messages WHERE chat_id = ? AND user_id = ? ORDER BY send_at').all(chatId, user.id) as ScheduledRow[],
  );
}

function requireOwn(id: number, user: UserRow): ScheduledRow {
  const r = db.prepare('SELECT * FROM scheduled_messages WHERE id = ? AND user_id = ?').get(id, user.id) as ScheduledRow | undefined;
  if (!r) throw notFound(txt.errors.scheduledNotFound);
  return r;
}

export function deleteScheduled(id: number, user: UserRow) {
  const r = requireOwn(id, user);
  db.prepare('DELETE FROM scheduled_messages WHERE id = ?').run(r.id);
  chatChanged(requireView(r.chat_id, user), user);
}

/** `keepOnFail`: a manual "send now" that is refused (slow mode, blocked…) leaves the message waiting. */
function deliver(r: ScheduledRow, user: UserRow, keepOnFail = false) {
  if (!keepOnFail) db.prepare('DELETE FROM scheduled_messages WHERE id = ?').run(r.id);
  try {
    const sent = sendMessage(r.chat_id, user, {
      text: r.text,
      replyToId: r.reply_to_id,
      fileIds: JSON.parse(r.file_ids) as string[],
      silent: !!r.silent,
    });
    if (keepOnFail) db.prepare('DELETE FROM scheduled_messages WHERE id = ?').run(r.id);
    return sent;
  } finally {
    const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(r.chat_id) as ChatRow | undefined;
    if (chat) chatChanged(chat, user);
  }
}

/** "Отправить сейчас". */
export function sendScheduledNow(id: number, user: UserRow) {
  return deliver(requireOwn(id, user), user, true);
}

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Every few seconds: send what is due, in the order it was scheduled (a long text and an album of single photos
 * are several messages with the same time). Slow mode makes a message wait for its turn; one that can no longer
 * be sent (no rights any more, blocked…) is dropped.
 */
export function sendDueScheduled() {
  const due = db.prepare('SELECT * FROM scheduled_messages WHERE send_at <= ? ORDER BY send_at, id LIMIT 100').all(now()) as ScheduledRow[];
  for (const r of due) {
    const user = getUserRow(r.user_id);
    if (!user) {
      db.prepare('DELETE FROM scheduled_messages WHERE id = ?').run(r.id);
      continue;
    }
    try {
      deliver(r, user);
    } catch (e) {
      const until = e instanceof HttpError && e.code === 'slow_mode' ? Number(e.extra.until) : 0;
      if (until) {
        // back in the queue for the moment slow mode lets it through
        db.prepare(
          `INSERT INTO scheduled_messages (id, chat_id, user_id, text, reply_to_id, file_ids, silent, send_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(r.id, r.chat_id, r.user_id, encryptText(r.text), r.reply_to_id, r.file_ids, r.silent, until, r.created_at);
      }
    }
  }
}

export function startScheduledTimer() {
  if (timer) return;
  timer = setInterval(() => {
    try {
      sendDueScheduled();
    } catch {
      /* db closed during shutdown */
    }
  }, 5000);
  timer.unref();
}
