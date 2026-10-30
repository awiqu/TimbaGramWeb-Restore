import type { NotificationDTO, NotificationKind, NotificationUnread, TopupKind, TopupStatus } from '@timba/shared';
import { EV } from '@timba/shared';
import { db, now } from './db.js';
import { notifyUser } from './push.js';
import { isUserActive, toUser } from './realtime.js';
import { userDTO, usersByIds } from './serialize.js';
import { txt } from './strings.js';

/**
 * Notifications of the bank (transfers, top-ups, Премиум) and of support (for the admin: new tickets,
 * operator calls, payment checks with buttons). They used to come from the built-in accounts
 * «ТимбаКоины» and «Поддержка» as chat messages; now they are a list of their own with a push.
 */

interface NotificationRow {
  id: number;
  user_id: number;
  kind: NotificationKind;
  text: string;
  topup_id: number | null;
  created_at: number;
  read: number;
}

interface TopupRow {
  id: number;
  user_id: number;
  kind: TopupKind;
  amount: number;
  status: TopupStatus;
  created_at: number;
}

const LIMIT = 100;

/**
 * The table lives outside the numbered migrations, so it never collides with a migration added
 * elsewhere; the old built-in accounts are cleaned up the same way, once.
 */
export function initNotifications() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      topup_id INTEGER REFERENCES bank_topups(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      read INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, kind, id);
  `);
  removeBuiltInAccounts();
}

/**
 * The accounts «ТимбаКоины» and «Поддержка» are gone: what they wrote moves to the notifications
 * (already read, with the buttons of payment checks), then their chats and the accounts are deleted.
 */
function removeBuiltInAccounts() {
  const bots = db.prepare('SELECT id, bot FROM users WHERE bot IS NOT NULL').all() as { id: number; bot: string }[];
  if (!bots.length) return;
  db.transaction(() => {
    for (const b of bots) {
      const kind: NotificationKind = b.bot === 'bank' ? 'bank' : 'support';
      const chats = db
        .prepare(`SELECT id, private_key FROM chats WHERE type = 'private' AND (private_key LIKE ? OR private_key LIKE ?)`)
        .all(`${b.id}:%`, `%:${b.id}`) as { id: number; private_key: string }[];
      for (const c of chats) {
        const [x, y] = c.private_key.split(':').map(Number);
        const owner = x === b.id ? y : x;
        // only what the account wrote: the user's own messages to it were not notifications
        if (owner && owner !== b.id) {
          db.prepare(
            `INSERT INTO notifications (user_id, kind, text, topup_id, created_at, read)
             SELECT ?, ?, m.text, (SELECT t.id FROM bank_topups t WHERE t.message_id = m.id), m.created_at, 1
             FROM messages m WHERE m.chat_id = ? AND m.sender_id = ? AND m.kind != 'service' AND m.text != ''
             ORDER BY m.id`,
          ).run(owner, kind, c.id, b.id);
        }
        db.prepare('DELETE FROM chats WHERE id = ?').run(c.id);
      }
      db.prepare('DELETE FROM users WHERE id = ?').run(b.id);
    }
  })();
}

/** Send a notification: it lands in the list, the open app gets it live, a closed one gets a push. */
export function notify(
  kind: NotificationKind,
  userId: number,
  text: string,
  topupId: number | null = null,
  /** where the push opens; the notification list by default */
  url = `/notifications/${kind}`,
): NotificationDTO {
  const res = db
    .prepare('INSERT INTO notifications (user_id, kind, text, topup_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, kind, text, topupId, now());
  const id = Number(res.lastInsertRowid);
  // the list is only as long as anyone reads it
  db.prepare(
    `DELETE FROM notifications WHERE user_id = ? AND kind = ? AND id <= (
       SELECT id FROM notifications WHERE user_id = ? AND kind = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
  ).run(userId, kind, userId, kind, LIMIT);
  const dto = toDTO([db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as NotificationRow])[0]!;
  toUser(userId, EV.notification, { notification: dto, unread: unreadCounts(userId) });
  if (!isUserActive(userId)) {
    const body = text.length > 200 ? `${text.slice(0, 197)}…` : text;
    notifyUser(userId, {
      title: kind === 'bank' ? txt.notifications.bankTitle : txt.notifications.supportTitle,
      body,
      chatId: 0,
      url,
      tag: `notify-${kind}-${id}`,
    });
  }
  return dto;
}

export function listNotifications(userId: number, kind: NotificationKind): NotificationDTO[] {
  const rows = db
    .prepare('SELECT * FROM notifications WHERE user_id = ? AND kind = ? ORDER BY id DESC LIMIT ?')
    .all(userId, kind, LIMIT) as NotificationRow[];
  return toDTO(rows);
}

export function markNotificationsRead(userId: number, kind: NotificationKind): NotificationUnread {
  db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ? AND kind = ? AND read = 0').run(userId, kind);
  const unread = unreadCounts(userId);
  // other devices of the user drop the badge too
  toUser(userId, EV.notification, { unread });
  return unread;
}

export function unreadCounts(userId: number): NotificationUnread {
  const rows = db
    .prepare('SELECT kind, COUNT(*) n FROM notifications WHERE user_id = ? AND read = 0 GROUP BY kind')
    .all(userId) as { kind: NotificationKind; n: number }[];
  const out: NotificationUnread = { bank: 0, support: 0 };
  for (const r of rows) if (r.kind in out) out[r.kind] = r.n;
  return out;
}

/** A payment check was decided: every notification that carries it shows the new state. */
export function topupDecided(topupId: number) {
  const rows = db.prepare('SELECT * FROM notifications WHERE topup_id = ?').all(topupId) as NotificationRow[];
  for (const dto of toDTO(rows)) toUser(rows.find((r) => r.id === dto.id)!.user_id, EV.notification, { notification: dto });
}

function toDTO(rows: NotificationRow[]): NotificationDTO[] {
  const topupIds = [...new Set(rows.map((r) => r.topup_id).filter((x): x is number => !!x))];
  const topups = new Map<number, TopupRow>();
  if (topupIds.length) {
    const list = db.prepare(`SELECT * FROM bank_topups WHERE id IN (${topupIds.map(() => '?').join(',')})`).all(...topupIds) as TopupRow[];
    for (const t of list) topups.set(t.id, t);
  }
  const users = usersByIds([...topups.values()].map((t) => t.user_id));
  return rows.map((r) => {
    const t = r.topup_id ? topups.get(r.topup_id) : undefined;
    return {
      id: r.id,
      kind: r.kind,
      text: r.text,
      createdAt: r.created_at,
      read: !!r.read,
      ...(t
        ? {
            topup: {
              id: t.id,
              kind: t.kind,
              amount: t.amount,
              status: t.status,
              user: users.has(t.user_id) ? userDTO(users.get(t.user_id)!, { self: true }) : null,
              createdAt: t.created_at,
            },
          }
        : {}),
    };
  });
}
