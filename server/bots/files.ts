import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db.js';
import { isAdmin } from '../auth.js';
import { uploadLimitMb } from '../premium.js';
import { type PendingUpload, AUDIO_MIME, PHOTO_MIME, VIDEO_MIME, newUploadPath, registerFile } from '../services/files.js';
import { type FileRow, type UserRow } from '../serialize.js';
import { getSettings } from '../settings.js';
import { badReq } from './errors.js';
import { download } from './net.js';
import type { BotRow } from './store.js';

/**
 * Files a bot sends: uploaded with the request (multipart), named by `attach://name`, an address, or the
 * `file_id` of a file the bot already has. Everything ends up as a row of "files", like any upload.
 */

export type Wanted = 'photo' | 'video' | 'voice' | 'round' | 'document' | 'animation';

const EXT_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
};

/** A client that does not know the type (application/octet-stream) is helped by the file name. */
function fixMime(up: PendingUpload) {
  if (!up.mime || up.mime === 'application/octet-stream') up.mime = EXT_MIME[up.ext] ?? up.mime;
}

/** The file is something the bot already has: it made it, or it lies in a chat the bot belongs to. */
export function botCanUse(bot: BotRow, f: FileRow): boolean {
  if (f.uploader_id === bot.user_id) return true;
  return !!db
    .prepare(
      `SELECT 1 FROM message_files mf JOIN messages m ON m.id = mf.message_id
       JOIN chat_members cm ON cm.chat_id = m.chat_id AND cm.user_id = ? WHERE mf.file_id = ? LIMIT 1`,
    )
    .get(bot.user_id, f.id);
}

const compatible = (wanted: Wanted, f: FileRow) =>
  wanted === 'document' ||
  (wanted === 'animation' ? f.kind === 'photo' || f.kind === 'video' : wanted === f.kind);

export function getFileRow(id: string): FileRow | undefined {
  return db.prepare('SELECT * FROM files WHERE id = ?').get(id) as FileRow | undefined;
}

/** The `file_id` the bot may download: its own, or one from a chat it is in. */
export function fileForBot(bot: BotRow, id: string): FileRow {
  const f = getFileRow(id);
  if (!f || !botCanUse(bot, f)) throw badReq('wrong file_id');
  return f;
}

function mimeAllowed(wanted: Wanted, mime: string) {
  switch (wanted) {
    case 'photo':
      return PHOTO_MIME.has(mime);
    case 'video':
    case 'round':
      return VIDEO_MIME.has(mime);
    case 'voice':
      return AUDIO_MIME.has(mime) || mime === 'video/webm';
    case 'animation':
      return PHOTO_MIME.has(mime) || VIDEO_MIME.has(mime);
    default:
      return true;
  }
}

const WRONG: Record<Wanted, string> = {
  photo: 'wrong file type: a photo must be a JPEG, PNG, WebP or GIF picture',
  video: 'wrong file type: a video must be MP4, WebM, MOV or OGV',
  round: 'wrong file type: a video note must be MP4, WebM, MOV or OGV',
  voice: 'wrong file type: a voice message must be OGG, MP3, M4A, AAC, WAV or WebM audio',
  animation: 'wrong file type: an animation must be a GIF or a video',
  document: 'wrong file type',
};

/**
 * The file named by parameter `field` as a row of "files", ready to be put in a message.
 * `extra` is for what Telegram's methods carry along (duration, width, height of a video).
 */
export async function inputFile(
  bot: BotRow,
  user: UserRow,
  field: string,
  params: Record<string, unknown>,
  uploads: Map<string, PendingUpload>,
  wanted: Wanted,
  extra: { width?: number; height?: number; duration?: number } = {},
): Promise<FileRow> {
  if (!getSettings().uploadsEnabled && !isAdmin(user)) throw badReq('file uploads are disabled');
  const value = params[field];
  let pending: PendingUpload | undefined;
  if (typeof value === 'string') {
    const attach = /^attach:\/\/(.+)$/.exec(value);
    if (attach) {
      pending = uploads.get(attach[1]!);
      if (!pending) throw badReq(`there is no file "${attach[1]}" in the request`);
    } else {
      const known = getFileRow(value);
      if (known && botCanUse(bot, known)) {
        if (!compatible(wanted, known)) throw badReq(WRONG[wanted]);
        return known;
      }
      if (/^https?:\/\//i.test(value)) {
        const maxMb = uploadLimitMb(user);
        let res;
        try {
          res = await download(value, maxMb * 1024 * 1024);
        } catch (e) {
          throw badReq(`failed to get HTTP URL content: ${(e as Error).message}`);
        }
        const name = decodeURIComponent(path.basename(new URL(value).pathname) || 'file');
        const dest = newUploadPath(name);
        fs.writeFileSync(dest.abs, res.body);
        pending = {
          id: dest.id,
          rel: dest.rel,
          abs: dest.abs,
          month: dest.month,
          ext: dest.ext,
          name: name.slice(0, 200),
          mime: res.contentType.split(';')[0]!.trim().toLowerCase(),
          size: res.body.length,
        };
      } else {
        throw badReq('wrong file identifier/HTTP URL specified');
      }
    }
  } else {
    pending = uploads.get(field);
  }
  if (!pending) throw badReq(`there is no ${field} in the request`);
  fixMime(pending);
  if (!mimeAllowed(wanted, pending.mime)) throw badReq(WRONG[wanted]);
  if (pending.used) throw badReq('the same uploaded file cannot be used twice in one request');
  return registerFile(user, pending, {
    asFile: wanted === 'document',
    as: wanted === 'voice' ? 'voice' : wanted === 'round' ? 'round' : undefined,
    width: extra.width ?? null,
    height: extra.height ?? null,
    duration: extra.duration ?? null,
  });
}
