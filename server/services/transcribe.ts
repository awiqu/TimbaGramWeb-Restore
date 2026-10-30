import fs from 'node:fs';
import path from 'node:path';
import { config, uploadsDir } from '../config.js';
import { db } from '../db.js';
import { HttpError, badRequest, forbidden, notFound } from '../errors.js';
import { canView, getChat } from '../permissions.js';
import type { FileRow, UserRow } from '../serialize.js';
import { txt } from '../strings.js';

/**
 * Voice and round messages to text through an OpenAI compatible /audio/transcriptions API —
 * by default polza.ai (POLZA_API_KEY and POLZA_BASE_URL). The text is kept, so every file is transcribed once.
 */
export const transcriptionAvailable = () => !!config.transcribeKey;

/** Anybody who can see a message with the file may read its text. */
function canSeeFile(fileId: string, user: UserRow): boolean {
  const chats = db
    .prepare('SELECT DISTINCT m.chat_id FROM message_files mf JOIN messages m ON m.id = mf.message_id WHERE mf.file_id = ?')
    .all(fileId) as { chat_id: number }[];
  return chats.some((c) => {
    const chat = getChat(c.chat_id);
    return !!chat && canView(chat, user);
  });
}

const inFlight = new Map<string, Promise<string>>();

export async function transcribe(fileId: string, user: UserRow): Promise<{ text: string }> {
  const f = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId) as FileRow | undefined;
  if (!f) throw notFound(txt.errors.fileNotFound);
  if (f.kind !== 'voice' && f.kind !== 'round') throw badRequest(txt.errors.transcribeKind);
  if (f.uploader_id !== user.id && !canSeeFile(f.id, user)) throw forbidden();
  if (f.transcript !== null) return { text: f.transcript };
  if (!transcriptionAvailable()) throw new HttpError(503, 'transcribe_unavailable', txt.errors.transcribeUnavailable);

  // two people pressing the button at once share one request
  let job = inFlight.get(f.id);
  if (!job) {
    job = request(f).finally(() => inFlight.delete(f.id));
    inFlight.set(f.id, job);
  }
  const text = await job;
  db.prepare('UPDATE files SET transcript = ? WHERE id = ?').run(text, f.id);
  return { text };
}

async function request(f: FileRow): Promise<string> {
  const data = fs.readFileSync(path.join(uploadsDir(), f.path));
  const form = new FormData();
  form.append('file', new Blob([data], { type: f.mime }), path.basename(f.path));
  form.append('model', config.transcribeModel);
  form.append('language', 'ru');
  form.append('response_format', 'json');
  let res: Response;
  try {
    res = await fetch(`${config.transcribeBaseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.transcribeKey}` },
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new HttpError(503, 'transcribe_failed', txt.errors.transcribeFailed);
  }
  const json = (await res.json().catch(() => null)) as { text?: string } | null;
  if (!res.ok || typeof json?.text !== 'string') throw new HttpError(503, 'transcribe_failed', txt.errors.transcribeFailed);
  return json.text.trim();
}
