import {
  EV,
  MAX_MESSAGE_LENGTH,
  POLL_EXPLANATION_MAX,
  POLL_MAX_OPTIONS,
  POLL_MIN_OPTIONS,
  POLL_OPTION_MAX,
  POLL_QUESTION_MAX,
  CHECKLIST_MAX_ITEMS,
  REACTIONS,
  type AdminRights,
} from '@timba/shared';
import { z } from 'zod';
import { rateLimit } from '../auth.js';
import { db, now } from '../db.js';
import { HttpError } from '../errors.js';
import { type ChatRow, NO_RIGHTS, canActOn, getMember, isChannel, membership, parsePerms, requireRight } from '../permissions.js';
import { toChat, toChatExcept } from '../realtime.js';
import { type FileRow, type MessageRow, type UserRow, displayName, getMessageRow, getUserByUsername, getUserRow, isBlockedBy, messageDTO } from '../serialize.js';
import { broadcastChat, removeMember, serviceMessage } from '../services/chats.js';
import { refreshChecklist, createChecklist } from '../services/cards.js';
import { deleteMessages, editMessage, forwardMessages, sendPrepared, setPinned } from '../services/messages.js';
import { createPoll, stopPoll } from '../services/polls.js';
import { setReaction } from '../services/reactions.js';
import { resolveSticker } from '../services/stickers.js';
import type { PendingUpload } from '../services/files.js';
import { txt } from '../strings.js';
import { botHooks } from './hooks.js';
import { type ApiMessage, apiChat, apiChatMember, apiMessage, apiPoll, apiUser, resolveChat } from './convert.js';
import { BotApiError, badReq, forbiddenReq, fromHttpError } from './errors.js';
import { fileForBot, inputFile } from './files.js';
import { type ApiEntity, toNative } from './format.js';
import { parseReplyMarkup, type ParsedMarkup } from './markup.js';
import { checkCommands, setBotAbout, setBotCommands, setBotDescription, setBotName } from './manage.js';
import { botCommands, type BotRow } from './store.js';
import { answerCallback, getUpdates, setWebhook, webhookInfo } from './updates.js';
import { InvoiceError, apiInvoice, cancelInvoice, createInvoice, getInvoice, payout, refundInvoice, transactionsOf, walletInfo } from './wallet.js';

/**
 * The methods of the Bot API, named and shaped like Telegram's: `POST /bot<token>/sendMessage` with
 * chat_id and text, answers `{ok, result}`. Anything the messenger has a service for goes through that
 * service, as the bot itself: it needs the same rights a person would.
 */

export interface BotCall {
  bot: BotRow;
  /** the bot's own account */
  user: UserRow;
  params: Record<string, unknown>;
  /** files that came with the request (multipart) */
  uploads: Map<string, PendingUpload>;
  /** https://host: where the messenger lives, for links */
  origin: string;
}

type Method = (c: BotCall) => unknown | Promise<unknown>;

// ---------- reading parameters ----------
// Values come as JSON, as a form or in the query string: numbers, booleans and objects may arrive as text.

const parseJson = (v: unknown) => {
  if (typeof v === 'string') {
    const t = v.trim();
    if (t.startsWith('[') || t.startsWith('{')) {
      try {
        return JSON.parse(t) as unknown;
      } catch {
        return v;
      }
    }
  }
  return v;
};
const toNum = (v: unknown) => (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v);
const toBool = (v: unknown) => {
  const s = typeof v === 'string' ? v.toLowerCase() : v;
  return s === 'true' || s === '1' || s === 1 ? true : s === 'false' || s === '0' || s === 0 ? false : v;
};
const toStr = (v: unknown) => (typeof v === 'number' ? String(v) : v);

const Int = z.preprocess(toNum, z.number().int());
const IntIn = (min: number, max = Number.MAX_SAFE_INTEGER) => z.preprocess(toNum, z.number().int().min(min).max(max));
const Num = z.preprocess(toNum, z.number());
const Bool = z.preprocess(toBool, z.boolean());
const Str = z.preprocess(toStr, z.string());
const ChatId = z.preprocess(toNum, z.union([z.number().int(), z.string().min(1)]));
const Json = <T extends z.ZodTypeAny>(s: T) => z.preprocess(parseJson, s);
const Entities = Json(z.array(z.object({ type: z.string(), offset: z.number(), length: z.number(), url: z.string().optional() }).passthrough()));

function parseParams<T extends z.ZodTypeAny>(schema: T, params: Record<string, unknown>): z.infer<T> {
  const r = schema.safeParse(params);
  if (r.success) return r.data;
  const issue = r.error.issues[0]!;
  const field = issue.path.join('.') || 'parameter';
  const value = issue.path.reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string | number, unknown>)[k] : undefined), params);
  const missing = value === undefined;
  throw badReq(missing ? `${field} is empty` : `wrong ${field}: ${issue.message.toLowerCase()}`);
}

const replyFields = {
  chat_id: ChatId,
  message_thread_id: Int.optional(),
  disable_notification: Bool.optional(),
  protect_content: Bool.optional(),
  reply_to_message_id: Int.optional(),
  reply_parameters: Json(z.object({ message_id: Int }).passthrough()).optional(),
  allow_sending_without_reply: Bool.optional(),
  reply_markup: z.unknown().optional(),
};

type SendFields = {
  chat_id: string | number;
  disable_notification?: boolean;
  reply_to_message_id?: number;
  reply_parameters?: { message_id: number };
  allow_sending_without_reply?: boolean;
  reply_markup?: unknown;
};

const nativeText = (text: string, parseMode: string | undefined, entities: ApiEntity[] | undefined) => toNative(text, parseMode, entities);

// ---------- sending ----------

function replyTarget(chat: ChatRow, p: SendFields): number | null {
  const id = p.reply_parameters?.message_id ?? p.reply_to_message_id;
  if (!id) return null;
  const r = getMessageRow(id);
  if (r && r.chat_id === chat.id) return r.id;
  if (p.allow_sending_without_reply) return null;
  throw badReq('message to be replied not found');
}

/** A keyboard under the input field belongs to the chat; the latest one stays until a bot removes it. */
function applyChatKeyboard(chat: ChatRow, bot: UserRow, mk: ParsedMarkup | null, messageId: number) {
  if (!mk || mk.kind === 'inline') return;
  if (mk.kind === 'remove') db.prepare('DELETE FROM chat_keyboards WHERE chat_id = ?').run(chat.id);
  else {
    db.prepare(
      `INSERT INTO chat_keyboards (chat_id, bot_id, message_id, markup, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET bot_id = excluded.bot_id, message_id = excluded.message_id,
         markup = excluded.markup, updated_at = excluded.updated_at`,
    ).run(chat.id, bot.id, messageId, JSON.stringify(mk.keyboard), now());
  }
  broadcastChat(chat.id);
}

