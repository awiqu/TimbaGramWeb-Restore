import crypto from 'node:crypto';
import { BOT_UPDATES_MAX, BOT_UPDATES_TTL_MS, EV } from '@timba/shared';
import { db, now } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { type ChatRow, getChat, getMember } from '../permissions.js';
import { toUser } from '../realtime.js';
import { broadcastChat } from '../services/chats.js';
import { type MessageRow, type UserRow, getMessageRow, getUserRow } from '../serialize.js';
import { txt } from '../strings.js';
import { runBuiltin } from './builtin.js';
import { type ApiMessage, apiChat, apiChatMember, apiChecklist, apiMessage, apiPoll, apiUser } from './convert.js';
import { BotApiError } from './errors.js';
import { type BotHooks, setBotHooks } from './hooks.js';
import { parseBotUrl, postJson } from './net.js';
import { type BotRow, type UpdateKind, botMembers, getBot, wantsUpdate } from './store.js';

/**
 * How things that happen in the messenger reach a bot.
 *
 * Every event a bot may care about becomes an "update" (Telegram's word, and its shape): a row in
 * bot_updates that getUpdates hands out and the bot confirms with the next offset, or — when a webhook
 * is set — a POST to the bot's address. The built-in bots get the same update directly.
 */

// ---------- the queue ----------

export interface ApiUpdate {
  update_id: number;
  [kind: string]: unknown;
}

/** Waiting getUpdates calls: one per bot, a new one ends the old one (Telegram answers 409 to it). */
const pollers = new Map<number, { wake: () => void; fail: (e: BotApiError) => void }>();

export function enqueue(bot: BotRow, kind: UpdateKind, payload: unknown) {
  if (!wantsUpdate(bot, kind)) return;
  if (bot.builtin) {
    runBuiltin(bot, { update_id: 0, [kind]: payload });
    return;
  }
  db.prepare('INSERT INTO bot_updates (bot_id, kind, payload, created_at) VALUES (?, ?, ?, ?)').run(
    bot.user_id,
    kind,
    JSON.stringify(payload),
    now(),
  );
  if (bot.webhook_url) void deliverWebhook(bot.user_id);
  else pollers.get(bot.user_id)?.wake();
}

interface UpdateRow {
  id: number;
  kind: string;
  payload: string;
}

const toUpdate = (r: UpdateRow): ApiUpdate => ({ update_id: r.id, [r.kind]: JSON.parse(r.payload) });

