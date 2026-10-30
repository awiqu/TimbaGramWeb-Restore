import type { MessageSearchResult, ReaderDTO } from '@timba/shared';
import { EV, HASHTAG_RE, MESSAGES_PAGE, READERS_DAYS, READERS_MAX_MEMBERS, queryHashtags, stripFormatting } from '@timba/shared';
import { isAdmin } from '../auth.js';
import { db, now } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import {
  type ChatRow,
  assertSlowMode,
  getChat,
  getMember,
  isChannel,
  membership,
  notMutedSql,
  requireView,
  rightsOf,
} from '../permissions.js';
import { botHooks } from '../bots/hooks.js';
import { notifyNewMessage } from '../push.js';
import { chatDTO } from './chats.js';
import { toChat, toChatExcept, toUser } from '../realtime.js';
import {
  type FileRow,
  type MessageRow,
  type UserRow,
  displayName,
  getMessageRow,
  getUserRow,
  isBlockedBy,
  messageDTO,
  messagesDTO,
  userDTO,
  usersByIds,
} from '../serialize.js';
import { restorePrivate, serviceMessage, touchChat } from './chats.js';
import { resolveSticker } from './stickers.js';
import { txt } from '../strings.js';
import { encryptText } from '../crypt.js';

export interface ListOptions {
  before?: number;
  after?: number;
  /** load a window centered on this message */
  around?: number;
  /** load a window around the first message sent at or after this time */
  date?: number;
  limit?: number;
  /** comments under a channel post instead of the main feed */
  threadId?: number;
}

export function listMessages(chatId: number, viewer: UserRow, opts: ListOptions) {
  const limit = Math.min(Math.max(opts.limit ?? MESSAGES_PAGE, 1), 100);
  const where = `chat_id = @chat AND ${opts.threadId ? 'thread_id = @thread' : 'thread_id IS NULL'}
    AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = messages.id AND h.user_id = @viewer)`;
  const params = { chat: chatId, thread: opts.threadId ?? null, viewer: viewer.id, limit };
  const older = (before: number, n: number) =>
    (
      db
        .prepare(`SELECT * FROM messages WHERE ${where} AND id < @before ORDER BY id DESC LIMIT @n`)
        .all({ ...params, before, n }) as MessageRow[]
    ).reverse();
  const newer = (after: number, n: number) =>
    db
      .prepare(`SELECT * FROM messages WHERE ${where} AND id > @after ORDER BY id ASC LIMIT @n`)
      .all({ ...params, after, n }) as MessageRow[];

  let around = opts.around;
  if (!around && opts.date) {
    const first = db
      .prepare(`SELECT id FROM messages WHERE ${where} AND created_at >= @date ORDER BY id ASC LIMIT 1`)
      .get({ ...params, date: opts.date }) as { id: number } | undefined;
    around = first?.id;
    if (!around) return messagesDTO(older(Number.MAX_SAFE_INTEGER, limit), viewer.id);
  }

  let rows: MessageRow[];
  if (around) {
    const half = Math.floor(limit / 2);
    rows = [...older(around + 1, half + 1), ...newer(around, half)];
  } else if (opts.after) {
    rows = newer(opts.after, limit);
  } else {
    rows = older(opts.before ?? Number.MAX_SAFE_INTEGER, limit);
  }
  return messagesDTO(rows, viewer.id);
}

/** Words of the query: `Привет, мир` -> [`привет`, `мир`] (every one must start some word of the message). */
function queryWords(q: string): string[] {
  return q
    .toLowerCase()
    .split(/\s+/)
    .flatMap((w) => w.match(/[\p{L}\p{N}]+/gu) ?? [])
    .slice(0, 8);
}

/** The texts are encrypted in the database, so the search reads them in batches and compares them here. */
const SEARCH_PAGE = 40;
const SEARCH_BATCH = 500;
/** how many messages one search looks through at most, newest first */
const SEARCH_SCAN_MAX = 100_000;

