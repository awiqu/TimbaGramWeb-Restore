import fs from 'node:fs';
import path from 'node:path';
import type { AdminUploadDTO, AdminUploadSort, AdminUploadsPage, AdminUploadsSummary, ChatType, FileKind } from '@timba/shared';
import { EV } from '@timba/shared';
import { uploadsDir } from '../config.js';
import { db } from '../db.js';
import { toChat } from '../realtime.js';
import { type FileRow, getMessageRow, messageDTO } from '../serialize.js';

/** Admin panel → «Файлы»: look through everything that was uploaded, and delete it. */

export interface UploadFilter {
  kind?: FileKind;
  q?: string;
  chatId?: number;
  usage?: 'attached' | 'avatar' | 'sticker' | 'unused';
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const IN_MESSAGE = 'EXISTS (SELECT 1 FROM message_files mf WHERE mf.file_id = f.id)';
const IS_AVATAR = '(EXISTS (SELECT 1 FROM users x WHERE x.avatar_file_id = f.id) OR EXISTS (SELECT 1 FROM chats x WHERE x.avatar_file_id = f.id))';
const IS_STICKER = 'EXISTS (SELECT 1 FROM stickers x WHERE x.file_id = f.id)';

// the chat of the latest message the file was sent in
const FROM = `FROM files f
  LEFT JOIN users u ON u.id = f.uploader_id
  LEFT JOIN chats c ON c.id = (
    SELECT m.chat_id FROM message_files mf JOIN messages m ON m.id = mf.message_id WHERE mf.file_id = f.id ORDER BY m.id DESC LIMIT 1
  )`;

function where(f: UploadFilter): { sql: string; params: (string | number)[] } {
  const parts: string[] = [];
  const params: (string | number)[] = [];
  if (f.kind) {
    parts.push('f.kind = ?');
    params.push(f.kind);
  }
  const q = f.q?.trim();
  if (q) {
    const like = `%${escapeLike(q)}%`;
    parts.push("(f.name LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\' OR c.title LIKE ? ESCAPE '\\')");
    params.push(like, like, like);
  }
  if (f.chatId) {
    parts.push('EXISTS (SELECT 1 FROM message_files mf JOIN messages m ON m.id = mf.message_id WHERE mf.file_id = f.id AND m.chat_id = ?)');
    params.push(f.chatId);
  }
  if (f.usage === 'attached') parts.push(IN_MESSAGE);
  else if (f.usage === 'avatar') parts.push(IS_AVATAR);
  else if (f.usage === 'sticker') parts.push(IS_STICKER);
  else if (f.usage === 'unused') parts.push(`NOT ${IN_MESSAGE} AND NOT ${IS_AVATAR} AND NOT ${IS_STICKER}`);
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params };
}

const SORTS: Record<AdminUploadSort, string> = {
  date: 'f.created_at',
  size: 'f.size',
  kind: 'f.kind',
  name: 'f.name COLLATE NOCASE',
  // files in no chat go last
  chat: "c.id IS NULL, COALESCE(NULLIF(c.title, ''), c.type)",
  uploader: 'u.username COLLATE NOCASE',
};

type Row = FileRow & {
  u_username: string | null;
  u_first: string | null;
  u_last: string | null;
  chat_id: number | null;
  chat_type: ChatType | null;
  chat_title: string | null;
  message_id: number | null;
  uses: number;
  is_avatar: number;
  is_sticker: number;
};

/** "Anna and Boris" for a private chat, the title for a group. */
function chatTitles(rows: Row[]): Map<number, string> {
  const out = new Map<number, string>();
  const names = db.prepare(
    `SELECT u.first_name, u.last_name, u.username FROM chat_members cm JOIN users u ON u.id = cm.user_id WHERE cm.chat_id = ? ORDER BY u.id`,
  );
  for (const r of rows) {
    if (r.chat_id === null || out.has(r.chat_id)) continue;
    if (r.chat_type === 'private') {
      const m = names.all(r.chat_id) as { first_name: string; last_name: string; username: string }[];
      out.set(r.chat_id, m.map((x) => `${x.first_name} ${x.last_name}`.trim() || `@${x.username}`).join(' · '));
    } else out.set(r.chat_id, r.chat_title ?? '');
  }
  return out;
}

