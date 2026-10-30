import type { AdminRights, GroupPermissions, MyMembership, Role } from '@timba/shared';
import { isAdmin } from './auth.js';
import { db, now } from './db.js';
import { HttpError, forbidden, notFound } from './errors.js';
import type { UserRow } from './serialize.js';
import { txt } from './strings.js';

export interface ChatRow {
  id: number;
  type: 'private' | 'group' | 'channel';
  private_key: string | null;
  title: string;
  description: string;
  avatar_file_id: string | null;
  is_public: number;
  public_username: string | null;
  invite_token: string | null;
  owner_id: number | null;
  default_permissions: string;
  sign_messages: number;
  reactions_enabled: number;
  comments_enabled: number;
  auto_delete: number | null;
  slow_mode: number;
  /** channels: extra subscribers added by the admin */
  boost_subscribers: number;
  /** public chats: joining needs an admin's approval */
  join_approval: number;
  created_at: number;
  last_activity_at: number;
}

export interface MemberRow {
  chat_id: number;
  user_id: number;
  role: Role;
  admin_rights: string;
  custom_title: string;
  muted_until: number | null;
  last_read_id: number;
  joined_at: number;
  notify_muted: number;
  notify_muted_until: number | null;
  pinned_at: number | null;
  archived: number;
  marked_unread: number;
}

/** Notifications of this member are off right now (for good, or until a time that has not come yet). */
export const notifyMuted = (m: Pick<MemberRow, 'notify_muted' | 'notify_muted_until'> | undefined | null) =>
  !!m && !!m.notify_muted && (m.notify_muted_until === null || m.notify_muted_until > now());

/**
 * SQL for "notifications are on": the same rule as notifyMuted for a chat_members row, for queries.
 * The time is inlined (it is our own integer), so the fragment can sit anywhere in a query.
 */
export const notMutedSql = (alias = 'chat_members') =>
  `(${alias}.notify_muted = 0 OR (${alias}.notify_muted_until IS NOT NULL AND ${alias}.notify_muted_until <= ${Math.trunc(now())}))`;

export const ALL_RIGHTS: AdminRights = {
  changeInfo: true,
  deleteMessages: true,
  banUsers: true,
  inviteUsers: true,
  pinMessages: true,
  addAdmins: true,
  postMessages: true,
  editMessages: true,
};

export const NO_RIGHTS: AdminRights = {
  changeInfo: false,
  deleteMessages: false,
  banUsers: false,
  inviteUsers: false,
  pinMessages: false,
  addAdmins: false,
  postMessages: false,
  editMessages: false,
};

export const DEFAULT_ADMIN_RIGHTS: AdminRights = { ...ALL_RIGHTS, addAdmins: false };

export const DEFAULT_PERMISSIONS: GroupPermissions = {
  sendMessages: true,
  sendMedia: true,
  sendPolls: true,
  inviteUsers: true,
  pinMessages: false,
};

/** Groups and channels (anything with members, roles and rights). */
export const isGroupLike = (chat: Pick<ChatRow, 'type'>) => chat.type === 'group' || chat.type === 'channel';
export const isChannel = (chat: Pick<ChatRow, 'type'>) => chat.type === 'channel';

export function getChat(id: number): ChatRow | undefined {
  return db.prepare('SELECT * FROM chats WHERE id = ?').get(id) as ChatRow | undefined;
}

export function requireChat(id: number): ChatRow {
  const c = getChat(id);
  if (!c) throw notFound(txt.errors.chatNotFound);
  return c;
}

