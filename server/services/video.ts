import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { uploadsDir } from '../config.js';
import { db } from '../db.js';
import type { FileRow } from '../serialize.js';

/**
 * Videos are looked after in the background once they are uploaded: ffprobe reads the size and the length,
 * a frame is cut out for the chat, and the video is made to start at once (the index goes to the front of
 * the file) and to play everywhere (H.264 + AAC, at most 1280 px). People never wait for any of it:
 * the message goes out with the original, which is swapped for the lighter file later.
 * Without ffmpeg on the machine all of this is skipped.
 */

const FFMPEG = process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH?.trim() || 'ffprobe';
const MAX_SIDE = 1280;
/** a video over this bitrate (bit/s) is encoded again, below it the file is only re-packed */
const MAX_BITRATE = 4_000_000;
const JOB_TIMEOUT_MS = 15 * 60_000;

let available: boolean | null = null;
export function ffmpegAvailable(): boolean {
  if (available === null) {
    available =
      process.env.FFMPEG !== 'off' &&
      spawnSync(FFMPEG, ['-version'], { stdio: 'ignore' }).status === 0 &&
      spawnSync(FFPROBE, ['-version'], { stdio: 'ignore' }).status === 0;
  }
  return available;
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: JOB_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

export interface VideoProbe {
  width: number;
  height: number;
  duration: number | null;
  vcodec: string;
  acodec: string | null;
  /** bit/s of the picture, 0 when unknown */
  bitrate: number;
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  bit_rate?: string;
  duration?: string;
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
}

export async function probeVideo(abs: string): Promise<VideoProbe | null> {
  try {
    const out = JSON.parse(await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', abs])) as {
      streams?: ProbeStream[];
      format?: { duration?: string; bit_rate?: string };
    };
    const v = out.streams?.find((s) => s.codec_type === 'video' && s.width && s.height);
    if (!v) return null;
    const a = out.streams?.find((s) => s.codec_type === 'audio');
    // a phone video is stored sideways and turned by a flag: the picture people see is the other way round
    const turn = Math.abs(Number(v.tags?.rotate ?? v.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0)) % 180 === 90;
    const dur = Number(v.duration ?? out.format?.duration);
    return {
      width: (turn ? v.height : v.width)!,
      height: (turn ? v.width : v.height)!,
      duration: Number.isFinite(dur) && dur > 0 ? dur : null,
      vcodec: v.codec_name ?? '',
      acodec: a?.codec_name ?? null,
      bitrate: Number(v.bit_rate) || Number(out.format?.bit_rate) || 0,
    };
  } catch {
    return null;
  }
}

/** Does it need to be encoded again, or is re-packing enough? */
export function needsEncode(p: VideoProbe): boolean {
  return p.vcodec !== 'h264' || (p.acodec !== null && p.acodec !== 'aac') || Math.max(p.width, p.height) > MAX_SIDE || p.bitrate > MAX_BITRATE;
}

async function makePoster(abs: string, p: VideoProbe, rel: string): Promise<boolean> {
  const tmp = `${abs}.poster.jpg`;
  try {
    const at = Math.min(1, (p.duration ?? 1) * 0.1);
    await run(FFMPEG, ['-v', 'error', '-y', '-ss', String(at), '-i', abs, '-frames:v', '1', '-vf', 'scale=720:720:force_original_aspect_ratio=decrease', tmp]);
    await sharp(tmp).webp({ quality: 80 }).toFile(path.join(uploadsDir(), rel));
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** One at a time: encoding takes the whole processor, and chat must stay quick. */
let tail: Promise<unknown> = Promise.resolve();
export function queueVideo(fileId: string) {
  if (process.env.NODE_ENV === 'test' || !ffmpegAvailable()) return;
  tail = tail.then(() => processVideo(fileId)).catch(() => {});
}

/** Everything ffmpeg does for one uploaded video. Never throws. */
export async function processVideo(fileId: string): Promise<void> {
  try {
    const row = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId) as FileRow | undefined;
    if (!row || row.kind !== 'video') return;
    const abs = path.join(uploadsDir(), row.path);
    const p = await probeVideo(abs);
    if (!p) return;

    // what the browser could not tell
    db.prepare('UPDATE files SET width = COALESCE(width, ?), height = COALESCE(height, ?), duration = COALESCE(duration, ?) WHERE id = ?').run(
      p.width,
      p.height,
      p.duration,
      fileId,
    );
    const dir = path.dirname(row.path);
    const stem = path.parse(row.path).name;
    if (!row.thumb_path) {
      const rel = path.posix.join(dir, `${stem}_t.webp`);
      if (await makePoster(abs, p, rel)) db.prepare('UPDATE files SET thumb_path = ? WHERE id = ?').run(rel, fileId);
    }

    const encode = needsEncode(p);
    const outRel = path.posix.join(dir, `${stem}_v.mp4`);
    const out = path.join(uploadsDir(), outRel);
    const tmp = `${out}.tmp.mp4`;
    const args = ['-v', 'error', '-y', '-i', abs, '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-map_metadata', '-1'];
    if (encode) {
      const long = p.width >= p.height;
      const scale = long ? `scale='min(${MAX_SIDE},iw)':-2` : `scale=-2:'min(${MAX_SIDE},ih)'`;
      args.push('-vf', scale, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k');
    } else {
      args.push('-c', 'copy');
    }
    args.push('-movflags', '+faststart', '-f', 'mp4', tmp);
    try {
      await run(FFMPEG, args);
      const size = fs.statSync(tmp).size;
      // an encode that did not make the file smaller is not worth it; a re-pack changes nothing but the order
      if (size <= 0 || (encode && size >= row.size)) {
        fs.rmSync(tmp, { force: true });
        return;
      }
      fs.renameSync(tmp, out);
    } catch {
      fs.rmSync(tmp, { force: true });
      return;
    }

    const small = await probeVideo(out);
    const name = row.name.replace(/\.[^.]+$/, '') + '.mp4';
    db.prepare('UPDATE files SET path = ?, mime = ?, size = ?, name = ?, width = ?, height = ?, duration = COALESCE(?, duration) WHERE id = ?').run(
      outRel,
      'video/mp4',
      fs.statSync(out).size,
      name,
      small?.width ?? p.width,
      small?.height ?? p.height,
      small?.duration ?? null,
      fileId,
    );
    // somebody may be watching it right now: the open file stays readable on Linux
    fs.rmSync(abs, { force: true });
  } catch {
    /* the database may be closed during shutdown; the original stays as it is */
  }
}
