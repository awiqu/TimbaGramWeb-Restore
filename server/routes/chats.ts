import {
  EV,
  MAX_PINNED_CHATS,
  MUTE_FOREVER,
  autoDeleteSchema,
  clearHistorySchema,
  createGroupSchema,
  createInviteSchema,
  decideRequestSchema,
  notificationsSchema,
  updateGroupSchema,
  updateMemberSchema,
  untilSchema,
} from '@timba/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isAdmin, requireAuth } from '../auth.js';
import { db, now } from '../db.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import {
  ALL_RIGHTS,
  DEFAULT_ADMIN_RIGHTS,
  type ChatRow,
  canActOn,
  getMember,
  isChannel,
  isChatBanned,
  isGroupLike,
  membership,
  parseRights,
  requireChat,
  requireRight,
  requireView,
  rightsOf,
} from '../permissions.js';
import { botHooks } from '../bots/hooks.js';
import { toChat, toUser } from '../realtime.js';
import { type UserRow, canInviteUser, displayName, fileDTO, getUserRow, userDTO, usersByIds } from '../serialize.js';
import {
  addMember,
  broadcastChat,
  chatDTO,
  createGroup,
  deleteChat,
  deletePrivateChat,
  getOrCreatePrivate,
  isUsernameTaken,
  listChats,
  memberIds,
  membersDTO,
  newInviteToken,
  removeMember,
  serviceMessage,
  shownMemberCount,
} from '../services/chats.js';
import { requireOwnPhoto } from '../services/files.js';
import { clearHistory, markRead, setPinned, sharedMedia } from '../services/messages.js';
import {
  MAX_INVITE_LINKS,
  cancelRequest,
  createInvite,
  createRequest,
  decideRequest,
  findInvite,
  hasRequest,
  inviteActive,
  inviteDTOs,
  joinByLink,
  listRequests,
} from '../services/invites.js';
import { exportChat } from '../services/export.js';
import { chatStats } from '../services/stats.js';
import { intParam, optInt, parse } from '../util.js';
import { getSettings } from '../settings.js';
import { txt } from '../strings.js';

type IdParams = { Params: { id: string } };
type MemberParams = { Params: { id: string; userId: string } };
type TokenParams = { Params: { id: string; token: string } };

/** A group or a channel. */
function requireGroup(id: number): ChatRow {
  const chat = requireChat(id);
  if (!isGroupLike(chat)) throw badRequest(txt.errors.notAGroup);
  return chat;
}

/** Service messages about members ("X joined") exist only in groups — channels keep quiet about subscribers. */
function memberEvent(chat: ChatRow, actorId: number, text: string): number | null {
  return !isChannel(chat) ? serviceMessage(chat.id, actorId, text).id : null;
}

function requireTargetUser(id: number): UserRow {
  const u = getUserRow(id);
  if (!u) throw notFound(txt.errors.userNotFound);
  return u;
}

function membersChanged(chatId: number) {
  toChat(chatId, EV.membersChanged, { chatId });
  broadcastChat(chatId);
}

/** Pass ownership to the best remaining member (admins first). Returns false if nobody is left. */
function handOverOwnership(chatId: number, fromUserId: number): boolean {
  const heir = db
    .prepare(
      `SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id != ?
       ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, joined_at LIMIT 1`,
    )
    .get(chatId, fromUserId) as { user_id: number } | undefined;
  if (!heir) {
    db.prepare('UPDATE chats SET owner_id = NULL WHERE id = ?').run(chatId);
    return false;
  }
  db.prepare(`UPDATE chat_members SET role = 'owner', admin_rights = '{}' WHERE chat_id = ? AND user_id = ?`).run(
    chatId,
    heir.user_id,
  );
  db.prepare('UPDATE chats SET owner_id = ? WHERE id = ?').run(heir.user_id, chatId);
  return true;
}

function formatUntil(until: number | null) {
  if (!until || until >= MUTE_FOREVER) return txt.service.forever;
  return txt.service.until(new Date(until).toLocaleString(txt.locale, { dateStyle: 'short', timeStyle: 'short' }));
}

