import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';

let app: FastifyInstance;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'timba-secret-'));

beforeAll(async () => {
  config.dataDir = tmp;
  config.bloomsPassword = '5638';
  app = await buildApp({ dbFile: ':memory:' });
});

afterAll(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

let ipSeq = 0;
const blooms = (r: { headers: Record<string, unknown> }) =>
  ([r.headers['set-cookie']].flat().filter(Boolean) as string[]).find((c) => c.startsWith('tg_blooms='));
const cookieOf = (r: { headers: Record<string, unknown> }) => blooms(r)!.split(';')[0]!;

describe('/secret/blooms', () => {
  it('is locked without the PIN and opens with it, without an account', async () => {
    const locked = await app.inject({ method: 'GET', url: '/api/secret/blooms' });
    expect(JSON.parse(locked.body)).toEqual({ ok: false });

    const ip = `10.9.0.${++ipSeq}`;
    const wrong = await app.inject({ method: 'POST', url: '/api/secret/blooms/unlock', remoteAddress: ip, payload: { password: '1234' } });
    expect(wrong.statusCode).toBe(403);
    expect(JSON.parse(wrong.body).error).toBe('wrong_password');
    expect(blooms(wrong)).toBeUndefined();

    const right = await app.inject({ method: 'POST', url: '/api/secret/blooms/unlock', remoteAddress: ip, payload: { password: '5638' } });
    expect(right.statusCode).toBe(200);
    expect(JSON.parse(right.body)).toEqual({ ok: true, save: null });
    const cookie = cookieOf(right);
    expect(cookie).toMatch(/^tg_blooms=/);

    const open = await app.inject({ method: 'GET', url: '/api/secret/blooms', headers: { cookie } });
    expect(JSON.parse(open.body)).toEqual({ ok: true, save: null });
  });

  it('keeps the progress of an unlocked browser and refuses a forged cookie', async () => {
    const right = await app.inject({ method: 'POST', url: '/api/secret/blooms/unlock', remoteAddress: `10.9.0.${++ipSeq}`, payload: { password: '5638' } });
    const cookie = cookieOf(right);
    const save = { xp: 1200, medals: { 'meadow:easy:standard': true } };
    const put = await app.inject({ method: 'PUT', url: '/api/secret/blooms/save', headers: { cookie }, payload: { save } });
    expect(put.statusCode).toBe(200);
    const back = await app.inject({ method: 'GET', url: '/api/secret/blooms', headers: { cookie } });
    expect(JSON.parse(back.body)).toEqual({ ok: true, save });

    // the same id with a made-up signature
    const forged = `${cookie.split('.')[0]}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
    expect(JSON.parse((await app.inject({ method: 'GET', url: '/api/secret/blooms', headers: { cookie: forged } })).body)).toEqual({ ok: false });
    expect((await app.inject({ method: 'PUT', url: '/api/secret/blooms/save', headers: { cookie: forged }, payload: { save } })).statusCode).toBe(403);
    // without the cookie nothing is written
    expect((await app.inject({ method: 'PUT', url: '/api/secret/blooms/save', payload: { save } })).statusCode).toBe(403);

    // entering the PIN again on the same browser keeps its progress
    const again = await app.inject({ method: 'POST', url: '/api/secret/blooms/unlock', remoteAddress: `10.9.0.${++ipSeq}`, headers: { cookie }, payload: { password: '5638' } });
    expect(JSON.parse(again.body)).toEqual({ ok: true, save });
  });

  it('locks every browser again when the PIN changes', async () => {
    const right = await app.inject({ method: 'POST', url: '/api/secret/blooms/unlock', remoteAddress: `10.9.0.${++ipSeq}`, payload: { password: '5638' } });
    const cookie = cookieOf(right);
    config.bloomsPassword = '0000';
    try {
      expect(JSON.parse((await app.inject({ method: 'GET', url: '/api/secret/blooms', headers: { cookie } })).body)).toEqual({ ok: false });
    } finally {
      config.bloomsPassword = '5638';
    }
    expect(JSON.parse((await app.inject({ method: 'GET', url: '/api/secret/blooms', headers: { cookie } })).body).ok).toBe(true);
  });

  it('limits PIN guesses from one address', async () => {
    const ip = `10.9.1.${++ipSeq}`;
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) {
      codes.push((await app.inject({ method: 'POST', url: '/api/secret/blooms/unlock', remoteAddress: ip, payload: { password: String(1000 + i) } })).statusCode);
    }
    expect(codes.slice(0, 8).every((c) => c === 403)).toBe(true);
    expect(codes.slice(8)).toEqual([429, 429]);
    // the right PIN does not slip through the limit either
    expect((await app.inject({ method: 'POST', url: '/api/secret/blooms/unlock', remoteAddress: ip, payload: { password: '5638' } })).statusCode).toBe(429);
  });

  it('carries the progress to another browser by its code', async () => {
    const a = cookieOf(await app.inject({ method: 'POST', url: '/api/secret/blooms/unlock', remoteAddress: `10.9.2.${++ipSeq}`, payload: { password: '5638' } }));
    const save = { xp: 777 };
    await app.inject({ method: 'PUT', url: '/api/secret/blooms/save', headers: { cookie: a }, payload: { save } });
    const { code } = JSON.parse((await app.inject({ method: 'GET', url: '/api/secret/blooms/code', headers: { cookie: a } })).body);
    expect(code).toBe(a.split('=')[1]!.split('.')[0]);

    // another browser, unlocked on its own, takes the code
    const b = cookieOf(await app.inject({ method: 'POST', url: '/api/secret/blooms/unlock', remoteAddress: `10.9.2.${++ipSeq}`, payload: { password: '5638' } }));
    const linked = await app.inject({ method: 'POST', url: '/api/secret/blooms/link', remoteAddress: `10.9.2.${++ipSeq}`, headers: { cookie: b }, payload: { code } });
    expect(JSON.parse(linked.body)).toEqual({ ok: true, save });
    const b2 = cookieOf(linked);
    expect(JSON.parse((await app.inject({ method: 'GET', url: '/api/secret/blooms', headers: { cookie: b2 } })).body)).toEqual({ ok: true, save });

    // a code nobody has, and a browser without the PIN
    expect((await app.inject({ method: 'POST', url: '/api/secret/blooms/link', remoteAddress: `10.9.2.${++ipSeq}`, headers: { cookie: b }, payload: { code: 'x'.repeat(24) } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/secret/blooms/link', remoteAddress: `10.9.2.${++ipSeq}`, payload: { code } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/secret/blooms/code' })).statusCode).toBe(403);
  });

  it('refuses a save that is too big', async () => {
    const right = await app.inject({ method: 'POST', url: '/api/secret/blooms/unlock', remoteAddress: `10.9.0.${++ipSeq}`, payload: { password: '5638' } });
    const cookie = cookieOf(right);
    const save = { junk: 'x'.repeat(800 * 1024) };
    const put = await app.inject({ method: 'PUT', url: '/api/secret/blooms/save', headers: { cookie }, payload: { save } });
    expect(put.statusCode).toBe(400);
  });
});
