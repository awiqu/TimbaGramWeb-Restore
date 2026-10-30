import { botHooks } from '../bots/hooks.js';
import type { InviteLinkDTO, JoinRequestDTO } from '@timba/shared';
import { EV } from '@timba/shared';
import { db, now } from '../db.js';
import { forbidden, notFound } from '../errors.js';
import { type ChatRow, getMember, isChannel, isChatBanned, parseRights, requireChat } from '../permissions.js';
import { notifyUser } from '../push.js';
import { toUser } from '../realtime.js';
import { type UserRow, displayName, userDTO, usersByIds } from '../serialize.js';
import { txt } from '../strings.js';
import { addMember, broadcastChat, newInviteToken, serviceMessage } from './chats.js';

/** Extra links a chat may have at once (revoked ones count too until deleted). */
export const MAX_INVITE_LINKS = 50;

export interface InviteRow {
  token: string;
  chat_id: number;
  creator_id: number | null;
  title: string;
  expires_at: number | null;
  usage_limit: number | null;
  uses: number;
  approval: number;
  revoked: number;
  created_at: number;
}

export const inviteActive = (r: InviteRow, t = now()) =>
  !r.revoked && (r.expires_at === null || r.expires_at > t) && (r.usage_limit === null || r.uses < r.usage_limit);

/** The chat behind a link: its main invite link, or one of the extra ones (then `invite` is set). */
export function findInvite(token: string): { chat: ChatRow; invite: InviteRow | null } {
  const chat = db.prepare('SELECT * FROM chats WHERE invite_token = ?').get(token) as ChatRow | undefined;
  if (chat) return { chat, invite: null };
  const invite = db.prepare('SELECT * FROM chat_invites WHERE token = ?').get(token) as InviteRow | undefined;
  if (!invite) throw notFound(txt.errors.invalidInvite);
  return { chat: requireChat(invite.chat_id), invite };
}

export function hasRequest(chatId: number, userId: number): boolean {
  return !!db.prepare('SELECT 1 FROM join_requests WHERE chat_id = ? AND user_id = ?').get(chatId, userId);
}

export function pendingRequestCount(chatId: number): number {
  return (db.prepare('SELECT COUNT(*) c FROM join_requests WHERE chat_id = ?').get(chatId) as { c: number }).c;
}

/** Members who get told about requests: the owner and admins allowed to invite. */
function requestAdmins(chatId: number): number[] {
  const rows = db
    .prepare(`SELECT * FROM chat_members WHERE chat_id = ? AND role IN ('owner', 'admin')`)
    .all(chatId) as Parameters<typeof parseRights>[0][];
  return rows.filter((m) => parseRights(m).inviteUsers).map((m) => m.user_id);
}

/** Ask to join; admins see the request in the chat and get a push. */
export function createRequest(chat: ChatRow, user: UserRow, inviteToken: string | null) {
  if (hasRequest(chat.id, user.id)) return;
  db.prepare('INSERT INTO join_requests (chat_id, user_id, invite_token, created_at) VALUES (?, ?, ?, ?)').run(
    chat.id,
    user.id,
    inviteToken,
    now(),
  );
  const admins = requestAdmins(chat.id);
  broadcastChat(chat.id, [user.id]);
  for (const id of admins) {
    notifyUser(id, {
      title: chat.title,
      body: txt.joinRequests.newRequest(displayName(user)),
      chatId: chat.id,
      url: `/c/${chat.id}`,
      tag: `requests-${chat.id}`,
    });
  }
}

export function cancelRequest(chatId: number, userId: number) {
  db.prepare('DELETE FROM join_requests WHERE chat_id = ? AND user_id = ?').run(chatId, userId);
}

/** Join by a link right away: counts the use and says so in groups. */
export function joinByLink(chat: ChatRow, user: UserRow, invite: InviteRow | null) {
  if (getMember(chat.id, user.id)) return;
  addMember(chat.id, user.id);
  if (invite) db.prepare('UPDATE chat_invites SET uses = uses + 1 WHERE token = ?').run(invite.token);
  cancelRequest(chat.id, user.id);
  const sm = !isChannel(chat) ? serviceMessage(chat.id, user.id, txt.service.joinedByLink(displayName(user))) : null;
  botHooks.membersAdded(chat, user, [user], sm?.id ?? null);
}