const inlineJson = (mk: ParsedMarkup | null) => (mk?.kind === 'inline' ? JSON.stringify(mk.keyboard) : null);

/** The common end of every send method: the message goes out, its keyboard is remembered, the answer is the Message. */
function sendOut(
  c: BotCall,
  chat: ChatRow,
  p: SendFields,
  content: { text: string; files: FileRow[]; sticker?: { sticker: string; emoji: string; packId: number | null } },
): ApiMessage {
  const mk = parseReplyMarkup(p.reply_markup);
  const dto = sendPrepared(chat, c.user, {
    ...content,
    replyToId: replyTarget(chat, p),
    silent: p.disable_notification,
    replyMarkup: inlineJson(mk),
  });
  applyChatKeyboard(chat, c.user, mk, dto.id);
  return apiMessage(getMessageRow(dto.id)!, c.bot.user_id);
}

const sendMessageSchema = z
  .object({ ...replyFields, text: Str, parse_mode: Str.optional(), entities: Entities.optional(), link_preview_options: z.unknown().optional() })
  .passthrough();

function sendMessageMethod(c: BotCall) {
  const p = parseParams(sendMessageSchema, c.params);
  const chat = resolveChat(c.bot, p.chat_id);
  const text = nativeText(p.text, p.parse_mode, p.entities as ApiEntity[] | undefined);
  if (!text.trim()) throw badReq('message text is empty');
  if (text.length > MAX_MESSAGE_LENGTH) throw badReq('message is too long');
  return sendOut(c, chat, p, { text: text.trim(), files: [] });
}

// ---------- money: invoices, balances, payouts ----------

/** The person of a private chat with a bot. */
function peerOfPrivate(chat: ChatRow, bot: UserRow): UserRow {
  const row = db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id != ?').get(chat.id, bot.id) as { user_id: number } | undefined;
  const user = row ? getUserRow(row.user_id) : undefined;
  if (!user) throw badReq('chat not found');
  return user;
}

const invoiceSchema = z
  .object({
    ...replyFields,
    title: Str,
    description: Str.optional(),
    payload: Str.optional(),
    amount: Int.optional(),
    total_amount: Int.optional(),
    prices: Json(z.array(z.object({ label: Str, amount: Int }).passthrough())).optional(),
    expires_in: Int.optional(),
  })
  .passthrough();

function sendInvoiceMethod(c: BotCall) {
  const p = parseParams(invoiceSchema, c.params);
  const chat = resolveChat(c.bot, p.chat_id);
  if (chat.type !== 'private') throw badReq('invoices can be sent to private chats only');
  const payer = peerOfPrivate(chat, c.user);
  const amount = p.amount ?? p.total_amount ?? p.prices?.reduce((sum, x) => sum + x.amount, 0);
  if (amount === undefined) throw badReq('amount is empty');
  const mk = parseReplyMarkup(p.reply_markup);
  if (mk && mk.kind !== 'inline') throw badReq('only an inline keyboard can be set on an invoice');
  try {
    const inv = createInvoice(c.bot, c.user, payer, chat, {
      title: p.title,
      description: p.description ?? '',
      payload: p.payload ?? '',
      amount,
      expiresIn: p.expires_in,
      silent: p.disable_notification,
      replyToId: replyTarget(chat, p),
      extraRows: mk?.kind === 'inline' ? mk.keyboard.rows : [],
    });
    return apiMessage(getMessageRow(inv.message_id!)!, c.bot.user_id);
  } catch (e) {
    if (e instanceof InvoiceError) throw badReq(e.message);
    throw e;
  }
}

const invoiceRefSchema = z.object({ invoice_id: Int }).passthrough();

const ownInvoice = (c: BotCall) => {
  const inv = getInvoice(parseParams(invoiceRefSchema, c.params).invoice_id);
  if (!inv || inv.bot_id !== c.bot.user_id) throw badReq('invoice not found');
  return inv;
};

/** A person the bot may talk about: one who wrote to it and did not block it. */
function knownUser(c: BotCall, raw: unknown): UserRow {
  const chat = resolveChat(c.bot, typeof raw === 'string' ? Number(raw) : raw);
  if (chat.type !== 'private') throw badReq('user not found');
  const user = peerOfPrivate(chat, c.user);
  if (isBlockedBy(user.id, c.user.id)) throw forbiddenReq('bot was blocked by the user');
  return user;
}

const balanceOf = (userId: number) => (db.prepare('SELECT balance FROM bank_accounts WHERE user_id = ?').get(userId) as { balance: number } | undefined)?.balance ?? 0;

const payoutSchema = z.object({ user_id: Int, amount: Int, comment: Str.optional() }).passthrough();

/**
 * getUserByUsername: a person's public profile by @username (what the app's search shows: id, name, username,
 * Премиум). Banned accounts are not found. A bot may look up 120 names a minute.
 */
function getUserByUsernameMethod(c: BotCall) {
  const p = parseParams(z.object({ username: Str }).passthrough(), c.params);
  rateLimit(`botlookup:${c.bot.user_id}`, 120, 60_000);
  const name = p.username.trim().replace(/^@/, '');
  if (!name) throw badReq('username is empty');
  const user = getUserByUsername(name);
  if (!user || user.is_banned) throw badReq('user not found');
  return apiUser(user);
}

const MONEY: Record<string, Method> = {
  sendinvoice: sendInvoiceMethod,
  getinvoice: (c) => apiInvoice(ownInvoice(c)),
  cancelinvoice: (c) => {
    cancelInvoice(c.bot, ownInvoice(c).id);
    return true;
  },
  refundpayment: (c) => {
    refundInvoice(c.bot, ownInvoice(c).id);
    return true;
  },
  getmybalance: (c) => {
    const w = walletInfo(c.bot);
    return { balance: w.balance, infinite: w.balance === -1, wallet: w.wallet, currency: 'TK' };
  },
  getuserbalance: (c) => {
    const p = parseParams(z.object({ user_id: Int }).passthrough(), c.params);
    const user = knownUser(c, p.user_id);
    const balance = balanceOf(user.id);
    return { user_id: user.id, balance, infinite: balance === -1, currency: 'TK' };
  },
  sendcoins: (c) => {
    const p = parseParams(payoutSchema, c.params);
    payout(c.bot, knownUser(c, p.user_id), p.amount, p.comment ?? '');
    return true;
  },
  getmytransactions: (c) => {
    const p = parseParams(z.object({ offset: Int.optional(), limit: IntIn(1, 100).optional() }).passthrough(), c.params);
    return transactionsOf(c.bot, p.offset ?? 0, p.limit ?? 50).map((x) => ({
      id: x.id,
      type: x.type,
      amount: x.amount,
      date: x.date,
      ...(x.user ? { user: apiUser(x.user) } : {}),
      ...(x.invoice_id ? { invoice_id: x.invoice_id } : {}),
      ...(x.message ? { comment: x.message } : {}),
    }));
  },
};

