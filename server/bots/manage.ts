import fs from 'node:fs';
import {
  ADMIN_USERNAME,
  BOT_ABOUT_MAX,
  BOT_COMMANDS_MAX,
  BOT_COMMAND_DESC_MAX,
  BOT_COMMAND_DESC_MIN,
  BOT_COMMAND_RE,
  BOT_DESCRIPTION_MAX,
  BOT_NAME_MAX,
  EV,
  PREMIUMBOT_USERNAME,
  WEATHERBOT_USERNAME,
  USERNAME_RE,
  isBotUsername,
  type BotCommandDTO,
  type BotUsernameCheck,
} from '@timba/shared';
import sharp from 'sharp';
import { payForBot } from '../bank/bank.js';
import { db, now } from '../db.js';
import { HttpError, badRequest, conflict } from '../errors.js';
import { toAll, toChat } from '../realtime.js';
import { type UserRow, getUserRow, userDTO } from '../serialize.js';
import { broadcastChat, deleteChat, isUsernameTaken, removeMember } from '../services/chats.js';
import { newUploadPath, registerFile } from '../services/files.js';
import { txt } from '../strings.js';
import { dropPoller } from './updates.js';
import { type BotRow, getBot, getBuiltinBot, newToken } from './store.js';
import { botSettings, withdraw } from './wallet.js';

/** Making, changing and deleting bots (what a person does in Settings → Расширенные настройки → Боты, and what the admin panel may do). */

const notBot = (code: string, message = code) => new HttpError(400, code, message);

/**
 * Create a bot owned by `owner`: ТК are paid (the admin sets the price), the account and the token are made.
 * Errors carry a `code` the caller can tell apart: name_invalid, username_invalid, username_not_bot,
 * username_taken, bot_limit, insufficient_funds.
 */
export function createBot(owner: UserRow, name: string, username: string): { bot: BotRow; user: UserRow; token: string; price: number } {
  const title = name.trim();
  if (!title || title.length > BOT_NAME_MAX) throw notBot('name_invalid', txt.bots.nameBad);
  if (!USERNAME_RE.test(username)) throw notBot('username_invalid', txt.bots.usernameBad);
  if (!isBotUsername(username)) throw notBot('username_not_bot', txt.bots.usernameNoBot);
  if (username.toLowerCase() === ADMIN_USERNAME || isUsernameTaken(username)) throw conflict(txt.errors.usernameTaken, 'username_taken');
  const settings = botSettings();
  if (!settings.createEnabled) throw notBot('creation_off', txt.bots.creationOff);
  const owned = (db.prepare('SELECT COUNT(*) c FROM bots WHERE owner_id = ?').get(owner.id) as { c: number }).c;
  if (owned >= settings.maxPerUser) throw notBot('bot_limit', txt.bots.botLimit(settings.maxPerUser));

  const t = now();
  let price = 0;
  const id = db.transaction(() => {
    price = payForBot(owner, txt.bots.payMessage(username));
    // the password hash is not one: nobody can sign in as a bot, it works through its token
    const res = db
      .prepare(`INSERT INTO users (username, first_name, password_hash, created_at, is_bot) VALUES (?, ?, '!', ?, 1)`)
      .run(username, title, t);
    const uid = Number(res.lastInsertRowid);
    db.prepare('INSERT INTO bots (user_id, owner_id, token, created_at) VALUES (?, ?, ?, ?)').run(uid, owner.id, newToken(uid), t);
    return uid;
  })();
  const bot = getBot(id)!;
  return { bot, user: getUserRow(id)!, token: bot.token!, price };
}

/** The bot is gone for good: its token stops working, private chats with it disappear, it leaves every group. */
export function deleteBot(bot: BotRow) {
  const user = getUserRow(bot.user_id);
  if (!user) return;
  dropPoller(bot.user_id);
  // what is in the bot's own till goes to the owner (the price of creation does not come back, the earnings do)
  const owner = bot.owner_id ? getUserRow(bot.owner_id) : undefined;
  if (owner) {
    try {
      withdraw(bot, owner);
    } catch {
      /* nothing there */
    }
  }
  const privateIds = (
    db
      .prepare(`SELECT c.id FROM chats c JOIN chat_members m ON m.chat_id = c.id WHERE m.user_id = ? AND c.type = 'private'`)
      .all(user.id) as { id: number }[]
  ).map((r) => r.id);
  for (const id of privateIds) deleteChat(id);
  const groups = (
    db.prepare(`SELECT chat_id FROM chat_members WHERE user_id = ?`).all(user.id) as { chat_id: number }[]
  ).map((r) => r.chat_id);
  for (const chatId of groups) removeMember(chatId, user.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
  for (const chatId of groups) {
    toChat(chatId, EV.membersChanged, { chatId });
    broadcastChat(chatId);
  }
}

/** Everybody sees the new name, picture or commands. */
export function announceBot(userId: number) {
  const u = getUserRow(userId);
  if (!u) return;
  toAll(EV.userUpdate, userDTO(u));
  toAll(EV.botUpdate, { userId });
}

/** Can this username be a bot's? (`exceptUserId`: the bot that already has it) */
export function checkBotUsername(username: string, exceptUserId?: number): BotUsernameCheck {
  if (!USERNAME_RE.test(username)) return 'invalid';
  if (!isBotUsername(username)) return 'not_bot';
  if (username.toLowerCase() === ADMIN_USERNAME || isUsernameTaken(username, undefined, exceptUserId)) return 'taken';
  return 'ok';
}

export function setBotUsername(bot: BotRow, username: string) {
  const r = checkBotUsername(username, bot.user_id);
  if (r === 'invalid') throw badRequest(txt.bots.usernameBad, 'username_invalid');
  if (r === 'not_bot') throw badRequest(txt.bots.usernameNoBot, 'username_not_bot');
  if (r === 'taken') throw conflict(txt.errors.usernameTaken, 'username_taken');
  db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, bot.user_id);
  announceBot(bot.user_id);
}