/** An admin lets somebody in or turns them down. */
export function decideRequest(chat: ChatRow, admin: UserRow, userId: number, approve: boolean) {
  const req = db.prepare('SELECT * FROM join_requests WHERE chat_id = ? AND user_id = ?').get(chat.id, userId) as
    | { invite_token: string | null }
    | undefined;
  if (!req) throw notFound(txt.errors.requestNotFound);
  cancelRequest(chat.id, userId);
  const target = usersByIds([userId]).get(userId);
  if (approve && target && !target.is_banned && !isChatBanned(chat.id, userId) && !getMember(chat.id, userId)) {
    addMember(chat.id, userId);
    if (req.invite_token) db.prepare('UPDATE chat_invites SET uses = uses + 1 WHERE token = ?').run(req.invite_token);
    const sm = !isChannel(chat) ? serviceMessage(chat.id, admin.id, txt.service.requestApproved(displayName(admin), displayName(target))) : null;
    botHooks.membersAdded(chat, admin, [target], sm?.id ?? null);
    toUser(userId, EV.membersChanged, { chatId: chat.id });
    notifyUser(userId, {
      title: txt.joinRequests.approvedTitle,
      body: txt.joinRequests.approved(chat.title),
      chatId: chat.id,
      url: `/c/${chat.id}`,
      tag: `joined-${chat.id}`,
    });
  } else if (approve && target && isChatBanned(chat.id, userId)) {
    throw forbidden(isChannel(chat) ? txt.errors.bannedInChannel : txt.errors.bannedInGroup);
  }
  broadcastChat(chat.id, [userId]);
}

export function listRequests(chatId: number): JoinRequestDTO[] {
  const rows = db
    .prepare(
      `SELECT r.user_id, r.created_at, i.title, i.token FROM join_requests r
       LEFT JOIN chat_invites i ON i.token = r.invite_token
       WHERE r.chat_id = ? ORDER BY r.created_at DESC`,
    )
    .all(chatId) as { user_id: number; created_at: number; title: string | null; token: string | null }[];
  const users = usersByIds(rows.map((r) => r.user_id));
  return rows
    .filter((r) => users.has(r.user_id))
    .map((r) => ({ user: userDTO(users.get(r.user_id)!), via: r.token ? r.title || r.token : null, createdAt: r.created_at }));
}

export function inviteDTOs(chatId: number): InviteLinkDTO[] {
  const rows = db.prepare('SELECT * FROM chat_invites WHERE chat_id = ? ORDER BY created_at DESC').all(chatId) as InviteRow[];
  const creators = usersByIds(rows.map((r) => r.creator_id).filter((x): x is number => x !== null));
  const requests = new Map(
    (
      db
        .prepare('SELECT invite_token, COUNT(*) c FROM join_requests WHERE chat_id = ? AND invite_token IS NOT NULL GROUP BY invite_token')
        .all(chatId) as { invite_token: string; c: number }[]
    ).map((r) => [r.invite_token, r.c]),
  );
  const t = now();
  return rows.map((r) => ({
    token: r.token,
    title: r.title,
    expiresAt: r.expires_at,
    usageLimit: r.usage_limit,
    uses: r.uses,
    approval: !!r.approval,
    revoked: !!r.revoked,
    active: inviteActive(r, t),
    requests: requests.get(r.token) ?? 0,
    creator: r.creator_id && creators.has(r.creator_id) ? userDTO(creators.get(r.creator_id)!) : null,
    createdAt: r.created_at,
  }));
}

export function createInvite(
  chat: ChatRow,
  user: UserRow,
  input: { title: string; expiresAt: number | null; usageLimit: number | null; approval: boolean },
): InviteLinkDTO {
  const token = newInviteToken();
  db.prepare(
    `INSERT INTO chat_invites (token, chat_id, creator_id, title, expires_at, usage_limit, approval, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(token, chat.id, user.id, input.title, input.expiresAt, input.usageLimit, input.approval ? 1 : 0, now());
  return inviteDTOs(chat.id).find((i) => i.token === token)!;
}
