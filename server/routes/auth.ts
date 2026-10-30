import {
  ADMIN_USERNAME,
  isBotUsername,
  type AccountDTO,
  EV,
  MAX_ACCOUNTS,
  MAX_ACCOUNTS_PREMIUM,
  type MeDTO,
  changePasswordSchema,
  loginSchema,
  prefsSchema,
  privacySchema,
  registerSchema,
  updateProfileSchema,
} from '@timba/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ACCOUNTS_COOKIE,
  ADMIN_RETURN_COOKIE,
  type Auth,
  SESSION_COOKIE,
  type SessionRow,
  assertAccess,
  createSession,
  deleteSession,
  hashPassword,
  isAdmin,
  rateLimit,
  readAccounts,
  requireAuth,
  resolveToken,
  setSessionCookie,
  verifyPassword,
  writeAccounts,
} from '../auth.js';
import { db, now } from '../db.js';
import { assertDevice, touchDevice } from '../devices.js';
import { HttpError, badRequest, conflict, forbidden, notFound, unauthorized } from '../errors.js';
import { notMutedSql } from '../permissions.js';
import { disconnectSessions, toAll } from '../realtime.js';
import { type UserRow, getUserByUsername, getUserRow, isPremium, parsePrivacy, userDTO } from '../serialize.js';
import { premiumPending } from '../premium.js';
import { profileExtras } from '../profile.js';
import { isUsernameTaken } from '../services/chats.js';
import { requireOwnPhoto } from '../services/files.js';
import { appStatus, getSettings } from '../settings.js';
import { bankSettings, ensureAccount, premiumBonusAt } from '../bank/bank.js';
import { notify } from '../notifications.js';
import { parse } from '../util.js';
import { labelsDTO } from '../labels.js';
import { txt } from '../strings.js';

function phoneTaken(phone: string, exceptId = 0) {
  return !!db.prepare('SELECT 1 FROM users WHERE phone = ? AND id != ?').get(phone, exceptId);
}

export function meDTO(u: UserRow, session?: Pick<SessionRow, 'impersonator_id'>): MeDTO {
  const impersonator = session?.impersonator_id ? getUserRow(session.impersonator_id) : undefined;
  return {
    ...userDTO(u, { self: true }),
    ...profileExtras(u.id),
    isAdmin: isAdmin(u),
    impersonator: impersonator?.username ?? null,
    prefs: JSON.parse(u.prefs || '{}'),
    privacy: parsePrivacy(u),
    phone: u.phone,
    premiumUntil: isPremium(u) ? u.premium_until : null,
    premiumPending: premiumPending(u.id),
    premiumBonusAt: premiumBonusAt(u),
  };
}

/** The user's own sessions; the admin signed in as the user is not listed and not revoked. */
async function revokeOthers(userId: number, keepSessionId: string) {
  const where = 'user_id = ? AND id != ? AND impersonator_id IS NULL';
  const ids = (db.prepare(`SELECT id FROM sessions WHERE ${where}`).all(userId, keepSessionId) as { id: string }[]).map(
    (r) => r.id,
  );
  db.prepare(`DELETE FROM sessions WHERE ${where}`).run(userId, keepSessionId);
  await disconnectSessions(new Set(ids), EV.sessionRevoked);
}

/** Every new user gets a PupsoBank account with the starting balance. */
function openBankAccount(user: UserRow) {
  try {
    // no word about starting coins when the panel gives none
    const start = bankSettings().startBalance;
    if (ensureAccount(user) && start > 0) notify('bank', user.id, txt.bank.welcome(start));
  } catch {
    // the bank being unavailable must not break the sign-up; the account opens on first visit
  }
}

/** Unread messages of a signed-in account that is not open right now (chats with notifications on). */
function accountUnread(userId: number): number {
  const r = db
    .prepare(
      `SELECT COUNT(*) c FROM messages m JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = ?
       WHERE m.id > cm.last_read_id AND m.thread_id IS NULL AND (m.sender_id IS NULL OR m.sender_id != ?)
       AND ${notMutedSql('cm')} AND (cm.muted_until IS NULL OR cm.muted_until < ?)`,
    )
    .get(userId, userId, now()) as { c: number };
  return r.c;
}

