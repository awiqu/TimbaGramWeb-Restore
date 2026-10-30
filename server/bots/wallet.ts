import {
  BOT_FEE_PERCENT,
  BOT_INVOICE_DESCRIPTION_MAX,
  BOT_INVOICE_MAX_AMOUNT,
  BOT_INVOICE_PAYLOAD_MAX,
  BOT_INVOICE_TITLE_MAX,
  BOT_INVOICE_TTL_HOURS,
  BOT_MAX_PER_USER,
  EV,
  type BotSettingsDTO,
  type BotWallet,
  type BotWalletInfo,
  type InlineKeyboardDTO,
  type InvoiceDTO,
  type InvoicePayResult,
  type InvoiceStatus,
} from '@timba/shared';
import { INFINITE, addOp, cashUser, ensureAccount, infinite, move, requireActive, spendable } from '../bank/bank.js';
import { db, now } from '../db.js';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { notify } from '../notifications.js';
import { toChat } from '../realtime.js';
import { type UserRow, getMessageRow, getUserRow, messageDTO, userDTO } from '../serialize.js';
import { sendPrepared } from '../services/messages.js';
import { txt } from '../strings.js';
import { apiChat, apiMessage, apiUser } from './convert.js';
import { enqueue } from './updates.js';
import { type BotRow, getBot } from './store.js';
import { encryptText } from '../crypt.js';

/**
 * The tills of bots and their invoices. A bot has an account like any user (it starts empty); the owner may
 * decide in the bot's settings that the owner's own balance is the till instead (wallet_owner = 1): payments then go
 * to it and refunds and payouts are taken from it. Every money move writes a row in the bank's history and
 * one in the bot's own book (bot_ledger).
 */

// ---------- settings of the admin ----------

const DEFAULT_SETTINGS: BotSettingsDTO = {
  createEnabled: true,
  maxPerUser: BOT_MAX_PER_USER,
  paymentsEnabled: true,
  feePercent: BOT_FEE_PERCENT,
  maxInvoice: BOT_INVOICE_MAX_AMOUNT,
  invoiceTtlHours: BOT_INVOICE_TTL_HOURS,
};

export function botSettings(): BotSettingsDTO {
  const r = db.prepare(`SELECT value FROM app_settings WHERE key = 'bots'`).get() as { value: string } | undefined;
  const stored = (r ? JSON.parse(r.value) : {}) as Partial<BotSettingsDTO>;
  return { ...DEFAULT_SETTINGS, ...stored };
}

