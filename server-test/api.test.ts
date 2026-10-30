import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { config, uploadsDir } from '../src/config.js';
import { getFile } from '../src/services/files.js';
import { ffmpegAvailable, probeVideo, processVideo } from '../src/services/video.js';
import { PREMIUM_WEEKLY_BONUS } from '@timba/shared';
import { sendPremiumReminders } from '../src/bank/bank.js';
import sharp from 'sharp';

let app: FastifyInstance;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'timba-test-'));

beforeAll(async () => {
  config.dataDir = tmp;
  config.adminPassword = 'adminpass';
  app = await buildApp({ dbFile: ':memory:' });
});

afterAll(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

interface Client {
  id: number;
  cookie: string;
  req: (method: string, url: string, body?: unknown) => Promise<{ status: number; body: any }>;
}

async function client(cookie: string, id: number): Promise<Client> {
  return {
    id,
    cookie,
    req: async (method, url, body) => {
      const r = await app.inject({ method: method as 'GET', url, payload: body as object, headers: { cookie } });
      return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
    },
  };
}

let ipSeq = 0;
async function register(username: string): Promise<Client> {
  const r = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    // one "IP" per registration so the sign-up rate limit does not kick in
    remoteAddress: `10.0.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`,
    payload: { username, password: 'secret123', firstName: username },
  });
  expect(r.statusCode).toBe(200);
  const cookie = String(r.headers['set-cookie']).split(';')[0]!;
  return client(cookie, JSON.parse(r.body).id);
}

async function login(username: string, password: string) {
  return app.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password } });
}

/** One admin session for the tests that need no fresh one: logins are rate limited per IP. */
let adminSession: Promise<Client> | null = null;
function sharedAdmin() {
  adminSession ??= app
    .inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'adminpass' }, remoteAddress: '10.0.0.2' })
    .then((r) => client(String(r.headers['set-cookie']).split(';')[0]!, JSON.parse(r.body).id));
  return adminSession;
}

describe('auth', () => {
  it('registers, rejects duplicates and reserved admin name', async () => {
    const a = await register('alice');
    const me = await a.req('GET', '/api/auth/me');
    expect(me.body.username).toBe('alice');
    const dup = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'ALICE', password: 'secret123' } });
    expect(dup.statusCode).toBe(409);
    const adm = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'admin', password: 'secret123' } });
    expect(adm.statusCode).toBe(409);
  });

  it('seeds admin account', async () => {
    const r = await login('admin', 'adminpass');
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).isAdmin).toBe(true);
  });
});

describe('hardening', () => {
  it('sends security headers and marks the cookie secure behind a TLS proxy', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/app/status' });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(r.headers['referrer-policy']).toBeTruthy();
    expect(String(r.headers['content-security-policy'])).toContain("frame-ancestors 'self'");

    const over = (proto: string, username: string) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/register',
        remoteAddress: `10.9.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`,
        headers: { 'x-forwarded-proto': proto },
        payload: { username, password: 'secret123', firstName: username },
      });
    expect(String((await over('https', 'secure_one')).headers['set-cookie'])).toContain('Secure');
    expect(String((await over('http', 'secure_two')).headers['set-cookie'])).not.toContain('Secure');
  });

  it('slows down guessing one password and message floods', async () => {
    await register('victim1');
    const guess = (i: number) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: `10.8.0.${i}`,
        payload: { username: 'victim1', password: 'wrong-password' },
      });
    let limited = 0;
    for (let i = 1; i <= 35; i++) if ((await guess(i)).statusCode === 429) limited++;
    expect(limited).toBeGreaterThan(0);

    const a = await register('flood_a');
    const b = await register('flood_b');
    const chat = await a.req('POST', '/api/chats/private', { userId: b.id });
    const statuses: number[] = [];
    for (let i = 0; i < 70; i++) statuses.push((await a.req('POST', `/api/chats/${chat.body.id}/messages`, { text: `m${i}` })).status);
    expect(statuses.slice(0, 60).every((x) => x === 200)).toBe(true);
    expect(statuses.slice(60).every((x) => x === 429)).toBe(true);
    // an honest user is not affected
    expect((await b.req('POST', `/api/chats/${chat.body.id}/messages`, { text: 'hi' })).status).toBe(200);
  });
});

describe('messaging & groups', () => {
  let owner: Client;
  let bob: Client;
  let carol: Client;
  let groupId: number;

  beforeAll(async () => {
    owner = await register('owner1');
    bob = await register('bob1');
    carol = await register('carol1');
  });

  it('private chat send / edit / delete', async () => {
    const chat = await owner.req('POST', '/api/chats/private', { userId: bob.id });
    expect(chat.status).toBe(200);
    const sent = await owner.req('POST', `/api/chats/${chat.body.id}/messages`, { text: 'hi' });
    expect(sent.body.text).toBe('hi');
    const bobChats = await bob.req('GET', '/api/chats');
    expect(bobChats.body[0].unreadCount).toBe(1);
    const edit = await bob.req('PATCH', `/api/messages/${sent.body.id}`, { text: 'hacked' });
    expect(edit.status).toBe(403);
    const ok = await owner.req('PATCH', `/api/messages/${sent.body.id}`, { text: 'hello' });
    expect(ok.body.text).toBe('hello');
    const del = await bob.req('POST', '/api/messages/delete', { ids: [sent.body.id], forAll: true });
    expect(del.status).toBe(200);
    const list = await owner.req('GET', `/api/chats/${chat.body.id}/messages`);
    expect(list.body).toHaveLength(0);
  });

  it('group roles, mute, ban', async () => {
    const g = await owner.req('POST', '/api/chats/group', { title: 'G', memberIds: [bob.id, carol.id] });
    expect(g.status).toBe(200);
    groupId = g.body.id;

    // member without rights cannot kick
    expect((await bob.req('POST', `/api/chats/${groupId}/members/${carol.id}/kick`)).status).toBe(403);

    // promote bob without ban rights -> still cannot ban
    await owner.req('PATCH', `/api/chats/${groupId}/members/${bob.id}`, {
      role: 'admin',
      rights: { changeInfo: true, deleteMessages: true, banUsers: false, inviteUsers: true, pinMessages: true, addAdmins: false },
    });
    expect((await bob.req('POST', `/api/chats/${groupId}/members/${carol.id}/ban`, {})).status).toBe(403);
    // admin cannot act on owner
    expect((await bob.req('POST', `/api/chats/${groupId}/members/${owner.id}/kick`)).status).toBe(403);

    // muted user cannot write
    await owner.req('POST', `/api/chats/${groupId}/members/${carol.id}/mute`, { until: null });
    expect((await carol.req('POST', `/api/chats/${groupId}/messages`, { text: 'x' })).status).toBe(403);
    await owner.req('POST', `/api/chats/${groupId}/members/${carol.id}/unmute`);
    expect((await carol.req('POST', `/api/chats/${groupId}/messages`, { text: 'x' })).status).toBe(200);

    // banned user is removed and cannot rejoin
    await owner.req('POST', `/api/chats/${groupId}/members/${carol.id}/ban`, {});
    expect((await carol.req('GET', `/api/chats/${groupId}`)).status).toBe(403);
    const token = (await owner.req('GET', `/api/chats/${groupId}`)).body.inviteToken;
    expect((await carol.req('POST', `/api/invite/${token}`)).status).toBe(403);
    await owner.req('DELETE', `/api/chats/${groupId}/bans/${carol.id}`);
    expect((await carol.req('POST', `/api/invite/${token}`)).status).toBe(200);
  });

  it('public groups can be joined and found', async () => {
    const g = await owner.req('POST', '/api/chats/group', { title: 'Public', isPublic: true, publicUsername: 'pubgroup' });
    const found = await carol.req('GET', '/api/search?q=pubgr');
    expect(found.body.groups.map((x: { id: number }) => x.id)).toContain(g.body.id);
    expect((await carol.req('POST', `/api/chats/${g.body.id}/join`)).status).toBe(200);
    const taken = await bob.req('POST', '/api/chats/group', { title: 'Dup', isPublic: true, publicUsername: 'pubgroup' });
    expect(taken.status).toBe(409);
  });

  it('global admin has owner rights and can ban / enable maintenance', async () => {
    const r = await login('admin', 'adminpass');
    const admin = await client(String(r.headers['set-cookie']).split(';')[0]!, JSON.parse(r.body).id);
    expect((await admin.req('POST', `/api/chats/${groupId}/members/${bob.id}/kick`)).status).toBe(200);
    expect((await bob.req('GET', '/api/admin/stats')).status).toBe(403);

    await admin.req('POST', `/api/admin/users/${carol.id}/ban`, { reason: 'spam' });
    const me = await carol.req('GET', '/api/chats');
    expect(me.status).toBe(403);
    expect(me.body.error).toBe('banned');
    expect((await login('carol1', 'secret123')).statusCode).toBe(403);
    await admin.req('POST', `/api/admin/users/${carol.id}/unban`);
    expect((await carol.req('GET', '/api/chats')).status).toBe(200);

    await admin.req('PUT', '/api/admin/settings', { maintenance: true });
    expect((await bob.req('GET', '/api/chats')).status).toBe(503);
    expect((await admin.req('GET', '/api/chats')).status).toBe(200);
    await admin.req('PUT', '/api/admin/settings', { maintenance: false });
    expect((await bob.req('GET', '/api/chats')).status).toBe(200);
  });

  it('global admin can moderate group owners and take ownership', async () => {
    const r = await login('admin', 'adminpass');
    const admin = await client(String(r.headers['set-cookie']).split(';')[0]!, JSON.parse(r.body).id);
    const dave = await register('dave1');
    const erin = await register('erin1');
    const g = (await dave.req('POST', '/api/chats/group', { title: 'Dave group', memberIds: [erin.id] })).body;

    // mute and ban the owner -> ownership passes to erin
    expect((await admin.req('POST', `/api/chats/${g.id}/members/${dave.id}/mute`, { until: null })).status).toBe(200);
    expect((await admin.req('POST', `/api/chats/${g.id}/members/${dave.id}/ban`, {})).status).toBe(200);
    const info = (await erin.req('GET', `/api/chats/${g.id}`)).body;
    expect(info.ownerId).toBe(erin.id);
    expect(info.me.role).toBe('owner');

    // admin takes ownership without being a member
    expect((await admin.req('POST', `/api/chats/${g.id}/transfer`, { userId: admin.id })).status).toBe(200);
    const after = (await admin.req('GET', `/api/chats/${g.id}`)).body;
    expect(after.ownerId).toBe(admin.id);
    expect(after.me.isMember).toBe(true);
    const members = (await admin.req('GET', `/api/chats/${g.id}/members`)).body as { user: { id: number }; role: string }[];
    expect(members.find((m) => m.user.id === erin.id)?.role).toBe('admin');

    // regular users still cannot touch the owner
    expect((await erin.req('POST', `/api/chats/${g.id}/members/${admin.id}/kick`)).status).toBe(403);
  });

  it('enforces upload size limit', async () => {
    const r = await login('admin', 'adminpass');
    const admin = await client(String(r.headers['set-cookie']).split(';')[0]!, JSON.parse(r.body).id);
    await admin.req('PUT', '/api/admin/settings', { maxUploadMb: 1 });
    const boundary = '----x';
    const big = Buffer.alloc(1024 * 1024 + 10, 1);
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      big,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/files',
      payload,
      headers: { cookie: owner.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    expect(res.statusCode).toBe(413);

    const small = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\n`),
      Buffer.from('hello'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const ok = await app.inject({
      method: 'POST',
      url: '/api/files',
      payload: small,
      headers: { cookie: owner.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).kind).toBe('file');
    await admin.req('PUT', '/api/admin/settings', { maxUploadMb: 100 });
  });
});

async function adminClient() {
  const r = await login('admin', 'adminpass');
  return client(String(r.headers['set-cookie']).split(';')[0]!, JSON.parse(r.body).id);
}

describe('channels', () => {
  let owner: Client;
  let sub: Client;
  let other: Client;

  beforeAll(async () => {
    owner = await register('chowner');
    sub = await register('chsub');
    other = await register('chother');
  });

  it('the site admin boosts channel subscribers, only they see the boost', async () => {
    const c = await owner.req('POST', '/api/chats/channel', { title: 'Boosted', isPublic: true, publicUsername: 'boostchan' });
    const id = c.body.id;
    const admin = await sharedAdmin();
    expect((await owner.req('POST', `/api/admin/groups/${id}/boost`, { mode: 'add', count: 5 })).status).toBe(403);
    expect((await admin.req('POST', `/api/admin/groups/${id}/boost`, { mode: 'add', count: 500 })).body.boostSubscribers).toBe(500);
    expect((await admin.req('POST', `/api/admin/groups/${id}/boost`, { mode: 'add', count: -100 })).body.boostSubscribers).toBe(400);
    const seen = (await owner.req('GET', `/api/chats/${id}`)).body;
    expect(seen.memberCount).toBe(401);
    expect(seen.boostSubscribers).toBe(0);
    expect((await admin.req('GET', `/api/chats/${id}`)).body.boostSubscribers).toBe(400);
    const listed = (await admin.req('GET', '/api/admin/groups?q=Boosted')).body[0];
    expect(listed).toMatchObject({ memberCount: 401, boostSubscribers: 400 });
    // cannot go below zero; "set" replaces
    expect((await admin.req('POST', `/api/admin/groups/${id}/boost`, { mode: 'add', count: -1000 })).body.boostSubscribers).toBe(0);
    expect((await admin.req('POST', `/api/admin/groups/${id}/boost`, { mode: 'set', count: 42 })).body.boostSubscribers).toBe(42);
    // groups cannot be boosted
    const g = await owner.req('POST', '/api/chats/group', { title: 'NoBoost', memberIds: [] });
    expect((await admin.req('POST', `/api/admin/groups/${g.body.id}/boost`, { mode: 'add', count: 5 })).status).toBe(400);
  });

  it('the shared media list names the sender and the time, but keeps channel authors hidden', async () => {
    const sharp = (await import('sharp')).default;
    const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 10, g: 90, b: 200 } } })
      .png()
      .toBuffer();
    const boundary = '----m';
    const upload = async (c: Client) => {
      const r = await app.inject({
        method: 'POST',
        url: '/api/files',
        payload: Buffer.concat([
          Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="p.png"\r\nContent-Type: image/png\r\n\r\n`),
          png,
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
        headers: { cookie: c.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      });
      expect(r.statusCode).toBe(200);
      return JSON.parse(r.body).id as string;
    };

    // a private chat: both sides see who sent it
    const pm = (await owner.req('POST', '/api/chats/private', { userId: sub.id })).body;
    await owner.req('POST', `/api/chats/${pm.id}/messages`, { fileIds: [await upload(owner)] });
    const priv = (await sub.req('GET', `/api/chats/${pm.id}/media?kind=media`)).body;
    expect(priv).toHaveLength(1);
    expect(priv[0]).toMatchObject({ senderId: owner.id });
    expect(typeof priv[0].createdAt).toBe('number');
    // a reply to the photo carries a small picture of it; a reply to text does not
    const photoMsg = (await sub.req('GET', `/api/chats/${pm.id}/messages`)).body.at(-1);
    const toPhoto = (await sub.req('POST', `/api/chats/${pm.id}/messages`, { text: 'красиво', replyToId: photoMsg.id })).body;
    expect(toPhoto.replyTo.thumb).toMatchObject({ fileId: photoMsg.attachments[0].id });
    expect(toPhoto.replyTo.text).toBe('Фото');
    const toText = (await owner.req('POST', `/api/chats/${pm.id}/messages`, { text: 'спасибо', replyToId: toPhoto.id })).body;
    expect(toText.replyTo.thumb).toBeNull();

    // a channel: subscribers do not learn who posted, the author does
    const ch = (await owner.req('POST', '/api/chats/channel', { title: 'Pics', isPublic: true, publicUsername: 'picschan' })).body;
    await sub.req('POST', `/api/chats/${ch.id}/join`);
    await owner.req('POST', `/api/chats/${ch.id}/messages`, { fileIds: [await upload(owner)] });
    expect((await sub.req('GET', `/api/chats/${ch.id}/media?kind=media`)).body[0].senderId).toBeNull();
    expect((await owner.req('GET', `/api/chats/${ch.id}/media?kind=media`)).body[0].senderId).toBe(owner.id);
  });

  it('only admins post, authors are hidden, subscribers are hidden', async () => {
    const c = await owner.req('POST', '/api/chats/channel', {
      title: 'News',
      isPublic: true,
      publicUsername: 'newschan',
    });
    expect(c.status).toBe(200);
    expect(c.body.type).toBe('channel');
    const id = c.body.id;

    // found in search and joinable
    const found = await sub.req('GET', '/api/search?q=newsch');
    expect(found.body.groups.map((x: { id: number }) => x.id)).toContain(id);
    const joined = await sub.req('POST', `/api/chats/${id}/join`);
    expect(joined.status).toBe(200);
    expect(joined.body.me.canSend).toBe(false);
    expect(joined.body.me.canSeeMembers).toBe(false);

    // subscriber cannot post, see members or create polls
    expect((await sub.req('POST', `/api/chats/${id}/messages`, { text: 'spam' })).status).toBe(403);
    expect((await sub.req('GET', `/api/chats/${id}/members`)).status).toBe(403);
    expect(
      (await sub.req('POST', `/api/chats/${id}/polls`, { question: 'q', options: ['a', 'b'] })).status,
    ).toBe(403);
    expect((await owner.req('GET', `/api/chats/${id}/members`)).body).toHaveLength(2);

    // post: author visible only to themself
    const post = await owner.req('POST', `/api/chats/${id}/messages`, { text: 'hello' });
    expect(post.body.senderId).toBe(owner.id);
    expect(post.body.views).toBe(1);
    const seen = (await sub.req('GET', `/api/chats/${id}/messages`)).body as { text: string; senderId: number | null }[];
    const msg = seen.find((m) => m.text === 'hello')!;
    expect(msg.senderId).toBeNull();

    // no "joined" service messages in channels
    expect(seen.filter((m) => m.text.includes('вбежал'))).toHaveLength(0);

    // signatures
    await owner.req('PATCH', `/api/chats/${id}`, { signMessages: true });
    await owner.req('POST', `/api/chats/${id}/messages`, { text: 'signed' });
    const list = (await sub.req('GET', `/api/chats/${id}/messages`)).body as { text: string; signature: string | null }[];
    expect(list.find((m) => m.text === 'signed')!.signature).toBe('chowner');

    // forwarding shows the channel, not the admin
    const pm = await sub.req('POST', '/api/chats/private', { userId: other.id });
    const fwd = await sub.req('POST', '/api/messages/forward', { ids: [post.body.id], fromChatId: id, toChatId: pm.body.id });
    expect(fwd.body[0].forwardedFrom.name).toBe('News');
    // «hide sender» sends a plain copy, also of an already forwarded message
    const copy = await sub.req('POST', '/api/messages/forward', { ids: [post.body.id], fromChatId: id, toChatId: pm.body.id, hideSender: true });
    expect(copy.body[0].forwardedFrom).toBeNull();
    const copy2 = await sub.req('POST', '/api/messages/forward', { ids: [fwd.body[0].id], fromChatId: pm.body.id, toChatId: pm.body.id, hideSender: true });
    expect(copy2.body[0].forwardedFrom).toBeNull();

    // an admin with post rights can write, without it cannot
    await owner.req('POST', `/api/chats/${id}/members`, { userIds: [other.id] });
    await owner.req('PATCH', `/api/chats/${id}/members/${other.id}`, {
      role: 'admin',
      rights: {
        changeInfo: false, deleteMessages: false, banUsers: false, inviteUsers: false,
        pinMessages: false, addAdmins: false, postMessages: false, editMessages: false,
      },
    });
    expect((await other.req('POST', `/api/chats/${id}/messages`, { text: 'x' })).status).toBe(403);
    expect((await other.req('GET', `/api/chats/${id}/members`)).status).toBe(200);
    await owner.req('PATCH', `/api/chats/${id}/members/${other.id}`, {
      role: 'admin',
      rights: {
        changeInfo: false, deleteMessages: false, banUsers: false, inviteUsers: false,
        pinMessages: false, addAdmins: false, postMessages: true, editMessages: true,
      },
    });
    expect((await other.req('POST', `/api/chats/${id}/messages`, { text: 'by other' })).status).toBe(200);
    // editMessages lets an admin edit someone else's post
    expect((await other.req('PATCH', `/api/messages/${post.body.id}`, { text: 'edited' })).status).toBe(200);
  });

  it('private channels are invite-only, the global admin sees everything', async () => {
    const c = (await owner.req('POST', '/api/chats/channel', { title: 'Secret' })).body;
    expect((await other.req('GET', `/api/chats/${c.id}`)).status).toBe(403);
    expect((await other.req('POST', `/api/chats/${c.id}/join`)).status).toBe(403);
    // subscribers do not get the invite link
    const token = c.inviteToken;
    expect(token).toBeTruthy();
    const preview = await other.req('GET', `/api/invite/${token}`);
    expect(preview.body.type).toBe('channel');
    const joined = (await other.req('POST', `/api/invite/${token}`)).body;
    expect(joined.inviteToken).toBeNull();

    const admin = await adminClient();
    const view = await admin.req('GET', `/api/chats/${c.id}`);
    expect(view.status).toBe(200);
    expect(view.body.me.canSend).toBe(true);
    expect((await admin.req('GET', `/api/chats/${c.id}/members`)).status).toBe(200);
    expect((await admin.req('POST', `/api/chats/${c.id}/messages`, { text: 'from god' })).status).toBe(200);
    const groups = (await admin.req('GET', '/api/admin/groups?q=Secret')).body as { id: number; type: string }[];
    expect(groups.find((g) => g.id === c.id)?.type).toBe('channel');
    expect((await admin.req('POST', `/api/chats/${c.id}/members/${other.id}/kick`)).status).toBe(200);
    expect((await admin.req('DELETE', `/api/chats/${c.id}`)).status).toBe(200);
  });

  it('notifications can be muted per chat', async () => {
    const pm = (await owner.req('POST', '/api/chats/private', { userId: sub.id })).body;
    const r = await sub.req('POST', `/api/chats/${pm.id}/notifications`, { muted: true });
    expect(r.body.me.notificationsMuted).toBe(true);
    const again = await sub.req('GET', `/api/chats/${pm.id}`);
    expect(again.body.me.notificationsMuted).toBe(true);
    // for good: no end time
    expect(again.body.me.notificationsMutedUntil).toBeNull();
  });

  it('notifications can be muted for a while, and come back on their own', async () => {
    const { db } = await import('../src/db.js');
    const pm = (await owner.req('POST', '/api/chats/private', { userId: sub.id })).body;
    const hour = await sub.req('POST', `/api/chats/${pm.id}/notifications`, { muted: true, seconds: 3600 });
    expect(hour.body.me.notificationsMuted).toBe(true);
    expect(hour.body.me.notificationsMutedUntil).toBeGreaterThan(Date.now() + 3500_000);
    expect(hour.body.me.notificationsMutedUntil).toBeLessThan(Date.now() + 3700_000);

    // the time passes: the chat is loud again, no request needed
    db.prepare('UPDATE chat_members SET notify_muted_until = ? WHERE chat_id = ? AND user_id = ?').run(Date.now() - 1, pm.id, sub.id);
    const expired = (await sub.req('GET', `/api/chats/${pm.id}`)).body;
    expect(expired.me.notificationsMuted).toBe(false);
    expect(expired.me.notificationsMutedUntil).toBeNull();

    // unmuting clears the end time; a nonsense duration is refused
    await sub.req('POST', `/api/chats/${pm.id}/notifications`, { muted: true, seconds: 3600 });
    const off = await sub.req('POST', `/api/chats/${pm.id}/notifications`, { muted: false });
    expect(off.body.me.notificationsMuted).toBe(false);
    expect(off.body.me.notificationsMutedUntil).toBeNull();
    expect((await sub.req('POST', `/api/chats/${pm.id}/notifications`, { muted: true, seconds: 5 })).status).toBe(400);
    expect((await sub.req('POST', `/api/chats/${pm.id}/notifications`, { muted: true, seconds: -3600 })).status).toBe(400);
  });

  it('a new message brings an archived chat back only once its timed mute is over', async () => {
    const { db } = await import('../src/db.js');
    const pm = (await owner.req('POST', '/api/chats/private', { userId: sub.id })).body;
    await sub.req('POST', `/api/chats/${pm.id}/archive`, { archived: true });
    await sub.req('POST', `/api/chats/${pm.id}/notifications`, { muted: true, seconds: 3600 });
    await owner.req('POST', `/api/chats/${pm.id}/messages`, { text: 'psst' });
    expect((await sub.req('GET', `/api/chats/${pm.id}`)).body.archived).toBe(true);

    db.prepare('UPDATE chat_members SET notify_muted_until = ? WHERE chat_id = ? AND user_id = ?').run(Date.now() - 1, pm.id, sub.id);
    await owner.req('POST', `/api/chats/${pm.id}/messages`, { text: 'again' });
    expect((await sub.req('GET', `/api/chats/${pm.id}`)).body.archived).toBe(false);
  });
});