/** The other accounts of this browser that are still signed in, one per user, never the current one. */
function stashedAccounts(req: FastifyRequest, current: Auth | null): { token: string; auth: Auth }[] {
  const seen = new Set(current ? [current.user.id] : []);
  const out: { token: string; auth: Auth }[] = [];
  for (const token of readAccounts(req)) {
    const auth = resolveToken(token);
    if (!auth || auth.session.impersonator_id || seen.has(auth.user.id)) continue;
    seen.add(auth.user.id);
    out.push({ token, auth });
  }
  return out;
}

/** After a sign-in: the new account leaves the waiting list, an older session of the same user is closed. */
function settleAccounts(req: FastifyRequest, reply: FastifyReply, userId: number) {
  if (!req.cookies[ACCOUNTS_COOKIE]) return;
  const rest = stashedAccounts(req, null).filter((a) => {
    if (a.auth.user.id !== userId) return true;
    deleteSession(a.auth.session.id);
    return false;
  });
  writeAccounts(
    reply,
    rest.map((a) => a.token),
  );
}

export default async function authRoutes(app: FastifyInstance) {
  app.get('/api/app/status', async () => appStatus());
  /** replaced interface texts; the login screen needs them too, so no session is required */
  app.get('/api/app/labels', async () => labelsDTO());

  app.post('/api/auth/register', async (req, reply) => {
    rateLimit(`reg:${req.ip}`, 10, 10 * 60_000);
    // a banned device cannot open new accounts
    assertDevice(req.deviceId);
    const s = getSettings();
    if (!s.registrationOpen) throw forbidden(txt.errors.registrationClosed, 'registration_closed');
    if (s.maintenance) throw new HttpError(503, 'maintenance', s.maintenanceMessage);
    const body = parse(registerSchema, req.body);
    if (body.username.toLowerCase() === ADMIN_USERNAME || isUsernameTaken(body.username)) {
      throw conflict(txt.errors.usernameTaken, 'username_taken');
    }
    // «…bot» is for bots only, so nobody passes for one
    if (isBotUsername(body.username)) throw conflict(txt.bots.usernameReserved, 'username_reserved');
    if (body.phone && phoneTaken(body.phone)) throw conflict(txt.errors.phoneTaken, 'phone_taken');
    const res = db
      .prepare('INSERT INTO users (username, first_name, last_name, password_hash, created_at, phone) VALUES (?, ?, ?, ?, ?, ?)')
      .run(body.username, body.firstName, body.lastName, await hashPassword(body.password), now(), body.phone || null);
    const user = getUserRow(Number(res.lastInsertRowid))!;
    touchDevice(req.deviceId, user.id, req.headers['user-agent'] ?? '', req.ip, true);
    setSessionCookie(reply, createSession(user.id, req.headers['user-agent'] ?? '', req.ip));
    settleAccounts(req, reply, user.id);
    openBankAccount(user);
    return meDTO(user);
  });

  app.post('/api/auth/login', async (req, reply) => {
    rateLimit(`login:${req.ip}`, 20, 5 * 60_000);
    const body = parse(loginSchema, req.body);
    // guessing one account's password from many addresses is slowed down too
    rateLimit(`login-user:${body.username.toLowerCase()}`, 30, 10 * 60_000);
    const user = getUserByUsername(body.username);
    // bots have no password: they work through their token
    if (!user || user.is_bot || !(await verifyPassword(user.password_hash, body.password))) {
      throw new HttpError(401, 'invalid_credentials', txt.errors.invalidCredentials);
    }
    assertAccess(user);
    // no signing in to other accounts from a banned device (the admin is exempt)
    assertDevice(req.deviceId, user);
    touchDevice(req.deviceId, user.id, req.headers['user-agent'] ?? '', req.ip, true);
    setSessionCookie(reply, createSession(user.id, req.headers['user-agent'] ?? '', req.ip));
    settleAccounts(req, reply, user.id);
    return meDTO(user);
  });

  /** Signs out of the open account; the next account of this browser, if any, opens instead. */
  app.post('/api/auth/logout', async (req, reply) => {
    const auth = resolveToken(req.cookies[SESSION_COOKIE]);
    if (auth) deleteSession(auth.session.id);
    reply.clearCookie(ADMIN_RETURN_COOKIE, { path: '/' });
    const [next, ...rest] = stashedAccounts(req, null);
    writeAccounts(
      reply,
      rest.map((a) => a.token),
    );
    if (next) {
      setSessionCookie(reply, next.token);
      return { ok: true, switched: true };
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true, switched: false };
  });

  /** Every account signed in on this browser, the open one first. Works signed out too (the login page lists them). */
  app.get('/api/auth/accounts', async (req, reply): Promise<AccountDTO[]> => {
    const current = resolveToken(req.cookies[SESSION_COOKIE]);
    const stashed = stashedAccounts(req, current);
    if (stashed.length !== readAccounts(req).length) {
      writeAccounts(
        reply,
        stashed.map((a) => a.token),
      );
    }
    const list: AccountDTO[] = [];
    if (current) list.push({ ...userDTO(current.user, { self: true }), current: true, unread: 0 });
    for (const a of stashed) list.push({ ...userDTO(a.auth.user, { self: true }), current: false, unread: accountUnread(a.auth.user.id) });
    return list;
  });

  /** "Add account": the open account waits in the list, the browser shows the login page. */
  app.post('/api/auth/accounts/add', { preHandler: requireAuth }, async (req, reply) => {
    if (req.auth.session.impersonator_id) throw forbidden(txt.errors.accountsImpersonating);
    const stashed = stashedAccounts(req, req.auth);
    const limit = isPremium(req.auth.user) ? MAX_ACCOUNTS_PREMIUM : MAX_ACCOUNTS;
    if (stashed.length + 1 >= limit) throw forbidden(txt.errors.accountsLimit(limit), 'accounts_limit');
    writeAccounts(reply, [req.cookies[SESSION_COOKIE]!, ...stashed.map((a) => a.token)]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  /** Open another account of this browser; the one open now waits in the list. */
  app.post('/api/auth/accounts/switch', async (req, reply) => {
    const { userId } = parse(z.object({ userId: z.number().int() }), req.body);
    const current = resolveToken(req.cookies[SESSION_COOKIE]);
    if (current?.session.impersonator_id) throw forbidden(txt.errors.accountsImpersonating);
    const stashed = stashedAccounts(req, current);
    const target = stashed.find((a) => a.auth.user.id === userId);
    if (!target) throw notFound(txt.errors.accountNotFound);
    const rest = stashed.filter((a) => a !== target).map((a) => a.token);
    writeAccounts(reply, current ? [req.cookies[SESSION_COOKIE]!, ...rest] : rest);
    setSessionCookie(reply, target.token);
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    const auth = resolveToken(req.cookies[SESSION_COOKIE]);
    if (!auth) throw unauthorized();
    assertAccess(auth.user, auth.session);
    assertDevice(req.deviceId, auth.user, auth.session);
    if (!req.deviceFresh && !auth.session.impersonator_id) {
      touchDevice(req.deviceId, auth.user.id, req.headers['user-agent'] ?? '', req.ip);
    }
    return meDTO(auth.user, auth.session);
  });

  /** The admin stops acting as a user and gets their own session back. */
  app.post('/api/auth/impersonate/return', async (req, reply) => {
    const auth = resolveToken(req.cookies[SESSION_COOKIE]);
    const admin = resolveToken(req.cookies[ADMIN_RETURN_COOKIE]);
    if (auth?.session.impersonator_id) deleteSession(auth.session.id);
    reply.clearCookie(ADMIN_RETURN_COOKIE, { path: '/' });
    if (!admin || !isAdmin(admin.user)) {
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      throw unauthorized();
    }
    setSessionCookie(reply, req.cookies[ADMIN_RETURN_COOKIE]!);
    return meDTO(admin.user, admin.session);
  });

  app.patch('/api/me', { preHandler: requireAuth }, async (req) => {
    const user = req.auth.user;
    const body = parse(updateProfileSchema, req.body);
    if (body.username && body.username.toLowerCase() !== user.username.toLowerCase()) {
      if (isAdmin(user)) throw forbidden(txt.errors.adminUsernameLocked);
      if (body.username.toLowerCase() === ADMIN_USERNAME || isUsernameTaken(body.username, undefined, user.id)) {
        throw conflict(txt.errors.usernameTaken, 'username_taken');
      }
      if (isBotUsername(body.username) && !user.is_bot) throw conflict(txt.bots.usernameReserved, 'username_reserved');
    }
    if (body.avatarFileId) requireOwnPhoto(body.avatarFileId, user);
    if (body.phone !== undefined) {
      if (body.phone && phoneTaken(body.phone, user.id)) throw conflict(txt.errors.phoneTaken, 'phone_taken');
      db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(body.phone || null, user.id);
    }
    db.prepare(
      `UPDATE users SET username = COALESCE(?, username), first_name = COALESCE(?, first_name),
       last_name = COALESCE(?, last_name), bio = COALESCE(?, bio),
       avatar_file_id = CASE WHEN ? THEN ? ELSE avatar_file_id END WHERE id = ?`,
    ).run(
      body.username ?? null,
      body.firstName ?? null,
      body.lastName ?? null,
      body.bio ?? null,
      body.avatarFileId !== undefined ? 1 : 0,
      body.avatarFileId ?? null,
      user.id,
    );
    const updated = getUserRow(user.id)!;
    toAll(EV.userUpdate, userDTO(updated));
    return meDTO(updated, req.auth.session);
  });

  app.put('/api/me/prefs', { preHandler: requireAuth }, async (req) => {
    const prefs = parse(prefsSchema, req.body);
    db.prepare('UPDATE users SET prefs = ? WHERE id = ?').run(JSON.stringify(prefs), req.auth.user.id);
    return { ok: true };
  });

  app.put('/api/me/privacy', { preHandler: requireAuth }, async (req) => {
    const user = req.auth.user;
    const privacy = { ...parsePrivacy(user), ...parse(privacySchema, req.body) };
    db.prepare('UPDATE users SET privacy = ? WHERE id = ?').run(JSON.stringify(privacy), user.id);
    const updated = getUserRow(user.id)!;
    // everybody else sees the user through the new settings
    toAll(EV.userUpdate, userDTO(updated));
    return meDTO(updated, req.auth.session);
  });

  app.post('/api/me/password', { preHandler: requireAuth }, async (req) => {
    const body = parse(changePasswordSchema, req.body);
    if (!(await verifyPassword(req.auth.user.password_hash, body.oldPassword))) {
      throw badRequest(txt.errors.wrongPassword);
    }
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(body.newPassword), req.auth.user.id);
    await revokeOthers(req.auth.user.id, req.auth.session.id);
    return { ok: true };
  });

  app.get('/api/me/sessions', { preHandler: requireAuth }, async (req) => {
    const rows = db
      .prepare('SELECT * FROM sessions WHERE user_id = ? AND (impersonator_id IS NULL OR id = ?) ORDER BY last_used_at DESC')
      .all(req.auth.user.id, req.auth.session.id) as {
      id: string;
      user_agent: string;
      ip: string;
      created_at: number;
      last_used_at: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      userAgent: r.user_agent,
      ip: r.ip,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
      current: r.id === req.auth.session.id,
    }));
  });

  app.delete<{ Params: { id: string } }>('/api/me/sessions/:id', { preHandler: requireAuth }, async (req) => {
    const r = db
      .prepare('DELETE FROM sessions WHERE id = ? AND user_id = ? AND impersonator_id IS NULL')
      .run(req.params.id, req.auth.user.id);
    if (!r.changes) throw notFound(txt.errors.sessionNotFound);
    await disconnectSessions(new Set([req.params.id]), EV.sessionRevoked);
    return { ok: true };
  });

  app.delete('/api/me/sessions', { preHandler: requireAuth }, async (req) => {
    await revokeOthers(req.auth.user.id, req.auth.session.id);
    return { ok: true };
  });
}