export function updateBotSettings(patch: Partial<BotSettingsDTO>): BotSettingsDTO {
  const next: BotSettingsDTO = { ...botSettings() };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) (next as unknown as Record<string, unknown>)[k] = v;
  db.prepare(`INSERT INTO app_settings (key, value) VALUES ('bots', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
    JSON.stringify(next),
  );
  return next;
}

// ---------- the till ----------

/**
 * A built-in bot may finish a payment itself: the hook runs inside the transaction of the payment, so the
 * goods (a month of Премиум) and the money move together or not at all.
 */
export type PaidHook = (user: UserRow, invoice: InvoiceRow) => void;
const paidHooks = new Map<string, PaidHook>();
export const registerPaidHook = (kind: string, hook: PaidHook) => void paidHooks.set(kind, hook);

/** The shop of Премиум sells for the messenger itself: its money goes to the cash (@admin), with no fee. */
const sellsForMessenger = (bot: Pick<BotRow, 'builtin'>) => bot.builtin === 'premiumbot';

export const walletOf = (bot: Pick<BotRow, 'wallet_owner' | 'owner_id'>): BotWallet => (bot.wallet_owner && bot.owner_id ? 'owner' : 'bot');

/** The user whose account is the till of the bot. */
export function walletUser(bot: BotRow): UserRow {
  if (sellsForMessenger(bot)) return cashUser();
  const id = walletOf(bot) === 'owner' ? bot.owner_id! : bot.user_id;
  const u = getUserRow(id);
  if (!u) throw notFound(txt.errors.userNotFound);
  return u;
}

const accountBalance = (userId: number) =>
  (db.prepare('SELECT balance FROM bank_accounts WHERE user_id = ?').get(userId) as { balance: number } | undefined)?.balance ?? 0;

export function walletInfo(bot: BotRow): BotWalletInfo {
  const u = walletUser(bot);
  ensureAccount(u);
  return { wallet: walletOf(bot), balance: accountBalance(u.id), ownBalance: accountBalance(bot.user_id) };
}

export function setWalletMode(bot: BotRow, wallet: BotWallet) {
  if (wallet === 'owner' && !bot.owner_id) throw badRequest(txt.bots.noTransfers);
  db.prepare('UPDATE bots SET wallet_owner = ? WHERE user_id = ?').run(wallet === 'owner' ? 1 : 0, bot.user_id);
}

export type LedgerKind = 'payment' | 'refund' | 'payout' | 'withdraw' | 'deposit';

function ledger(botId: number, kind: LedgerKind, amount: number, userId: number | null, invoiceId: number | null, message: string) {
  db.prepare('INSERT INTO bot_ledger (bot_id, kind, amount, user_id, invoice_id, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    botId,
    kind,
    amount,
    userId,
    invoiceId,
    message,
    now(),
  );
}

interface LedgerRow {
  id: number;
  kind: LedgerKind;
  amount: number;
  user_id: number | null;
  invoice_id: number | null;
  message: string;
  created_at: number;
}

/** The bot's own book: newest first. */
export function transactionsOf(bot: BotRow, offset: number, limit: number) {
  const rows = db
    .prepare('SELECT * FROM bot_ledger WHERE bot_id = ? ORDER BY id DESC LIMIT ? OFFSET ?')
    .all(bot.user_id, limit, offset) as LedgerRow[];
  return rows.map((r) => ({
    id: r.id,
    type: r.kind,
    amount: r.amount,
    date: r.created_at,
    user: r.user_id ? getUserRow(r.user_id) : undefined,
    invoice_id: r.invoice_id,
    message: r.message,
  }));
}

export function earnings(botId: number): { paid: number; earned: number } {
  const r = db
    .prepare(`SELECT COUNT(*) paid, COALESCE(SUM(amount - fee), 0) earned FROM bot_invoices WHERE bot_id = ? AND paid_at IS NOT NULL`)
    .get(botId) as { paid: number; earned: number };
  return r;
}

// ---------- invoices ----------

export interface InvoiceRow {
  id: number;
  bot_id: number;
  user_id: number;
  chat_id: number | null;
  message_id: number | null;
  title: string;
  description: string;
  payload: string;
  amount: number;
  status: InvoiceStatus;
  fee: number;
  wallet_user_id: number | null;
  created_at: number;
  expires_at: number | null;
  paid_at: number | null;
  refunded_at: number | null;
}

export const getInvoice = (id: number) => db.prepare('SELECT * FROM bot_invoices WHERE id = ?').get(id) as InvoiceRow | undefined;

export function invoiceByMessage(messageId: number) {
  return db.prepare('SELECT * FROM bot_invoices WHERE message_id = ?').get(messageId) as InvoiceRow | undefined;
}

export function invoiceDTO(inv: InvoiceRow): InvoiceDTO {
  const bot = getUserRow(inv.bot_id);
  return {
    id: inv.id,
    bot: userDTO(bot!),
    title: inv.title,
    description: inv.description,
    amount: inv.amount,
    status: inv.status,
    createdAt: inv.created_at,
    expiresAt: inv.expires_at,
    paidAt: inv.paid_at,
  };
}

/** The Bot API's view of an invoice. */
export function apiInvoice(inv: InvoiceRow) {
  return {
    invoice_id: inv.id,
    title: inv.title,
    description: inv.description,
    currency: 'TK',
    total_amount: inv.amount,
    invoice_payload: inv.payload,
    status: inv.status,
    date: inv.created_at,
    ...(inv.expires_at ? { expire_date: Math.floor(inv.expires_at / 1000) } : {}),
    ...(inv.paid_at ? { paid_date: Math.floor(inv.paid_at / 1000) } : {}),
    chat_id: inv.user_id,
    ...(inv.message_id ? { message_id: inv.message_id } : {}),
  };
}

function invoiceText(inv: Pick<InvoiceRow, 'title' | 'description' | 'amount' | 'status'>): string {
  const status = (txt.bots.invoiceStatus[inv.status] ?? txt.bots.invoiceStatus.pending!)(inv.amount);
  return [txt.bots.invoiceHeader(inv.title), inv.description, status].filter(Boolean).join('\n\n');
}

/** The invoice message shows its state; the buttons go away once the invoice cannot be paid any more. */
function refreshMessage(inv: InvoiceRow) {
  if (!inv.message_id) return;
  const row = getMessageRow(inv.message_id);
  if (!row) return;
  const markup = inv.status === 'pending' ? row.reply_markup : null;
  db.prepare('UPDATE messages SET text = ?, reply_markup = ? WHERE id = ?').run(encryptText(invoiceText(inv)), markup, row.id);
  toChat(row.chat_id, EV.messageEdit, messageDTO(getMessageRow(row.id)!));
}

export interface InvoiceInput {
  title: string;
  description: string;
  payload: string;
  amount: number;
  /** seconds; none = the default term */
  expiresIn?: number;
  silent?: boolean;
  replyToId?: number | null;
  /** the bot's own buttons under the «Оплатить» one */
  extraRows?: InlineKeyboardDTO['rows'];
}

export class InvoiceError extends Error {}

function assertPayments(bot: BotRow) {
  if (!botSettings().paymentsEnabled || !bot.payments_enabled) throw forbidden(txt.bots.paymentsOff, 'payments_off');
}

/** The checks of an invoice. Throws InvoiceError with the text for the Bot API. */
export function checkInvoice(input: InvoiceInput) {
  const s = botSettings();
  const title = input.title.trim();
  if (!title || title.length > BOT_INVOICE_TITLE_MAX) throw new InvoiceError(`title must be 1-${BOT_INVOICE_TITLE_MAX} characters`);
  if (input.description.length > BOT_INVOICE_DESCRIPTION_MAX) throw new InvoiceError(`description must be at most ${BOT_INVOICE_DESCRIPTION_MAX} characters`);
  if (Buffer.byteLength(input.payload, 'utf8') > BOT_INVOICE_PAYLOAD_MAX) throw new InvoiceError(`payload must be at most ${BOT_INVOICE_PAYLOAD_MAX} bytes`);
  if (!Number.isInteger(input.amount) || input.amount < 1 || input.amount > s.maxInvoice) throw new InvoiceError(`amount must be an integer from 1 to ${s.maxInvoice}`);
  if (input.expiresIn !== undefined && (!Number.isInteger(input.expiresIn) || input.expiresIn < 60 || input.expiresIn > 365 * 24 * 3600)) {
    throw new InvoiceError('expires_in must be from 60 seconds to a year');
  }
  return { title, s };
}

/** The bot sends an invoice to a person in their private chat. */
export function createInvoice(bot: BotRow, botUser: UserRow, payer: UserRow, chatRow: Parameters<typeof sendPrepared>[0], input: InvoiceInput) {
  assertPayments(bot);
  const { title, s } = checkInvoice(input);
  if (payer.is_bot) throw badRequest(txt.bots.noTransfers);
  const t = now();
  const expires = t + (input.expiresIn ? input.expiresIn * 1000 : s.invoiceTtlHours * 3600_000);
  const id = Number(
    db
      .prepare(
        `INSERT INTO bot_invoices (bot_id, user_id, chat_id, title, description, payload, amount, wallet_user_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(bot.user_id, payer.id, chatRow.id, title, input.description.trim(), input.payload, input.amount, walletUser(bot).id, t, expires)
      .lastInsertRowid,
  );
  const inv = getInvoice(id)!;
  try {
    const rows: InlineKeyboardDTO['rows'] = [[{ text: txt.bots.invoicePayButton(inv.amount), invoiceId: id }], ...(input.extraRows ?? [])];
    const sent = sendPrepared(chatRow, botUser, {
      text: invoiceText(inv),
      files: [],
      replyToId: input.replyToId,
      silent: input.silent,
      replyMarkup: JSON.stringify({ rows } satisfies InlineKeyboardDTO),
    });
    db.prepare('UPDATE bot_invoices SET message_id = ? WHERE id = ?').run(sent.id, id);
  } catch (e) {
    db.prepare('DELETE FROM bot_invoices WHERE id = ?').run(id);
    throw e;
  }
  return getInvoice(id)!;
}