describe('polls', () => {
  let a: Client;
  let b: Client;
  let groupId: number;

  beforeAll(async () => {
    a = await register('polla');
    b = await register('pollb');
    groupId = (await a.req('POST', '/api/chats/group', { title: 'Poll group', memberIds: [b.id] })).body.id;
  });

  it('validates polls', async () => {
    const one = await a.req('POST', `/api/chats/${groupId}/polls`, { question: 'q', options: ['a'] });
    expect(one.status).toBe(400);
    const dup = await a.req('POST', `/api/chats/${groupId}/polls`, { question: 'q', options: ['a', 'A'] });
    expect(dup.status).toBe(400);
    const quiz = await a.req('POST', `/api/chats/${groupId}/polls`, { question: 'q', options: ['a', 'b'], quiz: true });
    expect(quiz.status).toBe(400);
  });

  it('votes, retracts, shows voters of public polls', async () => {
    const p = await a.req('POST', `/api/chats/${groupId}/polls`, {
      question: 'Lunch?',
      options: ['Pizza', 'Sushi', 'Soup'],
      anonymous: false,
      multiple: true,
    });
    expect(p.status).toBe(200);
    expect(p.body.kind).toBe('poll');
    expect(p.body.poll.myVotes).toEqual([]);
    const mid = p.body.id;

    const v = await b.req('POST', `/api/messages/${mid}/vote`, { options: [0, 2] });
    expect(v.body.myVotes).toEqual([0, 2]);
    expect(v.body.totalVoters).toBe(1);
    await a.req('POST', `/api/messages/${mid}/vote`, { options: [0] });

    const list = (await a.req('GET', `/api/chats/${groupId}/messages`)).body as { id: number; poll: any }[];
    const poll = list.find((m) => m.id === mid)!.poll;
    expect(poll.options.map((o: { voters: number }) => o.voters)).toEqual([2, 0, 1]);
    expect(poll.totalVoters).toBe(2);
    expect(poll.myVotes).toEqual([0]);

    const voters = (await a.req('GET', `/api/messages/${mid}/poll/voters`)).body;
    expect(voters[0].users.map((u: { id: number }) => u.id).sort()).toEqual([a.id, b.id].sort());

    // retract
    const r = await b.req('POST', `/api/messages/${mid}/vote`, { options: [] });
    expect(r.body.myVotes).toEqual([]);
    expect(r.body.totalVoters).toBe(1);

    // polls cannot be edited
    expect((await a.req('PATCH', `/api/messages/${mid}`, { text: 'x' })).status).toBe(403);

    // only author/admins stop polls
    expect((await b.req('POST', `/api/messages/${mid}/poll/stop`)).status).toBe(403);
    expect((await a.req('POST', `/api/messages/${mid}/poll/stop`)).body.closed).toBe(true);
    expect((await b.req('POST', `/api/messages/${mid}/vote`, { options: [1] })).status).toBe(400);
  });

  it('anonymous single-choice polls and quizzes', async () => {
    const p = (await a.req('POST', `/api/chats/${groupId}/polls`, { question: 'Anon', options: ['x', 'y'] })).body;
    expect(p.poll.anonymous).toBe(true);
    expect((await b.req('POST', `/api/messages/${p.id}/vote`, { options: [0, 1] })).status).toBe(400);
    expect((await a.req('GET', `/api/messages/${p.id}/poll/voters`)).status).toBe(403);

    const q = (
      await a.req('POST', `/api/chats/${groupId}/polls`, {
        question: '2+2?',
        options: ['3', '4'],
        quiz: true,
        correctOption: 1,
        explanation: 'math',
      })
    ).body;
    // the answer is hidden before voting
    const before = (await b.req('GET', `/api/chats/${groupId}/messages`)).body.find((m: { id: number }) => m.id === q.id);
    expect(before.poll.correctOption).toBeUndefined();
    const voted = (await b.req('POST', `/api/messages/${q.id}/vote`, { options: [0] })).body;
    expect(voted.correctOption).toBe(1);
    expect(voted.explanation).toBe('math');
    // quiz answers are final
    expect((await b.req('POST', `/api/messages/${q.id}/vote`, { options: [1] })).status).toBe(400);
  });

  it('forwarded polls share votes; polls close by time', async () => {
    const p = (await a.req('POST', `/api/chats/${groupId}/polls`, { question: 'Shared', options: ['1', '2'] })).body;
    const pm = (await a.req('POST', '/api/chats/private', { userId: b.id })).body;
    const fwd = (await a.req('POST', '/api/messages/forward', { ids: [p.id], fromChatId: groupId, toChatId: pm.id })).body;
    expect(fwd[0].poll.id).toBe(p.poll.id);
    await b.req('POST', `/api/messages/${fwd[0].id}/vote`, { options: [1] });
    const orig = (await a.req('GET', `/api/chats/${groupId}/messages`)).body.find((m: { id: number }) => m.id === p.id);
    expect(orig.poll.totalVoters).toBe(1);

    const timed = (
      await a.req('POST', `/api/chats/${groupId}/polls`, { question: 'Timed', options: ['1', '2'], closePeriod: 60 })
    ).body;
    expect(timed.poll.closeAt).toBeGreaterThan(Date.now());
    const { db } = await import('../src/db.js');
    db.prepare('UPDATE polls SET close_at = ? WHERE id = ?').run(Date.now() - 1, timed.poll.id);
    expect((await b.req('POST', `/api/messages/${timed.id}/vote`, { options: [0] })).status).toBe(400);
    const after = (await a.req('GET', `/api/chats/${groupId}/messages`)).body.find((m: { id: number }) => m.id === timed.id);
    expect(after.poll.closed).toBe(true);
  });

  it('group permission can forbid polls', async () => {
    await a.req('PATCH', `/api/chats/${groupId}`, {
      defaultPermissions: { sendMessages: true, sendMedia: true, sendPolls: false, inviteUsers: true, pinMessages: false },
    });
    expect((await b.req('POST', `/api/chats/${groupId}/polls`, { question: 'q', options: ['a', 'b'] })).status).toBe(403);
    expect((await a.req('POST', `/api/chats/${groupId}/polls`, { question: 'q', options: ['a', 'b'] })).status).toBe(200);
  });
});

describe('push', () => {
  it('exposes the VAPID key and stores subscriptions per session', async () => {
    const u = await register('pushuser');
    const key = await u.req('GET', '/api/push/key');
    expect(key.body.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    const sub = {
      endpoint: 'https://push.example.com/abc',
      keys: { p256dh: 'BKey', auth: 'auth' },
    };
    expect((await u.req('POST', '/api/push/subscribe', sub)).status).toBe(200);
    const { db } = await import('../src/db.js');
    const count = () => (db.prepare('SELECT COUNT(*) c FROM push_subscriptions WHERE user_id = ?').get(u.id) as { c: number }).c;
    expect(count()).toBe(1);
    await u.req('POST', '/api/auth/logout');
    expect(count()).toBe(0);
  });
});

describe('pwa', () => {
  it('renders png icons', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/icon/192' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('image/png');
    expect((await app.inject({ method: 'GET', url: '/api/icon/7' })).statusCode).toBe(404);
  });
});

describe('reactions', () => {
  it('one reaction per user, switchable, can be turned off; anonymous in channels', async () => {
    const a = await register('reacta');
    const b = await register('reactb');
    const g = (await a.req('POST', '/api/chats/group', { title: 'R', memberIds: [b.id] })).body;
    const m = (await a.req('POST', `/api/chats/${g.id}/messages`, { text: 'react me' })).body;

    const r1 = await b.req('POST', `/api/messages/${m.id}/reaction`, { emoji: '👍' });
    expect(r1.body).toEqual([expect.objectContaining({ emoji: '👍', count: 1, mine: true })]);
    await a.req('POST', `/api/messages/${m.id}/reaction`, { emoji: '👍' });
    // switching replaces the previous reaction
    const r2 = await b.req('POST', `/api/messages/${m.id}/reaction`, { emoji: '🔥' });
    expect(r2.body.map((x: { emoji: string; count: number }) => [x.emoji, x.count])).toEqual([
      ['👍', 1],
      ['🔥', 1],
    ]);
    expect((await b.req('POST', `/api/messages/${m.id}/reaction`, { emoji: 'not-an-emoji' })).status).toBe(400);

    const list = (await a.req('GET', `/api/chats/${g.id}/messages`)).body.find((x: { id: number }) => x.id === m.id);
    expect(list.reactions.find((x: { emoji: string }) => x.emoji === '👍').mine).toBe(true);
    expect(list.reactions.find((x: { emoji: string }) => x.emoji === '🔥').recent[0].id).toBe(b.id);
    const who = (await a.req('GET', `/api/messages/${m.id}/reactions`)).body;
    expect(who).toHaveLength(2);

    const del = await b.req('DELETE', `/api/messages/${m.id}/reaction`);
    expect(del.body).toHaveLength(1);

    await a.req('PATCH', `/api/chats/${g.id}`, { reactionsEnabled: false });
    expect((await b.req('POST', `/api/messages/${m.id}/reaction`, { emoji: '👍' })).status).toBe(403);

    const c = (await a.req('POST', '/api/chats/channel', { title: 'RC', memberIds: [b.id] })).body;
    const post = (await a.req('POST', `/api/chats/${c.id}/messages`, { text: 'post' })).body;
    await b.req('POST', `/api/messages/${post.id}/reaction`, { emoji: '❤️' });
    const seen = (await a.req('GET', `/api/chats/${c.id}/messages`)).body.find((x: { id: number }) => x.id === post.id);
    expect(seen.reactions[0]).toMatchObject({ emoji: '❤️', count: 1, recent: [] });
    expect((await a.req('GET', `/api/messages/${post.id}/reactions`)).status).toBe(403);
  });
});

describe('replies', () => {
  it('quotes the answered message without its markers and keeps a spoiler hidden', async () => {
    const a = await register('quote_a');
    const b = await register('quote_b');
    const chat = (await a.req('POST', '/api/chats/private', { userId: b.id })).body;
    const first = (await a.req('POST', `/api/chats/${chat.id}/messages`, { text: '**Жирный** и\n||тайна||' })).body;
    const reply = (await b.req('POST', `/api/chats/${chat.id}/messages`, { text: 'ок', replyToId: first.id })).body;
    expect(reply.replyTo.text).toBe('Жирный и ▒▒▒▒▒');
    const long = (await a.req('POST', `/api/chats/${chat.id}/messages`, { text: 'а'.repeat(1000) })).body;
    const r2 = (await b.req('POST', `/api/chats/${chat.id}/messages`, { text: 'да', replyToId: long.id })).body;
    expect(r2.replyTo.text.length).toBeLessThanOrEqual(201);
  });

  it('a pinned message is quoted without markers and its spoiler stays hidden, once', async () => {
    const a = await register('pinq_a');
    const b = await register('pinq_b');
    const g = (await a.req('POST', '/api/chats/group', { title: 'P', memberIds: [b.id] })).body;
    const m = (await a.req('POST', `/api/chats/${g.id}/messages`, { text: '**Итог:** ||секрет||' })).body;
    await a.req('POST', `/api/chats/${g.id}/pins`, { messageId: m.id, pinned: true });
    await a.req('POST', `/api/chats/${g.id}/pins`, { messageId: m.id, pinned: true });
    const service = (await b.req('GET', `/api/chats/${g.id}/messages`)).body.filter((x: { kind: string; text: string }) => x.kind === 'service' && x.text.includes('закрепил'));
    expect(service).toHaveLength(1);
    expect(service[0].text).toContain('«Итог: ▒▒▒▒▒▒»');
    expect(service[0].text).not.toContain('секрет');
  });
});

describe('mentions', () => {
  it('tracks @mentions and replies as unread mentions', async () => {
    const a = await register('menta');
    const b = await register('mentb');
    const c = await register('mentc');
    const g = (await a.req('POST', '/api/chats/group', { title: 'M', memberIds: [b.id, c.id] })).body;
    const m1 = (await a.req('POST', `/api/chats/${g.id}/messages`, { text: 'hi @MentB and @nobodyhere' })).body;
    const own = (await b.req('POST', `/api/chats/${g.id}/messages`, { text: 'my message' })).body;
    const m2 = (await c.req('POST', `/api/chats/${g.id}/messages`, { text: 'reply', replyToId: own.id })).body;
    // an email-like string is not a mention
    await a.req('POST', `/api/chats/${g.id}/messages`, { text: 'mail me: x@mentb' });

    let chat = (await b.req('GET', `/api/chats/${g.id}`)).body;
    // b's own message moved b's read pointer past m1, so only the reply is unread
    expect(chat.unreadMentions).toEqual([m2.id]);
    const cChat = (await c.req('GET', `/api/chats/${g.id}`)).body;
    expect(cChat.unreadMentions).toEqual([]);

    const x = (await c.req('POST', `/api/chats/${g.id}/messages`, { text: '@mentb look' })).body;
    chat = (await b.req('GET', `/api/chats/${g.id}`)).body;
    expect(chat.unreadMentions).toEqual([m2.id, x.id]);
    await b.req('POST', `/api/chats/${g.id}/read`, { messageId: x.id });
    expect((await b.req('GET', `/api/chats/${g.id}`)).body.unreadMentions).toEqual([]);
    expect(m1.id).toBeLessThan(own.id);
  });
});

describe('read receipts', () => {
  it('lists who read your message in a small group', async () => {
    const a = await register('reada');
    const b = await register('readb');
    const c = await register('readc');
    const g = (await a.req('POST', '/api/chats/group', { title: 'Read', memberIds: [b.id, c.id] })).body;
    const m = (await a.req('POST', `/api/chats/${g.id}/messages`, { text: 'read me' })).body;
    expect((await a.req('GET', `/api/messages/${m.id}/readers`)).body).toEqual([]);
    await b.req('POST', `/api/chats/${g.id}/read`, { messageId: m.id });
    const readers = (await a.req('GET', `/api/messages/${m.id}/readers`)).body;
    expect(readers.map((r: { user: { id: number } }) => r.user.id)).toEqual([b.id]);
    expect(readers[0].readAt).toBeGreaterThan(0);
    // only the author may ask, and only in groups
    expect((await b.req('GET', `/api/messages/${m.id}/readers`)).status).toBe(403);
    const pm = (await a.req('POST', '/api/chats/private', { userId: b.id })).body;
    const pmsg = (await a.req('POST', `/api/chats/${pm.id}/messages`, { text: 'x' })).body;
    expect((await a.req('GET', `/api/messages/${pmsg.id}/readers`)).status).toBe(403);
  });
});

describe('message search', () => {
  it('finds messages by word prefix, case-insensitively, in one chat or everywhere', async () => {
    const a = await register('searcha');
    const b = await register('searchb');
    const outsider = await register('searchc');
    const g = (await a.req('POST', '/api/chats/group', { title: 'S', memberIds: [b.id] })).body;
    const pm = (await a.req('POST', '/api/chats/private', { userId: b.id })).body;
    const m1 = (await a.req('POST', `/api/chats/${g.id}/messages`, { text: 'Привет, МИР! Как дела?' })).body;
    await a.req('POST', `/api/chats/${g.id}/messages`, { text: 'совсем другое' });
    const m3 = (await b.req('POST', `/api/chats/${pm.id}/messages`, { text: 'мирный договор' })).body;

    const inChat = (await b.req('GET', `/api/chats/${g.id}/search?q=${encodeURIComponent('мир')}`)).body;
    expect(inChat.messages.map((m: { id: number }) => m.id)).toEqual([m1.id]);
    const both = (await b.req('GET', `/api/chats/${g.id}/search?q=${encodeURIComponent('привет мир')}`)).body;
    expect(both.messages).toHaveLength(1);

    const all = (await a.req('GET', `/api/search/messages?q=${encodeURIComponent('МИР')}`)).body;
    expect(all.messages.map((m: { id: number }) => m.id)).toEqual([m3.id, m1.id]);
    // strangers see nothing, edited text is re-indexed, junk queries are harmless
    expect((await outsider.req('GET', `/api/search/messages?q=${encodeURIComponent('мир')}`)).body.messages).toEqual([]);
    expect((await outsider.req('GET', `/api/chats/${g.id}/search?q=x`)).status).toBe(403);
    await a.req('PATCH', `/api/messages/${m1.id}`, { text: 'Пока' });
    expect((await a.req('GET', `/api/chats/${g.id}/search?q=${encodeURIComponent('привет')}`)).body.messages).toEqual([]);
    expect((await a.req('GET', `/api/search/messages?q=${encodeURIComponent('" OR * (')}`)).status).toBe(200);
  });

  it('loads a window around a message or a date', async () => {
    const a = await register('arounda');
    const pm = (await a.req('POST', '/api/chats/private', { userId: a.id })).body;
    const ids: number[] = [];
    for (let i = 0; i < 30; i++) ids.push((await a.req('POST', `/api/chats/${pm.id}/messages`, { text: `n${i}` })).body.id);
    const win = (await a.req('GET', `/api/chats/${pm.id}/messages?around=${ids[10]}&limit=10`)).body as { id: number }[];
    expect(win.map((m) => m.id)).toEqual(ids.slice(5, 16));
    const future = (await a.req('GET', `/api/chats/${pm.id}/messages?date=${Date.now() + 86400_000}&limit=5`)).body;
    expect(future.map((m: { id: number }) => m.id)).toEqual(ids.slice(25));
    const past = (await a.req('GET', `/api/chats/${pm.id}/messages?date=1&limit=4`)).body;
    expect(past[0].id).toBe(ids[0]);
  });
});

describe('pinned chats, archive, folders', () => {
  it('pins up to 5 chats, archives and brings chats back on new messages', async () => {
    const a = await register('pina');
    const peers = [];
    for (let i = 0; i < 6; i++) peers.push(await register(`pinpeer${i}`));
    const chats = [];
    for (const p of peers) chats.push((await a.req('POST', '/api/chats/private', { userId: p.id })).body);
    for (let i = 0; i < 5; i++) {
      const r = await a.req('POST', `/api/chats/${chats[i].id}/pin`, { pinned: true });
      expect(r.body.pinnedAt).toBeGreaterThan(0);
    }
    expect((await a.req('POST', `/api/chats/${chats[5].id}/pin`, { pinned: true })).status).toBe(400);
    await a.req('POST', `/api/chats/${chats[0].id}/pin`, { pinned: false });
    expect((await a.req('POST', `/api/chats/${chats[5].id}/pin`, { pinned: true })).status).toBe(200);

    // archive unpins; a new message unarchives unless muted
    const arch = (await a.req('POST', `/api/chats/${chats[1].id}/archive`, { archived: true })).body;
    expect(arch.archived).toBe(true);
    expect(arch.pinnedAt).toBeNull();
    await peers[1].req('POST', `/api/chats/${chats[1].id}/messages`, { text: 'hey' });
    expect((await a.req('GET', `/api/chats/${chats[1].id}`)).body.archived).toBe(false);

    await a.req('POST', `/api/chats/${chats[2].id}/archive`, { archived: true });
    await a.req('POST', `/api/chats/${chats[2].id}/notifications`, { muted: true });
    await peers[2].req('POST', `/api/chats/${chats[2].id}/messages`, { text: 'hey' });
    expect((await a.req('GET', `/api/chats/${chats[2].id}`)).body.archived).toBe(true);
  });

  it('puts the pinned chats in a new order, a part of them at a time', async () => {
    const a = await register('pinorder');
    const peers = [];
    for (let i = 0; i < 4; i++) peers.push(await register(`pinorderpeer${i}`));
    const chats = [];
    for (const p of peers) chats.push((await a.req('POST', '/api/chats/private', { userId: p.id })).body);
    for (const c of chats) await a.req('POST', `/api/chats/${c.id}/pin`, { pinned: true });
    const onTop = async () =>
      ((await a.req('GET', '/api/chats')).body as { id: number; pinnedAt: number | null }[])
        .filter((c) => c.pinnedAt)
        .sort((x, y) => y.pinnedAt! - x.pinnedAt!)
        .map((c) => c.id);
    // pinned last is on top: 3, 2, 1, 0
    expect(await onTop()).toEqual([chats[3].id, chats[2].id, chats[1].id, chats[0].id]);
    const ids = [chats[0].id, chats[1].id, chats[2].id, chats[3].id];
    const r = await a.req('POST', '/api/chats/pins/order', { ids });
    expect(r.status).toBe(200);
    expect(r.body.map((c: { id: number }) => c.id)).toEqual(ids);
    expect(await onTop()).toEqual(ids);
    // a part of them swap places, the others stay where they are
    expect((await a.req('POST', '/api/chats/pins/order', { ids: [chats[3].id, chats[1].id] })).status).toBe(200);
    expect(await onTop()).toEqual([chats[0].id, chats[3].id, chats[2].id, chats[1].id]);
    // not pinned, twice in a list, somebody else's: no
    await a.req('POST', `/api/chats/${chats[0].id}/pin`, { pinned: false });
    expect((await a.req('POST', '/api/chats/pins/order', { ids: [chats[0].id, chats[1].id] })).status).toBe(400);
    expect((await a.req('POST', '/api/chats/pins/order', { ids: [chats[1].id, chats[1].id] })).status).toBe(400);
    const other = await register('pinorderother');
    expect((await other.req('POST', '/api/chats/pins/order', { ids: [chats[1].id] })).status).toBe(400);
    expect((await a.req('POST', '/api/chats/pins/order', { ids: [] })).status).toBe(400);
  });

  it('manages folders', async () => {
    const a = await register('folda');
    const b = await register('foldb');
    expect((await a.req('GET', '/api/folders')).body).toEqual([]);
    const created = (await a.req('POST', '/api/folders', { title: 'Личные', filters: { private: true } })).body;
    expect(created[0]).toMatchObject({ title: 'Личные', filters: { private: true, groups: false, excludeArchived: true } });
    const list = (await a.req('POST', '/api/folders', { title: 'Работа', includeIds: [1, 2] })).body;
    expect(list.map((f: { title: string }) => f.title)).toEqual(['Личные', 'Работа']);
    const reordered = (await a.req('PUT', '/api/folders/order', { ids: [list[1].id, list[0].id] })).body;
    expect(reordered.map((f: { title: string }) => f.title)).toEqual(['Работа', 'Личные']);
    const upd = (await a.req('PUT', `/api/folders/${list[1].id}`, { title: 'Дела', excludeIds: [3] })).body;
    expect(upd.find((f: { id: number }) => f.id === list[1].id)).toMatchObject({ title: 'Дела', excludeIds: [3], includeIds: [] });
    // someone else's folder is not found
    expect((await b.req('DELETE', `/api/folders/${list[0].id}`)).status).toBe(404);
    expect((await a.req('DELETE', `/api/folders/${list[0].id}`)).body).toHaveLength(1);
    expect((await a.req('POST', '/api/folders', { title: '' })).status).toBe(400);
  });
});

describe('blocking and privacy', () => {
  it('blocks private messages both ways and hides the blocker', async () => {
    const a = await register('blocka');
    const b = await register('blockb');
    const pm = (await a.req('POST', '/api/chats/private', { userId: b.id })).body;
    expect((await a.req('POST', `/api/users/${b.id}/block`)).status).toBe(200);
    expect((await a.req('GET', `/api/users/${b.id}`)).body.blockedByMe).toBe(true);
    expect((await a.req('GET', `/api/chats/${pm.id}`)).body.peerBlocked).toBe(true);

    const fromB = await b.req('POST', `/api/chats/${pm.id}/messages`, { text: 'hi' });
    expect(fromB.status).toBe(403);
    expect(fromB.body.error).toBe('blocked_by_user');
    expect((await a.req('POST', `/api/chats/${pm.id}/messages`, { text: 'hi' })).body.error).toBe('you_blocked');
    // the blocked user sees no avatar / last seen
    const seen = (await b.req('GET', `/api/users/${a.id}`)).body;
    expect(seen.lastSeenApprox).toBe('long');
    expect(seen.online).toBe(false);
    // and cannot add the blocker to groups
    const g = (await b.req('POST', '/api/chats/group', { title: 'x', memberIds: [a.id] })).body;
    expect(g.memberCount).toBe(1);
    expect((await b.req('POST', `/api/chats/${g.id}/members`, { userIds: [a.id] })).body).toEqual({ added: 0, restricted: 1 });

    expect((await a.req('GET', '/api/me/blocks')).body.map((u: { id: number }) => u.id)).toEqual([b.id]);
    await a.req('DELETE', `/api/users/${b.id}/block`);
    expect((await b.req('POST', `/api/chats/${pm.id}/messages`, { text: 'hi' })).status).toBe(200);
  });

  it('applies privacy settings', async () => {
    const a = await register('priva');
    const b = await register('privb');
    const me = (await a.req('PUT', '/api/me/privacy', { lastSeen: 'nobody', groupInvites: 'nobody', avatar: 'nobody' })).body;
    expect(me.privacy).toEqual({ lastSeen: 'nobody', avatar: 'nobody', groupInvites: 'nobody', phone: 'nobody' });
    // the user still sees their own data
    expect((await a.req('GET', '/api/auth/me')).body.lastSeenApprox).toBeNull();
    const seen = (await b.req('GET', `/api/users/${a.id}`)).body;
    expect(seen.lastSeenAt).toBeNull();
    expect(seen.lastSeenApprox).toBe('recently');
    const found = (await b.req('GET', '/api/search?q=priva')).body.users.find((u: { id: number }) => u.id === a.id);
    expect(found.lastSeenAt).toBeNull();
    const g = (await b.req('POST', '/api/chats/group', { title: 'y' })).body;
    expect((await b.req('POST', `/api/chats/${g.id}/members`, { userIds: [a.id] })).body.restricted).toBe(1);
    // joining by link is still possible
    expect((await a.req('POST', `/api/invite/${g.inviteToken}`)).status).toBe(200);
    expect((await a.req('PUT', '/api/me/privacy', { lastSeen: 'maybe' })).status).toBe(400);
  });
});

