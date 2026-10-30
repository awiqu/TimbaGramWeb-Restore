import {
  adminBankGiveSchema,
  adminBankPromoPatchSchema,
  adminBankPromoSchema,
  adminBankSettingsSchema,
  bankPromoSchema,
  bankTopupSchema,
  bankTransferSchema,
  casinoRouletteSchema,
  casinoSlotsSchema,
  redeemPromoSchema,
  type RouletteBet,
  BANK_TOPUP_PHONE,
} from '@timba/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin, requireAuth } from '../auth.js';
import {
  activatePromo,
  adminCreatePromo,
  adminDeletePromo,
  adminAccount,
  adminGive,
  adminOps,
  adminOverview,
  adminSetBanned,
  adminUpdatePromo,
  balanceOfUser,
  bankInfo,
  buyJoke,
  cashUser,
  createTopup,
  decideTopup,
  history,
  claimPremiumBonus,
  pendingTopups,
  transfer,
  updateBankSettings,
} from '../bank/bank.js';
import { badRequest, notFound } from '../errors.js';
import { displayName, getUserRow } from '../serialize.js';
import { getSettings } from '../settings.js';
import { spinRoulette, spinSlots } from '../bank/casino.js';
import { announcePremium, redeemPromo } from '../premium.js';
import { notify, topupDecided } from '../notifications.js';
import { rateLimit } from '../auth.js';
import { parse } from '../util.js';
import { txt } from '../strings.js';

