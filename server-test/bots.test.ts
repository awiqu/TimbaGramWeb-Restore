import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createBot } from '../src/bots/manage.js';
import { config } from '../src/config.js';
import { getUserRow } from '../src/serialize.js';

let app: FastifyInstance;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'timba-bots-'));

beforeAll(async () => {
  config.dataDir = tmp;
  config.adminPassword = 'adminpass';
  config.botAllowPrivate = true;
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

function client(cookie: string, id: number): Client {
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
    remoteAddress: `10.5.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`,
    payload: { username, password: 'secret123', firstName: username },
  });
  expect(r.statusCode).toBe(200);
  return client(String(r.headers['set-cookie']).split(';')[0]!, JSON.parse(r.body).id);
}

let adminSession: Promise<Client> | null = null;
const admin = () =>
  (adminSession ??= app
    .inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'adminpass' }, remoteAddress: '10.5.250.2' })
    .then((r) => client(String(r.headers['set-cookie']).split(';')[0]!, JSON.parse(r.body).id)));

async function fund(u: Client, amount: number) {
  expect((await (await admin()).req('POST', '/api/admin/bank/give', { userId: u.id, amount, set: true, notify: false })).status).toBe(200);
}

async function waitFor<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

// ---------- Bot API helpers ----------

async function api(token: string, method: string, payload?: Record<string, unknown>) {
  const r = await app.inject({ method: 'POST', url: `/bot${token}/${method}`, payload: payload as object });
  return { status: r.statusCode, body: JSON.parse(r.body) as any };
}

async function ok<T = any>(token: string, method: string, payload?: Record<string, unknown>): Promise<T> {
  const r = await api(token, method, payload);
  expect(r.body, `${method}: ${JSON.stringify(r.body)}`).toMatchObject({ ok: true });
  return r.body.result as T;
}

/** Everything the bot has been told so far (and confirms it). */
async function updates(token: string, offset?: number, timeout = 0) {
  return ok<any[]>(token, 'getUpdates', { offset, timeout });
}

