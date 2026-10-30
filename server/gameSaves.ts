import { GAME_SAVES_MAX, GAME_SAVE_KEY_RE, GAME_SAVE_MAX_BYTES, betterSave } from '@timba/shared';
import { db, now } from './db.js';
import { badRequest, notFound } from './errors.js';
import { txt } from './strings.js';

/**
 * Progress of the mini-games per account (see shared/gameSaves.ts). The client sends what it has,
 * the server keeps the better of each pair and answers with everything: one request syncs a device.
 * The table lives outside the numbered migrations, like the notifications.
 */
export function initGameSaves() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS game_saves (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, key)
    );
    -- the clicker's earlier saves: a reset or a bad save can be taken back
    CREATE TABLE IF NOT EXISTS game_save_backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      saved_at INTEGER NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_game_save_backups ON game_save_backups(user_id, key, id);
  `);
  // when an admin last set the save (admin panel → «Игры»): a device that has not synced since does not bring its own copy back
  const columns = db.prepare('PRAGMA table_info(game_saves)').all() as { name: string }[];
  if (!columns.some((c) => c.name === 'forced_at')) db.exec('ALTER TABLE game_saves ADD COLUMN forced_at INTEGER NOT NULL DEFAULT 0');
}

/** Only the clicker keeps a history: its progress is the one that takes weeks. */
const BACKED_UP = 'clicker';
/** a copy of the replaced save is kept when the last one is older than this */
const BACKUP_EVERY_MS = 15 * 60_000;
const BACKUPS_KEPT = 20;
const PINNED_KEPT = 5;

/** Keep the save that is about to be replaced; `pinned` ones (before a reset) outlive the rolling copies. */
function backUp(userId: number, key: string, oldValue: string, pinned: boolean) {
  const last = db.prepare('SELECT saved_at FROM game_save_backups WHERE user_id = ? AND key = ? ORDER BY id DESC LIMIT 1').get(userId, key) as
    | { saved_at: number }
    | undefined;
  if (!pinned && last && now() - last.saved_at < BACKUP_EVERY_MS) return;
  db.prepare('INSERT INTO game_save_backups (user_id, key, value, saved_at, pinned) VALUES (?, ?, ?, ?, ?)').run(userId, key, oldValue, now(), pinned ? 1 : 0);
  db.prepare(
    `DELETE FROM game_save_backups WHERE user_id = ? AND key = ? AND pinned = 0
     AND id NOT IN (SELECT id FROM game_save_backups WHERE user_id = ? AND key = ? AND pinned = 0 ORDER BY id DESC LIMIT ?)`,
  ).run(userId, key, userId, key, BACKUPS_KEPT);
  db.prepare(
    `DELETE FROM game_save_backups WHERE user_id = ? AND key = ? AND pinned = 1
     AND id NOT IN (SELECT id FROM game_save_backups WHERE user_id = ? AND key = ? AND pinned = 1 ORDER BY id DESC LIMIT ?)`,
  ).run(userId, key, userId, key, PINNED_KEPT);
}

const epochOf = (v: unknown) => Number((v && typeof v === 'object' ? (v as Record<string, unknown>).epoch : 0) ?? 0) || 0;

export interface ClickerBackup {
  id: number;
  savedAt: number;
  resets: number;
  cores: number;
  total: unknown;
  pinned: boolean;
}

/** The earlier saves of the clicker, the newest first. */
export function clickerBackups(userId: number): ClickerBackup[] {
  const rows = db
    .prepare('SELECT id, value, saved_at, pinned FROM game_save_backups WHERE user_id = ? AND key = ? ORDER BY id DESC')
    .all(userId, BACKED_UP) as { id: number; value: string; saved_at: number; pinned: number }[];
  return rows.map((r) => {
    const v = (parse(r.value) ?? {}) as Record<string, unknown>;
    return { id: r.id, savedAt: r.saved_at, resets: Number(v.resets) || 0, cores: Number(v.coresTotal) || 0, total: v.total ?? 0, pinned: !!r.pinned };
  });
}

/** Take an earlier save back: it becomes the current one (a new epoch, so no device brings the lost state back), the current one is kept. */
export function restoreClickerBackup(userId: number, id: number): Record<string, unknown> {
  const row = db.prepare('SELECT value FROM game_save_backups WHERE id = ? AND user_id = ? AND key = ?').get(id, userId, BACKED_UP) as
    | { value: string }
    | undefined;
  if (!row) throw notFound(txt.gameSaves.noBackup);
  const value = parse(row.value);
  if (!value || typeof value !== 'object') throw notFound(txt.gameSaves.noBackup);
  const cur = db.prepare('SELECT value FROM game_saves WHERE user_id = ? AND key = ?').get(userId, BACKED_UP) as { value: string } | undefined;
  const at = now();
  db.transaction(() => {
    if (cur) backUp(userId, BACKED_UP, cur.value, true);
    db.prepare(
      `INSERT INTO game_saves (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(userId, BACKED_UP, JSON.stringify({ ...(value as object), epoch: at, savedAt: at }), at);
  })();
  const out: Record<string, unknown> = {};
  for (const r of db.prepare('SELECT key, value FROM game_saves WHERE user_id = ?').all(userId) as SaveRow[]) out[r.key] = parse(r.value);
  return out;
}