export function listUploads(f: UploadFilter, sort: AdminUploadSort, desc: boolean, offset: number, limit: number): AdminUploadsPage {
  const w = where(f);
  const rows = db
    .prepare(
      `SELECT f.*, u.username AS u_username, u.first_name AS u_first, u.last_name AS u_last,
        c.id AS chat_id, c.type AS chat_type, c.title AS chat_title,
        (SELECT mf.message_id FROM message_files mf WHERE mf.file_id = f.id ORDER BY mf.message_id DESC LIMIT 1) AS message_id,
        (SELECT COUNT(*) FROM message_files mf WHERE mf.file_id = f.id) AS uses,
        ${IS_AVATAR} AS is_avatar, ${IS_STICKER} AS is_sticker
       ${FROM} ${w.sql}
       ORDER BY ${SORTS[sort]} ${desc ? 'DESC' : 'ASC'}, f.created_at DESC, f.id
       LIMIT ? OFFSET ?`,
    )
    .all(...w.params, limit, offset) as Row[];
  const totals = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(f.size), 0) AS bytes ${FROM} ${w.sql}`).get(...w.params) as { n: number; bytes: number };
  const titles = chatTitles(rows);
  const items: AdminUploadDTO[] = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    mime: r.mime,
    size: r.size,
    name: r.name,
    hasThumb: !!r.thumb_path,
    width: r.width,
    height: r.height,
    duration: r.duration,
    createdAt: r.created_at,
    uploader: r.uploader_id
      ? { id: r.uploader_id, username: r.u_username ?? '', name: `${r.u_first ?? ''} ${r.u_last ?? ''}`.trim() || `@${r.u_username ?? ''}` }
      : null,
    chat: r.chat_id !== null && r.chat_type ? { id: r.chat_id, type: r.chat_type, title: titles.get(r.chat_id) ?? '' } : null,
    messageId: r.message_id,
    uses: r.uses,
    isAvatar: !!r.is_avatar,
    isSticker: !!r.is_sticker,
  }));
  return { items, total: totals.n, totalBytes: totals.bytes };
}

export function uploadsSummary(): AdminUploadsSummary {
  const byKind = db.prepare('SELECT kind, COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM files GROUP BY kind ORDER BY bytes DESC').all() as AdminUploadsSummary['byKind'];
  const rows = db
    .prepare(
      `SELECT c.id AS chatId, c.type, c.title, COUNT(DISTINCT f.id) AS count, COALESCE(SUM(f.size), 0) AS bytes
       FROM files f JOIN message_files mf ON mf.file_id = f.id JOIN messages m ON m.id = mf.message_id JOIN chats c ON c.id = m.chat_id
       GROUP BY c.id ORDER BY bytes DESC LIMIT 50`,
    )
    .all() as { chatId: number; type: ChatType; title: string; count: number; bytes: number }[];
  const names = db.prepare(
    `SELECT u.first_name, u.last_name, u.username FROM chat_members cm JOIN users u ON u.id = cm.user_id WHERE cm.chat_id = ? ORDER BY u.id`,
  );
  const byChat = rows.map((r) => {
    if (r.type !== 'private') return r;
    const m = names.all(r.chatId) as { first_name: string; last_name: string; username: string }[];
    return { ...r, title: m.map((x) => `${x.first_name} ${x.last_name}`.trim() || `@${x.username}`).join(' · ') };
  });
  const unused = db
    .prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(f.size), 0) AS bytes FROM files f WHERE NOT ${IN_MESSAGE} AND NOT ${IS_AVATAR} AND NOT ${IS_STICKER}`)
    .get() as { count: number; bytes: number };
  return { byKind, byChat, unused };
}

/** Ids of everything that fits the filter (for «delete all»). */
export function uploadIds(f: UploadFilter): string[] {
  const w = where(f);
  return (db.prepare(`SELECT f.id ${FROM} ${w.sql}`).all(...w.params) as { id: string }[]).map((r) => r.id);
}

const chunks = <T>(list: T[], n: number) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));
const marks = (n: number) => Array(n).fill('?').join(',');

/**
 * Deletes files from the database and the disk. A picture in a message disappears from it; a message that was
 * nothing but that picture disappears too. An avatar goes back to the initials. Sticker files stay (they would
 * break the packs).
 */
