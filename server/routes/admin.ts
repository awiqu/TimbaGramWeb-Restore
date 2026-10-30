import { deleteBot } from '../bots/manage.js';
import { ownBots } from '../bots/store.js';
import type { AdminGameSort, AdminUploadSort, AdminBadgeDTO, AdminChatDTO, AdminStats, AdminUserDetail, AdminUserDTO, BannedDeviceDTO, SessionDTO } from '@timba/shared';
import {
  ADMIN_USERNAME,
  EV,
  adminBoostSchema,
  adminBroadcastSchema,
  BOOST_MAX,
  adminDeleteUserSchema,
  adminPasswordSchema,
  adminPremiumSchema,
  adminPromoSchema,
  PREMIUM_DAYS,
  adminSendSchema,
  adminSettingsSchema,
  adminGameResetSchema,
  adminGameSaveSchema,
  adminLabelsSchema,
  adminAwardSchema,
  adminBadgeSchema,
  adminTagSchema,
  adminUploadsDeleteSchema,
  adminUploadsFilterSchema,
  adminUserBadgeSchema,
  banDeviceSchema,
  banUserSchema,
  deleteMessagesSchema,
} from '@timba/shared';
import { deleteUploads, listUploads, uploadIds, uploadsSummary } from '../services/uploads.js';
import { gameSaveDetail, gamesSummary, listGameSaves, resetGameSave, restoreGameBackup, setGameSave } from '../gameAdmin.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  ADMIN_RETURN_COOKIE,
  SESSION_COOKIE,
  createSession,
  hashPassword,
  isAdmin,
  requireAdmin,
  setSessionCookie,
} from '../auth.js';
import { db, now } from '../db.js';
import { banDevice, devicesOf, listBannedDevices, unbanDevice } from '../devices.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { type ChatRow, isGroupLike, requireChat } from '../permissions.js';
import {
  disconnectAllExcept,
  disconnectDevice,
  disconnectSessions,
  disconnectUser,
  onlineCount,
  toAll,
  toChat,
  toUser,
} from '../realtime.js';
import {
  type MessageRow,
  type UserRow,
  getUserRow,
  isPremium,
  messagesDTO,
  userDTO,
  usersByIds,
} from '../serialize.js';
import { broadcastChat, deleteChat, getOrCreatePrivate, shownMemberCount } from '../services/chats.js';
import { closeAccount } from '../bank/bank.js';
import { announcePremium, createPromo, cutPremium, deletePromo, extendPremium, listPromos, removePremium, setPremiumUntil } from '../premium.js';
import { notify as sendNotification } from '../notifications.js';
import { uploadsBytes } from '../services/files.js';
import { insertMessage, listMessages, publishMessage, sendMessage } from '../services/messages.js';
import { appStatus, getSettings, updateSettings } from '../settings.js';
import { intParam, optInt, parse } from '../util.js';
import { txt } from '../strings.js';
import { labelsDTO, serverLabelDefaults, updateLabels } from '../labels.js';
import {
  addAward,
  addTag,
  announceUser,
  createBadge,
  deleteBadge,
  listBadges,
  profileExtras,
  removeAward,
  removeTag,
  setUserBadge,
  updateBadge,
} from '../profile.js';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { customLogoPath, resetIconCache } from './pwa.js';

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { c: number }).c;
const DAY = 86400_000;

function adminUserDTO(r: UserRow): AdminUserDTO {
  // the admin sees the real profile, privacy settings do not apply
  return {
    ...userDTO(r, { self: true }),
    isBanned: !!r.is_banned,
    banReason: r.ban_reason,
    createdAt: r.created_at,
    premiumUntil: isPremium(r) ? r.premium_until : null,
  };
}

function requireUser(id: unknown): UserRow {
  const u = getUserRow(intParam(id));
  if (!u) throw notFound(txt.errors.userNotFound);
  return u;
}

/** A user the admin may ban, delete, sign in as… — anybody but the admin themself. */
function requireTarget(id: unknown): UserRow {
  const u = requireUser(id);
  if (isAdmin(u)) throw forbidden(txt.errors.cannotTouchAdmin);
  return u;
}

