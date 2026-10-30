import { config } from '../config.js';
import { db } from '../db.js';
import { type UserRow, getUserRow } from '../serialize.js';
import { txt } from '../strings.js';
import { callBotMethod } from './api.js';
import type { BuiltinUpdate } from './builtin.js';
import { BotApiError } from './errors.js';
import { clearState, getState, setState } from './state.js';
import { type BotRow, getBuiltinBot } from './store.js';
import { type City, cityById, findCities, placeOf } from './weather/cities.js';
import { type Place, WeatherError, deps, localTime } from './weather/data.js';
import { DEFAULT_FIELDS, FIELDS, LEVELS, type View, escapeHtml, renderView } from './weather/render.js';

/**
 * @WeatherBot («Погода»): the weather of the city a chat has chosen (MET Norway, with Open-Meteo as the spare). Commands
 * show today, tomorrow, the week or a detailed day; once a day it sends the forecast to everybody who wrote to it
 * and to the groups it was added to. Every chat sets its own city (found by name), time (of that city), level of
 * detail and figures; a group is set up by the person who added the bot.
 */

type Json = Record<string, unknown>;
const api = (bot: BotRow, method: string, params: Json) => callBotMethod(bot, method, params, new Map(), config.publicUrl ?? '');

const DEFAULT_TIME = '08:00';
/** a bot that was off at the time of the mailing catches up with it for 3 hours */
const CATCHUP_MINUTES = 180;
const GROUP_TYPES = ['group', 'supergroup'];
const COMMAND_VIEWS: Record<string, View> = { weather: 'today', today: 'today', tomorrow: 'tomorrow', week: 'week', details: 'details' };
const VIEWS = new Set<string>(['today', 'tomorrow', 'week', 'details', 'details1']);

const w = () => txt.bots.weather;

// ---------- what each chat has chosen ----------

export interface ChatCfg {
  key: number;
  /** null until the person has chosen one */
  city: Place | null;
  type: 'private' | 'group';
  title: string | null;
  managerId: number | null;
  managerUsername: string | null;
  enabled: boolean;
  time: string;
  level: number;
  fields: Record<string, boolean>;
  lastSent: string | null;
}

interface Row {
  chat_key: number;
  type: string;
  title: string | null;
  manager_id: number | null;
  manager_username: string | null;
  enabled: number;
  time: string;
  level: number;
  fields: string;
  last_sent: string | null;
  city_id: number | null;
  city_name: string | null;
  city_label: string | null;
  city_lat: number | null;
  city_lon: number | null;
  city_tz: string | null;
}

function fromRow(r: Row): ChatCfg {
  let fields: Record<string, boolean> = {};
  try {
    fields = JSON.parse(r.fields) as Record<string, boolean>;
  } catch {
    /* defaults */
  }
  return {
    key: r.chat_key,
    city:
      r.city_id !== null && r.city_name && r.city_lat !== null && r.city_lon !== null && r.city_tz
        ? { id: r.city_id, name: r.city_name, label: r.city_label ?? undefined, lat: r.city_lat, lon: r.city_lon, tz: r.city_tz }
        : null,
    type: r.type === 'group' ? 'group' : 'private',
    title: r.title,
    managerId: r.manager_id,
    managerUsername: r.manager_username,
    enabled: !!r.enabled,
    time: r.time,
    level: r.level,
    fields: { ...DEFAULT_FIELDS, ...fields },
    lastSent: r.last_sent,
  };
}

export const getCfg = (key: number) => {
  const r = db.prepare('SELECT * FROM weather_chats WHERE chat_key = ?').get(key) as Row | undefined;
  return r ? fromRow(r) : undefined;
};

export function allCfgs(): ChatCfg[] {
  return (db.prepare('SELECT * FROM weather_chats ORDER BY chat_key').all() as Row[]).map(fromRow);
}

