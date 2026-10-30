import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { type Socket, io } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { activeGroupCalls } from '../src/groupCalls.js';
import { attachSocket } from '../src/socket.js';

let app: FastifyInstance;
let base = '';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'timba-calls-'));
const sockets: Socket[] = [];

beforeAll(async () => {
  config.dataDir = tmp;
  config.adminPassword = 'adminpass';
  app = await buildApp({ dbFile: ':memory:' });
  attachSocket(app.server);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  for (const s of sockets) s.disconnect();
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

let ipSeq = 0;
async function register(username: string) {
  const r = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    remoteAddress: `10.9.0.${++ipSeq}`,
    payload: { username, password: 'secret123', firstName: username },
  });
  expect(r.statusCode).toBe(200);
  const cookie = String(r.headers['set-cookie']).split(';')[0]!;
  const id = JSON.parse(r.body).id as number;
  const req = async (method: string, url: string, body?: unknown) => {
    const res = await app.inject({ method: method as 'GET', url, payload: body as object, headers: { cookie } });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  const socket = io(base, { extraHeaders: { cookie }, transports: ['websocket'], forceNew: true });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('connect_error', reject);
  });
  return { id, cookie, req, socket };
}

const next = <T>(s: Socket, event: string) => new Promise<T>((resolve) => s.once(event, resolve));
const emit = <T>(s: Socket, event: string, data?: unknown) => new Promise<T>((resolve) => s.emit(event, data, resolve));