describe('voice messages', () => {
  it('stores voice notes with duration and waveform, round videos as their own kind', async () => {
    const a = await register('voicea');
    const boundary = '----v';
    const wave = JSON.stringify(Array.from({ length: 48 }, (_, i) => i % 32));
    const field = (name: string, value: string) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    const upload = (as: string, mime: string, extra: string) =>
      app.inject({
        method: 'POST',
        url: '/api/files',
        payload: Buffer.concat([
          Buffer.from(field('as', as) + extra),
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="rec"\r\nContent-Type: ${mime}\r\n\r\n`,
          ),
          Buffer.from('fake-media'),
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
        headers: { cookie: a.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      });

    const v = JSON.parse((await upload('voice', 'audio/webm;codecs=opus', field('duration', '3.4') + field('waveform', wave))).body);
    expect(v).toMatchObject({ kind: 'voice', mime: 'audio/webm', duration: 3.4 });
    expect(v.waveform).toHaveLength(48);
    const r = JSON.parse((await upload('round', 'video/mp4', field('duration', '999'))).body);
    expect(r).toMatchObject({ kind: 'round', duration: 60 });
    // audio without "as" is an ordinary file
    expect(JSON.parse((await upload('', 'audio/mpeg', '')).body).kind).toBe('file');

    const pm = (await a.req('POST', '/api/chats/private', { userId: a.id })).body;
    const m = (await a.req('POST', `/api/chats/${pm.id}/messages`, { fileIds: [v.id] })).body;
    expect(m.attachments[0].kind).toBe('voice');
    const tab = (await a.req('GET', `/api/chats/${pm.id}/media?kind=voice`)).body;
    expect(tab.map((x: { file: { id: string } }) => x.file.id)).toEqual([v.id]);
  });
});

describe('channel comments', () => {
  it('lets subscribers discuss posts without touching the main feed', async () => {
    const owner = await register('comowner');
    const sub = await register('comsub');
    const stranger = await register('comstranger');
    const c = (await owner.req('POST', '/api/chats/channel', { title: 'Talk', memberIds: [sub.id] })).body;
    expect(c.commentsEnabled).toBe(true);
    const post = (await owner.req('POST', `/api/chats/${c.id}/messages`, { text: 'discuss me' })).body;
    expect(post.commentCount).toBe(0);

    const cm = (await sub.req('POST', `/api/chats/${c.id}/messages`, { text: 'first!', threadId: post.id })).body;
    expect(cm.threadId).toBe(post.id);
    expect(cm.senderId).toBe(sub.id);
    // strangers must subscribe first
    expect((await stranger.req('POST', `/api/chats/${c.id}/messages`, { text: 'x', threadId: post.id })).status).toBe(403);

    // the owner sees the commenter; the feed and counters ignore comments
    const thread = (await owner.req('GET', `/api/chats/${c.id}/threads/${post.id}`)).body;
    expect(thread.map((m: { text: string; sender: { id: number } }) => [m.text, m.sender.id])).toEqual([['first!', sub.id]]);
    const feed = (await sub.req('GET', `/api/chats/${c.id}/messages`)).body as { id: number; commentCount: number; commenters: { id: number }[] }[];
    expect(feed.some((m) => m.id === cm.id)).toBe(false);
    const p = feed.find((m) => m.id === post.id)!;
    expect(p.commentCount).toBe(1);
    expect(p.commenters.map((u) => u.id)).toEqual([sub.id]);
    const ownerChat = (await owner.req('GET', `/api/chats/${c.id}`)).body;
    expect(ownerChat.unreadCount).toBe(0);
    expect(ownerChat.lastMessage.id).toBe(post.id);

    // replies inside the thread count as mentions; subscribers can edit their comments
    const reply = (await owner.req('POST', `/api/chats/${c.id}/messages`, { text: 'thanks', threadId: post.id, replyToId: cm.id })).body;
    expect(reply.replyTo.senderId).toBe(sub.id);
    expect((await sub.req('PATCH', `/api/messages/${cm.id}`, { text: 'first (edited)' })).status).toBe(200);
    expect((await sub.req('GET', `/api/messages/${cm.id}`)).body.text).toBe('first (edited)');

    // comments can be switched off; deleting the post removes its comments
    await owner.req('PATCH', `/api/chats/${c.id}`, { commentsEnabled: false });
    expect((await sub.req('POST', `/api/chats/${c.id}/messages`, { text: 'y', threadId: post.id })).status).toBe(403);
    expect((await sub.req('GET', `/api/chats/${c.id}/messages`)).body.find((m: { id: number }) => m.id === post.id).commentCount).toBeNull();
    await owner.req('POST', '/api/messages/delete', { ids: [post.id], forAll: true });
    expect((await owner.req('GET', `/api/messages/${cm.id}`)).status).toBe(404);
  });
});

describe('app status', () => {
  it('exposes the https address when PUBLIC_URL is set', async () => {
    const before = (await app.inject({ method: 'GET', url: '/api/app/status' })).json();
    expect(before.publicUrl).toBeNull();
    config.publicUrl = 'https://timbagram.duckdns.org';
    const after = (await app.inject({ method: 'GET', url: '/api/app/status' })).json();
    expect(after.publicUrl).toBe('https://timbagram.duckdns.org');
    config.publicUrl = null;
  });
});

describe('admin: user management', () => {
  const cookieOf = (setCookie: unknown, name: string) => {
    const list = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
    const c = list.find((x: string) => x.startsWith(`${name}=`));
    return c ? c.split(';')[0]! : null;
  };
  async function adminClient() {
    const r = await login('admin', 'adminpass');
    return client(String(r.headers['set-cookie']).split(';')[0]!, JSON.parse(r.body).id);
  }

  it('signs in as a user, hides that session from them and returns to the admin', async () => {
    const admin = await adminClient();
    const fred = await register('fred1');
    await admin.req('POST', `/api/admin/users/${fred.id}/ban`, { reason: 'x' });

    const r = await app.inject({ method: 'POST', url: `/api/admin/users/${fred.id}/impersonate`, headers: { cookie: admin.cookie } });
    expect(r.statusCode).toBe(200);
    const session = cookieOf(r.headers['set-cookie'], 'tg_session')!;
    const ret = cookieOf(r.headers['set-cookie'], 'tg_admin_return')!;
    expect(ret.split('=')[1]).toBe(admin.cookie.split('=')[1]);
    const as = await client(`${session}; ${ret}`, fred.id);

    // works even though fred is banned
    const me = await as.req('GET', '/api/auth/me');
    expect(me.body.username).toBe('fred1');
    expect(me.body.impersonator).toBe('admin');
    expect((await as.req('GET', '/api/chats')).status).toBe(200);
    // the admin cannot be impersonated
    expect((await admin.req('POST', `/api/admin/users/${admin.id}/impersonate`)).status).toBe(403);

    // fred does not see the admin's session; the admin does
    await admin.req('POST', `/api/admin/users/${fred.id}/unban`);
    expect((await fred.req('GET', '/api/me/sessions')).body).toHaveLength(1);
    const detail = (await admin.req('GET', `/api/admin/users/${fred.id}`)).body;
    expect(detail.sessions).toHaveLength(2);
    expect(detail.sessions.filter((s: { impersonated: boolean }) => s.impersonated)).toHaveLength(1);

    const back = await app.inject({ method: 'POST', url: '/api/auth/impersonate/return', headers: { cookie: as.cookie } });
    expect(back.statusCode).toBe(200);
    expect(back.json().username).toBe('admin');
    expect(cookieOf(back.headers['set-cookie'], 'tg_session')).toBe(admin.cookie);
    expect((await (await client(session, fred.id)).req('GET', '/api/auth/me')).status).toBe(401);
    expect((await admin.req('GET', `/api/admin/users/${fred.id}`)).body.sessions).toHaveLength(1);

    // ending one session
    const sid = (await admin.req('GET', `/api/admin/users/${fred.id}`)).body.sessions[0].id;
    expect((await admin.req('DELETE', `/api/admin/users/${fred.id}/sessions/${sid}`)).status).toBe(200);
    expect((await fred.req('GET', '/api/chats')).status).toBe(401);
  });

  it('reads private chats and writes on behalf of either member', async () => {
    const admin = await adminClient();
    const gina = await register('gina1');
    const hank = await register('hank1');
    const chat = (await gina.req('POST', '/api/chats/private', { userId: hank.id })).body;
    await gina.req('POST', `/api/chats/${chat.id}/messages`, { text: 'secret' });

    const list = (await admin.req('GET', `/api/admin/chats?q=gina1`)).body;
    expect(list[0].id).toBe(chat.id);
    expect(list[0].members.map((u: { id: number }) => u.id).sort()).toEqual([gina.id, hank.id].sort());
    const msgs = (await admin.req('GET', `/api/admin/chats/${chat.id}/messages`)).body;
    expect(msgs.map((m: { text: string }) => m.text)).toContain('secret');

    const sent = await admin.req('POST', `/api/admin/chats/${chat.id}/messages`, { asUserId: hank.id, text: 'from hank' });
    expect(sent.status).toBe(200);
    expect(sent.body.senderId).toBe(hank.id);
    const seen = (await gina.req('GET', `/api/chats/${chat.id}/messages`)).body;
    expect(seen.at(-1).text).toBe('from hank');
    expect((await admin.req('POST', '/api/admin/messages/delete', { ids: [sent.body.id] })).status).toBe(200);
    expect((await gina.req('GET', `/api/messages/${sent.body.id}`)).status).toBe(404);
    // regular users have no access
    expect((await gina.req('GET', '/api/admin/chats')).status).toBe(403);
  });

  it('deletes accounts and hands their groups over', async () => {
    const admin = await adminClient();
    const ivan = await register('ivan1');
    const judy = await register('judy1');
    const pm = (await ivan.req('POST', '/api/chats/private', { userId: judy.id })).body;
    const g = (await ivan.req('POST', '/api/chats/group', { title: 'Ivan group', memberIds: [judy.id] })).body;
    await ivan.req('POST', `/api/chats/${g.id}/messages`, { text: 'bye' });

    expect((await admin.req('POST', `/api/admin/users/${admin.id}/delete`, {})).status).toBe(403);
    expect((await admin.req('POST', `/api/admin/users/${ivan.id}/delete`, { wipeMessages: true })).status).toBe(200);
    expect((await admin.req('GET', `/api/admin/users/${ivan.id}`)).status).toBe(404);
    expect((await ivan.req('GET', '/api/chats')).status).toBe(401);
    expect((await judy.req('GET', `/api/chats/${pm.id}`)).status).toBe(404);
    const group = (await judy.req('GET', `/api/chats/${g.id}`)).body;
    expect(group.ownerId).toBe(judy.id);
    const texts = (await judy.req('GET', `/api/chats/${g.id}/messages`)).body.map((m: { text: string }) => m.text);
    expect(texts).not.toContain('bye');
  });

  it('manages messenger settings', async () => {
    const admin = await adminClient();
    const kate = await register('kate1');
    const s = (await admin.req('PUT', '/api/admin/settings', { version: '2.0.0', appName: 'Timba', announcement: 'hi', forceReload: true })).body;
    expect(s.version).toBe('2.0.0');
    expect(s.appName).toBe('Timba');
    expect(s.buildId).toBe(1);
    await admin.req('PUT', '/api/admin/settings', { groupCreation: false, uploadsEnabled: false });
    expect((await kate.req('POST', '/api/chats/group', { title: 'no' })).status).toBe(403);
    expect((await admin.req('POST', '/api/chats/group', { title: 'yes' })).status).toBe(200);
    await admin.req('PUT', '/api/admin/settings', { groupCreation: true, uploadsEnabled: true, announcement: '' });

    const b = await admin.req('POST', '/api/admin/broadcast', { text: 'news' });
    expect(b.body.sent).toBeGreaterThan(0);
    const chats = (await kate.req('GET', '/api/chats')).body;
    expect(chats.some((c: { lastMessage: { text: string } | null }) => c.lastMessage?.text === 'news')).toBe(true);
  });
});

describe('PupsoBank', () => {
  async function adminClient() {
    const r = await login('admin', 'adminpass');
    return client(String(r.headers['set-cookie']).split(';')[0]!, JSON.parse(r.body).id);
  }

  it('opens an account with 10 ТК on sign-up and greets in the bank notifications, not in a chat', async () => {
    const u = await register('bank_a');
    const info = (await u.req('GET', '/api/bank')).body;
    expect(info.balance).toBe(10);
    expect((await u.req('GET', '/api/bank/history')).body.items[0]).toMatchObject({ kind: 'start', amount: 10 });
    expect((await u.req('GET', '/api/chats')).body).toEqual([]);
    expect((await u.req('GET', '/api/notifications/unread')).body).toEqual({ bank: 1, support: 0 });
    const notes = (await u.req('GET', '/api/notifications/bank')).body;
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: 'bank', read: false });
    expect(notes[0].text).toContain('10');
    expect((await u.req('POST', '/api/notifications/bank/read')).body).toEqual({ bank: 0, support: 0 });
    expect((await u.req('GET', '/api/notifications/bank')).body[0].read).toBe(true);
    expect((await u.req('GET', '/api/notifications/nope')).status).toBe(400);
    // there are no built-in accounts to find
    expect((await u.req('GET', '/api/search?q=pupsobank')).body.users).toHaveLength(0);
    expect((await u.req('GET', '/api/search?q=support')).body.users).toHaveLength(0);
  });

  it('says nothing about starting coins when the panel gives none', async () => {
    const admin = await sharedAdmin();
    const before = (await admin.req('GET', '/api/bank')).body;
    expect((await admin.req('PUT', '/api/admin/bank/settings', { startBalance: 0 })).status).toBe(200);
    const u = await register('bank_zero');
    expect((await u.req('GET', '/api/bank')).body.balance).toBe(0);
    expect((await u.req('GET', '/api/notifications/bank')).body).toEqual([]);
    await admin.req('PUT', '/api/admin/bank/settings', { startBalance: 10 });
    expect(before.balance).toBeDefined();
  });

  it('transfers between users with a notification and a history', async () => {
    const a = await register('bank_b');
    const b = await register('bank_c');
    expect((await a.req('POST', '/api/bank/transfer', { userId: b.id, amount: 11 })).status).toBe(400);
    expect((await a.req('POST', '/api/bank/transfer', { userId: a.id, amount: 1 })).status).toBe(400);
    const r = await a.req('POST', '/api/bank/transfer', { userId: b.id, amount: 4, message: 'на пиццу' });
    expect(r.status).toBe(200);
    expect(r.body.balance).toBe(6);
    expect((await b.req('GET', '/api/bank')).body.balance).toBe(14);
    const hist = (await b.req('GET', '/api/bank/history')).body;
    expect(hist.items[0]).toMatchObject({ kind: 'transfer_in', amount: 4, peer: 'bank_b', message: 'на пиццу' });
    expect((await a.req('GET', '/api/bank/history')).body.items[0]).toMatchObject({ kind: 'transfer_out', amount: -4 });
    expect((await b.req('GET', '/api/notifications/bank')).body[0].text).toContain('4 ТК от @bank_b');
  });

  it('sells jokes, mints promo codes, lets the admin give coins and set an infinite balance', async () => {
    const admin = await adminClient();
    const u = await register('bank_d');
    const joke = await u.req('POST', '/api/bank/joke');
    expect(joke.status).toBe(200);
    expect(joke.body.balance).toBe(5);
    expect(joke.body.joke.length).toBeGreaterThan(5);
    await u.req('POST', '/api/bank/joke');
    const broke = await u.req('POST', '/api/bank/joke');
    expect(broke.status).toBe(400);
    expect(broke.body.message).toContain('Недостаточно ТимбаКоинов');

    // there is no cash: fees do not go to @admin
    const adminBefore = (await admin.req('GET', '/api/bank')).body.balance;
    expect((await admin.req('GET', `/api/admin/bank/ops?userId=${admin.id}`)).body.items.some((o: { kind: string }) => o.kind === 'income')).toBe(false);
    expect((await admin.req('POST', '/api/admin/bank/promos', { code: 'pups', tcoins: 3, maxUses: 1 })).status).toBe(200);
    const p = await u.req('POST', '/api/bank/promo', { code: 'PUPS' });
    expect(p.body).toEqual({ tcoins: 3, balance: 3 });
    expect((await u.req('POST', '/api/bank/promo', { code: 'pups' })).status).toBe(400);

    // promo codes create new coins, however big
    await admin.req('POST', '/api/admin/bank/promos', { code: 'HUGE', tcoins: 1_000_000 });
    expect((await u.req('POST', '/api/bank/promo', { code: 'huge' })).body.balance).toBe(1_000_003);
    expect((await admin.req('GET', '/api/bank')).body.balance).toBe(adminBefore);
    expect((await u.req('POST', '/api/bank/promo', { code: 'NOPE' })).status).toBe(400);

    expect((await admin.req('POST', '/api/admin/bank/give', { userId: u.id, amount: 3, set: true })).body.balance).toBe(3);
    expect((await admin.req('POST', '/api/admin/bank/give', { userId: u.id, amount: 100, reason: 'бонус' })).body.balance).toBe(103);
    const ov = (await admin.req('GET', '/api/admin/bank')).body;
    expect(ov.accounts.find((x: { user: { id: number } }) => x.user.id === u.id).balance).toBe(103);
    expect(ov.cashBalance).toBeUndefined();

    // -1 is an infinite balance: spending never lowers it
    const rich = await register('bank_inf');
    expect((await admin.req('POST', '/api/admin/bank/give', { userId: rich.id, amount: -1, set: true })).body.balance).toBe(-1);
    expect((await admin.req('POST', '/api/admin/bank/give', { userId: rich.id, amount: -2, set: true })).status).toBe(400);
    const sent = await rich.req('POST', '/api/bank/transfer', { userId: u.id, amount: 500 });
    expect(sent.body.balance).toBe(-1);
    expect((await u.req('GET', '/api/bank')).body.balance).toBe(603);
    expect((await rich.req('POST', '/api/bank/joke')).status).toBe(200);
    expect((await rich.req('GET', '/api/bank')).body.balance).toBe(-1);
    const notice = (await rich.req('GET', '/api/notifications/bank')).body[0].text;
    expect(notice).toContain('бесконечным');
    // setting a normal balance ends it
    expect((await admin.req('POST', '/api/admin/bank/give', { userId: rich.id, amount: 7, set: true })).body.balance).toBe(7);
    expect((await u.req('GET', '/api/admin/bank')).status).toBe(403);
  });
});

describe('old built-in accounts', () => {
  it('moves what «ТимбаКоины» and «Поддержка» wrote to notifications and removes them with their chats', async () => {
    const { db } = await import('../src/db.js');
    const { getUserRow } = await import('../src/serialize.js');
    const { getOrCreatePrivate } = await import('../src/services/chats.js');
    const { insertMessage } = await import('../src/services/messages.js');
    const { initNotifications } = await import('../src/notifications.js');
    const u = await register('legacy_u');
    const admin = await sharedAdmin();
    const mk = (username: string, bot: string) =>
      Number(
        db
          .prepare(`INSERT INTO users (username, first_name, last_name, bio, password_hash, created_at, bot) VALUES (?, ?, '', '', '!', ?, ?)`)
          .run(username, username, Date.now(), bot).lastInsertRowid,
      );
    const bank = getUserRow(mk('pupsobank', 'bank'))!;
    const support = getUserRow(mk('support', 'support'))!;
    const bankChat = getOrCreatePrivate(bank, getUserRow(u.id)!);
    insertMessage(bankChat, bank, { text: 'Вы получили 5 ТК', files: [] });
    insertMessage(bankChat, getUserRow(u.id)!, { text: 'спасибо', files: [] });
    const supportChat = getOrCreatePrivate(support, getUserRow(admin.id)!);
    const check = insertMessage(supportChat, support, { text: 'Проверка пополнения', files: [] });
    const topup = Number(
      db
        .prepare(`INSERT INTO bank_topups (user_id, amount, status, message_id, created_at) VALUES (?, 50, 'pending', ?, ?)`)
        .run(u.id, check.id, Date.now()).lastInsertRowid,
    );

    initNotifications();

    expect(db.prepare('SELECT COUNT(*) n FROM users WHERE bot IS NOT NULL').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT 1 FROM chats WHERE id IN (?, ?)').all(bankChat.id, supportChat.id)).toEqual([]);
    const mine = (await u.req('GET', '/api/notifications/bank')).body as { text: string; read: boolean }[];
    expect(mine.map((n) => n.text)).toContain('Вы получили 5 ТК');
    expect(mine.some((n) => n.text === 'спасибо')).toBe(false);
    expect(mine.find((n) => n.text === 'Вы получили 5 ТК')!.read).toBe(true);
    const notes = (await admin.req('GET', '/api/notifications/support')).body as { text: string; topup?: { id: number; status: string } }[];
    expect(notes.find((n) => n.text === 'Проверка пополнения')!.topup).toMatchObject({ id: topup, status: 'pending' });
    // the check still works from the notification
    expect((await admin.req('POST', `/api/admin/bank/topups/${topup}/reject`)).body.status).toBe('rejected');
    // running again changes nothing
    const count = db.prepare('SELECT COUNT(*) n FROM notifications').get();
    initNotifications();
    expect(db.prepare('SELECT COUNT(*) n FROM notifications').get()).toEqual(count);
  });
});

describe('PupsoBank admin', () => {
  it('sets prices, balances, promo codes and freezes accounts', async () => {
    const r = await login('admin', 'adminpass');
    const admin = await client(String(r.headers['set-cookie']).split(';')[0]!, JSON.parse(r.body).id);
    await admin.req('PUT', '/api/admin/bank/settings', { startBalance: 25, jokePrice: 7 });
    const u = await register('bank_f');
    expect((await u.req('GET', '/api/bank')).body).toMatchObject({ balance: 25, jokePrice: 7 });
    expect((await u.req('POST', '/api/bank/joke')).body.balance).toBe(18);

    expect((await admin.req('POST', '/api/admin/bank/give', { userId: u.id, amount: 50, set: true })).body.balance).toBe(50);
    expect((await admin.req('GET', `/api/admin/bank/ops?userId=${u.id}`)).body.items[0]).toMatchObject({ kind: 'admin', amount: 32 });

    await admin.req('POST', '/api/admin/bank/promos', { code: 'OFF', tcoins: 2 });
    await admin.req('PATCH', '/api/admin/bank/promos/off', { active: false });
    expect((await u.req('POST', '/api/bank/promo', { code: 'OFF' })).status).toBe(400);
    await admin.req('PATCH', '/api/admin/bank/promos/OFF', { active: true, tcoins: 4 });
    expect((await u.req('POST', '/api/bank/promo', { code: 'off' })).body.tcoins).toBe(4);

    await admin.req('POST', `/api/admin/bank/accounts/${u.id}/ban`, { banned: true });
    expect((await u.req('POST', '/api/bank/joke')).status).toBe(403);
    await admin.req('POST', `/api/admin/bank/accounts/${u.id}/ban`, { banned: false });
    await admin.req('PUT', '/api/admin/bank/settings', { startBalance: 10, jokePrice: 5 });
  });
});

describe('PupsoBank top-ups', () => {
  it('sends a check to the admin support chat and credits 1 ТК per ₽ on approval', async () => {
    const r = await login('admin', 'adminpass');
    const admin = await client(String(r.headers['set-cookie']).split(';')[0]!, JSON.parse(r.body).id);
    const u = await register('topup_a');
    const t = await u.req('POST', '/api/bank/topup', { amount: 150 });
    expect(t.status).toBe(200);
    // one check at a time
    expect((await u.req('POST', '/api/bank/topup', { amount: 10 })).status).toBe(400);
    expect((await u.req('POST', '/api/bank/topup', { amount: 0 })).status).toBe(400);

    // the check comes to the admin's support notifications, not to a chat
    expect((await admin.req('GET', '/api/notifications/unread')).body.support).toBeGreaterThan(0);
    const notes = (await admin.req('GET', '/api/notifications/support')).body as { text: string; topup?: { id: number; status: string; amount: number } }[];
    const check = notes[0]!;
    expect(check.text).toContain('150 ₽');
    expect(check.text).toContain('+79214822402');
    expect(check.topup).toMatchObject({ id: t.body.id, status: 'pending', amount: 150 });
    expect((await admin.req('GET', '/api/admin/bank/topups')).body.some((x: { id: number }) => x.id === t.body.id)).toBe(true);

    expect((await u.req('POST', `/api/admin/bank/topups/${t.body.id}/approve`)).status).toBe(403);
    expect((await admin.req('POST', `/api/admin/bank/topups/${t.body.id}/approve`)).body.status).toBe('approved');
    expect((await admin.req('POST', `/api/admin/bank/topups/${t.body.id}/reject`)).status).toBe(400);
    expect((await u.req('GET', '/api/bank')).body.balance).toBe(160);
    expect((await u.req('GET', '/api/bank/history')).body.items[0]).toMatchObject({ kind: 'topup', amount: 150 });

    const t2 = await u.req('POST', '/api/bank/topup', { amount: 30 });
    expect((await admin.req('POST', `/api/admin/bank/topups/${t2.body.id}/reject`)).body.status).toBe('rejected');
    expect((await u.req('GET', '/api/bank')).body.balance).toBe(160);
    const after = (await admin.req('GET', '/api/notifications/support')).body as { topup?: { id: number; status: string } }[];
    expect(after.find((m) => m.topup?.id === t2.body.id)!.topup!.status).toBe('rejected');
    expect(after.find((m) => m.topup?.id === t.body.id)!.topup!.status).toBe('approved');
    // the user hears about both in the bank notifications
    const mine = (await u.req('GET', '/api/notifications/bank')).body as { text: string }[];
    expect(mine[0]!.text).toContain('30 ₽');
    expect(mine[1]!.text).toContain('+150 ТК');
  });
});

describe('TimbaGram Premium', () => {
  it('is paid like a top-up: the admin confirms a month, the badge shows, balance stays', async () => {
    const r = await login('admin', 'adminpass');
    const admin = await client(String(r.headers['set-cookie']).split(';')[0]!, JSON.parse(r.body).id);
    const u = await register('prem_a');
    const other = await register('prem_b');
    expect((await u.req('GET', '/api/auth/me')).body).toMatchObject({ premium: false, premiumUntil: null, premiumPending: false });

    const t = await u.req('POST', '/api/premium/check');
    expect(t.status).toBe(200);
    expect((await u.req('POST', '/api/premium/check')).status).toBe(400);
    // a coin top-up may wait at the same time
    expect((await u.req('POST', '/api/bank/topup', { amount: 5 })).status).toBe(200);
    expect((await u.req('GET', '/api/auth/me')).body.premiumPending).toBe(true);

    const notes = (await admin.req('GET', '/api/notifications/support')).body as { text: string; topup?: { id: number; kind: string } }[];
    const check = notes.find((m) => m.topup?.id === t.body.id)!;
    expect(check.topup!.kind).toBe('premium');
    expect(check.text).toContain('399 ₽');

    const before = (await u.req('GET', '/api/bank')).body.balance;
    expect((await admin.req('POST', `/api/admin/bank/topups/${t.body.id}/approve`)).body.status).toBe('approved');
    expect((await u.req('GET', '/api/bank')).body.balance).toBe(before);
    const me = (await u.req('GET', '/api/auth/me')).body;
    expect(me.premium).toBe(true);
    expect(me.premiumUntil).toBeGreaterThan(Date.now() + 29 * 86400_000);
    expect((await other.req('GET', `/api/users/${u.id}`)).body.premium).toBe(true);

    // the admin extends, then removes
    const ext = await admin.req('POST', `/api/admin/users/${u.id}/premium`, { action: 'give', days: 30 });
    expect(ext.body.premiumUntil).toBeGreaterThan(me.premiumUntil + 29 * 86400_000);
    expect((await u.req('POST', `/api/admin/users/${u.id}/premium`, { action: 'remove' })).status).toBe(403);
    await admin.req('POST', `/api/admin/users/${u.id}/premium`, { action: 'remove' });
    expect((await u.req('GET', '/api/auth/me')).body).toMatchObject({ premium: false, premiumUntil: null });
    expect((await admin.req('GET', `/api/admin/users/${u.id}`)).body.premiumUntil).toBeNull();
    await premiumTerms(admin, await register('prem_c'));
  });

  it('gives the weekly bonus by a button, reminds of it and of the end', async () => {
    const admin = await sharedAdmin();
    const u = await register('prem_bonus');
    const DAY = 86400_000;
    const balance = async () => (await u.req('GET', '/api/bank')).body.balance as number;
    const me = async () => (await u.req('GET', '/api/auth/me')).body;
    const notes = async () => ((await u.req('GET', '/api/notifications/bank')).body as { text: string }[]).map((n) => n.text);
    const at = (ms: number, f: () => void) => {
      const spy = vi.spyOn(Date, 'now').mockReturnValue(ms);
      try {
        f();
      } finally {
        spy.mockRestore();
      }
    };
    const start = await balance();
    expect((await me()).premiumBonusAt).toBeNull();
    expect((await u.req('POST', '/api/premium/bonus')).status).toBe(403);

    await admin.req('POST', `/api/admin/users/${u.id}/premium`, { action: 'give', days: 10, notify: false });
    // nothing is paid by itself: the bonus is ready on the day of the purchase
    expect(await balance()).toBe(start);
    expect((await me()).premiumBonusAt).toBe(0);
    sendPremiumReminders();
    sendPremiumReminders();
    expect((await notes()).filter((n) => n.includes('бонус Премиума готов'))).toHaveLength(1);

    const r = await u.req('POST', '/api/premium/bonus');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ amount: PREMIUM_WEEKLY_BONUS, balance: start + PREMIUM_WEEKLY_BONUS });
    expect((await u.req('GET', '/api/bank/history')).body.items[0]).toMatchObject({ kind: 'premium_bonus', amount: PREMIUM_WEEKLY_BONUS });
    expect((await u.req('POST', '/api/premium/bonus')).status).toBe(400);
    const next = (await me()).premiumBonusAt as number;
    expect(next).toBeGreaterThan(Date.now() + 7 * DAY - 60_000);

    // a week later: one reminder, one more a day later, then quiet
    const real = Date.now();
    at(real + 7 * DAY + 1000, sendPremiumReminders);
    at(real + 7 * DAY + 2000, sendPremiumReminders);
    at(real + 8 * DAY + 3000, sendPremiumReminders);
    at(real + 9 * DAY + 4000, sendPremiumReminders);
    const n = await notes();
    expect(n.filter((x) => x.includes('бонус Премиума готов'))).toHaveLength(2);
    expect(n.filter((x) => x.includes('Не забудьте забрать'))).toHaveLength(1);
    // the premium ends 10 days after it started: warned once, a day before
    expect(n.filter((x) => x.includes('меньше чем через сутки'))).toHaveLength(1);

    // extended: warned again before the new end; forever: never
    await admin.req('POST', `/api/admin/users/${u.id}/premium`, { action: 'give', days: 5, notify: false });
    at(real + 14 * DAY + 5000, sendPremiumReminders);
    expect((await notes()).filter((x) => x.includes('меньше чем через сутки'))).toHaveLength(2);
    await admin.req('POST', `/api/admin/users/${u.id}/premium`, { action: 'forever', notify: false });
    at(real + 400 * DAY, sendPremiumReminders);
    expect((await notes()).filter((x) => x.includes('меньше чем через сутки'))).toHaveLength(2);

    await admin.req('POST', `/api/admin/users/${u.id}/premium`, { action: 'remove', notify: false });
    expect((await u.req('POST', '/api/premium/bonus')).status).toBe(403);
  });
});

/** The admin sets an exact end, cuts by days, gives it forever; promo codes give it too. */
async function premiumTerms(admin: Awaited<ReturnType<typeof client>>, u: Awaited<ReturnType<typeof register>>) {
  const set = (body: object) => admin.req('POST', `/api/admin/users/${u.id}/premium`, { notify: false, ...body });
  const DAY = 86400_000;

  const at = Date.now() + 10 * DAY;
  expect((await set({ action: 'until', until: at })).body.premiumUntil).toBe(at);
  // earlier than the current end: the term is cut
  expect((await set({ action: 'until', until: at - 5 * DAY })).body.premiumUntil).toBe(at - 5 * DAY);
  expect((await set({ action: 'cut', days: 2 })).body.premiumUntil).toBe(at - 7 * DAY);
  // cutting past now takes it away
  expect((await set({ action: 'cut', days: 30 })).body.premiumUntil).toBeNull();
  expect((await u.req('GET', '/api/auth/me')).body.premium).toBe(false);

  const forever = (await set({ action: 'forever' })).body.premiumUntil;
  expect(forever).toBeGreaterThan(Date.now() + 900 * 365 * DAY);
  // extending an endless one keeps it endless, cutting by days is refused
  expect((await set({ action: 'give', days: 30 })).body.premiumUntil).toBe(forever);
  expect((await set({ action: 'cut', days: 1 })).status).toBe(400);
  expect((await set({ action: 'until', until: at })).body.premiumUntil).toBe(at);
  expect((await u.req('GET', '/api/auth/me')).body.premium).toBe(true);

  // promo codes: days on top, forever, limits and expiry
  const a = await register('promo_a');
  const b = await register('promo_b');

  expect((await a.req('POST', '/api/admin/promos', { days: 7 })).status).toBe(403);
  const week = (await admin.req('POST', '/api/admin/promos', { code: 'week7', days: 7, maxUses: 1 })).body;
  expect(week).toMatchObject({ code: 'WEEK7', days: 7, maxUses: 1, uses: 0 });
  expect((await admin.req('POST', '/api/admin/promos', { code: 'WEEK7', days: 1 })).status).toBe(400);
  const random = (await admin.req('POST', '/api/admin/promos', { days: null })).body;
  expect(random.code).toMatch(/^[A-Z0-9]{8}$/);
  expect(random.days).toBeNull();

  const got = await a.req('POST', '/api/premium/redeem', { code: ' week7 ' });
  expect(got.status).toBe(200);
  expect(got.body.premiumUntil).toBeGreaterThan(Date.now() + 6.9 * DAY);
  expect((await a.req('GET', '/api/auth/me')).body.premium).toBe(true);
  // one per user, and the limit of uses
  expect((await a.req('POST', '/api/premium/redeem', { code: 'WEEK7' })).status).toBe(400);
  expect((await b.req('POST', '/api/premium/redeem', { code: 'WEEK7' })).status).toBe(400);
  expect((await b.req('POST', '/api/premium/redeem', { code: 'NOPE' })).status).toBe(400);

  // forever
  const f = await a.req('POST', '/api/premium/redeem', { code: random.code });
  expect(f.body.premiumUntil).toBeGreaterThan(Date.now() + 900 * 365 * DAY);

  // expired codes do not work
  const old = (await admin.req('POST', '/api/admin/promos', { days: 3, expiresAt: Date.now() - 1000 })).body;
  expect((await b.req('POST', '/api/premium/redeem', { code: old.code })).status).toBe(400);

  const list = (await admin.req('GET', '/api/admin/promos')).body as { id: number; code: string; uses: number }[];
  expect(list.find((p) => p.code === 'WEEK7')!.uses).toBe(1);
  expect((await admin.req('DELETE', `/api/admin/promos/${week.id}`)).status).toBe(200);
  expect(((await admin.req('GET', '/api/admin/promos')).body as { code: string }[]).some((p) => p.code === 'WEEK7')).toBe(false);
}

describe('Казино', () => {
  it('is for premium users only and moves exactly win minus bet', async () => {
    const r = await login('admin', 'adminpass');
    const admin = await client(String(r.headers['set-cookie']).split(';')[0]!, JSON.parse(r.body).id);
    const u = await register('casino_a');
    expect((await u.req('POST', '/api/casino/slots', { amount: 1 })).status).toBe(403);
    await admin.req('POST', `/api/admin/users/${u.id}/premium`, { action: 'give', days: 1, notify: false });
    expect((await u.req('POST', '/api/casino/slots', { amount: 0 })).status).toBe(400);
    const rich = (await u.req('GET', '/api/bank')).body.balance as number;
    expect((await u.req('POST', '/api/casino/slots', { amount: rich + 1 })).status).toBe(400);
    expect((await u.req('POST', '/api/casino/roulette', { type: 'number', value: 37, amount: 1 })).status).toBe(400);

    let balance = (await u.req('GET', '/api/bank')).body.balance as number;
    for (let i = 0; i < 5; i++) {
      const s = await u.req('POST', '/api/casino/slots', { amount: 1 });
      expect(s.status).toBe(200);
      expect(s.body.reels).toHaveLength(3);
      expect(s.body.balance).toBe(balance - 1 + s.body.win);
      balance = s.body.balance;
      const rr = await u.req('POST', '/api/casino/roulette', { type: 'red', amount: 1 });
      if (rr.status === 400) break; // spent everything
      expect(rr.body.number).toBeGreaterThanOrEqual(0);
      expect(rr.body.win === 0 || rr.body.win === 2).toBe(true);
      expect(rr.body.balance).toBe(balance - 1 + rr.body.win);
      balance = rr.body.balance;
    }
    const hist = (await u.req('GET', '/api/bank/history')).body.items as { kind: string }[];
    expect(hist[0]!.kind).toBe('casino');
  });

  it('pays the roulette by the rules and keeps the slots below 100%', async () => {
    const { rouletteWins, slotsMultiplier } = await import('../src/bank/casino.js');
    expect(rouletteWins({ type: 'number', value: 0, amount: 1 }, 0)).toBe(35);
    expect(rouletteWins({ type: 'red', amount: 1 }, 0)).toBeNull();
    expect(rouletteWins({ type: 'red', amount: 1 }, 1)).toBe(1);
    expect(rouletteWins({ type: 'black', amount: 1 }, 2)).toBe(1);
    expect(rouletteWins({ type: 'dozen', value: 3, amount: 1 }, 36)).toBe(2);
    expect(rouletteWins({ type: 'high', amount: 1 }, 18)).toBeNull();
    const w = [30, 25, 20, 12, 8, 4, 1];
    const total = 100;
    let rtp = 0;
    for (let a = 0; a < 7; a++) for (let b = 0; b < 7; b++) for (let c = 0; c < 7; c++) {
      rtp += ((w[a]! * w[b]! * w[c]!) / total ** 3) * slotsMultiplier([a, b, c]);
    }
    expect(rtp).toBeGreaterThan(0.87);
    expect(rtp).toBeLessThan(0.93);
    // a pair counts on any two reels, not only on the first two
    expect(slotsMultiplier([6, 0, 6])).toBe(10);
    expect(slotsMultiplier([0, 6, 6])).toBe(10);
    expect(slotsMultiplier([6, 6, 0])).toBe(10);
    expect(slotsMultiplier([5, 1, 5])).toBe(5);
    expect(slotsMultiplier([0, 1, 0])).toBe(0);
    expect(slotsMultiplier([6, 6, 6])).toBe(777);
    expect(slotsMultiplier([1, 2, 3])).toBe(0);
  });
});

describe('Telegram-like extras', () => {
  it('schedules messages, sends them on time or right away', async () => {
    const { db } = await import('../src/db.js');
    const { sendDueScheduled } = await import('../src/services/scheduled.js');
    const a = await register('sched_a');
    const b = await register('sched_b');
    const chat = (await a.req('POST', '/api/chats/private', { userId: b.id })).body;
    expect((await a.req('POST', `/api/chats/${chat.id}/scheduled`, { text: 'soon', sendAt: Date.now() + 1000 })).status).toBe(400);
    const s1 = (await a.req('POST', `/api/chats/${chat.id}/scheduled`, { text: 'later', sendAt: Date.now() + 3600_000, silent: true })).body;
    const s2 = (await a.req('POST', `/api/chats/${chat.id}/scheduled`, { text: 'now please', sendAt: Date.now() + 7200_000 })).body;
    expect((await a.req('GET', `/api/chats/${chat.id}`)).body.scheduledCount).toBe(2);
    expect((await b.req('GET', `/api/chats/${chat.id}/scheduled`)).body).toHaveLength(0);
    expect((await b.req('DELETE', `/api/scheduled/${s1.id}`)).status).toBe(404);

    const sent = (await a.req('POST', `/api/scheduled/${s2.id}/send`)).body;
    expect(sent.text).toBe('now please');
    // the first one comes due
    db.prepare('UPDATE scheduled_messages SET send_at = ? WHERE id = ?').run(Date.now() - 1, s1.id);
    sendDueScheduled();
    const msgs = (await b.req('GET', `/api/chats/${chat.id}/messages`)).body as { text: string; silent?: boolean }[];
    expect(msgs.at(-1)).toMatchObject({ text: 'later', silent: true });
    expect((await a.req('GET', `/api/chats/${chat.id}`)).body.scheduledCount).toBe(0);
  });

  it('keeps a scheduled message when "send now" is refused', async () => {
    const owner = await register('keep_a');
    const member = await register('keep_b');
    const g = (await owner.req('POST', '/api/chats/group', { title: 'Keep', memberIds: [member.id] })).body;
    await owner.req('PATCH', `/api/chats/${g.id}`, { slowMode: 60 });
    const s = (await member.req('POST', `/api/chats/${g.id}/scheduled`, { text: 'later', sendAt: Date.now() + 3600_000 })).body;
    expect((await member.req('POST', `/api/chats/${g.id}/messages`, { text: 'first' })).status).toBe(200);
    // slow mode refuses the second message: it must stay in the queue, not vanish
    expect((await member.req('POST', `/api/scheduled/${s.id}/send`)).status).toBe(429);
    expect((await member.req('GET', `/api/chats/${g.id}/scheduled`)).body).toHaveLength(1);
    expect((await member.req('GET', `/api/chats/${g.id}`)).body.scheduledCount).toBe(1);
  });

  it('sends scheduled messages of the same moment in order, and slow mode makes the next one wait', async () => {
    const { db } = await import('../src/db.js');
    const { sendDueScheduled } = await import('../src/services/scheduled.js');
    const owner = await register('order_a');
    const member = await register('order_b');
    const g = (await owner.req('POST', '/api/chats/group', { title: 'Order', memberIds: [member.id] })).body;
    await owner.req('PATCH', `/api/chats/${g.id}`, { slowMode: 60 });
    const at = Date.now() + 3600_000;
    const s1 = (await member.req('POST', `/api/chats/${g.id}/scheduled`, { text: 'часть 1', sendAt: at })).body;
    const s2 = (await member.req('POST', `/api/chats/${g.id}/scheduled`, { text: 'часть 2', sendAt: at })).body;
    db.prepare('UPDATE scheduled_messages SET send_at = ? WHERE id IN (?, ?)').run(Date.now() - 1, s2.id, s1.id);
    sendDueScheduled();
    const texts = ((await owner.req('GET', `/api/chats/${g.id}/messages`)).body as { text: string }[]).map((m) => m.text);
    expect(texts.at(-1)).toBe('часть 1');
    expect(texts).not.toContain('часть 2');
    // the second one waits for the end of slow mode instead of vanishing
    const left = (await member.req('GET', `/api/chats/${g.id}/scheduled`)).body;
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ id: s2.id, text: 'часть 2' });
    expect(left[0].sendAt).toBeGreaterThan(Date.now() + 30_000);
  });

  it('auto-deletes messages after the chat timer', async () => {
    const { db } = await import('../src/db.js');
    const { deleteExpiredMessages } = await import('../src/services/messages.js');
    const a = await register('auto_a');
    const b = await register('auto_b');
    const chat = (await a.req('POST', '/api/chats/private', { userId: b.id })).body;
    expect((await a.req('PUT', `/api/chats/${chat.id}/auto-delete`, { seconds: 123 })).status).toBe(400);
    expect((await b.req('PUT', `/api/chats/${chat.id}/auto-delete`, { seconds: 86400 })).body.autoDelete).toBe(86400);
    const m = (await a.req('POST', `/api/chats/${chat.id}/messages`, { text: 'bye' })).body;
    expect(m.expiresAt).toBeGreaterThan(Date.now() + 86000_000);
    db.prepare('UPDATE messages SET expires_at = ? WHERE id = ?').run(Date.now() - 1, m.id);
    deleteExpiredMessages();
    expect((await a.req('GET', `/api/messages/${m.id}`)).status).toBe(404);
    await a.req('PUT', `/api/chats/${chat.id}/auto-delete`, { seconds: null });
    const m2 = (await a.req('POST', `/api/chats/${chat.id}/messages`, { text: 'stay' })).body;
    expect(m2.expiresAt).toBeUndefined();
  });

  it('slow mode limits members but not admins', async () => {
    const owner = await register('slow_a');
    const member = await register('slow_b');
    const g = (await owner.req('POST', '/api/chats/group', { title: 'Slow', memberIds: [member.id] })).body;
    expect((await owner.req('PATCH', `/api/chats/${g.id}`, { slowMode: 7 })).status).toBe(400);
    expect((await owner.req('PATCH', `/api/chats/${g.id}`, { slowMode: 60 })).body.slowMode).toBe(60);
    expect((await member.req('POST', `/api/chats/${g.id}/messages`, { text: 'one' })).status).toBe(200);
    const second = await member.req('POST', `/api/chats/${g.id}/messages`, { text: 'two' });
    expect(second.status).toBe(429);
    expect(second.body.error).toBe('slow_mode');
    expect((await member.req('GET', `/api/chats/${g.id}`)).body.me.slowModeUntil).toBeGreaterThan(Date.now());
    expect((await owner.req('POST', `/api/chats/${g.id}/messages`, { text: 'a' })).status).toBe(200);
    expect((await owner.req('POST', `/api/chats/${g.id}/messages`, { text: 'b' })).status).toBe(200);
  });
});

describe('cards, reminders, transcripts', () => {
  it('sends ТК right in a chat as a card', async () => {
    const a = await register('card_a');
    const b = await register('card_b');
    const c = await register('card_c');
    const chat = (await a.req('POST', '/api/chats/private', { userId: b.id })).body;
    const m = await a.req('POST', `/api/chats/${chat.id}/send-coins`, { toUserId: b.id, amount: 4, comment: 'на кофе' });
    expect(m.status).toBe(200);
    expect(m.body).toMatchObject({ kind: 'transfer', text: 'на кофе', transfer: { amount: 4, to: { id: b.id }, from: { id: a.id } } });
    expect((await b.req('GET', '/api/bank')).body.balance).toBe(14);
    // not a member of the chat, too much, to yourself
    expect((await a.req('POST', `/api/chats/${chat.id}/send-coins`, { toUserId: c.id, amount: 1 })).status).toBe(404);
    expect((await a.req('POST', `/api/chats/${chat.id}/send-coins`, { toUserId: b.id, amount: 100 })).status).toBe(400);
    expect((await a.req('POST', `/api/chats/${chat.id}/send-coins`, { toUserId: a.id, amount: 1 })).status).toBe(400);
    // cards can be neither edited nor forwarded
    expect((await a.req('PATCH', `/api/messages/${m.body.id}`, { text: 'x' })).status).toBe(403);
  });

  it('collects money for a group fundraiser', async () => {
    const owner = await register('fund_a');
    const x = await register('fund_b');
    const y = await register('fund_c');
    const g = (await owner.req('POST', '/api/chats/group', { title: 'Подарок', memberIds: [x.id, y.id] })).body;
    const card = (await owner.req('POST', `/api/chats/${g.id}/funds`, { title: 'Торт маме', goal: 15 })).body;
    expect(card.fund).toMatchObject({ title: 'Торт маме', goal: 15, collected: 0, closed: false });
    const r1 = await x.req('POST', `/api/funds/${card.fund.id}/contribute`, { amount: 6 });
    expect(r1.body.balance).toBe(4);
    await y.req('POST', `/api/funds/${card.fund.id}/contribute`, { amount: 5 });
    expect((await x.req('POST', `/api/funds/${card.fund.id}/contribute`, { amount: 50 })).status).toBe(400);
    expect((await owner.req('GET', '/api/bank')).body.balance).toBe(21);
    const after = (await owner.req('GET', `/api/messages/${card.id}`)).body;
    expect(after.fund).toMatchObject({ collected: 11, contributors: 2 });
    expect((await x.req('POST', `/api/funds/${card.fund.id}/close`)).status).toBe(403);
    expect((await owner.req('POST', `/api/funds/${card.fund.id}/close`)).body.fund.closed).toBe(true);
    expect((await y.req('POST', `/api/funds/${card.fund.id}/contribute`, { amount: 1 })).status).toBe(400);
  });

  it('keeps a shared checklist', async () => {
    const a = await register('list_a');
    const b = await register('list_b');
    const chat = (await a.req('POST', '/api/chats/private', { userId: b.id })).body;
    const card = (await a.req('POST', `/api/chats/${chat.id}/checklists`, { title: 'Покупки', items: ['Молоко', 'Хлеб'] })).body;
    expect(card.checklist.items.map((i: { text: string }) => i.text)).toEqual(['Молоко', 'Хлеб']);
    const item = card.checklist.items[0].id;
    const done = (await b.req('POST', `/api/checklists/${card.checklist.id}/items/${item}/toggle`)).body;
    expect(done.checklist.items[0].doneBy.id).toBe(b.id);
    const added = (await b.req('POST', `/api/checklists/${card.checklist.id}/items`, { text: 'Сыр' })).body;
    expect(added.checklist.items).toHaveLength(3);
    const undone = (await a.req('POST', `/api/checklists/${card.checklist.id}/items/${item}/toggle`)).body;
    expect(undone.checklist.items[0].doneBy).toBeNull();
    const c = await register('list_c');
    expect((await c.req('POST', `/api/checklists/${card.checklist.id}/items/${item}/toggle`)).status).toBe(403);
  });

  it('reminds about a message in saved messages', async () => {
    const { db } = await import('../src/db.js');
    const { sendDueReminders } = await import('../src/services/reminders.js');
    const a = await register('rem_a');
    const b = await register('rem_b');
    const chat = (await a.req('POST', '/api/chats/private', { userId: b.id })).body;
    const m = (await b.req('POST', `/api/chats/${chat.id}/messages`, { text: 'Позвони бабушке' })).body;
    expect((await a.req('POST', `/api/messages/${m.id}/remind`, { at: Date.now() + 1000 })).status).toBe(400);
    const r = await a.req('POST', `/api/messages/${m.id}/remind`, { at: Date.now() + 3600_000 });
    expect(r.status).toBe(200);
    db.prepare('UPDATE reminders SET remind_at = ? WHERE id = ?').run(Date.now() - 1, r.body.id);
    sendDueReminders();
    const chats = (await a.req('GET', '/api/chats')).body as { id: number; peer: { id: number } | null }[];
    const saved = chats.find((c) => c.peer?.id === a.id)!;
    const msgs = (await a.req('GET', `/api/chats/${saved.id}/messages`)).body as { text: string; forwardedFrom: unknown }[];
    expect(msgs.at(-2)!.text).toContain('Напоминание');
    expect(msgs.at(-1)).toMatchObject({ text: 'Позвони бабушке', forwardedFrom: { name: 'rem_b' } });
  });

  it('transcribes voice messages once and keeps the text', async () => {
    const saved = config.transcribeKey;
    const a = await register('voice_a');
    const b = await register('voice_b');
    const chat = (await a.req('POST', '/api/chats/private', { userId: b.id })).body;
    const boundary = '----v';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="as"\r\n\r\nvoice\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="v.webm"\r\nContent-Type: audio/webm\r\n\r\n`),
      Buffer.alloc(2000, 7),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const up = await app.inject({
      method: 'POST',
      url: '/api/files',
      payload,
      headers: { cookie: a.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    const file = up.json();
    expect(file.kind).toBe('voice');
    await a.req('POST', `/api/chats/${chat.id}/messages`, { fileIds: [file.id] });

    expect((await b.req('POST', `/api/files/${file.id}/transcribe`)).status).toBe(503);
    config.transcribeKey = 'test';
    let calls = 0;
    vi.stubGlobal('fetch', async (url: string) => {
      calls++;
      expect(url).toContain('/audio/transcriptions');
      return new Response(JSON.stringify({ text: ' Привет, это голосовое ' }), { status: 200 });
    });
    try {
      expect((await b.req('POST', `/api/files/${file.id}/transcribe`)).body.text).toBe('Привет, это голосовое');
      expect((await a.req('POST', `/api/files/${file.id}/transcribe`)).body.text).toBe('Привет, это голосовое');
      expect(calls).toBe(1);
      const msgs = (await b.req('GET', `/api/chats/${chat.id}/messages`)).body as { attachments: { transcript?: string }[] }[];
      expect(msgs.at(-1)!.attachments[0]!.transcript).toBe('Привет, это голосовое');
      const c = await register('voice_c');
      expect((await c.req('POST', `/api/files/${file.id}/transcribe`)).status).toBe(403);
    } finally {
      vi.unstubAllGlobals();
      config.transcribeKey = saved;
    }
  });
});

describe('branding', () => {
  it('renames the messenger everywhere and takes an uploaded logo', async () => {
    const sharp = (await import('sharp')).default;
    const r = await login('admin', 'adminpass');
    const admin = await client(String(r.headers['set-cookie']).split(';')[0]!, JSON.parse(r.body).id);
    const u = await register('brand_a');

    await admin.req('PUT', '/api/admin/settings', { appName: 'Семейный чат' });
    const manifest = (await app.inject({ method: 'GET', url: '/manifest.webmanifest' })).json();
    expect(manifest.name).toBe('Семейный чат');
    expect((await u.req('GET', '/api/app/status')).body.appName).toBe('Семейный чат');

    // the built-in logo is an svg; an uploaded picture becomes a png
    expect((await app.inject({ method: 'GET', url: '/api/logo' })).headers['content-type']).toContain('svg');
    // the light theme of the app has its own built-in logo
    const dark = (await app.inject({ method: 'GET', url: '/api/logo' })).body;
    const light = await app.inject({ method: 'GET', url: '/api/logo?theme=light' });
    expect(light.headers['content-type']).toContain('svg');
    expect(light.body).not.toBe(dark);
    const png = await sharp({ create: { width: 300, height: 200, channels: 3, background: '#ff0000' } }).png().toBuffer();
    const boundary = '----logo';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="logo.png"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const headers = (cookie: string) => ({ cookie, 'content-type': `multipart/form-data; boundary=${boundary}` });
    expect((await app.inject({ method: 'POST', url: '/api/admin/logo', payload, headers: headers(u.cookie) })).statusCode).toBe(403);
    const up = await app.inject({ method: 'POST', url: '/api/admin/logo', payload, headers: headers(admin.cookie) });
    expect(up.statusCode).toBe(200);
    expect(up.json().logoVersion).toBeGreaterThan(0);
    const logo = await app.inject({ method: 'GET', url: '/api/logo' });
    expect(logo.headers['content-type']).toContain('png');
    expect((await sharp(logo.rawPayload).metadata()).width).toBe(512);
    const icon = await app.inject({ method: 'GET', url: '/api/icon/192' });
    expect((await sharp(icon.rawPayload).metadata()).width).toBe(192);

    expect((await admin.req('DELETE', '/api/admin/logo')).body.logoVersion).toBe(0);
    expect((await app.inject({ method: 'GET', url: '/api/logo' })).headers['content-type']).toContain('svg');
    await admin.req('PUT', '/api/admin/settings', { appName: 'TimbaGram' });
  });
});

describe('phone numbers', () => {
  it('stores an optional number, hides it by privacy and finds users by it', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      remoteAddress: '10.77.0.1',
      payload: { username: 'phone_a', password: 'secret123', phone: '8 (921) 123-45-67' },
    });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.body).phone).toBe('+79211234567');
    const a = await client(String(r.headers['set-cookie']).split(';')[0]!, JSON.parse(r.body).id);
    const b = await register('phone_b');

    // the same number twice, garbage
    const dup = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      remoteAddress: '10.77.0.2',
      payload: { username: 'phone_c', password: 'secret123', phone: '+7 921 1234567' },
    });
    expect(dup.statusCode).toBe(409);
    expect((await b.req('PATCH', '/api/me', { phone: '12' })).status).toBe(400);
    expect((await b.req('PATCH', '/api/me', { phone: 'abc' })).status).toBe(400);

    // hidden by default, found by the whole number
    expect((await b.req('GET', `/api/users/${a.id}`)).body.phone).toBeNull();
    expect((await b.req('GET', '/api/search?q=' + encodeURIComponent('+7 921 123 45 67'))).body.users[0].id).toBe(a.id);
    await a.req('PUT', '/api/me/privacy', { phone: 'everybody' });
    expect((await b.req('GET', `/api/users/${a.id}`)).body.phone).toBe('+79211234567');

    // cleared
    expect((await a.req('PATCH', '/api/me', { phone: '' })).body.phone).toBeNull();
    expect((await b.req('PATCH', '/api/me', { phone: '9211234567' })).body.phone).toBe('+79211234567');
  });
});

