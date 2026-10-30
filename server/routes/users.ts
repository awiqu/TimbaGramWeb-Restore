import type { UserProfileDTO } from '@timba/shared';
import { EV, normalizePhone } from '@timba/shared';
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../auth.js';
import { db, now } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import type { ChatRow } from '../permissions.js';
import { botHooks } from '../bots/hooks.js';
import { toUser } from '../realtime.js';
import {
  type UserRow,
  blockedIdsOf,
  getUserByUsername,
  getUserRow,
  isBlockedBy,
  parsePrivacy,
  userDTO,
  userDTOFor,
  usersByIds,
  visiblePhone,
} from '../serialize.js';
import { profileExtras } from '../profile.js';
import { chatDTO } from '../services/chats.js';
import { intParam } from '../util.js';
import { txt } from '../strings.js';

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export default async function userRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);

  app.get<{ Querystring: { q?: string } }>('/api/search', async (req) => {
    const q = (req.query.q ?? '').trim().replace(/^@/, '');
    if (!q) return { users: [], groups: [] };
    const like = escapeLike(q);
    // a whole phone number finds its owner, like in Telegram (whatever the number's visibility)
    const phone = /^[\d\s()+\-.]{7,}$/.test(q) ? normalizePhone(q) : '';
    const byPhone = phone.length >= 11 ? (db.prepare('SELECT * FROM users WHERE phone = ? AND is_banned = 0').get(phone) as UserRow | undefined) : undefined;
    const found = db
      .prepare(
        `SELECT * FROM users WHERE is_banned = 0 AND bot IS NULL AND (
           username LIKE @prefix ESCAPE '\\' OR (first_name || ' ' || last_name) LIKE @any ESCAPE '\\')
         ORDER BY CASE WHEN username = @q THEN 0 ELSE 1 END, username LIMIT 20`,
      )
      .all({ prefix: `${like}%`, any: `%${like}%`, q }) as UserRow[];
    const users = byPhone ? [byPhone, ...found.filter((u) => u.id !== byPhone.id)] : found;
    const groups = db
      .prepare(
        `SELECT * FROM chats WHERE type IN ('group', 'channel') AND is_public = 1 AND (
           public_username LIKE @prefix ESCAPE '\\' OR title LIKE @any ESCAPE '\\') LIMIT 20`,
      )
      .all({ prefix: `${like}%`, any: `%${like}%` }) as ChatRow[];
    return {
      users: users.map((u) => userDTOFor(u, req.auth.user.id)),
      groups: groups.map((g) => chatDTO(g, req.auth.user)),
    };
  });

  app.get<{ Params: { id: string } }>('/api/users/:id', async (req): Promise<UserProfileDTO> => {
    const u = getUserRow(intParam(req.params.id));
    if (!u) throw notFound(txt.errors.userNotFound);
    return {
      ...userDTOFor(u, req.auth.user.id),
      ...profileExtras(u.id),
      blockedByMe: isBlockedBy(req.auth.user.id, u.id),
      isContact: !!db.prepare('SELECT 1 FROM user_contacts WHERE user_id = ? AND contact_id = ?').get(req.auth.user.id, u.id),
      phone: visiblePhone(u, req.auth.user),
    };
  });

  /** My own profile the way somebody else sees it: privacy applies (last seen, photo, phone), no blocks. */
  app.get('/api/me/profile-preview', async (req): Promise<UserProfileDTO> => {
    const me = req.auth.user;
    return {
      ...userDTO(me),
      ...profileExtras(me.id),
      blockedByMe: false,
      isContact: false,
      phone: parsePrivacy(me).phone === 'everybody' ? me.phone : null,
    };
  });

  /** After (un)blocking both sides see the change live: the private chat and the other user's profile. */
  function blockChanged(me: UserRow, other: UserRow) {
    const pm = db
      .prepare(`SELECT * FROM chats WHERE private_key = ?`)
      .get([me.id, other.id].sort((a, b) => a - b).join(':')) as ChatRow | undefined;
    if (pm) toUser(me.id, EV.chatUpdate, chatDTO(pm, me));
    toUser(other.id, EV.userUpdate, userDTOFor(me, other.id));
  }

  app.post<{ Params: { id: string } }>('/api/users/:id/block', async (req) => {
    const me = req.auth.user;
    const other = getUserRow(intParam(req.params.id));
    if (!other) throw notFound(txt.errors.userNotFound);
    if (other.id === me.id) throw badRequest(txt.errors.cannotBlockSelf);
    const res = db.prepare('INSERT OR IGNORE INTO user_blocks (user_id, blocked_id, created_at) VALUES (?, ?, ?)').run(me.id, other.id, now());
    blockChanged(me, other);
    if (res.changes && other.is_bot) botHooks.blocked(me, other, true);
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/users/:id/block', async (req) => {
    const me = req.auth.user;
    const other = getUserRow(intParam(req.params.id));
    if (!other) throw notFound(txt.errors.userNotFound);
    const res = db.prepare('DELETE FROM user_blocks WHERE user_id = ? AND blocked_id = ?').run(me.id, other.id);
    blockChanged(me, other);
    if (res.changes && other.is_bot) botHooks.blocked(me, other, false);
    return { ok: true };
  });

  /** Groups where both the viewer and this person are members (channels are left out: their subscribers are not public). */
  app.get<{ Params: { id: string } }>('/api/users/:id/common-chats', async (req) => {
    const me = req.auth.user;
    const other = getUserRow(intParam(req.params.id));
    if (!other) throw notFound(txt.errors.userNotFound);
    if (other.id === me.id || other.is_bot) return [];
    const rows = db
      .prepare(
        `SELECT c.* FROM chats c
         JOIN chat_members a ON a.chat_id = c.id AND a.user_id = ?
         JOIN chat_members b ON b.chat_id = c.id AND b.user_id = ?
         WHERE c.type = 'group' ORDER BY c.last_activity_at DESC LIMIT 100`,
      )
      .all(me.id, other.id) as ChatRow[];
    return rows.map((c) => chatDTO(c, me));
  });

  app.get('/api/me/blocks', async (req) => {
    const users = usersByIds(blockedIdsOf(req.auth.user.id));
    return [...users.values()].map((u) => userDTO(u));
  });

  app.get<{ Params: { username: string } }>('/api/resolve/:username', async (req) => {
    const name = req.params.username.replace(/^@/, '');
    const u = getUserByUsername(name);
    if (u) return { type: 'user', user: userDTOFor(u, req.auth.user.id) };
    const c = db.prepare(`SELECT * FROM chats WHERE public_username = ? AND is_public = 1`).get(name) as
      | ChatRow
      | undefined;
    if (c) return { type: 'group', chat: chatDTO(c, req.auth.user) };
    throw notFound(txt.errors.notFound);
  });
}