const mediaSchema = z
  .object({
    ...replyFields,
    caption: Str.optional(),
    parse_mode: Str.optional(),
    caption_entities: Entities.optional(),
    duration: Int.optional(),
    width: Int.optional(),
    height: Int.optional(),
    length: Int.optional(),
  })
  .passthrough();

type MediaWanted = 'photo' | 'video' | 'voice' | 'round' | 'document' | 'animation';

async function sendMediaMethod(c: BotCall, field: string, wanted: MediaWanted) {
  const p = parseParams(mediaSchema, c.params);
  const chat = resolveChat(c.bot, p.chat_id);
  const file = await inputFile(c.bot, c.user, field, c.params, c.uploads, wanted, {
    width: p.width ?? p.length,
    height: p.height ?? p.length,
    duration: p.duration,
  });
  const caption = nativeText(p.caption ?? '', p.parse_mode, p.caption_entities as ApiEntity[] | undefined).trim();
  if (caption.length > MAX_MESSAGE_LENGTH) throw badReq('message caption is too long');
  return sendOut(c, chat, p, { text: caption, files: [file] });
}

const mediaGroupSchema = z
  .object({ ...replyFields, media: Json(z.array(z.object({ type: z.string(), media: z.string(), caption: Str.optional(), parse_mode: Str.optional() }).passthrough()).min(2).max(10)) })
  .passthrough();

/** An album: one message with up to 10 pictures, videos or files. */
async function sendMediaGroupMethod(c: BotCall) {
  const p = parseParams(mediaGroupSchema, c.params);
  const chat = resolveChat(c.bot, p.chat_id);
  const files: FileRow[] = [];
  for (const item of p.media) {
    const wanted: MediaWanted | undefined =
      item.type === 'photo' ? 'photo' : item.type === 'video' ? 'video' : item.type === 'document' || item.type === 'audio' ? 'document' : undefined;
    if (!wanted) throw badReq(`unsupported media type "${item.type}": photo, video, document or audio expected`);
    files.push(await inputFile(c.bot, c.user, 'media', { media: item.media }, c.uploads, wanted));
  }
  const first = p.media.find((m) => m.caption);
  const caption = first ? nativeText(first.caption!, first.parse_mode, undefined).trim() : '';
  return [sendOut(c, chat, p, { text: caption, files })];
}

function sendStickerMethod(c: BotCall) {
  const p = parseParams(z.object({ ...replyFields, sticker: Str }).passthrough(), c.params);
  const chat = resolveChat(c.bot, p.chat_id);
  let id = p.sticker;
  if (!id.startsWith('tg:')) {
    // a custom sticker: by its picture's file id (what a bot gets in updates) or by its number
    const byFile = db.prepare('SELECT id FROM stickers WHERE file_id = ?').get(id) as { id: number } | undefined;
    if (byFile) id = String(byFile.id);
  }
  let sticker;
  try {
    sticker = resolveSticker(id);
  } catch {
    throw badReq('wrong sticker identifier');
  }
  return sendOut(c, chat, p, { text: '', files: [], sticker });
}

// ---------- polls and checklists ----------

const pollSchema = z
  .object({
    ...replyFields,
    question: Str,
    options: Json(z.array(z.union([Str, z.object({ text: Str }).passthrough()]))),
    is_anonymous: Bool.optional(),
    type: z.enum(['regular', 'quiz']).optional(),
    allows_multiple_answers: Bool.optional(),
    correct_option_id: Int.optional(),
    explanation: Str.optional(),
    open_period: Int.optional(),
    close_date: Int.optional(),
  })
  .passthrough();

function sendPollMethod(c: BotCall) {
  const p = parseParams(pollSchema, c.params);
  const chat = resolveChat(c.bot, p.chat_id);
  const question = p.question.trim();
  if (!question) throw badReq('poll question is empty');
  if (question.length > POLL_QUESTION_MAX) throw badReq(`poll question is too long: at most ${POLL_QUESTION_MAX} characters`);
  const options = p.options.map((o) => (typeof o === 'string' ? o : o.text).trim());
  if (options.length < POLL_MIN_OPTIONS) throw badReq(`poll must have at least ${POLL_MIN_OPTIONS} options`);
  if (options.length > POLL_MAX_OPTIONS) throw badReq(`poll must have at most ${POLL_MAX_OPTIONS} options`);
  if (options.some((o) => !o)) throw badReq('poll option text is empty');
  if (options.some((o) => o.length > POLL_OPTION_MAX)) throw badReq(`poll option is too long: at most ${POLL_OPTION_MAX} characters`);
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) throw badReq('poll options must be unique');
  const quiz = p.type === 'quiz';
  if (quiz) {
    if (p.correct_option_id === undefined) throw badReq('correct_option_id is required for quiz polls');
    if (p.correct_option_id < 0 || p.correct_option_id >= options.length) throw badReq('wrong correct_option_id: no such option');
    if (p.allows_multiple_answers) throw badReq('a quiz allows only one answer');
  }
  const explanation = (p.explanation ?? '').trim();
  if (explanation.length > POLL_EXPLANATION_MAX) throw badReq(`explanation is too long: at most ${POLL_EXPLANATION_MAX} characters`);
  const closePeriod = p.open_period ? Math.max(5, p.open_period) : p.close_date ? Math.max(5, p.close_date - Math.floor(Date.now() / 1000)) : null;
  const mk = parseReplyMarkup(p.reply_markup);
  const dto = createPoll(chat.id, c.user, {
    question,
    options,
    anonymous: p.is_anonymous ?? true,
    multiple: !!p.allows_multiple_answers,
    quiz,
    correctOption: quiz ? p.correct_option_id! : null,
    explanation: quiz ? explanation : '',
    closePeriod,
    replyToId: replyTarget(chat, p),
    replyMarkup: inlineJson(mk),
  });
  applyChatKeyboard(chat, c.user, mk, dto.id);
  return apiMessage(getMessageRow(dto.id)!, c.bot.user_id);
}

/** Telegram's InputChecklist: {title, tasks: [{id, text}], others_can_add_tasks}; or just a title and a list of texts. */
const checklistSchema = z
  .object({
    ...replyFields,
    checklist: Json(z.object({ title: Str, tasks: Json(z.array(z.union([Str, z.object({ text: Str }).passthrough()]))), others_can_add_tasks: Bool.optional() }).passthrough()).optional(),
    title: Str.optional(),
    tasks: Json(z.array(z.union([Str, z.object({ text: Str }).passthrough()]))).optional(),
    others_can_add_tasks: Bool.optional(),
  })
  .passthrough();