export async function getUpdates(
  bot: BotRow,
  p: { offset?: number; limit: number; timeout: number; allowed?: string[] },
): Promise<ApiUpdate[]> {
  if (bot.webhook_url) {
    throw new BotApiError(409, "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first");
  }
  if (p.allowed) db.prepare('UPDATE bots SET allowed_updates = ? WHERE user_id = ?').run(JSON.stringify(p.allowed), bot.user_id);
  const offset = p.offset ?? 0;
  // an offset confirms everything before it
  if (offset > 0) db.prepare('DELETE FROM bot_updates WHERE bot_id = ? AND id < ?').run(bot.user_id, offset);
  const read = (): ApiUpdate[] => {
    if (offset < 0) {
      const rows = db
        .prepare('SELECT * FROM bot_updates WHERE bot_id = ? ORDER BY id DESC LIMIT ?')
        .all(bot.user_id, Math.min(-offset, p.limit)) as UpdateRow[];
      return rows.reverse().map(toUpdate);
    }
    return (
      db.prepare('SELECT * FROM bot_updates WHERE bot_id = ? AND id >= ? ORDER BY id LIMIT ?').all(bot.user_id, offset, p.limit) as UpdateRow[]
    ).map(toUpdate);
  };
  const first = read();
  if (first.length || !p.timeout) return first;

  return new Promise<ApiUpdate[]>((resolve, reject) => {
    pollers.get(bot.user_id)?.fail(new BotApiError(409, 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running'));
    const entry = {
      wake: () => finish(() => resolve(read())),
      fail: (e: BotApiError) => finish(() => reject(e)),
    };
    const timer = setTimeout(() => entry.wake(), Math.min(p.timeout, 50) * 1000);
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      if (pollers.get(bot.user_id) === entry) pollers.delete(bot.user_id);
      fn();
    };
    pollers.set(bot.user_id, entry);
  });
}

/** The bot is gone (deleted, or its token was replaced): whoever waits for updates is told. */
export function dropPoller(botId: number) {
  pollers.get(botId)?.fail(new BotApiError(401, 'Unauthorized'));
}

// ---------- webhooks ----------

const delivering = new Set<number>();
const retries = new Map<number, ReturnType<typeof setTimeout>>();
const failures = new Map<number, number>();

export function webhookInfo(bot: BotRow) {
  const pending = (db.prepare('SELECT COUNT(*) c FROM bot_updates WHERE bot_id = ?').get(bot.user_id) as { c: number }).c;
  return {
    url: bot.webhook_url ?? '',
    has_custom_certificate: false,
    pending_update_count: pending,
    max_connections: 1,
    ...(bot.webhook_error ? { last_error_date: Math.floor((bot.webhook_error_at ?? 0) / 1000), last_error_message: bot.webhook_error } : {}),
    ...(bot.allowed_updates ? { allowed_updates: JSON.parse(bot.allowed_updates) as string[] } : {}),
  };
}

export function setWebhook(bot: BotRow, url: string, secret: string | null, allowed: string[] | undefined, dropPending: boolean) {
  if (url) {
    try {
      parseBotUrl(url);
    } catch (e) {
      throw new BotApiError(400, `Bad Request: bad webhook: ${(e as Error).message}`);
    }
  }
  db.prepare(
    `UPDATE bots SET webhook_url = ?, webhook_secret = ?, webhook_error = NULL, webhook_error_at = NULL,
       allowed_updates = COALESCE(?, allowed_updates) WHERE user_id = ?`,
  ).run(url || null, url ? secret : null, allowed ? JSON.stringify(allowed) : null, bot.user_id);
  if (dropPending) db.prepare('DELETE FROM bot_updates WHERE bot_id = ?').run(bot.user_id);
  pollers.get(bot.user_id)?.fail(new BotApiError(409, 'Conflict: terminated by setWebhook request'));
  clearTimeout(retries.get(bot.user_id));
  retries.delete(bot.user_id);
  failures.delete(bot.user_id);
  if (url) void deliverWebhook(bot.user_id);
}

async function deliverWebhook(botId: number) {
  if (delivering.has(botId)) return;
  delivering.add(botId);
  try {
    for (;;) {
      const bot = getBot(botId);
      if (!bot?.webhook_url) return;
      const rows = db.prepare('SELECT * FROM bot_updates WHERE bot_id = ? ORDER BY id LIMIT 20').all(botId) as UpdateRow[];
      if (!rows.length) return;
      for (const r of rows) {
        try {
          const res = await postJson(
            parseBotUrl(bot.webhook_url),
            toUpdate(r),
            bot.webhook_secret ? { 'X-Telegram-Bot-Api-Secret-Token': bot.webhook_secret } : {},
          );
          if (res.status < 200 || res.status >= 300) throw new Error(`Wrong response from the webhook: ${res.status}`);
        } catch (e) {
          db.prepare('UPDATE bots SET webhook_error = ?, webhook_error_at = ? WHERE user_id = ?').run(
            String((e as Error).message).slice(0, 200),
            now(),
            botId,
          );
          const n = (failures.get(botId) ?? 0) + 1;
          failures.set(botId, n);
          clearTimeout(retries.get(botId));
          const timer = setTimeout(() => void deliverWebhook(botId), Math.min(5000 * 2 ** (n - 1), 5 * 60_000));
          timer.unref();
          retries.set(botId, timer);
          return;
        }
        failures.delete(botId);
        db.prepare('DELETE FROM bot_updates WHERE id = ?').run(r.id);
      }
    }
  } finally {
    delivering.delete(botId);
  }
}

// ---------- buttons under messages ----------

const CALLBACK_TTL_MS = 10 * 60_000;
const callbacks = new Map<string, { userId: number; botId: number; at: number }>();

/** A person pressed a callback button: the bot gets a callback_query, the person gets an id to wait for the answer by. */
export function pressButton(user: UserRow, messageId: number, data: string): { id: string } {
  const row = getMessageRow(messageId);
  if (!row || !row.reply_markup) throw notFound(txt.bots.buttonOutdated);
  const chat = getChat(row.chat_id);
  if (!chat || !getMember(chat.id, user.id)) throw forbidden(txt.errors.notMember);
  const kb = JSON.parse(row.reply_markup) as { rows: { callbackData?: string }[][] };
  if (!kb.rows.some((r) => r.some((b) => b.callbackData === data))) throw badRequest(txt.bots.buttonOutdated, 'button_outdated');
  const bot = row.sender_id ? getBot(row.sender_id) : undefined;
  if (!bot) throw badRequest(txt.bots.buttonOutdated, 'button_outdated');
  const id = crypto.randomBytes(8).toString('hex');
  callbacks.set(id, { userId: user.id, botId: bot.user_id, at: now() });
  enqueue(bot, 'callback_query', {
    id,
    from: apiUser(user),
    message: apiMessage(row, bot.user_id),
    chat_instance: String(chat.id),
    data,
  });
  return { id };
}

/** answerCallbackQuery: the person who pressed sees a notice, an alert or a link opens. */
export function answerCallback(botId: number, id: string, answer: { text?: string; show_alert?: boolean; url?: string }) {
  const cb = callbacks.get(id);
  if (!cb || cb.botId !== botId || now() - cb.at > CALLBACK_TTL_MS) {
    throw new BotApiError(400, 'Bad Request: query is too old and response timeout expired or query ID is invalid');
  }
  callbacks.delete(id);
  toUser(cb.userId, EV.botCallbackAnswer, {
    id,
    ...(answer.text ? { text: answer.text } : {}),
    ...(answer.show_alert ? { alert: true } : {}),
    ...(answer.url ? { url: answer.url } : {}),
  });
}

// ---------- what bots hear about chats ----------

const BOT_KINDS = new Set(['text', 'media', 'poll', 'checklist', 'sticker']);

const lastBotSender = (chatId: number) =>
  (
    db
      .prepare(
        `SELECT m.sender_id FROM messages m JOIN users u ON u.id = m.sender_id
         WHERE m.chat_id = ? AND u.is_bot = 1 AND m.kind != 'service' ORDER BY m.id DESC LIMIT 1`,
      )
      .get(chatId) as { sender_id: number } | undefined
  )?.sender_id;

/**
 * A bot in a group sees what Telegram's privacy mode lets through: commands meant for it, replies to it,
 * mentions of it. With privacy off, or as an administrator, it sees everything. Bots never see bots.
 */
function visibleInGroup(bot: BotRow & { role: string }, chat: ChatRow, row: MessageRow, sender: UserRow): boolean {
  if (sender.is_bot) return false;
  if (!bot.privacy_mode || bot.role === 'admin' || bot.role === 'owner') return true;
  const username = getUserRow(bot.user_id)?.username ?? '';
  const cmd = /^\/[A-Za-z0-9_]{1,32}(?:@([A-Za-z][A-Za-z0-9_]{2,31}))?(?=\s|$)/.exec(row.text);
  if (cmd) {
    // «/start@some_bot» is for that bot; a plain «/start» for the bot that spoke last (or the only one)
    if (cmd[1]) return cmd[1].toLowerCase() === username.toLowerCase();
    return lastBotSender(chat.id) === bot.user_id || botMembers(chat.id).length === 1;
  }
  if (new RegExp(`(^|[^A-Za-z0-9_])@${username}(?![A-Za-z0-9_])`, 'i').test(row.text)) return true;
  if (row.reply_to_id && getMessageRow(row.reply_to_id)?.sender_id === bot.user_id) return true;
  return false;
}

function deliverMessage(chat: ChatRow, actor: UserRow, row: MessageRow, edited: boolean) {
  if (row.thread_id !== null || !BOT_KINDS.has(row.kind)) return;
  for (const bot of botMembers(chat.id)) {
    if (bot.user_id === actor.id) continue;
    if (chat.type === 'channel') {
      // a bot reads a channel's posts as its administrator
      if (bot.role !== 'admin' && bot.role !== 'owner') continue;
      enqueue(bot, edited ? 'edited_channel_post' : 'channel_post', apiMessage(row, bot.user_id));
    } else {
      if (chat.type === 'group' && !visibleInGroup(bot, chat, row, actor)) continue;
      enqueue(bot, edited ? 'edited_message' : 'message', apiMessage(row, bot.user_id));
    }
  }
}

const emojiReaction = (e: string | null) => (e ? [{ type: 'emoji', emoji: e }] : []);

/** A service message ("new_chat_members" & co.) as the Bot API shows it. */
function serviceUpdate(chat: ChatRow, bot: BotRow, actor: UserRow, id: number | null, extra: Record<string, unknown>): ApiMessage {
  return { message_id: id ?? 0, from: apiUser(actor), chat: apiChat(chat, bot.user_id), date: Math.floor(Date.now() / 1000), ...extra };
}

function privateChatWith(bot: UserRow, user: UserRow): ChatRow | undefined {
  const key = [bot.id, user.id].sort((a, b) => a - b).join(':');
  return db.prepare('SELECT * FROM chats WHERE private_key = ?').get(key) as ChatRow | undefined;
}

/** A keyboard for one press, or a "reply to this" request, goes away once the person writes something. */
function consumeKeyboard(chat: ChatRow, sender: UserRow) {
  if (sender.is_bot || chat.type === 'channel') return;
  const kb = db.prepare('SELECT markup FROM chat_keyboards WHERE chat_id = ?').get(chat.id) as { markup: string } | undefined;
  if (!kb) return;
  const m = JSON.parse(kb.markup) as { type: string; oneTime?: boolean };
  if (m.type === 'force_reply' || m.oneTime) {
    db.prepare('DELETE FROM chat_keyboards WHERE chat_id = ?').run(chat.id);
    broadcastChat(chat.id);
  }
}

const hooks: BotHooks = {
  newMessage: (chat, sender, row) => {
    consumeKeyboard(chat, sender);
    deliverMessage(chat, sender, row, false);
  },
  editedMessage: (chat, editor, row) => deliverMessage(chat, editor, row, true),

  pollAnswer(pollId, user, votes) {
    const p = db.prepare('SELECT creator_id, anonymous FROM polls WHERE id = ?').get(pollId) as { creator_id: number | null; anonymous: number } | undefined;
    const bot = p?.creator_id ? getBot(p.creator_id) : undefined;
    // bots learn who voted only in polls that are not anonymous
    if (!bot || p?.anonymous) return;
    enqueue(bot, 'poll_answer', { poll_id: String(pollId), user: apiUser(user), option_ids: votes });
  },

  pollChanged(pollId) {
    const p = db.prepare('SELECT creator_id FROM polls WHERE id = ?').get(pollId) as { creator_id: number | null } | undefined;
    const bot = p?.creator_id ? getBot(p.creator_id) : undefined;
    if (!bot) return;
    const poll = apiPoll(pollId, bot.user_id);
    if (poll) enqueue(bot, 'poll', poll);
  },

  reaction(chat, user, row, oldEmoji, newEmoji) {
    for (const bot of botMembers(chat.id)) {
      if (bot.user_id === user.id) continue;
      // in groups and channels only administrators hear about reactions, as in Telegram
      if (chat.type !== 'private' && bot.role !== 'admin' && bot.role !== 'owner') continue;
      enqueue(bot, 'message_reaction', {
        chat: apiChat(chat, bot.user_id),
        message_id: row.id,
        user: apiUser(user),
        date: Math.floor(Date.now() / 1000),
        old_reaction: emojiReaction(oldEmoji),
        new_reaction: emojiReaction(newEmoji),
      });
    }
  },

  membersAdded(chat, actor, added, serviceId) {
    const date = Math.floor(Date.now() / 1000);
    for (const u of added) {
      const bot = u.is_bot ? getBot(u.id) : undefined;
      if (!bot) continue;
      enqueue(bot, 'my_chat_member', {
        chat: apiChat(chat, bot.user_id),
        from: apiUser(actor),
        date,
        old_chat_member: { status: 'left', user: apiUser(u) },
        new_chat_member: apiChatMember(chat, u),
      });
    }
    if (chat.type === 'channel' || serviceId === null) return;
    // "new_chat_members" reaches every bot of the group, the added ones included
    for (const bot of botMembers(chat.id)) {
      if (bot.user_id === actor.id) continue;
      enqueue(bot, 'message', serviceUpdate(chat, bot, actor, serviceId, { new_chat_members: added.map(apiUser) }));
    }
  },

  memberLeft(chat, actor, who, kicked, serviceId) {
    const bot = who.is_bot ? getBot(who.id) : undefined;
    if (bot) {
      enqueue(bot, 'my_chat_member', {
        chat: apiChat(chat, bot.user_id),
        from: apiUser(actor),
        date: Math.floor(Date.now() / 1000),
        old_chat_member: { status: 'member', user: apiUser(who) },
        new_chat_member: apiChatMember(chat, who),
      });
      void kicked;
    }
    if (chat.type === 'channel' || serviceId === null) return;
    for (const b of botMembers(chat.id)) {
      if (b.user_id === who.id || b.user_id === actor.id) continue;
      enqueue(b, 'message', serviceUpdate(chat, b, actor, serviceId, { left_chat_member: apiUser(who) }));
    }
  },

  blocked(user, botUser, isBlocked) {
    const bot = getBot(botUser.id);
    const chat = privateChatWith(botUser, user);
    if (!bot || !chat) return;
    enqueue(bot, 'my_chat_member', {
      chat: apiChat(chat, bot.user_id),
      from: apiUser(user),
      date: Math.floor(Date.now() / 1000),
      old_chat_member: { status: isBlocked ? 'member' : 'kicked', user: apiUser(botUser) },
      new_chat_member: { status: isBlocked ? 'kicked' : 'member', user: apiUser(botUser) },
    });
  },

  checklistChanged(checklistId, user, change) {
    const c = db.prepare('SELECT creator_id FROM checklists WHERE id = ?').get(checklistId) as { creator_id: number | null } | undefined;
    const bot = c?.creator_id ? getBot(c.creator_id) : undefined;
    const msg = db.prepare("SELECT * FROM messages WHERE kind = 'checklist' AND extra_id = ? ORDER BY id LIMIT 1").get(checklistId) as MessageRow | undefined;
    const chat = msg ? getChat(msg.chat_id) : undefined;
    if (!bot || !msg || !chat || user.id === bot.user_id) return;
    const card = apiMessage(msg, bot.user_id);
    if (change.done.length || change.undone.length) {
      enqueue(bot, 'message', serviceUpdate(chat, bot, user, msg.id, {
        checklist_tasks_done: {
          checklist_message: card,
          ...(change.done.length ? { marked_as_done_task_ids: change.done } : {}),
          ...(change.undone.length ? { marked_as_not_done_task_ids: change.undone } : {}),
        },
      }));
    }
    if (change.added.length) {
      const tasks = apiChecklist(checklistId)?.tasks.filter((t) => change.added.includes(t.id)) ?? [];
      enqueue(bot, 'message', serviceUpdate(chat, bot, user, msg.id, { checklist_tasks_added: { checklist_message: card, tasks } }));
    }
  },
};

export function installBotHooks() {
  setBotHooks(hooks);
}

// ---------- housekeeping ----------

export function cleanupBots() {
  db.prepare('DELETE FROM bot_updates WHERE created_at < ?').run(now() - BOT_UPDATES_TTL_MS);
  const big = db.prepare('SELECT bot_id FROM bot_updates GROUP BY bot_id HAVING COUNT(*) > ?').all(BOT_UPDATES_MAX) as { bot_id: number }[];
  for (const b of big) {
    db.prepare(
      `DELETE FROM bot_updates WHERE bot_id = ? AND id <= (SELECT id FROM bot_updates WHERE bot_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`,
    ).run(b.bot_id, b.bot_id, BOT_UPDATES_MAX);
  }
  for (const [id, cb] of callbacks) if (now() - cb.at > CALLBACK_TTL_MS) callbacks.delete(id);
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startBotTimer() {
  if (timer) return;
  const run = () => {
    try {
      cleanupBots();
    } catch {
      /* db closed during shutdown */
    }
  };
  run();
  timer = setInterval(run, 3600_000);
  timer.unref();
  // webhooks that were waiting when the server stopped
  for (const r of db.prepare('SELECT user_id FROM bots WHERE webhook_url IS NOT NULL').all() as { user_id: number }[]) void deliverWebhook(r.user_id);
}
