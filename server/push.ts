import type { MessageDTO, Prefs, PushNotificationPayload } from '@timba/shared';
import { isQuietNow, stripFormatting } from '@timba/shared';
import webpush from 'web-push';
import { config } from './config.js';
import { db, now } from './db.js';
import { type ChatRow, notMutedSql } from './permissions.js';
import { isUserActive } from './realtime.js';
import { type UserRow, displayName } from './serialize.js';
import { txt } from './strings.js';

/**
 * Web Push (VAPID). The server only makes outbound HTTPS requests to the browser's push service
 * (Google FCM, Mozilla, Apple), so it works behind NAT without a public IP. Browsers only allow
 * push subscriptions on HTTPS pages (or localhost) — see README.
 */

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

interface SubscriptionRow {
  endpoint: string;
  user_id: number;
  p256dh: string;
  auth: string;
}

let keys: VapidKeys | null = null;

export function vapidKeys(): VapidKeys {
  if (keys) return keys;
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = 'vapid_keys'`).get() as { value: string } | undefined;
  if (row) {
    keys = JSON.parse(row.value) as VapidKeys;
  } else {
    keys = webpush.generateVAPIDKeys();
    db.prepare(`INSERT INTO app_settings (key, value) VALUES ('vapid_keys', ?)`).run(JSON.stringify(keys));
  }
  return keys;
}

export function resetPushCache() {
  keys = null;
}

export function saveSubscription(
  userId: number,
  sessionId: string,
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
) {
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, user_id, session_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, session_id = excluded.session_id,
       p256dh = excluded.p256dh, auth = excluded.auth`,
  ).run(sub.endpoint, userId, sessionId, sub.keys.p256dh, sub.keys.auth, now());
}

export function deleteSubscription(userId: number, endpoint: string) {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, userId);
}

/** Short text for the notification body. */
function preview(m: MessageDTO): string {
  if (m.poll) return txt.labels.pollPreview(m.poll.question);
  if (m.transfer) return txt.labels.transferPreview(m.transfer.amount);
  if (m.fund) return txt.labels.fundPreview(m.fund.title);
  if (m.checklist) return txt.labels.checklistPreview(m.checklist.title);
  if (m.sticker) return txt.labels.sticker(m.sticker.emoji);
  if (m.text) {
    const text = stripFormatting(m.text);
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  }
  const a = m.attachments;
  if (!a.length) return '';
  if (a[0]!.kind === 'voice') return txt.labels.voice;
  if (a[0]!.kind === 'round') return txt.labels.round;
  if (a.every((x) => x.kind === 'photo')) return txt.labels.photo;
  if (a.every((x) => x.kind === 'video')) return txt.labels.video;
  if (a.every((x) => x.kind === 'file')) return a[0]!.name;
  return txt.labels.media;
}

/** Send a push about a new message to every member who is not looking at the app right now. */
/**
 * Send a push about a new message to every member who is not looking at the app right now.
 * Mentioned users (and people replied to) are notified even in muted chats; comments under
 * channel posts notify only them.
 */
export function notifyNewMessage(chat: ChatRow, sender: UserRow, m: MessageDTO, mentioned: number[] = []) {
  if (m.kind === 'service') return;
  const members = m.threadId
    ? []
    : (
        db
          .prepare(`SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id != ? AND ${notMutedSql()}`)
          .all(chat.id, sender.id) as { user_id: number }[]
      ).map((r) => r.user_id);
  const recipients = [...new Set([...members, ...mentioned])].filter((id) => id !== sender.id && !isUserActive(id));
  if (!recipients.length) return;

  const subs = db
    .prepare(`SELECT * FROM push_subscriptions WHERE user_id IN (${recipients.map(() => '?').join(',')})`)
    .all(...recipients) as SubscriptionRow[];
  if (!subs.length) return;
  // quiet hours: the notification still shows, but without a sound — unless the message is meant for this very person
  const quiet = quietUsers(recipients.filter((id) => !mentioned.includes(id)));

  const body = preview(m);
  const payload: PushNotificationPayload = {
    title: chat.type === 'private' ? displayName(sender) : chat.title,
    body: chat.type === 'group' || m.threadId ? `${displayName(sender)}: ${body}` : body,
    chatId: chat.id,
    url: `/c/${chat.id}`,
    tag: `chat-${chat.id}`,
    ...(m.silent ? { silent: true } : {}),
  };
  if (!quiet.size) return void sendToSubscriptions(subs, payload);
  void sendToSubscriptions(
    subs.filter((s) => !quiet.has(s.user_id)),
    payload,
  );
  void sendToSubscriptions(
    subs.filter((s) => quiet.has(s.user_id)),
    { ...payload, silent: true },
  );
}

/** Of these users, the ones whose «Тихие часы» are on right now. */
function quietUsers(userIds: number[]): Set<number> {
  const out = new Set<number>();
  if (!userIds.length) return out;
  const rows = db
    .prepare(`SELECT id, prefs FROM users WHERE id IN (${userIds.map(() => '?').join(',')})`)
    .all(...userIds) as { id: number; prefs: string }[];
  for (const r of rows) {
    try {
      if (isQuietNow((JSON.parse(r.prefs || '{}') as Prefs).quietHours)) out.add(r.id);
    } catch {
      /* broken prefs: not quiet */
    }
  }
  return out;
}

/** A push to one user, whatever the chat (reminders come from the user's own saved messages). */
export function notifyUser(userId: number, payload: PushNotificationPayload) {
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId) as SubscriptionRow[];
  if (subs.length) void sendToSubscriptions(subs, payload);
}

async function sendToSubscriptions(subs: SubscriptionRow[], payload: PushNotificationPayload) {
  const k = vapidKeys();
  const data = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, data, {
          TTL: 24 * 3600,
          urgency: 'high',
          topic: payload.tag.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32),
          vapidDetails: { subject: config.pushContact, publicKey: k.publicKey, privateKey: k.privateKey },
        });
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        // subscription expired or was revoked by the user
        if (status === 404 || status === 410) {
          db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(s.endpoint);
        }
      }
    }),
  );
}