describe('support tickets', () => {
  it('creates a ticket, answers it, calls the operator and lets the admin reply and close', async () => {
    const { ticketsIdle } = await import('../src/services/tickets.js');
    const u = await register('ticket_user');
    const r = await login('admin', 'adminpass');
    const admin = await client(String(r.headers['set-cookie']).split(';')[0]!, JSON.parse(r.body).id);

    expect((await u.req('GET', '/api/support/tickets')).body).toEqual([]);
    expect((await u.req('POST', '/api/support/tickets', { type: 'problem', text: 'abc' })).status).toBe(400);
    expect((await u.req('POST', '/api/support/tickets', { type: 'nope', text: 'Не приходят уведомления' })).status).toBe(400);

    const created = (await u.req('POST', '/api/support/tickets', { type: 'problem', text: 'Не приходят уведомления\nНа айфоне' })).body;
    expect(created).toMatchObject({ type: 'problem', subject: 'Не приходят уведомления', status: 'open' });
    await ticketsIdle();
    // no GigaChat key in tests: a single "we got it" answer
    let t = (await u.req('GET', `/api/support/tickets/${created.id}`)).body;
    expect(t.messages.map((m: any) => m.author)).toEqual(['user', 'support']);
    await u.req('POST', `/api/support/tickets/${created.id}/messages`, { text: 'Ещё вопрос' });
    await ticketsIdle();
    t = (await u.req('GET', `/api/support/tickets/${created.id}`)).body;
    expect(t.messages.map((m: any) => m.author)).toEqual(['user', 'support', 'user']);

    // somebody else's ticket
    const other = await register('ticket_other');
    expect((await other.req('GET', `/api/support/tickets/${created.id}`)).status).toBe(403);
    expect((await other.req('GET', '/api/admin/support/tickets')).status).toBe(403);

    // the operator: status, a support notification for the admin, and the admin's list
    expect((await u.req('POST', `/api/support/tickets/${created.id}/operator`)).body.status).toBe('operator');
    const note = (await admin.req('GET', '/api/notifications/support')).body[0].text;
    expect(note).toContain(`№${created.id}`);
    const list = (await admin.req('GET', '/api/admin/support/tickets')).body;
    expect(list.tickets[0]).toMatchObject({ id: created.id, status: 'operator', user: { username: 'ticket_user' } });
    expect(list.badge).toBeGreaterThan(0);

    // after that support keeps quiet; the operator answers
    await u.req('POST', `/api/support/tickets/${created.id}/messages`, { text: 'Жду' });
    await ticketsIdle();
    await admin.req('POST', `/api/admin/support/tickets/${created.id}/messages`, { text: 'Сбросил настройки, проверьте' });
    const mine = (await u.req('GET', '/api/support/tickets')).body[0];
    expect(mine.unread).toBeGreaterThan(0);
    t = (await u.req('GET', `/api/support/tickets/${created.id}`)).body;
    expect(t.messages.map((m: any) => m.author)).toEqual(['user', 'support', 'user', 'system', 'user', 'operator']);
    expect((await u.req('GET', '/api/support/tickets')).body[0].unread).toBe(0);

    // the operator has answered: the ticket no longer "waits for an operator" (for the user and for the admin)
    expect((await u.req('GET', '/api/support/tickets')).body[0].status).toBe('answered');
    const answered = (await admin.req('GET', '/api/admin/support/tickets')).body.tickets.find((x: any) => x.id === created.id);
    expect(answered.status).toBe('answered');
    // …until the user writes again: then it waits for the operator once more, and the admin is told
    await u.req('POST', `/api/support/tickets/${created.id}/messages`, { text: 'Не помогло' });
    await ticketsIdle();
    expect((await u.req('GET', `/api/support/tickets/${created.id}`)).body.status).toBe('operator');
    expect((await admin.req('GET', '/api/admin/support/tickets')).body.tickets.find((x: any) => x.id === created.id).status).toBe('operator');
    // the operator who has the ticket open on a screen marks what came into it as read, without loading the thread again
    const unreadOf = async () => (await admin.req('GET', '/api/admin/support/tickets')).body.tickets.find((x: any) => x.id === created.id).unread;
    expect(await unreadOf()).toBeGreaterThan(0);
    expect((await admin.req('POST', `/api/admin/support/tickets/${created.id}/read`)).status).toBe(200);
    expect(await unreadOf()).toBe(0);
    expect((await u.req('POST', `/api/admin/support/tickets/${created.id}/read`)).status).toBe(403);
    expect((await admin.req('POST', '/api/admin/support/tickets/999999/read')).status).toBe(404);
    // the operator answers again
    await admin.req('POST', `/api/admin/support/tickets/${created.id}/messages`, { text: 'Передал разработчикам' });
    expect((await u.req('GET', `/api/support/tickets/${created.id}`)).body.status).toBe('answered');

    expect((await admin.req('POST', `/api/admin/support/tickets/${created.id}/close`)).body.status).toBe('closed');
    // writing into a closed ticket opens it again
    await u.req('POST', `/api/support/tickets/${created.id}/messages`, { text: 'Снова не работает' });
    await ticketsIdle();
    expect((await u.req('GET', `/api/support/tickets/${created.id}`)).body.status).toBe('open');

    // there is no support chat any more
    expect((await u.req('POST', '/api/support')).status).toBe(404);
    // …and the admin's own chats are not among "Переписки"
    expect(((await admin.req('GET', '/api/admin/chats')).body as any[]).some((c) => c.members.some((m: any) => m.id === admin.id))).toBe(false);
  });

  it('tells the admin about new tickets, goes straight to the operator when support is off, deletes tickets', async () => {
    const { ticketsIdle } = await import('../src/services/tickets.js');
    const u = await register('ticket_user2');
    const r = await login('admin', 'adminpass');
    const admin = await client(String(r.headers['set-cookie']).split(';')[0]!, JSON.parse(r.body).id);

    const t1 = (await u.req('POST', '/api/support/tickets', { type: 'question', text: 'Как сменить фото?' })).body;
    await ticketsIdle();
    const note = (await admin.req('GET', '/api/notifications/support')).body[0].text;
    expect(note).toContain(`Новое обращение №${t1.id}`);
    const adminBadge = (await admin.req('GET', '/api/support/badge')).body;
    expect(adminBadge.admin).toBeGreaterThan(0);
    // the parts add up to the total, so each admin section can show its own number
    expect(adminBadge.adminSupport + adminBadge.adminTopups).toBe(adminBadge.admin);
    expect((await u.req('GET', '/api/support/badge')).body).toEqual({ unread: 1, admin: 0, adminSupport: 0, adminTopups: 0 });

    // automatic answers off: the ticket waits for the operator at once
    await admin.req('PUT', '/api/admin/settings', { supportBot: false });
    const t2 = (await u.req('POST', '/api/support/tickets', { type: 'problem', text: 'Не могу войти' })).body;
    await ticketsIdle();
    const d2 = (await u.req('GET', `/api/support/tickets/${t2.id}`)).body;
    expect(d2.status).toBe('operator');
    expect(d2.messages.map((m: any) => m.author)).toEqual(['user', 'system']);
    await admin.req('PUT', '/api/admin/settings', { supportBot: true });

    // the admin deletes a ticket
    expect((await u.req('DELETE', `/api/admin/support/tickets/${t2.id}`)).status).toBe(403);
    expect((await admin.req('DELETE', `/api/admin/support/tickets/${t2.id}`)).status).toBe(200);
    expect((await u.req('GET', `/api/support/tickets/${t2.id}`)).status).toBe(404);
    expect(((await u.req('GET', '/api/support/tickets')).body as any[]).map((x) => x.id)).toEqual([t1.id]);
  });
});

