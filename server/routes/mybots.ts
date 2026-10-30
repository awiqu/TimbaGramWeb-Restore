import {
  BOT_ABOUT_MAX,
  BOT_DESCRIPTION_MAX,
  BOT_NAME_MAX,
  botWithdrawSchema,
  createBotSchema,
  myBotPatchSchema,
  type BotLedgerItem,
  type BotUsernameCheck,
  type MyBotDTO,
  type MyBotDetailDTO,
  type MyBotsDTO,
} from '@timba/shared';
import type { FastifyInstance } from 'fastify';
import { isAdmin, rateLimit, requireAuth } from '../auth.js';
import { balanceOfUser, bankSettings, ensureAccount } from '../bank/bank.js';
import { db } from '../db.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { type UserRow, getUserRow, userDTO } from '../serialize.js';
import { requireOwnPhoto } from '../services/files.js';
import { txt } from '../strings.js';
import { intParam, parse } from '../util.js';
import {
  checkBotUsername,
  checkCommands,
  createBot,
  deleteBot,
  revokeToken,
  setBotAbout,
  setBotAvatar,
  setBotCommands,
  setBotDescription,
  setBotJoinGroups,
  setBotName,
  setBotPrivacy,
  setBotUsername,
} from '../bots/manage.js';
import { type BotRow, botCommands, getBot, ownBots } from '../bots/store.js';
import { botSettings, earnings, setWalletMode, transactionsOf, walletInfo, walletOf, withdraw } from '../bots/wallet.js';

/**
 * The bot manager (Settings → Расширенные настройки → Боты, and the admin panel): a person makes, sets up and
 * deletes their bots here. The owner and the admin may open a bot; the built-in ones cannot be changed.
 */
