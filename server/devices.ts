import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db, now } from './db.js';
import { HttpError } from './errors.js';
import type { UserRow } from './serialize.js';
import { isAdmin } from './auth.js';
import { txt } from './strings.js';

/**
 * A browser has no hardware id, so a device is a random id kept in a long-lived cookie. The page
 * copies it to localStorage and puts it back if only the cookie was cleared (client/src/lib/device.ts),
 * so the ban survives "clear cookies" and a new account, but not "clear everything" or another browser.
 * The cookie is readable by the page on purpose: it is a label, not a secret.
 */
export const DEVICE_COOKIE = 'tg_device';
const DEVICE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const YEARS = 10;

declare module 'fastify' {
  interface FastifyRequest {
    /** the device this request comes from (set by the onRequest hook of /api) */
    deviceId: string;
    /** no valid device cookie came with the request: the id was just made up */
    deviceFresh: boolean;
  }
}

export interface DeviceRow {
  device_id: string;
  user_id: number;
  user_agent: string;
  ip: string;
  first_seen: number;
  last_seen: number;
}

export interface BannedDeviceRow {
  device_id: string;
  reason: string;
  banned_at: number;
  user_id: number | null;
  username: string;
}

export function deviceFromCookies(cookies: Record<string, string | undefined>): string | null {
  const v = cookies[DEVICE_COOKIE];
  return v && DEVICE_RE.test(v) ? v : null;
}

/** Hook for every /api request: reads the device cookie or makes up a new id. */
export function identifyDevice(req: FastifyRequest) {
  const known = deviceFromCookies(req.cookies);
  req.deviceFresh = !known;
  req.deviceId = known ?? crypto.randomBytes(24).toString('base64url');
}

/** onSend: a new id is handed out as a cookie (after the handler's own cookies, so the session cookie stays first). */
export function sendDeviceCookie(req: FastifyRequest, reply: FastifyReply) {
  if (!req.deviceFresh || !req.url.startsWith('/api/')) return;
  reply.setCookie(DEVICE_COOKIE, req.deviceId, {
    path: '/',
    httpOnly: false,
    sameSite: 'lax',
    secure: req.protocol === 'https',
    maxAge: YEARS * 365 * 86400,
  });
}

export const bannedDevice = (deviceId: string) =>
  db.prepare('SELECT * FROM banned_devices WHERE device_id = ?').get(deviceId) as BannedDeviceRow | undefined;

/**
 * Throws if the device is banned. The global admin and the admin signed in as somebody else always get through,
 * so a ban can never lock the admin out.
 */
export function assertDevice(deviceId: string, user?: Pick<UserRow, 'username'>, session?: { impersonator_id: number | null }) {
  if (session?.impersonator_id || (user && isAdmin(user))) return;
  const b = bannedDevice(deviceId);
  if (b) throw new HttpError(403, 'banned', txt.errors.deviceBanned, { reason: b.reason, device: true });
}

const lastTouch = new Map<string, number>();

/** Remembers that the account was used on this device (at most once in five minutes per pair). */
export function touchDevice(deviceId: string, userId: number, userAgent: string, ip: string, force = false) {
  const key = `${deviceId}:${userId}`;
  const t = now();
  if (!force && (lastTouch.get(key) ?? 0) > t - 5 * 60_000) return;
  if (lastTouch.size > 5000) lastTouch.clear();
  lastTouch.set(key, t);
  db.prepare(
    `INSERT INTO user_devices (device_id, user_id, user_agent, ip, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (device_id, user_id) DO UPDATE SET last_seen = excluded.last_seen, user_agent = excluded.user_agent, ip = excluded.ip`,
  ).run(deviceId, userId, userAgent.slice(0, 300), ip, t, t);
}

export interface AdminDevice {
  id: string;
  userAgent: string;
  ip: string;
  firstSeen: number;
  lastSeen: number;
  banned: boolean;
  banReason: string;
  /** other accounts that were used on this device */
  otherUsers: { id: number; username: string }[];
}

/** Devices the account was used on, newest first, with the other accounts seen on each. */
export function devicesOf(userId: number): AdminDevice[] {
  const rows = db.prepare('SELECT * FROM user_devices WHERE user_id = ? ORDER BY last_seen DESC LIMIT 50').all(userId) as DeviceRow[];
  return rows.map((r) => {
    const ban = bannedDevice(r.device_id);
    const others = db
      .prepare(
        `SELECT u.id, u.username FROM user_devices d JOIN users u ON u.id = d.user_id
         WHERE d.device_id = ? AND d.user_id != ? ORDER BY d.last_seen DESC LIMIT 10`,
      )
      .all(r.device_id, userId) as { id: number; username: string }[];
    return {
      id: r.device_id,
      userAgent: r.user_agent,
      ip: r.ip,
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
      banned: !!ban,
      banReason: ban?.reason ?? '',
      otherUsers: others,
    };
  });
}

/** Bans the device; `via` is the account the admin did it from. Returns false if it was banned already. */
export function banDevice(deviceId: string, reason: string, via: { id: number; username: string } | null): boolean {
  const res = db
    .prepare('INSERT OR IGNORE INTO banned_devices (device_id, reason, banned_at, user_id, username) VALUES (?, ?, ?, ?, ?)')
    .run(deviceId, reason, now(), via?.id ?? null, via?.username ?? '');
  return res.changes > 0;
}

export function unbanDevice(deviceId: string): boolean {
  return db.prepare('DELETE FROM banned_devices WHERE device_id = ?').run(deviceId).changes > 0;
}

export function listBannedDevices(): BannedDeviceRow[] {
  return db.prepare('SELECT * FROM banned_devices ORDER BY banned_at DESC LIMIT 200').all() as BannedDeviceRow[];
}