function sessionsOf(userId: number): SessionDTO[] {
  const rows = db.prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY last_used_at DESC').all(userId) as {
    id: string;
    user_agent: string;
    ip: string;
    created_at: number;
    last_used_at: number;
    impersonator_id: number | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    userAgent: r.user_agent,
    ip: r.ip,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    current: false,
    impersonated: !!r.impersonator_id,
  }));
}

/**
 * Remove an account for good. Private chats with the user disappear for both sides, owned groups and
 * channels go to the next admin (or oldest member) or are deleted when nobody is left.
 */
function deleteUser(u: UserRow, wipeMessages: boolean) {
  toUser(u.id, EV.sessionRevoked, {});
  disconnectUser(u.id);
  closeAccount(u);
  // the bots the person made go with them (nobody could manage them any more)
  for (const { bot } of ownBots(u.id)) deleteBot(bot);

  const privateIds = (
    db
      .prepare(`SELECT c.id FROM chats c JOIN chat_members m ON m.chat_id = c.id WHERE m.user_id = ? AND c.type = 'private'`)
      .all(u.id) as { id: number }[]
  ).map((r) => r.id);
  for (const id of privateIds) deleteChat(id);

  const owned = db.prepare(`SELECT * FROM chats WHERE owner_id = ? AND type IN ('group', 'channel')`).all(u.id) as ChatRow[];
  for (const chat of owned) {
    const next = db
      .prepare(
        `SELECT user_id FROM chat_members WHERE chat_id = ? AND user_id != ?
         ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, joined_at LIMIT 1`,
      )
      .get(chat.id, u.id) as { user_id: number } | undefined;
    if (!next) {
      deleteChat(chat.id);
      continue;
    }
    db.prepare(`UPDATE chat_members SET role = 'owner', admin_rights = '{}' WHERE chat_id = ? AND user_id = ?`).run(
      chat.id,
      next.user_id,
    );
    db.prepare('UPDATE chats SET owner_id = ? WHERE id = ?').run(next.user_id, chat.id);
  }

  if (wipeMessages) {
    const rows = db.prepare('SELECT id, chat_id FROM messages WHERE sender_id = ?').all(u.id) as { id: number; chat_id: number }[];
    const byChat = new Map<number, number[]>();
    for (const r of rows) byChat.set(r.chat_id, [...(byChat.get(r.chat_id) ?? []), r.id]);
    db.prepare('DELETE FROM messages WHERE sender_id = ?').run(u.id);
    for (const [chatId, ids] of byChat) toChat(chatId, EV.messageDelete, { chatId, ids });
  }

  const groups = (db.prepare('SELECT chat_id FROM chat_members WHERE user_id = ?').all(u.id) as { chat_id: number }[]).map(
    (r) => r.chat_id,
  );
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  for (const chatId of groups) {
    toChat(chatId, EV.membersChanged, { chatId });
    broadcastChat(chatId);
  }
}

function adminChatDTO(chat: { id: number; last_activity_at: number; message_count: number }): AdminChatDTO {
  const ids = (db.prepare('SELECT user_id FROM chat_members WHERE chat_id = ? ORDER BY user_id').all(chat.id) as { user_id: number }[]).map(
    (r) => r.user_id,
  );
  const users = usersByIds(ids);
  const last = db
    .prepare(`SELECT * FROM messages WHERE chat_id = ? AND thread_id IS NULL ORDER BY id DESC LIMIT 1`)
    .get(chat.id) as MessageRow | undefined;
  return {
    id: chat.id,
    members: ids.filter((id) => users.has(id)).map((id) => userDTO(users.get(id)!, { self: true })),
    messageCount: chat.message_count,
    lastMessage: last ? (messagesDTO([last])[0] ?? null) : null,
    lastActivityAt: chat.last_activity_at,
  };
}

function requirePrivateChat(id: unknown): ChatRow {
  const chat = requireChat(intParam(id));
  if (chat.type !== 'private') throw badRequest(txt.errors.chatNotFound);
  return chat;
}