export default async function myBotRoutes(app: FastifyInstance) {
  const dto = (bot: BotRow, user: UserRow): MyBotDTO => {
    const w = walletInfo(bot);
    const e = earnings(bot.user_id);
    const owner = bot.owner_id ? getUserRow(bot.owner_id) : undefined;
    return {
      user: userDTO(user, { self: true }),
      owner: owner ? userDTO(owner, { self: true }) : null,
      builtin: bot.builtin,
      description: bot.description,
      about: user.bio,
      commands: botCommands(bot),
      canJoinGroups: !!bot.can_join_groups,
      privacyMode: !!bot.privacy_mode,
      wallet: walletOf(bot),
      walletBalance: w.balance,
      ownBalance: w.ownBalance,
      paidInvoices: e.paid,
      earned: e.earned,
      paymentsEnabled: !!bot.payments_enabled,
      disabled: !!bot.disabled,
      createdAt: bot.created_at,
    };
  };

  const detail = (bot: BotRow, user: UserRow): MyBotDetailDTO => ({
    ...dto(bot, user),
    token: bot.token,
    webhook: !!bot.webhook_url,
    pending: (db.prepare('SELECT COUNT(*) c FROM bot_updates WHERE bot_id = ?').get(bot.user_id) as { c: number }).c,
  });

  /** A bot of the caller (or any, for the admin); the built-in ones are read-only. */
  function mine(me: UserRow, rawId: string, opts: { write?: boolean } = {}): { bot: BotRow; user: UserRow } {
    const bot = getBot(intParam(rawId));
    const user = bot ? getUserRow(bot.user_id) : undefined;
    if (!bot || !user) throw notFound();
    if (bot.owner_id !== me.id && !isAdmin(me)) throw forbidden(txt.bots.botNotYours);
    if (bot.builtin && (opts.write !== false)) throw forbidden(txt.bots.botBuiltinReadonly);
    return { bot, user };
  }

  app.get('/api/mybots', { preHandler: requireAuth }, async (req): Promise<MyBotsDTO> => {
    const s = botSettings();
    return {
      bots: ownBots(req.auth.user.id).map((b) => dto(b.bot, b.user)),
      price: bankSettings().botPrice,
      max: s.maxPerUser,
      createEnabled: s.createEnabled,
    };
  });

  app.get<{ Querystring: { username?: string } }>('/api/mybots/check', { preHandler: requireAuth }, async (req): Promise<{ result: BotUsernameCheck }> => {
    rateLimit(`botcheck:${req.auth.user.id}`, 60, 60_000);
    return { result: checkBotUsername(String(req.query.username ?? '').trim().replace(/^@/, '')) };
  });

  app.post('/api/mybots', { preHandler: requireAuth }, async (req): Promise<{ bot: MyBotDetailDTO; price: number; balance: number }> => {
    const me = req.auth.user;
    rateLimit(`botcreate:${me.id}`, 10, 60_000);
    const body = parse(createBotSchema, req.body);
    ensureAccount(me);
    const made = createBot(me, body.name, body.username.replace(/^@/, ''));
    const row = getBot(made.user.id)!;
    return { bot: detail(row, getUserRow(row.user_id)!), price: made.price, balance: balanceOfUser(me) };
  });

  app.get<{ Params: { id: string } }>('/api/mybots/:id', { preHandler: requireAuth }, async (req): Promise<MyBotDetailDTO> => {
    const { bot, user } = mine(req.auth.user, req.params.id, { write: false });
    return detail(bot, user);
  });

  app.patch<{ Params: { id: string } }>('/api/mybots/:id', { preHandler: requireAuth }, async (req): Promise<MyBotDetailDTO> => {
    const me = req.auth.user;
    const { bot, user } = mine(me, req.params.id);
    const p = parse(myBotPatchSchema, req.body);
    if (p.name !== undefined) {
      if (p.name.length > BOT_NAME_MAX) throw badRequest(txt.bots.nameBad);
      setBotName(bot, p.name);
    }
    if (p.username !== undefined && p.username.replace(/^@/, '') !== user.username) {
      rateLimit(`botusername:${me.id}`, 5, 60_000);
      setBotUsername(bot, p.username.replace(/^@/, ''));
    }
    if (p.description !== undefined) {
      if (p.description.length > BOT_DESCRIPTION_MAX) throw badRequest(txt.bots.descriptionTooLong(BOT_DESCRIPTION_MAX));
      setBotDescription(bot, p.description);
    }
    if (p.about !== undefined) {
      if (p.about.length > BOT_ABOUT_MAX) throw badRequest(txt.bots.aboutTooLong(BOT_ABOUT_MAX));
      setBotAbout(bot, p.about);
    }
    if (p.commands !== undefined) {
      const checked = checkCommands(p.commands);
      if (typeof checked === 'string') {
        const why = {
          format: txt.bots.commandsWhyFormat,
          name: txt.bots.commandsWhyName,
          description: txt.bots.commandsWhyDescription,
          tooMany: txt.bots.commandsWhyTooMany,
          duplicate: txt.bots.commandsWhyDuplicate,
        }[checked];
        throw badRequest(why);
      }
      setBotCommands(bot, checked);
    }
    if (p.canJoinGroups !== undefined) setBotJoinGroups(bot, p.canJoinGroups);
    if (p.privacyMode !== undefined) setBotPrivacy(bot, p.privacyMode);
    if (p.wallet !== undefined) {
      if (bot.owner_id !== me.id) throw forbidden(txt.bots.walletOwnerOnly);
      setWalletMode(bot, p.wallet);
    }
    if (p.avatarFileId !== undefined) {
      if (p.avatarFileId) requireOwnPhoto(p.avatarFileId, me);
      setBotAvatar(bot, p.avatarFileId);
    }
    return detail(getBot(bot.user_id)!, getUserRow(bot.user_id)!);
  });

  app.post<{ Params: { id: string } }>('/api/mybots/:id/revoke', { preHandler: requireAuth }, async (req): Promise<MyBotDetailDTO> => {
    const { bot } = mine(req.auth.user, req.params.id);
    revokeToken(bot);
    return detail(getBot(bot.user_id)!, getUserRow(bot.user_id)!);
  });

  /** What is in the bot's own account goes to the owner's balance. */
  app.post<{ Params: { id: string } }>('/api/mybots/:id/withdraw', { preHandler: requireAuth }, async (req): Promise<{ withdrawn: number; bot: MyBotDetailDTO }> => {
    const me = req.auth.user;
    const { bot } = mine(me, req.params.id);
    const owner = bot.owner_id ? getUserRow(bot.owner_id) : undefined;
    if (!owner) throw forbidden(txt.bots.walletOwnerOnly);
    if (owner.id !== me.id) throw forbidden(txt.bots.walletOwnerOnly);
    const { amount } = parse(botWithdrawSchema, req.body ?? {});
    const withdrawn = withdraw(bot, owner, amount);
    return { withdrawn, bot: detail(getBot(bot.user_id)!, getUserRow(bot.user_id)!) };
  });

  app.get<{ Params: { id: string }; Querystring: { offset?: string } }>('/api/mybots/:id/ledger', { preHandler: requireAuth }, async (req) => {
    const { bot } = mine(req.auth.user, req.params.id, { write: false });
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const rows = transactionsOf(bot, offset, 31);
    const items: BotLedgerItem[] = rows.slice(0, 30).map((r) => ({
      id: r.id,
      type: r.type,
      amount: r.amount,
      createdAt: r.date,
      user: r.user ? userDTO(r.user) : null,
      message: r.message,
    }));
    return { items, hasMore: rows.length > 30 };
  });

  app.delete<{ Params: { id: string } }>('/api/mybots/:id', { preHandler: requireAuth }, async (req) => {
    const { bot } = mine(req.auth.user, req.params.id);
    deleteBot(bot);
    return { ok: true };
  });
}