/** Search in one chat (chatId) or in every chat the viewer is a member of. */
export function searchMessages(
  viewer: UserRow,
  q: string,
  opts: { chatId?: number; before?: number; fromId?: number },
): MessageSearchResult {
  const words = queryWords(q);
  // without words only "everything from this person" in one chat makes sense
  if (!words.length && !(opts.fromId && opts.chatId)) return { messages: [], hasMore: false };
  if (opts.chatId) requireView(opts.chatId, viewer);
  // "#новости" finds the tag itself, not every "новости"
  const tags = queryHashtags(q);
  const params = { chat: opts.chatId ?? null, from: opts.fromId ?? null, viewer: viewer.id, limit: SEARCH_BATCH };
  const batch = db.prepare(
    `SELECT m.* FROM messages m
     WHERE m.id < @before AND m.thread_id IS NULL AND m.kind != 'service' AND m.text != ''
     ${opts.fromId ? 'AND m.sender_id = @from' : ''}
     AND ${opts.chatId ? 'm.chat_id = @chat' : 'm.chat_id IN (SELECT chat_id FROM chat_members WHERE user_id = @viewer)'}
     AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = @viewer)
     ORDER BY m.id DESC LIMIT @limit`,
  );
  const found: MessageRow[] = [];
  let before = opts.before ?? Number.MAX_SAFE_INTEGER;
  let scanned = 0;
  while (found.length <= SEARCH_PAGE && scanned < SEARCH_SCAN_MAX) {
    const rows = batch.all({ ...params, before }) as MessageRow[];
    if (!rows.length) break;
    for (const r of rows) {
      if (matches(r.text, words, tags)) found.push(r);
      if (found.length > SEARCH_PAGE) break;
    }
    scanned += rows.length;
    before = rows[rows.length - 1]!.id;
    if (rows.length < SEARCH_BATCH) break;
  }
  return { messages: messagesDTO(found.slice(0, SEARCH_PAGE), viewer.id), hasMore: found.length > SEARCH_PAGE };
}

/** All the words start some word of the text (case-insensitive), and the exact #tags are there. */
function matches(text: string, words: string[], tags: string[]): boolean {
  const lower = text.toLowerCase();
  if (tags.length) {
    const have = new Set(lower.match(HASHTAG_RE) ?? []);
    if (!tags.every((t) => have.has(t))) return false;
  }
  if (!words.length) return true;
  const tokens = lower.match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.every((w) => tokens.some((t) => t.startsWith(w)));
}

export function loadOwnFiles(fileIds: string[], user: UserRow): FileRow[] {
  if (!fileIds.length) return [];
  const rows = db
    .prepare(`SELECT * FROM files WHERE id IN (${fileIds.map(() => '?').join(',')})`)
    .all(...fileIds) as FileRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  return fileIds.map((id) => {
    const f = byId.get(id);
    if (!f || f.uploader_id !== user.id) throw badRequest(txt.errors.fileNotFound);
    return f;
  });
}