export function setBotName(bot: BotRow, name: string) {
  const n = name.trim();
  if (!n || n.length > BOT_NAME_MAX) throw badRequest(txt.bots.nameBad);
  db.prepare('UPDATE users SET first_name = ? WHERE id = ?').run(n, bot.user_id);
  announceBot(bot.user_id);
}

export function setBotDescription(bot: BotRow, text: string) {
  db.prepare('UPDATE bots SET description = ? WHERE user_id = ?').run(text.trim().slice(0, BOT_DESCRIPTION_MAX), bot.user_id);
  announceBot(bot.user_id);
}

/** «О боте»: the short line in the profile (it is the bio of the bot's account). */
export function setBotAbout(bot: BotRow, text: string) {
  db.prepare('UPDATE users SET bio = ? WHERE id = ?').run(text.trim().slice(0, BOT_ABOUT_MAX), bot.user_id);
  announceBot(bot.user_id);
}

export function setBotAvatar(bot: BotRow, fileId: string | null) {
  db.prepare('UPDATE users SET avatar_file_id = ? WHERE id = ?').run(fileId, bot.user_id);
  announceBot(bot.user_id);
}

export function setBotCommands(bot: BotRow, commands: BotCommandDTO[]) {
  db.prepare('UPDATE bots SET commands = ? WHERE user_id = ?').run(JSON.stringify(commands), bot.user_id);
  announceBot(bot.user_id);
}

export function setBotPrivacy(bot: BotRow, privacyMode: boolean) {
  db.prepare('UPDATE bots SET privacy_mode = ? WHERE user_id = ?').run(privacyMode ? 1 : 0, bot.user_id);
  announceBot(bot.user_id);
}

export function setBotJoinGroups(bot: BotRow, can: boolean) {
  db.prepare('UPDATE bots SET can_join_groups = ? WHERE user_id = ?').run(can ? 1 : 0, bot.user_id);
  announceBot(bot.user_id);
}

/** A new token: the old one stops working at once. */
export function revokeToken(bot: BotRow): string {
  const token = newToken(bot.user_id);
  db.prepare('UPDATE bots SET token = ? WHERE user_id = ?').run(token, bot.user_id);
  dropPoller(bot.user_id);
  return token;
}

// ---------- commands ----------

export type CommandsError = 'format' | 'name' | 'description' | 'tooMany' | 'duplicate';