export function saveCfg(c: ChatCfg) {
  db.prepare(
    `INSERT INTO weather_chats (chat_key, type, title, manager_id, manager_username, enabled, time, level, fields, last_sent,
       city_id, city_name, city_label, city_lat, city_lon, city_tz)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_key) DO UPDATE SET type = excluded.type, title = excluded.title, manager_id = excluded.manager_id,
       manager_username = excluded.manager_username, enabled = excluded.enabled, time = excluded.time, level = excluded.level,
       fields = excluded.fields, last_sent = excluded.last_sent, city_id = excluded.city_id, city_name = excluded.city_name,
       city_label = excluded.city_label, city_lat = excluded.city_lat, city_lon = excluded.city_lon, city_tz = excluded.city_tz`,
  ).run(
    c.key, c.type, c.title, c.managerId, c.managerUsername, c.enabled ? 1 : 0, c.time, c.level, JSON.stringify(c.fields), c.lastSent,
    c.city?.id ?? null, c.city?.name ?? null, c.city?.label ?? null, c.city?.lat ?? null, c.city?.lon ?? null, c.city?.tz ?? null,
  );
}

const forget = (key: number) => db.prepare('DELETE FROM weather_chats WHERE chat_key = ?').run(key).changes > 0;

export function newCfg(key: number, type: ChatCfg['type'], title: string | null, manager?: UserRow | null): ChatCfg {
  return {
    key,
    city: null,
    type,
    title,
    managerId: manager?.id ?? null,
    managerUsername: manager?.username ?? null,
    enabled: true,
    time: DEFAULT_TIME,
    level: 2,
    fields: { ...DEFAULT_FIELDS },
    lastSent: null,
  };
}

/** The settings of a chat; for one the bot does not know — the defaults. */
const settingsOf = (key: number) => getCfg(key) ?? newCfg(key, 'private', null);

