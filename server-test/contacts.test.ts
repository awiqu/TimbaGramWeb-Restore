import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { db } from '../src/db.js';

let app: FastifyInstance;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'timba-contacts-'));

beforeAll(async () => {
  config.dataDir = tmp;
  config.adminPassword = 'adminpass';
  app = await buildApp({ dbFile: ':memory:' });
});

afterAll(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

let ipSeq = 0;
async function register(username: string, phone = '') {
  const r = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    remoteAddress: `10.7.0.${++ipSeq}`,
    payload: { username, password: 'secret123', firstName: username, phone },
  });
  expect(r.statusCode).toBe(200);
  const cookie = String(r.headers['set-cookie']).split(';')[0]!;
  const id = JSON.parse(r.body).id as number;
  const req = async (method: string, url: string, body?: unknown) => {
    const res = await app.inject({ method: method as 'GET', url, payload: body as object, headers: { cookie } });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };
  return { id, req };
}

describe('contacts', () => {
  it('starts empty, adds and removes one person, and shows it in the profile', async () => {
    const ann = await register('ct_ann');
    const ben = await register('ct_ben');
    expect((await ann.req('GET', '/api/contacts')).body).toEqual([]);

    const added = await ann.req('POST', '/api/contacts', { userId: ben.id });
    expect(added.status).toBe(200);
    expect(added.body.id).toBe(ben.id);
    // adding twice changes nothing
    expect((await ann.req('POST', '/api/contacts', { userId: ben.id })).status).toBe(200);
    expect((await ann.req('GET', '/api/contacts')).body.map((u: { id: number }) => u.id)).toEqual([ben.id]);
    expect((await ann.req('GET', `/api/users/${ben.id}`)).body.isContact).toBe(true);
    // the list is personal: Ben did not get Ann
    expect((await ben.req('GET', '/api/contacts')).body).toEqual([]);
    expect((await ben.req('GET', `/api/users/${ann.id}`)).body.isContact).toBe(false);

    expect((await ann.req('DELETE', `/api/contacts/${ben.id}`)).status).toBe(200);
    expect((await ann.req('GET', '/api/contacts')).body).toEqual([]);
    expect((await ann.req('GET', `/api/users/${ben.id}`)).body.isContact).toBe(false);
  });

  it('does not take yourself, bots, banned or missing people', async () => {
    const cy = await register('ct_cy');
    expect((await cy.req('POST', '/api/contacts', { userId: cy.id })).status).toBe(400);
    expect((await cy.req('POST', '/api/contacts', { userId: 999999 })).status).toBe(404);
    expect((await cy.req('POST', '/api/contacts', { userId: 'x' })).status).toBe(400);
    const bot = db.prepare(`SELECT id FROM users WHERE bot IS NOT NULL LIMIT 1`).get() as { id: number } | undefined;
    if (bot) expect((await cy.req('POST', '/api/contacts', { userId: bot.id })).status).toBe(400);
    const dan = await register('ct_dan');
    await cy.req('POST', '/api/contacts', { userId: dan.id });
    db.prepare('UPDATE users SET is_banned = 1 WHERE id = ?').run(dan.id);
    expect((await cy.req('GET', '/api/contacts')).body).toEqual([]);
    expect((await cy.req('POST', '/api/contacts', { userId: dan.id })).status).toBe(404);
  });

  it('imports a phone book by numbers in any spelling', async () => {
    const eve = await register('ct_eve', '+7 921 111-11-11');
    const fay = await register('ct_fay', '8 (921) 222-22-22');
    await register('ct_gus', '+49 151 2345 6789');
    const me = await register('ct_me', '+79213333333');

    const r = await me.req('POST', '/api/contacts/import', {
      contacts: [
        ['8 921 111 11 11'], // Eve, written the Russian way
        ['+7 (921) 222-22-22', '+1 202 555 0100'], // Fay with a second number
        ['+49 151 2345 6789'], // Gus
        ['+7 900 000 00 00'], // nobody here
        ['+7 921 333 33 33'], // the own number: not counted
        ['abc', ''], // no number at all: not counted
        ['9211111111'], // Eve once more
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(5);
    expect(r.body.found).toBe(4);
    expect(r.body.added.map((u: { username: string }) => u.username).sort()).toEqual(['ct_eve', 'ct_fay', 'ct_gus']);
    expect((await me.req('GET', '/api/contacts')).body).toHaveLength(3);

    // the same book again adds nobody
    const again = await me.req('POST', '/api/contacts/import', { contacts: [['+79211111111']] });
    expect(again.body).toMatchObject({ total: 1, found: 1, added: [] });
    // nobody gets the importing person for free
    expect((await eve.req('GET', '/api/contacts')).body).toEqual([]);
    expect((await fay.req('GET', '/api/contacts')).body).toEqual([]);
  });

  it('refuses a book that is too big and numbers that are not strings', async () => {
    const hal = await register('ct_hal');
    const big = Array.from({ length: 501 }, (_, i) => [`+7900${String(1000000 + i)}`]);
    expect((await hal.req('POST', '/api/contacts/import', { contacts: big })).status).toBe(400);
    expect((await hal.req('POST', '/api/contacts/import', { contacts: [[1234567890]] })).status).toBe(400);
    expect((await hal.req('POST', '/api/contacts/import', { contacts: [Array(6).fill('+79001234567')] })).status).toBe(400);
    expect((await hal.req('POST', '/api/contacts/import', {})).status).toBe(400);
  });

  it('limits how often a book is imported', async () => {
    const ivy = await register('ct_ivy');
    for (let i = 0; i < 20; i++) expect((await ivy.req('POST', '/api/contacts/import', { contacts: [] })).status).toBe(200);
    expect((await ivy.req('POST', '/api/contacts/import', { contacts: [] })).status).toBe(429);
  });

  it('is signed-in only', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/contacts' });
    expect(r.statusCode).toBe(401);
  });
});
