import {
  AWARDS_MAX,
  AWARD_DEGREE_MAX,
  AWARD_DEGREE_MIN,
  BADGE_IMAGE_SIZE,
  EV,
  TAGS_MAX,
  type AdminBadgeDTO,
  type AwardDTO,
  type BadgeDTO,
  type ProfileExtras,
  type UserTagDTO,
} from '@timba/shared';
import sharp from 'sharp';
import { type DB, db, now } from './db.js';
import { badRequest, notFound } from './errors.js';
import { toAll } from './realtime.js';
import { getUserRow, userDTO } from './serialize.js';
import { txt } from './strings.js';

/**
 * Значки, подписи под ником и награды — всё, что админ выдаёт людям в профиле.
 * Значок (badge) показывается слева от имени везде, поэтому он входит в UserDTO.
 */

// ---------- badges ----------

interface BadgeRow {
  id: number;
  title: string;
  updated_at: number;
  created_at: number;
}

// the catalog is tiny and read for every serialized user: kept in memory (rebuilt for a new database)
let cache: Map<number, BadgeDTO> | null = null;
let cacheFor: DB | null = null;

function badges(): Map<number, BadgeDTO> {
  if (!cache || cacheFor !== db) {
    const rows = db.prepare('SELECT id, title, updated_at FROM badges').all() as BadgeRow[];
    cache = new Map(rows.map((r) => [r.id, { id: r.id, title: r.title, v: r.updated_at }]));
    cacheFor = db;
  }
  return cache;
}

const dropCache = () => {
  cache = null;
};

/** The badge as users carry it; null for no badge (or one that was deleted). */
export const badgeOf = (id: number | null | undefined): BadgeDTO | null => (id ? (badges().get(id) ?? null) : null);

export function badgeImage(id: number): Buffer | null {
  const r = db.prepare('SELECT image FROM badges WHERE id = ?').get(id) as { image: Buffer } | undefined;
  return r?.image ?? null;
}