function multipart(fields: Record<string, string>, files: { name: string; filename: string; type: string; data: Buffer }[]) {
  const boundary = '----timbatest' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  for (const f of files) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\nContent-Type: ${f.type}\r\n\r\n`));
    parts.push(f.data, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

const png = (color = '#3a7bd5') =>
  sharp({ create: { width: 40, height: 30, channels: 3, background: color } })
    .png()
    .toBuffer();

// ---------- people and bots ----------

/** A bot made through the service, owned by a funded user. */
async function makeBot(username: string, ownerName = `${username.replace(/bot$/i, '')}owner`) {
  const owner = await register(ownerName);
  await fund(owner, 100);
  const made = createBot(getUserRow(owner.id)!, `Bot ${username}`, username);
  return { owner, token: made.token, id: made.user.id, username };
}

/** The private chat between a person and a bot (the person opens it, like in the app). */
async function chatWithBot(u: Client, botId: number): Promise<number> {
  const chat = await u.req('POST', '/api/chats/private', { userId: botId });
  expect(chat.status).toBe(200);
  return chat.body.id;
}

async function say(u: Client, chatId: number, text: string) {
  const r = await u.req('POST', `/api/chats/${chatId}/messages`, { text });
  expect(r.status).toBe(200);
  return r.body;
}

const messagesOf = async (u: Client, chatId: number) => (await u.req('GET', `/api/chats/${chatId}/messages?limit=100`)).body as any[];

/** A message of the built-in bot that came after `afterId`. */
async function reply(u: Client, chatId: number, botId: number, afterId: number, n = 1) {
  return waitFor(async () => {
    const list = (await messagesOf(u, chatId)).filter((m) => m.id > afterId && m.senderId === botId);
    return list.length >= n ? list : undefined;
  });
}

const lastId = async (u: Client, chatId: number) => (await messagesOf(u, chatId)).at(-1)?.id ?? 0;

async function botUserId(u: Client, username: string): Promise<number> {
  const r = await u.req('GET', `/api/resolve/${username}`);
  expect(r.status).toBe(200);
  return r.body.user.id;
}

describe('built-in bots', () => {
  it('has @PremiumBot and @WeatherBot with a picture, a description and commands, and no @BotFather', async () => {
    const u = await register('bf_viewer');
    for (const [name, minCommands] of [['PremiumBot', 2], ['WeatherBot', 2]] as const) {
      const id = await botUserId(u, name);
      const profile = (await u.req('GET', `/api/users/${id}`)).body;
      expect(profile).toMatchObject({ isBot: true, username: name, online: false, lastSeenAt: null });
      expect(profile.avatarFileId).toBeTruthy();
      const info = (await u.req('GET', `/api/bots/${id}`)).body;
      expect(info).toMatchObject({ userId: id, builtin: true, privacyMode: true });
      expect(info.description.length).toBeGreaterThan(20);
      expect(info.about.length).toBeGreaterThan(3);
      expect(info.commands.length).toBeGreaterThanOrEqual(minCommands);
    }
    expect((await u.req('GET', '/api/resolve/BotFather')).status).toBe(404);
    // bots are found by search, but are no contacts
    expect((await u.req('GET', '/api/search?q=premiumbot')).body.users.map((x: any) => x.username)).toContain('PremiumBot');
    expect((await u.req('GET', '/api/contacts')).body.map((x: any) => x.username)).not.toContain('PremiumBot');
  });

  it('keeps «…bot» usernames for bots and lets nobody sign in as one', async () => {
    const dup = await app.inject({ method: 'POST', url: '/api/auth/register', remoteAddress: '10.6.0.1', payload: { username: 'fake_bot', password: 'secret123' } });
    expect(dup.statusCode).toBe(409);
    expect(JSON.parse(dup.body).error).toBe('username_reserved');
    const u = await register('rename_me');
    expect((await u.req('PATCH', '/api/me', { username: 'renamed_bot' })).status).toBe(409);
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '10.6.0.2', payload: { username: 'PremiumBot', password: '!' } });
    expect(login.statusCode).toBe(401);
  });

  it('cannot be called, paid or deleted by the admin', async () => {
    const u = await register('bf_nocalls');
    const id = await botUserId(u, 'PremiumBot');
    expect((await u.req('POST', '/api/bank/transfer', { userId: id, amount: 1 })).status).toBe(400);
    const a = await admin();
    const list = (await a.req('GET', '/api/admin/bots')).body;
    const test = list.find((b: any) => b.builtin === 'premiumbot');
    expect(test).toBeTruthy();
    expect((await a.req('DELETE', `/api/admin/bots/${test.user.id}`)).status).toBe(404);
    // nor changed in the manager
    expect((await a.req('PATCH', `/api/mybots/${test.user.id}`, { name: 'Другой' })).status).toBe(403);
    expect((await a.req('DELETE', `/api/mybots/${test.user.id}`)).status).toBe(403);
  });

  it('removes a built-in bot that no longer exists, with its chats', async () => {
    const u = await register('old_father_fan');
    const { db } = await import('../src/db.js');
    const { seedBuiltinBots } = await import('../src/bots/manage.js');
    const res = db.prepare(`INSERT INTO users (username, first_name, password_hash, created_at, is_bot) VALUES ('BotFather', 'BotFather', '!', 1, 1)`).run();
    const fatherId = Number(res.lastInsertRowid);
    db.prepare(`INSERT INTO bots (user_id, builtin, created_at) VALUES (?, 'botfather', 1)`).run(fatherId);
    const chat = await chatWithBot(u, fatherId);
    expect(((await u.req('GET', '/api/chats')).body as any[]).some((c) => c.id === chat)).toBe(true);
    await seedBuiltinBots();
    expect((await u.req('GET', '/api/resolve/BotFather')).status).toBe(404);
    expect(((await u.req('GET', '/api/chats')).body as any[]).some((c) => c.id === chat)).toBe(false);
    expect(db.prepare(`SELECT 1 FROM bots WHERE builtin = 'botfather'`).get()).toBeUndefined();
  });
});

describe('the removed @testbot', () => {
  it('goes away with its chats when the server starts', async () => {
    const u = await register('old_testbot_fan');
    const { db } = await import('../src/db.js');
    const { seedBuiltinBots } = await import('../src/bots/manage.js');
    const res = db.prepare(`INSERT INTO users (username, first_name, password_hash, created_at, is_bot) VALUES ('testbot', 'Тестовый бот', '!', 1, 1)`).run();
    const id = Number(res.lastInsertRowid);
    db.prepare(`INSERT INTO bots (user_id, builtin, created_at) VALUES (?, 'testbot', 1)`).run(id);
    const chat = await chatWithBot(u, id);
    expect(((await u.req('GET', '/api/chats')).body as any[]).some((c) => c.id === chat)).toBe(true);
    await seedBuiltinBots();
    expect((await u.req('GET', '/api/resolve/testbot')).status).toBe(404);
    expect(((await u.req('GET', '/api/chats')).body as any[]).some((c) => c.id === chat)).toBe(false);
    expect(db.prepare(`SELECT 1 FROM bots WHERE builtin = 'testbot'`).get()).toBeUndefined();
  });
});

describe('the bot manager (Settings → Расширенные настройки → Боты)', () => {
  it('makes a bot for ТК: checks the name and username, then shows the token', async () => {
    const u = await register('mgr_user');
    expect((await u.req('GET', '/api/mybots')).body).toMatchObject({ bots: [], price: 20, max: 20, createEnabled: true });
    const check = async (username: string) => (await u.req('GET', `/api/mybots/check?username=${username}`)).body.result;
    expect(await check('weather_bot')).toBe('ok');
    expect(await check('weather')).toBe('not_bot');
    expect(await check('x')).toBe('invalid');
    expect(await check('premiumbot')).toBe('taken');

    // 0 ТК are not enough for a 20 ТК bot
    await fund(u, 5);
    const poor = await u.req('POST', '/api/mybots', { name: 'Погода', username: 'weather_bot' });
    expect(poor.status).toBe(400);
    expect(poor.body.error).toBe('insufficient_funds');
    await fund(u, 50);
    for (const [body, error] of [
      [{ name: '', username: 'weather_bot' }, 'validation'],
      [{ name: 'Погода', username: 'weather' }, 'username_not_bot'],
      [{ name: 'Погода', username: 'x' }, 'username_invalid'],
      [{ name: 'Погода', username: 'premiumbot' }, 'username_taken'],
    ] as const) {
      const r = await u.req('POST', '/api/mybots', body);
      expect(r.status, JSON.stringify(r.body)).toBeGreaterThanOrEqual(400);
      if (error !== 'validation') expect(r.body.error).toBe(error);
    }
    // nothing was paid for the failures
    expect((await u.req('GET', '/api/bank')).body.balance).toBe(50);

    const made = await u.req('POST', '/api/mybots', { name: 'Погода', username: '@weather_bot' });
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ price: 20, balance: 30 });
    const bot = made.body.bot;
    expect(bot.user).toMatchObject({ username: 'weather_bot', firstName: 'Погода', isBot: true });
    expect(bot.token).toMatch(/^\d+:[\w-]+$/);
    expect(bot).toMatchObject({ wallet: 'bot', walletBalance: 0, canJoinGroups: true, privacyMode: true, commands: [] });
    expect((await u.req('GET', '/api/bank/history')).body.items[0]).toMatchObject({ kind: 'bot', amount: -20 });

    // the token works and the bot is findable
    const me = await ok(bot.token, 'getMe');
    expect(me).toMatchObject({ is_bot: true, username: 'weather_bot', first_name: 'Погода', can_join_groups: true });
    expect((await u.req('GET', '/api/resolve/weather_bot')).body.user).toMatchObject({ isBot: true });
    expect((await u.req('GET', '/api/mybots')).body.bots.map((b: any) => b.user.username)).toEqual(['weather_bot']);
    // the list does not carry tokens
    expect(JSON.stringify((await u.req('GET', '/api/mybots')).body)).not.toContain(bot.token);
  });

  it('changes the name, username, texts, commands, groups, privacy and picture', async () => {
    const { owner, id, token } = await makeBot('edit_bot');
    const path = `/api/mybots/${id}`;
    const patch = (body: unknown) => owner.req('PATCH', path, body);

    expect((await patch({ name: 'Новое имя', description: 'Умею многое', about: 'Коротко' })).body).toMatchObject({
      user: { firstName: 'Новое имя' },
      description: 'Умею многое',
      about: 'Коротко',
    });
    expect((await ok(token, 'getMyDescription')).description).toBe('Умею многое');
    expect((await owner.req('GET', `/api/bots/${id}`)).body).toMatchObject({ description: 'Умею многое', about: 'Коротко' });

    const cmds = await patch({ commands: [{ command: '/Start', description: 'Начать' }, { command: 'help', description: 'Справка' }] });
    expect(cmds.body.commands).toEqual([{ command: 'start', description: 'Начать' }, { command: 'help', description: 'Справка' }]);
    expect(await ok(token, 'getMyCommands')).toEqual(cmds.body.commands);
    expect((await patch({ commands: [{ command: 'BAD COMMAND', description: 'x' }] })).status).toBe(400);
    expect((await patch({ commands: [{ command: 'a', description: 'x' }, { command: 'a', description: 'y' }] })).status).toBe(400);
    expect((await patch({ description: 'я'.repeat(513) })).status).toBe(400);
    expect((await patch({ about: 'я'.repeat(121) })).status).toBe(400);

    expect((await patch({ canJoinGroups: false, privacyMode: false })).body).toMatchObject({ canJoinGroups: false, privacyMode: false });
    expect(await ok(token, 'getMe')).toMatchObject({ can_join_groups: false, can_read_all_group_messages: true });

    // a new username keeps the token, frees the old name and obeys the rules
    expect((await patch({ username: 'renamed_bot' })).body.user.username).toBe('renamed_bot');
    expect((await ok(token, 'getMe')).username).toBe('renamed_bot');
    expect((await owner.req('GET', '/api/resolve/edit_bot')).status).toBe(404);
    expect((await patch({ username: 'renamed' })).status).toBe(400);
    expect((await patch({ username: 'premiumbot' })).status).toBe(409);
    expect((await patch({ username: 'renamed_bot' })).status).toBe(200);

    // the picture: a photo the owner uploaded
    const form = multipart({}, [{ name: 'file', filename: 'ava.png', type: 'image/png', data: await png() }]);
    const up = await app.inject({ method: 'POST', url: '/api/files', payload: form.payload, headers: { ...form.headers, cookie: owner.cookie } });
    const fileId = JSON.parse(up.body).id as string;
    expect((await patch({ avatarFileId: fileId })).body.user.avatarFileId).toBe(fileId);
    expect((await owner.req('GET', `/api/users/${id}`)).body.avatarFileId).toBe(fileId);
    expect((await patch({ avatarFileId: null })).body.user.avatarFileId).toBeNull();
    // somebody else's file is refused
    const other = await register('mgr_other_photo');
    const form2 = multipart({}, [{ name: 'file', filename: 'o.png', type: 'image/png', data: await png('#aa3355') }]);
    const up2 = await app.inject({ method: 'POST', url: '/api/files', payload: form2.payload, headers: { ...form2.headers, cookie: other.cookie } });
    expect((await patch({ avatarFileId: JSON.parse(up2.body).id })).status).toBeGreaterThanOrEqual(400);
  });

  it('shows the token to the owner and the admin only, and revokes it', async () => {
    const { owner, id, token } = await makeBot('tok_bot');
    const stranger = await register('mgr_stranger');
    const a = await admin();
    expect((await owner.req('GET', `/api/mybots/${id}`)).body.token).toBe(token);
    expect((await a.req('GET', `/api/mybots/${id}`)).body.token).toBe(token);
    for (const r of [await stranger.req('GET', `/api/mybots/${id}`), await stranger.req('PATCH', `/api/mybots/${id}`, { name: 'X' }), await stranger.req('DELETE', `/api/mybots/${id}`), await stranger.req('POST', `/api/mybots/${id}/revoke`)]) {
      expect(r.status).toBe(403);
    }
    const revoked = await owner.req('POST', `/api/mybots/${id}/revoke`);
    expect(revoked.body.token).not.toBe(token);
    expect((await api(token, 'getMe')).status).toBe(401);
    await ok(revoked.body.token, 'getMe');
  });

  it('is run by the admin too: name, username, picture and delete', async () => {
    const { owner, id, token } = await makeBot('adm2_bot');
    const a = await admin();
    expect((await a.req('PATCH', `/api/mybots/${id}`, { name: 'Админ поменял', username: 'adm2_changed_bot' })).body.user).toMatchObject({ firstName: 'Админ поменял', username: 'adm2_changed_bot' });
    // the till is the owner's choice: the admin cannot switch it
    expect((await a.req('PATCH', `/api/mybots/${id}`, { wallet: 'owner' })).status).toBe(403);
    expect((await a.req('DELETE', `/api/mybots/${id}`)).status).toBe(200);
    expect((await api(token, 'getMe')).status).toBe(401);
    expect((await owner.req('GET', '/api/mybots')).body.bots).toHaveLength(0);
  });

  it('has a till: the owner chooses whose money it is, withdraws and reads the book', async () => {
    const { owner, id, token } = await makeBot('till_bot');
    const customer = await register('till_customer');
    await fund(customer, 100);
    const chat = await chatWithBot(customer, id);
    await say(customer, chat, '/start');
    const msg = await ok(token, 'sendInvoice', { chat_id: customer.id, title: 'Кофе', amount: 40 });
    await customer.req('POST', `/api/invoices/${msg.invoice.invoice_id}/pay`);

    let bot = (await owner.req('GET', `/api/mybots/${id}`)).body;
    expect(bot).toMatchObject({ wallet: 'bot', walletBalance: 40, ownBalance: 40, paidInvoices: 1, earned: 40 });
    const ledger = (await owner.req('GET', `/api/mybots/${id}/ledger`)).body;
    expect(ledger.items[0]).toMatchObject({ type: 'payment', amount: 40, user: { id: customer.id } });

    const before = (await owner.req('GET', '/api/bank')).body.balance;
    expect((await owner.req('POST', `/api/mybots/${id}/withdraw`, { amount: 15 })).body).toMatchObject({ withdrawn: 15 });
    expect((await owner.req('POST', `/api/mybots/${id}/withdraw`, {})).body.withdrawn).toBe(25);
    expect((await owner.req('GET', '/api/bank')).body.balance).toBe(before + 40);
    expect((await owner.req('POST', `/api/mybots/${id}/withdraw`, {})).status).toBe(400);
    expect((await owner.req('GET', `/api/mybots/${id}/ledger`)).body.items.map((x: any) => x.type)).toEqual(['withdraw', 'withdraw', 'payment']);

    // the owner's balance as the till
    bot = (await owner.req('PATCH', `/api/mybots/${id}`, { wallet: 'owner' })).body;
    expect(bot).toMatchObject({ wallet: 'owner', walletBalance: before + 40 });
    expect(await ok(token, 'getMyBalance')).toMatchObject({ wallet: 'owner', balance: before + 40 });
    expect((await owner.req('PATCH', `/api/mybots/${id}`, { wallet: 'bot' })).body.wallet).toBe('bot');
  });

  it('deletes a bot: the token dies, the till goes to the owner, the price does not come back', async () => {
    const { owner, id, token } = await makeBot('gone_bot');
    const customer = await register('gone_customer');
    await fund(customer, 100);
    const chat = await chatWithBot(customer, id);
    await say(customer, chat, '/start');
    const msg = await ok(token, 'sendInvoice', { chat_id: customer.id, title: 'Кофе', amount: 30 });
    await customer.req('POST', `/api/invoices/${msg.invoice.invoice_id}/pay`);
    const before = (await owner.req('GET', '/api/bank')).body.balance;
    expect((await owner.req('DELETE', `/api/mybots/${id}`)).status).toBe(200);
    expect((await owner.req('GET', '/api/bank')).body.balance).toBe(before + 30);
    expect((await api(token, 'getMe')).status).toBe(401);
    expect((await owner.req('GET', `/api/mybots/${id}`)).status).toBe(404);
    expect((await owner.req('GET', '/api/resolve/gone_bot')).status).toBe(404);
  });
});

describe('Bot API basics', () => {
  it('answers like Telegram: ok/result, errors with codes, unknown methods and tokens', async () => {
    const { token } = await makeBot('basic_bot');
    const me = await api(token, 'getMe');
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ ok: true, result: { username: 'basic_bot', is_bot: true } });
    // methods are not case sensitive, GET works with a query string
    const get = await app.inject({ method: 'GET', url: `/bot${token}/GETME` });
    expect(JSON.parse(get.body).ok).toBe(true);
    expect(await api('123:wrong-token-wrong-token-wrong', 'getMe')).toMatchObject({ status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } });
    expect(await api('garbage', 'getMe')).toMatchObject({ status: 401 });
    expect(await api(token, 'noSuchMethod')).toMatchObject({ status: 404, body: { ok: false, error_code: 404 } });
    expect(await api(token, 'sendMessage', { text: 'x' })).toMatchObject({ status: 400, body: { description: 'Bad Request: chat_id is empty' } });
    // a bot cannot start talking to a person
    const stranger = await register('basic_stranger');
    expect(await api(token, 'sendMessage', { chat_id: stranger.id, text: 'hi' })).toMatchObject({
      status: 403,
      body: { description: "Forbidden: bot can't initiate conversation with a user" },
    });
    expect(await api(token, 'sendMessage', { chat_id: 999999, text: 'hi' })).toMatchObject({ status: 400, body: { description: 'Bad Request: chat not found' } });
  });

  it('takes JSON, forms and queries, with objects as JSON strings', async () => {
    const { token, id } = await makeBot('forms_bot');
    const u = await register('forms_user');
    const chat = await chatWithBot(u, id);
    await say(u, chat, 'привет');
    // form-urlencoded, like pyTelegramBotAPI sends it
    const form = new URLSearchParams({
      chat_id: String(u.id),
      text: 'из формы',
      reply_markup: JSON.stringify({ inline_keyboard: [[{ text: 'Жми', callback_data: 'x' }]] }),
      disable_notification: 'true',
    });
    const r = await app.inject({ method: 'POST', url: `/bot${token}/sendMessage`, payload: form.toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(JSON.parse(r.body)).toMatchObject({ ok: true, result: { text: 'из формы', chat: { id: u.id, type: 'private' }, reply_markup: { inline_keyboard: [[{ text: 'Жми', callback_data: 'x' }]] } } });
    // GET with a query
    const q = await app.inject({ method: 'GET', url: `/bot${token}/sendMessage?chat_id=${u.id}&text=${encodeURIComponent('из адреса')}` });
    expect(JSON.parse(q.body).result.text).toBe('из адреса');
    const shown = (await messagesOf(u, chat)).filter((m) => m.senderId === id);
    expect(shown.map((m) => m.text)).toEqual(['из формы', 'из адреса']);
    expect(shown[0]).toMatchObject({ silent: true, replyMarkup: { rows: [[{ text: 'Жми', callbackData: 'x' }]] } });
  });
});

describe('looking people up', () => {
  it('finds a person by @username, any case, and says so when there is nobody', async () => {
    const { token } = await makeBot('find_bot');
    const target = await register('FindMeNow');
    for (const name of ['FindMeNow', '@findmenow', ' @FINDMENOW ']) {
      expect(await ok(token, 'getUserByUsername', { username: name })).toEqual({ id: target.id, is_bot: false, first_name: 'FindMeNow', username: 'FindMeNow' });
    }
    // a bot is a user, too
    expect(await ok(token, 'getUserByUsername', { username: 'PremiumBot' })).toMatchObject({ is_bot: true, username: 'PremiumBot' });
    // Премиум shows
    const { extendPremium } = await import('../src/premium.js');
    extendPremium(target.id, 5);
    expect((await ok(token, 'getUserByUsername', { username: 'findmenow' })).is_premium).toBe(true);

    for (const [params, text] of [[{ username: 'nobody_here_at_all' }, /user not found/], [{ username: '@' }, /username is empty/], [{}, /username is empty/]] as const) {
      const r = await api(token, 'getUserByUsername', params as Record<string, unknown>);
      expect(r.status).toBe(400);
      expect(r.body.description).toMatch(text);
    }
    // an account the admin banned is not found
    const { db } = await import('../src/db.js');
    db.prepare('UPDATE users SET is_banned = 1 WHERE id = ?').run(target.id);
    expect((await api(token, 'getUserByUsername', { username: 'FindMeNow' })).status).toBe(400);
    db.prepare('UPDATE users SET is_banned = 0 WHERE id = ?').run(target.id);
  });

  it('answers GET with a query string and limits how fast a bot may look people up', async () => {
    const { token } = await makeBot('limit_find_bot');
    const r = await app.inject({ method: 'GET', url: `/bot${token}/getUserByUsername?username=PremiumBot` });
    expect(JSON.parse(r.body)).toMatchObject({ ok: true, result: { username: 'PremiumBot' } });
    let last = { status: 200, body: {} as any };
    for (let i = 0; i < 125 && last.status === 200; i++) last = await api(token, 'getUserByUsername', { username: 'PremiumBot' });
    expect(last.status).toBe(429);
    expect(last.body.parameters.retry_after).toBeGreaterThanOrEqual(1);
  });
});

describe('updates', () => {
  it('hands out messages with an offset, waits for new ones and keeps what is not confirmed', async () => {
    const { token, id } = await makeBot('poll_bot');
    const u = await register('poll_person');
    const chat = await chatWithBot(u, id);
    expect(await updates(token)).toEqual([]);

    await say(u, chat, 'один');
    await say(u, chat, '/start привет');
    const first = await updates(token);
    expect(first).toHaveLength(2);
    expect(first[0].update_id).toBeLessThan(first[1].update_id);
    expect(first[0].message).toMatchObject({
      text: 'один',
      from: { id: u.id, is_bot: false, username: 'poll_person' },
      chat: { id: u.id, type: 'private' },
    });
    expect(first[1].message.entities).toEqual([{ type: 'bot_command', offset: 0, length: 6 }]);
    // not confirmed: they come again; the offset confirms
    expect(await updates(token)).toHaveLength(2);
    expect(await updates(token, first[1].update_id)).toHaveLength(1);
    expect(await updates(token, first[1].update_id + 1)).toEqual([]);

    // long polling: the call waits and is answered when the message comes
    const waiting = updates(token, first[1].update_id + 1, 5);
    await new Promise((r) => setTimeout(r, 100));
    await say(u, chat, 'позже');
    const late = await waiting;
    expect(late).toHaveLength(1);
    expect(late[0].message.text).toBe('позже');

    // a second getUpdates ends the first one with a conflict
    const a = api(token, 'getUpdates', { offset: late[0].update_id + 1, timeout: 5 });
    await new Promise((r) => setTimeout(r, 50));
    const b = api(token, 'getUpdates', { offset: late[0].update_id + 1, timeout: 1 });
    expect((await a).body).toMatchObject({ ok: false, error_code: 409 });
    expect((await b).body.ok).toBe(true);
  });

  it('does not tell a bot about its own messages, only about what it asked for', async () => {
    const { token, id } = await makeBot('filter_bot');
    const u = await register('filter_person');
    const chat = await chatWithBot(u, id);
    await ok(token, 'getUpdates', { allowed_updates: ['edited_message'] });
    await say(u, chat, 'не нужно');
    await ok(token, 'sendMessage', { chat_id: u.id, text: 'сам себе' });
    expect(await updates(token)).toEqual([]);
    const mid = (await messagesOf(u, chat))[0].id;
    await u.req('PATCH', `/api/messages/${mid}`, { text: 'исправлено' });
    const [edit] = await updates(token);
    expect(edit.edited_message).toMatchObject({ text: 'исправлено', edit_date: expect.any(Number) });
  });

  it('delivers to a webhook and refuses getUpdates while it is set', async () => {
    const { token, id } = await makeBot('hook_bot');
    const got: { headers: http.IncomingHttpHeaders; body: any }[] = [];
    const server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        got.push({ headers: req.headers, body: JSON.parse(data) });
        res.end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    try {
      const u = await register('hook_person');
      const chat = await chatWithBot(u, id);
      await say(u, chat, 'до вебхука');
      await ok(token, 'setWebhook', { url: `http://127.0.0.1:${port}/hook`, secret_token: 's3cret' });
      // what was waiting is delivered, then the live ones
      await waitFor(() => got.length >= 1);
      await say(u, chat, 'после вебхука');
      await waitFor(() => got.length >= 2);
      expect(got.map((g) => g.body.message.text)).toEqual(['до вебхука', 'после вебхука']);
      expect(got[0]!.headers['x-telegram-bot-api-secret-token']).toBe('s3cret');
      expect(await api(token, 'getUpdates')).toMatchObject({ status: 409 });
      const info = await ok(token, 'getWebhookInfo');
      expect(info).toMatchObject({ url: `http://127.0.0.1:${port}/hook`, pending_update_count: 0 });
      await ok(token, 'deleteWebhook');
      await say(u, chat, 'снова опрос');
      expect((await updates(token)).map((x) => x.message.text)).toEqual(['снова опрос']);
    } finally {
      server.close();
    }
  });

  it('refuses webhooks to internal addresses unless the server allows them', async () => {
    const { token } = await makeBot('ssrf_bot');
    config.botAllowPrivate = false;
    try {
      expect(await api(token, 'setWebhook', { url: 'http://127.0.0.1:9/hook' })).toMatchObject({ status: 400 });
      expect(await api(token, 'setWebhook', { url: 'http://169.254.169.254/latest' })).toMatchObject({ status: 400 });
      expect(await api(token, 'setWebhook', { url: 'ftp://example.com/hook' })).toMatchObject({ status: 400 });
    } finally {
      config.botAllowPrivate = true;
    }
  });
});

