import type { AdminGameHas, AdminGameSaveDTO, AdminGameSaveDetail, AdminGameSavesPage, AdminGameSort, AdminGamesSummary, SaveField } from '@timba/shared';
import { ADMIN_GAMES, ADMIN_GAME_KEYS, type AdminGameDef, Big, adminGame, fieldValues, freshClicker, gameKeys, normalizeClicker, saveProgress, serializeClicker, validFieldValue } from '@timba/shared';
import { db, now } from './db.js';
import { badRequest, notFound } from './errors.js';
import { clickerBackups, forceClickerBackup, forceSave, readSaves } from './gameSaves.js';
import { getUserRow } from './serialize.js';
import { txt } from './strings.js';

/**
 * Admin panel → «Игры»: every player's progress in every game, found by game, name and progress, and set by hand.
 * The saves live in game_saves (see gameSaves.ts); the catalog of what each game keeps is in shared/gameSaves.ts.
 * What an admin writes is marked (forced_at) so that a device with the old progress does not bring it back.
 */

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

function requireGame(id: string): AdminGameDef {
  const def = adminGame(id);
  if (!def) throw badRequest(txt.gameSaves.noGame);
  return def;
}

/** One player and the saves of theirs that belong to some game of the panel. */
interface Holder {
  user: AdminGameSaveDTO['user'];
  saves: Map<string, unknown>;
  updated: Map<string, number>;
  edited: Map<string, number>;
}

interface HolderRow {
  user_id: number;
  key: string;
  value: string;
  updated_at: number;
  forced_at: number;
  username: string;
  first_name: string;
  last_name: string;
  avatar_file_id: string | null;
  is_banned: number;
}