function checklistInput(p: z.infer<typeof checklistSchema>) {
  const title = (p.checklist?.title ?? p.title ?? '').trim();
  const rawTasks = p.checklist?.tasks ?? p.tasks ?? [];
  const items = rawTasks.map((t) => (typeof t === 'string' ? t : t.text).trim());
  if (!title) throw badReq('checklist title is empty');
  if (title.length > 100) throw badReq('checklist title is too long: at most 100 characters');
  if (!items.length) throw badReq('checklist must have at least one task');
  if (items.length > CHECKLIST_MAX_ITEMS) throw badReq(`checklist must have at most ${CHECKLIST_MAX_ITEMS} tasks`);
  if (items.some((i) => !i || i.length > 200)) throw badReq('checklist task text must be 1-200 characters');
  return { title, items, othersCanAdd: p.checklist?.others_can_add_tasks ?? p.others_can_add_tasks ?? true };
}

function sendChecklistMethod(c: BotCall) {
  const p = parseParams(checklistSchema, c.params);
  const chat = resolveChat(c.bot, p.chat_id);
  const mk = parseReplyMarkup(p.reply_markup);
  const dto = createChecklist(chat.id, c.user, { ...checklistInput(p), replyMarkup: inlineJson(mk) });
  applyChatKeyboard(chat, c.user, mk, dto.id);
  return apiMessage(getMessageRow(dto.id)!, c.bot.user_id);
}

/** Replace the title and the tasks of the bot's own checklist; a task with a known id keeps its mark. */
function editChecklistMethod(c: BotCall) {
  const p = parseParams(checklistSchema.and(z.object({ message_id: Int })), c.params);
  const chat = resolveChat(c.bot, p.chat_id);
  const row = ownMessage(c, chat, p.message_id);
  if (row.kind !== 'checklist' || !row.extra_id) throw badReq('message is not a checklist');
  const input = checklistInput(p);
  const raw = p.checklist?.tasks ?? p.tasks ?? [];
  db.transaction(() => {
    db.prepare('UPDATE checklists SET title = ?, others_can_add = ? WHERE id = ?').run(input.title, input.othersCanAdd ? 1 : 0, row.extra_id);
    const have = new Set((db.prepare('SELECT id FROM checklist_items WHERE checklist_id = ?').all(row.extra_id) as { id: number }[]).map((r) => r.id));
    const keep = new Set<number>();
    raw.forEach((t, i) => {
      const text = input.items[i]!;
      const id = typeof t === 'object' && typeof (t as unknown as { id?: unknown }).id === 'number' ? (t as unknown as { id: number }).id : null;
      if (id !== null && have.has(id)) {
        keep.add(id);
        db.prepare('UPDATE checklist_items SET text = ?, position = ? WHERE id = ?').run(text, i, id);
      } else {
        const r = db.prepare('INSERT INTO checklist_items (checklist_id, position, text, added_by) VALUES (?, ?, ?, ?)').run(row.extra_id, i, text, c.user.id);
        keep.add(Number(r.lastInsertRowid));
      }
    });
    for (const id of have) if (!keep.has(id)) db.prepare('DELETE FROM checklist_items WHERE id = ?').run(id);
  })();
  refreshChecklist(row.extra_id);
  return apiMessage(getMessageRow(row.id)!, c.bot.user_id);
}

// ---------- changing and removing messages ----------

/** A message of this chat that the bot wrote (bots edit only their own messages). */
function ownMessage(c: BotCall, chat: ChatRow, messageId: number): MessageRow {
  const row = getMessageRow(messageId);
  if (!row || row.chat_id !== chat.id) throw badReq('message to edit not found');
  if (row.sender_id !== c.user.id) throw badReq("message can't be edited");
  return row;
}

const editSchema = z
  .object({
    chat_id: ChatId,
    message_id: Int,
    text: Str.optional(),
    caption: Str.optional(),
    parse_mode: Str.optional(),
    entities: Entities.optional(),
    caption_entities: Entities.optional(),
    reply_markup: z.unknown().optional(),
  })
  .passthrough();

/** Edit text or caption and/or the inline keyboard. Without a new keyboard the old one is removed (as in Telegram). */
function editMessageMethod(c: BotCall, what: 'text' | 'caption' | 'markup') {
  const p = parseParams(editSchema, c.params);
  const chat = resolveChat(c.bot, p.chat_id);
  const row = ownMessage(c, chat, p.message_id);
  const mk = parseReplyMarkup(p.reply_markup);
  if (mk && mk.kind !== 'inline') throw badReq('only an inline keyboard can be set on an existing message');
  const nextMarkup = inlineJson(mk);
  let text = row.text;
  if (what !== 'markup') {
    const raw = what === 'text' ? p.text : p.caption;
    if (raw === undefined) throw badReq(what === 'text' ? 'message text is empty' : 'caption is empty');
    if (what === 'text' && row.kind !== 'text') throw badReq("there is no text in the message to edit");
    if (what === 'caption' && row.kind !== 'media') throw badReq('there is no caption in the message to edit');
    text = nativeText(raw, p.parse_mode, (what === 'text' ? p.entities : p.caption_entities) as ApiEntity[] | undefined).trim();
    if (what === 'text' && !text) throw badReq('message text is empty');
    if (text.length > MAX_MESSAGE_LENGTH) throw badReq('message is too long');
  } else if (row.kind === 'service') {
    throw badReq("message can't be edited");
  }
  if (text === row.text && nextMarkup === row.reply_markup) {
    throw badReq('message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message');
  }
  db.prepare('UPDATE messages SET reply_markup = ? WHERE id = ?').run(nextMarkup, row.id);
  if (text !== row.text) editMessage(row.id, c.user, text);
  else toChat(chat.id, EV.messageEdit, messageDTO(getMessageRow(row.id)!));
  return apiMessage(getMessageRow(row.id)!, c.bot.user_id);
}

const messageRefSchema = z.object({ chat_id: ChatId, message_id: Int }).passthrough();

function deleteMessageMethod(c: BotCall) {
  const p = parseParams(messageRefSchema, c.params);
  const chat = resolveChat(c.bot, p.chat_id);
  const row = getMessageRow(p.message_id);
  if (!row || row.chat_id !== chat.id) throw badReq('message to delete not found');
  deleteMessages([row.id], c.user, true);
  return true;
}

function deleteMessagesMethod(c: BotCall) {
  const p = parseParams(z.object({ chat_id: ChatId, message_ids: Json(z.array(Int).min(1).max(100)) }).passthrough(), c.params);
  const chat = resolveChat(c.bot, p.chat_id);
  const ids = p.message_ids.filter((id) => getMessageRow(id)?.chat_id === chat.id);
  if (ids.length) deleteMessages(ids, c.user, true);
  return true;
}

const forwardSchema = z.object({ ...replyFields, from_chat_id: ChatId, message_id: Int }).passthrough();

function forwardMessageMethod(c: BotCall) {
  const p = parseParams(forwardSchema, c.params);
  const to = resolveChat(c.bot, p.chat_id);
  const from = resolveChat(c.bot, p.from_chat_id);
  const out = forwardMessages([p.message_id], from.id, to.id, c.user);
  if (!out.length) throw badReq('message to forward not found');
  return apiMessage(getMessageRow(out[0]!.id)!, c.bot.user_id);
}

