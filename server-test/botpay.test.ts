import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { createBot } from '../src/bots/manage.js';
import { config } from '../src/config.js';
import { getUserRow } from '../src/serialize.js';

let app: FastifyInstance;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'timba-botpay-'));

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
  req: (method: string, url: string, body?: unknown) => Promise<{ status: number; body: any }>;
}

function client(cookie: string, id: number): Client {
  return {
    id,
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
    remoteAddress: `10.6.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`,
    payload: { username, password: 'secret123', firstName: username },
  });
  expect(r.statusCode).toBe(200);
  return client(String(r.headers['set-cookie']).split(';')[0]!, JSON.parse(r.body).id);
}

let adminSession: Promise<Client> | null = null;
const admin = () =>
  (adminSession ??= app
    .inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'admin', password: 'adminpass' }, remoteAddress: '10.6.250.2' })
    .then((r) => client(String(r.headers['set-cookie']).split(';')[0]!, JSON.parse(r.body).id)));

async function setBalance(id: number, amount: number) {
  expect((await (await admin()).req('POST', '/api/admin/bank/give', { userId: id, amount, set: true, notify: false })).status).toBe(200);
}

const balance = async (u: Client) => (await u.req('GET', '/api/bank')).body.balance as number;

async function api(token: string, method: string, payload?: Record<string, unknown>) {
  const r = await app.inject({ method: 'POST', url: `/bot${token}/${method}`, payload: payload as object });
  return { status: r.statusCode, body: JSON.parse(r.body) as any };
}