/** The bot withdraws an unpaid invoice. */
export function cancelInvoice(bot: BotRow, invoiceId: number) {
  const inv = getInvoice(invoiceId);
  if (!inv || inv.bot_id !== bot.user_id) throw notFound(txt.bots.invoiceNotFound);
  if (inv.status !== 'pending') throw conflict(txt.bots.invoiceNotPending, 'invoice_not_pending');
  db.prepare(`UPDATE bot_invoices SET status = 'cancelled' WHERE id = ?`).run(inv.id);
  refreshMessage(getInvoice(inv.id)!);
  return getInvoice(inv.id)!;
}

/** Invoices past their term stop being payable. */
export function expireInvoices() {
  const rows = db
    .prepare(`SELECT * FROM bot_invoices WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < ?`)
    .all(now()) as InvoiceRow[];
  for (const inv of rows) {
    db.prepare(`UPDATE bot_invoices SET status = 'expired' WHERE id = ?`).run(inv.id);
    refreshMessage(getInvoice(inv.id)!);
  }
}

/** The payer pays an invoice with their ТК. */
export function payInvoice(user: UserRow, invoiceId: number): InvoicePayResult {
  let inv = getInvoice(invoiceId);
  if (!inv || inv.user_id !== user.id) throw notFound(txt.bots.invoiceNotFound);
  if (inv.status === 'pending' && inv.expires_at && inv.expires_at < now()) {
    expireInvoices();
    inv = getInvoice(invoiceId)!;
  }
  if (inv.status === 'expired') throw conflict(txt.bots.invoiceExpired, 'invoice_expired');
  if (inv.status !== 'pending') throw conflict(txt.bots.invoiceNotPending, 'invoice_not_pending');
  const bot = getBot(inv.bot_id);
  const botUser = getUserRow(inv.bot_id);
  if (!bot || !botUser) throw notFound(txt.bots.invoiceNotFound);
  if (bot.disabled) throw forbidden(txt.bots.botDisabled);
  assertPayments(bot);
  requireActive(user);
  const wallet = walletUser(bot);
  ensureAccount(wallet);
  if (accountBanned(wallet.id)) throw forbidden(txt.bots.walletBanned);
  const cash = cashUser();
  ensureAccount(cash);
  const fee = sellsForMessenger(bot) ? 0 : Math.floor((inv.amount * botSettings().feePercent) / 100);
  db.transaction(() => {
    if (spendable(user.id) < inv!.amount) throw new HttpError(400, 'insufficient_funds', txt.bank.insufficient);
    move(user.id, -inv!.amount);
    move(wallet.id, inv!.amount - fee);
    addOp(user.id, 'invoice_pay', -inv!.amount, botUser, inv!.title);
    addOp(wallet.id, 'invoice_in', inv!.amount - fee, user, `@${botUser.username}: ${inv!.title}`);
    if (fee) {
      move(cash.id, fee);
      addOp(cash.id, 'income', fee, user, `@${botUser.username}: ${inv!.title}`);
    }
    db.prepare(`UPDATE bot_invoices SET status = 'paid', fee = ?, wallet_user_id = ?, paid_at = ? WHERE id = ?`).run(fee, wallet.id, now(), inv!.id);
    ledger(bot.user_id, 'payment', inv!.amount - fee, user.id, inv!.id, txt.bots.ledgerPayment(inv!.title));
    if (bot.builtin) paidHooks.get(bot.builtin)?.(user, getInvoice(inv!.id)!);
  })();
  const paid = getInvoice(inv.id)!;
  refreshMessage(paid);
  announcePayment(bot, user, paid);
  return { invoice: invoiceDTO(paid), balance: accountBalance(user.id) };
}