export const fullName = (u: { first_name?: string; last_name?: string; username?: string }) =>
  [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || '';

/** Everybody who wrote to the bot in a private chat gets the mailing (the bot cannot write first). */
function ensurePrivate(user: { id: number; first_name?: string; last_name?: string; username?: string }) {
  if (!getCfg(user.id)) saveCfg(newCfg(user.id, 'private', fullName(user)));
}

// ---------- time ----------

/** «8», «8:30», «08.30» -> «08:00»/«08:30»; null when it is no time. */
export function parseTime(text: string | undefined): string | null {
  const t = (text ?? '').trim().replace(/[.-]/g, ':');
  const [hours = '', minutes = ''] = t.split(':', 2);
  if (!/^\d+$/.test(hours) || (minutes !== '' && !/^\d+$/.test(minutes)) || t.split(':').length > 2) return null;
  const h = Number(hours);
  const m = Number(minutes || 0);
  return h < 24 && m < 60 ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` : null;
}

function shiftTime(value: string, delta: number): string {
  const [h, m] = value.split(':').map(Number) as [number, number];
  const total = (((h * 60 + m + delta) % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

const minutesOf = (value: string) => {
  const [h, m] = value.split(':').map(Number) as [number, number];
  return h * 60 + m;
};

/** A new time of the mailing (or a new city, which has its own clock). If it has already passed today, the first one is tomorrow. */
function setTime(c: ChatCfg, value: string) {
  c.time = value;
  if (!c.city) return void (c.lastSent = null);
  const now = localTime(deps.now(), c.city.tz);
  c.lastSent = value <= now.time ? now.date : null;
}

// ---------- keyboards and screens ----------

type Button = { text: string; callback_data: string };
const mark = (flag: boolean) => (flag ? '✅' : '❌');
const keyboard = (rows: Button[][]) => ({ inline_keyboard: rows });

function navMarkup(view: string) {
  const rows: Button[][] = [
    [{ text: w().btnToday, callback_data: 'v:today' }, { text: w().btnTomorrow, callback_data: 'v:tomorrow' }],
    [{ text: w().btnWeek, callback_data: 'v:week' }, { text: w().btnDetails, callback_data: 'v:details' }],
  ];
  if (view.startsWith('details')) {
    rows.push([view === 'details' ? { text: w().btnDetailsTomorrow, callback_data: 'v:details1' } : { text: w().btnDetailsToday, callback_data: 'v:details' }]);
  }
  rows.push([{ text: w().btnMenu, callback_data: 'm' }]);
  return keyboard(rows);
}

const statusLine = (c: ChatCfg) => (c.enabled ? w().statusOn(c.time, (LEVELS[c.level] ?? '').toLowerCase()) : w().statusOff);

const managedGroups = (uid: number) => allCfgs().filter((c) => c.type === 'group' && c.managerId === uid);

interface Screen {
  text: string;
  markup: Json;
}

/** A chat looks at the weather of its city; every caller has made sure there is one. */
const look = (c: ChatCfg & { city: Place }) => ({ level: c.level, fields: c.fields, place: c.city });

/** «Which city?»: the next thing the person writes is searched for among the cities. */
function needCity(bot: BotRow, uid: number, key: number): Screen {
  setState(bot, uid, 'city', { key });
  return { text: key === uid ? w().cityFirst : w().cityPrompt, markup: keyboard([]) };
}

function mainMenu(bot: BotRow, uid: number): Screen {
  const c = settingsOf(uid);
  if (!c.city) return needCity(bot, uid, uid);
  const groups = managedGroups(uid);
  return {
    text: w().menuTitle(escapeHtml(c.city.name), statusLine(c)),
    markup: keyboard([
      [{ text: w().btnToday, callback_data: 'v:today' }, { text: w().btnTomorrow, callback_data: 'v:tomorrow' }],
      [{ text: w().btnWeek, callback_data: 'v:week' }, { text: w().btnDetails, callback_data: 'v:details' }],
      [{ text: w().btnCity(c.city.name), callback_data: `x:${uid}:ci` }],
      [{ text: w().btnMine, callback_data: `x:${uid}:menu` }],
      [{ text: w().btnGroups(groups.length), callback_data: 'gl' }],
    ]),
  };
}

function groupsMenu(uid: number): Screen {
  const groups = managedGroups(uid);
  const rows: Button[][] = groups.map((c) => [{ text: `${mark(c.enabled)} ${c.title || c.key}`, callback_data: `x:${c.key}:menu` }]);
  rows.push([{ text: w().btnMenu, callback_data: 'm' }]);
  return { text: groups.length ? w().groupsTitle : w().groupsNone, markup: keyboard(rows) };
}

function settingsMenu(key: number): Screen {
  const c = settingsOf(key);
  const group = c.type === 'group';
  const rows: Button[][] = [
    [{ text: w().btnCity(c.city?.name ?? w().noCity), callback_data: `x:${key}:ci` }],
    [{ text: w().btnEnabled(mark(c.enabled)), callback_data: `x:${key}:en` }],
    [{ text: w().btnTime(c.time), callback_data: `x:${key}:menu` }],
    [-60, -30, 30, 60].map((delta) => ({ text: `${delta < 0 ? '−' : '+'}${Math.abs(delta) === 60 ? '1 ч' : '30 м'}`, callback_data: `x:${key}:tm:${delta}` })),
    [{ text: w().btnManualTime, callback_data: `x:${key}:ti` }],
    Object.entries(LEVELS).map(([n, name]) => ({ text: (c.level === Number(n) ? '● ' : '') + name, callback_data: `x:${key}:lv:${n}` })),
    ...Object.entries(FIELDS).map(([k, label]) => [{ text: `${mark(!!c.fields[k])} ${label}`, callback_data: `x:${key}:f:${k}` }]),
    [{ text: w().btnSendNow, callback_data: `x:${key}:test` }],
  ];
  if (group) rows.push([{ text: w().btnUnlink, callback_data: `x:${key}:un` }]);
  rows.push([{ text: w().btnBack, callback_data: group ? 'gl' : 'm' }]);
  const target = w().settingsTarget(group ? escapeHtml(c.title || String(key)) : null);
  return { text: w().settingsText(target, c.city ? escapeHtml(c.city.label ?? c.city.name) : w().noCity, statusLine(c)), markup: keyboard(rows) };
}

function unlinkMenu(key: number): Screen {
  return {
    text: w().unlinkAsk(escapeHtml(settingsOf(key).title || String(key))),
    markup: keyboard([[{ text: w().btnUnlinkYes, callback_data: `x:${key}:unc` }, { text: w().btnUnlinkNo, callback_data: `x:${key}:menu` }]]),
  };
}

const canManage = (key: number, uid: number) => {
  const c = getCfg(key);
  if (!c) return false;
  return c.type === 'private' ? c.key === uid : c.managerId === uid;
};

// ---------- the updates ----------

export async function weatherbot(bot: BotRow, update: BuiltinUpdate) {
  if (update.message) await onMessage(bot, update.message as Json);
  else if (update.callback_query) await onCallback(bot, update.callback_query as Json);
  else if (update.my_chat_member) onMyChatMember(bot, update.my_chat_member as Json);
}

const say = (bot: BotRow, chatId: number, text: string, markup?: Json) =>
  api(bot, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...(markup ? { reply_markup: markup } : {}) }).catch(() => null);

const botUsername = (bot: BotRow) => getUserRow(bot.user_id)?.username ?? '';

/** The name of the command, if it is meant for this bot: «/week@other_bot» is somebody else's. */
function commandOf(bot: BotRow, text: string): string | null {
  const m = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?/.exec(text);
  if (!m) return null;
  if (m[2] && m[2].toLowerCase() !== botUsername(bot).toLowerCase()) return null;
  return m[1]!.toLowerCase();
}

async function onMessage(bot: BotRow, m: Json) {
  const from = m.from as { id: number; first_name?: string; last_name?: string; username?: string } | undefined;
  const chat = m.chat as { id: number; type: string };
  if (!from || typeof m.text !== 'string') {
    if (from && chat.type === 'private') ensurePrivate(from);
    return;
  }
  const text = m.text.trim();
  const private_ = chat.type === 'private';
  if (private_) ensurePrivate(from);

  // the answer to «Ввести время вручную» or to «Какой город?»
  if (private_) {
    const st = getState(bot, from.id);
    if (st?.state === 'time') {
      clearState(bot, from.id);
      if (!text.startsWith('/')) return onTimeInput(bot, from.id, Number(st.data.key), text);
    } else if (st?.state === 'city') {
      if (!text.startsWith('/')) return onCityInput(bot, from.id, Number(st.data.key), text);
      clearState(bot, from.id);
    }
  }

  const cmd = commandOf(bot, text);
  if (!cmd) return;
  if (cmd in COMMAND_VIEWS) {
    const view = COMMAND_VIEWS[cmd]!;
    const cfg = settingsOf(chat.id);
    if (!cfg.city) {
      if (private_) {
        const s = needCity(bot, from.id, from.id);
        return void (await say(bot, chat.id, s.text));
      }
      return void (await say(bot, chat.id, w().groupNoCity(cfg.managerUsername ? w().groupManager(`@${cfg.managerUsername}`) : '')));
    }
    try {
      const body = await renderView(view, look({ ...cfg, city: cfg.city }));
      await say(bot, chat.id, body, private_ ? navMarkup(view) : undefined);
    } catch (e) {
      if (!(e instanceof WeatherError)) throw e;
      console.error('weather unavailable:', e.message);
      await say(bot, chat.id, w().unavailable);
    }
    return;
  }
  if (cmd === 'help') return void (await say(bot, chat.id, w().help(DEFAULT_TIME)));
  if (private_ && cmd === 'city') {
    const query = text.replace(/^\/\S+\s*/, '');
    if (query) return onCityInput(bot, from.id, from.id, query);
    setState(bot, from.id, 'city', { key: from.id });
    return void (await say(bot, chat.id, w().cityPrompt));
  }
  if (private_ && ['start', 'settings', 'menu'].includes(cmd)) {
    const s = mainMenu(bot, from.id);
    return void (await say(bot, chat.id, cmd === 'start' ? `${w().help(DEFAULT_TIME)}\n\n${s.text}` : s.text, s.markup));
  }
  if (!private_ && (cmd === 'settings' || cmd === 'city')) {
    const c = getCfg(chat.id);
    const who = c?.managerUsername ? w().groupManager(`@${c.managerUsername}`) : '';
    await say(bot, chat.id, w().groupSettingsHint(who));
  }
}

async function onTimeInput(bot: BotRow, uid: number, key: number, text: string) {
  if (!canManage(key, uid)) return;
  const value = parseTime(text);
  if (value === null) return void (await say(bot, uid, w().timeBad));
  const c = getCfg(key)!;
  setTime(c, value);
  saveCfg(c);
  const s = settingsMenu(key);
  await say(bot, uid, `${w().timeDone(value)}\n\n${s.text}`, s.markup);
}

/** The name of a city came in: the cities that fit, to pick from (the person may also write another name). */
async function onCityInput(bot: BotRow, uid: number, key: number, text: string) {
  if (!canManage(key, uid)) return void clearState(bot, uid);
  const found = await findCities(text.slice(0, 80));
  if (!found.length) return void (await say(bot, uid, w().cityNotFound(escapeHtml(text.slice(0, 40)))));
  const rows: Button[][] = found.map((c) => [{ text: c.label ?? c.name, callback_data: `x:${key}:cs:${c.id}` }]);
  await say(bot, uid, w().cityPick, keyboard(rows));
}

type Action = Screen & { notice?: string };

/** An action on the settings of a chat; the answer is the screen to show and a small notice. */
async function settingsAction(bot: BotRow, key: number, parts: string[], uid: number): Promise<Action> {
  const c = getCfg(key)!;
  const action = parts[0];
  let notice: string | undefined;
  if (action === 'en') {
    c.enabled = !c.enabled;
    saveCfg(c);
  } else if (action === 'tm') {
    setTime(c, shiftTime(c.time, Number(parts[1])));
    saveCfg(c);
  } else if (action === 'lv' && LEVELS[Number(parts[1])]) {
    c.level = Number(parts[1]);
    saveCfg(c);
  } else if (action === 'f' && parts[1] && parts[1] in FIELDS) {
    c.fields[parts[1]] = !c.fields[parts[1]];
    saveCfg(c);
  } else if (action === 'cs') {
    const city = cityById(Number(parts[1]));
    if (!city) return { ...settingsMenu(key), notice: w().cityLost };
    const first = !c.city;
    c.city = placeOf(city);
    setTime(c, c.time); // the clock of the new city: no mailing twice, none missed
    saveCfg(c);
    clearState(bot, uid);
    notice = w().cityDone(city.name);
    return { ...(first && c.type === 'private' ? mainMenu(bot, uid) : settingsMenu(key)), notice };
  } else if (action === 'test') {
    if (!c.city) return { ...settingsMenu(key), notice: w().cityNeeded };
    try {
      await api(bot, 'sendMessage', { chat_id: key, text: await renderView('today', look({ ...c, city: c.city })), parse_mode: 'HTML' });
      notice = w().sent;
    } catch (e) {
      if (e instanceof WeatherError) notice = w().serviceDown;
      else if (e instanceof BotApiError) notice = w().sendFailed(e.description.slice(0, 60));
      else throw e;
    }
  } else if (action === 'un') {
    return unlinkMenu(key);
  } else if (action === 'unc') {
    forget(key);
    await api(bot, 'leaveChat', { chat_id: key }).catch(() => null);
    return { ...groupsMenu(uid), notice: w().unlinked };
  }
  return { ...settingsMenu(key), notice };
}

async function route(bot: BotRow, data: string, uid: number): Promise<Action> {
  const [action, ...rest] = data.split(':');
  if (action === 'm') return mainMenu(bot, uid);
  if (action === 'gl') return groupsMenu(uid);
  if (action === 'v' && rest[0] && VIEWS.has(rest[0])) {
    const cfg = settingsOf(uid);
    if (!cfg.city) return needCity(bot, uid, uid);
    try {
      return { text: await renderView(rest[0] as View, look({ ...cfg, city: cfg.city })), markup: navMarkup(rest[0]) };
    } catch (e) {
      if (!(e instanceof WeatherError)) throw e;
      console.error('weather unavailable:', e.message);
      return { ...mainMenu(bot, uid), notice: w().serviceDown };
    }
  }
  if (action === 'x' && rest.length >= 2) {
    const key = Number(rest[0]);
    if (!Number.isInteger(key) || !canManage(key, uid)) return { ...mainMenu(bot, uid), notice: w().noAccess };
    return settingsAction(bot, key, rest.slice(1), uid);
  }
  return mainMenu(bot, uid);
}

async function onCallback(bot: BotRow, q: Json) {
  const from = q.from as { id: number; first_name?: string; last_name?: string; username?: string };
  const message = q.message as { message_id: number; chat: { id: number; type: string } } | undefined;
  const answer = (text?: string) => api(bot, 'answerCallbackQuery', { callback_query_id: q.id, ...(text ? { text } : {}) }).catch(() => null);
  if (!message || message.chat.type !== 'private') return void (await answer());
  const uid = from.id;
  ensurePrivate(from); // a button was pressed: there is a chat with the bot, even if the record was lost
  const data = String(q.data ?? '');
  const parts = data.split(':');
  if (parts[0] === 'x' && parts.length === 3 && parts[2] === 'ti') {
    // the time is typed as a separate message
    const key = Number(parts[1]);
    if (!Number.isInteger(key) || !canManage(key, uid)) return void (await answer(w().noAccessShort));
    await answer();
    setState(bot, uid, 'time', { key });
    await say(bot, uid, w().timePrompt);
    return;
  }
  if (parts[0] === 'x' && parts.length === 3 && parts[2] === 'ci') {
    // the city is typed as a separate message
    const key = Number(parts[1]);
    if (!Number.isInteger(key) || !canManage(key, uid)) return void (await answer(w().noAccessShort));
    await answer();
    setState(bot, uid, 'city', { key });
    await say(bot, uid, w().cityPrompt);
    return;
  }
  let result: Action;
  try {
    result = await route(bot, data, uid);
  } catch (e) {
    await answer(w().failed);
    throw e;
  }
  await answer(result.notice);
  await api(bot, 'editMessageText', {
    chat_id: message.chat.id,
    message_id: message.message_id,
    text: result.text,
    parse_mode: 'HTML',
    reply_markup: result.markup,
  }).catch((e) => {
    // the same content: the server does not «change» a message to itself
    if (!(e instanceof BotApiError && /not modified/.test(e.description))) throw e;
  });
}

function onMyChatMember(bot: BotRow, u: Json) {
  const chat = u.chat as { id: number; type: string; title?: string };
  const target = (u.new_chat_member as { user?: { id: number } } | undefined)?.user;
  if (!target || target.id !== bot.user_id) return;
  const oldStatus = (u.old_chat_member as { status: string }).status;
  const newStatus = (u.new_chat_member as { status: string }).status;
  if (chat.type === 'private') {
    if (newStatus === 'left' || newStatus === 'kicked') forget(chat.id); // the person blocked the bot
    return;
  }
  if (!GROUP_TYPES.includes(chat.type)) return;
  if ((oldStatus === 'left' || oldStatus === 'kicked') && (newStatus === 'member' || newStatus === 'administrator')) {
    const actor = u.from as { id: number; first_name?: string; last_name?: string; username?: string } | undefined;
    const manager = actor ? getUserRow(actor.id) : undefined;
    saveCfg(newCfg(chat.id, 'group', chat.title ?? null, manager));
    const name = manager ? (manager.username ? `@${manager.username}` : escapeHtml(fullName(manager))) : '';
    void say(bot, chat.id, w().groupHello(manager ? w().groupManagerIs(name) : ''));
    if (manager) void say(bot, manager.id, w().managerNotice(escapeHtml(chat.title ?? '')), keyboard([[{ text: w().btnCityPick, callback_data: `x:${chat.id}:ci` }]]));
  } else if (newStatus === 'left' || newStatus === 'kicked') {
    forget(chat.id);
  }
}

// ---------- the daily mailing ----------

let ticking = false;

/** Sends the forecast to every chat whose time has come. Called every 20 seconds. */
export async function tickWeather() {
  if (ticking) return;
  ticking = true;
  try {
    const bot = getBuiltinBot('weatherbot');
    if (!bot) return;
    // «now» is different in every city: the mailing of a chat is due by the clock of its own city
    const ms = deps.now();
    const due = allCfgs().flatMap((c) => {
      if (!c.enabled || !c.city) return [];
      const now = localTime(ms, c.city.tz);
      const late = now.hour * 60 + now.minutes - minutesOf(c.time);
      return c.lastSent !== now.date && late >= 0 && late <= CATCHUP_MINUTES ? [{ c, city: c.city, date: now.date }] : [];
    });
    let down = 0;
    for (const { c, city, date } of due) {
      try {
        await api(bot, 'sendMessage', { chat_id: c.key, text: await renderView('today', look({ ...c, city })), parse_mode: 'HTML' });
        down = 0;
      } catch (e) {
        if (e instanceof WeatherError) {
          // this city waits for the next round, while the window is open; three in a row mean the services are down
          console.error(`mailing waits: weather unavailable for ${city.name}:`, e.message);
          if (++down >= 3) return;
          continue;
        }
        if (e instanceof BotApiError) {
          if (e.code === 403 || /not found/i.test(e.description)) {
            // the bot was blocked, the group is gone
            forget(c.key);
            continue;
          }
          console.error(`weather: chat ${c.key}: ${e.description}`);
        } else {
          console.error(`weather: chat ${c.key}:`, e);
          continue; // later
        }
      }
      c.lastSent = date;
      saveCfg(c);
    }
  } finally {
    ticking = false;
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startWeatherTimer() {
  if (timer) return;
  timer = setInterval(() => {
    tickWeather().catch((e) => console.error('weather mailing:', e));
  }, 20_000);
  timer.unref();
}