describe('several accounts', () => {
  /** a tiny browser cookie jar: set-cookie in, cookie header out */
  function jar() {
    const cookies = new Map<string, string>();
    const req = async (method: string, url: string, payload?: object) => {
      const r = await app.inject({
        method: method as 'GET',
        url,
        payload,
        remoteAddress: `10.9.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`,
        headers: { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
      });
      const set = r.headers['set-cookie'];
      for (const c of Array.isArray(set) ? set : set ? [set] : []) {
        const [pair, ...attrs] = c.split(';');
        const [k, v = ''] = pair!.split('=');
        if (!v || attrs.some((a) => /expires=Thu, 01 Jan 1970/i.test(a) || /max-age=0\b/i.test(a))) cookies.delete(k!);
        else cookies.set(k!, v);
      }
      return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
    };
    return { req, cookies };
  }

  it('adds accounts, switches between them and logs out into the next one', async () => {
    const b = jar();
    const first = await b.req('POST', '/api/auth/register', { username: 'multi1', password: 'secret123', firstName: 'M1' });
    expect(first.status).toBe(200);

    expect((await b.req('POST', '/api/auth/accounts/add')).status).toBe(200);
    expect((await b.req('GET', '/api/auth/me')).status).toBe(401);
    const waiting = await b.req('GET', '/api/auth/accounts');
    expect(waiting.body.map((a: any) => [a.username, a.current])).toEqual([['multi1', false]]);

    const second = await b.req('POST', '/api/auth/register', { username: 'multi2', password: 'secret123', firstName: 'M2' });
    expect(second.status).toBe(200);
    let list = await b.req('GET', '/api/auth/accounts');
    expect(list.body.map((a: any) => [a.username, a.current])).toEqual([
      ['multi2', true],
      ['multi1', false],
    ]);

    // the account that is not open shows its unread messages
    const before = list.body[1].unread;
    const chat = await b.req('POST', '/api/chats/private', { userId: first.body.id });
    await b.req('POST', `/api/chats/${chat.body.id}/messages`, { text: 'hi', clientId: 'multi-1' });
    list = await b.req('GET', '/api/auth/accounts');
    expect(list.body[1].unread).toBe(before + 1);

    // a chat muted for a while is not counted until the time is up
    const { db } = await import('../src/db.js');
    const muteUntil = (until: number | null) =>
      db.prepare('UPDATE chat_members SET notify_muted = ?, notify_muted_until = ? WHERE chat_id = ? AND user_id = ?').run(until === null ? 0 : 1, until, chat.body.id, first.body.id);
    muteUntil(Date.now() + 3600_000);
    expect((await b.req('GET', '/api/auth/accounts')).body[1].unread).toBe(before);
    muteUntil(Date.now() - 1);
    expect((await b.req('GET', '/api/auth/accounts')).body[1].unread).toBe(before + 1);
    muteUntil(null);

    expect((await b.req('POST', '/api/auth/accounts/switch', { userId: first.body.id })).status).toBe(200);
    expect((await b.req('GET', '/api/auth/me')).body.username).toBe('multi1');
    list = await b.req('GET', '/api/auth/accounts');
    expect(list.body.map((a: any) => [a.username, a.current])).toEqual([
      ['multi1', true],
      ['multi2', false],
    ]);
    expect((await b.req('POST', '/api/auth/accounts/switch', { userId: 999999 })).status).toBe(404);

    // signing in again to an account that is already here does not duplicate it
    await b.req('POST', '/api/auth/accounts/add');
    await b.req('POST', '/api/auth/login', { username: 'multi2', password: 'secret123' });
    list = await b.req('GET', '/api/auth/accounts');
    expect(list.body.map((a: any) => a.username)).toEqual(['multi2', 'multi1']);

    // three accounts without premium
    await b.req('POST', '/api/auth/accounts/add');
    await b.req('POST', '/api/auth/register', { username: 'multi3', password: 'secret123', firstName: 'M3' });
    const tooMany = await b.req('POST', '/api/auth/accounts/add');
    expect(tooMany.status).toBe(403);
    expect(tooMany.body.error).toBe('accounts_limit');

    const out = await b.req('POST', '/api/auth/logout');
    expect(out.body.switched).toBe(true);
    expect((await b.req('GET', '/api/auth/me')).body.username).toBe('multi2');
    await b.req('POST', '/api/auth/logout');
    expect((await b.req('GET', '/api/auth/me')).body.username).toBe('multi1');
    const last = await b.req('POST', '/api/auth/logout');
    expect(last.body.switched).toBe(false);
    expect((await b.req('GET', '/api/auth/me')).status).toBe(401);
    expect((await b.req('GET', '/api/auth/accounts')).body).toEqual([]);
  });
});

describe('interface labels', () => {
  it('lets the admin replace texts, applies server ones at once and brings the defaults back', async () => {
    const r = await login('admin', 'adminpass');
    const admin = await client(String(r.headers['set-cookie']).split(';')[0]!, JSON.parse(r.body).id);
    const user = await register('labeluser');

    const initial = await admin.req('GET', '/api/admin/labels');
    expect(initial.status).toBe(200);
    const def = initial.body.serverDefaults.find((d: { key: string }) => d.key === 'server.service.renamed');
    expect(def).toMatchObject({ text: '{1} изменил(а) название группы на «{2}»', args: 2 });
    expect(initial.body.serverDefaults.some((d: { key: string }) => d.key === 'server.locale')).toBe(false);

    expect((await user.req('PUT', '/api/admin/labels', { set: { 'settings.aboutText': 'x' } })).status).toBe(403);
    expect((await admin.req('PUT', '/api/admin/labels', { set: { 'bad key!': 'x' } })).status).toBe(400);

    const saved = await admin.req('PUT', '/api/admin/labels', {
      set: { 'settings.aboutText': 'Лучший мессенджер', 'server.errors.userNotFound': 'Нет такого: {1}' },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.labels['settings.aboutText']).toBe('Лучший мессенджер');
    // everybody, even without a session, gets the texts
    const pub = await app.inject({ method: 'GET', url: '/api/app/labels' });
    expect(JSON.parse(pub.body).labels['settings.aboutText']).toBe('Лучший мессенджер');
    const status = await app.inject({ method: 'GET', url: '/api/app/status' });
    expect(JSON.parse(status.body).labelsVersion).toBe(saved.body.version);
    expect(JSON.parse(status.body).labels).toBeUndefined();
    // server texts change right away
    expect((await user.req('GET', '/api/users/999999')).body.message).toBe('Нет такого: {1}');

    const before = JSON.parse(status.body).buildId;
    const reset = await admin.req('PUT', '/api/admin/labels', { set: { 'server.errors.userNotFound': null }, reload: true });
    expect(reset.body.labels).toEqual({ 'settings.aboutText': 'Лучший мессенджер' });
    expect((await user.req('GET', '/api/users/999999')).body.message).toBe('Пользователь не найден');
    const after = await app.inject({ method: 'GET', url: '/api/app/status' });
    expect(JSON.parse(after.body).buildId).toBe(before + 1);
  });
});

describe('multiplayer games on ТК', () => {
  const setup = async (a: string, b: string) => {
    const admin = await sharedAdmin();
    const p1 = await register(a);
    const p2 = await register(b);
    for (const p of [p1, p2]) await admin.req('POST', '/api/admin/bank/give', { userId: p.id, amount: 100, set: true, notify: false });
    return { admin, p1, p2 };
  };
  const balance = async (c: Client) => (await c.req('GET', '/api/bank')).body.balance as number;

  it('duel: invite needs Премиум, stakes go to the winner', async () => {
    const { admin, p1, p2 } = await setup('duel_a', 'duel_b');
    expect((await p1.req('POST', '/api/pvp', { game: 'duel', userId: p2.id, stake: 30 })).body.error).toBe('premium_required');
    await admin.req('POST', `/api/admin/users/${p1.id}/premium`, { action: 'give', days: 30, notify: false });
    // Премиум brings its weekly bonus: start both from the same balance
    await admin.req('POST', '/api/admin/bank/give', { userId: p1.id, amount: 100, set: true, notify: false });
    expect((await p1.req('POST', '/api/pvp', { game: 'duel', userId: p1.id, stake: 30 })).status).toBe(400);
    const inv = await p1.req('POST', '/api/pvp', { game: 'duel', userId: p2.id, stake: 30 });
    expect(inv.body).toMatchObject({ status: 'pending', stake: 30, game: 'duel' });
    // one open game per pair; the inviter cannot accept for the other side
    expect((await p1.req('POST', '/api/pvp', { game: 'dice', userId: p2.id, stake: 5 })).status).toBe(400);
    expect((await p1.req('POST', `/api/pvp/${inv.body.id}/accept`)).status).toBe(403);
    expect((await p2.req('GET', '/api/pvp')).body.some((m: { id: number }) => m.id === inv.body.id)).toBe(true);

    let m = (await p2.req('POST', `/api/pvp/${inv.body.id}/accept`)).body;
    expect(m.status).toBe('active');
    expect(await balance(p1)).toBe(70);
    expect(await balance(p2)).toBe(70);
    expect(m.aim).toEqual({ [p1.id]: 30, [p2.id]: 30 });

    const byId = { [p1.id]: p1, [p2.id]: p2 };
    const waiting = byId[m.turn === p1.id ? p2.id : p1.id]!;
    expect((await waiting.req('POST', `/api/pvp/${m.id}/move`, { action: 'shoot' })).status).toBe(400);
    expect((await byId[m.turn]!.req('POST', `/api/pvp/${m.id}/move`, { action: 'roll' })).status).toBe(400);
    // aim raises the own chance, knock resets the other's
    const first = m.turn as number;
    m = (await byId[first]!.req('POST', `/api/pvp/${m.id}/move`, { action: 'aim' })).body;
    expect(m.aim[first]).toBe(50);
    m = (await byId[m.turn]!.req('POST', `/api/pvp/${m.id}/move`, { action: 'knock' })).body;
    expect(m.aim[first]).toBe(30);
    for (let i = 0; i < 4; i++) m = (await byId[m.turn]!.req('POST', `/api/pvp/${m.id}/move`, { action: 'aim' })).body;
    expect(m.aim[first]).toBe(70);
    for (let i = 0; i < 4; i++) m = (await byId[m.turn]!.req('POST', `/api/pvp/${m.id}/move`, { action: 'aim' })).body;
    expect(m.aim[first]).toBe(90);
    for (let i = 0; i < 200 && m.status === 'active'; i++) {
      m = (await byId[m.turn]!.req('POST', `/api/pvp/${m.id}/move`, { action: 'shoot' })).body;
    }
    expect(m.status).toBe('finished');
    const winner = byId[m.winnerId]!;
    const loser = winner === p1 ? p2 : p1;
    expect(await balance(winner)).toBe(130);
    expect(await balance(loser)).toBe(70);
    expect((await winner.req('POST', `/api/pvp/${m.id}/move`, { action: 'shoot' })).status).toBe(400);
  });

  it('dice: ties are rolled again, a missed move times out', async () => {
    const { admin, p1, p2 } = await setup('dice_a', 'dice_b');
    await admin.req('POST', `/api/admin/users/${p1.id}/premium`, { action: 'give', days: 30, notify: false });
    // Премиум brings its weekly bonus: start both from the same balance
    await admin.req('POST', '/api/admin/bank/give', { userId: p1.id, amount: 100, set: true, notify: false });
    expect((await p1.req('POST', '/api/pvp', { game: 'dice', userId: p2.id, stake: 500 })).body.error).toBe('insufficient_funds');
    await admin.req('POST', '/api/admin/bank/give', { userId: p1.id, amount: 900, notify: false });
    // not enough coins on the invited side
    const big = await p1.req('POST', '/api/pvp', { game: 'dice', userId: p2.id, stake: 500 });
    expect((await p2.req('POST', `/api/pvp/${big.body.id}/accept`)).body.error).toBe('insufficient_funds');
    expect((await p2.req('POST', `/api/pvp/${big.body.id}/decline`)).body.status).toBe('declined');

    const inv = await p1.req('POST', '/api/pvp', { game: 'dice', userId: p2.id, stake: 10 });
    let m = (await p2.req('POST', `/api/pvp/${inv.body.id}/accept`)).body;
    for (let i = 0; i < 100 && m.status === 'active'; i++) {
      await p1.req('POST', `/api/pvp/${m.id}/move`, { action: 'roll' });
      expect((await p1.req('POST', `/api/pvp/${m.id}/move`, { action: 'roll' })).status).toBe(400);
      m = (await p2.req('POST', `/api/pvp/${m.id}/move`, { action: 'roll' })).body;
    }
    expect(m.status).toBe('finished');
    const rolls = m.moves.filter((x: { round: number }) => x.round === m.round);
    expect(rolls).toHaveLength(2);
    expect(rolls[0].roll).not.toBe(rolls[1].roll);
    const total = (await balance(p1)) + (await balance(p2));
    expect(total).toBe(1100);

    // a duel whose player does not move is lost by them
    const { tickPvp } = await import('../src/bank/pvp.js');
    const d = await p1.req('POST', '/api/pvp', { game: 'duel', userId: p2.id, stake: 5 });
    const started = (await p2.req('POST', `/api/pvp/${d.body.id}/accept`)).body;
    tickPvp(Date.now() + 10 * 60_000);
    const over = (await p1.req('GET', `/api/pvp/${d.body.id}`)).body;
    expect(over).toMatchObject({ status: 'finished', forfeit: true });
    expect(over.winnerId).not.toBe(started.turn);
    // an unanswered invite expires
    const e = await p1.req('POST', '/api/pvp', { game: 'dice', userId: p2.id, stake: 5 });
    tickPvp(Date.now() + 60 * 60_000);
    expect((await p2.req('GET', `/api/pvp/${e.body.id}`)).body.status).toBe('expired');
  });
});

describe('стикеры', () => {
  async function uploadPng(c: Client) {
    const sharp = (await import('sharp')).default;
    const png = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 50, g: 120, b: 230, alpha: 1 } } })
      .png()
      .toBuffer();
    const boundary = '----s';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="s.png"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const r = await app.inject({
      method: 'POST',
      url: '/api/files',
      payload,
      headers: { cookie: c.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    expect(r.statusCode).toBe(200);
    return JSON.parse(r.body).id as string;
  }

  it('sends built-in stickers without Премиум, makes packs only with it and shares them by a link', async () => {
    const admin = await sharedAdmin();
    const a = await register('stick_a');
    const b = await register('stick_b');
    const chat = (await a.req('POST', '/api/chats/private', { userId: b.id })).body;

    const sent = await a.req('POST', `/api/chats/${chat.id}/messages`, { stickerId: 'tg:lol' });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ kind: 'sticker', text: '😂', sticker: { id: 'tg:lol', fileId: null, packId: null } });
    expect((await a.req('PATCH', `/api/messages/${sent.body.id}`, { text: 'x' })).status).toBe(403);
    expect((await a.req('POST', `/api/chats/${chat.id}/messages`, { stickerId: 'tg:nope' })).status).toBe(404);

    // no Премиум: no own packs
    expect((await a.req('POST', '/api/stickers/packs', { title: 'Мой пак' })).status).toBe(403);
    await admin.req('POST', `/api/admin/users/${a.id}/premium`, { action: 'give', days: 30 });

    const pack = (await a.req('POST', '/api/stickers/packs', { title: 'Мой пак' })).body;
    expect(pack).toMatchObject({ title: 'Мой пак', mine: true, added: true, stickers: [] });
    const f1 = await uploadPng(a);
    const f2 = await uploadPng(a);
    await a.req('POST', `/api/stickers/packs/${pack.id}/stickers`, { fileId: f1, emoji: '😀' });
    const two = (await a.req('POST', `/api/stickers/packs/${pack.id}/stickers`, { fileId: f2, emoji: '🔥' })).body;
    expect(two.stickers.map((s: { emoji: string }) => s.emoji)).toEqual(['😀', '🔥']);
    // somebody else's picture does not become a sticker
    const foreign = await uploadPng(b);
    expect((await a.req('POST', `/api/stickers/packs/${pack.id}/stickers`, { fileId: foreign, emoji: '😀' })).status).toBe(400);

    const moved = (await a.req('PATCH', `/api/stickers/${two.stickers[1].id}`, { position: 0, emoji: '💯' })).body;
    expect(moved.stickers.map((s: { emoji: string }) => s.emoji)).toEqual(['💯', '😀']);
    expect((await a.req('PATCH', `/api/stickers/packs/${pack.id}`, { title: 'Новое имя' })).body.title).toBe('Новое имя');

    // b opens the link, adds the pack, sends a sticker from it, but cannot edit it
    const shared = (await b.req('GET', `/api/stickers/share/${pack.token}`)).body;
    expect(shared).toMatchObject({ id: pack.id, mine: false, added: false });
    expect((await b.req('POST', `/api/stickers/packs/${pack.id}/add`)).body.added).toBe(true);
    expect((await b.req('GET', '/api/stickers')).body.packs.map((p: { id: number }) => p.id)).toEqual([pack.id]);
    expect((await b.req('PATCH', `/api/stickers/packs/${pack.id}`, { title: 'чужой' })).status).toBe(403);
    const custom = await b.req('POST', `/api/chats/${chat.id}/messages`, { stickerId: moved.stickers[0].id });
    expect(custom.body.sticker).toMatchObject({ fileId: f2, emoji: '💯', packId: pack.id });

    // a new link replaces the old one
    const relinked = (await a.req('POST', `/api/stickers/packs/${pack.id}/link`)).body;
    expect((await b.req('GET', `/api/stickers/share/${pack.token}`)).status).toBe(404);
    expect(relinked.token).not.toBe(pack.token);

    // deleting a sticker and the pack; the sent sticker stays, without its pack
    expect((await a.req('DELETE', `/api/stickers/${moved.stickers[1].id}`)).body.stickers).toHaveLength(1);
    expect((await a.req('DELETE', `/api/stickers/packs/${pack.id}`)).status).toBe(200);
    expect((await b.req('GET', '/api/stickers')).body.packs).toEqual([]);
    const after = (await b.req('GET', `/api/messages/${custom.body.id}`)).body;
    expect(after.sticker).toMatchObject({ fileId: f2, packId: null });
  });

  it('serves stickers in small copies with their transparency, and keeps a moving picture as it is', async () => {
    const admin = await sharedAdmin();
    const a = await register('stick_small');
    await admin.req('POST', `/api/admin/users/${a.id}/premium`, { action: 'give', days: 30 });
    const sharp = (await import('sharp')).default;
    const upload = async (png: Buffer, mime = 'image/png') => {
      const boundary = '----t';
      const payload = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="s.png"\r\nContent-Type: ${mime}\r\n\r\n`),
        png,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const r = await app.inject({ method: 'POST', url: '/api/files', payload, headers: { cookie: a.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` } });
      return JSON.parse(r.body).id as string;
    };
    // a big picture with a see-through corner
    const big = await sharp({ create: { width: 1400, height: 1400, channels: 4, background: { r: 230, g: 60, b: 60, alpha: 0 } } })
      .composite([{ input: await sharp({ create: { width: 700, height: 700, channels: 4, background: { r: 20, g: 120, b: 220, alpha: 1 } } }).png().toBuffer(), left: 350, top: 350 }])
      .png()
      .toBuffer();
    const id = await upload(big);
    const pack = (await a.req('POST', '/api/stickers/packs', { title: 'Мелкие' })).body;
    await a.req('POST', `/api/stickers/packs/${pack.id}/stickers`, { fileId: id, emoji: '😀' });
    const get = (q: string) => app.inject({ method: 'GET', url: `/api/files/${id}${q}`, headers: { cookie: a.cookie } });
    const original = await get('');
    const large = await get('?sticker=1');
    const small = await get('?sticker=s');
    expect(large.headers['content-type']).toBe('image/webp');
    expect(large.headers['cache-control']).toContain('immutable');
    const lm = await sharp(large.rawPayload).metadata();
    const sm = await sharp(small.rawPayload).metadata();
    expect(Math.max(lm.width!, lm.height!)).toBe(512);
    expect(Math.max(sm.width!, sm.height!)).toBe(224);
    expect(lm.hasAlpha).toBe(true);
    // the corner is still see-through, the middle is not
    const { data, info } = await sharp(small.rawPayload).raw().ensureAlpha().toBuffer({ resolveWithObject: true });
    expect(data[3]).toBe(0);
    expect(data[((info.height >> 1) * info.width + (info.width >> 1)) * 4 + 3]).toBe(255);
    expect(small.rawPayload.length).toBeLessThan(original.rawPayload.length / 4);

    // a moving WebP is not flattened into one frame
    const frames = await sharp(
      Buffer.concat([0, 1].map((i) => Buffer.alloc(64 * 64 * 4, i ? 255 : 40))),
      { raw: { width: 64, height: 64 * 2, channels: 4, pageHeight: 64 } },
    )
      .webp({ loop: 0, delay: [100, 100] })
      .toBuffer();
    const moving = await upload(frames, 'image/webp');
    const orig2 = await app.inject({ method: 'GET', url: `/api/files/${moving}`, headers: { cookie: a.cookie } });
    const asSticker = await app.inject({ method: 'GET', url: `/api/files/${moving}?sticker=1`, headers: { cookie: a.cookie } });
    expect(asSticker.rawPayload.equals(orig2.rawPayload)).toBe(true);
  });

  it('allows at most 10 own packs', async () => {
    const admin = await sharedAdmin();
    const u = await register('stick_c');
    await admin.req('POST', `/api/admin/users/${u.id}/premium`, { action: 'give', days: 30 });
    for (let i = 0; i < 10; i++) expect((await u.req('POST', '/api/stickers/packs', { title: `П${i}` })).status).toBe(200);
    expect((await u.req('POST', '/api/stickers/packs', { title: 'лишний' })).status).toBe(400);
  });
});

