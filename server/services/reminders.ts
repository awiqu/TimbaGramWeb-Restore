import { SCHEDULE_MAX_MS, SCHEDULE_MIN_MS, stripFormatting } from '@timba/shared';
import { db, now } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { getChat, requireView } from '../permissions.js';
import { notifyUser } from '../push.js';
import { type UserRow, getMessageRow, getUserRow, messageDTO } from '../serialize.js';
import { txt } from '../strings.js';
import { broadcastChat, getOrCreatePrivate } from './chats.js';
import { forwardMessages, insertMessage, publishMessage } from './messages.js';

/** "Напомнить мне": at the chosen time the message comes back in the user's saved messages. */
interface ReminderRow {
  id: number;
  user_id: number;
  message_id: number | null;
  chat_id: number | null;
  snapshot: string;
  remind_at: number;
}

export function createReminder(messageId: number, user: UserRow, at: number) {
  const m = getMessageRow(messageId);
  if (!m || m.kind === 'service') throw notFound(txt.errors.messageNotFound);
  requireView(m.chat_id, user);
  const t = now();
  if (at < t + SCHEDULE_MIN_MS || at > t + SCHEDULE_MAX_MS) throw badRequest(txt.errors.reminderTime);
  const dto = messageDTO(m, user.id);
  const snapshot = (dto.text || (dto.attachments.length ? txt.labels.media : '')).slice(0, 500);
  const res = db
    .prepare('INSERT INTO reminders (user_id, message_id, chat_id, snapshot, remind_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(user.id, m.id, m.chat_id, snapshot, at, t);
  return { id: Number(res.lastInsertRowid), remindAt: at };
}

function deliver(r: ReminderRow) {
  db.prepare('DELETE FROM reminders WHERE id = ?').run(r.id);
  const user = getUserRow(r.user_id);
  if (!user) return;
  const saved = getOrCreatePrivate(user, user);
  broadcastChat(saved.id);
  const original = r.message_id ? getMessageRow(r.message_id) : undefined;
  let forwarded = false;
  if (original && getChat(original.chat_id)) {
    publishMessage(saved, user, insertMessage(saved, user, { text: txt.labels.reminder, files: [] }));
    try {
      forwardMessages([original.id], original.chat_id, saved.id, user);
      forwarded = true;
    } catch {
      /* no access any more: fall back to the text we kept */
    }
  }
  if (!forwarded) {
    publishMessage(saved, user, insertMessage(saved, user, { text: txt.labels.reminderOf(r.snapshot), files: [] }));
  }
  // own messages never ring: this one should
  notifyUser(user.id, {
    title: txt.labels.reminder,
    // a push shows on the lock screen: no markers, spoilers stay hidden
    body: stripFormatting(r.snapshot).replace(/\s+/g, ' ').trim().slice(0, 200) || txt.labels.media,
    chatId: saved.id,
    url: `/c/${saved.id}`,
    tag: `reminder-${r.id}`,
  });
}

export function sendDueReminders() {
  const due = db.prepare('SELECT * FROM reminders WHERE remind_at <= ? ORDER BY remind_at LIMIT 100').all(now()) as ReminderRow[];
  for (const r of due) {
    try {
      deliver(r);
    } catch {
      /* the user or the saved chat is gone */
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startReminderTimer() {
  if (timer) return;
  timer = setInterval(() => {
    try {
      sendDueReminders();
    } catch {
      /* db closed during shutdown */
    }
  }, 10_000);
  timer.unref();
}

