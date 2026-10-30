import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FileKind } from '@timba/shared';
import type { z } from 'zod';
import { ROUND_MAX_SECONDS, VOICE_MAX_SECONDS, type fileMetaSchema, waveformSchema } from '@timba/shared';
import type { FastifyRequest } from 'fastify';
import { nanoid } from 'nanoid';
import sharp from 'sharp';
import { uploadsDir } from '../config.js';
import { db, now } from '../db.js';
import { isAdmin } from '../auth.js';
import { HttpError, badRequest, forbidden, notFound } from '../errors.js';
import { type FileRow, type UserRow, fileDTO } from '../serialize.js';
import { getSettings } from '../settings.js';
import { uploadLimitMb } from '../premium.js';
import { txt } from '../strings.js';
import { queueVideo } from './video.js';

export const PHOTO_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
export const VIDEO_MIME = new Set(['video/mp4', 'video/webm', 'video/quicktime', 'video/ogg']);
export const AUDIO_MIME = new Set(['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/x-m4a', 'audio/wav']);
/** "audio/webm;codecs=opus" -> "audio/webm" */
const baseMime = (m: string) => m.split(';')[0]!.trim().toLowerCase();

function fieldValue(fields: Record<string, unknown>, name: string): string | undefined {
  const f = fields[name] as { value?: unknown } | undefined;
  return f && typeof f.value === 'string' ? f.value : undefined;
}

/** A file already on the disk that no row of "files" knows yet. */
export interface PendingUpload {
  id: string;
  /** relative to the uploads folder */
  rel: string;
  abs: string;
  month: string;
  ext: string;
  name: string;
  mime: string;
  size: number;
  /** a row was made from it */
  used?: boolean;
}

/** How the file is meant to be shown. */
export interface RegisterOptions {
  asFile?: boolean;
  as?: string;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  /** a frame of a video: "data:image/jpeg;base64,…" */
  poster?: string;
  /** JSON of WAVEFORM_BARS levels */
  waveform?: string;
}

/** Where a new upload goes: <month>/<id><ext>. */
export function newUploadPath(filename: string) {
  const id = nanoid(21);
  const ext = path
    .extname(filename || '')
    .toLowerCase()
    .replace(/[^.a-z0-9]/g, '')
    .slice(0, 10);
  const month = new Date().toISOString().slice(0, 7);
  fs.mkdirSync(path.join(uploadsDir(), month), { recursive: true });
  const rel = `${month}/${id}${ext}`;
  return { id, ext, month, rel, abs: path.join(uploadsDir(), rel) };
}

/** Writes an incoming stream to the disk; a file over `maxMb` is thrown away. */
export async function writeUpload(
  file: NodeJS.ReadableStream & { truncated?: boolean },
  filename: string,
  mimetype: string,
  maxMb: number,
): Promise<PendingUpload> {
  const dest = newUploadPath(filename);
  await pipeline(file, fs.createWriteStream(dest.abs));
  if (file.truncated) {
    fs.rmSync(dest.abs, { force: true });
    throw new HttpError(413, 'too_large', txt.errors.fileLargerThan(maxMb));
  }
  return {
    id: dest.id,
    rel: dest.rel,
    abs: dest.abs,
    month: dest.month,
    ext: dest.ext,
    name: (filename || `file${dest.ext}`).slice(0, 200),
    mime: baseMime(mimetype || 'application/octet-stream'),
    size: fs.statSync(dest.abs).size,
  };
}

