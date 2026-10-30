import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { decryptText, encryptText, isEncrypted, messageKey } from '../src/crypt.js';
import { db, initDb } from '../src/db.js';
import { getOrCreatePrivate } from '../src/services/chats.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'timba-enc-'));
let app: FastifyInstance;
let ip = 0;

beforeAll(async () => {
  config.dataDir = tmp;
  config.adminPassword = 'adminpass';
  app = await buildApp({ dbFile: ':memory:' });
});

afterAll(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function user(name: string) {
  const r = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    remoteAddress: `10.7.0.${++ip}`,
    payload: { username: name, password: 'secret123', firstName: name },
  });
  const cookie = String(r.headers['set-cookie']).split(';')[0]!;
  return {
    id: JSON.parse(r.body).id as number,
    req: async (method: string, url: string, body?: unknown) => {
      const x = await app.inject({ method: method as 'GET', url, payload: body as object, headers: { cookie } });
      return { status: x.statusCode, body: x.body ? JSON.parse(x.body) : null };
    },
  };
}

describe('clearing a chat for everybody', () => {
  it('wipes a private chat for both sides, and a message goes for both when nothing else is said', async () => {
    const ann = await user('clr_ann');
    const bob = await user('clr_bob');
    const chat = (await ann.req('POST', '/api/chats/private', { userId: bob.id })).body;
    const m1 = (await ann.req('POST', `/api/chats/${chat.id}/messages`, { text: 'раз' })).body;
    await bob.req('POST', `/api/chats/${chat.id}/messages`, { text: 'два' });
    // no "forAll" in the request: the message is deleted for the other side as well
    expect((await ann.req('POST', '/api/messages/delete', { ids: [m1.id] })).status).toBe(200);
    expect((await bob.req('GET', `/api/chats/${chat.id}/messages`)).body.map((m: { text: string }) => m.text)).toEqual(['два']);

    await ann.req('POST', `/api/chats/${chat.id}/messages`, { text: 'три' });
    const cleared = await bob.req('POST', `/api/chats/${chat.id}/clear`);
    expect(cleared.status).toBe(200);
    expect(cleared.body.lastMessage).toBeNull();
    expect((await ann.req('GET', `/api/chats/${chat.id}/messages`)).body).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) c FROM messages WHERE chat_id = ?').get(chat.id)).toEqual({ c: 0 });
  });

  it('a channel is wiped by its owner for all subscribers; a subscriber can only clear their own view', async () => {
    const owner = await user('clr_owner');
    const fan = await user('clr_fan');
    const ch = (await owner.req('POST', '/api/chats/channel', { title: 'Новости', memberIds: [fan.id] })).body;
    await owner.req('POST', `/api/chats/${ch.id}/messages`, { text: 'пост 1' });
    await owner.req('POST', `/api/chats/${ch.id}/messages`, { text: 'пост 2' });

    // a subscriber may not wipe it for others, but their own copy goes
    expect((await fan.req('POST', `/api/chats/${ch.id}/clear`, { forAll: true })).status).toBe(403);
    expect((await fan.req('POST', `/api/chats/${ch.id}/clear`, { forAll: false })).status).toBe(200);
    expect((await fan.req('GET', `/api/chats/${ch.id}/messages`)).body).toEqual([]);
    expect((await owner.req('GET', `/api/chats/${ch.id}/messages`)).body.filter((m: { kind: string }) => m.kind !== 'service')).toHaveLength(2);

    expect((await owner.req('POST', `/api/chats/${ch.id}/clear`)).status).toBe(200);
    expect((await owner.req('GET', `/api/chats/${ch.id}/messages`)).body).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) c FROM messages WHERE chat_id = ?').get(ch.id)).toEqual({ c: 0 });
    // the chat itself stays and works
    expect((await owner.req('POST', `/api/chats/${ch.id}/messages`, { text: 'снова' })).status).toBe(200);
  });
});