const accountBanned = (userId: number) => !!(db.prepare('SELECT banned FROM bank_accounts WHERE user_id = ?').get(userId) as { banned: number } | undefined)?.banned;

/** The bot hears about the payment: a message with `successful_payment`, a reply to the invoice. */
function announcePayment(bot: BotRow, payer: UserRow, inv: InvoiceRow) {
  const chat = inv.chat_id ? db.prepare('SELECT * FROM chats WHERE id = ?').get(inv.chat_id) : undefined;
  if (!chat) return;
  const invoiceMessage = inv.message_id ? getMessageRow(inv.message_id) : undefined;
  enqueue(bot, 'message', {
    message_id: inv.message_id ?? 0,
    from: apiUser(payer),
    chat: apiChat(chat as Parameters<typeof apiChat>[0], bot.user_id),
    date: Math.floor(Date.now() / 1000),
    ...(invoiceMessage ? { reply_to_message: apiMessage(invoiceMessage, bot.user_id, { shallow: true }) } : {}),
    successful_payment: {
      currency: 'TK',
      total_amount: inv.amount,
      invoice_id: inv.id,
      invoice_payload: inv.payload,
    },
  });
}

/** The bot gives the money of a paid invoice back. */
export function refundInvoice(bot: BotRow, invoiceId: number) {
  assertPayments(bot);
  const inv = getInvoice(invoiceId);
  if (!inv || inv.bot_id !== bot.user_id) throw notFound(txt.bots.invoiceNotFound);
  if (inv.status !== 'paid') throw conflict(txt.bots.invoiceNotPending, 'invoice_not_paid');
  const payer = getUserRow(inv.user_id);
  const botUser = getUserRow(bot.user_id)!;
  if (!payer) throw notFound(txt.errors.userNotFound);
  const wallet = walletUser(bot);
  const cash = cashUser();
  db.transaction(() => {
    ensureAccount(payer);
    // the fee comes back from the cash as far as the cash can; otherwise the bot gives the whole sum back
    const cashPays = inv.fee > 0 && (infinite(cash.id) || accountBalance(cash.id) >= inv.fee) ? inv.fee : 0;
    const walletPays = inv.amount - cashPays;
    if (spendable(wallet.id) < walletPays) throw new HttpError(400, 'insufficient_funds', txt.bots.noFundsOnBot);
    move(wallet.id, -walletPays);
    if (cashPays) {
      move(cash.id, -cashPays);
      addOp(cash.id, 'refund_out', -cashPays, payer, txt.bots.refundMessage(inv.title));
    }
    move(payer.id, inv.amount);
    addOp(wallet.id, 'refund_out', -walletPays, payer, txt.bots.refundMessage(inv.title));
    addOp(payer.id, 'refund_in', inv.amount, botUser, txt.bots.refundMessage(inv.title));
    db.prepare(`UPDATE bot_invoices SET status = 'refunded', refunded_at = ? WHERE id = ?`).run(now(), inv.id);
    ledger(bot.user_id, 'refund', -walletPays, payer.id, inv.id, txt.bots.refundMessage(inv.title));
  })();
  refreshMessage(getInvoice(inv.id)!);
  notify('bank', payer.id, txt.bots.refundNotice(botUser.username, inv.amount, inv.title));
  return getInvoice(inv.id)!;
}

