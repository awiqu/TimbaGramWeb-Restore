import type { StickerDTO, StickerPackDTO, StickerPacksDTO } from '@timba/shared';
import { EV, MAX_STICKER_PACKS, MAX_STICKERS_PER_PACK, builtinSticker } from '@timba/shared';
import { randomBytes } from 'node:crypto';
import { db, now } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { toUser } from '../realtime.js';
import { type UserRow, isPremium, userDTO, usersByIds } from '../serialize.js';
import { txt } from '../strings.js';
import { getFile, requireOwnPhoto, stickerPath, warmSticker } from './files.js';

/**
 * Стикеры. The built-in TimbaGram pack is drawn by the client and needs no rows. Users with
 * Премиум make their own packs (up to MAX_STICKER_PACKS) from square pictures; anybody adds
 * a pack to their panel by its link /addstickers/<token>.
 */

interface PackRow {
  id: number;
  owner_id: number | null;
  title: string;
  token: string;
  created_at: number;
}

interface StickerRow {
  id: number;
  pack_id: number;
  file_id: string;
  emoji: string;
  position: number;
}

const newToken = () => randomBytes(9).toString('base64url');

const stickerDTO = (s: StickerRow): StickerDTO => ({ id: String(s.id), fileId: s.file_id, emoji: s.emoji, packId: s.pack_id });

function packsDTO(rows: PackRow[], viewer: UserRow): StickerPackDTO[] {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const ph = ids.map(() => '?').join(',');
  const stickers = db
    .prepare(`SELECT * FROM stickers WHERE pack_id IN (${ph}) ORDER BY position, id`)
    .all(...ids) as StickerRow[];
  const added = new Set(
    (
      db.prepare(`SELECT pack_id FROM user_sticker_packs WHERE user_id = ? AND pack_id IN (${ph})`).all(viewer.id, ...ids) as {
        pack_id: number;
      }[]
    ).map((r) => r.pack_id),
  );
  const owners = usersByIds(rows.map((r) => r.owner_id).filter((x): x is number => x !== null));
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    token: r.token,
    owner: r.owner_id && owners.has(r.owner_id) ? userDTO(owners.get(r.owner_id)!) : null,
    mine: r.owner_id === viewer.id,
    added: added.has(r.id),
    stickers: stickers.filter((s) => s.pack_id === r.id).map(stickerDTO),
  }));
}

const packDTO = (row: PackRow, viewer: UserRow) => packsDTO([row], viewer)[0]!;

const getPack = (id: number) => db.prepare('SELECT * FROM sticker_packs WHERE id = ?').get(id) as PackRow | undefined;

function requirePack(id: number): PackRow {
  const p = getPack(id);
  if (!p) throw notFound(txt.stickers.packNotFound);
  return p;
}

/** Changes need the author; making the pack bigger also needs an active Премиум. */
function requireOwnPack(id: number, user: UserRow, premium = false): PackRow {
  const p = requirePack(id);
  if (p.owner_id !== user.id) throw forbidden(txt.stickers.notOwner);
  if (premium && !isPremium(user)) throw forbidden(txt.stickers.premiumOnly, 'premium_required');
  return p;
}

function requireSticker(id: number): StickerRow {
  const s = db.prepare('SELECT * FROM stickers WHERE id = ?').get(id) as StickerRow | undefined;
  if (!s) throw notFound(txt.stickers.stickerNotFound);
  return s;
}

const ownCount = (userId: number) =>
  (db.prepare('SELECT COUNT(*) c FROM sticker_packs WHERE owner_id = ?').get(userId) as { c: number }).c;

/** Everybody who has the pack in their panel sees the change in every open tab. */
function packChanged(packId: number, extraUserIds: number[] = []) {
  const users = (db.prepare('SELECT user_id FROM user_sticker_packs WHERE pack_id = ?').all(packId) as { user_id: number }[]).map(
    (r) => r.user_id,
  );
  for (const id of new Set([...users, ...extraUserIds])) toUser(id, EV.stickersUpdate, { packId });
}

export function listMyPacks(user: UserRow): StickerPacksDTO {
  const rows = db
    .prepare(
      `SELECT p.* FROM user_sticker_packs u JOIN sticker_packs p ON p.id = u.pack_id
       WHERE u.user_id = ? ORDER BY u.added_at, p.id`,
    )
    .all(user.id) as PackRow[];
  return { packs: packsDTO(rows, user), ownCount: ownCount(user.id) };
}

export function getPackById(id: number, user: UserRow): StickerPackDTO {
  return packDTO(requirePack(id), user);
}

export function getPackByToken(token: string, user: UserRow): StickerPackDTO {
  const p = db.prepare('SELECT * FROM sticker_packs WHERE token = ?').get(token) as PackRow | undefined;
  if (!p) throw notFound(txt.stickers.packNotFound);
  return packDTO(p, user);
}

export function createPack(user: UserRow, title: string): StickerPackDTO {
  if (!isPremium(user)) throw forbidden(txt.stickers.premiumOnly, 'premium_required');
  if (ownCount(user.id) >= MAX_STICKER_PACKS) throw badRequest(txt.stickers.tooManyPacks(MAX_STICKER_PACKS));
  const t = now();
  const id = db.transaction(() => {
    const res = db
      .prepare('INSERT INTO sticker_packs (owner_id, title, token, created_at) VALUES (?, ?, ?, ?)')
      .run(user.id, title, newToken(), t);
    const pid = Number(res.lastInsertRowid);
    db.prepare('INSERT INTO user_sticker_packs (user_id, pack_id, added_at) VALUES (?, ?, ?)').run(user.id, pid, t);
    return pid;
  })();
  packChanged(id);
  return packDTO(getPack(id)!, user);
}