function forwardMessagesMethod(c: BotCall) {
  const p = parseParams(z.object({ chat_id: ChatId, from_chat_id: ChatId, message_ids: Json(z.array(Int).min(1).max(100)) }).passthrough(), c.params);
  const to = resolveChat(c.bot, p.chat_id);
  const from = resolveChat(c.bot, p.from_chat_id);
  return forwardMessages(p.message_ids, from.id, to.id, c.user).map((m) => ({ message_id: m.id }));
}

/** copyMessage: the same text, files, sticker, poll or checklist as a new message of the bot (no "forwarded from"). */
function copyOne(c: BotCall, from: ChatRow, to: ChatRow, id: number, p: SendFields & { caption?: string; parse_mode?: string; caption_entities?: unknown }): MessageRow {
  const row = getMessageRow(id);
  if (!row || row.chat_id !== from.id || row.kind === 'service' || row.kind === 'transfer' || row.kind === 'fund') throw badReq('message to copy not found');
  const text = p.caption !== undefined ? nativeText(p.caption, p.parse_mode, p.caption_entities as ApiEntity[] | undefined).trim() : row.text;
  const mk = parseReplyMarkup(p.reply_markup);
  let dto;
  if (row.kind === 'poll' && row.poll_id) {
    const poll = db.prepare('SELECT * FROM polls WHERE id = ?').get(row.poll_id) as {
      question: string;
      options: string;
      anonymous: number;
      multiple: number;
      quiz: number;
      correct_option: number | null;
      explanation: string;
    };
    dto = createPoll(to.id, c.user, {
      question: poll.question,
      options: JSON.parse(poll.options) as string[],
      anonymous: !!poll.anonymous,
      multiple: !!poll.multiple,
      quiz: !!poll.quiz,
      correctOption: poll.correct_option,
      explanation: poll.explanation,
      closePeriod: null,
      replyToId: replyTarget(to, p),
      replyMarkup: inlineJson(mk),
    });
  } else if (row.kind === 'checklist' && row.extra_id) {
    const l = db.prepare('SELECT title, others_can_add FROM checklists WHERE id = ?').get(row.extra_id) as { title: string; others_can_add: number };
    const items = (db.prepare('SELECT text FROM checklist_items WHERE checklist_id = ? ORDER BY position, id').all(row.extra_id) as { text: string }[]).map((r) => r.text);
    dto = createChecklist(to.id, c.user, { title: l.title, items, othersCanAdd: !!l.others_can_add, replyMarkup: inlineJson(mk) });
  } else {
    const files = db
      .prepare('SELECT f.* FROM message_files mf JOIN files f ON f.id = mf.file_id WHERE mf.message_id = ? ORDER BY mf.position')
      .all(row.id) as FileRow[];
    const sticker = row.kind === 'sticker' && row.sticker ? { sticker: row.sticker, emoji: row.text, packId: row.extra_id } : undefined;
    dto = sendPrepared(to, c.user, { text, files, sticker, replyToId: replyTarget(to, p), silent: p.disable_notification, replyMarkup: inlineJson(mk) });
  }
  applyChatKeyboard(to, c.user, mk, dto.id);
  return getMessageRow(dto.id)!;
}

const copySchema = z
  .object({ ...replyFields, from_chat_id: ChatId, message_id: Int, caption: Str.optional(), parse_mode: Str.optional(), caption_entities: Entities.optional() })
  .passthrough();

function copyMessageMethod(c: BotCall) {
  const p = parseParams(copySchema, c.params);
  const to = resolveChat(c.bot, p.chat_id);
  const from = resolveChat(c.bot, p.from_chat_id);
  return { message_id: copyOne(c, from, to, p.message_id, p).id };
}

function copyMessagesMethod(c: BotCall) {
  const p = parseParams(z.object({ ...replyFields, from_chat_id: ChatId, message_ids: Json(z.array(Int).min(1).max(100)) }).passthrough(), c.params);
  const to = resolveChat(c.bot, p.chat_id);
  const from = resolveChat(c.bot, p.from_chat_id);
  return p.message_ids.map((id) => ({ message_id: copyOne(c, from, to, id, { ...p, reply_to_message_id: undefined, reply_parameters: undefined, reply_markup: undefined }).id }));
}

// ---------- reactions, pins, actions ----------

function setReactionMethod(c: BotCall) {
  const p = parseParams(
    z.object({ chat_id: ChatId, message_id: Int, reaction: Json(z.array(z.object({ type: z.string(), emoji: Str.optional() }).passthrough())).optional(), is_big: Bool.optional() }).passthrough(),
    c.params,
  );
  const chat = resolveChat(c.bot, p.chat_id);
  const row = getMessageRow(p.message_id);
  if (!row || row.chat_id !== chat.id) throw badReq('message not found');
  // one reaction per person on a message, so the first one counts
  const emoji = p.reaction?.find((r) => r.type === 'emoji')?.emoji ?? null;
  if (emoji && !(REACTIONS as readonly string[]).includes(emoji)) throw badReq('REACTION_INVALID');
  setReaction(row.id, c.user, emoji);
  return true;
}

function pinMethod(c: BotCall, pinned: boolean) {
  const p = parseParams(z.object({ chat_id: ChatId, message_id: Int.optional() }).passthrough(), c.params);
  const chat = resolveChat(c.bot, p.chat_id);
  if (p.message_id) {
    setPinned(chat.id, p.message_id, c.user, pinned);
    return true;
  }
  if (pinned) throw badReq('message_id is empty');
  // no message_id: the latest pinned one
  const last = db.prepare('SELECT message_id FROM pinned_messages WHERE chat_id = ? ORDER BY message_id DESC LIMIT 1').get(chat.id) as { message_id: number } | undefined;
  if (last) setPinned(chat.id, last.message_id, c.user, false);
  return true;
}

function unpinAllMethod(c: BotCall) {
  const p = parseParams(z.object({ chat_id: ChatId }).passthrough(), c.params);
  const chat = resolveChat(c.bot, p.chat_id);
  const ids = db.prepare('SELECT message_id FROM pinned_messages WHERE chat_id = ?').all(chat.id) as { message_id: number }[];
  for (const r of ids) setPinned(chat.id, r.message_id, c.user, false);
  return true;
}

function chatActionMethod(c: BotCall) {
  const p = parseParams(z.object({ chat_id: ChatId, action: Str }).passthrough(), c.params);
  const chat = resolveChat(c.bot, p.chat_id);
  // typing, upload_photo, record_voice…: all show «печатает…»
  if (chat.type !== 'channel') toChatExcept(chat.id, c.user.id, EV.typing, { chatId: chat.id, userId: c.user.id });
  return true;
}

// ---------- chats and their people ----------

const chatRef = z.object({ chat_id: ChatId }).passthrough();
const memberRef = z.object({ chat_id: ChatId, user_id: Int }).passthrough();