export default async function chatRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get('/api/chats', async (req) => listChats(req.auth.user));

  app.get<IdParams>('/api/chats/:id', async (req) => {
    const chat = requireView(intParam(req.params.id), req.auth.user);
    return chatDTO(chat, req.auth.user);
  });

  app.post('/api/chats/private', async (req) => {
    const { userId } = parse(z.object({ userId: z.number().int().positive() }), req.body);
    const peer = requireTargetUser(userId);
    const chat = getOrCreatePrivate(req.auth.user, peer);
    return chatDTO(chat, req.auth.user);
  });

  app.post('/api/chats/group', async (req) => {
    if (!getSettings().groupCreation && !isAdmin(req.auth.user)) throw forbidden(txt.errors.groupCreationOff);
    const body = parse(createGroupSchema, req.body);
    if (body.avatarFileId) requireOwnPhoto(body.avatarFileId, req.auth.user);
    const chat = createGroup(req.auth.user, body);
    return chatDTO(chat, req.auth.user);
  });

  app.post('/api/chats/channel', async (req) => {
    if (!getSettings().channelCreation && !isAdmin(req.auth.user)) throw forbidden(txt.errors.channelCreationOff);
    const body = parse(createGroupSchema, req.body);
    if (body.avatarFileId) requireOwnPhoto(body.avatarFileId, req.auth.user);
    const chat = createGroup(req.auth.user, body, 'channel');
    return chatDTO(chat, req.auth.user);
  });

  /** Auto-delete timer: in a private chat either side sets it, in groups and channels admins with "change info". */
  app.put<IdParams>('/api/chats/:id/auto-delete', async (req) => {
    const user = req.auth.user;
    const chat = requireView(intParam(req.params.id), user);
    if (chat.type === 'private') {
      if (!getMember(chat.id, user.id)) throw forbidden();
    } else {
      requireRight(chat, user, 'changeInfo');
    }
    const { seconds } = parse(autoDeleteSchema, req.body);
    if ((chat.auto_delete ?? null) !== seconds) {
      db.prepare('UPDATE chats SET auto_delete = ? WHERE id = ?').run(seconds, chat.id);
      serviceMessage(
        chat.id,
        user.id,
        seconds ? txt.service.autoDeleteOn(displayName(user), txt.service.period(seconds)) : txt.service.autoDeleteOff(displayName(user)),
      );
      broadcastChat(chat.id);
    }
    return chatDTO(requireChat(chat.id), user);
  });

  app.patch<IdParams>('/api/chats/:id', async (req) => {
    const user = req.auth.user;
    const chat = requireGroup(intParam(req.params.id));
    requireRight(chat, user, 'changeInfo');
    const body = parse(updateGroupSchema, req.body);
    if (body.avatarFileId) requireOwnPhoto(body.avatarFileId, user);

    const isPublic = body.isPublic ?? !!chat.is_public;
    let publicUsername = body.publicUsername !== undefined ? body.publicUsername : chat.public_username;
    if (isPublic) {
      if (!publicUsername) throw badRequest(txt.errors.publicLinkRequired);
      if (isUsernameTaken(publicUsername, chat.id)) throw conflict(txt.errors.linkTaken, 'username_taken');
    } else {
      publicUsername = null;
    }

    db.prepare(
      `UPDATE chats SET title = ?, description = ?, avatar_file_id = ?, is_public = ?, public_username = ?,
       default_permissions = ?, sign_messages = ?, reactions_enabled = ?, comments_enabled = ?, slow_mode = ?,
       join_approval = ? WHERE id = ?`,
    ).run(
      body.title ?? chat.title,
      body.description ?? chat.description,
      body.avatarFileId !== undefined ? body.avatarFileId : chat.avatar_file_id,
      isPublic ? 1 : 0,
      publicUsername,
      body.defaultPermissions ? JSON.stringify(body.defaultPermissions) : chat.default_permissions,
      isChannel(chat) && body.signMessages !== undefined ? (body.signMessages ? 1 : 0) : chat.sign_messages,
      body.reactionsEnabled !== undefined ? (body.reactionsEnabled ? 1 : 0) : chat.reactions_enabled,
      isChannel(chat) && body.commentsEnabled !== undefined ? (body.commentsEnabled ? 1 : 0) : chat.comments_enabled,
      chat.type === 'group' && body.slowMode !== undefined ? body.slowMode : chat.slow_mode,
      body.joinApproval !== undefined ? (body.joinApproval ? 1 : 0) : chat.join_approval,
      chat.id,
    );
    const channel = isChannel(chat);
    if (body.title && body.title !== chat.title) {
      serviceMessage(
        chat.id,
        user.id,
        channel ? txt.service.channelRenamed(body.title) : txt.service.renamed(displayName(user), body.title),
      );
    }
    if (chat.type === 'group' && body.slowMode !== undefined && body.slowMode !== chat.slow_mode) {
      serviceMessage(chat.id, user.id, body.slowMode ? txt.service.slowModeOn(txt.service.period(body.slowMode)) : txt.service.slowModeOff);
    }
    if (body.avatarFileId !== undefined && body.avatarFileId !== chat.avatar_file_id) {
      serviceMessage(chat.id, user.id, channel ? txt.service.channelPhotoChanged : txt.service.photoChanged(displayName(user)));
    }
    broadcastChat(chat.id);
    return chatDTO(requireChat(chat.id), user);
  });

  app.delete<IdParams>('/api/chats/:id', async (req) => {
    const user = req.auth.user;
    const chat = requireGroup(intParam(req.params.id));
    const m = getMember(chat.id, user.id);
    if (!isAdmin(user) && m?.role !== 'owner') throw forbidden(txt.errors.onlyOwnerCanDelete);
    toChat(chat.id, EV.chatRemoved, { chatId: chat.id });
    deleteChat(chat.id);
    return { ok: true };
  });

  /** «Удалить чат» in a private chat (with a bot, too): for me, or for both people. */
  app.post<IdParams>('/api/chats/:id/delete', async (req) => {
    const user = req.auth.user;
    const chat = requireView(intParam(req.params.id), user);
    if (chat.type !== 'private') throw badRequest(txt.errors.privateOnly);
    const { forBoth } = parse(z.object({ forBoth: z.boolean().optional() }), req.body ?? {});
    deletePrivateChat(chat, user, !!forBoth);
    return { ok: true };
  });

  app.post<IdParams>('/api/chats/:id/leave', async (req) => {
    const user = req.auth.user;
    const chat = requireGroup(intParam(req.params.id));
    const m = getMember(chat.id, user.id);
    if (!m) throw badRequest(txt.errors.notInGroup);
    if (m.role === 'owner' && !handOverOwnership(chat.id, user.id)) {
      deleteChat(chat.id);
      return { ok: true };
    }
    removeMember(chat.id, user.id);
    const sid = memberEvent(chat, user.id, txt.service.left(displayName(user)));
    botHooks.memberLeft(chat, user, user, false, sid);
    membersChanged(chat.id);
    return { ok: true };
  });

  app.post<IdParams>('/api/chats/:id/join', async (req) => {
    const user = req.auth.user;
    const chat = requireGroup(intParam(req.params.id));
    const channel = isChannel(chat);
    if (!chat.is_public) throw forbidden(channel ? txt.errors.privateChannel : txt.errors.privateGroup);
    if (isChatBanned(chat.id, user.id)) throw forbidden(channel ? txt.errors.bannedInChannel : txt.errors.bannedInGroup);
    if (!getMember(chat.id, user.id)) {
      // "approve new members": the button sends a request instead
      if (chat.join_approval && !isAdmin(user)) {
        createRequest(chat, user, null);
        return { requested: true };
      }
      addMember(chat.id, user.id);
      const sid = memberEvent(chat, user.id, txt.service.joined(displayName(user)));
      botHooks.membersAdded(chat, user, [user], sid);
      membersChanged(chat.id);
    }
    return chatDTO(chat, user);
  });

  /** Take back one's own request to join. */
  app.delete<IdParams>('/api/chats/:id/request', async (req) => {
    const chat = requireGroup(intParam(req.params.id));
    cancelRequest(chat.id, req.auth.user.id);
    broadcastChat(chat.id, [req.auth.user.id]);
    return { ok: true };
  });

  app.get<{ Params: { token: string } }>('/api/invite/:token', async (req) => {
    const user = req.auth.user;
    const { chat, invite } = findInvite(req.params.token);
    const isMember = !!getMember(chat.id, user.id);
    if (invite && !isMember && !inviteActive(invite)) throw notFound(txt.errors.inviteExpired);
    return {
      id: chat.id,
      type: chat.type,
      title: chat.title,
      description: chat.description,
      avatarFileId: chat.avatar_file_id,
      memberCount: shownMemberCount(chat, memberIds(chat.id).length),
      isMember,
      approval: !!invite?.approval,
      requested: hasRequest(chat.id, user.id),
    };
  });

  app.post<{ Params: { token: string } }>('/api/invite/:token', async (req) => {
    const user = req.auth.user;
    const { chat, invite } = findInvite(req.params.token);
    if (getMember(chat.id, user.id)) return chatDTO(chat, user);
    if (invite && !inviteActive(invite)) throw notFound(txt.errors.inviteExpired);
    if (isChatBanned(chat.id, user.id)) {
      throw forbidden(isChannel(chat) ? txt.errors.bannedInChannel : txt.errors.bannedInGroup);
    }
    if (invite?.approval && !isAdmin(user)) {
      createRequest(chat, user, invite.token);
      return { requested: true };
    }
    joinByLink(chat, user, invite);
    membersChanged(chat.id);
    return chatDTO(chat, user);
  });

  // ---------- extra invite links: a name, a deadline, a limit of people, approval ----------

  app.get<IdParams>('/api/chats/:id/invites', async (req) => {
    const chat = requireGroup(intParam(req.params.id));
    requireRight(chat, req.auth.user, 'inviteUsers');
    return inviteDTOs(chat.id);
  });

  app.post<IdParams>('/api/chats/:id/invites', async (req) => {
    const chat = requireGroup(intParam(req.params.id));
    requireRight(chat, req.auth.user, 'inviteUsers');
    const body = parse(createInviteSchema, req.body);
    const count = (db.prepare('SELECT COUNT(*) c FROM chat_invites WHERE chat_id = ?').get(chat.id) as { c: number }).c;
    if (count >= MAX_INVITE_LINKS) throw badRequest(txt.errors.tooManyInvites(MAX_INVITE_LINKS));
    if (body.expiresAt !== null && body.expiresAt <= now()) throw badRequest(txt.errors.inviteExpired);
    return createInvite(chat, req.auth.user, body);
  });

  app.post<TokenParams>('/api/chats/:id/invites/:token/revoke', async (req) => {
    const chat = requireGroup(intParam(req.params.id));
    requireRight(chat, req.auth.user, 'inviteUsers');
    const res = db.prepare('UPDATE chat_invites SET revoked = 1 WHERE chat_id = ? AND token = ?').run(chat.id, req.params.token);
    if (!res.changes) throw notFound(txt.errors.invalidInvite);
    return inviteDTOs(chat.id);
  });

  app.delete<TokenParams>('/api/chats/:id/invites/:token', async (req) => {
    const chat = requireGroup(intParam(req.params.id));
    requireRight(chat, req.auth.user, 'inviteUsers');
    // requests that came by the link stay: they only lose the link's name
    db.prepare('DELETE FROM chat_invites WHERE chat_id = ? AND token = ?').run(chat.id, req.params.token);
    return inviteDTOs(chat.id);
  });

  // ---------- join requests ----------

  app.get<IdParams>('/api/chats/:id/requests', async (req) => {
    const chat = requireGroup(intParam(req.params.id));
    requireRight(chat, req.auth.user, 'inviteUsers');
    return listRequests(chat.id);
  });

  app.post<MemberParams>('/api/chats/:id/requests/:userId', async (req) => {
    const chat = requireGroup(intParam(req.params.id));
    requireRight(chat, req.auth.user, 'inviteUsers');
    const { approve } = parse(decideRequestSchema, req.body);
    decideRequest(chat, req.auth.user, intParam(req.params.userId), approve);
    if (approve) toChat(chat.id, EV.membersChanged, { chatId: chat.id });
    return listRequests(chat.id);
  });

  // ---------- statistics ----------

  app.get<IdParams & { Querystring: { tz?: string } }>('/api/chats/:id/stats', async (req) => {
    const user = req.auth.user;
    const chat = requireGroup(intParam(req.params.id));
    const m = getMember(chat.id, user.id);
    if (!isAdmin(user) && m?.role !== 'owner' && m?.role !== 'admin') throw forbidden(txt.errors.statsForbidden);
    const tz = Math.max(-840, Math.min(840, Number(req.query.tz) || 0));
    return chatStats(chat, user, tz);
  });

  app.post<IdParams>('/api/chats/:id/invite/reset', async (req) => {
    const chat = requireGroup(intParam(req.params.id));
    requireRight(chat, req.auth.user, 'inviteUsers');
    db.prepare('UPDATE chats SET invite_token = ? WHERE id = ?').run(newInviteToken(), chat.id);
    broadcastChat(chat.id);
    return chatDTO(requireChat(chat.id), req.auth.user);
  });

  app.get<IdParams>('/api/chats/:id/members', async (req) => {
    const chat = requireView(intParam(req.params.id), req.auth.user);
    // channel subscribers do not see each other
    if (!membership(chat, req.auth.user).canSeeMembers) throw forbidden(txt.errors.membersHidden);
    return membersDTO(chat.id);
  });

  app.post<IdParams>('/api/chats/:id/members', async (req) => {
    const user = req.auth.user;
    const chat = requireGroup(intParam(req.params.id));
    const me = membership(chat, user);
    if (!me.canInvite) throw forbidden(txt.errors.cannotInvite);
    const { userIds } = parse(z.object({ userIds: z.array(z.number().int().positive()).min(1).max(100) }), req.body);
    const added: UserRow[] = [];
    let restricted = 0;
    for (const u of usersByIds(userIds).values()) {
      if (u.is_banned || getMember(chat.id, u.id)) continue;
      if (!canInviteUser(user, u)) {
        restricted++;
        continue;
      }
      if (isChatBanned(chat.id, u.id)) {
        if (!me.rights.banUsers) continue;
        db.prepare('DELETE FROM chat_bans WHERE chat_id = ? AND user_id = ?').run(chat.id, u.id);
      }
      addMember(chat.id, u.id);
      added.push(u);
    }
    if (added.length) {
      const sid = memberEvent(chat, user.id, txt.service.added(displayName(user), added.map(displayName).join(', ')));
      botHooks.membersAdded(chat, user, added, sid);
      membersChanged(chat.id);
    }
    return { added: added.length, restricted };
  });

  app.patch<MemberParams>('/api/chats/:id/members/:userId', async (req) => {
    const user = req.auth.user;
    const chat = requireGroup(intParam(req.params.id));
    const actorRights = requireRight(chat, user, 'addAdmins');
    const target = getMember(chat.id, intParam(req.params.userId));
    if (!target) throw notFound(txt.errors.memberNotFound);
    if (!canActOn(chat, user, target)) throw forbidden(txt.errors.cannotEditRights);
    if (target.role === 'owner') throw forbidden(txt.errors.ownerRightsViaTransfer);
    const body = parse(updateMemberSchema, req.body);
    const actorIsOwner = isAdmin(user) || getMember(chat.id, user.id)?.role === 'owner';

    const role = body.role ?? target.role;
    let rights = role === 'admin' ? body.rights ?? (target.role === 'admin' ? parseRights(target) : DEFAULT_ADMIN_RIGHTS) : {};
    if (!actorIsOwner && role === 'admin') {
      // an admin can only grant rights they have themselves
      rights = Object.fromEntries(
        Object.entries(rights).map(([k, v]) => [k, v && actorRights[k as keyof typeof actorRights]]),
      ) as typeof rights;
    }
    db.prepare(
      'UPDATE chat_members SET role = ?, admin_rights = ?, custom_title = ? WHERE chat_id = ? AND user_id = ?',
    ).run(
      role,
      JSON.stringify(rights),
      role === 'admin' ? (body.customTitle ?? target.custom_title) : '',
      chat.id,
      target.user_id,
    );
    membersChanged(chat.id);
    return { ok: true };
  });

  app.post<MemberParams>('/api/chats/:id/members/:userId/kick', async (req) => {
    const user = req.auth.user;
    const chat = requireGroup(intParam(req.params.id));
    requireRight(chat, user, 'banUsers');
    const target = getMember(chat.id, intParam(req.params.userId));
    if (!target) throw notFound(txt.errors.memberNotFound);
    if (!canActOn(chat, user, target)) throw forbidden(txt.errors.cannotKick);
    if (target.role === 'owner') handOverOwnership(chat.id, target.user_id);
    removeMember(chat.id, target.user_id);
    const tu = requireTargetUser(target.user_id);
    const sid = memberEvent(chat, user.id, txt.service.kicked(displayName(user), displayName(tu)));
    botHooks.memberLeft(chat, user, tu, true, sid);
    membersChanged(chat.id);
    return { ok: true };
  });

  app.post<MemberParams>('/api/chats/:id/members/:userId/ban', async (req) => {
    const user = req.auth.user;
    const chat = requireGroup(intParam(req.params.id));
    requireRight(chat, user, 'banUsers');
    const tu = requireTargetUser(intParam(req.params.userId));
    const target = getMember(chat.id, tu.id);
    if (tu.id === user.id || !canActOn(chat, user, target)) throw forbidden(txt.errors.cannotBan);
    const { until } = parse(untilSchema, req.body);
    db.prepare(
      `INSERT INTO chat_bans (chat_id, user_id, banned_by, until, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(chat_id, user_id) DO UPDATE SET until = excluded.until, banned_by = excluded.banned_by`,
    ).run(chat.id, tu.id, user.id, until, now());
    if (target?.role === 'owner') handOverOwnership(chat.id, tu.id);
    if (target) removeMember(chat.id, tu.id);
    const sid = memberEvent(chat, user.id, txt.service.banned(displayName(user), displayName(tu), formatUntil(until)));
    if (target) botHooks.memberLeft(chat, user, tu, true, sid);
    membersChanged(chat.id);
    return { ok: true };
  });

  app.get<IdParams>('/api/chats/:id/bans', async (req) => {
    const chat = requireGroup(intParam(req.params.id));
    requireRight(chat, req.auth.user, 'banUsers');
    const rows = db
      .prepare('SELECT * FROM chat_bans WHERE chat_id = ? AND (until IS NULL OR until > ?) ORDER BY created_at DESC')
      .all(chat.id, now()) as { user_id: number; banned_by: number | null; until: number | null; created_at: number }[];
    const users = usersByIds(rows.map((r) => r.user_id));
    return rows
      .filter((r) => users.has(r.user_id))
      .map((r) => ({ user: userDTO(users.get(r.user_id)!), bannedBy: r.banned_by, until: r.until, createdAt: r.created_at }));
  });

  app.delete<MemberParams>('/api/chats/:id/bans/:userId', async (req) => {
    const chat = requireGroup(intParam(req.params.id));
    requireRight(chat, req.auth.user, 'banUsers');
    db.prepare('DELETE FROM chat_bans WHERE chat_id = ? AND user_id = ?').run(chat.id, intParam(req.params.userId));
    return { ok: true };
  });

  app.post<MemberParams>('/api/chats/:id/members/:userId/mute', async (req) => {
    const user = req.auth.user;
    const chat = requireGroup(intParam(req.params.id));
    requireRight(chat, user, 'banUsers');
    const target = getMember(chat.id, intParam(req.params.userId));
    if (!target) throw notFound(txt.errors.memberNotFound);
    if (!canActOn(chat, user, target)) throw forbidden(txt.errors.cannotMute);
    const { until } = parse(untilSchema, req.body);
    const value = until ?? MUTE_FOREVER;
    db.prepare('UPDATE chat_members SET muted_until = ? WHERE chat_id = ? AND user_id = ?').run(value, chat.id, target.user_id);
    const tu = requireTargetUser(target.user_id);
    memberEvent(chat, user.id, txt.service.muted(displayName(user), displayName(tu), formatUntil(value)));
    membersChanged(chat.id);
    return { ok: true };
  });

  app.post<MemberParams>('/api/chats/:id/members/:userId/unmute', async (req) => {
    const user = req.auth.user;
    const chat = requireGroup(intParam(req.params.id));
    requireRight(chat, user, 'banUsers');
    const target = getMember(chat.id, intParam(req.params.userId));
    if (!target) throw notFound(txt.errors.memberNotFound);
    if (!canActOn(chat, user, target)) throw forbidden();
    db.prepare('UPDATE chat_members SET muted_until = NULL WHERE chat_id = ? AND user_id = ?').run(chat.id, target.user_id);
    const tu = requireTargetUser(target.user_id);
    memberEvent(chat, user.id, txt.service.unmuted(displayName(user), displayName(tu)));
    membersChanged(chat.id);
    return { ok: true };
  });

  app.post<IdParams>('/api/chats/:id/transfer', async (req) => {
    const user = req.auth.user;
    const chat = requireGroup(intParam(req.params.id));
    const me = getMember(chat.id, user.id);
    if (!isAdmin(user) && me?.role !== 'owner') throw forbidden(txt.errors.onlyOwnerCanTransfer);
    const { userId } = parse(z.object({ userId: z.number().int().positive() }), req.body);
    // the global admin may take ownership of any group, joining it if needed
    if (isAdmin(user) && userId === user.id && !getMember(chat.id, user.id)) addMember(chat.id, user.id);
    const target = getMember(chat.id, userId);
    if (!target) throw notFound(txt.errors.memberNotFound);
    if (target.role === 'owner') return { ok: true };
    db.transaction(() => {
      db.prepare(`UPDATE chat_members SET role = 'admin', admin_rights = ? WHERE chat_id = ? AND role = 'owner'`).run(
        JSON.stringify(ALL_RIGHTS),
        chat.id,
      );
      db.prepare(`UPDATE chat_members SET role = 'owner', admin_rights = '{}' WHERE chat_id = ? AND user_id = ?`).run(
        chat.id,
        userId,
      );
      db.prepare('UPDATE chats SET owner_id = ? WHERE id = ?').run(userId, chat.id);
    })();
    const tu = requireTargetUser(userId);
    memberEvent(chat, user.id, txt.service.newOwner(displayName(tu)));
    membersChanged(chat.id);
    return { ok: true };
  });

  app.post<IdParams>('/api/chats/:id/pin', async (req) => {
    const user = req.auth.user;
    const chat = requireChat(intParam(req.params.id));
    if (!getMember(chat.id, user.id)) throw badRequest(txt.errors.notMember);
    const { pinned } = parse(z.object({ pinned: z.boolean() }), req.body);
    if (pinned) {
      const count = (
        db.prepare('SELECT COUNT(*) c FROM chat_members WHERE user_id = ? AND pinned_at IS NOT NULL AND chat_id != ?').get(user.id, chat.id) as {
          c: number;
        }
      ).c;
      if (count >= MAX_PINNED_CHATS) throw badRequest(txt.errors.tooManyPinned(MAX_PINNED_CHATS), 'too_many_pinned');
    }
    db.prepare('UPDATE chat_members SET pinned_at = ?, archived = CASE WHEN ? THEN 0 ELSE archived END WHERE chat_id = ? AND user_id = ?').run(
      pinned ? now() : null,
      pinned ? 1 : 0,
      chat.id,
      user.id,
    );
    const dto = chatDTO(chat, user);
    toUser(user.id, EV.chatUpdate, dto);
    return dto;
  });

  /**
   * The chat list's «Изменить»: pinned chats in a new order, the first on top. `ids` may be only some of the pinned
   * chats (a folder shows a part of them): they take each other's places, the rest keep theirs.
   */
  app.post('/api/chats/pins/order', async (req) => {
    const user = req.auth.user;
    const { ids } = parse(z.object({ ids: z.array(z.number().int().positive()).min(1).max(MAX_PINNED_CHATS) }), req.body);
    if (new Set(ids).size !== ids.length) throw badRequest(txt.errors.notPinned);
    const rows = db
      .prepare(
        `SELECT chat_id, pinned_at FROM chat_members WHERE user_id = ? AND pinned_at IS NOT NULL AND chat_id IN (${ids.map(() => '?').join(',')})`,
      )
      .all(user.id, ...ids) as { chat_id: number; pinned_at: number }[];
    if (rows.length !== ids.length) throw badRequest(txt.errors.notPinned);
    // The selected chats take each other's places: they get the very moments the selection held before,
    // just dealt out in the new order (the first id goes on top). The rest of the pins keep their moments,
    // so a partial reorder is stable. Equal moments are told apart by the chat id, not by array order.
    const ordered = [...rows].sort((a, b) => b.pinned_at - a.pinned_at || a.chat_id - b.chat_id);
    // strictly decreasing slot times: two equal moments get distinct ones, the smaller chat id stays on top
    const slots: number[] = [];
    for (let i = 0; i < ordered.length; i++) {
      const prev = i > 0 ? slots[i - 1]! - 1 : Infinity;
      slots.push(Math.min(ordered[i]!.pinned_at, prev));
    }
    const slotByChat = new Map(ordered.map((r, i) => [r.chat_id, slots[i]!]));
    const chosenSlots = [...slotByChat.values()].sort((a, b) => b - a); // the held slots, from top to bottom
    const set = db.prepare('UPDATE chat_members SET pinned_at = ? WHERE chat_id = ? AND user_id = ?');
    db.transaction(() => ids.forEach((id, i) => set.run(chosenSlots[i], id, user.id)))();
    return ids.map((id) => {
      const dto = chatDTO(requireChat(id), user);
      toUser(user.id, EV.chatUpdate, dto);
      return dto;
    });
  });

  app.post<IdParams>('/api/chats/:id/archive', async (req) => {
    const user = req.auth.user;
    const chat = requireChat(intParam(req.params.id));
    if (!getMember(chat.id, user.id)) throw badRequest(txt.errors.notMember);
    const { archived } = parse(z.object({ archived: z.boolean() }), req.body);
    // archiving unpins, like in Telegram
    db.prepare(
      'UPDATE chat_members SET archived = ?, pinned_at = CASE WHEN ? THEN NULL ELSE pinned_at END WHERE chat_id = ? AND user_id = ?',
    ).run(archived ? 1 : 0, archived ? 1 : 0, chat.id, user.id);
    const dto = chatDTO(chat, user);
    toUser(user.id, EV.chatUpdate, dto);
    return dto;
  });

  app.post<IdParams>('/api/chats/:id/notifications', async (req) => {
    const user = req.auth.user;
    const chat = requireChat(intParam(req.params.id));
    if (!getMember(chat.id, user.id)) throw badRequest(txt.errors.notMember);
    const { muted, seconds } = parse(notificationsSchema, req.body);
    const until = muted && seconds ? now() + seconds * 1000 : null;
    db.prepare('UPDATE chat_members SET notify_muted = ?, notify_muted_until = ? WHERE chat_id = ? AND user_id = ?').run(muted ? 1 : 0, until, chat.id, user.id);
    const dto = chatDTO(chat, user);
    toUser(user.id, EV.chatUpdate, dto);
    return dto;
  });

  app.post<IdParams>('/api/chats/:id/read', async (req) => {
    const { messageId } = parse(z.object({ messageId: z.number().int().positive() }), req.body);
    markRead(intParam(req.params.id), req.auth.user, messageId);
    return { ok: true };
  });

  app.post('/api/chats/read-all', async (req) => {
    const user = req.auth.user;
    const rows = db
      .prepare(
        `SELECT cm.chat_id, (SELECT MAX(id) FROM messages WHERE chat_id = cm.chat_id) AS max_id FROM chat_members cm
         WHERE cm.user_id = ? AND (cm.marked_unread = 1 OR cm.last_read_id < COALESCE((SELECT MAX(id) FROM messages WHERE chat_id = cm.chat_id), 0))`,
      )
      .all(user.id) as { chat_id: number; max_id: number | null }[];
    for (const r of rows) markRead(r.chat_id, user, r.max_id ?? 0);
    return { ok: true, count: rows.length };
  });

  app.post<IdParams>('/api/chats/:id/unread', async (req) => {
    const user = req.auth.user;
    const chat = requireChat(intParam(req.params.id));
    if (!getMember(chat.id, user.id)) throw badRequest(txt.errors.notMember);
    const { unread } = parse(z.object({ unread: z.boolean() }), req.body);
    db.prepare('UPDATE chat_members SET marked_unread = ? WHERE chat_id = ? AND user_id = ?').run(unread ? 1 : 0, chat.id, user.id);
    const dto = chatDTO(chat, user);
    toUser(user.id, EV.chatUpdate, dto);
    return dto;
  });

  app.get<IdParams & { Querystring: { tz?: string } }>('/api/chats/:id/export', async (req, reply) => {
    const tz = Number(req.query.tz);
    const { title, text } = exportChat(intParam(req.params.id), req.auth.user, Number.isFinite(tz) && Math.abs(tz) <= 840 ? tz : 0);
    const name = `${title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').slice(0, 60).trim() || 'chat'}.txt`;
    reply.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    reply.header('Cache-Control', 'no-store');
    return reply.type('text/plain; charset=utf-8').send(text);
  });

  app.post<IdParams>('/api/chats/:id/pins', async (req) => {
    const { messageId, pinned } = parse(
      z.object({ messageId: z.number().int().positive(), pinned: z.boolean() }),
      req.body,
    );
    setPinned(intParam(req.params.id), messageId, req.auth.user, pinned);
    return { ok: true };
  });

  app.post<IdParams>('/api/chats/:id/clear', async (req) => {
    const chat = requireView(intParam(req.params.id), req.auth.user);
    const { forAll } = parse(clearHistorySchema, req.body ?? {});
    clearHistory(chat.id, req.auth.user, forAll);
    return chatDTO(chat, req.auth.user);
  });

  app.get<IdParams & { Querystring: { kind?: string; before?: string } }>('/api/chats/:id/media', async (req) => {
    const kind = req.query.kind === 'file' ? 'file' : req.query.kind === 'voice' ? 'voice' : 'media';
    const rows = sharedMedia(intParam(req.params.id), req.auth.user, kind, optInt(req.query.before));
    return rows.map((r) => ({ messageId: r.message_id, senderId: r.sender_id, createdAt: r.message_at, file: fileDTO(r) }));
  });

  app.get<IdParams>('/api/chats/:id/rights', async (req) => {
    const chat = requireView(intParam(req.params.id), req.auth.user);
    return rightsOf(req.auth.user, chat, getMember(chat.id, req.auth.user.id));
  });
}
