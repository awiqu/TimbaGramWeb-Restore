import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db } from '../db.js';
import { getChat, getMember } from '../permissions.js';
import { getUserRow } from '../serialize.js';
import { addMember, getOrCreatePrivate } from '../services/chats.js';
import { getBuiltinBot } from './store.js';
import { type ChatCfg, fullName, getCfg, newCfg, parseTime, saveCfg } from './weatherbot.js';
import { ARKHANGELSK } from './weather/data.js';
import { DEFAULT_FIELDS, FIELDS, LEVELS } from './weather/render.js';

/**
 * Takes over the subscribers of the old, external weather bot (its `weather_data.json`): who gets the forecast, at what
 * time, how detailed, which figures. The keys are the Bot API's chat ids, the same ones the built-in bot uses: a person's
 * id for a private chat, minus the group's id for a group.
 *
 * Every chat is checked against this messenger first: a person must exist (if the name differs, the chat is taken
 * and the difference is reported: a forecast to the wrong person does no harm), a group must exist and have the same
 * title (a message in the wrong group would). Chats the bot already knows are left as they are. The bot gets a private chat with the person and a place in the group,
 * as if they had pressed «Start» or added it.
 */

export interface ImportResult {
  imported: string[];
  skipped: { key: string; why: string }[];
  /** taken, but worth a look */
  warnings: { key: string; text: string }[];
}

const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();

/** The settings of the file, made safe: a bad value becomes the default one. */
function readSettings(raw: Record<string, unknown>): Pick<ChatCfg, 'enabled' | 'time' | 'level' | 'fields' | 'lastSent'> {
  const fields = { ...DEFAULT_FIELDS };
  if (raw.fields && typeof raw.fields === 'object') {
    for (const [k, v] of Object.entries(raw.fields as Record<string, unknown>)) if (k in FIELDS && typeof v === 'boolean') fields[k] = v;
  }
  const level = Number(raw.level);
  return {
    enabled: raw.enabled !== false,
    time: parseTime(typeof raw.time === 'string' ? raw.time : undefined) ?? '08:00',
    level: LEVELS[level] ? level : 2,
    fields,
    lastSent: typeof raw.last_sent === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.last_sent) ? raw.last_sent : null,
  };
}

export function importWeatherData(data: unknown): ImportResult {
  const result: ImportResult = { imported: [], skipped: [], warnings: [] };
  const bot = getBuiltinBot('weatherbot');
  const botUser = bot ? getUserRow(bot.user_id) : undefined;
  const chats = (data as { chats?: Record<string, Record<string, unknown>> } | null)?.chats;
  if (!bot || !botUser || !chats || typeof chats !== 'object') return result;

  for (const [rawKey, raw] of Object.entries(chats)) {
    const skip = (why: string) => void result.skipped.push({ key: rawKey, why });
    const key = Number(rawKey);
    if (!Number.isInteger(key) || key === 0 || !raw || typeof raw !== 'object') {
      skip('неверный ключ');
      continue;
    }
    if (getCfg(key)) {
      skip('бот уже знает этот чат');
      continue;
    }
    const settings = readSettings(raw);
    const title = typeof raw.title === 'string' ? raw.title : null;

    if (key > 0) {
      const user = getUserRow(key);
      if (!user || user.is_bot || user.is_banned) {
        skip('такого пользователя нет');
        continue;
      }
      if (title && !same(title, fullName(user)) && !same(title, user.username)) {
        result.warnings.push({ key: rawKey, text: `имя в файле «${title}», у пользователя «${fullName(user)}»` });
      }
      db.transaction(() => {
        getOrCreatePrivate(user, botUser);
        saveCfg({ ...newCfg(key, 'private', fullName(user)), city: ARKHANGELSK, ...settings });
      })();
      result.imported.push(rawKey);
      continue;
    }

    const chat = getChat(-key);
    if (!chat || chat.type !== 'group') {
      skip('такой группы нет');
      continue;
    }
    if (title && !same(title, chat.title)) {
      skip(`название не совпадает: «${title}» и «${chat.title}»`);
      continue;
    }
    const managerId = typeof raw.manager_id === 'number' ? raw.manager_id : null;
    const manager = managerId && getMember(chat.id, managerId) ? getUserRow(managerId) : undefined;
    db.transaction(() => {
      if (!getMember(chat.id, bot.user_id)) addMember(chat.id, bot.user_id);
      saveCfg({ ...newCfg(key, 'group', chat.title, manager), city: ARKHANGELSK, ...settings });
    })();
    result.imported.push(rawKey);
  }
  return result;
}

/** The file shipped with the server (server/seed/weather_data.json). */
const SEED_FILE = fileURLToPath(new URL('../../seed/weather_data.json', import.meta.url));

/**
 * Imports the file once (a mark in app_settings): what people changed afterwards, or a person who blocked the bot, is
 * not brought back by the next start. Tests do not import the shipped file; a file may be passed on purpose.
 */
export function importWeatherSeed(file?: string): ImportResult | null {
  if (!file && process.env.NODE_ENV === 'test') return null;
  const path = file ?? SEED_FILE;
  if (db.prepare(`SELECT 1 FROM app_settings WHERE key = 'weather_import'`).get() || !fs.existsSync(path)) return null;
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (e) {
    console.warn('  ⚠ weather_data.json не прочитан:', e instanceof Error ? e.message : e);
    return null;
  }
  const result = importWeatherData(data);
  db.prepare(`INSERT INTO app_settings (key, value) VALUES ('weather_import', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
    JSON.stringify({ at: Date.now(), imported: result.imported, skipped: result.skipped, warnings: result.warnings }),
  );
  const notes = [
    result.skipped.length ? `пропущено — ${result.skipped.map((s) => `${s.key} (${s.why})`).join('; ')}` : '',
    result.warnings.length ? `обратите внимание — ${result.warnings.map((s) => `${s.key} (${s.text})`).join('; ')}` : '',
  ].filter(Boolean);
  console.log(`  Погода: перенесено чатов — ${result.imported.length}${notes.length ? `, ${notes.join(', ')}` : ''}`);
  return result;
}
