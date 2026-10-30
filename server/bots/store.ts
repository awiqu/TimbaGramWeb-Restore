import crypto from 'node:crypto';
import type { BotCommandDTO, BotInfoDTO } from '@timba/shared';
import { db } from '../db.js';
import { type UserRow, getUserRow } from '../serialize.js';

/** A bot's own settings (the bot itself is a row of "users" with is_bot = 1). */
export interface BotRow {
  user_id: number;
  /** who made it; null for the built-in ones */
  owner_id: number | null;
  /** 'premiumbot' / 'weatherbot': runs inside the server, has no token */
  builtin: string | null;
  token: string | null;
  description: string;
  /** JSON BotCommandDTO[] */
  commands: string;
  can_join_groups: number;
  privacy_mode: number;
  /** JSON string[]: the update kinds the bot wants; null = the default set */
  allowed_updates: string | null;
  webhook_url: string | null;
  webhook_secret: string | null;
  webhook_error: string | null;
  webhook_error_at: number | null;
  /** 1: the owner's balance is the bot's till (otherwise the bot has its own account) */
  wallet_owner: number;
  /** the admin lets the bot send invoices and pay out */
  payments_enabled: number;
  /** the admin froze the bot */
  disabled: number;
  created_at: number;
}

export const getBot = (userId: number) => db.prepare('SELECT * FROM bots WHERE user_id = ?').get(userId) as BotRow | undefined;

export const getBotByUsername = (username: string) =>
  db.prepare('SELECT b.* FROM bots b JOIN users u ON u.id = b.user_id WHERE u.username = ?').get(username) as BotRow | undefined;

export const getBuiltinBot = (kind: string) => db.prepare('SELECT * FROM bots WHERE builtin = ?').get(kind) as BotRow | undefined;

/** A token looks like `123456:AAH-xyz…`: the bot's id, a colon and a secret. */
const TOKEN_RE = /^(\d{1,12}):([A-Za-z0-9_-]{20,64})$/;

export const newToken = (botUserId: number) => `${botUserId}:${crypto.randomBytes(24).toString('base64url')}`;

export function getBotByToken(token: string): BotRow | undefined {
  const m = TOKEN_RE.exec(token);
  if (!m) return undefined;
  const bot = getBot(Number(m[1]));
  if (!bot?.token) return undefined;
  const a = Buffer.from(bot.token);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? bot : undefined;
}

export function botCommands(bot: Pick<BotRow, 'commands'>): BotCommandDTO[] {
  try {
    const list = JSON.parse(bot.commands) as BotCommandDTO[];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function botInfoDTO(bot: BotRow, user: UserRow): BotInfoDTO {
  return {
    userId: user.id,
    description: bot.description,
    about: user.bio,
    commands: botCommands(bot),
    canJoinGroups: !!bot.can_join_groups,
    privacyMode: !!bot.privacy_mode,
    builtin: !!bot.builtin,
  };
}

export function botInfoOf(userId: number): BotInfoDTO | null {
  const bot = getBot(userId);
  const user = bot ? getUserRow(userId) : undefined;
  return bot && user ? botInfoDTO(bot, user) : null;
}

/** The bots a user made, oldest first. */
export function ownBots(ownerId: number): { bot: BotRow; user: UserRow }[] {
  const rows = db.prepare('SELECT * FROM bots WHERE owner_id = ? ORDER BY created_at, user_id').all(ownerId) as BotRow[];
  return rows.flatMap((bot) => {
    const user = getUserRow(bot.user_id);
    return user ? [{ bot, user }] : [];
  });
}

/** Bots that are members of a chat. */
export function botMembers(chatId: number): (BotRow & { role: string })[] {
  return db
    .prepare(
      `SELECT b.*, m.role FROM bots b JOIN chat_members m ON m.user_id = b.user_id WHERE m.chat_id = ?
       ORDER BY b.user_id`,
    )
    .all(chatId) as (BotRow & { role: string })[];
}

/** The update kinds a bot gets when it asked for none in particular: Telegram leaves these out, too. */
export const DEFAULT_UPDATES = [
  'message',
  'edited_message',
  'channel_post',
  'edited_channel_post',
  'callback_query',
  'poll',
  'poll_answer',
  'my_chat_member',
] as const;

export const ALL_UPDATES = [...DEFAULT_UPDATES, 'message_reaction', 'chat_member'] as const;
export type UpdateKind = (typeof ALL_UPDATES)[number];

export function wantsUpdate(bot: BotRow, kind: UpdateKind): boolean {
  if (bot.disabled) return false;
  if (!bot.allowed_updates) return (DEFAULT_UPDATES as readonly string[]).includes(kind);
  try {
    return (JSON.parse(bot.allowed_updates) as string[]).includes(kind);
  } catch {
    return (DEFAULT_UPDATES as readonly string[]).includes(kind);
  }
}