/** A bot, a person who has written to it, and what the bot was told so far (confirmed). */
async function talkingPair(botName: string, personName: string) {
  const bot = await makeBot(botName);
  const person = await register(personName);
  const chat = await chatWithBot(person, bot.id);
  const first = await say(person, chat, 'начнём');
  const [u] = await updates(bot.token);
  await updates(bot.token, u.update_id + 1);
  return { ...bot, person, chat, first };
}

describe('sending', () => {
  it('formats text with HTML, Markdown and entities and gives entities back', async () => {
    const { token, person, chat } = await talkingPair('fmt_bot', 'fmt_person');
    const sent = await ok(token, 'sendMessage', { chat_id: person.id, text: '<b>жирный</b> и <i>курсив</i> <a href="https://a.example/x">ссылка</a> <code>код</code>', parse_mode: 'HTML' });
    expect(sent.text).toBe('жирный и курсив ссылка код');
    expect(sent.entities.map((e: any) => e.type)).toEqual(['bold', 'italic', 'text_link', 'code']);
    await ok(token, 'sendMessage', { chat_id: person.id, text: '*bold* _it_ `c`', parse_mode: 'Markdown' });
    await ok(token, 'sendMessage', { chat_id: person.id, text: 'plain bold', entities: [{ type: 'bold', offset: 6, length: 4 }] });
    const shown = (await messagesOf(person, chat)).filter((m) => m.senderId !== person.id).map((m) => m.text);
    expect(shown).toEqual(['**жирный** и __курсив__ [ссылка](https://a.example/x) `код`', '**bold** __it__ `c`', 'plain **bold**']);
    // what a person writes comes back as text and entities
    await say(person, chat, '/help **важно** @someone https://ex.com/a');
    const [u] = await updates(token);
    expect(u.message.text).toBe('/help важно @someone https://ex.com/a');
    expect(u.message.entities.map((e: any) => e.type)).toEqual(['bot_command', 'bold', 'mention', 'url']);
    expect(await api(token, 'sendMessage', { chat_id: person.id, text: '   ' })).toMatchObject({ status: 400, body: { description: 'Bad Request: message text is empty' } });
    expect((await api(token, 'sendMessage', { chat_id: person.id, text: 'x'.repeat(5000) })).status).toBe(400);
  });

  it('replies, edits, deletes, forwards, copies and pins', async () => {
    const { token, person, chat, first } = await talkingPair('edit2_bot', 'edit2_person');
    const m1 = await ok(token, 'sendMessage', { chat_id: person.id, text: 'раз', reply_to_message_id: first.id });
    expect(m1.reply_to_message).toMatchObject({ message_id: first.id, text: 'начнём' });
    expect((await messagesOf(person, chat)).find((m) => m.id === m1.message_id).replyTo.id).toBe(first.id);
    expect(await api(token, 'sendMessage', { chat_id: person.id, text: 'x', reply_parameters: { message_id: 99999 } })).toMatchObject({ status: 400 });
    expect((await api(token, 'sendMessage', { chat_id: person.id, text: 'x', reply_parameters: { message_id: 99999 }, allow_sending_without_reply: true })).status).toBe(200);

    const edited = await ok(token, 'editMessageText', { chat_id: person.id, message_id: m1.message_id, text: 'один', reply_markup: { inline_keyboard: [[{ text: 'A', callback_data: 'a' }]] } });
    expect(edited).toMatchObject({ text: 'один', edit_date: expect.any(Number) });
    const shown = (await messagesOf(person, chat)).find((m) => m.id === m1.message_id);
    expect(shown).toMatchObject({ text: 'один', replyMarkup: { rows: [[{ text: 'A', callbackData: 'a' }]] } });
    expect(shown.editedAt).toBeTruthy();
    // the same again is an error, and so is somebody else's message
    expect(await api(token, 'editMessageText', { chat_id: person.id, message_id: m1.message_id, text: 'один', reply_markup: { inline_keyboard: [[{ text: 'A', callback_data: 'a' }]] } })).toMatchObject({
      status: 400,
      body: { description: expect.stringContaining('message is not modified') },
    });
    expect(await api(token, 'editMessageText', { chat_id: person.id, message_id: first.id, text: 'чужое' })).toMatchObject({ status: 400, body: { description: "Bad Request: message can't be edited" } });
    // without a new keyboard the old one goes away; editMessageReplyMarkup changes only the keyboard
    await ok(token, 'editMessageText', { chat_id: person.id, message_id: m1.message_id, text: 'два' });
    expect((await messagesOf(person, chat)).find((m) => m.id === m1.message_id).replyMarkup).toBeUndefined();
    await ok(token, 'editMessageReplyMarkup', { chat_id: person.id, message_id: m1.message_id, reply_markup: { inline_keyboard: [[{ text: 'B', url: 'https://b.example' }]] } });
    expect((await messagesOf(person, chat)).find((m) => m.id === m1.message_id)).toMatchObject({ text: 'два', replyMarkup: { rows: [[{ text: 'B', url: 'https://b.example' }]] } });

    const fwd = await ok(token, 'forwardMessage', { chat_id: person.id, from_chat_id: person.id, message_id: first.id });
    expect(fwd.forward_origin).toMatchObject({ type: 'user', sender_user: { username: 'edit2_person' } });
    const copy = await ok(token, 'copyMessage', { chat_id: person.id, from_chat_id: person.id, message_id: first.id });
    expect((await messagesOf(person, chat)).find((m) => m.id === copy.message_id)).toMatchObject({ text: 'начнём', forwardedFrom: null, senderId: expect.not.stringMatching(/^$/) });

    await ok(token, 'pinChatMessage', { chat_id: person.id, message_id: m1.message_id });
    expect((await person.req('GET', `/api/chats/${chat}`)).body.pinned.map((m: any) => m.id)).toEqual([m1.message_id]);
    await ok(token, 'unpinAllChatMessages', { chat_id: person.id });
    expect((await person.req('GET', `/api/chats/${chat}`)).body.pinned).toEqual([]);

    await ok(token, 'deleteMessage', { chat_id: person.id, message_id: m1.message_id });
    expect((await messagesOf(person, chat)).some((m) => m.id === m1.message_id)).toBe(false);
    expect(await api(token, 'deleteMessage', { chat_id: person.id, message_id: m1.message_id })).toMatchObject({ status: 400 });
    await ok(token, 'sendChatAction', { chat_id: person.id, action: 'typing' });
  });

  it('shows reply keyboards under the input field until they are removed', async () => {
    const { token, person, chat } = await talkingPair('kb_bot', 'kb_person');
    const keyboard = { keyboard: [['Да', 'Нет'], [{ text: 'Может быть' }]], resize_keyboard: true, input_field_placeholder: 'Выберите' };
    const sent = await ok(token, 'sendMessage', { chat_id: person.id, text: 'Выбирай', reply_markup: keyboard });
    const kb = (await person.req('GET', `/api/chats/${chat}`)).body.keyboard;
    expect(kb).toEqual({ type: 'keyboard', rows: [['Да', 'Нет'], ['Может быть']], resize: true, oneTime: false, placeholder: 'Выберите', messageId: sent.message_id, botId: expect.any(Number) });
    // it stays when the person answers (not one-time)
    await say(person, chat, 'Да');
    expect((await person.req('GET', `/api/chats/${chat}`)).body.keyboard).not.toBeNull();
    await ok(token, 'sendMessage', { chat_id: person.id, text: 'Спасибо', reply_markup: { remove_keyboard: true } });
    expect((await person.req('GET', `/api/chats/${chat}`)).body.keyboard).toBeNull();
    // a one-time keyboard and a force reply go away with the next message of the person
    await ok(token, 'sendMessage', { chat_id: person.id, text: 'Один раз', reply_markup: { keyboard: [['Ок']], one_time_keyboard: true } });
    expect((await person.req('GET', `/api/chats/${chat}`)).body.keyboard).not.toBeNull();
    await say(person, chat, 'Ок');
    expect((await person.req('GET', `/api/chats/${chat}`)).body.keyboard).toBeNull();
    const ask = await ok(token, 'sendMessage', { chat_id: person.id, text: 'Имя?', reply_markup: { force_reply: true, input_field_placeholder: 'Ваше имя' } });
    expect((await person.req('GET', `/api/chats/${chat}`)).body.keyboard).toMatchObject({ type: 'force_reply', placeholder: 'Ваше имя', messageId: ask.message_id });
    await say(person, chat, 'Аня');
    expect((await person.req('GET', `/api/chats/${chat}`)).body.keyboard).toBeNull();
    expect(await api(token, 'sendMessage', { chat_id: person.id, text: 'x', reply_markup: { inline_keyboard: [[{ text: '', callback_data: 'a' }]] } })).toMatchObject({ status: 400 });
    expect(await api(token, 'sendMessage', { chat_id: person.id, text: 'x', reply_markup: { inline_keyboard: [[{ text: 'a', callback_data: 'x'.repeat(65) }]] } })).toMatchObject({ status: 400 });
    expect(await api(token, 'sendMessage', { chat_id: person.id, text: 'x', reply_markup: { inline_keyboard: [[{ text: 'a' }]] } })).toMatchObject({ status: 400 });
  });

  it('turns button presses into callback queries and answers them', async () => {
    const { token, person, chat } = await talkingPair('cb_bot', 'cb_person');
    const sent = await ok(token, 'sendMessage', {
      chat_id: person.id,
      text: 'Кнопки',
      reply_markup: { inline_keyboard: [[{ text: 'Раз', callback_data: 'one' }, { text: 'Копировать', copy_text: { text: 'секрет' } }], [{ text: 'Сайт', url: 'https://x.example' }]] },
    });
    const shown = (await messagesOf(person, chat)).find((m) => m.id === sent.message_id);
    expect(shown.replyMarkup.rows[0][1]).toEqual({ text: 'Копировать', copyText: 'секрет' });
    // only a button that is there can be pressed, and only by somebody in the chat
    expect((await person.req('POST', `/api/messages/${sent.message_id}/callback`, { data: 'nope' })).status).toBe(400);
    const outsider = await register('cb_outsider');
    expect((await outsider.req('POST', `/api/messages/${sent.message_id}/callback`, { data: 'one' })).status).toBe(403);
    const press = await person.req('POST', `/api/messages/${sent.message_id}/callback`, { data: 'one' });
    expect(press.status).toBe(200);
    const [u] = await updates(token);
    expect(u.callback_query).toMatchObject({
      id: press.body.id,
      from: { id: person.id },
      data: 'one',
      message: { message_id: sent.message_id, text: 'Кнопки', chat: { id: person.id } },
    });
    await ok(token, 'answerCallbackQuery', { callback_query_id: press.body.id, text: 'Нажато', show_alert: true });
    // an answer is accepted once
    expect(await api(token, 'answerCallbackQuery', { callback_query_id: press.body.id })).toMatchObject({ status: 400 });
    expect(await api(token, 'answerCallbackQuery', { callback_query_id: 'deadbeef' })).toMatchObject({ status: 400 });
  });

  it('uploads photos, documents and files by id or link, and lets the bot download what it received', async () => {
    const { token, person, chat } = await talkingPair('media_bot', 'media_person');
    const data = await png('#e0457b');
    const form = multipart({ chat_id: String(person.id), caption: '**подпись**' }, [{ name: 'photo', filename: 'pic.png', type: 'image/png', data }]);
    const r = await app.inject({ method: 'POST', url: `/bot${token}/sendPhoto`, payload: form.payload, headers: form.headers });
    const sent = JSON.parse(r.body);
    expect(sent.ok, r.body).toBe(true);
    expect(sent.result.photo).toHaveLength(1);
    expect(sent.result.photo[0]).toMatchObject({ width: 40, height: 30, file_size: data.length });
    expect(sent.result.caption).toBe('подпись');
    expect(sent.result.caption_entities).toEqual([{ type: 'bold', offset: 0, length: 7 }]);
    const shown = (await messagesOf(person, chat)).find((m) => m.id === sent.result.message_id);
    expect(shown).toMatchObject({ kind: 'media', text: '**подпись**', attachments: [{ kind: 'photo', width: 40, height: 30 }] });

    // the file can be sent again by its id, and downloaded
    const fileId = sent.result.photo[0].file_id as string;
    const again = await ok(token, 'sendPhoto', { chat_id: person.id, photo: fileId });
    expect(again.photo[0].file_id).toBe(fileId);
    const info = await ok(token, 'getFile', { file_id: fileId });
    expect(info).toMatchObject({ file_id: fileId, file_size: data.length });
    const dl = await app.inject({ method: 'GET', url: `/file/bot${token}/${info.file_path}` });
    expect(dl.statusCode).toBe(200);
    expect(Buffer.compare(dl.rawPayload, data)).toBe(0);
    expect((await app.inject({ method: 'GET', url: `/file/bot${token}/2020-01/nothing.png` })).statusCode).toBe(404);

    // a document, and a file nobody is allowed to see
    const doc = multipart({ chat_id: String(person.id) }, [{ name: 'document', filename: 'notes.txt', type: 'text/plain', data: Buffer.from('привет') }]);
    const d = JSON.parse((await app.inject({ method: 'POST', url: `/bot${token}/sendDocument`, payload: doc.payload, headers: doc.headers })).body);
    expect(d.result.document).toMatchObject({ file_name: 'notes.txt', mime_type: 'text/plain', file_size: 12 });
    const other = await makeBot('media2_bot');
    expect(await api(other.token, 'getFile', { file_id: fileId })).toMatchObject({ status: 400, body: { description: 'Bad Request: wrong file_id' } });
    const otherChat = await chatWithBot(person, other.id);
    await say(person, otherChat, 'привет второму');
    expect(await api(other.token, 'sendPhoto', { chat_id: person.id, photo: fileId })).toMatchObject({ status: 400, body: { description: expect.stringContaining('wrong file identifier') } });

    // not a picture
    const bad = multipart({ chat_id: String(person.id) }, [{ name: 'photo', filename: 'x.txt', type: 'text/plain', data: Buffer.from('no') }]);
    expect(JSON.parse((await app.inject({ method: 'POST', url: `/bot${token}/sendPhoto`, payload: bad.payload, headers: bad.headers })).body)).toMatchObject({ ok: false, error_code: 400 });

    // a file from the web, fetched by the server
    const server = http.createServer((req, res) => {
      res.setHeader('content-type', 'image/png');
      res.end(data);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/a/b.png`;
      expect((await ok(token, 'sendPhoto', { chat_id: person.id, photo: url })).photo[0]).toMatchObject({ width: 40 });
      config.botAllowPrivate = false;
      expect(await api(token, 'sendPhoto', { chat_id: person.id, photo: url })).toMatchObject({ status: 400, body: { description: expect.stringContaining('failed to get HTTP URL content') } });
    } finally {
      config.botAllowPrivate = true;
      server.close();
    }

    // what a person sends reaches the bot with file ids it can use
    const form2 = multipart({}, [{ name: 'file', filename: 'mine.png', type: 'image/png', data }]);
    const up = JSON.parse((await app.inject({ method: 'POST', url: '/api/files', payload: form2.payload, headers: { ...form2.headers, cookie: person.cookie } })).body);
    await person.req('POST', `/api/chats/${chat}/messages`, { text: 'смотри', fileIds: [up.id] });
    const [u] = await updates(token);
    expect(u.message).toMatchObject({ caption: 'смотри', photo: [{ file_id: up.id, width: 40 }] });
    expect((await ok(token, 'getFile', { file_id: up.id })).file_size).toBe(data.length);
    expect((await app.inject({ method: 'GET', url: `/file/bot${token}/${(await ok(token, 'getFile', { file_id: up.id })).file_path}` })).statusCode).toBe(200);
  });

  it('sends albums, stickers, voice and round videos', async () => {
    const { token, person, chat } = await talkingPair('album_bot', 'album_person');
    const a = await png('#111111');
    const b = await png('#eeeeee');
    const form = multipart(
      { chat_id: String(person.id), media: JSON.stringify([{ type: 'photo', media: 'attach://one', caption: 'альбом' }, { type: 'photo', media: 'attach://two' }]) },
      [
        { name: 'one', filename: '1.png', type: 'image/png', data: a },
        { name: 'two', filename: '2.png', type: 'image/png', data: b },
      ],
    );
    const r = JSON.parse((await app.inject({ method: 'POST', url: `/bot${token}/sendMediaGroup`, payload: form.payload, headers: form.headers })).body);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(r.result).toHaveLength(1);
    expect(r.result[0]).toMatchObject({ caption: 'альбом', media_group_id: expect.any(String) });
    expect(r.result[0].attachments).toHaveLength(2);
    expect((await messagesOf(person, chat)).find((m) => m.id === r.result[0].message_id).attachments).toHaveLength(2);
    expect(await api(token, 'sendMediaGroup', { chat_id: person.id, media: [{ type: 'photo', media: 'x' }] })).toMatchObject({ status: 400 });

    const st = await ok(token, 'sendSticker', { chat_id: person.id, sticker: 'tg:happy' });
    expect(st.sticker).toMatchObject({ file_id: 'tg:happy', emoji: '😊' });
    expect((await messagesOf(person, chat)).find((m) => m.id === st.message_id)).toMatchObject({ kind: 'sticker', sticker: { id: 'tg:happy' } });
    expect(await api(token, 'sendSticker', { chat_id: person.id, sticker: 'tg:nothing' })).toMatchObject({ status: 400 });

    const voice = multipart({ chat_id: String(person.id), duration: '3' }, [{ name: 'voice', filename: 'v.ogg', type: 'audio/ogg', data: Buffer.from('OggS-fake') }]);
    const v = JSON.parse((await app.inject({ method: 'POST', url: `/bot${token}/sendVoice`, payload: voice.payload, headers: voice.headers })).body);
    expect(v.result.voice).toMatchObject({ duration: 3, mime_type: 'audio/ogg' });
    expect((await messagesOf(person, chat)).find((m) => m.id === v.result.message_id).attachments[0]).toMatchObject({ kind: 'voice' });
  });
});

describe('polls, checklists and reactions', () => {
  it('sends polls and quizzes, reports answers and stops them', async () => {
    const { token, person, chat } = await talkingPair('pollapi_bot', 'pollapi_person');
    const poll = await ok(token, 'sendPoll', { chat_id: person.id, question: 'Кто?', options: ['Я', { text: 'Ты' }, 'Он'], is_anonymous: false, allows_multiple_answers: true });
    expect(poll.poll).toMatchObject({ question: 'Кто?', is_anonymous: false, type: 'regular', allows_multiple_answers: true, total_voter_count: 0, is_closed: false });
    expect(poll.poll.options.map((o: any) => o.text)).toEqual(['Я', 'Ты', 'Он']);
    const shown = (await messagesOf(person, chat)).find((m) => m.id === poll.message_id);
    expect(shown.poll).toMatchObject({ question: 'Кто?', anonymous: false, multiple: true });

    await person.req('POST', `/api/messages/${poll.message_id}/vote`, { options: [0, 2] });
    const got = await updates(token);
    expect(got.map((x) => Object.keys(x).find((k) => k !== 'update_id'))).toEqual(['poll_answer', 'poll']);
    expect(got[0].poll_answer).toMatchObject({ poll_id: poll.poll.id, user: { id: person.id }, option_ids: [0, 2] });
    expect(got[1].poll).toMatchObject({ id: poll.poll.id, total_voter_count: 1, options: [{ voter_count: 1 }, { voter_count: 0 }, { voter_count: 1 }] });
    await updates(token, got[1].update_id + 1);

    // an anonymous poll tells the bot the numbers, but not who voted
    const anon = await ok(token, 'sendPoll', { chat_id: person.id, question: 'Да?', options: ['Да', 'Нет'] });
    expect(anon.poll.is_anonymous).toBe(true);
    await person.req('POST', `/api/messages/${anon.message_id}/vote`, { options: [1] });
    expect((await updates(token)).map((x) => Object.keys(x).find((k) => k !== 'update_id'))).toEqual(['poll']);

    const stopped = await ok(token, 'stopPoll', { chat_id: person.id, message_id: poll.message_id });
    expect(stopped).toMatchObject({ is_closed: true, total_voter_count: 1 });
    expect((await person.req('POST', `/api/messages/${poll.message_id}/vote`, { options: [1] })).status).toBe(400);

    const quiz = await ok(token, 'sendPoll', { chat_id: person.id, question: '2+2?', options: ['3', '4'], type: 'quiz', correct_option_id: 1, explanation: 'Арифметика', open_period: 60 });
    expect(quiz.poll).toMatchObject({ type: 'quiz', correct_option_id: 1, explanation: 'Арифметика', open_period: 60 });
    // the person does not see the right answer before voting
    expect((await messagesOf(person, chat)).find((m) => m.id === quiz.message_id).poll.correctOption).toBeUndefined();
  });

  it('checks the poll', async () => {
    const { token, person } = await talkingPair('pollbad_bot', 'pollbad_person');
    const bad = (extra: Record<string, unknown>) => api(token, 'sendPoll', { chat_id: person.id, question: 'Q', options: ['a', 'b'], ...extra });
    expect((await bad({ options: ['a'] })).status).toBe(400);
    expect((await bad({ options: ['a', 'A'] })).body.description).toMatch(/unique/);
    expect((await bad({ options: Array.from({ length: 11 }, (_, i) => `o${i}`) })).status).toBe(400);
    expect((await bad({ type: 'quiz' })).body.description).toMatch(/correct_option_id/);
    expect((await bad({ type: 'quiz', correct_option_id: 5 })).status).toBe(400);
    expect((await bad({ question: '' })).status).toBe(400);
    expect((await bad({ options: '["a","b"]' })).status).toBe(200);
  });

  it('sends checklists and tells the bot who ticked what', async () => {
    const { token, person, chat } = await talkingPair('check_bot', 'check_person');
    const sent = await ok(token, 'sendChecklist', { chat_id: person.id, checklist: { title: 'Купить', tasks: [{ id: 1, text: 'Хлеб' }, { id: 2, text: 'Молоко' }], others_can_add_tasks: true } });
    expect(sent.checklist).toMatchObject({ title: 'Купить', others_can_add_tasks: true });
    expect(sent.checklist.tasks.map((t: any) => t.text)).toEqual(['Хлеб', 'Молоко']);
    const shown = (await messagesOf(person, chat)).find((m) => m.id === sent.message_id);
    expect(shown).toMatchObject({ kind: 'checklist', checklist: { title: 'Купить' } });
    const [a, b] = shown.checklist.items;

    await person.req('POST', `/api/checklists/${shown.checklist.id}/items/${a.id}/toggle`);
    const [done] = await updates(token);
    expect(done.message).toMatchObject({ from: { id: person.id }, checklist_tasks_done: { marked_as_done_task_ids: [a.id], checklist_message: { message_id: sent.message_id } } });
    await person.req('POST', `/api/checklists/${shown.checklist.id}/items`, { text: 'Сыр' });
    const got = await updates(token, done.update_id + 1);
    expect(got[0].message.checklist_tasks_added.tasks.map((t: any) => t.text)).toEqual(['Сыр']);

    // the bot rewrites its own list: a task with a known id keeps its tick
    const edited = await ok(token, 'editMessageChecklist', { chat_id: person.id, message_id: sent.message_id, checklist: { title: 'Купить срочно', tasks: [{ id: a.id, text: 'Хлеб!' }, { text: 'Масло' }] } });
    expect(edited.checklist.title).toBe('Купить срочно');
    expect(edited.checklist.tasks.map((t: any) => [t.text, !!t.completed_by_user])).toEqual([['Хлеб!', true], ['Масло', false]]);
    void b;
    expect((await api(token, 'sendChecklist', { chat_id: person.id, title: 'Пусто', tasks: [] })).status).toBe(400);
  });

  it('reacts to messages and tells the bot about reactions it asked for', async () => {
    const { token, person, chat, first } = await talkingPair('react_bot', 'react_person');
    await ok(token, 'setMessageReaction', { chat_id: person.id, message_id: first.id, reaction: [{ type: 'emoji', emoji: '🔥' }] });
    const shown = (await messagesOf(person, chat)).find((m) => m.id === first.id);
    expect(shown.reactions).toMatchObject([{ emoji: '🔥', count: 1 }]);
    await ok(token, 'setMessageReaction', { chat_id: person.id, message_id: first.id, reaction: [] });
    expect((await messagesOf(person, chat)).find((m) => m.id === first.id).reactions).toEqual([]);
    expect(await api(token, 'setMessageReaction', { chat_id: person.id, message_id: first.id, reaction: [{ type: 'emoji', emoji: '🦄' }] })).toMatchObject({ status: 400 });

    // reactions of people are not in the default updates
    await person.req('POST', `/api/messages/${first.id}/reaction`, { emoji: '👍' });
    expect(await updates(token)).toEqual([]);
    await ok(token, 'getUpdates', { allowed_updates: ['message', 'message_reaction'] });
    await person.req('POST', `/api/messages/${first.id}/reaction`, { emoji: '❤️' });
    await person.req('DELETE', `/api/messages/${first.id}/reaction`);
    const got = await updates(token);
    expect(got.map((g) => g.message_reaction)).toMatchObject([
      { message_id: first.id, user: { id: person.id }, old_reaction: [{ type: 'emoji', emoji: '👍' }], new_reaction: [{ type: 'emoji', emoji: '❤️' }] },
      { old_reaction: [{ type: 'emoji', emoji: '❤️' }], new_reaction: [] },
    ]);
  });
});

describe('groups, channels and blocking', () => {
  /** A bot, the owner of a group, a member, and the group with the bot not in it yet. */
  async function setup(botName: string) {
    const bot = await makeBot(botName);
    const base = botName.replace(/bot$/i, '');
    const boss = await register(`${base}boss`);
    const member = await register(`${base}member`);
    const g = (await boss.req('POST', '/api/chats/group', { title: 'Чат', memberIds: [member.id] })).body;
    return { ...bot, boss, member, group: g.id as number };
  }
  const kinds = (list: any[]) => list.map((u) => Object.keys(u).find((k) => k !== 'update_id'));

  it('is added to a group and sees what privacy mode lets through', async () => {
    const { token, id, boss, member, group, username } = await setup('grp_bot');
    expect((await boss.req('POST', `/api/chats/${group}/members`, { userIds: [id] })).body).toMatchObject({ added: 1 });
    // the bot is told it joined, and "new_chat_members" comes as a message
    const joined = await updates(token);
    expect(kinds(joined)).toEqual(['my_chat_member', 'message']);
    expect(joined[0].my_chat_member).toMatchObject({
      chat: { id: -group, type: 'group', title: 'Чат' },
      from: { id: boss.id },
      old_chat_member: { status: 'left' },
      new_chat_member: { status: 'member', user: { id, is_bot: true } },
    });
    expect(joined[1].message).toMatchObject({ new_chat_members: [{ id, is_bot: true }], chat: { id: -group } });
    await updates(token, joined[1].update_id + 1);

    // privacy mode is on: plain talk is not heard; commands, mentions and replies are
    await say(boss, group, 'просто разговор');
    await say(boss, group, '/start');
    await say(boss, group, `/start@${username}`);
    await say(boss, group, '/start@some_other_bot');
    await say(boss, group, `эй @${username}, ты тут?`);
    const sent = await ok(token, 'sendMessage', { chat_id: -group, text: 'я здесь' });
    await say(member, group, 'без ответа');
    await member.req('POST', `/api/chats/${group}/messages`, { text: 'ответ боту', replyToId: sent.message_id });
    expect((await updates(token)).map((u) => u.message.text)).toEqual(['/start', `/start@${username}`, `эй @${username}, ты тут?`, 'ответ боту']);

    // privacy mode off: everything is heard (but never what bots say)
    const { setBotPrivacy } = await import('../src/bots/manage.js');
    const { getBot } = await import('../src/bots/store.js');
    setBotPrivacy(getBot(id)!, false);
    await say(member, group, 'теперь слышно всё');
    await ok(token, 'sendMessage', { chat_id: -group, text: 'и это тоже, но это от самого бота' });
    expect((await updates(token)).map((u) => u.message.text)).toEqual(['/start', `/start@${username}`, `эй @${username}, ты тут?`, 'ответ боту', 'теперь слышно всё']);

    // chat info
    const chat = await ok(token, 'getChat', { chat_id: -group });
    expect(chat).toMatchObject({ id: -group, type: 'group', title: 'Чат', permissions: { can_send_messages: true } });
    expect(await ok(token, 'getChatMemberCount', { chat_id: -group })).toBe(3);
    expect((await ok(token, 'getChatMember', { chat_id: -group, user_id: boss.id })).status).toBe('creator');
    expect((await ok(token, 'getChatMember', { chat_id: -group, user_id: id })).status).toBe('member');
    expect((await ok(token, 'getChatAdministrators', { chat_id: -group })).map((m: any) => m.user.id)).toEqual([boss.id]);
    // a bot that is not in a chat cannot write to it
    const other = await makeBot('grp2_bot');
    expect(await api(other.token, 'sendMessage', { chat_id: -group, text: 'x' })).toMatchObject({ status: 403, body: { description: 'Forbidden: bot is not a member of the group chat' } });
  });

  it('is not added to groups when its owner forbids it, and hears about people joining and leaving', async () => {
    const { token, id, boss, member, group } = await setup('join_bot');
    const { setBotJoinGroups } = await import('../src/bots/manage.js');
    const { getBot } = await import('../src/bots/store.js');
    setBotJoinGroups(getBot(id)!, false);
    expect((await boss.req('POST', `/api/chats/${group}/members`, { userIds: [id] })).body).toMatchObject({ added: 0, restricted: 1 });
    expect((await boss.req('POST', '/api/chats/group', { title: 'Другой', memberIds: [id] })).body.memberCount).toBe(1);
    setBotJoinGroups(getBot(id)!, true);
    await boss.req('POST', `/api/chats/${group}/members`, { userIds: [id] });
    await updates(token).then((u) => updates(token, u.at(-1).update_id + 1));

    const late = await register('join_latecomer');
    await boss.req('POST', `/api/chats/${group}/members`, { userIds: [late.id] });
    const [joined] = await updates(token);
    expect(joined.message.new_chat_members).toEqual([expect.objectContaining({ id: late.id, username: 'join_latecomer' })]);
    await late.req('POST', `/api/chats/${group}/leave`);
    const got = await updates(token, joined.update_id + 1);
    expect(got[0].message.left_chat_member).toMatchObject({ id: late.id });
    void member;
  });

  it('moderates a group as an administrator: sees everything, bans, mutes, pins, renames', async () => {
    const { token, id, boss, member, group } = await setup('mod_bot');
    await boss.req('POST', `/api/chats/${group}/members`, { userIds: [id] });
    await updates(token).then((u) => updates(token, u.at(-1).update_id + 1));
    // not an administrator yet
    expect(await api(token, 'banChatMember', { chat_id: -group, user_id: member.id })).toMatchObject({ status: 403 });
    const rights = { changeInfo: true, deleteMessages: true, banUsers: true, inviteUsers: true, pinMessages: true, addAdmins: true };
    expect((await boss.req('PATCH', `/api/chats/${group}/members/${id}`, { role: 'admin', rights })).status).toBe(200);
    // an administrator hears everything, whatever privacy mode says
    await say(member, group, 'слышно всем админам');
    expect((await updates(token)).map((u) => u.message.text)).toEqual(['слышно всем админам']);
    expect((await ok(token, 'getChatMember', { chat_id: -group, user_id: id })).status).toBe('administrator');

    await ok(token, 'setChatTitle', { chat_id: -group, title: 'Новое имя' });
    await ok(token, 'setChatDescription', { chat_id: -group, description: 'Правила чата' });
    expect((await boss.req('GET', `/api/chats/${group}`)).body).toMatchObject({ title: 'Новое имя', description: 'Правила чата' });
    const note = await ok(token, 'sendMessage', { chat_id: -group, text: 'Правила' });
    await ok(token, 'pinChatMessage', { chat_id: -group, message_id: note.message_id });
    expect((await boss.req('GET', `/api/chats/${group}`)).body.pinned.map((m: any) => m.id)).toEqual([note.message_id]);

    await ok(token, 'restrictChatMember', { chat_id: -group, user_id: member.id, permissions: { can_send_messages: false } });
    expect((await member.req('POST', `/api/chats/${group}/messages`, { text: 'тишина' })).status).toBe(403);
    await ok(token, 'restrictChatMember', { chat_id: -group, user_id: member.id, permissions: { can_send_messages: true } });
    expect((await member.req('POST', `/api/chats/${group}/messages`, { text: 'снова можно' })).status).toBe(200);
    expect(await api(token, 'banChatMember', { chat_id: -group, user_id: boss.id })).toMatchObject({ status: 403 });

    await ok(token, 'banChatMember', { chat_id: -group, user_id: member.id });
    expect((await ok(token, 'getChatMember', { chat_id: -group, user_id: member.id })).status).toBe('kicked');
    expect((await member.req('GET', `/api/chats/${group}`)).status).toBe(403);
    await ok(token, 'unbanChatMember', { chat_id: -group, user_id: member.id });
    expect((await boss.req('POST', `/api/chats/${group}/members`, { userIds: [member.id] })).body.added).toBe(1);
    await ok(token, 'promoteChatMember', { chat_id: -group, user_id: member.id, can_pin_messages: true, can_delete_messages: true });
    expect((await ok(token, 'getChatMember', { chat_id: -group, user_id: member.id }))).toMatchObject({ status: 'administrator', can_pin_messages: true, can_delete_messages: true, can_restrict_members: false });
    await ok(token, 'setChatPermissions', { chat_id: -group, permissions: { can_send_polls: false } });
    expect((await boss.req('GET', `/api/chats/${group}`)).body.defaultPermissions.sendPolls).toBe(false);
    expect((await ok(token, 'exportChatInviteLink', { chat_id: -group }))).toMatch(/\/join\/[\w-]+$/);

    await ok(token, 'leaveChat', { chat_id: -group });
    expect((await boss.req('GET', `/api/chats/${group}/members`)).body.map((m: any) => m.user.id)).not.toContain(id);
  });

  it('reads the posts of a channel as an administrator', async () => {
    const bot = await makeBot('chan_bot');
    const boss = await register('chan_boss');
    const ch = (await boss.req('POST', '/api/chats/channel', { title: 'Новости' })).body;
    await boss.req('POST', `/api/chats/${ch.id}/members`, { userIds: [bot.id] });
    await boss.req('POST', `/api/chats/${ch.id}/messages`, { text: 'пока бот не админ' });
    expect(kinds(await updates(bot.token))).toEqual(['my_chat_member']);
    await updates(bot.token, (await updates(bot.token)).at(-1).update_id + 1);
    // it cannot write until it is an administrator who may post
    expect(await api(bot.token, 'sendMessage', { chat_id: -ch.id, text: 'нельзя' })).toMatchObject({ status: 403 });
    const rights = { changeInfo: false, deleteMessages: false, banUsers: false, inviteUsers: false, pinMessages: false, addAdmins: false, postMessages: true };
    expect((await boss.req('PATCH', `/api/chats/${ch.id}/members/${bot.id}`, { role: 'admin', rights })).status).toBe(200);
    await boss.req('POST', `/api/chats/${ch.id}/messages`, { text: 'новость дня' });
    const [post] = await updates(bot.token);
    expect(post.channel_post).toMatchObject({ text: 'новость дня', chat: { id: -ch.id, type: 'channel', title: 'Новости' }, sender_chat: { id: -ch.id } });
    expect(post.channel_post.from).toBeUndefined();
    const sent = await ok(bot.token, 'sendMessage', { chat_id: -ch.id, text: 'от бота' });
    expect(sent.sender_chat).toMatchObject({ type: 'channel' });
    // a public channel is also reachable by its @username
    await boss.req('PATCH', `/api/chats/${ch.id}`, { isPublic: true, publicUsername: 'bot_news' });
    expect((await ok(bot.token, 'sendMessage', { chat_id: '@bot_news', text: 'по имени' })).message_id).toBeGreaterThan(sent.message_id);
  });

  it('cannot write to somebody who blocked it, and is told about blocks', async () => {
    const { token, person, chat, id } = await talkingPair('blk_bot', 'blk_person');
    await person.req('POST', `/api/users/${id}/block`);
    expect(await api(token, 'sendMessage', { chat_id: person.id, text: 'эй' })).toMatchObject({ status: 403, body: { description: 'Forbidden: bot was blocked by the user' } });
    const [blocked] = await updates(token);
    expect(blocked.my_chat_member).toMatchObject({ chat: { id: person.id }, old_chat_member: { status: 'member' }, new_chat_member: { status: 'kicked' } });
    await person.req('DELETE', `/api/users/${id}/block`);
    expect((await api(token, 'sendMessage', { chat_id: person.id, text: 'снова' })).status).toBe(200);
    const got = await updates(token, blocked.update_id + 1);
    expect(got[0].my_chat_member.new_chat_member.status).toBe('member');
    void chat;
  });
});

describe('admin and rules', () => {
  it('lists bots with their owners in the admin panel and deletes them', async () => {
    const a = await admin();
    const { owner, id, token } = await makeBot('adm_bot');
    const list = (await a.req('GET', '/api/admin/bots')).body;
    const mine = list.find((b: any) => b.user.id === id);
    expect(mine).toMatchObject({ builtin: null, owner: { id: owner.id }, commands: 0, webhook: false });
    expect(list.filter((b: any) => b.builtin).map((b: any) => b.builtin).sort()).toEqual(['premiumbot', 'weatherbot']);
    expect((await owner.req('GET', '/api/admin/bots')).status).toBe(403);
    expect((await a.req('DELETE', `/api/admin/bots/${id}`)).status).toBe(200);
    expect((await api(token, 'getMe')).status).toBe(401);
    expect((await a.req('GET', '/api/admin/bots')).body.some((b: any) => b.user.id === id)).toBe(false);
  });

  it('charges the price the admin set, and nothing when it cannot', async () => {
    const a = await admin();
    expect((await a.req('PUT', '/api/admin/bank/settings', { botPrice: 35 })).status).toBe(200);
    try {
      const u = await register('price_user');
      await fund(u, 60);
      expect(() => createBot(getUserRow(u.id)!, 'Дорого', 'one_bot')).not.toThrow();
      expect((await u.req('GET', '/api/bank')).body.balance).toBe(25);
      // 25 ТК are too few: no bot, no charge
      expect(() => createBot(getUserRow(u.id)!, 'Ещё', 'two_bot')).toThrow(/Недостаточно/);
      expect((await u.req('GET', '/api/bank')).body.balance).toBe(25);
      expect((await u.req('GET', '/api/resolve/two_bot')).status).toBe(404);
      // an infinite balance pays nothing
      await a.req('POST', '/api/admin/bank/give', { userId: u.id, amount: -1, set: true, notify: false });
      expect(() => createBot(getUserRow(u.id)!, 'Бесплатно', 'three_bot')).not.toThrow();
      expect((await u.req('GET', '/api/bank')).body.balance).toBe(-1);
    } finally {
      await a.req('PUT', '/api/admin/bank/settings', { botPrice: 20 });
    }
  });

  it('limits the number of bots of one person and checks names', async () => {
    const u = await register('many_user');
    await fund(u, 1000);
    const me = getUserRow(u.id)!;
    expect(() => createBot(me, '', 'ok_bot')).toThrow();
    expect(() => createBot(me, 'Имя', 'no_suffix')).toThrow();
    expect(() => createBot(me, 'Имя', 'a_b')).toThrow();
    for (let i = 0; i < 20; i++) createBot(me, `Бот ${i}`, `many${i}_bot`);
    expect(() => createBot(me, 'Лишний', 'many_extra_bot')).toThrow();
  });
});