function parseValue(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

const displayName = (u: { first_name: string; last_name: string; username: string }) => `${u.first_name} ${u.last_name}`.trim() || u.username;

function holders(keys: readonly string[], filter: { userId?: number; q?: string }): Map<number, Holder> {
  const where = [`s.key IN (${keys.map(() => '?').join(',')})`];
  const args: (string | number)[] = [...keys];
  if (filter.userId) {
    where.push('s.user_id = ?');
    args.push(filter.userId);
  }
  const q = filter.q?.trim().replace(/^@/, '');
  if (q) {
    const like = `%${escapeLike(q)}%`;
    where.push(
      `(u.username LIKE ? ESCAPE '\\' OR u.first_name LIKE ? ESCAPE '\\' OR u.last_name LIKE ? ESCAPE '\\' OR (u.first_name || ' ' || u.last_name) LIKE ? ESCAPE '\\')`,
    );
    args.push(like, like, like, like);
  }
  const rows = db
    .prepare(
      `SELECT s.user_id, s.key, s.value, s.updated_at, s.forced_at, u.username, u.first_name, u.last_name, u.avatar_file_id, u.is_banned
       FROM game_saves s JOIN users u ON u.id = s.user_id WHERE ${where.join(' AND ')}`,
    )
    .all(...args) as HolderRow[];
  const out = new Map<number, Holder>();
  for (const r of rows) {
    let h = out.get(r.user_id);
    if (!h) {
      h = {
        user: { id: r.user_id, username: r.username, name: displayName(r), avatarFileId: r.avatar_file_id, isBanned: !!r.is_banned },
        saves: new Map(),
        updated: new Map(),
        edited: new Map(),
      };
      out.set(r.user_id, h);
    }
    h.saves.set(r.key, parseValue(r.value));
    h.updated.set(r.key, r.updated_at);
    h.edited.set(r.key, r.forced_at);
  }
  return out;
}

interface Entry {
  dto: AdminGameSaveDTO;
  tie: number;
  def: AdminGameDef;
}

/** The player's save of one game; null when they have none. */
function entryOf(h: Holder, def: AdminGameDef): Entry | null {
  const keys = gameKeys(def);
  if (!keys.some((k) => h.saves.has(k))) return null;
  const values = fieldValues(def, h.saves);
  const { progress, tie } = saveProgress(def, values);
  const last = (m: Map<string, number>) => Math.max(0, ...keys.map((k) => m.get(k) ?? 0));
  return { dto: { user: h.user, game: def.id, progress, values, updatedAt: last(h.updated), editedAt: last(h.edited) }, tie, def };
}

export interface GameSaveFilter {
  game?: string;
  userId?: number;
  q?: string;
  has?: AdminGameHas;
  min?: number;
  max?: number;
  sort: AdminGameSort;
  /** newest first / best first / Я–А */
  desc: boolean;
  offset: number;
  limit: number;
}

export function listGameSaves(f: GameSaveFilter): AdminGameSavesPage {
  const defs = f.game ? [requireGame(f.game)] : ADMIN_GAMES;
  const entries: Entry[] = [];
  for (const h of holders([...new Set(defs.flatMap(gameKeys))], f).values()) {
    for (const def of defs) {
      const e = entryOf(h, def);
      if (e) entries.push(e);
    }
  }

  // a range of progress means something only inside one game: every game counts in its own units
  const ranged = !!f.game && (f.min !== undefined || f.max !== undefined);
  const shown = entries.filter(({ dto: { progress: p } }) => {
    if (f.has === 'yes' && p === null) return false;
    if (f.has === 'no' && p !== null) return false;
    if (!ranged) return true;
    return p !== null && (f.min === undefined || p >= f.min) && (f.max === undefined || p <= f.max);
  });

  const sort = f.sort === 'progress' && !f.game ? 'updated' : f.sort;
  const dir = f.desc ? 1 : -1;
  const order = (a: Entry, b: Entry): number => {
    if (sort === 'progress') {
      // a player with no progress is last either way
      const [pa, pb] = [a.dto.progress, b.dto.progress];
      if (pa === null || pb === null) return pa === pb ? 0 : pa === null ? 1 : -1;
      const best = (e: Entry, p: number) => (e.def.lower ? -p : p);
      return (best(b, pb) - best(a, pa) || b.tie - a.tie) * dir;
    }
    if (sort === 'name') return -dir * a.dto.user.name.localeCompare(b.dto.user.name, 'ru');
    return (b.dto.updatedAt - a.dto.updatedAt) * dir;
  };
  const gameIndex = (e: Entry) => ADMIN_GAMES.indexOf(e.def);
  shown.sort((a, b) => order(a, b) || a.dto.user.id - b.dto.user.id || gameIndex(a) - gameIndex(b));
  return { items: shown.slice(f.offset, f.offset + f.limit).map((e) => e.dto), total: shown.length };
}

export function gamesSummary(): AdminGamesSummary {
  const rows = db.prepare(`SELECT DISTINCT user_id, key FROM game_saves WHERE key IN (${ADMIN_GAME_KEYS.map(() => '?').join(',')})`).all(...ADMIN_GAME_KEYS) as {
    user_id: number;
    key: string;
  }[];
  const all = new Set<number>();
  const byKey = new Map<string, Set<number>>();
  for (const r of rows) {
    all.add(r.user_id);
    if (!byKey.has(r.key)) byKey.set(r.key, new Set());
    byKey.get(r.key)!.add(r.user_id);
  }
  return {
    players: all.size,
    games: ADMIN_GAMES.map((def) => {
      const players = new Set<number>();
      for (const k of gameKeys(def)) for (const id of byKey.get(k) ?? []) players.add(id);
      return { game: def.id, players: players.size };
    }),
  };
}

function requireUserRow(id: number) {
  const u = getUserRow(id);
  if (!u) throw notFound(txt.errors.userNotFound);
  return u;
}

export function gameSaveDetail(userId: number, gameId: string): AdminGameSaveDetail {
  const def = requireGame(gameId);
  const u = requireUserRow(userId);
  const h = holders(gameKeys(def), { userId }).get(userId);
  const entry = h && entryOf(h, def);
  const dto: AdminGameSaveDTO = entry?.dto ?? {
    user: { id: u.id, username: u.username, name: displayName(u), avatarFileId: u.avatar_file_id, isBanned: !!u.is_banned },
    game: def.id,
    progress: null,
    values: {},
    updatedAt: 0,
    editedAt: 0,
  };
  return { ...dto, backups: def.id === 'clicker' ? clickerBackups(userId) : [] };
}

/** The clicker with some of its numbers set by hand; it starts a new epoch, so no device brings its own progress back. */
function editedClicker(current: unknown, edits: [SaveField, unknown][], at: number): Record<string, unknown> {
  const st = normalizeClicker(current, at);
  for (const [f, v] of edits) {
    switch (f.path) {
      case 'points':
        st.points = Big.decode(v);
        break;
      case 'total':
        st.total = Big.decode(v);
        break;
      case 'cores':
        st.cores = Big.decode(v).floor();
        break;
      case 'coresTotal':
        st.coresTotal = Big.decode(v).floor();
        break;
      case 'resets':
        st.resets = Number(v);
        break;
      case 'clicks':
        st.clicks = Number(v);
        break;
      case 'goldens':
        st.goldens = Number(v);
        break;
    }
  }
  // what is on the account was earned, the cores in hand were received, and a run is a part of the whole
  if (st.points.gt(st.total)) st.total = st.points;
  st.coresTotal = st.coresTotal.max(st.cores);
  st.run = st.run.min(st.total);
  st.savedAt = at;
  st.epoch = at;
  return serializeClicker(st);
}

/** Set fields of one player's save of one game (field id → value). Nothing is written unless every value is fine. */
export function setGameSave(userId: number, gameId: string, values: Record<string, unknown>): AdminGameSaveDetail {
  const def = requireGame(gameId);
  requireUserRow(userId);
  const fields = new Map(def.fields.map((f) => [f.id, f]));
  const edits: [SaveField, unknown][] = [];
  for (const [id, v] of Object.entries(values)) {
    const f = fields.get(id);
    if (!f) throw badRequest(txt.gameSaves.noField);
    if (!validFieldValue(f, v)) throw badRequest(txt.gameSaves.badValue);
    edits.push([f, v]);
  }
  const at = now();
  db.transaction(() => {
    for (const [f, v] of edits) if (!f.path) forceSave(userId, f.key, v, at);
    const inClicker = edits.filter(([f]) => f.path);
    if (inClicker.length) forceSave(userId, 'clicker', editedClicker(readSaves(userId).get('clicker'), inClicker, at), at);
  })();
  return gameSaveDetail(userId, gameId);
}

/**
 * Take all of one player's progress in one game back to the start. Every field is written (a zero, not a missing row),
 * so a device that has not synced yet does not bring its progress back; the clicker's old save is kept among its copies.
 */
export function resetGameSave(userId: number, gameId: string): AdminGameSaveDetail {
  const def = requireGame(gameId);
  requireUserRow(userId);
  const at = now();
  db.transaction(() => {
    if (def.id === 'clicker') {
      forceSave(userId, 'clicker', { ...serializeClicker(freshClicker(at)), epoch: at }, at);
      return;
    }
    for (const f of def.fields) forceSave(userId, f.key, f.min ?? 0, at);
    for (const [key, value] of Object.entries(def.extra ?? {})) forceSave(userId, key, value, at);
  })();
  return gameSaveDetail(userId, gameId);
}

export function restoreGameBackup(userId: number, backupId: number): AdminGameSaveDetail {
  requireUserRow(userId);
  forceClickerBackup(userId, backupId);
  return gameSaveDetail(userId, 'clicker');
}