/** The bot pays coins to a person out of its till. */
export function payout(bot: BotRow, target: UserRow, amount: number, comment: string) {
  assertPayments(bot);
  const max = botSettings().maxInvoice;
  if (!Number.isInteger(amount) || amount < 1 || amount > max) throw badRequest(txt.bots.amountBad(max));
  if (target.is_bot) throw badRequest(txt.bots.noTransfers);
  const botUser = getUserRow(bot.user_id)!;
  const wallet = walletUser(bot);
  const note = comment.trim().slice(0, 200);
  db.transaction(() => {
    ensureAccount(target);
    ensureAccount(wallet);
    if (accountBanned(target.id)) throw forbidden(txt.bots.walletBanned);
    if (spendable(wallet.id) < amount) throw new HttpError(400, 'insufficient_funds', txt.bots.noFundsOnBot);
    move(wallet.id, -amount);
    move(target.id, amount);
    addOp(wallet.id, 'payout_out', -amount, target, txt.bots.payoutMessage(note));
    addOp(target.id, 'payout_in', amount, botUser, txt.bots.payoutMessage(note));
    ledger(bot.user_id, 'payout', -amount, target.id, null, txt.bots.payoutMessage(note));
  })();
  notify('bank', target.id, txt.bots.payoutNotice(botUser.username, amount, note));
}

/** The owner takes everything (or `amount`) from the bot's own account to their balance. */
export function withdraw(bot: BotRow, owner: UserRow, amount?: number): number {
  const botUser = getUserRow(bot.user_id)!;
  ensureAccount(botUser);
  const have = accountBalance(bot.user_id);
  if (have === INFINITE) throw badRequest(txt.bots.nothingToWithdraw);
  const sum = amount ?? have;
  if (sum < 1 || sum > have) throw badRequest(txt.bots.nothingToWithdraw);
  db.transaction(() => {
    ensureAccount(owner);
    move(bot.user_id, -sum);
    move(owner.id, sum);
    addOp(bot.user_id, 'transfer_out', -sum, owner, txt.bots.withdrawMessage(botUser.username));
    addOp(owner.id, 'transfer_in', sum, botUser, txt.bots.withdrawMessage(botUser.username));
    ledger(bot.user_id, 'withdraw', -sum, owner.id, null, txt.bots.withdrawMessage(botUser.username));
  })();
  return sum;
}