export async function saveUpload(req: FastifyRequest, user: UserRow) {
  if (!getSettings().uploadsEnabled && !isAdmin(user)) throw forbidden(txt.errors.uploadsOff);
  const maxMb = uploadLimitMb(user);
  const maxBytes = maxMb * 1024 * 1024;
  const part = await req.file({ limits: { fileSize: maxBytes, files: 1 } });
  if (!part) throw badRequest(txt.errors.noFile);
  const pending = await writeUpload(part.file, part.filename, part.mimetype, maxMb);
  const num = (n: string) => {
    const v = Number(fieldValue(part.fields, n));
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const row = await registerFile(user, pending, {
    asFile: fieldValue(part.fields, 'asFile') === '1',
    as: fieldValue(part.fields, 'as'),
    width: num('width'),
    height: num('height'),
    duration: num('duration'),
    poster: fieldValue(part.fields, 'poster'),
    waveform: fieldValue(part.fields, 'waveform'),
  });
  return fileDTO(row);
}

/** What kind of file it turned out to be (the thumbnail of a photo, the size of a video…) and the row for it. */
export async function registerFile(user: UserRow, up: PendingUpload, o: RegisterOptions): Promise<FileRow> {
  const { id, month, rel, abs, size, mime, name } = up;
  let kind: FileKind = 'file';
  if (o.as === 'voice' && (AUDIO_MIME.has(mime) || mime === 'video/webm')) kind = 'voice';
  else if (o.as === 'round' && VIDEO_MIME.has(mime)) kind = 'round';
  else if (!o.asFile && PHOTO_MIME.has(mime)) kind = 'photo';
  else if (!o.asFile && VIDEO_MIME.has(mime)) kind = 'video';

  let width: number | null = null;
  let height: number | null = null;
  let duration: number | null = null;
  let thumbRel: string | null = null;
  let waveform: string | null = null;

  if (kind === 'photo') {
    try {
      const img = sharp(abs, { animated: false }).rotate();
      const meta = await sharp(abs).metadata();
      const swap = (meta.orientation ?? 1) >= 5;
      width = (swap ? meta.height : meta.width) ?? null;
      height = (swap ? meta.width : meta.height) ?? null;
      if (mime !== 'image/gif') {
        thumbRel = `${month}/${id}_t.webp`;
        await img
          .resize(720, 720, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 80 })
          .toFile(path.join(uploadsDir(), thumbRel));
      }
    } catch {
      kind = 'file';
      thumbRel = null;
    }
  } else if (kind === 'video' || kind === 'round' || kind === 'voice') {
    width = kind === 'voice' ? null : (o.width ?? null);
    height = kind === 'voice' ? null : (o.height ?? null);
    duration = o.duration ?? null;
    if (duration && kind === 'voice') duration = Math.min(duration, VOICE_MAX_SECONDS);
    if (duration && kind === 'round') duration = Math.min(duration, ROUND_MAX_SECONDS);
    if (kind === 'video') thumbRel = await savePoster(o.poster, month, id);
    if (kind === 'voice') {
      try {
        const w = waveformSchema.safeParse(JSON.parse(o.waveform ?? 'null'));
        if (w.success) waveform = JSON.stringify(w.data);
      } catch {
        /* no waveform */
      }
    }
  }

  db.prepare(
    `INSERT INTO files (id, uploader_id, kind, path, thumb_path, mime, size, name, width, height, duration, waveform, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, user.id, kind, rel, thumbRel, mime, size, name, width, height, duration, waveform, now());
  up.used = true;
  const row = db.prepare('SELECT * FROM files WHERE id = ?').get(id) as FileRow;
  if (kind === 'video') queueVideo(id);
  // the viewer-sized copy is made now, while nobody waits, not when the first person opens the photo
  else if (kind === 'photo') void previewPath(row);
  return row;
}

/** The first frame of a video, which the browser cut out before the upload ("data:image/jpeg;base64,…"). */
async function savePoster(dataUrl: string | undefined, dir: string, id: string): Promise<string | null> {
  const m = dataUrl && dataUrl.length < 600_000 ? /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl) : null;
  if (!m) return null;
  try {
    const rel = path.posix.join(dir, `${id}_t.webp`);
    // sharp decodes and re-encodes it: whatever was sent, only a picture is left
    await sharp(Buffer.from(m[1]!, 'base64'))
      .resize(720, 720, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toFile(path.join(uploadsDir(), rel));
    return rel;
  } catch {
    return null;
  }
}

/**
 * What the browser worked out about a video while it was going up (the size, the length and a frame): it is sent after the
 * file, so that the upload itself never waits for it. Only what is still unknown is filled in; ffprobe may have been quicker.
 */
export async function addVideoMeta(user: UserRow, fileId: string, meta: z.infer<typeof fileMetaSchema>): Promise<FileRow> {
  const f = getFile(fileId);
  if (!f || f.uploader_id !== user.id || f.kind !== 'video') throw notFound(txt.errors.fileNotFound);
  const sized = !!meta.width && !!meta.height;
  db.prepare('UPDATE files SET width = COALESCE(width, ?), height = COALESCE(height, ?), duration = COALESCE(duration, ?) WHERE id = ?').run(
    sized ? meta.width : null,
    sized ? meta.height : null,
    meta.duration ?? null,
    fileId,
  );
  if (!f.thumb_path && meta.poster) {
    const rel = await savePoster(meta.poster, path.posix.dirname(f.path), f.id);
    if (rel) db.prepare('UPDATE files SET thumb_path = COALESCE(thumb_path, ?) WHERE id = ?').run(rel, fileId);
  }
  return getFile(fileId)!;
}

/**
 * Smaller copies of a picture, made when somebody first asks and kept next to the original as <name>_<suffix>.webp:
 * the viewer needs a few hundred KB instead of the several MB the camera made, an avatar circle needs a few KB.
 */
const derivedJobs = new Map<string, Promise<string | null>>();

function derivedRel(f: FileRow, suffix: string) {
  const parsed = path.parse(f.path);
  const rel = path.posix.join(parsed.dir, `${parsed.name}_${suffix}.webp`);
  return { rel, abs: path.join(uploadsDir(), rel) };
}

function derived(f: FileRow, suffix: string, source: string, resize: (img: sharp.Sharp) => sharp.Sharp): Promise<string | null> {
  const { rel, abs } = derivedRel(f, suffix);
  if (fs.existsSync(abs)) return Promise.resolve(rel);
  const key = `${f.id}:${suffix}`;
  let job = derivedJobs.get(key);
  if (!job) {
    const tmp = `${abs}.${process.pid}.tmp`;
    job = resize(sharp(path.join(uploadsDir(), source), { animated: false }).rotate())
      .toFile(tmp)
      .then(() => {
        fs.renameSync(tmp, abs);
        return rel;
      })
      .catch(() => {
        fs.rmSync(tmp, { force: true });
        return null;
      })
      .finally(() => derivedJobs.delete(key));
    derivedJobs.set(key, job);
  }
  return job;
}

/** A photo as big as the viewer needs: a few hundred KB instead of the several MB the camera made. */
const PREVIEW_SIDE = 1920;

/** Path of the viewer-sized copy of a photo, made on first request (null: the original is small enough). */
export function previewPath(f: FileRow): Promise<string | null> {
  if (f.kind !== 'photo' || f.mime === 'image/gif' || f.mime === 'image/webp') return Promise.resolve(null);
  if (f.size < 350 * 1024 && Math.max(f.width ?? 0, f.height ?? 0) <= PREVIEW_SIDE) return Promise.resolve(null);
  return derived(f, 'p', f.path, (img) => img.resize(PREVIEW_SIDE, PREVIEW_SIDE, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }));
}

/** Avatars are shown at 18–80 px: 128 px is sharp on a retina screen at up to 64 px, and weighs a few KB instead of the 720 px thumbnail's tens. */
export const AVATAR_SIDE = 128;

/** Path of the small copy of a photo for an avatar circle (null: use the ordinary thumbnail). */
export function avatarPath(f: FileRow): Promise<string | null> {
  // a GIF may move, and it has no thumbnail to start from
  if (f.kind !== 'photo' || f.mime === 'image/gif') return Promise.resolve(null);
  return derived(f, 'a', f.thumb_path ?? f.path, (img) => img.resize(AVATAR_SIDE, AVATAR_SIDE, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }));
}

/**
 * Stickers: the panel shows them at about 72 px and a message at 160 px, but the file is whatever the author uploaded
 * (often a 1000+ px PNG of a few hundred KB). Two small copies with the transparency kept: 512 px for messages,
 * 224 px for the panel, the tabs and the editor.
 */
export const STICKER_SIDE = 512;
export const STICKER_SMALL_SIDE = 224;

/** Path of the sticker-sized copy of a picture (`small`: the one for the panel); null: the original goes as it is (a GIF). */
export async function stickerPath(f: FileRow, small = false): Promise<string | null> {
  if (f.kind !== 'photo' || f.mime === 'image/gif') return null;
  const suffix = small ? 'ss' : 'sk';
  if (fs.existsSync(derivedRel(f, suffix).abs)) return derivedRel(f, suffix).rel;
  // a moving picture (animated WebP or PNG) would lose its motion in a copy: it goes as it is
  try {
    const meta = await sharp(path.join(uploadsDir(), f.path)).metadata();
    if ((meta.pages ?? 1) > 1) return null;
  } catch {
    return null;
  }
  const side = small ? STICKER_SMALL_SIDE : STICKER_SIDE;
  return derived(f, suffix, f.path, (img) => img.resize(side, side, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 85, alphaQuality: 100 }));
}

/** Both copies are made when a picture becomes a sticker, so that the first person to open the pack does not wait for them. */
export function warmSticker(fileId: string) {
  const f = getFile(fileId);
  if (!f) return;
  void stickerPath(f);
  void stickerPath(f, true);
}

export function getFile(id: string): FileRow | undefined {
  return db.prepare('SELECT * FROM files WHERE id = ?').get(id) as FileRow | undefined;
}

export function requireOwnPhoto(fileId: string, user: UserRow) {
  const f = getFile(fileId);
  if (!f || f.kind !== 'photo' || f.uploader_id !== user.id) throw badRequest(txt.errors.imageRequired);
  return f;
}

export function uploadsBytes(): number {
  return (db.prepare('SELECT COALESCE(SUM(size), 0) s FROM files').get() as { s: number }).s;
}