function groupChat(c: BotCall, raw: unknown): ChatRow {
  const chat = resolveChat(c.bot, raw);
  if (chat.type === 'private') throw badReq('chat is not a group or a channel');
  return chat;
}

function getChatMethod(c: BotCall) {
  const p = parseParams(chatRef, c.params);
  const chat = resolveChat(c.bot, p.chat_id);
  const base = apiChat(chat, c.user.id);
  if (chat.type === 'private') {
    const peer = getUserRow(base.id);
    return { ...base, ...(peer?.bio ? { bio: peer.bio } : {}), max_reaction_count: 1 };
  }
  const pinned = db
    .prepare('SELECT m.* FROM pinned_messages p JOIN messages m ON m.id = p.message_id WHERE p.chat_id = ? ORDER BY m.id DESC LIMIT 1')
    .get(chat.id) as MessageRow | undefined;
  const perms = parsePerms(chat);
  const me = membership(chat, c.user);
  return {
    ...base,
    ...(chat.description ? { description: chat.description } : {}),
    ...(me.canInvite && chat.invite_token ? { invite_link: `${c.origin}/join/${chat.invite_token}` } : {}),
    ...(pinned ? { pinned_message: apiMessage(pinned, c.user.id, { shallow: true }) } : {}),
    permissions: {
      can_send_messages: perms.sendMessages,
      can_send_audios: perms.sendMedia,
      can_send_documents: perms.sendMedia,
      can_send_photos: perms.sendMedia,
      can_send_videos: perms.sendMedia,
      can_send_polls: perms.sendPolls,
      can_invite_users: perms.inviteUsers,
      can_pin_messages: perms.pinMessages,
    },
    ...(chat.slow_mode ? { slow_mode_delay: chat.slow_mode } : {}),
  };
}

function getChatMemberMethod(c: BotCall) {
  const p = parseParams(memberRef, c.params);
  const chat = resolveChat(c.bot, p.chat_id);
  const u = getUserRow(p.user_id);
  if (!u) throw badReq('user not found');
  if (chat.type === 'private') {
    return { status: 'member', user: apiUser(u) };
  }
  return apiChatMember(chat, u);
}

function memberCountMethod(c: BotCall) {
  const chat = resolveChat(c.bot, parseParams(chatRef, c.params).chat_id);
  return (db.prepare('SELECT COUNT(*) c FROM chat_members WHERE chat_id = ?').get(chat.id) as { c: number }).c;
}

function administratorsMethod(c: BotCall) {
  const chat = groupChat(c, parseParams(chatRef, c.params).chat_id);
  const rows = db
    .prepare(`SELECT user_id FROM chat_members WHERE chat_id = ? AND role IN ('owner', 'admin') ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, joined_at`)
    .all(chat.id) as { user_id: number }[];
  return rows.flatMap((r) => {
    const u = getUserRow(r.user_id);
    return u ? [apiChatMember(chat, u)] : [];
  });
}

function leaveChatMethod(c: BotCall) {
  const chat = groupChat(c, parseParams(chatRef, c.params).chat_id);
  const member = getMember(chat.id, c.user.id);
  if (member?.role === 'owner') throw badReq('the owner of a chat cannot leave it');
  removeMember(chat.id, c.user.id);
  const sm = !isChannel(chat) ? serviceMessage(chat.id, c.user.id, txt.service.left(displayName(c.user))) : null;
  botHooks.memberLeft(chat, c.user, c.user, false, sm?.id ?? null);
  toChat(chat.id, EV.membersChanged, { chatId: chat.id });
  broadcastChat(chat.id);
  return true;
}

function untilOf(v: number | undefined): number | null {
  // Telegram: 0, or less than 30 seconds / more than 366 days from now, means "forever"
  if (!v) return null;
  const ms = v * 1000;
  return ms - Date.now() < 30_000 || ms - Date.now() > 366 * 86400_000 ? null : ms;
}

function membersChanged(chatId: number) {
  toChat(chatId, EV.membersChanged, { chatId });
  broadcastChat(chatId);
}

function banMethod(c: BotCall) {
  const p = parseParams(z.object({ chat_id: ChatId, user_id: Int, until_date: Int.optional(), revoke_messages: Bool.optional() }).passthrough(), c.params);
  const chat = groupChat(c, p.chat_id);
  requireRight(chat, c.user, 'banUsers');
  const target = getUserRow(p.user_id);
  if (!target) throw badReq('user not found');
  const member = getMember(chat.id, target.id);
  if (target.id === c.user.id || !canActOn(chat, c.user, member)) throw forbiddenReq('not enough rights to restrict/unrestrict chat member');
  const until = untilOf(p.until_date);
  db.prepare(
    `INSERT INTO chat_bans (chat_id, user_id, banned_by, until, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chat_id, user_id) DO UPDATE SET until = excluded.until, banned_by = excluded.banned_by`,
  ).run(chat.id, target.id, c.user.id, until, now());
  if (member) {
    removeMember(chat.id, target.id);
    const sm = !isChannel(chat)
      ? serviceMessage(chat.id, c.user.id, txt.service.banned(displayName(c.user), displayName(target), until ? txt.service.until(new Date(until).toLocaleString(txt.locale, { dateStyle: 'short', timeStyle: 'short' })) : txt.service.forever))
      : null;
    botHooks.memberLeft(chat, c.user, target, true, sm?.id ?? null);
  }
  membersChanged(chat.id);
  return true;
}

function unbanMethod(c: BotCall) {
  const p = parseParams(z.object({ chat_id: ChatId, user_id: Int, only_if_banned: Bool.optional() }).passthrough(), c.params);
  const chat = groupChat(c, p.chat_id);
  requireRight(chat, c.user, 'banUsers');
  db.prepare('DELETE FROM chat_bans WHERE chat_id = ? AND user_id = ?').run(chat.id, p.user_id);
  // like in Telegram, a member who is not banned is removed unless only_if_banned is set... here nobody is removed
  return true;
}

/** restrictChatMember: here a person can only be muted (can_send_messages false) or let write again. */
function restrictMethod(c: BotCall) {
  const p = parseParams(
    z.object({ chat_id: ChatId, user_id: Int, permissions: Json(z.object({ can_send_messages: Bool.optional() }).passthrough()), until_date: Int.optional() }).passthrough(),
    c.params,
  );
  const chat = groupChat(c, p.chat_id);
  if (chat.type !== 'group') throw badReq('only members of a group can be restricted');
  requireRight(chat, c.user, 'banUsers');
  const member = getMember(chat.id, p.user_id);
  if (!member) throw badReq('user is not a member of the chat');
  if (!canActOn(chat, c.user, member)) throw forbiddenReq('not enough rights to restrict/unrestrict chat member');
  const mute = p.permissions.can_send_messages === false;
  const until = untilOf(p.until_date);
  db.prepare('UPDATE chat_members SET muted_until = ? WHERE chat_id = ? AND user_id = ?').run(mute ? (until ?? 253402300799000) : null, chat.id, p.user_id);
  membersChanged(chat.id);
  return true;
}