export function deleteUploads(ids: string[]): { deleted: number; bytes: number; skipped: number } {
  const removed: FileRow[] = [];
  const removedMessages = new Map<number, number[]>();
  const editedMessages: number[] = [];
  let skipped = 0;

  for (const part of chunks([...new Set(ids)], 500)) {
    const list = marks(part.length);
    const rows = db.prepare(`SELECT * FROM files WHERE id IN (${list})`).all(...part) as FileRow[];
    const protectedIds = new Set((db.prepare(`SELECT DISTINCT file_id FROM stickers WHERE file_id IN (${list})`).all(...part) as { file_id: string }[]).map((r) => r.file_id));
    const doomed = rows.filter((r) => !protectedIds.has(r.id));
    skipped += rows.length - doomed.length;
    if (!doomed.length) continue;
    const dIds = doomed.map((r) => r.id);
    const dl = marks(dIds.length);

    db.transaction(() => {
      const messages = (db.prepare(`SELECT DISTINCT message_id FROM message_files WHERE file_id IN (${dl})`).all(...dIds) as { message_id: number }[]).map((r) => r.message_id);
      db.prepare(`UPDATE users SET avatar_file_id = NULL WHERE avatar_file_id IN (${dl})`).run(...dIds);
      db.prepare(`UPDATE chats SET avatar_file_id = NULL WHERE avatar_file_id IN (${dl})`).run(...dIds);
      // a scheduled message that still has files to send keeps them
      const gone = new Set(dIds);
      const scheduled = db.prepare("SELECT id, text, file_ids FROM scheduled_messages WHERE file_ids <> '[]'").all() as { id: number; text: string; file_ids: string }[];
      for (const sm of scheduled) {
        let fids: string[] = [];
        try {
          fids = JSON.parse(sm.file_ids) as string[];
        } catch {
          continue;
        }
        if (!fids.some((x) => gone.has(x))) continue;
        const left = fids.filter((x) => !gone.has(x));
        if (!left.length && !sm.text.trim()) db.prepare('DELETE FROM scheduled_messages WHERE id = ?').run(sm.id);
        else db.prepare('UPDATE scheduled_messages SET file_ids = ? WHERE id = ?').run(JSON.stringify(left), sm.id);
      }
      db.prepare(`DELETE FROM message_files WHERE file_id IN (${dl})`).run(...dIds);
      db.prepare(`DELETE FROM files WHERE id IN (${dl})`).run(...dIds);

      for (const mid of messages) {
        const m = getMessageRow(mid);
        if (!m) continue;
        const left = (db.prepare('SELECT COUNT(*) AS n FROM message_files WHERE message_id = ?').get(mid) as { n: number }).n;
        if (left > 0) editedMessages.push(mid);
        else if (m.kind === 'media' && !m.text.trim()) {
          db.prepare('DELETE FROM messages WHERE id = ?').run(mid);
          removedMessages.set(m.chat_id, [...(removedMessages.get(m.chat_id) ?? []), mid]);
        } else {
          if (m.kind === 'media') db.prepare("UPDATE messages SET kind = 'text' WHERE id = ?").run(mid);
          editedMessages.push(mid);
        }
      }
    })();
    removed.push(...doomed);
  }

  // the disk, once the database let go of them
  for (const r of removed) {
    const parsed = path.parse(r.path);
    // the copies made on request: the viewer-sized photo and the avatar
    const rels = [r.path, path.posix.join(parsed.dir, `${parsed.name}_p.webp`), path.posix.join(parsed.dir, `${parsed.name}_a.webp`)];
    if (r.thumb_path) rels.push(r.thumb_path);
    for (const rel of rels) fs.rmSync(path.join(uploadsDir(), rel), { force: true });
  }

  // those who have the chat open see it at once
  for (const [chatId, mids] of removedMessages) toChat(chatId, EV.messageDelete, { chatId, ids: mids });
  for (const mid of editedMessages) {
    const row = getMessageRow(mid);
    if (row) toChat(row.chat_id, EV.messageEdit, messageDTO(row));
  }
  return { deleted: removed.length, bytes: removed.reduce((n, r) => n + r.size, 0), skipped };
}
