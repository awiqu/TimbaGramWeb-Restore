import crypto from 'node:crypto';
import type { ChatDTO, ChatKeyboardDTO, MemberDTO, MessageDTO } from '@timba/shared';
import { EV } from '@timba/shared';
import { isAdmin } from '../auth.js';
import { db, now } from '../db.js';
import { botHooks } from '../bots/hooks.js';
import { badRequest, conflict } from '../errors.js';
import {
  type ChatRow,
  type MemberRow,
  getChat,
  getMember,
  membership,
  parsePerms,
  parseRights,
} from '../permissions.js';
import { isOnline, joinChat, leaveChat, toChat, toUser } from '../realtime.js';
import {
  type MessageRow,
  type UserRow,
  displayName,
  getUserRow,
  messageDTO,
  messagesDTO,
  userDTO,
  userDTOFor,
  isBlockedBy,
  canInviteUser,
  usersByIds,
} from '../serialize.js';
import { txt } from '../strings.js';
import { encryptText } from '../crypt.js';

export const newInviteToken = () => crypto.randomBytes(12).toString('base64url');

export function memberIds(chatId: number): number[] {
  return (db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ?').all(chatId) as { user_id: number }[]).map(
    (r) => r.user_id,
  );
}

/** Shown subscriber count: channels add the admin's boost to real members. */
export const shownMemberCount = (chat: Pick<ChatRow, 'type' | 'boost_subscribers'>, real: number) =>
  real + (chat.type === 'channel' ? chat.boost_subscribers ?? 0 : 0);

export function isUsernameTaken(name: string, exceptChatId?: number, exceptUserId?: number): boolean {
  const u = db.prepare('SELECT id FROM users WHERE username = ?').get(name) as { id: number } | undefined;
  if (u && u.id !== exceptUserId) return true;
  const c = db.prepare('SELECT id FROM chats WHERE public_username = ?').get(name) as { id: number } | undefined;
  return !!c && c.id !== exceptChatId;
}

function pinnedFor(chatId: number, viewerId: number): MessageDTO[] {
  const rows = db
    .prepare(
      `SELECT m.* FROM pinned_messages p JOIN messages m ON m.id = p.message_id
       WHERE p.chat_id = ? AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = ?)
       ORDER BY m.id DESC LIMIT 50`,
    )
    .all(chatId, viewerId) as MessageRow[];
  return messagesDTO(rows, viewerId);
}

/** The keyboard a bot put under the input field of the chat (null = none). */
export function chatKeyboard(chatId: number): ChatKeyboardDTO | null {
  const r = db.prepare('SELECT bot_id, message_id, markup FROM chat_keyboards WHERE chat_id = ?').get(chatId) as
    | { bot_id: number; message_id: number | null; markup: string }
    | undefined;
  if (!r) return null;
  return { ...(JSON.parse(r.markup) as Omit<ChatKeyboardDTO, 'messageId' | 'botId'>), messageId: r.message_id ?? 0, botId: r.bot_id };
}