describe('ссылки-приглашения, заявки, статистика и хэштеги', () => {
  it('limits a link by people and time, and joins through approval', async () => {
    const owner = await register('invowner');
    const a = await register('inva');
    const b = await register('invb');
    const c = await register('invc');
    const g = (await owner.req('POST', '/api/chats/group', { title: 'Inv', memberIds: [] })).body;

    // a link for one person
    const one = await owner.req('POST', `/api/chats/${g.id}/invites`, { title: 'Один', usageLimit: 1 });
    expect(one.status).toBe(200);
    expect(one.body.active).toBe(true);
    expect((await a.req('POST', `/api/invite/${one.body.token}`)).body.id).toBe(g.id);
    const used = await b.req('POST', `/api/invite/${one.body.token}`);
    expect(used.status).toBe(404);
    expect((await b.req('GET', `/api/invite/${one.body.token}`)).status).toBe(404);

    // outsiders cannot manage links
    expect((await b.req('GET', `/api/chats/${g.id}/invites`)).status).toBe(403);
    // an expired date is refused
    expect((await owner.req('POST', `/api/chats/${g.id}/invites`, { expiresAt: Date.now() - 1000 })).status).toBe(400);

    // approval: the link sends a request, the admin sees it and lets them in
    const appr = (await owner.req('POST', `/api/chats/${g.id}/invites`, { title: 'Заявки', approval: true })).body;
    const preview = (await b.req('GET', `/api/invite/${appr.token}`)).body;
    expect(preview.approval).toBe(true);
    expect((await b.req('POST', `/api/invite/${appr.token}`)).body).toEqual({ requested: true });
    expect((await c.req('POST', `/api/invite/${appr.token}`)).body).toEqual({ requested: true });
    expect((await b.req('GET', `/api/invite/${appr.token}`)).body.requested).toBe(true);
    expect((await owner.req('GET', `/api/chats/${g.id}`)).body.pendingRequests).toBe(2);
    const reqs = (await owner.req('GET', `/api/chats/${g.id}/requests`)).body as { user: { id: number }; via: string }[];
    expect(reqs.map((r) => r.user.id).sort()).toEqual([b.id, c.id].sort());
    expect(reqs[0]!.via).toBe('Заявки');
    await owner.req('POST', `/api/chats/${g.id}/requests/${b.id}`, { approve: true });
    await owner.req('POST', `/api/chats/${g.id}/requests/${c.id}`, { approve: false });
    expect((await b.req('GET', `/api/chats/${g.id}`)).body.me.isMember).toBe(true);
    expect((await c.req('GET', `/api/chats/${g.id}`)).status).toBe(403);
    const links = (await owner.req('GET', `/api/chats/${g.id}/invites`)).body as { token: string; uses: number }[];
    expect(links.find((l) => l.token === appr.token)!.uses).toBe(1);

    // revoked links stop working
    await owner.req('POST', `/api/chats/${g.id}/invites/${appr.token}/revoke`);
    expect((await c.req('POST', `/api/invite/${appr.token}`)).status).toBe(404);
    expect((await owner.req('DELETE', `/api/chats/${g.id}/invites/${appr.token}`)).status).toBe(200);
  });

  it('public chats with approval turn the join button into a request', async () => {
    const owner = await register('pubapprowner');
    const d = await register('pubapprd');
    const ch = (await owner.req('POST', '/api/chats/channel', { title: 'Approve', isPublic: true, publicUsername: 'approvechan' })).body;
    await owner.req('PATCH', `/api/chats/${ch.id}`, { joinApproval: true });
    expect((await d.req('POST', `/api/chats/${ch.id}/join`)).body).toEqual({ requested: true });
    expect((await d.req('GET', `/api/chats/${ch.id}`)).body.joinRequested).toBe(true);
    await d.req('DELETE', `/api/chats/${ch.id}/request`);
    expect((await d.req('GET', `/api/chats/${ch.id}`)).body.joinRequested).toBe(false);
  });

  it('counts subscribers, views and shares for admins only', async () => {
    const owner = await register('statowner');
    const s1 = await register('stats1');
    const s2 = await register('stats2');
    const ch = (await owner.req('POST', '/api/chats/channel', { title: 'Stat', isPublic: true, publicUsername: 'statchan' })).body;
    await s1.req('POST', `/api/chats/${ch.id}/join`);
    await s2.req('POST', `/api/chats/${ch.id}/join`);
    await s2.req('POST', `/api/chats/${ch.id}/leave`);
    const post = (await owner.req('POST', `/api/chats/${ch.id}/messages`, { text: 'Новость #важное' })).body;
    await s1.req('POST', `/api/chats/${ch.id}/read`, { messageId: post.id });
    const pm = (await s1.req('POST', '/api/chats/private', { userId: owner.id })).body;
    await s1.req('POST', '/api/messages/forward', { ids: [post.id], fromChatId: ch.id, toChatId: pm.id });

    expect((await s1.req('GET', `/api/chats/${ch.id}/stats`)).status).toBe(403);
    const st = (await owner.req('GET', `/api/chats/${ch.id}/stats?tz=-180`)).body;
    expect(st.members).toBe(2);
    expect(st.days).toHaveLength(30);
    expect(st.days.at(-1).members).toBe(2);
    expect(st.joins30).toBe(3);
    expect(st.leaves30).toBe(1);
    expect(st.growth7).toBe(2);
    expect(st.days.at(-1).messages).toBe(1);
    const p = st.posts.find((x: { message: { id: number } }) => x.message.id === post.id);
    expect(p.views).toBe(2);
    expect(p.shares).toBe(1);

    // hashtags: "#важное" finds the tag, the plain word does not need a "#"
    await owner.req('POST', `/api/chats/${ch.id}/messages`, { text: 'просто важное без тега' });
    const found = (await owner.req('GET', `/api/chats/${ch.id}/search?q=${encodeURIComponent('#Важное')}`)).body;
    expect(found.messages.map((m: { id: number }) => m.id)).toEqual([post.id]);
    const plain = (await owner.req('GET', `/api/chats/${ch.id}/search?q=${encodeURIComponent('важное')}`)).body;
    expect(plain.messages).toHaveLength(2);
  });
});

describe('chat list: mark unread, read all, export', () => {
  it('marks a chat as unread by hand and clears it when the chat is read', async () => {
    const a = await register('munr_a');
    const b = await register('munr_b');
    const chat = (await a.req('POST', '/api/chats/private', { userId: b.id })).body;
    const m = (await a.req('POST', `/api/chats/${chat.id}/messages`, { text: 'привет' })).body;
    await b.req('POST', `/api/chats/${chat.id}/read`, { messageId: m.id });
    expect((await b.req('GET', `/api/chats/${chat.id}`)).body.markedUnread).toBe(false);

    const on = (await b.req('POST', `/api/chats/${chat.id}/unread`, { unread: true })).body;
    expect(on.markedUnread).toBe(true);
    expect(on.unreadCount).toBe(0);
    // it is personal
    expect((await a.req('GET', `/api/chats/${chat.id}`)).body.markedUnread).toBe(false);
    // not a member: no
    const c = await register('munr_c');
    expect((await c.req('POST', `/api/chats/${chat.id}/unread`, { unread: true })).status).toBe(400);

    // reading the chat (even at the same message) clears the mark
    await b.req('POST', `/api/chats/${chat.id}/read`, { messageId: m.id });
    expect((await b.req('GET', `/api/chats/${chat.id}`)).body.markedUnread).toBe(false);
    // and it can be taken back
    await b.req('POST', `/api/chats/${chat.id}/unread`, { unread: true });
    expect((await b.req('POST', `/api/chats/${chat.id}/unread`, { unread: false })).body.markedUnread).toBe(false);
  });

  it('reads all chats at once', async () => {
    const a = await register('rall_a');
    const b = await register('rall_b');
    const c = await register('rall_c');
    const ab = (await a.req('POST', '/api/chats/private', { userId: b.id })).body;
    const ac = (await a.req('POST', '/api/chats/private', { userId: c.id })).body;
    await b.req('POST', `/api/chats/${ab.id}/messages`, { text: 'one' });
    await b.req('POST', `/api/chats/${ab.id}/messages`, { text: 'two' });
    await c.req('POST', `/api/chats/${ac.id}/messages`, { text: 'three' });
    await a.req('POST', `/api/chats/${ac.id}/unread`, { unread: true });
    const before = (await a.req('GET', '/api/chats')).body as { id: number; unreadCount: number }[];
    expect(before.find((x) => x.id === ab.id)!.unreadCount).toBe(2);

    const r = await a.req('POST', '/api/chats/read-all');
    expect(r.status).toBe(200);
    expect(r.body.count).toBeGreaterThanOrEqual(2);
    const after = (await a.req('GET', '/api/chats')).body as { id: number; unreadCount: number; markedUnread: boolean }[];
    expect(after.every((x) => x.unreadCount === 0 && !x.markedUnread)).toBe(true);
    // the senders see the messages as read
    expect((await b.req('GET', `/api/chats/${ab.id}`)).body.othersReadId).toBeGreaterThan(0);
    // nothing left: a second call touches nothing
    expect((await a.req('POST', '/api/chats/read-all')).body.count).toBe(0);
  });

  it('exports a chat as a text file', async () => {
    const a = await register('exp_a');
    const b = await register('exp_b');
    const c = await register('exp_c');
    const chat = (await a.req('POST', '/api/chats/private', { userId: b.id })).body;
    const first = (await a.req('POST', `/api/chats/${chat.id}/messages`, { text: '**Привет**, мир' })).body;
    await b.req('POST', `/api/chats/${chat.id}/messages`, { text: 'ответ\nна двух строках', replyToId: first.id });
    await a.req('POST', `/api/chats/${chat.id}/polls`, { question: 'Идём?', options: ['да', 'нет'] });

    const res = await app.inject({ method: 'GET', url: `/api/chats/${chat.id}/export?tz=-180`, headers: { cookie: a.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(String(res.headers['content-disposition'])).toContain('attachment');
    const lines = res.body.trim().split('\n');
    expect(lines[0]).toContain('exp_b');
    expect(lines[0]).toContain('сообщений: 3');
    expect(res.body).toMatch(/\] exp_a: Привет, мир/);
    expect(res.body).toMatch(/\] exp_b: ↩ «Привет, мир» ответ\n {4}на двух строках/);
    expect(res.body).toContain('📊 Идём?');
    // the time follows the viewer's zone (tz = Date.getTimezoneOffset)
    const stamp = async (tz: number) => {
      const r = await app.inject({ method: 'GET', url: `/api/chats/${chat.id}/export?tz=${tz}`, headers: { cookie: a.cookie } });
      const [, h, min] = /\[\d{4}-\d\d-\d\d (\d\d):(\d\d)\]/.exec(r.body.split('\n')[2]!)!;
      return (Number(h) * 60 + Number(min) + 1440) % 1440;
    };
    const utc = await stamp(0);
    expect([180, 181]).toContain(((await stamp(-180)) - utc + 1440) % 1440);

    // only for people who may see the chat; tz is optional
    expect((await app.inject({ method: 'GET', url: `/api/chats/${chat.id}/export`, headers: { cookie: c.cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: `/api/chats/${chat.id}/export`, headers: { cookie: b.cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `/api/chats/${chat.id}/export` })).statusCode).toBe(401);
  });
});

describe('device bans', () => {
  const D1 = 'testdevice-one-aaaaaaaa';
  const D2 = 'testdevice-two-bbbbbbbb';
  const withDevice = (device: string, cookie = '') => ({ cookie: [`tg_device=${device}`, cookie].filter(Boolean).join('; ') });
  let ip = 0;
  const signUp = (username: string, device: string) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/register',
      remoteAddress: `10.9.${Math.floor(++ip / 250)}.${ip % 250}`,
      headers: withDevice(device),
      payload: { username, password: 'secret123', firstName: username },
    });
  const signIn = (username: string, device: string) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: `10.8.${Math.floor(++ip / 250)}.${ip % 250}`,
      headers: withDevice(device),
      payload: { username, password: 'secret123' },
    });
  const sessionOf = (r: { headers: Record<string, unknown> }) => String(([] as string[]).concat(r.headers['set-cookie'] as string[]).find((c) => c.startsWith('tg_session='))).split(';')[0]!;

  it('hands out a device cookie on the first request and keeps it', async () => {
    const first = await app.inject({ method: 'GET', url: '/api/app/status' });
    const set = ([] as string[]).concat(first.headers['set-cookie'] as string[]).find((c) => c.startsWith('tg_device='));
    expect(set).toBeTruthy();
    expect(set).not.toContain('HttpOnly');
    // with the cookie there is nothing to hand out
    const again = await app.inject({ method: 'GET', url: '/api/app/status', headers: withDevice(D1) });
    expect(again.headers['set-cookie']).toBeUndefined();
    // junk in the cookie is replaced
    const junk = await app.inject({ method: 'GET', url: '/api/app/status', headers: { cookie: 'tg_device=<script>' } });
    expect(String(junk.headers['set-cookie'])).toContain('tg_device=');
  });

  it('a banned device cannot register, sign in or use accounts that are already open', async () => {
    const admin = await sharedAdmin();
    const a = await signUp('devban_a', D1);
    expect(a.statusCode).toBe(200);
    const b = await signUp('devban_b', D2);
    expect(b.statusCode).toBe(200);
    const bCookie = sessionOf(b);

    // the admin sees the device with the account
    const detail = (await admin.req('GET', `/api/admin/users/${JSON.parse(a.body).id}`)).body;
    expect(detail.devices.map((d: { id: string }) => d.id)).toEqual([D1]);
    expect(detail.devices[0].banned).toBe(false);

    // device only, the account itself stays untouched
    expect((await admin.req('POST', `/api/admin/devices/${D1}/ban?userId=${JSON.parse(a.body).id}`, { reason: 'спам' })).status).toBe(200);
    expect((await admin.req('GET', `/api/admin/users/${JSON.parse(a.body).id}`)).body.isBanned).toBe(false);

    const reg = await signUp('devban_new', D1);
    expect(reg.statusCode).toBe(403);
    expect(JSON.parse(reg.body)).toMatchObject({ error: 'banned', device: true, reason: 'спам' });
    expect((await signIn('devban_b', D1)).statusCode).toBe(403);
    expect((await signIn('devban_a', D1)).statusCode).toBe(403);
    // an account that is already open here is cut off too
    const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: withDevice(D1, bCookie) });
    expect(me.statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/chats', headers: withDevice(D1, bCookie) })).statusCode).toBe(403);

    // other devices are not affected, the banned account included
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: withDevice(D2, bCookie) })).statusCode).toBe(200);
    expect((await signIn('devban_a', D2)).statusCode).toBe(200);
    expect((await signUp('devban_c', D2)).statusCode).toBe(200);
    // the admin is never locked out
    const adm = await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '10.7.0.1', headers: withDevice(D1), payload: { username: 'admin', password: 'adminpass' } });
    expect(adm.statusCode).toBe(200);

    // the list of banned devices, and lifting the ban
    const list = (await admin.req('GET', '/api/admin/devices/banned')).body as { id: string; username: string }[];
    expect(list.find((d) => d.id === D1)!.username).toBe('devban_a');
    expect((await admin.req('POST', `/api/admin/devices/${D1}/unban`)).status).toBe(200);
    expect((await admin.req('POST', `/api/admin/devices/${D1}/unban`)).status).toBe(404);
    expect((await signUp('devban_new', D1)).statusCode).toBe(200);
  });

  it('banning an account can take its devices along, and unbanning gives them back', async () => {
    const admin = await sharedAdmin();
    const D3 = 'testdevice-three-cccccc';
    const u = await signUp('devban_d', D3);
    const id = JSON.parse(u.body).id;

    // account ban alone leaves the device free
    await admin.req('POST', `/api/admin/users/${id}/ban`, { reason: 'x' });
    expect((await signUp('devban_e', D3)).statusCode).toBe(200);
    await admin.req('POST', `/api/admin/users/${id}/unban`);

    const res = await admin.req('POST', `/api/admin/users/${id}/ban`, { reason: 'мошенник', devices: true });
    expect(res.body).toEqual({ ok: true, devices: 1 });
    expect((await signUp('devban_f', D3)).statusCode).toBe(403);
    expect((await admin.req('GET', `/api/admin/users/${id}`)).body.devices[0]).toMatchObject({ banned: true, banReason: 'мошенник' });
    // the other account seen on the device is listed
    expect((await admin.req('GET', `/api/admin/users/${id}`)).body.devices[0].otherUsers.map((x: { username: string }) => x.username)).toContain('devban_e');

    expect((await admin.req('POST', `/api/admin/users/${id}/unban`)).body).toEqual({ ok: true, devices: 1 });
    expect((await signUp('devban_f', D3)).statusCode).toBe(200);
  });

  it('checks the device id and only bans devices that were seen', async () => {
    const admin = await sharedAdmin();
    expect((await admin.req('POST', '/api/admin/devices/short/ban', {})).status).toBe(400);
    expect((await admin.req('POST', '/api/admin/devices/neverseen-device-0000/ban', {})).status).toBe(404);
    const plain = await register('devban_plain');
    expect((await plain.req('POST', `/api/admin/devices/${D2}/ban`, {})).status).toBe(403);
    expect((await plain.req('GET', '/api/admin/devices/banned')).status).toBe(403);
  });
});

