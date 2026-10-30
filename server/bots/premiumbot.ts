import { PREMIUM_SHOP, isPremiumForever } from '@timba/shared';
import { balanceOfUser, ensureAccount } from '../bank/bank.js';
import { config } from '../config.js';
import { db } from '../db.js';
import { announcePremium, extendPremium } from '../premium.js';
import { type UserRow, getUserRow } from '../serialize.js';
import { txt } from '../strings.js';
import { callBotMethod } from './api.js';
import type { BuiltinUpdate } from './builtin.js';
import { BotApiError } from './errors.js';
import type { BotRow } from './store.js';
import { type InvoiceRow, cancelInvoice } from './wallet.js';

/**
 * @PremiumBot: sells TimbaGram Premium for ТК, 1 day, 7 days or 30 days. It does nothing else: no refunds,
 * no settings. A tariff button makes an invoice; when it is paid the Премиум is added in the same transaction
 * (see `grantPremium`) and the bot says thanks.
 */

type Json = Record<string, unknown>;

const api = (bot: BotRow, method: string, params: Json) => callBotMethod(bot, method, params, new Map(), config.publicUrl ?? '');

/** The invoice stays payable for an hour: prices and the balance do not go stale in the chat. */
const INVOICE_TTL_SECONDS = 3600;

const tariff = (days: number) => PREMIUM_SHOP.find((t) => t.days === days);

const payloadOf = (days: number) => `premium:${days}`;
const daysOfPayload = (payload: string) => {
  const m = /^premium:(\d+)$/.exec(payload);
  return m ? Number(m[1]) : null;
};

/** Runs inside the payment: the days are added to the Премиум of the payer. */
export function grantPremium(user: UserRow, inv: InvoiceRow) {
  const days = daysOfPayload(inv.payload);
  const plan = days === null ? undefined : tariff(days);
  if (!plan || plan.price !== inv.amount) throw new Error(`premium invoice ${inv.id} does not match a tariff`);
  extendPremium(user.id, plan.days);
}

const untilText = (userId: number) => {
  const u = getUserRow(userId);
  return u?.premium_until && u.premium_until > Date.now() ? txt.premium.until(u.premium_until) : null;
};

function menu(user: UserRow) {
  ensureAccount(user);
  const balance = balanceOfUser(user);
  const until = untilText(user.id);
  return {
    text: txt.bots.premiumMenu(until ? txt.bots.premiumStatusOn(until) : txt.bots.premiumStatusOff, balance === -1 ? '∞' : balance),
    reply_markup: {
      inline_keyboard: PREMIUM_SHOP.map((t) => [{ text: txt.bots.premiumButton(t.days, t.price), callback_data: `buy:${t.days}` }]),
    },
  };
}

export async function premiumbot(bot: BotRow, update: BuiltinUpdate) {
  if (update.message) await onMessage(bot, update.message as Json);
  else if (update.callback_query) await onCallback(bot, update.callback_query as Json);
}

async function onMessage(bot: BotRow, m: Json) {
  const from = m.from as { id: number } | undefined;
  const chat = m.chat as { id: number; type: string };
  const user = from ? getUserRow(from.id) : undefined;
  if (!user || chat.type !== 'private') return;
  const say = (text: string, extra: Json = {}) => api(bot, 'sendMessage', { chat_id: chat.id, text, ...extra });

  // a payment made: the Премиум is already added, the bot only says so
  const paid = m.successful_payment as { invoice_payload?: string } | undefined;
  if (paid) {
    const days = daysOfPayload(String(paid.invoice_payload ?? ''));
    announcePremium(user.id);
    const until = untilText(user.id);
    if (days !== null && until) await say(txt.bots.premiumDone(until));
    return;
  }

  const text = typeof m.text === 'string' ? m.text.trim() : '';
  const cmd = /^\/([A-Za-z0-9_]+)/.exec(text)?.[1]?.toLowerCase();
  if (cmd === 'help') return void (await say(txt.bots.premiumPerks));
  if (cmd === 'start' || cmd === 'buy') {
    const { text: body, reply_markup } = menu(user);
    return void (await say(body, { reply_markup }));
  }
  await say(txt.bots.premiumUnknown);
}

async function onCallback(bot: BotRow, q: Json) {
  const from = q.from as { id: number };
  const message = q.message as { chat: { id: number } } | undefined;
  const user = getUserRow(from.id);
  const answer = (text?: string, alert = false) =>
    api(bot, 'answerCallbackQuery', { callback_query_id: q.id, ...(text ? { text, show_alert: alert } : {}) }).catch(() => {});
  const days = /^buy:(\d+)$/.exec(String(q.data ?? ''))?.[1];
  const plan = days ? tariff(Number(days)) : undefined;
  if (!user || !message || !plan) return void (await answer());

  if (isPremiumForever(user.premium_until)) return void (await answer(txt.bots.premiumForever, true));
  // one open invoice per person: a new choice replaces the old bill
  const open = db.prepare(`SELECT id FROM bot_invoices WHERE bot_id = ? AND user_id = ? AND status = 'pending'`).all(bot.user_id, user.id) as { id: number }[];
  for (const o of open) {
    try {
      cancelInvoice(bot, o.id);
    } catch {
      /* paid or cancelled a moment ago */
    }
  }
  try {
    await api(bot, 'sendInvoice', {
      chat_id: message.chat.id,
      title: txt.bots.premiumInvoiceTitle(plan.days),
      description: txt.bots.premiumInvoiceDescription,
      payload: payloadOf(plan.days),
      amount: plan.price,
      expires_in: INVOICE_TTL_SECONDS,
    });
    await answer(txt.bots.premiumInvoiceSent);
  } catch (e) {
    await answer(e instanceof BotApiError ? e.description.replace(/^[A-Za-z ]+: /, '') : String(e), true);
  }
}
