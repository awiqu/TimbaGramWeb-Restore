import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { db, now } from './db.js';

/**
 * Secret pages behind a PIN (/secret/blooms, a tower defence game). The PIN is checked here, never in the
 * page code. An unlocked browser gets a cookie «<id>.<signature>»: the id names its saved progress, the
 * signature (HMAC over the id and the PIN) proves the PIN was entered; a new PIN locks every browser again.
 * The table lives outside the numbered migrations, like the game saves.
 */
export const BLOOMS_COOKIE = 'tg_blooms';
/** one saved profile, JSON (saved games on every map and the drawn maps) */
export const BLOOMS_SAVE_MAX_BYTES = 768 * 1024;

export function initSecretPages() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS secret_saves (
      id TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

let key: Buffer | null = null;

/** the signing key: random, made once and kept in the database, so a restart does not lock anybody out */
function signingKey(): Buffer {
  if (key) return key;
  const row = db.prepare(`SELECT value FROM app_settings WHERE key = 'secret_pages_key'`).get() as { value: string } | undefined;
  if (row) return (key = Buffer.from(row.value, 'base64url'));
  const fresh = crypto.randomBytes(32);
  db.prepare(`INSERT OR IGNORE INTO app_settings (key, value) VALUES ('secret_pages_key', ?)`).run(fresh.toString('base64url'));
  // another process may have been first: take what is stored
  const stored = db.prepare(`SELECT value FROM app_settings WHERE key = 'secret_pages_key'`).get() as { value: string };
  return (key = Buffer.from(stored.value, 'base64url'));
}

/** tests switch databases: the cached key belongs to the old one */
export function resetSecretKey() {
  key = null;
}

const sign = (id: string) => crypto.createHmac('sha256', signingKey()).update(`blooms:${id}:${config.bloomsPassword}`).digest('base64url');

export function checkPassword(password: string): boolean {
  const a = crypto.createHash('sha256').update(password).digest();
  const b = crypto.createHash('sha256').update(config.bloomsPassword).digest();
  return crypto.timingSafeEqual(a, b);
}

/** The id of the unlocked browser, or null when the cookie is missing, forged or made for an older PIN. */
export function unlockedId(req: FastifyRequest): string | null {
  const raw = req.cookies[BLOOMS_COOKIE];
  if (!raw) return null;
  const [id, sig] = raw.split('.');
  if (!id || !sig || !/^[A-Za-z0-9_-]{16,64}$/.test(id)) return null;
  const want = Buffer.from(sign(id));
  const got = Buffer.from(sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got) ? id : null;
}

/** Remember the browser for a year; an id it already had keeps its progress. */
export function unlock(req: FastifyRequest, reply: FastifyReply): string {
  const prev = req.cookies[BLOOMS_COOKIE]?.split('.')[0];
  const id = prev && /^[A-Za-z0-9_-]{16,64}$/.test(prev) ? prev : crypto.randomBytes(18).toString('base64url');
  adopt(reply, req, id);
  return id;
}

/** this browser keeps the progress of `id` from now on */
export function adopt(reply: FastifyReply, req: FastifyRequest, id: string) {
  reply.setCookie(BLOOMS_COOKIE, `${id}.${sign(id)}`, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: req.protocol === 'https',
    maxAge: 365 * 86400,
  });
}

export function loadSave(id: string): unknown {
  const row = db.prepare('SELECT value FROM secret_saves WHERE id = ?').get(id) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

export function storeSave(id: string, value: unknown) {
  db.prepare(
    `INSERT INTO secret_saves (id, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(id, JSON.stringify(value), now());
}