export function insertMessage(
  chat: ChatRow,
  sender: UserRow,
  data: {
    text: string;
    replyToId?: number | null;
    files: FileRow[];
    fwdId?: number | null;
    fwdName?: string | null;
    pollId?: number | null;
    threadId?: number | null;
    silent?: boolean;
    /** cards: transfer / fund / checklist with the id of their row; a sticker with its pack */
    kind?: 'transfer' | 'fund' | 'checklist' | 'sticker';
    extraId?: number | null;
    /** kind "sticker": "tg:<key>" or the picture's file id */
    sticker?: string;
    /** a bot's inline keyboard: JSON of InlineKeyboardDTO */
    replyMarkup?: string | null;
  },
): MessageRow {
  const t = now();
  const id = db.transaction(() => {
    const res = db
      .prepare(
        `INSERT INTO messages (chat_id, sender_id, kind, text, reply_to_id, forwarded_from_id, forwarded_from_name,
           signature, poll_id, thread_id, created_at, silent, expires_at, extra_id, sticker, reply_markup)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        chat.id,
        sender.id,
        data.kind ?? (data.pollId ? 'poll' : data.files.length ? 'media' : 'text'),
        encryptText(data.text),
        data.replyToId ?? null,
        data.fwdId ?? null,
        data.fwdName ?? null,
        isChannel(chat) && chat.sign_messages && !data.threadId ? displayName(sender) : null,
        data.pollId ?? null,
        data.threadId ?? null,
        t,
        data.silent ? 1 : 0,
        // the chat's auto-delete timer starts when the message is sent
        chat.auto_delete ? t + chat.auto_delete * 1000 : null,
        data.extraId ?? null,
        data.sticker ?? null,
        data.replyMarkup ?? null,
      );
    const mid = Number(res.lastInsertRowid);
    const ins = db.prepare('INSERT INTO message_files (message_id, file_id, position) VALUES (?, ?, ?)');
    data.files.forEach((f, i) => ins.run(mid, f.id, i));
    if (!data.threadId) {
      db.prepare('UPDATE chat_members SET last_read_id = ? WHERE chat_id = ? AND user_id = ?').run(mid, chat.id, sender.id);
      touchChat(chat.id, t);
      // a new message brings an archived chat back unless its notifications are off (Telegram)
      db.prepare(`UPDATE chat_members SET archived = 0 WHERE chat_id = ? AND archived = 1 AND ${notMutedSql()}`).run(chat.id);
    }
    // mentions exist in groups and in comments; forwarded text mentions nobody
    if ((chat.type === 'group' || data.threadId) && !data.fwdName) saveMentions(chat, sender, mid, data.text, data.replyToId);
    return mid;
  })();
  return getMessageRow(id)!;
}

const MENTION_RE = /(?:^|[^a-zA-Z0-9_])@([a-zA-Z][a-zA-Z0-9_]{2,31})/g;

/** Members named with @username, plus the author of the replied message. */
function saveMentions(chat: ChatRow, sender: UserRow, messageId: number, text: string, replyToId?: number | null) {
  const ids = new Set<number>();
  const names = [...new Set([...text.matchAll(MENTION_RE)].map((m) => m[1]!.toLowerCase()))].slice(0, 50);
  if (names.length) {
    const rows = db
      .prepare(
        `SELECT u.id FROM users u JOIN chat_members m ON m.user_id = u.id AND m.chat_id = ?
         WHERE lower(u.username) IN (${names.map(() => '?').join(',')})`,
      )
      .all(chat.id, ...names) as { id: number }[];
    for (const r of rows) ids.add(r.id);
  }
  if (replyToId) {
    const r = getMessageRow(replyToId);
    if (r?.sender_id && getMember(chat.id, r.sender_id)) ids.add(r.sender_id);
  }
  ids.delete(sender.id);
  const ins = db.prepare('INSERT OR IGNORE INTO message_mentions (message_id, chat_id, user_id) VALUES (?, ?, ?)');
  for (const id of ids) ins.run(messageId, chat.id, id);
}

export function mentionedIn(messageId: number): number[] {
  return (db.prepare('SELECT user_id FROM message_mentions WHERE message_id = ?').all(messageId) as { user_id: number }[]).map(
    (r) => r.user_id,
  );
}

/**
 * Deliver a freshly inserted message: everybody in the chat gets the public version,
 * the sender gets a personalized one (own poll votes, own authorship in channels).
 * Returns the sender's version.
 */
export function publishMessage(chat: ChatRow, sender: UserRow, row: MessageRow, clientId?: string) {
  const own = { ...messageDTO(row, sender.id), clientId };
  const pub = { ...messageDTO(row), clientId };
  toChatExcept(chat.id, sender.id, EV.messageNew, pub);
  toUser(sender.id, EV.messageNew, own);
  notifyNewMessage(chat, sender, pub, mentionedIn(row.id));
  botHooks.newMessage(chat, sender, row);
  return own;
}

/** In a private chat nobody writes past a block, in either direction. */
export function assertNotBlocked(chat: ChatRow, user: UserRow) {
  if (chat.type !== 'private') return;
  const peer = (
    db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id != ?').get(chat.id, user.id) as
      | { user_id: number }
      | undefined
  )?.user_id;
  if (!peer) return;
  if (isBlockedBy(user.id, peer)) throw forbidden(txt.errors.youBlocked, 'you_blocked');
  if (isBlockedBy(peer, user.id)) throw forbidden(txt.errors.blockedByUser, 'blocked_by_user');
}

export function replyTarget(chat: ChatRow, replyToId: number | null | undefined): number | null {
  if (!replyToId) return null;
  const r = getMessageRow(replyToId);
  return r && r.chat_id === chat.id ? r.id : null;
}

export function sendMessage(
  chatId: number,
  user: UserRow,
  input: {
    text: string;
    replyToId?: number | null;
    fileIds: string[];
    clientId?: string;
    threadId?: number | null;
    silent?: boolean;
    stickerId?: string | null;
    /** a bot's inline keyboard: JSON of InlineKeyboardDTO */
    replyMarkup?: string | null;
  },
) {
  const chat = requireView(chatId, user);
  restorePrivate(chat);
  if (input.threadId) return sendComment(chat, user, input as typeof input & { threadId: number });
  const me = membership(chat, user);
  if (!me.canSend) throw forbidden(me.mutedUntil ? txt.errors.cannotWriteMuted : txt.errors.cannotWrite);
  // a sticker is media, like in Telegram
  if ((input.fileIds.length || input.stickerId) && !me.canSendMedia) throw forbidden(txt.errors.mediaForbidden);
  assertNotBlocked(chat, user);
  assertSlowMode(chat, user);
  const row = insertMessage(chat, user, {
    replyToId: replyTarget(chat, input.replyToId),
    silent: input.silent,
    replyMarkup: input.replyMarkup,
    ...messageContent(input, user),
  });
  return publishMessage(chat, user, row, input.clientId);
}

/**
 * Send a message whose files are already rows of "files" (a bot sends a file it got in a chat, or one it
 * uploaded itself), or a sticker. The same rules as for a person: may write, may send media, blocks, slow mode.
 */
export function sendPrepared(
  chat: ChatRow,
  user: UserRow,
  input: {
    text: string;
    files: FileRow[];
    replyToId?: number | null;
    silent?: boolean;
    replyMarkup?: string | null;
    sticker?: { sticker: string; emoji: string; packId: number | null };
  },
) {
  restorePrivate(chat);
  const me = membership(chat, user);
  if (!me.canSend) throw forbidden(me.mutedUntil ? txt.errors.cannotWriteMuted : txt.errors.cannotWrite);
  if ((input.files.length || input.sticker) && !me.canSendMedia) throw forbidden(txt.errors.mediaForbidden);
  assertNotBlocked(chat, user);
  assertSlowMode(chat, user);
  const row = insertMessage(chat, user, {
    text: input.sticker ? input.sticker.emoji : input.text,
    files: input.sticker ? [] : input.files,
    replyToId: replyTarget(chat, input.replyToId),
    silent: input.silent,
    replyMarkup: input.replyMarkup,
    ...(input.sticker ? { kind: 'sticker' as const, sticker: input.sticker.sticker, extraId: input.sticker.packId } : {}),
  });
  return publishMessage(chat, user, row);
}

/** Text with files, or a sticker alone (its emoji becomes the text). */
function messageContent(input: { text: string; fileIds: string[]; stickerId?: string | null }, user: UserRow) {
  if (input.stickerId) {
    const s = resolveSticker(input.stickerId);
    return { text: s.emoji, files: [], kind: 'sticker' as const, sticker: s.sticker, extraId: s.packId };
  }
  return { text: input.text.trim(), files: loadOwnFiles(input.fileIds, user) };
}

/** The channel post whose comments are requested; throws unless comments are open. */
export function requirePost(chat: ChatRow, postId: number): MessageRow {
  const post = getMessageRow(postId);
  if (!post || post.chat_id !== chat.id || post.thread_id !== null || post.kind === 'service') {
    throw notFound(txt.errors.messageNotFound);
  }
  if (!isChannel(chat) || !chat.comments_enabled) throw forbidden(txt.errors.commentsOff);
  return post;
}

/** Channel subscribers may comment; the post shows the new counter to everybody. */
function sendComment(
  chat: ChatRow,
  user: UserRow,
  input: {
    text: string;
    replyToId?: number | null;
    fileIds: string[];
    clientId?: string;
    threadId: number;
    stickerId?: string | null;
  },
) {
  const post = requirePost(chat, input.threadId);
  if (!getMember(chat.id, user.id) && !isAdmin(user)) throw forbidden(txt.errors.subscribeToComment);
  const content = messageContent(input, user);
  let replyToId = input.replyToId ?? null;
  if (replyToId) {
    const r = getMessageRow(replyToId);
    if (!r || (r.thread_id !== post.id && r.id !== post.id)) replyToId = null;
  }
  const row = insertMessage(chat, user, { ...content, replyToId, threadId: post.id });
  const own = publishMessage(chat, user, row, input.clientId);
  postChanged(post.id);
  return own;
}

/** Re-send a post after its comments changed (counter, avatars). */
function postChanged(postId: number) {
  const post = getMessageRow(postId);
  if (post) toChat(post.chat_id, EV.messageEdit, messageDTO(post));
}

export function getMessage(messageId: number, user: UserRow) {
  const m = getMessageRow(messageId);
  if (!m) throw notFound(txt.errors.messageNotFound);
  requireView(m.chat_id, user);
  return messageDTO(m, user.id);
}

export function editMessage(messageId: number, user: UserRow, text: string) {
  const m = getMessageRow(messageId);
  if (!m) throw notFound(txt.errors.messageNotFound);
  if (m.kind === 'poll') throw forbidden(txt.errors.cannotEditPoll);
  if (
    m.kind === 'service' ||
    m.kind === 'transfer' ||
    m.kind === 'fund' ||
    m.kind === 'checklist' ||
    m.kind === 'sticker' ||
    m.forwarded_from_name
  ) {
    throw forbidden(txt.errors.cannotEditMessage);
  }
  const chat = requireView(m.chat_id, user);
  const me = membership(chat, user);
  // in channels admins with the right may edit any post
  const canEdit =
    m.sender_id === user.id
      ? m.thread_id !== null || me.canSend
      : isChannel(chat) && m.thread_id === null && me.rights.editMessages;
  if (!canEdit) throw forbidden(txt.errors.cannotEditMessage);
  const trimmed = text.trim();
  if (!trimmed && m.kind !== 'media') throw badRequest(txt.errors.emptyMessage);
  db.prepare('UPDATE messages SET text = ?, edited_at = ? WHERE id = ?').run(encryptText(trimmed), now(), m.id);
  const row = getMessageRow(m.id)!;
  toChat(m.chat_id, EV.messageEdit, messageDTO(row));
  botHooks.editedMessage(chat, user, row);
  return messageDTO(row, user.id);
}

export function canDeleteForAll(chat: ChatRow, user: UserRow, m: MessageRow): boolean {
  if (m.sender_id === user.id) return true;
  if (chat.type === 'private') return !!getMember(chat.id, user.id);
  return rightsOf(user, chat, getMember(chat.id, user.id)).deleteMessages;
}

export function deleteMessages(ids: number[], user: UserRow, forAll: boolean) {
  const rows = db
    .prepare(`SELECT * FROM messages WHERE id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as MessageRow[];
  const byChat = new Map<number, MessageRow[]>();
  for (const r of rows) byChat.set(r.chat_id, [...(byChat.get(r.chat_id) ?? []), r]);

  for (const [chatId, msgs] of byChat) {
    const chat = requireView(chatId, user);
    if (forAll) {
      for (const m of msgs) if (!canDeleteForAll(chat, user, m)) throw forbidden(txt.errors.cannotDeleteForAll);
    }
    const mids = msgs.map((m) => m.id);
    if (forAll) {
      db.prepare(`DELETE FROM messages WHERE id IN (${mids.map(() => '?').join(',')})`).run(...mids);
      toChat(chatId, EV.messageDelete, { chatId, ids: mids });
      for (const post of new Set(msgs.map((m) => m.thread_id).filter((x): x is number => x !== null))) postChanged(post);
    } else {
      const ins = db.prepare('INSERT OR IGNORE INTO message_hidden (message_id, user_id) VALUES (?, ?)');
      db.transaction(() => mids.forEach((id) => ins.run(id, user.id)))();
      toUser(user.id, EV.messageDelete, { chatId, ids: mids });
    }
  }
}

/** Who may wipe the history of a chat for everybody: either side of a private chat, owners and admins with the right elsewhere. */
export function canClearForAll(chat: ChatRow, user: UserRow): boolean {
  if (chat.type === 'private') return !!getMember(chat.id, user.id);
  return rightsOf(user, chat, getMember(chat.id, user.id)).deleteMessages;
}

/**
 * «Очистить историю». For everybody (the default when the person may) the messages are deleted for good and the
 * clients are told to empty the chat; otherwise the chat is only hidden for the one who cleared it.
 */
export function clearHistory(chatId: number, user: UserRow, forAll?: boolean) {
  const chat = requireView(chatId, user);
  if (forAll === undefined) forAll = canClearForAll(chat, user);
  if (!forAll) {
    db.prepare(`INSERT OR IGNORE INTO message_hidden (message_id, user_id) SELECT id, ? FROM messages WHERE chat_id = ?`).run(user.id, chat.id);
    return;
  }
  if (!canClearForAll(chat, user)) throw forbidden(txt.errors.cannotDeleteForAll);
  db.transaction(() => {
    db.prepare('DELETE FROM pinned_messages WHERE chat_id = ?').run(chat.id);
    db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chat.id);
  })();
  toChat(chat.id, EV.chatCleared, { chatId: chat.id });
}

export function forwardMessages(ids: number[], fromChatId: number, toChatId: number, user: UserRow, hideSender = false) {
  const source = requireView(fromChatId, user);
  const target = requireView(toChatId, user);
  const tm = membership(target, user);
  if (!tm.canSend) throw forbidden(txt.errors.cannotWrite);
  assertNotBlocked(target, user);
  assertSlowMode(target, user);
  const rows = db
    .prepare(
      // transfers, fundraisers and checklists belong to their chat
      `SELECT * FROM messages WHERE chat_id = ? AND kind NOT IN ('service', 'transfer', 'fund', 'checklist')
       AND id IN (${ids.map(() => '?').join(',')}) ORDER BY id`,
    )
    .all(fromChatId, ...ids) as MessageRow[];
  const out = [];
  for (const r of rows) {
    const files = db
      .prepare('SELECT f.* FROM message_files mf JOIN files f ON f.id = mf.file_id WHERE mf.message_id = ? ORDER BY position')
      .all(r.id) as FileRow[];
    if ((files.length || r.kind === 'sticker') && !tm.canSendMedia) throw forbidden(txt.errors.mediaForbidden);
    if (r.poll_id && !tm.canSendPolls) throw forbidden(txt.errors.pollsForbidden);
    let fwdId = hideSender ? null : r.forwarded_from_id;
    let fwdName = hideSender ? null : r.forwarded_from_name;
    if (!fwdName && !hideSender) {
      if (isChannel(source) && r.thread_id === null) {
        // posts are forwarded "from the channel", never from the admin who wrote them
        fwdId = null;
        fwdName = source.title;
      } else {
        const s = r.sender_id ? getUserRow(r.sender_id) : undefined;
        fwdId = s?.id ?? null;
        fwdName = s ? displayName(s) : txt.labels.deletedAccount;
      }
    }
    // a forwarded poll is the same poll: votes are shared, like in Telegram
    const row = insertMessage(target, user, {
      text: r.text,
      files,
      fwdId,
      fwdName,
      pollId: r.poll_id,
      ...(r.kind === 'sticker' && r.sticker ? { kind: 'sticker' as const, sticker: r.sticker, extraId: r.extra_id } : {}),
    });
    // "shares" in the statistics of the source chat
    db.prepare('INSERT INTO message_shares (message_id, chat_id, user_id, at) VALUES (?, ?, ?, ?)').run(r.id, source.id, user.id, now());
    out.push(publishMessage(target, user, row));
  }
  return out;
}

export function markRead(chatId: number, user: UserRow, messageId: number) {
  const m = getMember(chatId, user.id);
  if (!m) return;
  if (m.marked_unread) {
    db.prepare('UPDATE chat_members SET marked_unread = 0 WHERE chat_id = ? AND user_id = ?').run(chatId, user.id);
    const chat = getChat(chatId);
    if (chat) toUser(user.id, EV.chatUpdate, chatDTO(chat, user));
  }
  if (messageId <= m.last_read_id) return;
  const maxId = (db.prepare('SELECT COALESCE(MAX(id), 0) id FROM messages WHERE chat_id = ?').get(chatId) as { id: number }).id;
  const id = Math.min(messageId, maxId);
  db.prepare('UPDATE chat_members SET last_read_id = ? WHERE chat_id = ? AND user_id = ?').run(id, chatId, user.id);
  // remember when, for "who read" in small groups
  const chat = getChat(chatId);
  if (chat?.type === 'group' && memberCount(chatId) <= READERS_MAX_MEMBERS) {
    db.prepare('INSERT INTO read_log (chat_id, user_id, up_to_id, read_at) VALUES (?, ?, ?, ?)').run(chatId, user.id, id, now());
  }
  toChat(chatId, EV.messageRead, { chatId, userId: user.id, lastReadId: id });
}

const memberCount = (chatId: number) =>
  (db.prepare('SELECT COUNT(*) c FROM chat_members WHERE chat_id = ?').get(chatId) as { c: number }).c;

/** Who has read the user's own message (small groups, recent messages only — like Telegram). */
export function messageReaders(messageId: number, user: UserRow): ReaderDTO[] {
  const m = getMessageRow(messageId);
  if (!m) throw notFound(txt.errors.messageNotFound);
  const chat = requireView(m.chat_id, user);
  if (m.sender_id !== user.id || chat.type !== 'group') throw forbidden(txt.errors.readersUnavailable);
  if (memberCount(chat.id) > READERS_MAX_MEMBERS || m.created_at < now() - READERS_DAYS * 86400_000) {
    throw forbidden(txt.errors.readersUnavailable);
  }
  const rows = db
    .prepare(
      `SELECT l.user_id, MIN(l.read_at) read_at FROM read_log l
       JOIN chat_members cm ON cm.chat_id = l.chat_id AND cm.user_id = l.user_id
       WHERE l.chat_id = ? AND l.up_to_id >= ? AND l.user_id != ?
       GROUP BY l.user_id ORDER BY read_at DESC`,
    )
    .all(chat.id, m.id, user.id) as { user_id: number; read_at: number }[];
  const users = usersByIds(rows.map((r) => r.user_id));
  return rows.filter((r) => users.has(r.user_id)).map((r) => ({ user: userDTO(users.get(r.user_id)!), readAt: r.read_at }));
}

let cleanup: ReturnType<typeof setInterval> | null = null;
/** Hourly housekeeping: read receipts are only kept for READERS_DAYS. */
export function startCleanupTimer() {
  if (cleanup) return;
  const run = () => {
    try {
      db.prepare('DELETE FROM read_log WHERE read_at < ?').run(now() - READERS_DAYS * 86400_000);
    } catch {
      /* db closed during shutdown */
    }
  };
  run();
  cleanup = setInterval(run, 3600_000);
  cleanup.unref();
}

export function setPinned(chatId: number, messageId: number, user: UserRow, pinned: boolean) {
  const chat = requireView(chatId, user);
  if (!membership(chat, user).canPin) throw forbidden(txt.errors.cannotPin);
  const m = getMessageRow(messageId);
  if (!m || m.chat_id !== chatId || m.thread_id !== null) throw notFound(txt.errors.messageNotFound);
  if (pinned) {
    const added = db.prepare('INSERT OR IGNORE INTO pinned_messages (chat_id, message_id, pinned_at) VALUES (?, ?, ?)').run(chatId, messageId, now()).changes > 0;
    // pinned twice (two devices at once): one service message is enough
    if (added && chat.type !== 'private') {
      // the quote shows no markers and keeps a spoiler hidden
      const plain = stripFormatting(m.text).replace(/\s+/g, ' ').trim();
      const snippet = plain ? txt.service.pinnedQuote(`${plain.slice(0, 40)}${plain.length > 40 ? '…' : ''}`) : txt.service.pinnedFallback;
      serviceMessage(
        chatId,
        user.id,
        isChannel(chat) ? txt.service.channelPinned(snippet) : txt.service.pinned(displayName(user), snippet),
      );
    }
  } else {
    db.prepare('DELETE FROM pinned_messages WHERE chat_id = ? AND message_id = ?').run(chatId, messageId);
  }
  const pins = messagesDTO(
    db
      .prepare(
        'SELECT m.* FROM pinned_messages p JOIN messages m ON m.id = p.message_id WHERE p.chat_id = ? ORDER BY m.id DESC LIMIT 50',
      )
      .all(chatId) as MessageRow[],
  );
  toChat(chatId, EV.pinsChanged, { chatId, pinned: pins });
}

export function sharedMedia(chatId: number, viewer: UserRow, kind: 'media' | 'file' | 'voice', before?: number) {
  const chat = requireView(chatId, viewer);
  const kinds = kind === 'media' ? "('photo','video')" : kind === 'voice' ? "('voice','round')" : "('file')";
  const rows = db
    .prepare(
      `SELECT f.*, m.id AS message_id, m.sender_id AS sender_id, m.created_at AS message_at FROM message_files mf
       JOIN messages m ON m.id = mf.message_id JOIN files f ON f.id = mf.file_id
       WHERE m.chat_id = ? AND m.thread_id IS NULL AND f.kind IN ${kinds} AND m.id < ?
       AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = ?)
       ORDER BY m.id DESC, mf.position LIMIT 60`,
    )
    .all(chatId, before ?? Number.MAX_SAFE_INTEGER, viewer.id) as (FileRow & {
    message_id: number;
    sender_id: number | null;
    message_at: number;
  })[];
  // in channels the author stays hidden
  if (chat.type === 'channel') for (const r of rows) if (r.sender_id !== viewer.id) r.sender_id = null;
  return rows;
}

/** Auto-delete: messages whose time is up disappear for everybody. */
export function deleteExpiredMessages() {
  const rows = db
    .prepare('SELECT id, chat_id, thread_id FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ? LIMIT 500')
    .all(now()) as { id: number; chat_id: number; thread_id: number | null }[];
  if (!rows.length) return;
  const byChat = new Map<number, number[]>();
  for (const r of rows) byChat.set(r.chat_id, [...(byChat.get(r.chat_id) ?? []), r.id]);
  for (const [chatId, ids] of byChat) {
    db.prepare(`DELETE FROM messages WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    toChat(chatId, EV.messageDelete, { chatId, ids });
  }
  for (const post of new Set(rows.map((r) => r.thread_id).filter((x): x is number => x !== null))) postChanged(post);
}

let expiry: ReturnType<typeof setInterval> | null = null;
export function startExpiryTimer() {
  if (expiry) return;
  expiry = setInterval(() => {
    try {
      deleteExpiredMessages();
    } catch {
      /* db closed during shutdown */
    }
  }, 15_000);
  expiry.unref();
}