interface SaveRow {
  key: string;
  value: string;
}

/** Every save of one account, parsed. */
export function readSaves(userId: number): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const r of db.prepare('SELECT key, value FROM game_saves WHERE user_id = ?').all(userId) as SaveRow[]) out.set(r.key, parse(r.value));
  return out;
}

/**
 * Admin: make `value` the save of `key`, whatever the devices hold. The one it replaces is kept (the clicker's for good);
 * a device takes the new one at its next sync, even if it is worse than what the device has.
 */
export function forceSave(userId: number, key: string, value: unknown, at = now()) {
  if (!GAME_SAVE_KEY_RE.test(key) || value === undefined) throw badRequest(txt.gameSaves.badKey);
  const json = JSON.stringify(value);
  if (json.length > GAME_SAVE_MAX_BYTES) throw badRequest(txt.gameSaves.tooBig);
  db.transaction(() => {
    const row = db.prepare('SELECT value FROM game_saves WHERE user_id = ? AND key = ?').get(userId, key) as { value: string } | undefined;
    if (row && key === BACKED_UP) backUp(userId, key, row.value, true);
    if (!row && (db.prepare('SELECT COUNT(*) c FROM game_saves WHERE user_id = ?').get(userId) as { c: number }).c >= GAME_SAVES_MAX) {
      throw badRequest(txt.gameSaves.tooMany);
    }
    db.prepare(
      `INSERT INTO game_saves (user_id, key, value, updated_at, forced_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, forced_at = excluded.forced_at`,
    ).run(userId, key, json, at, at);
  })();
}

/** Admin: the same as a player taking an earlier save of the clicker back, and it counts as the admin's change. */
export function forceClickerBackup(userId: number, id: number) {
  restoreClickerBackup(userId, id);
  db.prepare('UPDATE game_saves SET forced_at = ? WHERE user_id = ? AND key = ?').run(now(), userId, BACKED_UP);
}

const parse = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
};

/** Did an admin set the save after the device last took the server's saves? (`since` undefined: an old client, which cannot tell.) */
const adminHolds = (forcedAt: number, since: number | undefined) => since !== undefined && forcedAt > 0 && forcedAt >= since;

/**
 * `since`: when the device last took the server's saves. A save an admin set later than that stands: the device's
 * own copy, which may be the very progress that was taken away, is not taken (it adopts the admin's one in the answer).
 * A client that sends no `since` is an old one and plays by the plain rules.
 */
export function syncSaves(userId: number, incoming: Record<string, unknown>, since?: number): Record<string, unknown> {
  const entries = Object.entries(incoming);
  if (entries.length > GAME_SAVES_MAX) throw badRequest(txt.gameSaves.tooMany);
  for (const [key, value] of entries) {
    if (!GAME_SAVE_KEY_RE.test(key) || value === undefined) throw badRequest(txt.gameSaves.badKey);
    if (JSON.stringify(value).length > GAME_SAVE_MAX_BYTES) throw badRequest(txt.gameSaves.tooBig);
  }
  const get = db.prepare('SELECT value, forced_at FROM game_saves WHERE user_id = ? AND key = ?');
  const put = db.prepare(
    `INSERT INTO game_saves (user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  db.transaction(() => {
    const have = (db.prepare('SELECT COUNT(*) c FROM game_saves WHERE user_id = ?').get(userId) as { c: number }).c;
    let fresh = 0;
    for (const [key, value] of entries) {
      const row = get.get(userId, key) as { value: string; forced_at: number } | undefined;
      if (!row) {
        if (have + ++fresh > GAME_SAVES_MAX) throw badRequest(txt.gameSaves.tooMany);
        put.run(userId, key, JSON.stringify(value), now());
      } else if (!adminHolds(row.forced_at, since) && betterSave(key, parse(row.value), value)) {
        if (key === BACKED_UP) {
          // a new epoch (a reset) or a save that holds less than the old one: the old one is kept for good
          const old = parse(row.value);
          backUp(userId, key, row.value, epochOf(value) > epochOf(old));
        }
        put.run(userId, key, JSON.stringify(value), now());
      }
    }
  })();
  const out: Record<string, unknown> = {};
  for (const r of db.prepare('SELECT key, value FROM game_saves WHERE user_id = ?').all(userId) as SaveRow[]) out[r.key] = parse(r.value);
  return out;
}