export function chatDTO(chat: ChatRow, viewer: UserRow): ChatDTO {
  const member = getMember(chat.id, viewer.id);
  const me = membership(chat, viewer, member);
  const members = db
    .prepare('SELECT user_id, last_read_id FROM chat_members WHERE chat_id = ?')
    .all(chat.id) as { user_id: number; last_read_id: number }[];

  const last = db
    .prepare(
      `SELECT * FROM messages WHERE chat_id = ? AND thread_id IS NULL
       AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = messages.id AND h.user_id = ?)
       ORDER BY id DESC LIMIT 1`,
    )
    .get(chat.id, viewer.id) as MessageRow | undefined;

  const lastReadId = member?.last_read_id ?? 0;
  const unread = member
    ? (
        db
          .prepare(
            `SELECT COUNT(*) c FROM messages WHERE chat_id = ? AND id > ? AND thread_id IS NULL
             AND (sender_id IS NULL OR sender_id != ?)
             AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = messages.id AND h.user_id = ?)`,
          )
          .get(chat.id, lastReadId, viewer.id, viewer.id) as { c: number }
      ).c
    : 0;

  const unreadMentions = member
    ? (
        db
          .prepare(
            `SELECT message_id FROM message_mentions WHERE user_id = ? AND chat_id = ? AND message_id > ?
             AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = message_mentions.message_id AND h.user_id = ?) ORDER BY message_id`,
          )
          .all(viewer.id, chat.id, lastReadId, viewer.id) as { message_id: number }[]
      ).map((r) => r.message_id)
    : [];

  const othersReadId = members.filter((m) => m.user_id !== viewer.id).reduce((a, m) => Math.max(a, m.last_read_id), 0);

  let peer = null;
  let title = chat.title;
  let peerBlocked = false;
  if (chat.type === 'private') {
    const peerId = members.find((m) => m.user_id !== viewer.id)?.user_id ?? viewer.id;
    peerBlocked = peerId !== viewer.id && isBlockedBy(viewer.id, peerId);
    const peerRow = getUserRow(peerId);
    if (peerRow) {
      peer = userDTOFor(peerRow, viewer.id);
      title = peerId === viewer.id ? txt.labels.savedMessages : displayName(peerRow);
    }
  }

  const canSeeInvite = me.canInvite || me.rights.inviteUsers;
  return {
    id: chat.id,
    type: chat.type,
    title,
    description: chat.description,
    avatarFileId: chat.avatar_file_id,
    isPublic: !!chat.is_public,
    publicUsername: chat.public_username,
    inviteToken: canSeeInvite ? chat.invite_token : null,
    ownerId: chat.owner_id,
    memberCount: shownMemberCount(chat, members.length),
    onlineCount: me.canSeeMembers ? members.filter((m) => isOnline(m.user_id)).length : 0,
    peer,
    lastMessage: last ? messageDTO(last, viewer.id) : null,
    unreadCount: unread,
    lastReadId,
    othersReadId,
    pinned: pinnedFor(chat.id, viewer.id),
    defaultPermissions: parsePerms(chat),
    signMessages: !!chat.sign_messages,
    reactionsEnabled: !!chat.reactions_enabled,
    commentsEnabled: chat.type === 'channel' && !!chat.comments_enabled,
    pinnedAt: member?.pinned_at ?? null,
    archived: !!member?.archived,
    markedUnread: !!member?.marked_unread,
    unreadMentions,
    peerBlocked,
    autoDelete: chat.auto_delete ?? null,
    joinApproval: !!chat.join_approval,
    joinRequested: !member && !!db.prepare('SELECT 1 FROM join_requests WHERE chat_id = ? AND user_id = ?').get(chat.id, viewer.id),
    pendingRequests:
      member && me.rights.inviteUsers
        ? (db.prepare('SELECT COUNT(*) c FROM join_requests WHERE chat_id = ?').get(chat.id) as { c: number }).c
        : 0,
    slowMode: chat.slow_mode ?? 0,
    boostSubscribers: isAdmin(viewer) && chat.type === 'channel' ? chat.boost_subscribers ?? 0 : 0,
    scheduledCount: (
      db.prepare('SELECT COUNT(*) c FROM scheduled_messages WHERE chat_id = ? AND user_id = ?').get(chat.id, viewer.id) as { c: number }
    ).c,
    keyboard: chat.type === 'channel' ? null : chatKeyboard(chat.id),
    me,
    createdAt: chat.created_at,
    lastActivityAt: chat.last_activity_at,
  };
}

export function listChats(viewer: UserRow): ChatDTO[] {
  const rows = db
    .prepare(
      `SELECT c.* FROM chats c JOIN chat_members m ON m.chat_id = c.id
       WHERE m.user_id = ? ORDER BY c.last_activity_at DESC`,
    )
    .all(viewer.id) as ChatRow[];
  return rows.map((c) => chatDTO(c, viewer));
}

/** Push a fresh ChatDTO to each member (each gets their own view). */
export function broadcastChat(chatId: number, extraUserIds: number[] = []) {
  const chat = getChat(chatId);
  if (!chat) return;
  const ids = new Set([...memberIds(chatId), ...extraUserIds]);
  const users = usersByIds(ids);
  for (const u of users.values()) toUser(u.id, EV.chatUpdate, chatDTO(chat, u));
}

export function membersDTO(chatId: number): MemberDTO[] {
  const rows = db
    .prepare(
      `SELECT * FROM chat_members WHERE chat_id = ?
       ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, joined_at`,
    )
    .all(chatId) as MemberRow[];
  const users = usersByIds(rows.map((r) => r.user_id));
  return rows
    .filter((r) => users.has(r.user_id))
    .map((r) => ({
      user: userDTO(users.get(r.user_id)!),
      role: r.role,
      rights: parseRights(r),
      customTitle: r.custom_title,
      mutedUntil: r.muted_until && r.muted_until > now() ? r.muted_until : null,
      joinedAt: r.joined_at,
    }));
}

/** Joins and leaves of groups and channels, for their statistics. */
function logMember(chatId: number, userId: number, delta: 1 | -1) {
  db.prepare(
    `INSERT INTO chat_member_log (chat_id, user_id, delta, at)
     SELECT id, ?, ?, ? FROM chats WHERE id = ? AND type != 'private'`,
  ).run(userId, delta, now(), chatId);
}