describe('link previews', () => {
  it('are for signed-in users only', async () => {
    const anon = await app.inject({ method: 'GET', url: '/api/link-preview?url=https%3A%2F%2Fexample.com%2F' });
    expect(anon.statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/link-preview/image/0123456789abcdef0123' })).statusCode).toBe(401);
  });

  it('never open the places the server itself can reach', async () => {
    const u = await register('lp_user');
    // answer is "no card", and nothing was fetched: these never leave the machine
    for (const target of [
      'http://127.0.0.1/',
      'http://localhost/',
      'http://[::1]/',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1:8080/',
      'http://2130706433/',
      'http://user:pw@example.com/',
      'http://example.com:22/',
      'file:///etc/passwd',
    ]) {
      const r = await u.req('GET', `/api/link-preview?url=${encodeURIComponent(target)}`);
      expect(r.status, target).toBe(200);
      expect(r.body, target).toEqual({ preview: null });
    }
  });

  it('refuse nonsense and unknown pictures', async () => {
    const u = await register('lp_user2');
    expect((await u.req('GET', '/api/link-preview')).status).toBe(400);
    expect((await u.req('GET', '/api/link-preview?url=not%20a%20url')).status).toBe(400);
    expect((await u.req('GET', `/api/link-preview?url=${encodeURIComponent(`https://example.com/${'a'.repeat(2100)}`)}`)).status).toBe(400);
    expect((await u.req('GET', '/api/link-preview/image/0123456789abcdef0123')).status).toBe(404);
    expect((await u.req('GET', '/api/link-preview/image/..%2F..%2Fetc')).status).toBe(404);
    expect((await u.req('GET', '/api/link-preview/image/ZZZ')).status).toBe(404);
  });

  it('are limited per user', async () => {
    const u = await register('lp_user3');
    let last = 200;
    for (let i = 0; i < 95; i++) last = (await u.req('GET', `/api/link-preview?url=${encodeURIComponent(`http://127.0.0.1/${i}`)}`)).status;
    expect(last).toBe(429);
  });
});

describe('значки, подписи и награды в профиле', () => {
  /** a multipart form with one picture (and a title before it, like the admin panel sends) */
  async function badgeForm(title: string | null, file: Buffer, filename = 'b.png') {
    const boundary = '----timbatest';
    const parts: Buffer[] = [];
    if (title !== null) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\n${title}\r\n`));
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
    parts.push(file, Buffer.from(`\r\n--${boundary}--\r\n`));
    return { payload: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
  }
  const png = (w: number, h: number, color = { r: 255, g: 0, b: 0 }) =>
    sharp({ create: { width: w, height: h, channels: 4, background: { ...color, alpha: 1 } } }).png().toBuffer();

  async function upload(admin: Client, method: 'POST' | 'PUT', url: string, title: string | null, file: Buffer, filename?: string) {
    const f = await badgeForm(title, file, filename);
    const r = await app.inject({ method, url, payload: f.payload, headers: { cookie: admin.cookie, 'content-type': f.contentType } });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  }

  it('shows the admin\'s badge next to the name everywhere and follows changes', async () => {
    const admin = await sharedAdmin();
    const u = await register('bdg_a');
    const o = await register('bdg_b');
    expect((await u.req('GET', '/api/admin/badges')).status).toBe(403);
    expect((await upload(u, 'POST', '/api/admin/badges', 'Свой', await png(8, 8))).status).toBe(403);

    // a title and a real picture are required
    expect((await upload(admin, 'POST', '/api/admin/badges', '  ', await png(8, 8))).status).toBe(400);
    expect((await upload(admin, 'POST', '/api/admin/badges', 'Текст', Buffer.from('not a picture'), 'x.txt')).status).toBe(400);
    expect((await upload(admin, 'POST', '/api/admin/badges', 'a'.repeat(41), await png(8, 8))).status).toBe(400);

    const made = await upload(admin, 'POST', '/api/admin/badges', 'Создатель', await png(40, 10));
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ title: 'Создатель', holders: 0 });
    const id = made.body.id as number;

    // the picture is a square PNG, open to anybody (like the logo), and cached for good
    const img = await app.inject({ method: 'GET', url: `/api/badges/${id}/image?v=${made.body.v}` });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(String(img.headers['cache-control'])).toContain('immutable');
    expect(await sharp(img.rawPayload).metadata()).toMatchObject({ width: 96, height: 96, format: 'png' });
    expect((await app.inject({ method: 'GET', url: '/api/badges/99999/image' })).statusCode).toBe(404);

    // nobody has it yet
    expect((await o.req('GET', `/api/users/${u.id}`)).body.badge).toBeNull();
    expect((await admin.req('POST', `/api/admin/users/${u.id}/badge`, { badgeId: 99999 })).status).toBe(404);
    expect((await u.req('POST', `/api/admin/users/${u.id}/badge`, { badgeId: id })).status).toBe(403);
    const given = await admin.req('POST', `/api/admin/users/${u.id}/badge`, { badgeId: id });
    expect(given.body.badge).toEqual({ id, title: 'Создатель', v: made.body.v });
    expect((await admin.req('GET', '/api/admin/badges')).body.find((b: { id: number }) => b.id === id).holders).toBe(1);

    // the badge comes with the user: profile, own profile, chat list, message senders, search
    expect((await o.req('GET', `/api/users/${u.id}`)).body.badge).toMatchObject({ id, title: 'Создатель' });
    expect((await u.req('GET', '/api/auth/me')).body.badge).toMatchObject({ id });
    const pm = (await o.req('POST', '/api/chats/private', { userId: u.id })).body;
    expect(pm.peer.badge).toMatchObject({ id });
    await u.req('POST', `/api/chats/${pm.id}/messages`, { text: 'привет' });
    const list = (await o.req('GET', `/api/chats/${pm.id}/messages`)).body as { sender: { badge: { id: number } | null } }[];
    expect(list.at(-1)!.sender.badge).toMatchObject({ id });
    expect((await o.req('GET', '/api/search?q=bdg_a')).body.users[0].badge).toMatchObject({ id });
    expect((await admin.req('GET', `/api/admin/users/${u.id}`)).body.badge).toMatchObject({ id });

    // a new picture gets a new version; a new title reaches the wearer
    const newer = await upload(admin, 'PUT', `/api/admin/badges/${id}/image`, null, await png(30, 30, { r: 0, g: 0, b: 255 }));
    expect(newer.status).toBe(200);
    expect(newer.body.v).toBeGreaterThan(made.body.v);
    expect((await admin.req('PATCH', `/api/admin/badges/${id}`, { title: '' })).status).toBe(400);
    expect((await admin.req('PATCH', `/api/admin/badges/${id}`, { title: 'Главный' })).body).toMatchObject({ title: 'Главный', v: newer.body.v });
    expect((await o.req('GET', `/api/users/${u.id}`)).body.badge).toEqual({ id, title: 'Главный', v: newer.body.v });

    // taking it away, and deleting a badge somebody wears
    expect((await admin.req('POST', `/api/admin/users/${u.id}/badge`, { badgeId: null })).body.badge).toBeNull();
    expect((await o.req('GET', `/api/users/${u.id}`)).body.badge).toBeNull();
    await admin.req('POST', `/api/admin/users/${u.id}/badge`, { badgeId: id });
    expect((await admin.req('DELETE', `/api/admin/badges/${id}`)).status).toBe(200);
    expect((await o.req('GET', `/api/users/${u.id}`)).body.badge).toBeNull();
    expect((await admin.req('DELETE', `/api/admin/badges/${id}`)).status).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/api/badges/${id}/image` })).statusCode).toBe(404);
  });

  it('puts coloured captions under the name, up to five', async () => {
    const admin = await sharedAdmin();
    const u = await register('tag_a');
    const o = await register('tag_b');
    expect((await u.req('POST', `/api/admin/users/${u.id}/tags`, { text: 'Сам себе', color: '#00ff00' })).status).toBe(403);
    expect((await admin.req('POST', `/api/admin/users/${u.id}/tags`, { text: '', color: '#e5383b' })).status).toBe(400);
    expect((await admin.req('POST', `/api/admin/users/${u.id}/tags`, { text: 'Скам', color: 'red' })).status).toBe(400);
    expect((await admin.req('POST', `/api/admin/users/${u.id}/tags`, { text: 'Скам', color: '#e5383' })).status).toBe(400);
    expect((await admin.req('POST', `/api/admin/users/${u.id}/tags`, { text: 'x'.repeat(41), color: '#e5383b' })).status).toBe(400);
    expect((await admin.req('POST', `/api/admin/users/99999/tags`, { text: 'Скам', color: '#e5383b' })).status).toBe(404);

    const a = await admin.req('POST', `/api/admin/users/${u.id}/tags`, { text: ' Скам ', color: '#E5383B' });
    expect(a.status).toBe(200);
    expect(a.body.tags).toEqual([{ id: expect.any(Number), text: 'Скам', color: '#e5383b' }]);
    await admin.req('POST', `/api/admin/users/${u.id}/tags`, { text: 'Создатель TimbaGram', color: '#2f9e55' });
    expect((await o.req('GET', `/api/users/${u.id}`)).body.tags.map((t: { text: string }) => t.text)).toEqual(['Скам', 'Создатель TimbaGram']);
    expect((await u.req('GET', '/api/auth/me')).body.tags).toHaveLength(2);
    expect((await admin.req('GET', `/api/admin/users/${u.id}`)).body.tags).toHaveLength(2);

    for (let i = 0; i < 3; i++) expect((await admin.req('POST', `/api/admin/users/${u.id}/tags`, { text: `t${i}`, color: '#2f6fed' })).status).toBe(200);
    expect((await admin.req('POST', `/api/admin/users/${u.id}/tags`, { text: 'лишняя', color: '#2f6fed' })).status).toBe(400);

    // a caption of somebody else is not touched through another user
    const first = a.body.tags[0].id;
    expect((await admin.req('DELETE', `/api/admin/users/${o.id}/tags/${first}`)).status).toBe(404);
    const left = await admin.req('DELETE', `/api/admin/users/${u.id}/tags/${first}`);
    expect(left.body.tags).toHaveLength(4);
    expect(left.body.tags.some((t: { text: string }) => t.text === 'Скам')).toBe(false);
  });

  it('gives awards of degrees 8…1 with a caption and a date', async () => {
    const admin = await sharedAdmin();
    const u = await register('awd_a');
    const o = await register('awd_b');
    expect((await u.req('POST', `/api/admin/users/${u.id}/awards`, { degree: 1 })).status).toBe(403);
    for (const degree of [0, 9, 1.5, -1]) expect((await admin.req('POST', `/api/admin/users/${u.id}/awards`, { degree })).status, String(degree)).toBe(400);
    expect((await admin.req('POST', `/api/admin/users/${u.id}/awards`, { degree: 3, caption: 'x'.repeat(121) })).status).toBe(400);

    const day = Date.UTC(2026, 4, 9, 12);
    await admin.req('POST', `/api/admin/users/${u.id}/awards`, { degree: 8 });
    const second = await admin.req('POST', `/api/admin/users/${u.id}/awards`, { degree: 3, caption: ' За помощь проекту ', awardedAt: day });
    expect(second.status).toBe(200);
    await admin.req('POST', `/api/admin/users/${u.id}/awards`, { degree: 1, caption: 'Навсегда в истории' });

    // the best degree comes first; no date means today
    const awards = (await o.req('GET', `/api/users/${u.id}`)).body.awards as { degree: number; caption: string; awardedAt: number }[];
    expect(awards.map((a) => a.degree)).toEqual([1, 3, 8]);
    expect(awards[1]).toMatchObject({ caption: 'За помощь проекту', awardedAt: day });
    expect(Math.abs(awards[0]!.awardedAt - Date.now())).toBeLessThan(60_000);
    expect(awards[2]!.caption).toBe('');
    expect((await u.req('GET', '/api/auth/me')).body.awards).toHaveLength(3);

    const id = second.body.awards.find((a: { degree: number }) => a.degree === 3).id;
    expect((await admin.req('DELETE', `/api/admin/users/${o.id}/awards/${id}`)).status).toBe(404);
    expect((await admin.req('DELETE', `/api/admin/users/${u.id}/awards/${id}`)).body.awards.map((a: { degree: number }) => a.degree)).toEqual([1, 8]);

    // at most 30 in one profile
    for (let i = 0; i < 28; i++) expect((await admin.req('POST', `/api/admin/users/${u.id}/awards`, { degree: 5 })).status).toBe(200);
    expect((await admin.req('POST', `/api/admin/users/${u.id}/awards`, { degree: 5 })).status).toBe(400);
  });

  it('turns a vector icon (an SVG plate with rounded corners) into a sharp square badge', async () => {
    const admin = await sharedAdmin();
    // what the admin panel makes from a built-in icon: a 24-unit icon on a coloured plate with mild corners
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 96 96"><rect width="96" height="96" rx="20" fill="#2f9e55"/><svg x="22" y="22" width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><path d="M5 21h14"/></svg></svg>`;
    const made = await upload(admin, 'POST', '/api/admin/badges', 'Плашка', Buffer.from(svg), 'icon.svg');
    expect(made.status).toBe(200);
    const img = await app.inject({ method: 'GET', url: `/api/badges/${made.body.id}/image` });
    const raw = await sharp(img.rawPayload).raw().toBuffer({ resolveWithObject: true });
    expect(raw.info).toMatchObject({ width: 96, height: 96, channels: 4 });
    const px = (x: number, y: number) => [...raw.data.subarray((y * 96 + x) * 4, (y * 96 + x) * 4 + 4)];
    // the plate is green and opaque in the middle of an edge, the very corner is rounded off (transparent)
    expect(px(48, 4)).toEqual([47, 158, 85, 255]);
    expect(px(0, 0)[3]).toBe(0);
    await admin.req('DELETE', `/api/admin/badges/${made.body.id}`);
  });

  it('shows my profile the way strangers see it: privacy applies, the rest is the same', async () => {
    const admin = await sharedAdmin();
    const u = await register('prv_a');
    await u.req('PATCH', '/api/me', { phone: '8 (921) 555-11-22', bio: 'Привет' });
    await admin.req('POST', `/api/admin/users/${u.id}/tags`, { text: 'Гость', color: '#2f6fed' });
    await admin.req('POST', `/api/admin/users/${u.id}/awards`, { degree: 2, caption: 'За всё' });
    expect((await app.inject({ method: 'GET', url: '/api/me/profile-preview' })).statusCode).toBe(401);

    // the number is hidden from others by default; the owner still sees it in their own profile
    let seen = (await u.req('GET', '/api/me/profile-preview')).body;
    expect(seen).toMatchObject({ id: u.id, bio: 'Привет', phone: null, blockedByMe: false });
    expect(seen.tags).toHaveLength(1);
    expect(seen.awards[0]).toMatchObject({ degree: 2, caption: 'За всё' });
    expect((await u.req('GET', '/api/auth/me')).body.phone).toBe('+79215551122');

    await u.req('PUT', '/api/me/privacy', { phone: 'everybody', lastSeen: 'nobody' });
    seen = (await u.req('GET', '/api/me/profile-preview')).body;
    expect(seen.phone).toBe('+79215551122');
    // last seen is hidden: only the approximate "recently" shows, never the exact time
    expect(seen.lastSeenAt).toBeNull();
    expect(seen.lastSeenApprox).not.toBeNull();
    // the other side agrees with the preview
    const o = await register('prv_b');
    expect((await o.req('GET', `/api/users/${u.id}`)).body).toMatchObject({ phone: seen.phone, lastSeenAt: null });
  });

  it('sends Премиум with every user: chat peer, message sender, search, profile, admin view', async () => {
    const admin = await sharedAdmin();
    const u = await register('star_a');
    const o = await register('star_b');
    const pm = (await o.req('POST', '/api/chats/private', { userId: u.id })).body;
    expect(pm.peer.premium).toBe(false);
    await admin.req('POST', `/api/admin/users/${u.id}/premium`, { action: 'give', days: 30 });
    expect((await o.req('GET', `/api/chats/${pm.id}`)).body.peer.premium).toBe(true);
    await u.req('POST', `/api/chats/${pm.id}/messages`, { text: 'я с премиумом' });
    const msgs = (await o.req('GET', `/api/chats/${pm.id}/messages`)).body as { sender: { premium: boolean } }[];
    expect(msgs.at(-1)!.sender.premium).toBe(true);
    expect((await o.req('GET', '/api/search?q=star_a')).body.users[0].premium).toBe(true);
    expect((await o.req('GET', `/api/users/${u.id}`)).body.premium).toBe(true);
    expect((await admin.req('GET', `/api/admin/users/${u.id}`)).body.premium).toBe(true);
    await admin.req('POST', `/api/admin/users/${u.id}/premium`, { action: 'remove' });
    expect((await o.req('GET', `/api/chats/${pm.id}`)).body.peer.premium).toBe(false);
  });
});

describe('monthly rating of the games', () => {
  const premium = async (name: string) => {
    const admin = await sharedAdmin();
    const u = await register(name);
    await admin.req('POST', `/api/admin/users/${u.id}/premium`, { action: 'give', days: 400, notify: false });
    return u;
  };

  it('keeps the best result of the month, top 5, lower is better for time', async () => {
    const a = await premium('lb_a');
    const b = await premium('lb_b');
    const free = await register('lb_free');
    const players = [a, b, ...(await Promise.all(['lb_c', 'lb_d', 'lb_e', 'lb_f'].map(premium)))];

    // only Премиум plays; unknown games and absurd results are refused
    expect((await free.req('POST', '/api/games/score', { game: 'tetris', score: 10 })).body.error).toBe('premium_required');
    expect((await a.req('POST', '/api/games/score', { game: 'hangman', score: 10 })).status).toBe(400);
    expect((await a.req('POST', '/api/games/score', { game: 'tetris', score: -5 })).status).toBe(400);
    expect((await a.req('POST', '/api/games/score', { game: 'reaction', score: 5 })).status).toBe(400);
    expect((await free.req('GET', '/api/games/hangman/leaderboard')).status).toBe(400);

    // a worse result does not replace a better one
    await a.req('POST', '/api/games/score', { game: 'tetris', score: 500 });
    await a.req('POST', '/api/games/score', { game: 'tetris', score: 200 });
    await b.req('POST', '/api/games/score', { game: 'tetris', score: 900 });
    for (const [i, p] of players.slice(2).entries()) await p.req('POST', '/api/games/score', { game: 'tetris', score: 100 + i });
    const top = (await free.req('GET', '/api/games/tetris/leaderboard')).body;
    expect(top.entries).toHaveLength(5);
    expect(top.entries.map((e: { score: number }) => e.score)).toEqual([900, 500, 103, 102, 101]);
    expect(top.entries[0].user.id).toBe(b.id);
    expect(top.me).toBeNull();
    // the clicker is rated by rebirths: the more of them, the higher
    await a.req('POST', '/api/games/score', { game: 'clicker', score: 3 });
    await b.req('POST', '/api/games/score', { game: 'clicker', score: 7 });
    await a.req('POST', '/api/games/score', { game: 'clicker', score: 2 });
    const rebirths = (await free.req('GET', '/api/games/clicker/leaderboard')).body;
    expect(rebirths.entries.map((e: { score: number }) => e.score)).toEqual([7, 3]);
    expect(rebirths.entries[0].user.id).toBe(b.id);
    expect((await a.req('POST', '/api/games/score', { game: 'clicker', score: 0 })).status).toBe(400);
    // somebody outside the top still sees their place
    const last = (await players[2]!.req('GET', '/api/games/tetris/leaderboard')).body;
    expect(last.me).toEqual({ rank: 6, score: 100 });
    expect(top.endsAt).toBeGreaterThan(Date.now());

    // time: the smaller the better
    await a.req('POST', '/api/games/score', { game: 'minesweeper', score: 80 });
    await b.req('POST', '/api/games/score', { game: 'minesweeper', score: 45 });
    await a.req('POST', '/api/games/score', { game: 'minesweeper', score: 60 });
    const mines = (await a.req('GET', '/api/games/minesweeper/leaderboard')).body;
    expect(mines.entries.map((e: { user: { id: number }; score: number }) => [e.user.id, e.score])).toEqual([
      [b.id, 45],
      [a.id, 60],
    ]);
    expect(mines.me).toEqual({ rank: 2, score: 60 });

    // the 3D runner is rated by points: metres plus ten for a coin
    expect((await a.req('POST', '/api/games/score', { game: 'subway', score: 1234 })).status).toBe(200);
    expect((await a.req('GET', '/api/games/subway/leaderboard')).body.entries[0]).toMatchObject({ score: 1234 });
  });

  it('gives the leader of a finished month an award of the 7th degree, once', async () => {
    const a = await premium('lbm_a');
    const b = await premium('lbm_b');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.UTC(2026, 4, 20, 12));
      await a.req('POST', '/api/games/score', { game: 'snake', score: 30 });
      await b.req('POST', '/api/games/score', { game: 'snake', score: 45 });
      await a.req('POST', '/api/games/score', { game: 'helix', score: 12 });
      expect((await a.req('GET', '/api/games/snake/leaderboard')).body.period).toBe('2026-05');

      const coins = async (u: typeof a) => (await u.req('GET', '/api/bank')).body.balance as number;
      const [a0, b0] = [await coins(a), await coins(b)];

      // June: the top starts empty, May's leaders get their awards
      vi.setSystemTime(Date.UTC(2026, 5, 2, 12));
      const june = (await a.req('GET', '/api/games/snake/leaderboard')).body;
      expect(june).toMatchObject({ period: '2026-06', entries: [], me: null });
      expect(june.previous.user.id).toBe(b.id);
      expect(june.previous.period).toBe('2026-05');
      await a.req('GET', '/api/games/snake/leaderboard');

      const awardsOf = async (u: typeof a) => ((await u.req('GET', '/api/auth/me')).body.awards as { degree: number; caption: string }[]).filter((w) => w.caption.startsWith('Лидер'));
      expect(await awardsOf(b)).toEqual([expect.objectContaining({ degree: 7, caption: 'Лидер по змейке Мая 2026' })]);
      expect((await awardsOf(a)).map((w) => w.caption)).toEqual(['Лидер по Helix Jump Мая 2026']);
      // ТК for the places: the snake (25 for the first), b first and a second (a third of it); the helix (35), a alone first
      expect(await coins(b)).toBe(b0 + 25);
      expect(await coins(a)).toBe(a0 + 8 + 35);
      // once only
      await a.req('GET', '/api/games/snake/leaderboard');
      expect(await coins(b)).toBe(b0 + 25);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('admin: game saves', () => {
  const sync = async (c: Client, saves: Record<string, unknown>, since?: number) =>
    (await c.req('POST', '/api/games/saves/sync', { saves, since })).body as { saves: Record<string, any>; at: number };
  const rich = { points: 5, total: 5000, run: 10, levels: { cursor: 3 }, cores: 12, coresTotal: 40, coreLevels: {}, resets: 3, clicks: 100, goldens: 2, savedAt: 1000 };
  const tick = () => new Promise((r) => setTimeout(r, 5));
  let admin: Client;
  let ann: Client;
  let bob: Client;
  let cid: Client;

  beforeAll(async () => {
    admin = await sharedAdmin();
    ann = await register('gadm_ann');
    bob = await register('gadm_bob');
    cid = await register('gadm_cid');
    await sync(ann, { 'best:tetris': 900, 'best:minesweeper': 45, 'helix:best': 12, 'helix:level': 12, 'best:subway': 1234, 'subway:earned': 500 });
    await sync(bob, { 'best:tetris': 300, 'best:minesweeper': 90 });
    await sync(cid, { 'best:tetris': 5000, clicker: rich });
  });

  const list = async (params: Record<string, string> = {}) =>
    (await admin.req('GET', `/api/admin/games/saves?${new URLSearchParams({ q: 'gadm_', ...params })}`)).body as { items: any[]; total: number };
  const who = (r: { items: any[] }) => r.items.map((e) => `${e.user.username.replace('gadm_', '')}:${e.game}`);
  const put = (userId: number, game: string, values: Record<string, unknown>) => admin.req('PUT', '/api/admin/games/saves', { userId, game, values });
  const reset = (userId: number, game: string) => admin.req('POST', '/api/admin/games/saves/reset', { userId, game });

  it('is for the admin only and counts the players of every game', async () => {
    expect((await ann.req('GET', '/api/admin/games')).status).toBe(403);
    expect((await ann.req('GET', '/api/admin/games/saves')).status).toBe(403);
    expect((await put(ann.id, 'tetris', { 'best:tetris': 1 }).then((r) => r)).status).toBe(200);
    const sum = (await admin.req('GET', '/api/admin/games')).body as { players: number; games: { game: string; players: number }[] };
    const players = (g: string) => sum.games.find((x) => x.game === g)!.players;
    expect(players('tetris')).toBeGreaterThanOrEqual(3);
    expect(players('minesweeper')).toBeGreaterThanOrEqual(2);
    expect(players('clicker')).toBeGreaterThanOrEqual(1);
    expect(sum.games.map((g) => g.game)).not.toContain('hangman');
    expect(sum.players).toBeGreaterThanOrEqual(3);
    // ann's tetris was only touched by the check above: put her record back for the next tests
    await put(ann.id, 'tetris', { 'best:tetris': 900 });
  });

  it('finds saves by game, name and progress, and sorts them', async () => {
    // best first; for time the smallest is the best
    expect(who(await list({ game: 'tetris', sort: 'progress' }))).toEqual(['cid:tetris', 'ann:tetris', 'bob:tetris']);
    expect(who(await list({ game: 'tetris', sort: 'progress', order: 'asc' }))).toEqual(['bob:tetris', 'ann:tetris', 'cid:tetris']);
    expect(who(await list({ game: 'minesweeper', sort: 'progress' }))).toEqual(['ann:minesweeper', 'bob:minesweeper']);
    // the clicker is judged by its rebirths and shows what else it holds
    const clicker = await list({ game: 'clicker' });
    expect(clicker.items[0]).toMatchObject({ game: 'clicker', progress: 3, user: { username: 'gadm_cid' } });
    expect(clicker.items[0].values).toMatchObject({ 'clicker.total': 5000, 'clicker.cores': 12, 'clicker.clicks': 100 });
    // by name (a part of the username or name counts, @ is ignored) and by a range of progress inside one game
    expect(who(await list({ q: '@gadm_an' })).sort()).toEqual(['ann:helix', 'ann:minesweeper', 'ann:subway', 'ann:tetris']);
    expect(who(await list({ game: 'tetris', q: 'bob' }))).toEqual(['bob:tetris']);
    expect(who(await list({ game: 'tetris', min: '500', max: '1000' }))).toEqual(['ann:tetris']);
    expect(who(await list({ game: 'tetris', min: '1000' }))).toEqual(['cid:tetris']);
    // a range is meaningless across games (their units differ), so it is not applied without one
    expect((await list({ min: '1000' })).total).toBe((await list()).total);
    expect(who(await list({ game: 'tetris', sort: 'name', order: 'asc' }))).toEqual(['ann:tetris', 'bob:tetris', 'cid:tetris']);
    // pages
    const page = await list({ game: 'tetris', sort: 'progress', limit: '2', offset: '2' });
    expect(page.total).toBe(3);
    expect(who(page)).toEqual(['bob:tetris']);
    expect((await admin.req('GET', '/api/admin/games/saves?game=hangman')).status).toBe(400);
    expect((await admin.req('GET', `/api/admin/games/saves?userId=${bob.id}`)).body.items.every((e: any) => e.user.id === bob.id)).toBe(true);
  });

  it('sets a value by hand, and a device with the old progress does not bring it back', async () => {
    const device = await sync(ann, {});
    const r = await put(ann.id, 'tetris', { 'best:tetris': 100 });
    expect(r.body).toMatchObject({ game: 'tetris', progress: 100, values: { 'best:tetris': 100 }, backups: [] });
    expect(r.body.editedAt).toBeGreaterThan(0);
    await tick();
    // the device still holds 900 and has not synced since: the admin's value stands, and the answer carries it
    const stale = await sync(ann, { 'best:tetris': 900 }, device.at);
    expect(stale.saves['best:tetris']).toBe(100);
    await tick();
    // having taken it, the device plays on: better results count again, worse ones still do not
    expect((await sync(ann, { 'best:tetris': 150 }, stale.at)).saves['best:tetris']).toBe(150);
    expect((await sync(ann, { 'best:tetris': 120 }, stale.at)).saves['best:tetris']).toBe(150);
    // an old client sends no `since` and plays by the plain rules
    expect((await sync(ann, { 'best:tetris': 900 })).saves['best:tetris']).toBe(900);
  });

  it('refuses what a field cannot hold and writes nothing unless every value is fine', async () => {
    const bad = async (game: string, values: Record<string, unknown>, status = 400) => expect((await put(bob.id, game, values)).status).toBe(status);
    await bad('tetris', { 'best:tetris': 5_000_001 });
    await bad('tetris', { 'best:tetris': 12.5 });
    await bad('tetris', { 'best:tetris': -1 });
    await bad('tetris', { nope: 1 });
    await bad('minesweeper', { 'best:minesweeper': 1 });
    await bad('paper', { 'best:paper': 12.34 });
    await bad('subway', { 'subway:own:cat': 2 });
    await bad('subway', { 'subway:up:shield': 4 });
    await bad('clicker', { 'clicker.total': [1.5, 4.5] });
    await bad('clicker', { 'clicker.resets': 1.5 });
    await bad('hangman', { x: 1 });
    await bad('tetris', {});
    // one bad value spoils the request
    await bad('subway', { 'subway:earned': 10, 'subway:up:shield': 9 });
    expect((await sync(bob, {})).saves['subway:earned']).toBeUndefined();
    expect((await put(999_999, 'tetris', { 'best:tetris': 1 })).status).toBe(404);
    // 0 clears a record; a decimal is fine where one is kept
    expect((await put(bob.id, 'minesweeper', { 'best:minesweeper': 0 })).body).toMatchObject({ progress: null });
    expect((await put(bob.id, 'paper', { 'best:paper': 12.5 })).body).toMatchObject({ progress: 12.5 });
    await put(bob.id, 'minesweeper', { 'best:minesweeper': 90 });
  });

  it('sets the clicker by hand: a new epoch, the old save kept, no device brings its own back', async () => {
    const device = await sync(cid, {});
    const r = await put(cid.id, 'clicker', { 'clicker.cores': 99, 'clicker.points': 1e9, 'clicker.total': [2, 400] });
    // what is on the account was earned, the cores in hand were received: the other numbers follow
    expect(r.body.values).toMatchObject({ 'clicker.cores': 99, 'clicker.coresTotal': 99, 'clicker.points': 1e9, 'clicker.total': [2, 400], 'clicker.resets': 3 });
    expect(r.body.backups).toEqual([expect.objectContaining({ resets: 3, cores: 40, pinned: true })]);
    await tick();
    // a device with a copy of its own that earned more (and has not synced since) loses
    const got = await sync(cid, { clicker: { ...rich, total: 7e12, savedAt: Date.now() + 99_999 } }, device.at);
    expect(got.saves.clicker).toMatchObject({ cores: 99, resets: 3 });
    expect(got.saves.clicker.epoch).toBeGreaterThan(0);
    expect(got.saves.clicker.points).toBe(1e9);
    // a number the admin typed may be beyond a double
    expect((await list({ game: 'clicker', q: 'cid' })).items[0].values['clicker.total']).toEqual([2, 400]);
  });

  it('resets one game: every field is written and an old copy cannot bring it back', async () => {
    await sync(ann, { 'subway:own:cat': 1, 'subway:up:jet': 2, 'subway:coins': 40, 'subway:skin': 'cat', 'subway:spent': 100 });
    const since = (await sync(ann, {})).at;
    await tick();
    const r = await reset(ann.id, 'subway');
    expect(r.body).toMatchObject({ game: 'subway', progress: null });
    expect(r.body.editedAt).toBeGreaterThan(0);
    // the device brings the old progress with the old `since`: it does not win
    const saves = (await sync(ann, { 'best:subway': 1234, 'subway:earned': 500, 'subway:up:jet': 2 }, since)).saves;
    expect(saves).toMatchObject({ 'best:subway': 0, 'subway:earned': 0, 'subway:spent': 0, 'subway:coins': 0, 'subway:skin': 'timba', 'subway:own:cat': 0, 'subway:up:jet': 0 });
    // the other games of the player are not touched
    expect(saves['helix:best']).toBe(12);
    expect(who(await list({ game: 'subway', has: 'no' }))).toContain('ann:subway');
    expect(who(await list({ game: 'subway', has: 'yes' }))).not.toContain('ann:subway');
    // the helix has no zero level: the start is level 1
    await reset(ann.id, 'helix');
    expect((await sync(ann, {})).saves).toMatchObject({ 'helix:best': 1, 'helix:level': 1, 'helix:bestScore': 0 });
  });

  it('resets the clicker keeping its old save, and takes a copy back', async () => {
    const r = (await reset(cid.id, 'clicker')).body;
    expect(r).toMatchObject({ progress: null, values: { 'clicker.total': 0, 'clicker.resets': 0 } });
    // the copy before the reset is the newest one; restoring it makes it current again
    expect(r.backups[0]).toMatchObject({ resets: 3, pinned: true });
    const back = (await admin.req('POST', `/api/admin/games/clicker/${cid.id}/backups/${r.backups[0].id}/restore`)).body;
    expect(back).toMatchObject({ progress: 3, values: { 'clicker.cores': 99 } });
    expect((await admin.req('POST', `/api/admin/games/clicker/${cid.id}/backups/999999/restore`)).status).toBe(404);
    // a copy belongs to its player
    expect((await admin.req('POST', `/api/admin/games/clicker/${bob.id}/backups/${r.backups[0].id}/restore`)).status).toBe(404);
    expect((await admin.req('GET', `/api/admin/games/saves/${cid.id}/clicker`)).body.backups.length).toBeGreaterThan(1);
  });

  it('shows the detail of a player who never played the game, empty', async () => {
    const d = (await admin.req('GET', `/api/admin/games/saves/${bob.id}/helix`)).body;
    expect(d).toMatchObject({ game: 'helix', progress: null, values: {}, updatedAt: 0, editedAt: 0, backups: [], user: { id: bob.id, username: 'gadm_bob' } });
    expect((await admin.req('GET', `/api/admin/games/saves/${bob.id}/nope`)).status).toBe(400);
    expect((await admin.req('GET', '/api/admin/games/saves/999999/helix')).status).toBe(404);
  });
});

describe('clicker backups', () => {
  it('keeps the save before a reset and takes it back, for its owner only', async () => {
    const u = await register('cb_a');
    const other = await register('cb_b');
    const sync = async (c: typeof u, saves: Record<string, unknown>) => (await c.req('POST', '/api/games/saves/sync', { saves })).body.saves;
    const rich = { points: 5, total: 900, run: 10, levels: { cursor: 3 }, cores: 12, coresTotal: 40, coreLevels: {}, resets: 7, clicks: 100, savedAt: 1000 };
    await sync(u, { clicker: rich });
    // a reset starts a new epoch and beats the progress, but the old save is kept
    await sync(u, { clicker: { ...rich, points: 0, total: 0, run: 0, cores: 0, coresTotal: 0, resets: 0, levels: {}, epoch: 5000, savedAt: 5000 } });
    expect((await sync(u, {})).clicker).toMatchObject({ resets: 0, epoch: 5000 });
    const list = (await u.req('GET', '/api/games/clicker/backups')).body as { id: number; resets: number; cores: number; pinned: boolean }[];
    expect(list).toEqual([expect.objectContaining({ resets: 7, cores: 40, pinned: true })]);
    expect((await other.req('GET', '/api/games/clicker/backups')).body).toEqual([]);
    expect((await other.req('POST', `/api/games/clicker/backups/${list[0]!.id}/restore`)).status).toBe(404);

    // taking it back: the old progress is current again (and wins on every device), the reset state is kept in turn
    const back = (await u.req('POST', `/api/games/clicker/backups/${list[0]!.id}/restore`)).body.saves;
    expect(back.clicker).toMatchObject({ resets: 7, cores: 12, coresTotal: 40 });
    const epoch = back.clicker.epoch as number;
    expect(epoch).toBeGreaterThan(5000);
    expect((await sync(u, { clicker: { ...rich, resets: 3, epoch: 5000, savedAt: 9000 } })).clicker).toMatchObject({ resets: 7, epoch });
    expect(((await u.req('GET', '/api/games/clicker/backups')).body as { resets: number }[]).map((b) => b.resets)).toEqual([0, 7]);
  });
});

describe('game saves', () => {
  it('keeps the better of two saves, never goes backwards, a reset of the clicker wins', async () => {
    const u = await register('gs_a');
    const other = await register('gs_b');
    const sync = async (c: typeof u, saves: Record<string, unknown>) => (await c.req('POST', '/api/games/saves/sync', { saves })).body.saves;

    expect(await sync(u, {})).toEqual({});
    // a new device brings its records; higher is better, for time and moves lower is
    await sync(u, { 'best:tetris': 500, 'best:minesweeper': 60, 'helix:level': 7, 'best:2048': 1000 });
    const got = await sync(u, { 'best:tetris': 300, 'best:minesweeper': 80, 'helix:level': 9, 'best:2048': 2000 });
    expect(got).toMatchObject({ 'best:tetris': 500, 'best:minesweeper': 60, 'helix:level': 9, 'best:2048': 2000 });
    expect((await sync(u, { 'best:minesweeper': 45 }))['best:minesweeper']).toBe(45);
    // the coins of the 3D runner: what was earned and what was spent only grow, so a purchase cannot roll back
    await sync(u, { 'subway:earned': 500, 'subway:spent': 120, 'subway:own:cat': 1 });
    const coins = await sync(u, { 'subway:earned': 300, 'subway:spent': 50, 'subway:up:shield': 1 });
    expect(coins).toMatchObject({ 'subway:earned': 500, 'subway:spent': 120, 'subway:own:cat': 1, 'subway:up:shield': 1 });
    // saves belong to the account
    expect(await sync(other, {})).toEqual({});

    // the clicker: more earned wins, not the later save; a reset (new epoch) wins over everything
    await sync(u, { clicker: { points: 10, owned: { cat: 3 }, savedAt: 1000, total: 5000 } });
    const stale = await sync(u, { clicker: { points: 1, owned: {}, savedAt: 9000, total: 20 } });
    expect(stale.clicker.total).toBe(5000);
    const reset = await sync(u, { clicker: { points: 0, owned: {}, savedAt: 10, total: 0, epoch: 5000 } });
    expect(reset.clicker).toMatchObject({ total: 0, epoch: 5000 });
    expect((await sync(u, { clicker: { points: 9, owned: {}, savedAt: 2000, total: 99999 } })).clicker.epoch).toBe(5000);

    // bad names and sizes are refused
    expect((await u.req('POST', '/api/games/saves/sync', { saves: { 'bad key!': 1 } })).status).toBe(400);
    expect((await u.req('POST', '/api/games/saves/sync', { saves: { big: 'x'.repeat(9000) } })).status).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/games/saves/sync', payload: { saves: {} } })).statusCode).toBe(401);
  });

  it('pushes an invite to a multiplayer game to the invited player', async () => {
    const { default: webpush } = await import('web-push');
    const spy = vi.spyOn(webpush, 'sendNotification').mockResolvedValue({ statusCode: 201, body: '', headers: {} });
    try {
      const admin = await sharedAdmin();
      const p1 = await register('pushinv_a');
      const p2 = await register('pushinv_b');
      await admin.req('POST', `/api/admin/users/${p1.id}/premium`, { action: 'give', days: 30, notify: false });
      await admin.req('POST', '/api/admin/bank/give', { userId: p1.id, amount: 100, set: true, notify: false });
      expect((await p2.req('POST', '/api/push/subscribe', { endpoint: 'https://push.example.com/inv', keys: { p256dh: 'BKey', auth: 'auth' } })).status).toBe(200);
      const inv = (await p1.req('POST', '/api/pvp', { game: 'duel', userId: p2.id, stake: 10 })).body;
      await vi.waitFor(() => expect(spy).toHaveBeenCalled());
      const [sub, data, opts] = spy.mock.calls[0]!;
      expect((sub as { endpoint: string }).endpoint).toBe('https://push.example.com/inv');
      expect(JSON.parse(data as string)).toMatchObject({ url: `/games/pvp/${inv.id}`, tag: `pvp-${inv.id}`, title: '🎮 Мультиплеер' });
      // the topic header of web push: at most 32 URL-safe characters
      expect((opts as { topic: string }).topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('multiplayer: board games, counter and rock-paper-scissors', () => {
  type Player = Awaited<ReturnType<typeof register>>;
  const setup = async (a: string, b: string, game: string, stake = 10) => {
    const admin = await sharedAdmin();
    const p1 = await register(a);
    const p2 = await register(b);
    await admin.req('POST', `/api/admin/users/${p1.id}/premium`, { action: 'give', days: 30, notify: false });
    for (const p of [p1, p2]) await admin.req('POST', '/api/admin/bank/give', { userId: p.id, amount: 100, set: true, notify: false });
    const inv = await p1.req('POST', '/api/pvp', { game, userId: p2.id, stake });
    expect(inv.status).toBe(200);
    const m = (await p2.req('POST', `/api/pvp/${inv.body.id}/accept`)).body;
    const byId: Record<number, Player> = { [p1.id]: p1, [p2.id]: p2 };
    const move = async (id: number, matchId: number, action: string, value?: number | string) => (await byId[id]!.req('POST', `/api/pvp/${matchId}/move`, { action, value })).body;
    const balance = async (c: Player) => (await c.req('GET', '/api/bank')).body.balance as number;
    return { p1, p2, m, byId, move, balance };
  };

  it('tic-tac-toe: turns, a win takes the pot, a draw gives the stakes back', async () => {
    const { p1, p2, m: started, byId, move, balance } = await setup('ttt_a', 'ttt_b', 'tictactoe');
    expect(started.board).toEqual(Array(9).fill(0));
    const first = started.turn as number;
    const second = first === p1.id ? p2.id : p1.id;
    // not your turn, a wrong cell, a taken cell
    expect((await move(second, started.id, 'mark', 0)).error).toBe('bad_request');
    expect((await move(first, started.id, 'mark', 9)).error).toBe('bad_request');
    let m = await move(first, started.id, 'mark', 0);
    expect(m.turn).toBe(second);
    expect(m.board[0]).toBe(first === p1.id ? 1 : 2);
    expect((await move(second, started.id, 'mark', 0)).error).toBe('bad_request');
    // first takes the top row: 0, 1, 2 against 3, 4
    m = await move(second, started.id, 'mark', 3);
    m = await move(first, started.id, 'mark', 1);
    m = await move(second, started.id, 'mark', 4);
    m = await move(first, started.id, 'mark', 2);
    expect(m).toMatchObject({ status: 'finished', winnerId: first });
    expect(await balance(byId[first]!)).toBe(110);
    expect(await balance(byId[second]!)).toBe(90);

    // a draw: 0 1 2 / 3 4 5 / 6 7 8 as X O X / X O O / O X X
    const d = await setup('ttt_c', 'ttt_d', 'tictactoe', 20);
    let dm = d.m;
    const order = [0, 1, 2, 4, 3, 5, 7, 6, 8];
    for (const cell of order) dm = await d.move(dm.turn, dm.id, 'mark', cell);
    expect(dm.status).toBe('finished');
    expect(dm.winnerId).toBeNull();
    expect(await d.balance(d.p1)).toBe(100);
    expect(await d.balance(d.p2)).toBe(100);
  });

  it('connect four: discs fall, four in a column win', async () => {
    const { m: started, move, balance, byId, p1, p2 } = await setup('c4_a', 'c4_b', 'connect4');
    expect(started.board).toHaveLength(42);
    let m = started;
    const a = m.turn as number;
    const b = a === p1.id ? p2.id : p1.id;
    // a drops in column 0, b in column 1, four times: a wins vertically
    for (let i = 0; i < 3; i++) {
      m = await move(a, m.id, 'drop', 0);
      m = await move(b, m.id, 'drop', 1);
    }
    expect(m.board[35]).toBe(a === p1.id ? 1 : 2); // the bottom of column 0
    expect(m.board[28]).toBe(a === p1.id ? 1 : 2);
    expect((await move(a, m.id, 'drop', 7)).error).toBe('bad_request');
    m = await move(a, m.id, 'drop', 0);
    expect(m).toMatchObject({ status: 'finished', winnerId: a });
    expect(await balance(byId[a]!)).toBe(110);
  });

  it('twenty-one: add 1…3, the player who reaches 21 wins; a missed move is lost', async () => {
    const { m: started, move, byId, balance } = await setup('nim_a', 'nim_b', 'nim');
    let m = started;
    expect((await move(m.turn, m.id, 'add', 4)).error).toBe('bad_request');
    expect((await move(m.turn, m.id, 'add', 0)).error).toBe('bad_request');
    // both add 3 until the counter is 18, then the next player adds 3 and wins
    for (let i = 0; i < 6; i++) m = await move(m.turn, m.id, 'add', 3);
    expect(m.total).toBe(18);
    expect((await move(m.turn, m.id, 'add', 4)).error).toBe('bad_request');
    const winner = m.turn as number;
    m = await move(winner, m.id, 'add', 3);
    expect(m).toMatchObject({ status: 'finished', winnerId: winner, total: 21 });
    expect(await balance(byId[winner]!)).toBe(110);

    const { tickPvp } = await import('../src/bank/pvp.js');
    const t = await setup('nim_c', 'nim_d', 'nim');
    tickPvp(Date.now() + 10 * 60_000);
    const over = (await t.p1.req('GET', `/api/pvp/${t.m.id}`)).body;
    expect(over).toMatchObject({ status: 'finished', forfeit: true });
    expect(over.winnerId).not.toBe(t.m.turn);
  });

  it('rock-paper-scissors: the choice is secret until both chose, two round wins take the pot', async () => {
    const { p1, p2, m: started, byId, move, balance } = await setup('rps_a', 'rps_b', 'rps');
    expect(started).toMatchObject({ status: 'active', picked: [], wins: {} });
    expect((await move(p1.id, started.id, 'pick', 'lizard')).error).toBeDefined();
    let m = await move(p1.id, started.id, 'pick', 'rock');
    expect(m.picked).toEqual([p1.id]);
    // the other side sees only that p1 chose, not what
    const seen = (await p2.req('GET', `/api/pvp/${started.id}`)).body;
    expect(seen.picked).toEqual([p1.id]);
    expect(JSON.stringify(seen.moves)).not.toContain('rock');
    expect((await move(p1.id, started.id, 'pick', 'paper')).error).toBe('bad_request');
    // p2 chooses scissors: p1 wins the round
    m = await move(p2.id, started.id, 'pick', 'scissors');
    expect(m).toMatchObject({ status: 'active', picked: [], round: 2 });
    expect(m.wins[p1.id]).toBe(1);
    expect(m.moves.map((x: { pick: string }) => x.pick).sort()).toEqual(['rock', 'scissors']);
    // a tie is played again without points
    await move(p1.id, started.id, 'pick', 'paper');
    m = await move(p2.id, started.id, 'pick', 'paper');
    expect(m.wins[p1.id]).toBe(1);
    expect(m.round).toBe(3);
    // p1 wins the second round
    await move(p1.id, started.id, 'pick', 'paper');
    m = await move(p2.id, started.id, 'pick', 'rock');
    expect(m).toMatchObject({ status: 'finished', winnerId: p1.id });
    expect(await balance(byId[p1.id]!)).toBe(110);
    expect(await balance(byId[p2.id]!)).toBe(90);

    // a hand not chosen in time is chosen by the server
    const { tickPvp } = await import('../src/bank/pvp.js');
    const t = await setup('rps_c', 'rps_d', 'rps');
    await t.move(t.p1.id, t.m.id, 'pick', 'rock');
    tickPvp(Date.now() + 10 * 60_000);
    const after = (await t.p1.req('GET', `/api/pvp/${t.m.id}`)).body;
    expect(after.moves).toHaveLength(2);
    expect(after.moves.find((x: { by: number }) => x.by === t.p2.id).auto).toBe(true);
  });
});

describe('file sizes', () => {
  async function upload(c: Client, name: string, mime: string, data: Buffer, fields: Record<string, string> = {}) {
    const boundary = '----sz';
    const head = Object.entries(fields)
      .map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)
      .join('');
    const r = await app.inject({
      method: 'POST',
      url: '/api/files',
      payload: Buffer.concat([
        Buffer.from(head),
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`),
        data,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
      headers: { cookie: c.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    expect(r.statusCode).toBe(200);
    return JSON.parse(r.body) as { id: string; kind: string; hasThumb: boolean };
  }
  const get = (c: Client, url: string) => app.inject({ method: 'GET', url, headers: { cookie: c.cookie } });

  it('serves a viewer-sized copy of a big photo, and the original of a small one', async () => {
    const sharp = (await import('sharp')).default;
    const a = await register('sz_photo');
    // noise does not compress: a "camera" picture of a few MB
    const raw = Buffer.alloc(3000 * 2000 * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24;
    const big = await sharp(raw, { raw: { width: 3000, height: 2000, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
    const bigFile = await upload(a, 'big.jpg', 'image/jpeg', big);
    expect(bigFile.kind).toBe('photo');

    const preview = await get(a, `/api/files/${bigFile.id}?preview=1`);
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['content-type']).toContain('image/webp');
    const meta = await sharp(preview.rawPayload).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBe(1920);
    expect(preview.rawPayload.length).toBeLessThan(big.length);
    // the original stays reachable
    const orig = await get(a, `/api/files/${bigFile.id}`);
    expect(orig.headers['content-type']).toContain('image/jpeg');
    expect(orig.rawPayload.length).toBe(big.length);

    const tiny = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#09c' } }).jpeg().toBuffer();
    const tinyFile = await upload(a, 'tiny.jpg', 'image/jpeg', tiny);
    const same = await get(a, `/api/files/${tinyFile.id}?preview=1`);
    expect(same.headers['content-type']).toContain('image/jpeg');
    expect(same.rawPayload.length).toBe(tiny.length);
  });

  it('keeps the frame the browser cut out of a video as its preview picture', async () => {
    const sharp = (await import('sharp')).default;
    const a = await register('sz_video');
    const frame = await sharp({ create: { width: 320, height: 180, channels: 3, background: '#c30' } }).jpeg().toBuffer();
    const poster = `data:image/jpeg;base64,${frame.toString('base64')}`;
    const v = await upload(a, 'v.mp4', 'video/mp4', Buffer.from('not really a video'), { duration: '3', poster });
    expect(v).toMatchObject({ kind: 'video', hasThumb: true });
    // a fresh video may still be swapped for its lighter copy: the browser checks it every time; a poster never changes
    expect((await get(a, `/api/files/${v.id}`)).headers['cache-control']).toBe('private, no-cache');
    expect((await get(a, `/api/files/${v.id}?thumb=1`)).headers['cache-control']).toContain('immutable');
    const thumb = await get(a, `/api/files/${v.id}?thumb=1`);
    expect(thumb.headers['content-type']).toContain('image/webp');
    expect((await sharp(thumb.rawPayload).metadata()).width).toBe(320);

    // garbage in the field is ignored, the video still goes through
    const bad = await upload(a, 'v2.mp4', 'video/mp4', Buffer.from('x'), { poster: 'data:image/jpeg;base64,AAAA' });
    expect(bad).toMatchObject({ kind: 'video', hasThumb: false });
    const html = await upload(a, 'v3.mp4', 'video/mp4', Buffer.from('x'), { poster: 'data:text/html;base64,PGI+' });
    expect(html.hasThumb).toBe(false);
  });

  it('makes the viewer-sized copy of a photo in the background, right after the upload', async () => {
    const a = await register('sz_bg');
    const raw = Buffer.alloc(2600 * 1800 * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24;
    const big = await sharp(raw, { raw: { width: 2600, height: 1800, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
    const f = await upload(a, 'bg.jpg', 'image/jpeg', big);
    const row = getFile(f.id)!;
    const preview = path.join(uploadsDir(), row.path.replace(/\.jpg$/, '_p.webp'));
    await vi.waitFor(() => expect(fs.existsSync(preview)).toBe(true), { timeout: 5000 });
  });

  it('serves a few-KB copy of a photo for avatar circles, and leaves a GIF as it is', async () => {
    const a = await register('sz_avatar');
    const raw = Buffer.alloc(900 * 600 * 3);
    for (let i = 0; i < raw.length; i++) raw[i] = (i * 2654435761) >>> 24;
    const photo = await sharp(raw, { raw: { width: 900, height: 600, channels: 3 } }).jpeg({ quality: 85 }).toBuffer();
    const f = await upload(a, 'me.jpg', 'image/jpeg', photo);

    const small = await get(a, `/api/files/${f.id}?avatar=1`);
    expect(small.statusCode).toBe(200);
    expect(small.headers['content-type']).toContain('image/webp');
    const meta = await sharp(small.rawPayload).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBe(128);
    const thumb = await get(a, `/api/files/${f.id}?thumb=1`);
    expect(small.rawPayload.length).toBeLessThan(thumb.rawPayload.length);
    // made once, kept on the disk, the same bytes the second time
    expect((await get(a, `/api/files/${f.id}?avatar=1`)).rawPayload.equals(small.rawPayload)).toBe(true);
    expect(small.headers['cache-control']).toContain('immutable');

    // a GIF has no thumbnail and may move: the original goes out
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    const g = await upload(a, 'a.gif', 'image/gif', gif);
    const same = await get(a, `/api/files/${g.id}?avatar=1`);
    expect(same.headers['content-type']).toContain('image/gif');
    expect(same.rawPayload.equals(gif)).toBe(true);
  });

  it('takes the size, the length and the frame of a video after the file, and fills in only what is unknown', async () => {
    const a = await register('sz_meta');
    const b = await register('sz_meta2');
    const v = await upload(a, 'late.mp4', 'video/mp4', Buffer.from('not really a video'));
    expect(v).toMatchObject({ kind: 'video', hasThumb: false, width: null });

    const frame = await sharp({ create: { width: 320, height: 180, channels: 3, background: '#30c' } }).jpeg().toBuffer();
    const meta = { width: 1280, height: 720, duration: 12.5, poster: `data:image/jpeg;base64,${frame.toString('base64')}` };
    // somebody else's file, a missing one, a bad body
    expect((await b.req('POST', `/api/files/${v.id}/meta`, meta)).status).toBe(404);
    expect((await a.req('POST', '/api/files/nope/meta', meta)).status).toBe(404);
    expect((await a.req('POST', `/api/files/${v.id}/meta`, { width: -5 })).status).toBe(400);

    const done = await a.req('POST', `/api/files/${v.id}/meta`, meta);
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ id: v.id, kind: 'video', hasThumb: true, width: 1280, height: 720, duration: 12.5 });
    const thumb = await get(a, `/api/files/${v.id}?thumb=1`);
    expect(thumb.headers['content-type']).toContain('image/webp');
    expect((await sharp(thumb.rawPayload).metadata()).width).toBe(320);

    // a second answer does not overwrite the first
    const again = await a.req('POST', `/api/files/${v.id}/meta`, { width: 10, height: 10, duration: 1 });
    expect(again.body).toMatchObject({ width: 1280, height: 720, duration: 12.5 });

    // only videos take it
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#000' } }).png().toBuffer();
    const photo = await upload(a, 'p.png', 'image/png', png);
    expect((await a.req('POST', `/api/files/${photo.id}/meta`, meta)).status).toBe(404);
  });

  it('compresses the JSON answers, but not pictures and video', async () => {
    const a = await register('sz_gzip');
    const b = await register('sz_gzip2');
    const chat = (await a.req('POST', '/api/chats/private', { userId: b.id })).body;
    for (let i = 0; i < 30; i++) await a.req('POST', `/api/chats/${chat.id}/messages`, { text: `message number ${i}, long enough to make a list worth packing` });
    const list = await app.inject({ method: 'GET', url: `/api/chats/${chat.id}/messages`, headers: { cookie: a.cookie, 'accept-encoding': 'br, gzip' } });
    expect(list.headers['content-encoding']).toBe('br');
    expect(list.rawPayload.length).toBeLessThan(JSON.parse(zlib.brotliDecompressSync(list.rawPayload).toString()).length * 120);
    expect(JSON.parse(zlib.brotliDecompressSync(list.rawPayload).toString())).toHaveLength(30);
    // nothing asked for: nothing packed
    const plain = await app.inject({ method: 'GET', url: `/api/chats/${chat.id}/messages`, headers: { cookie: a.cookie } });
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(JSON.parse(plain.body)).toHaveLength(30);

    // a file keeps its own bytes, and a range stays a range
    const f = await upload(a, 'doc.txt', 'text/plain', Buffer.from('0123456789'.repeat(400)));
    const file = await app.inject({ method: 'GET', url: `/api/files/${f.id}`, headers: { cookie: a.cookie, 'accept-encoding': 'br, gzip' } });
    expect(file.headers['content-encoding']).toBeUndefined();
    expect(file.rawPayload.length).toBe(4000);
    const part = await app.inject({ method: 'GET', url: `/api/files/${f.id}`, headers: { cookie: a.cookie, range: 'bytes=10-19', 'accept-encoding': 'br' } });
    expect(part.statusCode).toBe(206);
    expect(part.body).toBe('0123456789');
  });

  it('lists every upload for the admin, sorts and filters them, and deletes one, several or all', async () => {
    const sharp = (await import('sharp')).default;
    const admin = await sharedAdmin();
    const a = await register('up_a');
    const b = await register('up_b');
    const chat = (await a.req('POST', '/api/chats/private', { userId: b.id })).body;
    const png = await sharp({ create: { width: 40, height: 40, channels: 3, background: '#339' } }).png().toBuffer();
    const photo = await upload(a, 'pic.png', 'image/png', png);
    const doc = await upload(a, 'notes.txt', 'text/plain', Buffer.from('x'.repeat(5000)));
    const loose = await upload(a, 'unsent.txt', 'text/plain', Buffer.from('y'));
    const photoMsg = (await a.req('POST', `/api/chats/${chat.id}/messages`, { fileIds: [photo.id] })).body;
    const docMsg = (await a.req('POST', `/api/chats/${chat.id}/messages`, { text: 'read me', fileIds: [doc.id] })).body;

    // only the admin
    expect((await a.req('GET', '/api/admin/uploads')).status).toBe(403);
    expect((await a.req('POST', '/api/admin/uploads/delete', { ids: [photo.id] })).status).toBe(403);

    const all = (await admin.req('GET', '/api/admin/uploads?q=up_a&sort=size&order=desc')).body;
    expect(all.total).toBe(3);
    expect(all.items[0].id).toBe(doc.id); // 5000 bytes: the biggest comes first
    expect(all.items.at(-1).id).toBe(loose.id); // 1 byte
    expect(all.items[0]).toMatchObject({ id: doc.id, size: 5000, uses: 1 });
    expect(all.items[0].chat).toMatchObject({ id: chat.id, type: 'private' });
    expect(all.items[0].chat.title).toContain('up_a');
    expect(all.items[0].uploader).toMatchObject({ id: a.id, username: 'up_a' });
    const asc = (await admin.req('GET', '/api/admin/uploads?q=up_a&sort=size&order=asc')).body;
    expect(asc.items[0].size).toBeLessThanOrEqual(asc.items[1].size);
    expect((await admin.req('GET', '/api/admin/uploads?q=up_a&kind=photo')).body.items.map((x: { id: string }) => x.id)).toEqual([photo.id]);
    expect((await admin.req('GET', `/api/admin/uploads?chatId=${chat.id}`)).body.total).toBe(2);
    const unused = (await admin.req('GET', '/api/admin/uploads?q=up_a&usage=unused')).body;
    expect(unused.items.map((x: { id: string }) => x.id)).toEqual([loose.id]);
    const sum = (await admin.req('GET', '/api/admin/uploads/summary')).body;
    expect(sum.byChat.find((c: { chatId: number }) => c.chatId === chat.id)).toMatchObject({ count: 2 });
    expect(sum.unused.count).toBeGreaterThanOrEqual(1);

    // a picture that was a whole message takes the message with it; a file with a caption leaves the caption
    expect((await admin.req('POST', '/api/admin/uploads/delete', { ids: [photo.id] })).body).toMatchObject({ deleted: 1, skipped: 0 });
    expect((await get(a, `/api/files/${photo.id}`)).statusCode).toBe(404);
    const msgs = (await a.req('GET', `/api/chats/${chat.id}/messages`)).body as { id: number }[];
    expect(msgs.some((m) => m.id === photoMsg.id)).toBe(false);

    expect((await admin.req('POST', '/api/admin/uploads/delete', { ids: [doc.id] })).body.deleted).toBe(1);
    const left = ((await a.req('GET', `/api/chats/${chat.id}/messages`)).body as { id: number; text: string; attachments: unknown[] }[]).find((m) => m.id === docMsg.id)!;
    expect(left).toMatchObject({ text: 'read me', attachments: [] });

    // "delete all" by a filter
    expect((await admin.req('POST', '/api/admin/uploads/delete', { all: true, filter: { usage: 'unused', q: 'up_a' } })).body.deleted).toBe(1);
    expect((await admin.req('GET', '/api/admin/uploads?q=up_a')).body.total).toBe(0);
    expect((await admin.req('POST', '/api/admin/uploads/delete', {})).status).toBe(400);
  });

  it.skipIf(!ffmpegAvailable())('makes an uploaded video light, quick to start and playable everywhere', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-video-'));
    const src = path.join(dir, 'in.mp4');
    // a big picture in an old codec, like the worst a phone or a screen recorder can send
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1920x1080:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', '-c:v', 'mpeg4', '-q:v', '2', '-c:a', 'libmp3lame', src]);
    const a = await register('sz_ffmpeg');
    const v = await upload(a, 'clip.mov', 'video/quicktime', fs.readFileSync(src));
    expect(v).toMatchObject({ kind: 'video', hasThumb: false });

    await processVideo(v.id);
    const file = getFile(v.id)!;
    expect(file).toMatchObject({ mime: 'video/mp4', name: 'clip.mp4', width: 1280, height: 720 });
    expect(file.thumb_path).toBeTruthy();
    const probe = await probeVideo(path.join(uploadsDir(), file.path));
    expect(probe).toMatchObject({ vcodec: 'h264', acodec: 'aac', width: 1280, height: 720 });
    // the index sits before the picture: the video starts without reading it all
    const head = fs.readFileSync(path.join(uploadsDir(), file.path)).subarray(0, 4096).toString('latin1');
    expect(head.indexOf('moov')).toBeGreaterThan(-1);
    expect(head.indexOf('moov')).toBeLessThan(head.indexOf('mdat') === -1 ? Infinity : head.indexOf('mdat'));
    const served = await get(a, `/api/files/${v.id}`);
    expect(served.headers['content-type']).toContain('video/mp4');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('search by author', () => {
  it('narrows the search in a group to one member, also without words', async () => {
    const a = await register('sa_a');
    const b = await register('sa_b');
    const bId = (await b.req('GET', '/api/auth/me')).body.id as number;
    const aId = (await a.req('GET', '/api/auth/me')).body.id as number;
    const g = (await a.req('POST', '/api/chats/group', { title: 'Поиск', memberIds: [bId] })).body;
    await a.req('POST', `/api/chats/${g.id}/messages`, { text: 'яблоко от первого' });
    await b.req('POST', `/api/chats/${g.id}/messages`, { text: 'яблоко от второго' });
    await b.req('POST', `/api/chats/${g.id}/messages`, { text: 'груша от второго' });
    const ids = (r: { body: { messages: { senderId: number }[] } }) => r.body.messages.map((m) => m.senderId);
    expect(ids(await a.req('GET', `/api/chats/${g.id}/search?q=${encodeURIComponent('яблоко')}`))).toHaveLength(2);
    expect(ids(await a.req('GET', `/api/chats/${g.id}/search?q=${encodeURIComponent('яблоко')}&from=${bId}`))).toEqual([bId]);
    // no words: everything from this person, newest first
    const all = await a.req('GET', `/api/chats/${g.id}/search?q=&from=${bId}`);
    expect(all.body.messages.map((m: { text: string }) => m.text)).toEqual(['груша от второго', 'яблоко от второго']);
    // no words and no author is still an empty answer
    expect((await a.req('GET', `/api/chats/${g.id}/search?q=`)).body.messages).toEqual([]);
    expect(ids(await a.req('GET', `/api/chats/${g.id}/search?q=&from=${aId}`))).toEqual([aId]);
  });
});

describe('common groups', () => {
  it('lists the groups both people are in, not channels or the groups of one of them', async () => {
    const a = await register('cg_a');
    const b = await register('cg_b');
    const c = await register('cg_c');
    const idOf = async (u: typeof a) => (await u.req('GET', '/api/auth/me')).body.id as number;
    const [bId, cId] = [await idOf(b), await idOf(c)];
    const shared = (await a.req('POST', '/api/chats/group', { title: 'Вместе', memberIds: [bId] })).body;
    await a.req('POST', '/api/chats/group', { title: 'Без Б', memberIds: [cId] });
    await a.req('POST', '/api/chats/channel', { title: 'Канал', memberIds: [bId] });
    const r = await a.req('GET', `/api/users/${bId}/common-chats`);
    expect(r.status).toBe(200);
    expect(r.body.map((x: { id: number }) => x.id)).toEqual([shared.id]);
    // the same list from the other side; nothing for oneself
    expect((await b.req('GET', `/api/users/${await idOf(a)}/common-chats`)).body).toHaveLength(1);
    expect((await a.req('GET', `/api/users/${await idOf(a)}/common-chats`)).body).toEqual([]);
    expect((await a.req('GET', '/api/users/999999/common-chats')).status).toBe(404);
  });
});

describe('save to favorites', () => {
  it('a message from a chat lands in the own chat with the author kept', async () => {
    const a = await register('fav_a');
    const b = await register('fav_b');
    const me = (await a.req('GET', '/api/auth/me')).body;
    const pm = (await a.req('POST', '/api/chats/private', { userId: (await b.req('GET', '/api/auth/me')).body.id })).body;
    const sent = (await b.req('POST', `/api/chats/${pm.id}/messages`, { text: 'сохрани меня' })).body;
    const saved = (await a.req('POST', '/api/chats/private', { userId: me.id })).body;
    const r = await a.req('POST', '/api/messages/forward', { ids: [sent.id], fromChatId: pm.id, toChatId: saved.id });
    expect(r.status).toBe(200);
    expect(r.body[0]).toMatchObject({ text: 'сохрани меня', chatId: saved.id, forwardedFrom: { name: expect.stringContaining('fav_b') } });
  });
});

describe('profile links', () => {
  it('opens a person by /api/resolve/<username>, the target of «Ссылка на профиль»', async () => {
    const a = await register('plink_a');
    const b = await register('plink_b');
    const r = await a.req('GET', '/api/resolve/plink_b');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ type: 'user', user: { username: 'plink_b' } });
    expect(r.body.user.id).toBe((await b.req('GET', '/api/auth/me')).body.id);
  });
});

describe('preferences', () => {
  it('keeps the quick reaction, one of the allowed ones only', async () => {
    const a = await register('prefs_a');
    expect((await a.req('PUT', '/api/me/prefs', { theme: 'dark', quickReaction: '🔥' })).status).toBe(200);
    expect((await a.req('GET', '/api/auth/me')).body.prefs).toMatchObject({ theme: 'dark', quickReaction: '🔥' });
    expect((await a.req('PUT', '/api/me/prefs', { quickReaction: '🦄' })).status).toBe(400);
  });

  it('keeps quiet hours, rejects a time of day that does not exist', async () => {
    const a = await register('prefs_q');
    const quietHours = { on: true, from: 1320, to: 480, tz: -180 };
    expect((await a.req('PUT', '/api/me/prefs', { quietHours })).status).toBe(200);
    expect((await a.req('GET', '/api/auth/me')).body.prefs.quietHours).toEqual(quietHours);
    expect((await a.req('PUT', '/api/me/prefs', { quietHours: { ...quietHours, from: 1440 } })).status).toBe(400);
  });
});
