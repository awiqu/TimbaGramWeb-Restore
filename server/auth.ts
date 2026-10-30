import crypto from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { ADMIN_USERNAME } from '@timba/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { db, now } from './db.js';
import { assertDevice, touchDevice } from './devices.js';
import { HttpError, unauthorized } from './errors.js';
import type { UserRow } from './serialize.js';
import { getSettings } from './settings.js';
import { txt } from './strings.js';

export const SESSION_COOKIE = 'tg_session';
/** the admin's own session while they are signed in as somebody else */
export const ADMIN_RETURN_COOKIE = 'tg_admin_return';
/** the other accounts signed in on this browser: their session tokens, "." separated */
export const ACCOUNTS_COOKIE = 'tg_accounts';

export interface SessionRow {
  id: string;
  token_hash: string;
  user_id: number;
  user_agent: string;
  ip: string;
  created_at: number;
  last_used_at: number;
  impersonator_id: number | null;
}

export interface Auth {
  user: UserRow;
  session: SessionRow;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: Auth;
  }
}

export const hashPassword = (p: string) => hash(p);
export const verifyPassword = (h: string, p: string) => verify(h, p).catch(() => false);
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export const isAdmin = (u: Pick<UserRow, 'username'>) => u.username.toLowerCase() === ADMIN_USERNAME;

export function createSession(userId: number, userAgent: string, ip: string, impersonatorId: number | null = null): string {
  const token = crypto.randomBytes(32).toString('base64url');
  const t = now();
  db.prepare(
    `INSERT INTO sessions (id, token_hash, user_id, user_agent, ip, created_at, last_used_at, impersonator_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(crypto.randomUUID(), sha256(token), userId, userAgent.slice(0, 300), ip, t, t, impersonatorId);
  return token;
}

export function deleteSession(id: string) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

export function resolveToken(token: string | undefined): Auth | null {
  if (!token) return null;
  const session = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(sha256(token)) as
    | SessionRow
    | undefined;
  if (!session) return null;
  const maxAge = config.sessionDays * 86400_000;
  if (now() - session.last_used_at > maxAge) {
    deleteSession(session.id);
    return null;
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id) as UserRow | undefined;
  if (!user) return null;
  if (now() - session.last_used_at > 60_000) {
    db.prepare('UPDATE sessions SET last_used_at = ? WHERE id = ?').run(now(), session.id);
  }
  return { user, session };
}

/**
 * Throws if the user may not use the messenger right now (banned / maintenance).
 * The global admin signed in as a user always gets through.
 */
export function assertAccess(user: UserRow, session?: Pick<SessionRow, 'impersonator_id'>) {
  if (session?.impersonator_id) return;
  if (user.is_banned) {
    throw new HttpError(403, 'banned', txt.errors.banned, { reason: user.ban_reason });
  }
  const s = getSettings();
  if (s.maintenance && !isAdmin(user)) {
    throw new HttpError(503, 'maintenance', s.maintenanceMessage);
  }
}

export async function requireAuth(req: FastifyRequest) {
  const auth = resolveToken(req.cookies[SESSION_COOKIE]);
  if (!auth) throw unauthorized();
  assertAccess(auth.user, auth.session);
  assertDevice(req.deviceId, auth.user, auth.session);
  if (!req.deviceFresh && !auth.session.impersonator_id) {
    touchDevice(req.deviceId, auth.user.id, req.headers['user-agent'] ?? '', req.ip);
  }
  req.auth = auth;
}

export async function requireAdmin(req: FastifyRequest) {
  await requireAuth(req);
  if (!isAdmin(req.auth.user)) throw new HttpError(403, 'forbidden', txt.errors.adminOnly);
}

export function setSessionCookie(reply: FastifyReply, token: string, name = SESSION_COOKIE) {
  reply.setCookie(name, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    // behind a TLS proxy (trustProxy) the cookie must never travel over plain http
    secure: reply.request.protocol === 'https',
    maxAge: config.sessionDays * 86400,
  });
}

/** Tokens of the other accounts waiting on this browser; invalid entries are left for the caller to drop. */
export function readAccounts(req: FastifyRequest): string[] {
  return (req.cookies[ACCOUNTS_COOKIE] ?? '').split('.').filter(Boolean);
}

export function writeAccounts(reply: FastifyReply, tokens: string[]) {
  const unique = [...new Set(tokens)];
  if (unique.length) setSessionCookie(reply, unique.join('.'), ACCOUNTS_COOKIE);
  else reply.clearCookie(ACCOUNTS_COOKIE, { path: '/' });
}

export async function seedAdmin() {
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(ADMIN_USERNAME);
  if (exists) return;
  db.prepare(
    `INSERT INTO users (username, first_name, password_hash, created_at) VALUES (?, ?, ?, ?)`,
  ).run(ADMIN_USERNAME, txt.labels.adminName, await hashPassword(config.adminPassword), now());
}

/** Very small in-memory rate limiter. */
const buckets = new Map<string, { n: number; reset: number }>();
export function rateLimit(key: string, max: number, windowMs: number) {
  const t = now();
  // expired buckets would otherwise pile up, one per address ever seen
  if (buckets.size > 5000) for (const [k, v] of buckets) if (v.reset < t) buckets.delete(k);
  const b = buckets.get(key);
  if (!b || b.reset < t) {
    buckets.set(key, { n: 1, reset: t + windowMs });
    return;
  }
  b.n++;
  if (b.n > max) {
    throw new HttpError(429, 'rate_limited', txt.errors.rateLimited);
  }
}