const RIGHTS: Record<string, keyof AdminRights> = {
  can_change_info: 'changeInfo',
  can_delete_messages: 'deleteMessages',
  can_restrict_members: 'banUsers',
  can_invite_users: 'inviteUsers',
  can_pin_messages: 'pinMessages',
  can_promote_members: 'addAdmins',
  can_post_messages: 'postMessages',
  can_edit_messages: 'editMessages',
};

function promoteMethod(c: BotCall) {
  const shape: Record<string, z.ZodTypeAny> = { chat_id: ChatId, user_id: Int };
  for (const k of Object.keys(RIGHTS)) shape[k] = Bool.optional();
  const p = parseParams(z.object(shape).passthrough(), c.params) as Record<string, unknown> & { chat_id: string | number; user_id: number };
  const chat = groupChat(c, p.chat_id);
  const mine = requireRight(chat, c.user, 'addAdmins');
  const target = getMember(chat.id, p.user_id);
  if (!target) throw badReq('user is not a member of the chat');
  if (!canActOn(chat, c.user, target) || target.role === 'owner') throw forbiddenReq('not enough rights to promote chat member');
  const actorIsOwner = getMember(chat.id, c.user.id)?.role === 'owner';
  const rights = { ...NO_RIGHTS } as AdminRights;
  for (const [k, right] of Object.entries(RIGHTS)) {
    // an administrator can hand out only the rights they have
    rights[right] = p[k] === true && (actorIsOwner || mine[right]);
  }
  const admin = Object.values(rights).some(Boolean);
  db.prepare('UPDATE chat_members SET role = ?, admin_rights = ?, custom_title = CASE WHEN ? THEN custom_title ELSE \'\' END WHERE chat_id = ? AND user_id = ?').run(
    admin ? 'admin' : 'member',
    admin ? JSON.stringify(rights) : '{}',
    admin ? 1 : 0,
    chat.id,
    p.user_id,
  );
  membersChanged(chat.id);
  return true;
}

function setPermissionsMethod(c: BotCall) {
  const p = parseParams(z.object({ chat_id: ChatId, permissions: Json(z.record(z.unknown())) }).passthrough(), c.params);
  const chat = groupChat(c, p.chat_id);
  if (chat.type !== 'group') throw badReq('permissions can be set only in a group');
  requireRight(chat, c.user, 'changeInfo');
  const cur = parsePerms(chat);
  const has = (k: string) => (p.permissions[k] === undefined ? undefined : p.permissions[k] === true);
  const media = ['can_send_audios', 'can_send_documents', 'can_send_photos', 'can_send_videos'].map(has).find((v) => v !== undefined);
  const next = {
    sendMessages: has('can_send_messages') ?? cur.sendMessages,
    sendMedia: media ?? cur.sendMedia,
    sendPolls: has('can_send_polls') ?? cur.sendPolls,
    inviteUsers: has('can_invite_users') ?? cur.inviteUsers,
    pinMessages: has('can_pin_messages') ?? cur.pinMessages,
  };
  db.prepare('UPDATE chats SET default_permissions = ? WHERE id = ?').run(JSON.stringify(next), chat.id);
  broadcastChat(chat.id);
  return true;
}

function setTitleMethod(c: BotCall) {
  const p = parseParams(z.object({ chat_id: ChatId, title: Str }).passthrough(), c.params);
  const chat = groupChat(c, p.chat_id);
  requireRight(chat, c.user, 'changeInfo');
  const title = p.title.trim();
  if (!title || title.length > 64) throw badReq('chat title must be 1-64 characters');
  if (title !== chat.title) {
    db.prepare('UPDATE chats SET title = ? WHERE id = ?').run(title, chat.id);
    serviceMessage(chat.id, c.user.id, isChannel(chat) ? txt.service.channelRenamed(title) : txt.service.renamed(displayName(c.user), title));
    broadcastChat(chat.id);
  }
  return true;
}

function setDescriptionMethod(c: BotCall) {
  const p = parseParams(z.object({ chat_id: ChatId, description: Str.optional() }).passthrough(), c.params);
  const chat = groupChat(c, p.chat_id);
  requireRight(chat, c.user, 'changeInfo');
  const description = (p.description ?? '').trim();
  if (description.length > 255) throw badReq('chat description is too long: at most 255 characters');
  db.prepare('UPDATE chats SET description = ? WHERE id = ?').run(description, chat.id);
  broadcastChat(chat.id);
  return true;
}

function inviteLinkMethod(c: BotCall) {
  const chat = groupChat(c, parseParams(chatRef, c.params).chat_id);
  requireRight(chat, c.user, 'inviteUsers');
  return `${c.origin}/join/${chat.invite_token}`;
}

/** The profile pictures of a person: here there is one at most. */
function profilePhotosMethod(c: BotCall) {
  const p = parseParams(z.object({ user_id: Int }).passthrough(), c.params);
  const u = getUserRow(p.user_id);
  if (!u) throw badReq('user not found');
  const f = u.avatar_file_id ? (db.prepare('SELECT * FROM files WHERE id = ?').get(u.avatar_file_id) as FileRow | undefined) : undefined;
  return {
    total_count: f ? 1 : 0,
    photos: f ? [[{ file_id: f.id, file_unique_id: f.id, file_size: f.size, width: f.width ?? 0, height: f.height ?? 0 }]] : [],
  };
}

function getFileMethod(c: BotCall) {
  const p = parseParams(z.object({ file_id: Str }).passthrough(), c.params);
  const f = fileForBot(c.bot, p.file_id);
  return { file_id: f.id, file_unique_id: f.id, file_size: f.size, file_path: f.path };
}

// ---------- the bot itself ----------

function setMyCommandsMethod(c: BotCall) {
  const p = parseParams(z.object({ commands: Json(z.array(z.object({ command: Str, description: Str }).passthrough())) }).passthrough(), c.params);
  const r = checkCommands(p.commands);
  if (typeof r === 'string') {
    throw badReq(
      r === 'name'
        ? 'command must be 1-32 characters long and contain only lowercase English letters, digits and underscores'
        : r === 'description'
          ? 'command description must be 1-256 characters long'
          : r === 'tooMany'
            ? 'too many commands: at most 100'
            : 'command names must be unique',
    );
  }
  setBotCommands(c.bot, r);
  return true;
}