export function renamePack(id: number, user: UserRow, title: string): StickerPackDTO {
  const p = requireOwnPack(id, user, true);
  db.prepare('UPDATE sticker_packs SET title = ? WHERE id = ?').run(title, p.id);
  packChanged(p.id);
  return packDTO(getPack(p.id)!, user);
}

/** A new link: the old one stops working. */
export function resetPackLink(id: number, user: UserRow): StickerPackDTO {
  const p = requireOwnPack(id, user);
  db.prepare('UPDATE sticker_packs SET token = ? WHERE id = ?').run(newToken(), p.id);
  packChanged(p.id);
  return packDTO(getPack(p.id)!, user);
}

/**
 * The author deletes the pack for everybody (stickers already sent stay in the chats);
 * anybody else only takes it out of their panel.
 */
export function deletePack(id: number, user: UserRow) {
  const p = requirePack(id);
  if (p.owner_id === user.id) {
    const users = (db.prepare('SELECT user_id FROM user_sticker_packs WHERE pack_id = ?').all(p.id) as { user_id: number }[]).map(
      (r) => r.user_id,
    );
    db.prepare('DELETE FROM sticker_packs WHERE id = ?').run(p.id);
    for (const u of new Set([...users, user.id])) toUser(u, EV.stickersUpdate, { packId: p.id });
  } else {
    db.prepare('DELETE FROM user_sticker_packs WHERE user_id = ? AND pack_id = ?').run(user.id, p.id);
    toUser(user.id, EV.stickersUpdate, { packId: p.id });
  }
}

export function addPackToPanel(id: number, user: UserRow): StickerPackDTO {
  const p = requirePack(id);
  db.prepare('INSERT OR IGNORE INTO user_sticker_packs (user_id, pack_id, added_at) VALUES (?, ?, ?)').run(user.id, p.id, now());
  toUser(user.id, EV.stickersUpdate, { packId: p.id });
  return packDTO(p, user);
}

export function addSticker(packId: number, user: UserRow, input: { fileId: string; emoji: string }): StickerPackDTO {
  const p = requireOwnPack(packId, user, true);
  const count = (db.prepare('SELECT COUNT(*) c FROM stickers WHERE pack_id = ?').get(p.id) as { c: number }).c;
  if (count >= MAX_STICKERS_PER_PACK) throw badRequest(txt.stickers.packFull(MAX_STICKERS_PER_PACK));
  const file = stickerImage(input.fileId, user);
  warmSticker(file);
  const pos = (db.prepare('SELECT COALESCE(MAX(position), -1) + 1 p FROM stickers WHERE pack_id = ?').get(p.id) as { p: number }).p;
  db.prepare('INSERT INTO stickers (pack_id, file_id, emoji, position, created_at) VALUES (?, ?, ?, ?, ?)').run(
    p.id,
    file,
    input.emoji,
    pos,
    now(),
  );
  packChanged(p.id);
  return packDTO(p, user);
}

function stickerImage(fileId: string, user: UserRow): string {
  try {
    return requireOwnPhoto(fileId, user).id;
  } catch {
    throw badRequest(txt.stickers.imageRequired);
  }
}

export function editSticker(
  stickerId: number,
  user: UserRow,
  input: { emoji?: string; fileId?: string; position?: number },
): StickerPackDTO {
  const s = requireSticker(stickerId);
  const p = requireOwnPack(s.pack_id, user, true);
  db.transaction(() => {
    if (input.emoji) db.prepare('UPDATE stickers SET emoji = ? WHERE id = ?').run(input.emoji, s.id);
    if (input.fileId) db.prepare('UPDATE stickers SET file_id = ? WHERE id = ?').run(stickerImage(input.fileId, user), s.id);
    if (input.position !== undefined) {
      const order = (db.prepare('SELECT id FROM stickers WHERE pack_id = ? ORDER BY position, id').all(p.id) as { id: number }[])
        .map((r) => r.id)
        .filter((id) => id !== s.id);
      order.splice(Math.min(input.position, order.length), 0, s.id);
      const upd = db.prepare('UPDATE stickers SET position = ? WHERE id = ?');
      order.forEach((id, i) => upd.run(i, id));
    }
  })();
  if (input.fileId) warmSticker(input.fileId);
  packChanged(p.id);
  return packDTO(p, user);
}

/**
 * At the start the small copies of every sticker picture are made one after another in the background (those made
 * before the copies existed would otherwise be made while somebody waits for the panel to fill).
 */
export async function warmAllStickers() {
  const ids = (db.prepare('SELECT DISTINCT file_id FROM stickers').all() as { file_id: string }[]).map((r) => r.file_id);
  for (const id of ids) {
    const f = getFile(id);
    if (!f) continue;
    await stickerPath(f).catch(() => null);
    await stickerPath(f, true).catch(() => null);
  }
}

export function deleteSticker(stickerId: number, user: UserRow): StickerPackDTO {
  const s = requireSticker(stickerId);
  const p = requireOwnPack(s.pack_id, user);
  db.prepare('DELETE FROM stickers WHERE id = ?').run(s.id);
  packChanged(p.id);
  return packDTO(p, user);
}

/**
 * What a message stores for a sticker the user sends: "tg:<key>" for the built-in pack,
 * otherwise the picture's file id and the pack.
 */
export function resolveSticker(stickerId: string): { sticker: string; emoji: string; packId: number | null } {
  const builtin = builtinSticker(stickerId);
  if (builtin) return { sticker: stickerId, emoji: builtin.emoji, packId: null };
  const id = Number(stickerId);
  if (!Number.isInteger(id) || id <= 0) throw notFound(txt.stickers.stickerNotFound);
  const s = requireSticker(id);
  return { sticker: s.file_id, emoji: s.emoji, packId: s.pack_id };
}