describe('message encryption', () => {
  it('encrypts a text with a fresh nonce, reads it back, and leaves everything else alone', () => {
    const a = encryptText('Привет, мир');
    const b = encryptText('Привет, мир');
    expect(isEncrypted(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(a).not.toContain('Привет');
    expect(decryptText(a)).toBe('Привет, мир');
    expect(encryptText('')).toBe('');
    // a text that merely looks like a stored one is still a text
    expect(decryptText(encryptText('enc1:AAAA'))).toBe('enc1:AAAA');
    // plain text of the old days and a damaged value come back as they are
    expect(decryptText('просто текст')).toBe('просто текст');
    const broken = a.slice(0, -4) + (a.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(decryptText(broken)).toBe(broken);
    // the key is made once and kept in the data directory
    expect(messageKey()).toHaveLength(32);
    expect(fs.statSync(path.join(tmp, 'message.key')).mode & 0o077).toBe(0);
  });

  it('keeps the texts encrypted in the database, plain through the API, the admin panel and the search', async () => {
    const ann = await user('enc_ann');
    const bob = await user('enc_bob');
    const chat = (await ann.req('POST', '/api/chats/private', { userId: bob.id })).body;
    const sent = (await ann.req('POST', `/api/chats/${chat.id}/messages`, { text: 'секретный план #тайна' })).body;
    expect(sent.text).toBe('секретный план #тайна');

    // the file itself holds no text
    const raw = db
      .prepare(`SELECT substr(text, 1, 5) AS p, instr(text, 'план') AS leak FROM messages WHERE id = ?`)
      .get(sent.id) as { p: string; leak: number };
    expect(raw).toEqual({ p: 'enc1:', leak: 0 });

    // the other member, the history, the editor
    const seen = (await bob.req('GET', `/api/chats/${chat.id}/messages`)).body;
    expect(seen.map((m: { text: string }) => m.text)).toContain('секретный план #тайна');
    const edited = await ann.req('PATCH', `/api/messages/${sent.id}`, { text: 'другой план' });
    expect(edited.body.text).toBe('другой план');
    expect(
      (db.prepare(`SELECT instr(text, 'план') AS leak, substr(text, 1, 5) AS p FROM messages WHERE id = ?`).get(sent.id) as { leak: number; p: string }),
    ).toEqual({ leak: 0, p: 'enc1:' });

    // the admin panel decrypts
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '10.7.9.9', payload: { username: 'admin', password: 'adminpass' } });
    const adminCookie = String(login.headers['set-cookie']).split(';')[0]!;
    const adm = await app.inject({ method: 'GET', url: `/api/admin/chats/${chat.id}/messages`, headers: { cookie: adminCookie } });
    expect(JSON.parse(adm.body).map((m: { text: string }) => m.text)).toContain('другой план');

    // search reads through the encryption, by word start and by tag
    const found = (await bob.req('GET', `/api/chats/${chat.id}/search?q=${encodeURIComponent('ДРУГ пла')}`)).body;
    expect(found.messages.map((m: { id: number }) => m.id)).toEqual([sent.id]);
    await ann.req('POST', `/api/chats/${chat.id}/messages`, { text: 'ещё #тайна' });
    expect((await bob.req('GET', `/api/search/messages?q=${encodeURIComponent('#тайна')}`)).body.messages).toHaveLength(1);

    // a text that looks like a stored one survives the trip
    const odd = (await ann.req('POST', `/api/chats/${chat.id}/messages`, { text: 'enc1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })).body;
    expect(odd.text).toBe('enc1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  });

  // last: it replaces the database the app runs on
  it('encrypts what was stored in the clear and drops the old search index', () => {
    const file = path.join(tmp, 'legacy.db');
    const first = initDb(file);
    const mk = (name: string) =>
      Number(first.prepare(`INSERT INTO users (username, password_hash, created_at) VALUES (?, 'x', 1)`).run(name).lastInsertRowid);
    const [a, b] = [mk('leg_a'), mk('leg_b')];
    const row = (id: number) => first.prepare('SELECT * FROM users WHERE id = ?').get(id) as never;
    const chat = getOrCreatePrivate(row(a), row(b));
    first.close();

    // the database as it was before: a plain message and the full-text index with its words
    const old = new Database(file);
    old.exec(`
      INSERT INTO messages (chat_id, sender_id, kind, text, created_at) VALUES (${chat.id}, ${a}, 'text', 'старое сообщение', 1);
      CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='id');
      INSERT INTO messages_fts(rowid, text) SELECT id, text FROM messages;
      CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text); END;
    `);
    old.close();

    const next = initDb(file);
    const stored = next.prepare(`SELECT substr(text, 1, 5) AS p, instr(text, 'старое') AS leak FROM messages`).get();
    expect(stored).toEqual({ p: 'enc1:', leak: 0 });
    expect((next.prepare('SELECT text FROM messages').get() as { text: string }).text).toBe('старое сообщение');
    expect(next.prepare(`SELECT COUNT(*) c FROM sqlite_master WHERE name LIKE 'messages_fts%'`).get()).toEqual({ c: 0 });
    next.close();
  });
});