async function ok<T = any>(token: string, method: string, payload?: Record<string, unknown>): Promise<T> {
  const r = await api(token, method, payload);
  expect(r.body, `${method}: ${JSON.stringify(r.body)}`).toMatchObject({ ok: true });
  return r.body.result as T;
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

/** A bot owned by a funded person, a customer who opened a chat with it. */
async function shop(name: string, customerMoney = 100) {
  const owner = await register(`${name}owner`);
  await setBalance(owner.id, 100);
  const made = createBot(getUserRow(owner.id)!, `Shop ${name}`, `${name}_bot`);
  const customer = await register(`${name}buyer`);
  await setBalance(customer.id, customerMoney);
  const chat = (await customer.req('POST', '/api/chats/private', { userId: made.user.id })).body.id as number;
  // the customer writes first: a bot cannot start a conversation
  await customer.req('POST', `/api/chats/${chat}/messages`, { text: '/start' });
  return { owner, customer, token: made.token, botId: made.user.id, chat, username: `${name}_bot` };
}

type Shop = Awaited<ReturnType<typeof shop>>;

const sendInvoice = (s: Shop, extra: Record<string, unknown> = {}) =>
  ok(s.token, 'sendInvoice', { chat_id: s.customer.id, title: 'Кофе', description: 'Чашка кофе', payload: 'order-1', amount: 30, ...extra });

const invoiceMessage = async (s: Shop, id: number) => {
  const list = (await s.customer.req('GET', `/api/chats/${s.chat}/messages?limit=100`)).body as any[];
  return list.find((m) => m.id === id);
};

describe('deleting a chat', () => {
  it('removes a private chat for me, and it comes back empty when the other person writes', async () => {
    const a = await register('delchata');
    const b = await register('delchatb');
    const chat = (await a.req('POST', '/api/chats/private', { userId: b.id })).body.id as number;
    await a.req('POST', `/api/chats/${chat}/messages`, { text: 'привет' });
    await b.req('POST', `/api/chats/${chat}/messages`, { text: 'здравствуй' });

    expect((await a.req('POST', `/api/chats/${chat}/delete`, {})).status).toBe(200);
    expect(((await a.req('GET', '/api/chats')).body as any[]).some((c) => c.id === chat)).toBe(false);
    // the other person keeps everything
    const list = (await b.req('GET', `/api/chats/${chat}/messages?limit=50`)).body as any[];
    expect(list.map((m) => m.text)).toEqual(['привет', 'здравствуй']);

    await b.req('POST', `/api/chats/${chat}/messages`, { text: 'ты тут?' });
    expect(((await a.req('GET', '/api/chats')).body as any[]).some((c) => c.id === chat)).toBe(true);
    const mine = (await a.req('GET', `/api/chats/${chat}/messages?limit=50`)).body as any[];
    expect(mine.map((m) => m.text)).toEqual(['ты тут?']);
  });

  it('removes it for both people when asked', async () => {
    const a = await register('delbotha');
    const b = await register('delbothb');
    const chat = (await a.req('POST', '/api/chats/private', { userId: b.id })).body.id as number;
    await a.req('POST', `/api/chats/${chat}/messages`, { text: 'привет' });
    expect((await a.req('POST', `/api/chats/${chat}/delete`, { forBoth: true })).status).toBe(200);
    for (const u of [a, b]) {
      expect(((await u.req('GET', '/api/chats')).body as any[]).some((c) => c.id === chat)).toBe(false);
      expect((await u.req('GET', `/api/chats/${chat}/messages`)).status).toBeGreaterThanOrEqual(400);
    }
  });

  it('leaves a group alone and lets a person delete a chat with a bot', async () => {
    const s = await shop('delbot');
    const group = (await s.customer.req('POST', '/api/chats/group', { title: 'Группа', memberIds: [] })).body.id as number;
    expect((await s.customer.req('POST', `/api/chats/${group}/delete`, {})).status).toBe(400);
    expect((await s.customer.req('POST', `/api/chats/${s.chat}/delete`, {})).status).toBe(200);
    expect(((await s.customer.req('GET', '/api/chats')).body as any[]).some((c) => c.id === s.chat)).toBe(false);
    // the bot can still answer: the chat returns
    await ok(s.token, 'sendMessage', { chat_id: s.customer.id, text: 'Вы ушли? Вернитесь!' });
    const chats = (await s.customer.req('GET', '/api/chats')).body as any[];
    expect(chats.find((c) => c.id === s.chat)?.lastMessage.text).toBe('Вы ушли? Вернитесь!');
    // «delete and stop the bot»: blocked, the bot cannot write any more
    expect((await s.customer.req('POST', `/api/chats/${s.chat}/delete`, {})).status).toBe(200);
    expect((await s.customer.req('POST', `/api/users/${s.botId}/block`)).status).toBe(200);
    const r = await api(s.token, 'sendMessage', { chat_id: s.customer.id, text: 'эй' });
    expect(r.status).toBe(403);
  });
});

describe('invoices', () => {
  it('sends an invoice, takes ТК from the payer into the bot till and tells the bot', async () => {
    const s = await shop('pay1');
    const msg = await sendInvoice(s);
    expect(msg.invoice).toMatchObject({ title: 'Кофе', currency: 'TK', total_amount: 30, status: 'pending' });
    expect(msg.reply_markup.inline_keyboard[0][0]).toMatchObject({ text: 'Оплатить 30 ТК', pay: true });

    const shown = await invoiceMessage(s, msg.message_id);
    expect(shown.text).toContain('Кофе');
    const button = shown.replyMarkup.rows[0][0];
    expect(button.invoiceId).toBe(msg.invoice.invoice_id);

    const seen = await s.customer.req('GET', `/api/invoices/${button.invoiceId}`);
    expect(seen.body).toMatchObject({ title: 'Кофе', amount: 30, status: 'pending', bot: { id: s.botId } });

    const paid = await s.customer.req('POST', `/api/invoices/${button.invoiceId}/pay`);
    expect(paid.status).toBe(200);
    expect(paid.body).toMatchObject({ balance: 70, invoice: { status: 'paid' } });
    expect(await balance(s.customer)).toBe(70);
    expect(await ok(s.token, 'getMyBalance')).toMatchObject({ balance: 30, wallet: 'bot', infinite: false });

    // the message changed: paid, no button
    const after = await invoiceMessage(s, msg.message_id);
    expect(after.text).toContain('Оплачено');
    expect(after.replyMarkup).toBeFalsy();

    // the bot hears about it
    const ups = await ok<any[]>(s.token, 'getUpdates', {});
    const pay = ups.map((u) => u.message).find((m) => m?.successful_payment);
    expect(pay.successful_payment).toMatchObject({ currency: 'TK', total_amount: 30, invoice_payload: 'order-1', invoice_id: msg.invoice.invoice_id });
    expect(pay.from.id).toBe(s.customer.id);
    expect(pay.reply_to_message.message_id).toBe(msg.message_id);

    // the book of the bot and the history of the payer
    const tx = await ok<any[]>(s.token, 'getMyTransactions');
    expect(tx[0]).toMatchObject({ type: 'payment', amount: 30, invoice_id: msg.invoice.invoice_id });
    expect(tx[0].user.id).toBe(s.customer.id);
    const hist = (await s.customer.req('GET', '/api/bank/history')).body.items as any[];
    expect(hist[0]).toMatchObject({ kind: 'invoice_pay', amount: -30, peer: s.username });
    expect(await ok(s.token, 'getInvoice', { invoice_id: msg.invoice.invoice_id })).toMatchObject({ status: 'paid', total_amount: 30 });
  });

  it('cannot be paid twice, by a stranger, without money, after cancel or after the term', async () => {
    const s = await shop('pay2', 20);
    const stranger = await register('pay2stranger');
    await setBalance(stranger.id, 500);
    const msg = await sendInvoice(s);
    const id = msg.invoice.invoice_id;
    expect((await stranger.req('POST', `/api/invoices/${id}/pay`)).status).toBe(404);
    const poor = await s.customer.req('POST', `/api/invoices/${id}/pay`);
    expect(poor.status).toBe(400);
    expect(poor.body.error).toBe('insufficient_funds');
    expect(await balance(s.customer)).toBe(20);

    await setBalance(s.customer.id, 100);
    expect((await s.customer.req('POST', `/api/invoices/${id}/pay`)).status).toBe(200);
    const twice = await s.customer.req('POST', `/api/invoices/${id}/pay`);
    expect(twice.status).toBe(409);
    expect(await balance(s.customer)).toBe(70);

    const other = await sendInvoice(s, { amount: 5 });
    await ok(s.token, 'cancelInvoice', { invoice_id: other.invoice.invoice_id });
    expect((await s.customer.req('POST', `/api/invoices/${other.invoice.invoice_id}/pay`)).status).toBe(409);
    expect((await invoiceMessage(s, other.message_id)).text).toContain('отменён');
    expect((await api(s.token, 'cancelInvoice', { invoice_id: id })).status).toBe(400);

    const late = await sendInvoice(s, { amount: 5, expires_in: 60 });
    const { db } = await import('../src/db.js');
    db.prepare('UPDATE bot_invoices SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, late.invoice.invoice_id);
    const expired = await s.customer.req('POST', `/api/invoices/${late.invoice.invoice_id}/pay`);
    expect(expired.status).toBe(409);
    expect(expired.body.error).toBe('invoice_expired');
    expect((await invoiceMessage(s, late.message_id)).text).toContain('истёк');
  });

  it('checks the invoice and keeps the pay button first with the bot\'s own buttons below', async () => {
    const s = await shop('pay3');
    const bad = async (extra: Record<string, unknown>, text: RegExp) => {
      const r = await api(s.token, 'sendInvoice', { chat_id: s.customer.id, title: 'T', amount: 10, ...extra });
      expect(r.status).toBe(400);
      expect(r.body.description).toMatch(text);
    };
    await bad({ amount: 0 }, /amount/);
    await bad({ amount: 1_000_000 }, /amount/);
    await bad({ title: 'x'.repeat(40) }, /title/);
    await bad({ payload: 'я'.repeat(80) }, /payload/);
    await bad({ amount: undefined }, /amount/);
    const group = (await s.customer.req('POST', '/api/chats/group', { title: 'Г', memberIds: [s.botId] })).body.id as number;
    await bad({ chat_id: -group }, /private/);
    const msg = await sendInvoice(s, { reply_markup: { inline_keyboard: [[{ text: 'Меню', callback_data: 'menu' }]] } });
    expect(msg.reply_markup.inline_keyboard.map((r: any[]) => r[0].text)).toEqual(['Оплатить 30 ТК', 'Меню']);
    // prices are summed, like in Telegram
    const sum = await sendInvoice(s, { amount: undefined, prices: [{ label: 'Кофе', amount: 20 }, { label: 'Сироп', amount: 5 }] });
    expect(sum.invoice.total_amount).toBe(25);
    // a bot cannot put a pay button on a plain message by itself
    const r = await api(s.token, 'sendMessage', { chat_id: s.customer.id, text: 'x', reply_markup: { inline_keyboard: [[{ text: 'Оплатить', pay: true }]] } });
    expect(r.status).toBe(400);
  });

  it('refunds a payment from the till, and only while there is money in it', async () => {
    const s = await shop('pay4');
    const msg = await sendInvoice(s, { amount: 40 });
    const id = msg.invoice.invoice_id;
    expect((await api(s.token, 'refundPayment', { invoice_id: id })).status).toBe(400);
    await s.customer.req('POST', `/api/invoices/${id}/pay`);
    expect(await balance(s.customer)).toBe(60);

    // the bot pays out what it earned, so the till is short
    await ok(s.token, 'sendCoins', { user_id: s.customer.id, amount: 25, comment: 'бонус' });
    expect(await balance(s.customer)).toBe(85);
    const short = await api(s.token, 'refundPayment', { invoice_id: id });
    expect(short.status).toBe(400);
    expect(await balance(s.customer)).toBe(85);

    await setBalance(s.botId, 100);
    await ok(s.token, 'refundPayment', { invoice_id: id });
    expect(await balance(s.customer)).toBe(125);
    expect((await invoiceMessage(s, msg.message_id)).text).toContain('возвращены');
    expect((await api(s.token, 'refundPayment', { invoice_id: id })).status).toBe(400);
    const types = (await ok<any[]>(s.token, 'getMyTransactions')).map((t) => t.type);
    expect(types).toEqual(['refund', 'payout', 'payment']);
    const notes = (await s.customer.req('GET', '/api/notifications/bank')).body;
    expect(JSON.stringify(notes)).toContain('вернул вам 40 ТК');
  });
});

describe('payouts and balances', () => {
  it('pays coins to a person out of the till and refuses more than there is', async () => {
    const s = await shop('out1');
    await setBalance(s.botId, 50);
    await ok(s.token, 'sendCoins', { user_id: s.customer.id, amount: 30, comment: 'выигрыш' });
    expect(await balance(s.customer)).toBe(130);
    expect((await ok(s.token, 'getMyBalance')).balance).toBe(20);
    const more = await api(s.token, 'sendCoins', { user_id: s.customer.id, amount: 21 });
    expect(more.status).toBe(400);
    expect((await api(s.token, 'sendCoins', { user_id: s.customer.id, amount: 0 })).status).toBe(400);
    const hist = (await s.customer.req('GET', '/api/bank/history')).body.items as any[];
    expect(hist[0]).toMatchObject({ kind: 'payout_in', amount: 30, peer: s.username, message: 'выигрыш' });
  });

  it('shows a balance only of people who wrote to the bot and did not block it', async () => {
    const s = await shop('bal1');
    expect(await ok(s.token, 'getUserBalance', { user_id: s.customer.id })).toMatchObject({ user_id: s.customer.id, balance: 100, currency: 'TK' });
    const stranger = await register('bal1stranger');
    const r = await api(s.token, 'getUserBalance', { user_id: stranger.id });
    expect(r.status).toBe(403);
    expect((await api(s.token, 'sendCoins', { user_id: stranger.id, amount: 1 })).status).toBe(403);
    await setBalance(s.customer.id, -1);
    expect(await ok(s.token, 'getUserBalance', { user_id: s.customer.id })).toMatchObject({ balance: -1, infinite: true });
    await s.customer.req('POST', `/api/users/${s.botId}/block`);
    expect((await api(s.token, 'getUserBalance', { user_id: s.customer.id })).status).toBe(403);
  });

  it('does not let a bot account get the starting balance, nor take transfers', async () => {
    const s = await shop('bal2');
    expect((await ok(s.token, 'getMyBalance')).balance).toBe(0);
    const r = await s.customer.req('POST', '/api/bank/transfer', { userId: s.botId, amount: 5, message: '' });
    expect(r.status).toBe(400);
  });
});

describe('the till of the owner', () => {
  it('can be the owner\'s own balance: payments go there, refunds and payouts come from it', async () => {
    const s = await shop('own1');
    // first the till of the bot itself gets something
    const first = await sendInvoice(s, { amount: 10 });
    await s.customer.req('POST', `/api/invoices/${first.invoice.invoice_id}/pay`);
    expect((await ok(s.token, 'getMyBalance')).balance).toBe(10);
    expect((await s.owner.req('GET', `/api/mybots/${s.botId}`)).body).toMatchObject({ wallet: 'bot', walletBalance: 10 });

    // switch to the owner's balance
    const ownerBefore = await balance(s.owner);
    const switched = await s.owner.req('PATCH', `/api/mybots/${s.botId}`, { wallet: 'owner' });
    expect(switched.body).toMatchObject({ wallet: 'owner', walletBalance: ownerBefore, ownBalance: 10 });
    expect(await ok(s.token, 'getMyBalance')).toMatchObject({ wallet: 'owner', balance: ownerBefore });
    const second = await sendInvoice(s, { amount: 25 });
    await s.customer.req('POST', `/api/invoices/${second.invoice.invoice_id}/pay`);
    expect(await balance(s.owner)).toBe(ownerBefore + 25);
    expect((await ok(s.token, 'getMyBalance')).balance).toBe(ownerBefore + 25);
    await ok(s.token, 'sendCoins', { user_id: s.customer.id, amount: 5 });
    expect(await balance(s.owner)).toBe(ownerBefore + 20);

    // the 10 ТК in the bot's own account are withdrawn to the owner
    expect((await s.owner.req('POST', `/api/mybots/${s.botId}/withdraw`, {})).body.withdrawn).toBe(10);
    expect(await balance(s.owner)).toBe(ownerBefore + 30);
    expect((await ok(s.token, 'getMyBalance')).wallet).toBe('owner');

    expect((await s.owner.req('PATCH', `/api/mybots/${s.botId}`, { wallet: 'bot' })).body.wallet).toBe('bot');
    expect((await ok(s.token, 'getMyBalance')).wallet).toBe('bot');
  });

  it('gives the till to the owner when the bot is deleted', async () => {
    const s = await shop('own2');
    const msg = await sendInvoice(s, { amount: 60 });
    await s.customer.req('POST', `/api/invoices/${msg.invoice.invoice_id}/pay`);
    const before = await balance(s.owner);
    expect((await s.owner.req('DELETE', `/api/mybots/${s.botId}`)).status).toBe(200);
    expect(await balance(s.owner)).toBe(before + 60);
  });
});

describe('what the admin controls', () => {
  it('takes a share of every payment into the cash and keeps the limits', async () => {
    const adm = await admin();
    const set = await adm.req('PUT', '/api/admin/bots/settings', { feePercent: 10, maxInvoice: 200 });
    expect(set.body).toMatchObject({ feePercent: 10, maxInvoice: 200, createEnabled: true, paymentsEnabled: true });
    try {
      const s = await shop('adm1', 300);
      const cashBefore = await balance(adm);
      const msg = await sendInvoice(s, { amount: 100 });
      await s.customer.req('POST', `/api/invoices/${msg.invoice.invoice_id}/pay`);
      expect((await ok(s.token, 'getMyBalance')).balance).toBe(90);
      expect(await balance(adm)).toBeGreaterThanOrEqual(cashBefore === -1 ? -1 : cashBefore + 10);
      expect((await api(s.token, 'sendInvoice', { chat_id: s.customer.id, title: 'T', amount: 201 })).status).toBe(400);
      // a refund gives the whole sum back, the fee returns from the cash
      await ok(s.token, 'refundPayment', { invoice_id: msg.invoice.invoice_id });
      expect(await balance(s.customer)).toBe(300);
      expect((await ok(s.token, 'getMyBalance')).balance).toBe(0);
    } finally {
      await adm.req('PUT', '/api/admin/bots/settings', { feePercent: 0, maxInvoice: 100000 });
    }
  });

  it('switches payments off for everybody or for one bot', async () => {
    const adm = await admin();
    const s = await shop('adm2');
    const msg = await sendInvoice(s, { amount: 5 });
    await adm.req('PUT', '/api/admin/bots/settings', { paymentsEnabled: false });
    try {
      expect((await api(s.token, 'sendInvoice', { chat_id: s.customer.id, title: 'T', amount: 5 })).status).toBe(403);
      expect((await api(s.token, 'sendCoins', { user_id: s.customer.id, amount: 1 })).status).toBe(403);
      expect((await s.customer.req('POST', `/api/invoices/${msg.invoice.invoice_id}/pay`)).status).toBe(403);
    } finally {
      await adm.req('PUT', '/api/admin/bots/settings', { paymentsEnabled: true });
    }
    expect((await adm.req('PATCH', `/api/admin/bots/${s.botId}`, { paymentsEnabled: false })).body.paymentsEnabled).toBe(false);
    expect((await api(s.token, 'sendInvoice', { chat_id: s.customer.id, title: 'T', amount: 5 })).status).toBe(403);
    await adm.req('PATCH', `/api/admin/bots/${s.botId}`, { paymentsEnabled: true });
    expect((await s.customer.req('POST', `/api/invoices/${msg.invoice.invoice_id}/pay`)).status).toBe(200);
  });

  it('freezes a bot: the token stops working and nothing reaches it', async () => {
    const adm = await admin();
    const s = await shop('adm3');
    await ok(s.token, 'getUpdates', {});
    const row = (await adm.req('PATCH', `/api/admin/bots/${s.botId}`, { disabled: true })).body;
    expect(row).toMatchObject({ disabled: true, paymentsEnabled: true, wallet: 'bot' });
    const r = await api(s.token, 'getMe');
    expect(r.status).toBe(403);
    await s.customer.req('POST', `/api/chats/${s.chat}/messages`, { text: 'эй' });
    await adm.req('PATCH', `/api/admin/bots/${s.botId}`, { disabled: false });
    expect((await ok<any[]>(s.token, 'getUpdates', {})).filter((u) => u.message?.text === 'эй')).toHaveLength(0);
    await ok(s.token, 'getMe');
    const listed = ((await adm.req('GET', '/api/admin/bots')).body as any[]).find((b) => b.user.id === s.botId);
    expect(listed).toMatchObject({ disabled: false, ownBalance: 0, paidInvoices: 0, earned: 0 });
    // the built-in bots are not frozen
    const father = ((await adm.req('GET', '/api/admin/bots')).body as any[]).find((b) => b.builtin === 'premiumbot');
    expect((await adm.req('PATCH', `/api/admin/bots/${father.user.id}`, { disabled: true })).status).toBe(404);
  });

  it('limits the number of bots and can stop creating them', async () => {
    const adm = await admin();
    const owner = await register('limitowner');
    await setBalance(owner.id, 100);
    const create = (username: string) => owner.req('POST', '/api/mybots', { name: 'Бот', username });
    await adm.req('PUT', '/api/admin/bots/settings', { createEnabled: false });
    try {
      expect((await owner.req('GET', '/api/mybots')).body.createEnabled).toBe(false);
      const off = await create('limit1_bot');
      expect(off.status).toBe(400);
      expect(off.body.error).toBe('creation_off');
    } finally {
      await adm.req('PUT', '/api/admin/bots/settings', { createEnabled: true, maxPerUser: 1 });
    }
    try {
      expect((await create('limit1_bot')).status).toBe(200);
      const over = await create('limit2_bot');
      expect(over.status).toBe(400);
      expect(over.body.error).toBe('bot_limit');
      expect((await owner.req('GET', '/api/mybots')).body.max).toBe(1);
    } finally {
      await adm.req('PUT', '/api/admin/bots/settings', { maxPerUser: 20 });
    }
    expect((await adm.req('PUT', '/api/admin/bots/settings', { feePercent: 95 })).status).toBe(400);
    expect((await owner.req('GET', '/api/admin/bots/settings')).status).toBeGreaterThanOrEqual(401);
  });
});

describe('@PremiumBot', () => {
  const DAY = 86400_000;

  async function customer(name: string, money: number) {
    const u = await register(name);
    await setBalance(u.id, money);
    const botId = (await u.req('GET', '/api/resolve/PremiumBot')).body.user.id as number;
    const chat = (await u.req('POST', '/api/chats/private', { userId: botId })).body.id as number;
    const messages = async () => (await u.req('GET', `/api/chats/${chat}/messages?limit=100`)).body as any[];
    const say = (text: string) => u.req('POST', `/api/chats/${chat}/messages`, { text });
    const fromBot = async (n: number, after = 0) =>
      waitFor(async () => {
        const list = (await messages()).filter((m) => m.senderId === botId && m.id > after);
        return list.length >= n ? list : undefined;
      });
    return { u, botId, chat, messages, say, fromBot };
  }

  const premiumUntil = async (id: number) => {
    const { getUserRow } = await import('../src/serialize.js');
    return getUserRow(id)!.premium_until;
  };

  /** Opens the menu, presses the button of a tariff and returns the invoice message the bot sent. */
  async function order(c: Awaited<ReturnType<typeof customer>>, days: number) {
    await c.say('/start');
    const menu = (await c.fromBot(1)).at(-1)!;
    const before = (await c.messages()).at(-1)!.id;
    const press = await c.u.req('POST', `/api/messages/${menu.id}/callback`, { data: `buy:${days}` });
    expect(press.status).toBe(200);
    const list = await c.fromBot(1, before);
    return list.find((m) => m.replyMarkup?.rows.flat().some((b: any) => b.invoiceId)) ?? list.at(-1)!;
  }

  it('is a built-in bot with a picture and two commands, and sells three tariffs', async () => {
    const c = await customer('prem1', 1000);
    const info = (await c.u.req('GET', `/api/bots/${c.botId}`)).body;
    expect(info.builtin).toBe(true);
    expect(info.commands.map((x: any) => x.command)).toEqual(['start', 'help']);
    expect(info.canJoinGroups).toBe(false);
    await c.say('/start');
    const menu = (await c.fromBot(1))[0]!;
    expect(menu.text).toContain('Сейчас Премиума нет');
    expect(menu.text).toContain('1000 ТК');
    expect(menu.replyMarkup.rows.flat().map((b: any) => b.text)).toEqual(['1 день — 30 ТК', '7 дней — 199 ТК', '30 дней — 499 ТК']);
    await c.say('/help');
    expect((await c.fromBot(2))[1]!.text).toContain('Что даёт Премиум');
    await c.say('привет');
    expect((await c.fromBot(3))[2]!.text).toContain('кнопкой');
  });

  it('bills the tariff, adds the days when it is paid and keeps the money in the cash', async () => {
    const adm = await admin();
    await setBalance(adm.id, 0);
    const c = await customer('prem2', 600);
    expect(await premiumUntil(c.u.id)).toBeNull();
    const invoice = await order(c, 7);
    expect(invoice.text).toContain('Премиум на 7 дней');
    expect(invoice.text).toContain('199 ТК');
    const inv = invoice.replyMarkup.rows[0][0];
    expect(inv.text).toBe('Оплатить 199 ТК');

    const paid = await c.u.req('POST', `/api/invoices/${inv.invoiceId}/pay`);
    expect(paid.status).toBe(200);
    expect(paid.body.balance).toBe(401);
    const until = (await premiumUntil(c.u.id))!;
    expect(until - Date.now()).toBeGreaterThan(7 * DAY - 60_000);
    expect(until - Date.now()).toBeLessThanOrEqual(7 * DAY);
    expect(await balance(adm)).toBe(199);

    // the bot says thanks, and the badge shows up for everybody
    const thanks = (await c.fromBot(3)).at(-1)!;
    expect(thanks.text).toContain('Оплата прошла');
    expect(((await c.u.req('GET', '/api/auth/me')).body as any).premium).toBe(true);

    // a second purchase adds to what is left
    const again = await order(c, 1);
    await c.u.req('POST', `/api/invoices/${again.replyMarkup.rows[0][0].invoiceId}/pay`);
    expect((await premiumUntil(c.u.id))! - until).toBe(DAY);
    expect(await balance(c.u)).toBe(401 - 30);
    expect(await balance(adm)).toBe(229);
    await setBalance(adm.id, -1);
  });

  it('sells nothing without enough ТК, and a new choice replaces the old bill', async () => {
    const c = await customer('prem3', 100);
    const first = await order(c, 30);
    const id1 = first.replyMarkup.rows[0][0].invoiceId;
    const poor = await c.u.req('POST', `/api/invoices/${id1}/pay`);
    expect(poor.status).toBe(400);
    expect(await premiumUntil(c.u.id)).toBeNull();
    expect(await balance(c.u)).toBe(100);

    const second = await order(c, 1);
    expect(second.text).toContain('Премиум на 1 день');
    expect((await c.u.req('POST', `/api/invoices/${id1}/pay`)).status).toBe(409);
    expect((await c.u.req('POST', `/api/invoices/${second.replyMarkup.rows[0][0].invoiceId}/pay`)).status).toBe(200);
    expect(await balance(c.u)).toBe(70);
    expect((await premiumUntil(c.u.id))! - Date.now()).toBeLessThanOrEqual(DAY);
  });

  it('does not sell to somebody with Премиум forever, nor while payments are off, nor an unknown tariff', async () => {
    const adm = await admin();
    const c = await customer('prem4', 1000);
    const { extendPremium } = await import('../src/premium.js');
    await c.say('/start');
    const menu = (await c.fromBot(1))[0]!;
    const press = async (data: string) => (await c.u.req('POST', `/api/messages/${menu.id}/callback`, { data })).status;

    // a button that is not on the message never reaches the bot
    expect(await press('buy:3')).toBe(400);
    expect(await press('nope')).toBe(400);

    await adm.req('PUT', '/api/admin/bots/settings', { paymentsEnabled: false });
    try {
      expect(await press('buy:7')).toBe(200);
      await new Promise((r) => setTimeout(r, 200));
      expect((await c.messages()).filter((m) => m.replyMarkup?.rows.flat().some((b: any) => b.invoiceId))).toHaveLength(0);
    } finally {
      await adm.req('PUT', '/api/admin/bots/settings', { paymentsEnabled: true });
    }

    extendPremium(c.u.id, null);
    expect(await press('buy:7')).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    expect((await c.messages()).filter((m) => m.replyMarkup?.rows.flat().some((b: any) => b.invoiceId))).toHaveLength(0);
    expect(await balance(c.u)).toBe(1000);
  });

  it('is listed in the admin panel as a built-in bot with what it earned', async () => {
    const adm = await admin();
    const list = (await adm.req('GET', '/api/admin/bots')).body as any[];
    const shop = list.find((b) => b.builtin === 'premiumbot');
    expect(shop).toBeTruthy();
    expect(shop.user.username).toBe('PremiumBot');
    expect(shop.paidInvoices).toBeGreaterThanOrEqual(2);
    expect((await adm.req('DELETE', `/api/admin/bots/${shop.user.id}`)).status).toBe(404);
  });
});