export function getMember(chatId: number, userId: number): MemberRow | undefined {
  return db.prepare('SELECT * FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, userId) as
    | MemberRow
    | undefined;
}

export function parsePerms(chat: ChatRow): GroupPermissions {
  return { ...DEFAULT_PERMISSIONS, ...JSON.parse(chat.default_permissions || '{}') };
}

export function parseRights(m: MemberRow): AdminRights {
  if (m.role === 'owner') return { ...ALL_RIGHTS };
  if (m.role === 'admin') return { ...NO_RIGHTS, ...JSON.parse(m.admin_rights || '{}') };
  return { ...NO_RIGHTS };
}

export function rightsOf(user: UserRow, chat: ChatRow, member: MemberRow | undefined): AdminRights {
  if (isGroupLike(chat) && isAdmin(user)) return { ...ALL_RIGHTS };
  if (!member) return { ...NO_RIGHTS };
  return parseRights(member);
}

export const isMuted = (m: MemberRow | undefined) => !!m?.muted_until && m.muted_until > now();

export function isChatBanned(chatId: number, userId: number): boolean {
  const b = db.prepare('SELECT until FROM chat_bans WHERE chat_id = ? AND user_id = ?').get(chatId, userId) as
    | { until: number | null }
    | undefined;
  if (!b) return false;
  if (b.until !== null && b.until <= now()) {
    db.prepare('DELETE FROM chat_bans WHERE chat_id = ? AND user_id = ?').run(chatId, userId);
    return false;
  }
  return true;
}

export function membership(chat: ChatRow, user: UserRow, member = getMember(chat.id, user.id)): MyMembership {
  const rights = rightsOf(user, chat, member);
  const isMember = !!member;
  if (chat.type === 'private') {
    return {
      isMember,
      role: member?.role ?? null,
      rights: { ...NO_RIGHTS },
      mutedUntil: null,
      canSend: isMember,
      canSendMedia: isMember,
      canSendPolls: isMember,
      canInvite: false,
      canPin: isMember,
      canSeeMembers: isMember,
      isBanned: false,
      notificationsMuted: notifyMuted(member),
      notificationsMutedUntil: notifyMuted(member) ? (member?.notify_muted_until ?? null) : null,
      slowModeUntil: null,
    };
  }
  const superUser = isAdmin(user);
  const elevated = superUser || member?.role === 'owner' || member?.role === 'admin';
  const active = isMember || superUser;
  if (chat.type === 'channel') {
    const canPost = active && rights.postMessages;
    return {
      isMember,
      role: member?.role ?? null,
      rights,
      mutedUntil: null,
      canSend: canPost,
      canSendMedia: canPost,
      canSendPolls: canPost,
      canInvite: active && rights.inviteUsers,
      canPin: active && rights.pinMessages,
      canSeeMembers: elevated,
      isBanned: isChatBanned(chat.id, user.id),
      notificationsMuted: notifyMuted(member),
      notificationsMutedUntil: notifyMuted(member) ? (member?.notify_muted_until ?? null) : null,
      slowModeUntil: null,
    };
  }
  const perms = parsePerms(chat);
  const muted = isMuted(member);
  const canSend = active && !muted && (elevated || perms.sendMessages);
  return {
    isMember,
    role: member?.role ?? null,
    rights,
    mutedUntil: muted ? member!.muted_until : null,
    canSend,
    canSendMedia: canSend && (elevated || perms.sendMedia),
    canSendPolls: canSend && (elevated || perms.sendPolls),
    canInvite: active && (rights.inviteUsers || perms.inviteUsers),
    canPin: active && (rights.pinMessages || perms.pinMessages),
    canSeeMembers: true,
    isBanned: isChatBanned(chat.id, user.id),
    notificationsMuted: notifyMuted(member),
    notificationsMutedUntil: notifyMuted(member) ? (member?.notify_muted_until ?? null) : null,
    slowModeUntil: elevated ? null : slowModeUntil(chat, user.id),
  };
}

/** Slow mode: when the member may write again (ms), or null if right now. */
export function slowModeUntil(chat: ChatRow, userId: number): number | null {
  if (chat.type !== 'group' || !chat.slow_mode) return null;
  const last = db
    .prepare(`SELECT MAX(created_at) t FROM messages WHERE chat_id = ? AND sender_id = ? AND thread_id IS NULL AND kind != 'service'`)
    .get(chat.id, userId) as { t: number | null };
  const until = (last.t ?? 0) + chat.slow_mode * 1000;
  return until > now() ? until : null;
}

/** Throws while slow mode keeps the member from writing (admins are not limited). */
export function assertSlowMode(chat: ChatRow, user: UserRow) {
  const until = membership(chat, user).slowModeUntil;
  if (until) {
    const sec = Math.ceil((until - now()) / 1000);
    throw new HttpError(429, 'slow_mode', txt.errors.slowMode(sec), { until });
  }
}

export function canView(chat: ChatRow, user: UserRow): boolean {
  if (getMember(chat.id, user.id)) return true;
  if (isGroupLike(chat) && (isAdmin(user) || (chat.is_public && !isChatBanned(chat.id, user.id)))) return true;
  return false;
}

export function requireView(chatId: number, user: UserRow): ChatRow {
  const chat = requireChat(chatId);
  if (!canView(chat, user)) throw forbidden(txt.errors.noAccess);
  return chat;
}

export function requireRight(chat: ChatRow, user: UserRow, right: keyof AdminRights): AdminRights {
  if (!isGroupLike(chat)) throw forbidden(txt.errors.groupsOnly);
  const rights = rightsOf(user, chat, getMember(chat.id, user.id));
  if (!rights[right]) throw forbidden();
  return rights;
}

/** Can `actor` moderate `target` (kick/ban/mute/edit) in the group? */
export function canActOn(chat: ChatRow, actor: UserRow, target: MemberRow | undefined): boolean {
  if (target?.user_id === actor.id) return false;
  // the global admin has power over everyone, including group owners
  if (isAdmin(actor)) return true;
  if (target?.role === 'owner') return false;
  const am = getMember(chat.id, actor.id);
  if (!am) return false;
  if (am.role === 'owner') return true;
  if (am.role === 'admin') return !target || target.role === 'member';
  return false;
}