const nameField = (field: 'name' | 'description' | 'short_description') => ({
  set: (c: BotCall) => {
    const p = parseParams(z.object({ [field]: Str.optional(), language_code: Str.optional() }).passthrough(), c.params) as Record<string, string | undefined>;
    const v = (p[field] ?? '').trim();
    if (field === 'name') {
      if (!v) throw badReq('bot name must not be empty');
      setBotName(c.bot, v);
    } else if (field === 'description') setBotDescription(c.bot, v);
    else setBotAbout(c.bot, v);
    return true;
  },
  get: (c: BotCall) => {
    const u = getUserRow(c.bot.user_id)!;
    const value = field === 'name' ? u.first_name : field === 'description' ? c.bot.description : u.bio;
    return { [field]: value };
  },
});

// ---------- the method table ----------

const name = {
  name: nameField('name'),
  description: nameField('description'),
  short: nameField('short_description'),
};

const METHODS: Record<string, Method> = {
  getme: (c) => ({
    ...apiUser(c.user),
    can_join_groups: !!c.bot.can_join_groups,
    can_read_all_group_messages: !c.bot.privacy_mode,
    supports_inline_queries: false,
  }),
  logout: () => true,
  close: () => true,

  // updates
  getupdates: (c) => {
    const p = parseParams(
      z.object({ offset: Int.optional(), limit: IntIn(1, 100).optional(), timeout: IntIn(0).optional(), allowed_updates: Json(z.array(Str)).optional() }).passthrough(),
      c.params,
    );
    return getUpdates(c.bot, { offset: p.offset, limit: p.limit ?? 100, timeout: p.timeout ?? 0, allowed: p.allowed_updates });
  },
  setwebhook: (c) => {
    const p = parseParams(
      z.object({ url: Str, secret_token: Str.optional(), allowed_updates: Json(z.array(Str)).optional(), drop_pending_updates: Bool.optional() }).passthrough(),
      c.params,
    );
    setWebhook(c.bot, p.url, p.secret_token ?? null, p.allowed_updates, !!p.drop_pending_updates);
    return true;
  },
  deletewebhook: (c) => {
    const p = parseParams(z.object({ drop_pending_updates: Bool.optional() }).passthrough(), c.params);
    setWebhook(c.bot, '', null, undefined, !!p.drop_pending_updates);
    return true;
  },
  getwebhookinfo: (c) => webhookInfo(c.bot),
  answercallbackquery: (c) => {
    const p = parseParams(
      z.object({ callback_query_id: Str, text: Str.optional(), show_alert: Bool.optional(), url: Str.optional(), cache_time: Int.optional() }).passthrough(),
      c.params,
    );
    answerCallback(c.bot.user_id, p.callback_query_id, { text: p.text?.slice(0, 200), show_alert: p.show_alert, url: p.url });
    return true;
  },

  ...MONEY,

  // sending
  sendmessage: sendMessageMethod,
  sendphoto: (c) => sendMediaMethod(c, 'photo', 'photo'),
  senddocument: (c) => sendMediaMethod(c, 'document', 'document'),
  sendaudio: (c) => sendMediaMethod(c, 'audio', 'document'),
  sendvideo: (c) => sendMediaMethod(c, 'video', 'video'),
  sendanimation: (c) => sendMediaMethod(c, 'animation', 'animation'),
  sendvoice: (c) => sendMediaMethod(c, 'voice', 'voice'),
  sendvideonote: (c) => sendMediaMethod(c, 'video_note', 'round'),
  sendmediagroup: sendMediaGroupMethod,
  sendsticker: sendStickerMethod,
  sendpoll: sendPollMethod,
  sendchecklist: sendChecklistMethod,
  editmessagechecklist: editChecklistMethod,
  stoppoll: (c) => {
    const p = parseParams(messageRefSchema, c.params);
    const chat = resolveChat(c.bot, p.chat_id);
    const row = getMessageRow(p.message_id);
    if (!row || row.chat_id !== chat.id || !row.poll_id) throw badReq('poll not found');
    stopPoll(row.id, c.user);
    return apiPoll(row.poll_id, c.bot.user_id);
  },
  forwardmessage: forwardMessageMethod,
  forwardmessages: forwardMessagesMethod,
  copymessage: copyMessageMethod,
  copymessages: copyMessagesMethod,
  sendchataction: chatActionMethod,
  setmessagereaction: setReactionMethod,

  // changing
  editmessagetext: (c) => editMessageMethod(c, 'text'),
  editmessagecaption: (c) => editMessageMethod(c, 'caption'),
  editmessagereplymarkup: (c) => editMessageMethod(c, 'markup'),
  deletemessage: deleteMessageMethod,
  deletemessages: deleteMessagesMethod,
  pinchatmessage: (c) => pinMethod(c, true),
  unpinchatmessage: (c) => pinMethod(c, false),
  unpinallchatmessages: unpinAllMethod,

  // chats
  getchat: getChatMethod,
  getuserbyusername: getUserByUsernameMethod,
  getchatmember: getChatMemberMethod,
  getchatmembercount: memberCountMethod,
  getchatmemberscount: memberCountMethod,
  getchatadministrators: administratorsMethod,
  leavechat: leaveChatMethod,
  banchatmember: banMethod,
  kickchatmember: banMethod,
  unbanchatmember: unbanMethod,
  restrictchatmember: restrictMethod,
  promotechatmember: promoteMethod,
  setchatpermissions: setPermissionsMethod,
  setchattitle: setTitleMethod,
  setchatdescription: setDescriptionMethod,
  exportchatinvitelink: inviteLinkMethod,
  getuserprofilephotos: profilePhotosMethod,
  getfile: getFileMethod,

  // the bot's own profile
  setmycommands: setMyCommandsMethod,
  getmycommands: (c) => botCommands(c.bot).map((x) => ({ command: x.command, description: x.description })),
  deletemycommands: (c) => {
    setBotCommands(c.bot, []);
    return true;
  },
  setmyname: name.name.set,
  getmyname: name.name.get,
  setmydescription: name.description.set,
  getmydescription: name.description.get,
  setmyshortdescription: name.short.set,
  getmyshortdescription: name.short.get,
  // the «Меню» button always lists the commands
  getchatmenubutton: () => ({ type: 'commands' }),
  setchatmenubutton: (c) => {
    const p = parseParams(z.object({ menu_button: Json(z.object({ type: Str }).passthrough()).optional() }).passthrough(), c.params);
    if (p.menu_button && p.menu_button.type !== 'commands' && p.menu_button.type !== 'default') throw badReq('only the "commands" menu button is supported');
    return true;
  },
};

export const botMethodNames = Object.keys(METHODS);

export async function callBotMethod(bot: BotRow, method: string, params: Record<string, unknown>, uploads: Map<string, PendingUpload>, origin: string): Promise<unknown> {
  const fn = METHODS[method.toLowerCase()];
  if (!fn) throw new BotApiError(404, 'Not Found');
  const user = getUserRow(bot.user_id);
  if (!user) throw new BotApiError(401, 'Unauthorized');
  try {
    return await fn({ bot, user, params, uploads, origin });
  } catch (e) {
    if (e instanceof HttpError) throw fromHttpError(e);
    throw e;
  }
}