export default async function bankRoutes(app: FastifyInstance) {
  // ---------- PupsoBank ----------
  app.get('/api/bank', { preHandler: requireAuth }, async (req) => bankInfo(req.auth.user));

  app.get<{ Querystring: { offset?: string } }>('/api/bank/history', { preHandler: requireAuth }, async (req) =>
    history(req.auth.user, Math.max(0, Number(req.query.offset) || 0)),
  );

  app.post('/api/bank/transfer', { preHandler: requireAuth }, async (req) => {
    const body = parse(bankTransferSchema, req.body);
    const to = getUserRow(body.userId);
    if (!to) throw notFound(txt.errors.userNotFound);
    // a bot is paid with invoices (sendInvoice), not with transfers
    if (to.is_bot) throw badRequest(txt.bots.noTransfers);
    const from = req.auth.user;
    const res = transfer(from, to, body.amount, body.message);
    notify('bank', to.id, txt.bank.received(body.amount, from.username, body.message, balanceOfUser(to)));
    return res;
  });

  app.post('/api/bank/promo', { preHandler: requireAuth }, async (req) => {
    rateLimit(`promo:${req.auth.user.id}`, 10, 60_000);
    return activatePromo(req.auth.user, parse(bankPromoSchema, req.body).code);
  });

  /** "I sent the money": the admin gets a check with buttons in the support notifications. */
  app.post('/api/bank/topup', { preHandler: requireAuth }, async (req) => {
    rateLimit(`topup:${req.auth.user.id}`, 10, 60 * 60_000);
    const { amount } = parse(bankTopupSchema, req.body);
    const u = req.auth.user;
    const topup = createTopup(u, amount);
    const text = getSettings().topupUrl
      ? txt.bank.topupCheckLink(displayName(u), u.username, amount)
      : txt.bank.topupCheck(displayName(u), u.username, amount, BANK_TOPUP_PHONE);
    notify('support', cashUser().id, text, topup.id);
    return { id: topup.id };
  });

  /** TimbaGram Premium: "Проверить оплату" sends the admin the same check as a top-up. */
  app.post('/api/premium/check', { preHandler: requireAuth }, async (req) => {
    rateLimit(`premium:${req.auth.user.id}`, 10, 60 * 60_000);
    const u = req.auth.user;
    const { premiumUrl, premiumPrice } = getSettings();
    const topup = createTopup(u, premiumPrice, 'premium');
    notify('support', cashUser().id, txt.premium.check(displayName(u), u.username, premiumPrice, premiumUrl ? null : BANK_TOPUP_PHONE), topup.id);
    return { id: topup.id };
  });

  /** TimbaGram Premium by a promo code from the admin. */
  app.post('/api/premium/redeem', { preHandler: requireAuth }, async (req) => {
    rateLimit(`promo:${req.auth.user.id}`, 10, 10 * 60_000);
    const premiumUntil = redeemPromo(req.auth.user.id, parse(redeemPromoSchema, req.body).code);
    announcePremium(req.auth.user.id);
    return { premiumUntil };
  });

  /** The weekly bonus of Премиум, taken by a button. */
  app.post('/api/premium/bonus', { preHandler: requireAuth }, async (req) => claimPremiumBonus(req.auth.user));

  // ---------- Казино (TimbaGram Premium) ----------
  app.post('/api/casino/slots', { preHandler: requireAuth }, async (req) => {
    rateLimit(`casino:${req.auth.user.id}`, 120, 60_000);
    return spinSlots(req.auth.user, parse(casinoSlotsSchema, req.body).amount);
  });

  app.post('/api/casino/roulette', { preHandler: requireAuth }, async (req) => {
    rateLimit(`casino:${req.auth.user.id}`, 120, 60_000);
    return spinRoulette(req.auth.user, parse(casinoRouletteSchema, req.body) as RouletteBet);
  });

  app.post('/api/bank/joke', { preHandler: requireAuth }, async (req) => buyJoke(req.auth.user));

  // ---------- admin ----------
  app.get('/api/admin/bank', { preHandler: requireAdmin }, async () => adminOverview());

  app.get<{ Params: { id: string } }>('/api/admin/bank/accounts/:id', { preHandler: requireAdmin }, async (req) =>
    adminAccount(Number(req.params.id)),
  );

  app.get<{ Querystring: { userId?: string; offset?: string } }>('/api/admin/bank/ops', { preHandler: requireAdmin }, async (req) =>
    adminOps(Number(req.query.userId) || null, Math.max(0, Number(req.query.offset) || 0)),
  );

  app.put('/api/admin/bank/settings', { preHandler: requireAdmin }, async (req) =>
    updateBankSettings(parse(adminBankSettingsSchema, req.body)),
  );

  app.post('/api/admin/bank/give', { preHandler: requireAdmin }, async (req) => {
    const { userId, amount, set, reason, notify: tell } = parse(adminBankGiveSchema, req.body);
    const res = adminGive(userId, amount, set, reason);
    if (tell && res.delta && res.user.id !== req.auth.user.id) {
      notify('bank', res.user.id, txt.bank.adminChange(res.delta, reason, res.balance, set));
    }
    return { balance: res.balance };
  });

  app.post<{ Params: { id: string } }>('/api/admin/bank/accounts/:id/ban', { preHandler: requireAdmin }, async (req) => {
    const { banned } = parse(z.object({ banned: z.boolean() }), req.body);
    adminSetBanned(Number(req.params.id), banned);
    return { ok: true };
  });

  app.get('/api/admin/bank/topups', { preHandler: requireAdmin }, async () => pendingTopups());

  app.post<{ Params: { id: string; action: string } }>(
    '/api/admin/bank/topups/:id/:action',
    { preHandler: requireAdmin },
    async (req) => {
      if (req.params.action !== 'approve' && req.params.action !== 'reject') throw notFound(txt.errors.notFound);
      const approve = req.params.action === 'approve';
      const { topup, user, balance } = decideTopup(Number(req.params.id), approve);
      // the check in the admin's notifications shows the decision
      topupDecided(topup.id);
      if (user && topup.kind === 'premium') {
        const fresh = getUserRow(user.id)!;
        notify('bank', fresh.id, approve ? txt.premium.approved(txt.premium.until(fresh.premium_until!)) : txt.premium.rejected(topup.amount));
        if (approve) announcePremium(user.id);
      } else if (user) {
        notify('bank', user.id, approve ? txt.bank.topupApproved(topup.amount, balance) : txt.bank.topupRejected(topup.amount));
      }
      return { status: topup.status };
    },
  );

  app.post('/api/admin/bank/promos', { preHandler: requireAdmin }, async (req) => {
    const { code, tcoins, maxUses } = parse(adminBankPromoSchema, req.body);
    adminCreatePromo(code, tcoins, maxUses);
    return { ok: true };
  });

  app.patch<{ Params: { code: string } }>('/api/admin/bank/promos/:code', { preHandler: requireAdmin }, async (req) => {
    adminUpdatePromo(req.params.code, parse(adminBankPromoPatchSchema, req.body));
    return { ok: true };
  });

  app.post<{ Params: { code: string } }>('/api/admin/bank/promos/:code/delete', { preHandler: requireAdmin }, async (req) => {
    adminDeletePromo(req.params.code);
    return { ok: true };
  });
}
