import type { AdminBotDTO, BotInfoDTO, BotSettingsDTO, InvoiceDTO, InvoicePayResult } from '@timba/shared';
import { adminBotPatchSchema, adminBotSettingsSchema, botCallbackSchema } from '@timba/shared';
import type { FastifyInstance } from 'fastify';
import { rateLimit, requireAdmin, requireAuth } from '../auth.js';
import { db } from '../db.js';
import { notFound } from '../errors.js';
import { requireView } from '../permissions.js';
import { type UserRow, getUserRow, userDTO } from '../serialize.js';
import { deleteBot, revokeToken } from '../bots/manage.js';
import { type BotRow, botCommands, botInfoDTO, botInfoOf, botMembers, getBot } from '../bots/store.js';
import { dropPoller, pressButton } from '../bots/updates.js';
import { botSettings, earnings, getInvoice, invoiceDTO, payInvoice, updateBotSettings, walletInfo, walletOf } from '../bots/wallet.js';
import { intParam, parse } from '../util.js';
import { txt } from '../strings.js';

/** What the app asks about bots: their profile and commands, a press of a button, and the admin's list. */
export default async function botRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/api/bots/:id', { preHandler: requireAuth }, async (req): Promise<BotInfoDTO> => {
    const info = botInfoOf(intParam(req.params.id));
    if (!info) throw notFound();
    return info;
  });

  /** The bots of a group: the «Меню» of the chat lists their commands. */
  app.get<{ Params: { id: string } }>('/api/chats/:id/bots', { preHandler: requireAuth }, async (req): Promise<BotInfoDTO[]> => {
    const chat = requireView(intParam(req.params.id), req.auth.user);
    return botMembers(chat.id).flatMap((b) => {
      const u = getUserRow(b.user_id);
      return u ? [botInfoDTO(b, u)] : [];
    });
  });

  /** A press of a button under a message: the bot gets a callback query, the answer comes as an event. */
  app.post<{ Params: { id: string } }>('/api/messages/:id/callback', { preHandler: requireAuth }, async (req) => {
    rateLimit(`callback:${req.auth.user.id}`, 40, 10_000);
    const { data } = parse(botCallbackSchema, req.body);
    return pressButton(req.auth.user, intParam(req.params.id), data);
  });

  // ---------- invoices of bots ----------

  /** The payer looks at an invoice before paying it. */
  app.get<{ Params: { id: string } }>('/api/invoices/:id', { preHandler: requireAuth }, async (req): Promise<InvoiceDTO> => {
    const inv = getInvoice(intParam(req.params.id));
    if (!inv || inv.user_id !== req.auth.user.id) throw notFound(txt.bots.invoiceNotFound);
    return invoiceDTO(inv);
  });

  app.post<{ Params: { id: string } }>('/api/invoices/:id/pay', { preHandler: requireAuth }, async (req): Promise<InvoicePayResult> => {
    rateLimit(`invoice:${req.auth.user.id}`, 20, 60_000);
    return payInvoice(req.auth.user, intParam(req.params.id));
  });

  // ---------- admin ----------

  const adminDTO = (bot: BotRow, user: UserRow): AdminBotDTO => ({
    user: userDTO(user, { self: true }),
    owner: bot.owner_id && getUserRow(bot.owner_id) ? userDTO(getUserRow(bot.owner_id)!, { self: true }) : null,
    builtin: bot.builtin,
    commands: botCommands(bot).length,
    canJoinGroups: !!bot.can_join_groups,
    createdAt: bot.created_at,
    pending: (db.prepare('SELECT COUNT(*) c FROM bot_updates WHERE bot_id = ?').get(bot.user_id) as { c: number }).c,
    webhook: !!bot.webhook_url,
    disabled: !!bot.disabled,
    paymentsEnabled: !!bot.payments_enabled,
    wallet: walletOf(bot),
    ownBalance: walletInfo(bot).ownBalance,
    paidInvoices: earnings(bot.user_id).paid,
    earned: earnings(bot.user_id).earned,
  });

  app.get('/api/admin/bots', { preHandler: requireAdmin }, async (): Promise<AdminBotDTO[]> => {
    const rows = db.prepare('SELECT * FROM bots ORDER BY builtin IS NULL, created_at DESC').all() as BotRow[];
    return rows.flatMap((b) => {
      const u = getUserRow(b.user_id);
      return u ? [adminDTO(b, u)] : [];
    });
  });

  app.get('/api/admin/bots/settings', { preHandler: requireAdmin }, async (): Promise<BotSettingsDTO> => botSettings());

  app.put('/api/admin/bots/settings', { preHandler: requireAdmin }, async (req): Promise<BotSettingsDTO> =>
    updateBotSettings(parse(adminBotSettingsSchema, req.body)),
  );

  /** Freeze a bot or switch its payments off. */
  app.patch<{ Params: { id: string } }>('/api/admin/bots/:id', { preHandler: requireAdmin }, async (req): Promise<AdminBotDTO> => {
    const bot = getBot(intParam(req.params.id));
    if (!bot || bot.builtin) throw notFound();
    const p = parse(adminBotPatchSchema, req.body);
    if (p.disabled !== undefined) db.prepare('UPDATE bots SET disabled = ? WHERE user_id = ?').run(p.disabled ? 1 : 0, bot.user_id);
    if (p.paymentsEnabled !== undefined) db.prepare('UPDATE bots SET payments_enabled = ? WHERE user_id = ?').run(p.paymentsEnabled ? 1 : 0, bot.user_id);
    if (p.disabled) dropPoller(bot.user_id);
    return adminDTO(getBot(bot.user_id)!, getUserRow(bot.user_id)!);
  });

  app.delete<{ Params: { id: string } }>('/api/admin/bots/:id', { preHandler: requireAdmin }, async (req) => {
    const bot = getBot(intParam(req.params.id));
    if (!bot) throw notFound();
    // the built-in bots are part of the messenger
    if (bot.builtin) throw notFound(txt.bots.builtinKept);
    deleteBot(bot);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/admin/bots/:id/revoke', { preHandler: requireAdmin }, async (req) => {
    const bot = getBot(intParam(req.params.id));
    if (!bot || bot.builtin) throw notFound();
    revokeToken(bot);
    return { ok: true };
  });
}