export function addMember(chatId: number, userId: number, role: MemberRow['role'] = 'member', rights = {}) {
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO chat_members (chat_id, user_id, role, admin_rights, joined_at, last_read_id)
       VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(id), 0) FROM messages WHERE chat_id = ?))`,
    )
    .run(chatId, userId, role, JSON.stringify(rights), now(), chatId);
  if (res.changes) {
    logMember(chatId, userId, 1);
    db.prepare('DELETE FROM join_requests WHERE chat_id = ? AND user_id = ?').run(chatId, userId);
  }
  joinChat(userId, chatId);
}

export function removeMember(chatId: number, userId: number) {
  const res = db.prepare('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?').run(chatId, userId);
  if (res.changes) logMember(chatId, userId, -1);
  leaveChat(userId, chatId);
  toUser(userId, EV.chatRemoved, { chatId });
}

export function touchChat(chatId: number, t = now()) {
  db.prepare('UPDATE chats SET last_activity_at = ? WHERE id = ?').run(t, chatId);
}

/** Insert a service message ("X added Y") and broadcast it. */
export function serviceMessage(chatId: number, actorId: number | null, text: string): MessageRow {
  const t = now();
  const res = db
    .prepare(`INSERT INTO messages (chat_id, sender_id, kind, text, created_at) VALUES (?, ?, 'service', ?, ?)`)
    .run(chatId, actorId, encryptText(text), t);
  touchChat(chatId, t);
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(res.lastInsertRowid) as MessageRow;
  toChat(chatId, EV.messageNew, messageDTO(row));
  return row;
}

export function getOrCreatePrivate(a: UserRow, b: UserRow): ChatRow {
  const key = [a.id, b.id].sort((x, y) => x - y).join(':');
  const existing = db.prepare('SELECT * FROM chats WHERE private_key = ?').get(key) as ChatRow | undefined;
  if (existing) {
    // re-add members if someone somehow left
    for (const u of [a, b]) if (!getMember(existing.id, u.id)) addMember(existing.id, u.id);
    return existing;
  }
  const t = now();
  const res = db
    .prepare(`INSERT INTO chats (type, private_key, created_at, last_activity_at) VALUES ('private', ?, ?, ?)`)
    .run(key, t, t);
  const id = Number(res.lastInsertRowid);
  addMember(id, a.id);
  if (b.id !== a.id) addMember(id, b.id);
  return getChat(id)!;
}

export function createGroup(
  owner: UserRow,
  input: {
    title: string;
    description: string;
    avatarFileId?: string | null;
    isPublic: boolean;
    publicUsername?: string | null;
    memberIds: number[];
    signMessages?: boolean;
  },
  type: 'group' | 'channel' = 'group',
): ChatRow {
  const channel = type === 'channel';
  if (input.isPublic) {
    if (!input.publicUsername) throw badRequest(txt.errors.publicLinkRequired);
    if (isUsernameTaken(input.publicUsername)) throw conflict(txt.errors.linkTaken, 'username_taken');
  }
  const t = now();
  const chatId = db.transaction(() => {
    const res = db
      .prepare(
        `INSERT INTO chats (type, title, description, avatar_file_id, is_public, public_username, invite_token,
           owner_id, default_permissions, sign_messages, created_at, last_activity_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
      )
      .run(
        type,
        input.title,
        input.description,
        input.avatarFileId ?? null,
        input.isPublic ? 1 : 0,
        input.isPublic ? input.publicUsername : null,
        newInviteToken(),
        owner.id,
        channel && input.signMessages ? 1 : 0,
        t,
        t,
      );
    const id = Number(res.lastInsertRowid);
    addMember(id, owner.id, 'owner');
    return id;
  })();
  serviceMessage(
    chatId,
    owner.id,
    channel ? txt.service.channelCreated(input.title) : txt.service.created(displayName(owner), input.title),
  );
  const others = usersByIds(input.memberIds.filter((id) => id !== owner.id));
  for (const u of [...others.values()]) {
    if (u.is_banned || !canInviteUser(owner, u)) {
      others.delete(u.id);
      continue;
    }
    addMember(chatId, u.id);
  }
  let addedMessageId: number | null = null;
  if (others.size && !channel) {
    addedMessageId = serviceMessage(
      chatId,
      owner.id,
      txt.service.added(displayName(owner), [...others.values()].map(displayName).join(', ')),
    ).id;
  }
  if (others.size) botHooks.membersAdded(getChat(chatId)!, owner, [...others.values()], addedMessageId);
  broadcastChat(chatId);
  return getChat(chatId)!;
}

/**
 * Someone deleted a private chat for themselves and it is written to again: they are back in it (the old
 * messages stay hidden for them). Call before anything looks at who is in the chat.
 */
export function restorePrivate(chat: ChatRow) {
  if (chat.type !== 'private' || !chat.private_key) return;
  for (const id of chat.private_key.split(':').map(Number)) {
    if (!getMember(chat.id, id)) addMember(chat.id, id);
  }
}

/**
 * «Удалить чат» in a private chat. For me: the history is hidden for me and the chat leaves my list (it comes
 * back, empty, when somebody writes). For both: the chat and all its messages are gone for the two of them.
 */
export function deletePrivateChat(chat: ChatRow, user: UserRow, forBoth: boolean) {
  if (forBoth) return deleteChat(chat.id);
  db.prepare(`INSERT OR IGNORE INTO message_hidden (message_id, user_id) SELECT id, ? FROM messages WHERE chat_id = ?`).run(user.id, chat.id);
  db.prepare('DELETE FROM chat_keyboards WHERE chat_id = ?').run(chat.id);
  removeMember(chat.id, user.id);
}

export function deleteChat(chatId: number) {
  const ids = memberIds(chatId);
  db.prepare('DELETE FROM chats WHERE id = ?').run(chatId);
  for (const id of ids) {
    leaveChat(id, chatId);
    toUser(id, EV.chatRemoved, { chatId });
  }
}

export function isGlobalAdmin(u: UserRow) {
  return isAdmin(u);
}