describe('group calls', () => {
  it('relays signals inside a group call and ends it when everybody leaves', async () => {
    const ann = await register('gc_ann');
    const ben = await register('gc_ben');
    const eve = await register('gc_eve');
    const group = (await ann.req('POST', '/api/chats/group', { title: 'Семья', memberIds: [ben.id] })).body;
    // the new members' sockets join the chat room on reconnect; watch it for the banner instead
    ben.socket.emit('chat:watch', { chatId: group.id });
    await new Promise((r) => setTimeout(r, 50));

    const banner = next<{ chatId: number; call: { count: number } | null }>(ben.socket, 'gcall:state');
    const a = await emit<any>(ann.socket, 'gcall:join', { chatId: group.id });
    expect(a.ok).toBe(true);
    expect(a.participants).toEqual([]);
    expect((await banner).call?.count).toBe(1);

    // not a member of the group
    expect((await emit<any>(eve.socket, 'gcall:join', { chatId: group.id })).ok).toBe(false);

    const joined = next<any>(ann.socket, 'gcall:joined');
    const b = await emit<any>(ben.socket, 'gcall:join', { chatId: group.id });
    expect(b.ok).toBe(true);
    expect(b.participants.map((p: any) => p.user.id)).toEqual([ann.id]);
    expect((await joined).participant.user.id).toBe(ben.id);

    // ben (the newcomer) sends the offer to ann
    const got = next<any>(ann.socket, 'gcall:signal');
    ben.socket.emit('gcall:signal', { to: a.selfPeerId, signal: { type: 'offer', sdp: 'x' } });
    expect(await got).toMatchObject({ from: b.selfPeerId, signal: { type: 'offer', sdp: 'x' } });

    const media = next<any>(ben.socket, 'gcall:media');
    ann.socket.emit('gcall:media', { mic: false, cam: true, screen: false });
    expect(await media).toMatchObject({ peerId: a.selfPeerId, mic: false, cam: true });

    // somebody in a group call is busy for one-to-one calls
    const busy = await emit<any>(eve.socket, 'call:start', { userId: ann.id });
    expect(busy.ok).toBe(true);

    const left = next<any>(ann.socket, 'gcall:left');
    ben.socket.emit('gcall:leave');
    expect((await left).peerId).toBe(b.selfPeerId);
    ann.socket.emit('gcall:leave');
    await new Promise((r) => setTimeout(r, 50));
    expect(activeGroupCalls()).toBe(0);

    const msgs = (await ann.req('GET', `/api/chats/${group.id}/messages`)).body as { text: string }[];
    expect(msgs.some((m) => m.text.includes('Групповой звонок завершён'))).toBe(true);
  });

  it('joins a call by link', async () => {
    const kim = await register('gc_kim');
    const lee = await register('gc_lee');
    const link = (await kim.req('POST', '/api/call-links', { title: 'Созвон' })).body;
    expect(link.url).toBe(`/call/${link.token}`);
    expect((await lee.req('GET', '/api/call-links/nope')).status).toBe(404);

    const k = await emit<any>(kim.socket, 'gcall:join', { token: link.token });
    expect(k).toMatchObject({ ok: true, title: 'Созвон', chatId: null });
    expect((await lee.req('GET', `/api/call-links/${link.token}`)).body.count).toBe(1);
    const l = await emit<any>(lee.socket, 'gcall:join', { token: link.token });
    expect(l.participants.map((p: any) => p.user.id)).toEqual([kim.id]);
    expect((await emit<any>(lee.socket, 'gcall:join', { token: 'nope' })).ok).toBe(false);
    lee.socket.disconnect();
    await new Promise((r) => setTimeout(r, 50));
    expect((await kim.req('GET', `/api/call-links/${link.token}`)).body.count).toBe(1);
    kim.socket.emit('gcall:leave');
  });

  it('keeps a call history for each side and lists contacts', async () => {
    const x = await register('log_x');
    const y = await register('log_y');
    // a call nobody answers, cancelled by the caller
    const started = await emit<any>(x.socket, 'call:start', { userId: y.id, video: true });
    expect(started.ok).toBe(true);
    const ended = next<any>(y.socket, 'call:end');
    x.socket.emit('call:hangup', { callId: started.callId });
    await ended;
    await new Promise((r) => setTimeout(r, 50));
    const xs = (await x.req('GET', '/api/calls')).body;
    expect(xs[0]).toMatchObject({ kind: 'private', outgoing: true, video: true, status: 'cancelled', peer: { id: y.id } });
    const ys = (await y.req('GET', '/api/calls?missed=1')).body;
    expect(ys).toHaveLength(1);
    expect(ys[0]).toMatchObject({ outgoing: false, status: 'missed', peer: { id: x.id } });

    // a group call by link: one row for whoever was in it
    const link = (await x.req('POST', '/api/call-links', { title: 'Созвон' })).body;
    await emit<any>(x.socket, 'gcall:join', { token: link.token });
    x.socket.emit('gcall:leave');
    await new Promise((r) => setTimeout(r, 50));
    expect((await x.req('GET', '/api/calls')).body[0]).toMatchObject({ kind: 'group', title: 'Созвон', linkToken: link.token, outgoing: true });

    expect((await x.req('DELETE', '/api/calls')).status).toBe(200);
    expect((await x.req('GET', '/api/calls')).body).toEqual([]);

    // "Контакты" are the people saved by the user (see contacts.test.ts), not everybody
    expect((await x.req('GET', '/api/contacts')).body).toEqual([]);
    await x.req('POST', '/api/contacts', { userId: y.id });
    const contacts = (await x.req('GET', '/api/contacts')).body as any[];
    expect(contacts.some((u) => u.id === y.id)).toBe(true);
    expect(contacts.some((u) => u.id === x.id || u.bot)).toBe(false);
  });
});

describe('typing indicator', () => {
  it('relays «typing» and what is being recorded, and drops what is not known', async () => {
    const ann = await register('ty_ann');
    const ben = await register('ty_ben');
    const group = (await ann.req('POST', '/api/chats/group', { title: 'Печать', memberIds: [ben.id] })).body;
    for (const u of [ann, ben]) u.socket.emit('chat:watch', { chatId: group.id });
    await new Promise((r) => setTimeout(r, 50));

    const plain = next<{ userId: number; action?: string }>(ben.socket, 'typing');
    ann.socket.emit('typing', { chatId: group.id });
    expect(await plain).toMatchObject({ userId: ann.id });
    expect((await plain).action).toBeUndefined();

    const voice = next<{ userId: number; action?: string }>(ben.socket, 'typing');
    ann.socket.emit('typing', { chatId: group.id, action: 'voice' });
    expect((await voice).action).toBe('voice');

    const odd = next<{ userId: number; action?: string }>(ben.socket, 'typing');
    ann.socket.emit('typing', { chatId: group.id, action: 'rm -rf' });
    expect((await odd).action).toBeUndefined();
  });
});