/** One command of the Bot API's BotCommand: a name in lower case without "/" and a description. */
export function checkCommand(rawName: unknown, rawDescription: unknown): BotCommandDTO | CommandsError {
  const command = String(rawName ?? '').trim().replace(/^\//, '').toLowerCase();
  const description = String(rawDescription ?? '').trim();
  if (!BOT_COMMAND_RE.test(command)) return 'name';
  if (description.length < BOT_COMMAND_DESC_MIN || description.length > BOT_COMMAND_DESC_MAX) return 'description';
  return { command, description };
}

export function checkCommands(list: { command: unknown; description: unknown }[]): BotCommandDTO[] | CommandsError {
  if (list.length > BOT_COMMANDS_MAX) return 'tooMany';
  const out: BotCommandDTO[] = [];
  for (const c of list) {
    const r = checkCommand(c.command, c.description);
    if (typeof r === 'string') return r;
    if (out.some((x) => x.command === r.command)) return 'duplicate';
    out.push(r);
  }
  return out;
}

/** A list of commands written as text: a command, a dash and a description on every line. */
export function parseCommandLines(text: string): { commands: BotCommandDTO[] } | { line: string; why: CommandsError } {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const list: { command: string; description: string; line: string }[] = [];
  for (const line of lines) {
    const m = /^\/?([^\s\-–—]+)\s*[-–—]\s*(.+)$/.exec(line);
    if (!m) return { line, why: 'format' };
    list.push({ command: m[1]!, description: m[2]!, line });
  }
  if (list.length > BOT_COMMANDS_MAX) return { line: '', why: 'tooMany' };
  const seen = new Set<string>();
  for (const c of list) {
    const r = checkCommand(c.command, c.description);
    if (typeof r === 'string') return { line: c.line, why: r };
    if (seen.has(r.command)) return { line: c.line, why: 'duplicate' };
    seen.add(r.command);
  }
  return { commands: list.map((c) => checkCommand(c.command, c.description) as BotCommandDTO) };
}

// ---------- the built-in bots ----------

const AVATARS: Record<string, string> = {
  weatherbot: `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
    <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#57b8ff"/><stop offset="1" stop-color="#2b7bd8"/></linearGradient></defs>
    <rect width="512" height="512" fill="url(#g)"/>
    <g stroke="#ffd84d" stroke-width="16" stroke-linecap="round"><line x1="190" y1="70" x2="190" y2="96"/><line x1="94" y1="166" x2="120" y2="166"/><line x1="122" y1="98" x2="140" y2="116"/><line x1="258" y1="98" x2="240" y2="116"/></g>
    <circle cx="190" cy="166" r="52" fill="#ffd84d"/>
    <path d="M150 400 a62 62 0 0 1 8-124 a84 84 0 0 1 160 -6 a60 60 0 0 1 22 130 z" fill="#fff"/></svg>`,
  premiumbot: `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffc24d"/><stop offset="1" stop-color="#ff7a1a"/></linearGradient></defs>
    <rect width="512" height="512" fill="url(#g)"/>
    <path d="M256 78 L300 196 L426 204 L328 284 L360 408 L256 340 L152 408 L184 284 L86 204 L212 196 Z" fill="#fff"/></svg>`,
};

async function makeAvatar(user: UserRow, kind: string) {
  const dest = newUploadPath('avatar.png');
  await sharp(Buffer.from(AVATARS[kind]!)).png().toFile(dest.abs);
  const row = await registerFile(
    user,
    { id: dest.id, rel: dest.rel, abs: dest.abs, month: dest.month, ext: dest.ext, name: 'avatar.png', mime: 'image/png', size: fs.statSync(dest.abs).size },
    {},
  );
  db.prepare('UPDATE users SET avatar_file_id = ? WHERE id = ?').run(row.id, user.id);
}

interface BuiltinSpec {
  kind: 'premiumbot' | 'weatherbot';
  username: string;
  name: () => string;
  about: () => string;
  description: () => string;
  commands: () => string;
  canJoinGroups: boolean;
}

const BUILTIN: BuiltinSpec[] = [
  {
    kind: 'premiumbot',
    username: PREMIUMBOT_USERNAME,
    name: () => txt.bots.premiumbotName,
    about: () => txt.bots.premiumbotAbout,
    description: () => txt.bots.premiumbotDescription,
    commands: () => txt.bots.premiumbotCommands,
    canJoinGroups: false,
  },
  {
    kind: 'weatherbot',
    username: WEATHERBOT_USERNAME,
    name: () => txt.bots.weather.name,
    about: () => txt.bots.weather.about,
    description: () => txt.bots.weather.description,
    commands: () => txt.bots.weather.commands,
    canJoinGroups: true,
  },
];

/**
 * @PremiumBot and @WeatherBot exist from the first start. Their texts are taken from the server's strings (so the
 * admin's replacements apply after a restart). A person who already registered such a name keeps it: the
 * bot is not made, and the log says why.
 */
export async function seedBuiltinBots() {
  // a built-in bot that no longer exists (@BotFather was replaced by the manager in Settings) goes away with its chats
  for (const old of db.prepare('SELECT * FROM bots WHERE builtin IS NOT NULL').all() as BotRow[]) {
    if (!BUILTIN.some((b) => b.kind === old.builtin)) deleteBot(old);
  }
  for (const spec of BUILTIN) {
    let bot = getBuiltinBot(spec.kind);
    if (!bot) {
      if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(spec.username)) {
        console.warn(`  ⚠ Имя @${spec.username} занято обычным аккаунтом — встроенный бот не создан. Освободите имя и перезапустите сервер.`);
        continue;
      }
      db.transaction(() => {
        const res = db
          .prepare(`INSERT INTO users (username, first_name, password_hash, created_at, is_bot) VALUES (?, ?, '!', ?, 1)`)
          .run(spec.username, spec.name(), now());
        db.prepare('INSERT INTO bots (user_id, builtin, created_at) VALUES (?, ?, ?)').run(Number(res.lastInsertRowid), spec.kind, now());
      })();
      bot = getBuiltinBot(spec.kind)!;
    }
    const commands = parseCommandLines(spec.commands());
    db.prepare('UPDATE users SET first_name = ?, bio = ? WHERE id = ?').run(spec.name(), spec.about(), bot.user_id);
    db.prepare('UPDATE bots SET description = ?, commands = ?, can_join_groups = ? WHERE user_id = ?').run(
      spec.description(),
      JSON.stringify('commands' in commands ? commands.commands : []),
      spec.canJoinGroups ? 1 : 0,
      bot.user_id,
    );
    const user = getUserRow(bot.user_id)!;
    if (!user.avatar_file_id) await makeAvatar(user, spec.kind);
  }
}