export default async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin);

  // ---------- overview ----------
  app.get('/api/admin/stats', async (): Promise<AdminStats> => {
    const t = now();
    const since = t - 13 * DAY;
    const start = new Date(since);
    start.setHours(0, 0, 0, 0);
    const perDay = db
      .prepare(
        `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch', 'localtime') day, COUNT(*) c
         FROM messages WHERE created_at >= ? AND kind != 'service' GROUP BY day`,
      )
      .all(start.getTime()) as { day: string; c: number }[];
    const byDay = new Map(perDay.map((r) => [r.day, r.c]));
    const messagesByDay: AdminStats['messagesByDay'] = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(start.getTime() + i * DAY + DAY / 2);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      messagesByDay.push({ day: key, count: byDay.get(key) ?? 0 });
    }
    const top = db
      .prepare(
        `SELECT sender_id, COUNT(*) c FROM messages WHERE created_at >= ? AND sender_id IS NOT NULL AND kind != 'service'
         GROUP BY sender_id ORDER BY c DESC LIMIT 5`,
      )
      .all(t - 7 * DAY) as { sender_id: number; c: number }[];
    const topUsers = usersByIds(top.map((r) => r.sender_id));
    return {
      users: count('SELECT COUNT(*) c FROM users WHERE bot IS NULL AND is_bot = 0'),
      bannedUsers: count('SELECT COUNT(*) c FROM users WHERE is_banned = 1'),
      groups: count(`SELECT COUNT(*) c FROM chats WHERE type = 'group'`),
      channels: count(`SELECT COUNT(*) c FROM chats WHERE type = 'channel'`),
      privateChats: count(`SELECT COUNT(*) c FROM chats WHERE type = 'private'`),
      messages: count('SELECT COUNT(*) c FROM messages'),
      files: count('SELECT COUNT(*) c FROM files'),
      filesBytes: uploadsBytes(),
      online: onlineCount(),
      sessions: count('SELECT COUNT(*) c FROM sessions WHERE impersonator_id IS NULL'),
      newUsersWeek: count('SELECT COUNT(*) c FROM users WHERE created_at >= ?', t - 7 * DAY),
      messagesDay: count(`SELECT COUNT(*) c FROM messages WHERE created_at >= ? AND kind != 'service'`, t - DAY),
      messagesByDay,
      topSenders: top
        .filter((r) => topUsers.has(r.sender_id))
        .map((r) => ({ user: userDTO(topUsers.get(r.sender_id)!, { self: true }), count: r.c })),
    };
  });

  // ---------- users ----------
  app.get<{ Querystring: { q?: string; offset?: string; filter?: string } }>('/api/admin/users', async (req) => {
    const q = escapeLike((req.query.q ?? '').trim().replace(/^@/, ''));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const filter =
      req.query.filter === 'banned' ? 'AND is_banned = 1' : req.query.filter === 'new' ? `AND created_at >= ${now() - 7 * DAY}` : '';
    const rows = db
      .prepare(
        `SELECT * FROM users WHERE (username LIKE @q ESCAPE '\\' OR (first_name || ' ' || last_name) LIKE @q ESCAPE '\\') ${filter}
         ORDER BY id DESC LIMIT 50 OFFSET @offset`,
      )
      .all({ q: `%${q}%`, offset }) as UserRow[];
    let list = rows.map(adminUserDTO);
    if (req.query.filter === 'online') list = list.filter((u) => u.online);
    return list;
  });

  app.get<{ Params: { id: string } }>('/api/admin/users/:id', async (req): Promise<AdminUserDetail> => {
    const u = requireUser(req.params.id);
    return {
      ...adminUserDTO(u),
      realLastSeenAt: u.last_seen_at,
      isAdmin: isAdmin(u),
      messageCount: count('SELECT COUNT(*) c FROM messages WHERE sender_id = ?', u.id),
      chatCount: count('SELECT COUNT(*) c FROM chat_members WHERE user_id = ?', u.id),
      ownedGroups: count(`SELECT COUNT(*) c FROM chats WHERE owner_id = ? AND type IN ('group', 'channel')`, u.id),
      sessions: sessionsOf(u.id),
      devices: devicesOf(u.id),
      ...profileExtras(u.id),
    };
  });

  app.post<{ Params: { id: string } }>('/api/admin/users/:id/ban', async (req) => {
    const u = requireUser(req.params.id);
    if (isAdmin(u)) throw forbidden(txt.errors.cannotBanAdmin);
    const { reason, devices } = parse(banUserSchema, req.body);
    db.prepare('UPDATE users SET is_banned = 1, ban_reason = ? WHERE id = ?').run(reason, u.id);
    toUser(u.id, EV.accountBanned, { reason });
    disconnectUser(u.id);
    let banned = 0;
    if (devices) {
      for (const d of devicesOf(u.id)) {
        if (banDevice(d.id, reason, u)) banned++;
        void disconnectDevice(d.id, { reason, device: true });
      }
    }
    return { ok: true, devices: banned };
  });

  app.post<{ Params: { id: string } }>('/api/admin/users/:id/unban', async (req) => {
    const u = requireUser(req.params.id);
    db.prepare(`UPDATE users SET is_banned = 0, ban_reason = '' WHERE id = ?`).run(u.id);
    // the devices that were banned through this account are let in again
    const freed = db.prepare('DELETE FROM banned_devices WHERE user_id = ?').run(u.id).changes;
    return { ok: true, devices: freed };
  });

  // ---------- device bans ----------
  const requireDeviceId = (id: string) => {
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) throw badRequest(txt.errors.invalidId);
    return id;
  };

  /** Ban one device: nobody can open an account or sign in on it (the admin excepted). */
  app.post<{ Params: { deviceId: string }; Querystring: { userId?: string } }>('/api/admin/devices/:deviceId/ban', async (req) => {
    const id = requireDeviceId(req.params.deviceId);
    const { reason } = parse(banDeviceSchema, req.body ?? {});
    const via = req.query.userId ? requireTarget(req.query.userId) : null;
    const known = db.prepare('SELECT 1 FROM user_devices WHERE device_id = ?').get(id);
    if (!known) throw notFound(txt.errors.deviceNotFound);
    banDevice(id, reason, via);
    void disconnectDevice(id, { reason, device: true });
    return { ok: true };
  });

  app.post<{ Params: { deviceId: string } }>('/api/admin/devices/:deviceId/unban', async (req) => {
    if (!unbanDevice(requireDeviceId(req.params.deviceId))) throw notFound(txt.errors.deviceNotFound);
    return { ok: true };
  });

  app.get('/api/admin/devices/banned', async (): Promise<BannedDeviceDTO[]> =>
    listBannedDevices().map((r) => ({ id: r.device_id, reason: r.reason, bannedAt: r.banned_at, userId: r.user_id, username: r.username })),
  );

  /** TimbaGram Premium: give, extend, make it endless, set or cut its end, or take it away. */
  app.post<{ Params: { id: string } }>('/api/admin/users/:id/premium', async (req) => {
    const u = requireUser(req.params.id);
    const { action, days, until: at, notify } = parse(adminPremiumSchema, req.body);
    const had = isPremium(u);
    let until: number | null = null;
    if (action === 'give') until = extendPremium(u.id, days ?? PREMIUM_DAYS);
    else if (action === 'forever') until = extendPremium(u.id, null);
    else if (action === 'until') {
      if (!at) throw badRequest(txt.premium.noDate);
      until = setPremiumUntil(u.id, at);
    } else if (action === 'cut') until = cutPremium(u.id, days ?? 1);
    else removePremium(u.id);
    announcePremium(u.id);
    if (notify !== false && u.id !== req.auth.user.id) {
      const when = until && txt.premium.until(until);
      sendNotification('bank', u.id, !when ? txt.premium.removed : had ? txt.premium.changed(when) : txt.premium.given(when));
    }
    return { premiumUntil: until };
  });

  // ---------- Премиум promo codes ----------
  app.get('/api/admin/promos', async () => listPromos());

  app.post('/api/admin/promos', async (req) => createPromo(parse(adminPromoSchema, req.body)));

  app.delete<{ Params: { id: string } }>('/api/admin/promos/:id', async (req) => {
    deletePromo(intParam(req.params.id));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/admin/users/:id/logout', async (req) => {
    const u = requireTarget(req.params.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    toUser(u.id, EV.sessionRevoked, {});
    disconnectUser(u.id);
    return { ok: true };
  });

  app.delete<{ Params: { id: string; sid: string } }>('/api/admin/users/:id/sessions/:sid', async (req) => {
    const u = requireTarget(req.params.id);
    const r = db.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(req.params.sid, u.id);
    if (!r.changes) throw notFound(txt.errors.sessionNotFound);
    await disconnectSessions(new Set([req.params.sid]), EV.sessionRevoked);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/admin/users/:id/password', async (req) => {
    const u = requireTarget(req.params.id);
    const { password } = parse(adminPasswordSchema, req.body);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), u.id);
    return { ok: true };
  });

  /** Sign in as the user; the admin's own session waits in a separate cookie. */
  app.post<{ Params: { id: string } }>('/api/admin/users/:id/impersonate', async (req, reply) => {
    const u = requireTarget(req.params.id);
    const token = createSession(u.id, txt.labels.impersonationDevice, req.ip, req.auth.user.id);
    setSessionCookie(reply, req.cookies[SESSION_COOKIE]!, ADMIN_RETURN_COOKIE);
    setSessionCookie(reply, token);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/admin/users/:id/delete', async (req) => {
    const u = requireTarget(req.params.id);
    const { wipeMessages } = parse(adminDeleteUserSchema, req.body);
    deleteUser(u, wipeMessages);
    return { ok: true };
  });

  // ---------- private chats ----------
  app.get<{ Querystring: { q?: string; userId?: string; offset?: string } }>('/api/admin/chats', async (req) => {
    const q = escapeLike((req.query.q ?? '').trim().replace(/^@/, ''));
    const rows = db
      .prepare(
        `SELECT c.id, c.last_activity_at, (SELECT COUNT(*) FROM messages x WHERE x.chat_id = c.id) AS message_count
         FROM chats c WHERE c.type = 'private'
         AND NOT EXISTS (SELECT 1 FROM chat_members m WHERE m.chat_id = c.id AND m.user_id = @me)
         AND (@q = '' OR EXISTS (SELECT 1 FROM chat_members m JOIN users u ON u.id = m.user_id WHERE m.chat_id = c.id
           AND (u.username LIKE @like ESCAPE '\\' OR (u.first_name || ' ' || u.last_name) LIKE @like ESCAPE '\\')))
         AND (@user IS NULL OR EXISTS (SELECT 1 FROM chat_members m WHERE m.chat_id = c.id AND m.user_id = @user))
         ORDER BY c.last_activity_at DESC LIMIT 50 OFFSET @offset`,
      )
      .all({
        q,
        like: `%${q}%`,
        user: optInt(req.query.userId) ?? null,
        offset: Math.max(0, Number(req.query.offset) || 0),
        // the admin's own chats are in their chat list, not here
        me: req.auth.user.id,
      }) as { id: number; last_activity_at: number; message_count: number }[];
    return rows.map(adminChatDTO);
  });

  app.get<{ Params: { id: string } }>('/api/admin/chats/:id', async (req) => {
    const chat = requirePrivateChat(req.params.id);
    return adminChatDTO({
      id: chat.id,
      last_activity_at: chat.last_activity_at,
      message_count: count('SELECT COUNT(*) c FROM messages WHERE chat_id = ?', chat.id),
    });
  });

  app.get<{ Params: { id: string }; Querystring: { before?: string; after?: string } }>(
    '/api/admin/chats/:id/messages',
    async (req) => {
      const chat = requirePrivateChat(req.params.id);
      return listMessages(chat.id, req.auth.user, { before: optInt(req.query.before), after: optInt(req.query.after) });
    },
  );

  /** Write into a private chat on behalf of one of its members. */
  app.post<{ Params: { id: string } }>('/api/admin/chats/:id/messages', async (req) => {
    const chat = requirePrivateChat(req.params.id);
    const body = parse(adminSendSchema, req.body);
    const as = requireUser(body.asUserId);
    return sendMessage(chat.id, as, { text: body.text, replyToId: body.replyToId, fileIds: [] });
  });

  /** Delete any messages for everybody. */
  app.post('/api/admin/messages/delete', async (req) => {
    const { ids } = parse(deleteMessagesSchema, req.body);
    const rows = db
      .prepare(`SELECT id, chat_id FROM messages WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as { id: number; chat_id: number }[];
    const byChat = new Map<number, number[]>();
    for (const r of rows) byChat.set(r.chat_id, [...(byChat.get(r.chat_id) ?? []), r.id]);
    for (const [chatId, mids] of byChat) {
      db.prepare(`DELETE FROM messages WHERE id IN (${mids.map(() => '?').join(',')})`).run(...mids);
      toChat(chatId, EV.messageDelete, { chatId, ids: mids });
    }
    return { ok: true };
  });

  // ---------- uploaded files ----------
  const uploadSorts = new Set(['date', 'size', 'kind', 'name', 'chat', 'uploader']);
  app.get<{ Querystring: Record<string, string | undefined> }>('/api/admin/uploads', async (req) => {
    const q = req.query;
    const filter = parse(adminUploadsFilterSchema, {
      kind: q.kind || undefined,
      q: q.q || undefined,
      chatId: q.chatId ? Number(q.chatId) : undefined,
      usage: q.usage || undefined,
    });
    const sort = (uploadSorts.has(q.sort ?? '') ? q.sort : 'date') as AdminUploadSort;
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 100);
    return listUploads(filter, sort, q.order !== 'asc', Math.max(Number(q.offset) || 0, 0), limit);
  });

  app.get('/api/admin/uploads/summary', async () => uploadsSummary());

  app.post('/api/admin/uploads/delete', async (req) => {
    const body = parse(adminUploadsDeleteSchema, req.body);
    return deleteUploads(body.all ? uploadIds(body.filter ?? {}) : (body.ids ?? []));
  });

  // ---------- mini-games: every player's progress ----------
  const gameSorts = new Set(['updated', 'progress', 'name']);
  app.get('/api/admin/games', async () => gamesSummary());

  app.get<{ Querystring: Record<string, string | undefined> }>('/api/admin/games/saves', async (req) => {
    const q = req.query;
    return listGameSaves({
      game: q.game || undefined,
      userId: q.userId ? intParam(q.userId) : undefined,
      q: q.q?.slice(0, 100),
      has: q.has === 'yes' || q.has === 'no' ? q.has : undefined,
      min: optInt(q.min),
      max: optInt(q.max),
      sort: (gameSorts.has(q.sort ?? '') ? q.sort : 'updated') as AdminGameSort,
      desc: q.order !== 'asc',
      offset: Math.max(Number(q.offset) || 0, 0),
      limit: Math.min(Math.max(Number(q.limit) || 50, 1), 100),
    });
  });

  app.get<{ Params: { userId: string; game: string } }>('/api/admin/games/saves/:userId/:game', async (req) =>
    gameSaveDetail(intParam(req.params.userId), req.params.game),
  );

  app.put('/api/admin/games/saves', async (req) => {
    const { userId, game, values } = parse(adminGameSaveSchema, req.body);
    return setGameSave(userId, game, values);
  });

  app.post('/api/admin/games/saves/reset', async (req) => {
    const { userId, game } = parse(adminGameResetSchema, req.body);
    return resetGameSave(userId, game);
  });

  app.post<{ Params: { userId: string; id: string } }>('/api/admin/games/clicker/:userId/backups/:id/restore', async (req) =>
    restoreGameBackup(intParam(req.params.userId), intParam(req.params.id)),
  );

  // ---------- groups & channels ----------
  app.get<{ Querystring: { q?: string } }>('/api/admin/groups', async (req) => {
    const q = escapeLike((req.query.q ?? '').trim().replace(/^@/, ''));
    const rows = db
      .prepare(
        `SELECT c.*,
           (SELECT COUNT(*) FROM chat_members m WHERE m.chat_id = c.id) AS member_count,
           (SELECT COUNT(*) FROM messages x WHERE x.chat_id = c.id) AS message_count
         FROM chats c WHERE c.type IN ('group', 'channel') AND (c.title LIKE @q ESCAPE '\\' OR COALESCE(c.public_username, '') LIKE @q ESCAPE '\\')
         ORDER BY c.last_activity_at DESC LIMIT 100`,
      )
      .all({ q: `%${q}%` }) as (ChatRow & { member_count: number; message_count: number })[];
    const owners = usersByIds(rows.map((r) => r.owner_id).filter((x): x is number => x != null));
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      avatarFileId: r.avatar_file_id,
      isPublic: !!r.is_public,
      publicUsername: r.public_username,
      memberCount: shownMemberCount(r, r.member_count),
      boostSubscribers: r.type === 'channel' ? r.boost_subscribers : 0,
      messageCount: r.message_count,
      owner: r.owner_id && owners.has(r.owner_id) ? userDTO(owners.get(r.owner_id)!) : null,
      createdAt: r.created_at,
    }));
  });

  app.post<{ Params: { id: string } }>('/api/admin/groups/:id/delete', async (req) => {
    const chat = requireChat(intParam(req.params.id));
    if (!isGroupLike(chat)) throw badRequest(txt.errors.notAGroup);
    deleteChat(chat.id);
    return { ok: true };
  });

  /** Fake subscribers on top of the real ones; everybody sees the sum. */
  app.post<{ Params: { id: string } }>('/api/admin/groups/:id/boost', async (req) => {
    const chat = requireChat(intParam(req.params.id));
    if (chat.type !== 'channel') throw badRequest(txt.errors.notAChannel);
    const { mode, count } = parse(adminBoostSchema, req.body);
    const boost = Math.min(BOOST_MAX, Math.max(0, mode === 'set' ? count : (chat.boost_subscribers ?? 0) + count));
    db.prepare('UPDATE chats SET boost_subscribers = ? WHERE id = ?').run(boost, chat.id);
    broadcastChat(chat.id, [req.auth.user.id]);
    return { boostSubscribers: boost };
  });

  // ---------- messenger ----------
  /** A message from @admin to every user, in their private chat with the admin. */
  app.post('/api/admin/broadcast', async (req) => {
    const { text } = parse(adminBroadcastSchema, req.body);
    const admin = req.auth.user;
    const users = db.prepare('SELECT * FROM users WHERE is_banned = 0 AND bot IS NULL AND is_bot = 0 AND id != ?').all(admin.id) as UserRow[];
    for (const u of users) {
      const chat = getOrCreatePrivate(admin, u);
      broadcastChat(chat.id);
      publishMessage(chat, admin, insertMessage(chat, admin, { text, files: [] }));
    }
    return { sent: users.length };
  });

  app.get('/api/admin/settings', async () => appStatus());

  app.put('/api/admin/settings', async (req) => {
    const { forceReload, ...patch } = parse(adminSettingsSchema, req.body);
    updateSettings({ ...patch, ...(forceReload ? { buildId: getSettings().buildId + 1 } : {}) });
    const status = appStatus();
    toAll(EV.appStatus, status);
    if (status.maintenance) {
      const admin = db.prepare('SELECT id FROM users WHERE username = ?').get(ADMIN_USERNAME) as { id: number } | undefined;
      await disconnectAllExcept(new Set(admin ? [admin.id] : []));
    }
    return status;
  });

  // ---------- labels ----------
  app.get('/api/admin/labels', async () => ({ ...labelsDTO(), serverDefaults: serverLabelDefaults }));

  app.put('/api/admin/labels', async (req) => {
    const { set, reload } = parse(adminLabelsSchema, req.body);
    const dto = updateLabels(set);
    if (reload) updateSettings({ buildId: getSettings().buildId + 1 });
    // clients fetch the new texts on the next start; `reload` makes every open tab restart now
    toAll(EV.appStatus, appStatus());
    return dto;
  });

  // ---------- значки у имени, подписи под ником и награды ----------
  /** The picture and, for a new badge, the title from a multipart form (the title goes before the file). */
  async function readBadgeForm(req: FastifyRequest) {
    const part = await req.file({ limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
    if (!part) throw badRequest(txt.errors.noFile);
    const file = await part.toBuffer();
    const field = part.fields.title as { value?: unknown } | undefined;
    return { file, title: typeof field?.value === 'string' ? field.value : '' };
  }

  app.get('/api/admin/badges', async (): Promise<AdminBadgeDTO[]> => listBadges());

  app.post('/api/admin/badges', async (req): Promise<AdminBadgeDTO> => {
    const { file, title } = await readBadgeForm(req);
    return createBadge(parse(adminBadgeSchema, { title }).title, file);
  });

  app.patch<{ Params: { id: string } }>('/api/admin/badges/:id', async (req): Promise<AdminBadgeDTO> =>
    updateBadge(intParam(req.params.id), { title: parse(adminBadgeSchema, req.body).title }),
  );

  app.put<{ Params: { id: string } }>('/api/admin/badges/:id/image', async (req): Promise<AdminBadgeDTO> => {
    const { file } = await readBadgeForm(req);
    return updateBadge(intParam(req.params.id), { file });
  });

  app.delete<{ Params: { id: string } }>('/api/admin/badges/:id', async (req) => {
    deleteBadge(intParam(req.params.id));
    return { ok: true };
  });

  /** Give a user a badge (it appears left of their name everywhere) or take it away with null. */
  app.post<{ Params: { id: string } }>('/api/admin/users/:id/badge', async (req) => {
    const u = requireUser(req.params.id);
    setUserBadge(u.id, parse(adminUserBadgeSchema, req.body).badgeId);
    return { badge: userDTO(requireUser(u.id), { self: true }).badge };
  });

  app.post<{ Params: { id: string } }>('/api/admin/users/:id/tags', async (req) => {
    const u = requireUser(req.params.id);
    const { text, color } = parse(adminTagSchema, req.body);
    addTag(u.id, text, color);
    announceUser(u.id);
    return profileExtras(u.id);
  });

  app.delete<{ Params: { id: string; tagId: string } }>('/api/admin/users/:id/tags/:tagId', async (req) => {
    const u = requireUser(req.params.id);
    removeTag(u.id, intParam(req.params.tagId));
    announceUser(u.id);
    return profileExtras(u.id);
  });

  app.post<{ Params: { id: string } }>('/api/admin/users/:id/awards', async (req) => {
    const u = requireUser(req.params.id);
    addAward(u.id, parse(adminAwardSchema, req.body));
    announceUser(u.id);
    return profileExtras(u.id);
  });

  app.delete<{ Params: { id: string; awardId: string } }>('/api/admin/users/:id/awards/:awardId', async (req) => {
    const u = requireUser(req.params.id);
    removeAward(u.id, intParam(req.params.awardId));
    announceUser(u.id);
    return profileExtras(u.id);
  });

  // ---------- logo ----------
  /** Any picture becomes a 512×512 PNG: app icons, favicon and the login screen use it. */
  app.post('/api/admin/logo', async (req) => {
    const part = await req.file({ limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
    if (!part) throw badRequest(txt.errors.noFile);
    const data = await part.toBuffer();
    let png: Buffer;
    try {
      png = await sharp(data).rotate().resize(512, 512, { fit: 'cover' }).png().toBuffer();
    } catch {
      throw badRequest(txt.errors.imageRequired);
    }
    fs.mkdirSync(path.dirname(customLogoPath()), { recursive: true });
    fs.writeFileSync(customLogoPath(), png);
    updateSettings({ logoVersion: now() });
    resetIconCache();
    const status = appStatus();
    toAll(EV.appStatus, status);
    return status;
  });

  app.delete('/api/admin/logo', async () => {
    fs.rmSync(customLogoPath(), { force: true });
    updateSettings({ logoVersion: 0 });
    resetIconCache();
    const status = appStatus();
    toAll(EV.appStatus, status);
    return status;
  });
}
