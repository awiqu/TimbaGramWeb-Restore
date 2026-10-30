import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import type { DB } from './db.js';

/**
 * Encryption of the message texts at rest (AES-256-GCM). The database file holds `enc1:<iv|tag|text>`
 * instead of the text, so a copy of the file (a backup, a leaked disk) does not read without the key.
 * It is not end-to-end: the server holds the key, which is why the admin panel can still read (decrypt)
 * the chats, and the users' own clients get plain text from the API as before.
 *
 * The key is MESSAGE_KEY (32 bytes, base64 or hex) or, when that is not set, a file `message.key` in the data
 * directory, made on the first use. Keep it next to the database backups, not inside them: a lost key cannot be
 * restored and the encrypted messages are gone with it.
 *
 * Writing goes through `encryptText` where a message is saved; reading is transparent: every row that comes out of
 * a query with a `text` that starts with the prefix is decrypted (see `installDecryption`), so the rest of the
 * server keeps working with plain text.
 */
const PREFIX = 'enc1:';
const KEY_FILE = 'message.key';

let cached: { dir: string; env: string | undefined; key: Buffer } | null = null;

function parseKey(raw: string): Buffer | null {
  const s = raw.trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return Buffer.from(s, 'hex');
  const b = Buffer.from(s, 'base64');
  return b.length === 32 ? b : null;
}

/** The key: from the environment, else from the file in the data directory (made once). */
export function messageKey(): Buffer {
  const env = process.env.MESSAGE_KEY;
  const dir = config.dataDir;
  if (cached && cached.dir === dir && cached.env === env) return cached.key;
  let key: Buffer | null = env ? parseKey(env) : null;
  if (env && !key) throw new Error('MESSAGE_KEY must be 32 bytes in base64 or 64 hex characters');
  if (!key) {
    const file = path.join(dir, KEY_FILE);
    try {
      key = parseKey(fs.readFileSync(file, 'utf8'));
      if (!key) throw new Error(`${file} does not hold a 32 byte key`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      fs.mkdirSync(dir, { recursive: true });
      const fresh = crypto.randomBytes(32);
      try {
        fs.writeFileSync(file, `${fresh.toString('base64')}\n`, { mode: 0o600, flag: 'wx' });
        key = fresh;
      } catch (err) {
        // another process was first: take its key
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        key = parseKey(fs.readFileSync(file, 'utf8'));
        if (!key) throw new Error(`${file} does not hold a 32 byte key`);
      }
    }
  }
  cached = { dir, env, key };
  return key;
}

/** Plain text -> `enc1:...`. Empty text stays empty. Always encrypts (a text that looks like a token is a text). */
export function encryptText(text: string): string {
  if (!text) return text;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', messageKey(), iv);
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

let warned = false;

/** `enc1:...` -> text. Anything else (a legacy plain text) comes back as it is; so does what cannot be decrypted. */
export function decryptText(value: string): string {
  if (!value.startsWith(PREFIX)) return value;
  try {
    const raw = Buffer.from(value.slice(PREFIX.length), 'base64url');
    if (raw.length < 28) return value;
    const decipher = crypto.createDecipheriv('aes-256-gcm', messageKey(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch (e) {
    if (!warned) {
      warned = true;
      console.warn('a message could not be decrypted (wrong or lost MESSAGE_KEY?):', (e as Error).message);
    }
    return value;
  }
}

export const isEncrypted = (value: unknown): value is string => typeof value === 'string' && value.startsWith(PREFIX);

const fix = (row: unknown) => {
  if (row && typeof row === 'object' && isEncrypted((row as { text?: unknown }).text)) {
    (row as { text: string }).text = decryptText((row as { text: string }).text);
  }
  return row;
};

let installed = false;

/**
 * Rows read from the database come out with the text decrypted. better-sqlite3 has one statement class for
 * every database, so this is done once, on its prototype (`get` and `all` are all the server reads with).
 */
export function installDecryption(db: DB) {
  if (installed) return;
  const proto = Object.getPrototypeOf(db.prepare('SELECT 1')) as {
    get: (...a: unknown[]) => unknown;
    all: (...a: unknown[]) => unknown[];
  };
  const get = proto.get;
  const all = proto.all;
  proto.get = function (this: unknown, ...args: unknown[]) {
    return fix(get.apply(this, args));
  };
  proto.all = function (this: unknown, ...args: unknown[]) {
    const rows = all.apply(this, args);
    for (const r of rows) fix(r);
    return rows;
  };
  installed = true;
}

/** Texts written before the encryption (and the old search index, which held them in the clear) are encrypted once. */
export function encryptExisting(db: DB): number {
  const todo = db
    .prepare(`SELECT COUNT(*) c FROM messages WHERE text != '' AND substr(text, 1, ${PREFIX.length}) != ?`)
    .get(PREFIX) as { c: number };
  const sched = db
    .prepare(`SELECT COUNT(*) c FROM scheduled_messages WHERE text != '' AND substr(text, 1, ${PREFIX.length}) != ?`)
    .get(PREFIX) as { c: number };
  if (!todo.c && !sched.c) return 0;
  let done = 0;
  for (const table of ['messages', 'scheduled_messages']) {
    const pick = db.prepare(`SELECT id, text FROM ${table} WHERE text != '' AND substr(text, 1, ${PREFIX.length}) != ? LIMIT 500`);
    const put = db.prepare(`UPDATE ${table} SET text = ? WHERE id = ?`);
    for (;;) {
      const rows = pick.all(PREFIX) as { id: number; text: string }[];
      if (!rows.length) break;
      db.transaction(() => {
        for (const r of rows) put.run(encryptText(r.text), r.id);
      })();
      done += rows.length;
    }
  }
  return done;
}