/** Any picture becomes a square PNG with a transparent margin (a badge is shown about as big as a letter). */
async function badgePng(data: Buffer): Promise<Buffer> {
  try {
    // density: a small vector picture (an icon with a 24-unit viewBox) is drawn big enough to stay sharp; rasters ignore it
    return await sharp(data, { density: 384 })
      .rotate()
      .resize(BADGE_IMAGE_SIZE, BADGE_IMAGE_SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
  } catch {
    throw badRequest(txt.errors.imageRequired);
  }
}

export function listBadges(): AdminBadgeDTO[] {
  const holders = new Map(
    (
      db.prepare('SELECT badge_id, COUNT(*) c FROM users WHERE badge_id IS NOT NULL GROUP BY badge_id').all() as {
        badge_id: number;
        c: number;
      }[]
    ).map((r) => [r.badge_id, r.c]),
  );
  const rows = db.prepare('SELECT id, title, updated_at, created_at FROM badges ORDER BY id').all() as BadgeRow[];
  return rows.map((r) => ({ id: r.id, title: r.title, v: r.updated_at, holders: holders.get(r.id) ?? 0, createdAt: r.created_at }));
}

const requireBadge = (id: number): BadgeRow => {
  const r = db.prepare('SELECT id, title, updated_at, created_at FROM badges WHERE id = ?').get(id) as BadgeRow | undefined;
  if (!r) throw notFound(txt.profile.badgeNotFound);
  return r;
};

/** Everybody who wears the badge sees the change at once. */
function announceHolders(badgeId: number) {
  const ids = db.prepare('SELECT id FROM users WHERE badge_id = ?').all(badgeId) as { id: number }[];
  for (const { id } of ids) announceUser(id);
}

/** A new or changed badge: its picture is cut to a square PNG. */
export async function createBadge(title: string, file: Buffer): Promise<AdminBadgeDTO> {
  const png = await badgePng(file);
  const t = now();
  const id = Number(
    db.prepare('INSERT INTO badges (title, image, updated_at, created_at) VALUES (?, ?, ?, ?)').run(title, png, t, t).lastInsertRowid,
  );
  dropCache();
  return listBadges().find((b) => b.id === id)!;
}

export async function updateBadge(id: number, patch: { title?: string; file?: Buffer }): Promise<AdminBadgeDTO> {
  const prev = requireBadge(id);
  const png = patch.file ? await badgePng(patch.file) : null;
  // a new picture gets a new version so browsers do not keep the old one
  const version = png ? Math.max(now(), prev.updated_at + 1) : prev.updated_at;
  db.prepare('UPDATE badges SET title = COALESCE(?, title), image = COALESCE(?, image), updated_at = ? WHERE id = ?').run(
    patch.title ?? null,
    png,
    version,
    id,
  );
  dropCache();
  announceHolders(id);
  return listBadges().find((b) => b.id === id)!;
}

export function deleteBadge(id: number) {
  requireBadge(id);
  const holders = (db.prepare('SELECT id FROM users WHERE badge_id = ?').all(id) as { id: number }[]).map((r) => r.id);
  db.prepare('DELETE FROM badges WHERE id = ?').run(id);
  dropCache();
  for (const uid of holders) announceUser(uid);
}

/** Give a badge to a user, or take it away with null. */
export function setUserBadge(userId: number, badgeId: number | null) {
  if (badgeId !== null) requireBadge(badgeId);
  db.prepare('UPDATE users SET badge_id = ? WHERE id = ?').run(badgeId, userId);
  announceUser(userId);
}

/** Everybody gets the user's fresh public profile (badge and premium come with it). */
export function announceUser(userId: number) {
  const u = getUserRow(userId);
  if (u) toAll(EV.userUpdate, userDTO(u));
}

// ---------- captions under the name ----------

interface TagRow {
  id: number;
  user_id: number;
  text: string;
  color: string;
}

const tagDTO = (r: TagRow): UserTagDTO => ({ id: r.id, text: r.text, color: r.color.toLowerCase() });

export function tagsOf(userId: number): UserTagDTO[] {
  return (db.prepare('SELECT * FROM user_tags WHERE user_id = ? ORDER BY id').all(userId) as TagRow[]).map(tagDTO);
}

export function addTag(userId: number, text: string, color: string): UserTagDTO {
  const have = (db.prepare('SELECT COUNT(*) c FROM user_tags WHERE user_id = ?').get(userId) as { c: number }).c;
  if (have >= TAGS_MAX) throw badRequest(txt.profile.tooManyTags(TAGS_MAX));
  const id = Number(
    db.prepare('INSERT INTO user_tags (user_id, text, color, created_at) VALUES (?, ?, ?, ?)').run(userId, text, color.toLowerCase(), now())
      .lastInsertRowid,
  );
  return tagDTO(db.prepare('SELECT * FROM user_tags WHERE id = ?').get(id) as TagRow);
}

export function removeTag(userId: number, tagId: number) {
  if (!db.prepare('DELETE FROM user_tags WHERE id = ? AND user_id = ?').run(tagId, userId).changes) throw notFound(txt.profile.tagNotFound);
}

// ---------- awards ----------

interface AwardRow {
  id: number;
  user_id: number;
  degree: number;
  caption: string;
  awarded_at: number;
}

const awardDTO = (r: AwardRow): AwardDTO => ({ id: r.id, degree: r.degree, caption: r.caption, awardedAt: r.awarded_at });

/** The best degree first, then the newest */
export function awardsOf(userId: number): AwardDTO[] {
  return (
    db.prepare('SELECT * FROM user_awards WHERE user_id = ? ORDER BY degree, awarded_at DESC, id DESC').all(userId) as AwardRow[]
  ).map(awardDTO);
}

export function addAward(userId: number, a: { degree: number; caption: string; awardedAt?: number }): AwardDTO {
  if (a.degree < AWARD_DEGREE_MIN || a.degree > AWARD_DEGREE_MAX) throw badRequest(txt.profile.badDegree);
  const have = (db.prepare('SELECT COUNT(*) c FROM user_awards WHERE user_id = ?').get(userId) as { c: number }).c;
  if (have >= AWARDS_MAX) throw badRequest(txt.profile.tooManyAwards(AWARDS_MAX));
  const t = now();
  const id = Number(
    db
      .prepare('INSERT INTO user_awards (user_id, degree, caption, awarded_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, a.degree, a.caption, a.awardedAt ?? t, t).lastInsertRowid,
  );
  return awardDTO(db.prepare('SELECT * FROM user_awards WHERE id = ?').get(id) as AwardRow);
}

export function removeAward(userId: number, awardId: number) {
  if (!db.prepare('DELETE FROM user_awards WHERE id = ? AND user_id = ?').run(awardId, userId).changes)
    throw notFound(txt.profile.awardNotFound);
}

/** Captions and awards: the part of the profile that is not in UserDTO */
export const profileExtras = (userId: number): ProfileExtras => ({ tags: tagsOf(userId), awards: awardsOf(userId) });
