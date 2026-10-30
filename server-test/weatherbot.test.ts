import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { allCfgs, getCfg, newCfg, parseTime, saveCfg, tickWeather } from '../src/bots/weatherbot.js';
import { importWeatherData, importWeatherSeed } from '../src/bots/weatherImport.js';
import { allCities, cityById, findCities, searchLocal } from '../src/bots/weather/cities.js';
import { ARKHANGELSK, type Place, deps, localTime, metnoCode, resetWeather } from '../src/bots/weather/data.js';
import { escapeHtml, mm, pyRound, temp } from '../src/bots/weather/render.js';
import { config } from '../src/config.js';
import { db } from '../src/db.js';

let app: FastifyInstance;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'timba-weather-'));
const realFetch = deps.fetch;
const realNow = deps.now;

beforeAll(async () => {
  config.dataDir = tmp;
  config.adminPassword = 'adminpass';
  app = await buildApp({ dbFile: ':memory:' });
});

afterAll(async () => {
  await app.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  resetWeather();
  deps.fetch = fakeServices();
  deps.now = realNow;
});

afterEach(() => {
  deps.fetch = realFetch;
  deps.now = realNow;
});

// ---------- the weather services, faked ----------

const DAY = 86400_000;

/** A week of Open-Meteo data starting today (Архангельск): today is +3…+9, light rain, wind 7.2 m/s from the east. */
function openMeteo(now = Date.now()) {
  const days = Array.from({ length: 7 }, (_, i) => localTime(now + i * DAY, 'Europe/Moscow').date);
  const hourly: Record<string, (string | number | null)[]> = { time: [] };
  const names = ['temperature_2m', 'apparent_temperature', 'precipitation_probability', 'precipitation', 'weather_code', 'wind_speed_10m', 'wind_gusts_10m', 'wind_direction_10m', 'relative_humidity_2m', 'surface_pressure'];
  for (const n of names) hourly[n] = [];
  days.forEach((date, i) => {
    for (let h = 0; h < 24; h++) {
      hourly.time!.push(`${date}T${String(h).padStart(2, '0')}:00`);
      hourly.temperature_2m!.push(i === 0 ? (h >= 12 && h < 18 ? 9 : 3 + (h % 3)) : 10);
      hourly.apparent_temperature!.push(i === 0 ? 1 : 8);
      hourly.precipitation_probability!.push(60);
      hourly.precipitation!.push(i === 0 && h === 14 ? 2.4 : 0);
      hourly.weather_code!.push(i === 0 ? 61 : 2);
      hourly.wind_speed_10m!.push(i === 0 ? 7.2 : 3);
      hourly.wind_gusts_10m!.push(11);
      hourly.wind_direction_10m!.push(90);
      hourly.relative_humidity_2m!.push(80);
      hourly.surface_pressure!.push(1000);
    }
  });
  const each = <T,>(f: (i: number) => T) => days.map((_, i) => f(i));
  return {
    current: { temperature_2m: 4.2, apparent_temperature: 1.1, weather_code: 3, wind_speed_10m: 6.4, wind_direction_10m: 90, relative_humidity_2m: 82, surface_pressure: 1001 },
    hourly,
    daily: {
      time: days,
      weather_code: each((i) => (i === 0 ? 61 : 2)),
      temperature_2m_max: each((i) => (i === 0 ? 9 : 10)),
      temperature_2m_min: each((i) => (i === 0 ? 3 : 10)),
      apparent_temperature_max: each((i) => (i === 0 ? 4 : 8)),
      apparent_temperature_min: each((i) => (i === 0 ? 1 : 8)),
      sunrise: each((i) => `${days[i]}T05:40`),
      sunset: each((i) => `${days[i]}T19:10`),
      uv_index_max: each(() => 3.2),
      precipitation_sum: each((i) => (i === 0 ? 2.4 : 0)),
      snowfall_sum: each(() => 0),
      precipitation_probability_max: each((i) => (i === 0 ? 60 : 10)),
      wind_speed_10m_max: each((i) => (i === 0 ? 7.2 : 3)),
      wind_gusts_10m_max: each((i) => (i === 0 ? 11 : 5)),
      wind_direction_10m_dominant: each(() => 90),
    },
  };
}

interface Fakes {
  metno?: 'fail' | unknown;
  openmeteo?: 'fail' | unknown;
  /** the Open-Meteo geocoder: by default it knows no place */
  geocoder?: 'fail' | unknown;
  calls?: string[];
}

/** What the server asks the Internet for: MET Norway fails unless a test gives it a forecast, Open-Meteo answers. */
function fakeServices(f: Fakes = {}) {
  return (async (url: string) => {
    f.calls?.push(url);
    if (url.includes('geocoding-api')) {
      const g = f.geocoder ?? { generationtime_ms: 1 };
      return g === 'fail' ? new Response('down', { status: 503 }) : new Response(JSON.stringify(g), { status: 200 });
    }
    const body = url.includes('api.met.no/weatherapi/locationforecast') ? f.metno ?? 'fail' : url.includes('api.met.no/weatherapi/sunrise') ? sunBody() : url.includes('open-meteo') ? (f.openmeteo ?? openMeteo()) : 'fail';
    if (body === 'fail') return new Response('down', { status: 503 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof deps.fetch;
}

const sunBody = () => ({ properties: { sunrise: { time: '2026-10-04T05:41:00+03:00' }, sunset: { time: '2026-10-04T19:09:00+03:00' } } });

/** A MET Norway answer: an entry per hour for two days, then one per 6 hours up to nine days. */
function metno(now = Date.now()) {
  const first = Math.floor(now / 3600_000) * 3600_000;
  const series: { time: string; data: any }[] = [];
  const entry = (at: number, hourly: boolean) => ({
    time: new Date(at).toISOString().replace('.000', ''),
    data: {
      instant: { details: { air_temperature: 5, apparent_air_temperature: 3, wind_speed: 4, wind_from_direction: 180, relative_humidity: 70, air_pressure_at_sea_level: 1005, ultraviolet_index_clear_sky: 2 } },
      ...(hourly ? { next_1_hours: { summary: { symbol_code: 'lightrain_day' }, details: { precipitation_amount: 0.6 } } } : {}),
      next_6_hours: { summary: { symbol_code: 'rain' }, details: { precipitation_amount: 3, air_temperature_max: 8, air_temperature_min: 2 } },
    },
  });
  for (let h = 0; h < 48; h++) series.push(entry(first + h * 3600_000, true));
  for (let h = 48; h < 9 * 24; h += 6) series.push(entry(first + h * 3600_000, false));
  return { properties: { timeseries: series } };
}

// ---------- people ----------

interface Client {
  id: number;
  username: string;
  req: (method: string, url: string, body?: unknown) => Promise<{ status: number; body: any }>;
}

function client(cookie: string, id: number, username: string): Client {
  return {
    id,
    username,
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
    remoteAddress: `10.7.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`,
    payload: { username, password: 'secret123', firstName: username },
  });
  expect(r.statusCode).toBe(200);
  return client(String(r.headers['set-cookie']).split(';')[0]!, JSON.parse(r.body).id, username);
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

/** A person with an open chat with the bot; they have chosen `city` already (null: the very first start). */
async function person(name: string, city: Place | null = ARKHANGELSK) {
  const u = await register(name);
  if (city) saveCfg({ ...newCfg(u.id, 'private', name), city });
  const botId = (await u.req('GET', '/api/resolve/WeatherBot')).body.user.id as number;
  const chat = (await u.req('POST', '/api/chats/private', { userId: botId })).body.id as number;
  const messages = async () => (await u.req('GET', `/api/chats/${chat}/messages?limit=100`)).body as any[];
  const say = (text: string) => u.req('POST', `/api/chats/${chat}/messages`, { text });
  /** The `n`-th message of the bot (1 = the first), waiting for it. */
  const botSays = async (n: number) =>
    waitFor(async () => {
      const list = (await messages()).filter((m) => m.senderId === botId);
      return list.length >= n ? list[n - 1] : undefined;
    });
  const lastBot = async () => (await messages()).filter((m) => m.senderId === botId).at(-1);
  const press = async (messageId: number, data: string) => {
    const r = await u.req('POST', `/api/messages/${messageId}/callback`, { data });
    expect(r.status, `button ${data}`).toBe(200);
    await new Promise((res) => setTimeout(res, 150));
  };
  const buttons = (m: any) => (m.replyMarkup?.rows ?? []).flat() as { text: string; callbackData: string }[];
  const count = async () => (await messages()).filter((m) => m.senderId === botId).length;
  return { u, botId, chat, say, botSays, lastBot, press, buttons, messages, count };
}

type Person = Awaited<ReturnType<typeof person>>;

/** Waits until the bot has said one more thing than before. */
async function next(p: Person, before: number) {
  return p.botSays(before + 1);
}

// ---------- the little formatters ----------

describe('formatting', () => {
  it('rounds like the original bot, writes temperatures and millimetres', () => {
    expect([pyRound(0.5), pyRound(1.5), pyRound(2.5), pyRound(-0.5), pyRound(-1.5), pyRound(2.4)]).toEqual([0, 2, 2, 0, -2, 2]);
    expect([temp(3.4), temp(-3.6), temp(0.2), temp(-0.4)]).toEqual(['+3°', '−4°', '0°', '0°']);
    expect([mm(0), mm(0.04), mm(2.4), mm(3), mm(0.25)]).toEqual(['0', '&lt;0,1', '2,4', '3', '0,3']);
    expect(escapeHtml('a<b>&c')).toBe('a&lt;b&gt;&amp;c');
  });

  it('reads times the way people write them', () => {
    expect([parseTime('8'), parseTime('8:30'), parseTime('08.05'), parseTime(' 7-45 '), parseTime('24:00'), parseTime('8:60'), parseTime('abc'), parseTime('1:2:3'), parseTime('')]).toEqual([
      '08:00', '08:30', '08:05', '07:45', null, null, null, null, null,
    ]);
  });

  it('turns MET Norway icons into weather codes', () => {
    expect([metnoCode('clearsky_day'), metnoCode('partlycloudy_night'), metnoCode('lightrain'), metnoCode('heavysnowshowers_day'), metnoCode('rainandthunder'), metnoCode('heavyrainandthunder_day'), metnoCode('weird'), metnoCode(undefined)]).toEqual([0, 2, 61, 86, 95, 99, 3, null]);
  });
});

// ---------- the bot ----------

describe('@WeatherBot', () => {
  it('is a built-in bot with a picture and commands, and may join groups', async () => {
    const u = await register('wx_viewer');
    const id = (await u.req('GET', '/api/resolve/WeatherBot')).body.user.id as number;
    expect((await u.req('GET', `/api/users/${id}`)).body).toMatchObject({ isBot: true, username: 'WeatherBot' });
    expect((await u.req('GET', `/api/users/${id}`)).body.avatarFileId).toBeTruthy();
    const info = (await u.req('GET', `/api/bots/${id}`)).body;
    expect(info).toMatchObject({ builtin: true, canJoinGroups: true });
    expect(info.commands.map((c: any) => c.command)).toEqual(['start', 'weather', 'tomorrow', 'week', 'details', 'city', 'help']);
    expect((await u.req('GET', `/api/users/${id}`)).body.firstName).toBe('Погода');
  });

  it('shows today, tomorrow, the week and a detailed day', async () => {
    const p = await person('wx_cmds');
    await p.say('/weather');
    const today = await p.botSays(1);
    expect(today.text).toContain('Архангельск — сегодня');
    expect(today.text).toContain('Небольшой дождь');
    expect(today.text).toContain('Температура: +3°…+9°');
    expect(today.text).toContain('Ощущается: +1°…+4°');
    expect(today.text).toContain('Осадки: 2,4 мм, вероятность до 60%');
    expect(today.text).toContain('Ветер: до 7 м/с В, порывы до 11 м/с');
    expect(p.buttons(today).map((b) => b.text)).toEqual(['🌤 Сегодня', '🌥 Завтра', '📅 Неделя', '🔎 Подробно', '🏠 Меню']);

    await p.say('/tomorrow');
    expect((await p.botSays(2)).text).toContain('Архангельск — завтра');
    await p.say('/week');
    const week = await p.botSays(3);
    expect(week.text).toContain('на неделю');
    expect(week.text.split('\n').filter((l: string) => l.includes('ветер'))).toHaveLength(7);
    await p.say('/details');
    const details = await p.botSays(4);
    expect(details.text).toContain('Сейчас:');
    expect(details.text).toContain('Влажность: 80%');
    expect(details.text).toContain('Давление: 750 мм рт. ст.');
    expect(details.text).toContain('УФ-индекс: 3 (умеренный)');
    expect(details.text).toContain('Восход 05:40, закат 19:10 (день 13 ч 30 мин)');
    expect(details.text).toContain('По времени суток');
    expect(details.text).toContain('По часам');
    expect(details.text).toContain('21:00');
    expect(p.buttons(details).map((b) => b.text)).toContain('🔎 Подробно на завтра');

    await p.say('/help');
    expect((await p.botSays(5)).text).toContain('Присылаю прогноз для выбранного города');
    // an ordinary text and somebody else's command get no answer
    await p.say('привет');
    await p.say('/week@other_bot');
    await new Promise((r) => setTimeout(r, 250));
    expect(await p.count()).toBe(5);
    await p.say('/week@WeatherBot');
    await next(p, 5);
  });

  it('switches views with its buttons in the same message', async () => {
    const p = await person('wx_nav');
    await p.say('/weather');
    const msg = await p.botSays(1);
    await p.press(msg.id, 'v:week');
    expect((await p.lastBot()).text).toContain('на неделю');
    await p.press(msg.id, 'v:details');
    expect((await p.lastBot()).text).toContain('По часам');
    await p.press(msg.id, 'v:details1');
    const tomorrow = await p.lastBot();
    expect(tomorrow.text).toContain('завтра');
    expect(p.buttons(tomorrow).map((b) => b.text)).toContain('🔎 Подробно на сегодня');
    await p.press(msg.id, 'm');
    expect((await p.lastBot()).text).toContain('Ваша рассылка: каждый день в 08:00, стандарт');
    expect(await p.count()).toBe(1);
  });

  it('subscribes everybody who writes to it and sets up the mailing with buttons', async () => {
    const p = await person('wx_setup', null);
    expect(getCfg(p.u.id)).toBeUndefined();
    // the first start: the city comes first
    await p.say('/start');
    expect((await p.botSays(1)).text).toContain('Для начала выберите город');
    expect(getCfg(p.u.id)).toMatchObject({ type: 'private', enabled: true, city: null });
    await p.say('архангельск');
    const list = await p.botSays(2);
    expect(p.buttons(list)[0]).toMatchObject({ text: 'Архангельск, Архангельская область', callbackData: `x:${p.u.id}:cs:581049` });
    await p.press(list.id, `x:${p.u.id}:cs:581049`);
    const menu = await p.lastBot();
    expect(menu.id).toBe(list.id); // the list became the menu
    expect(menu.text).toContain('Погода — Архангельск');
    expect(menu.text).toContain('Ваша рассылка: каждый день в 08:00, стандарт');
    expect(getCfg(p.u.id)).toMatchObject({ type: 'private', enabled: true, time: '08:00', level: 2 });
    expect(p.buttons(menu).map((b) => b.callbackData)).toEqual(['v:today', 'v:tomorrow', 'v:week', 'v:details', `x:${p.u.id}:ci`, `x:${p.u.id}:menu`, 'gl']);

    await p.press(menu.id, `x:${p.u.id}:menu`);
    let screen = await p.lastBot();
    expect(screen.text).toContain('Рассылка: вам в личные сообщения');
    expect(screen.text).toContain('Город: Архангельск, Архангельская область');
    expect(p.buttons(screen).map((b) => b.text)).toEqual(expect.arrayContaining(['🏙 Город: Архангельск', '✅ Рассылка включена', '⏰ Время рассылки: 08:00', '−1 ч', '−30 м', '+30 м', '+1 ч', '✏️ Ввести время вручную', 'Кратко', '● Стандарт', 'Подробно', '❌ 💧 Влажность', '✅ 🌡 Температура', '📨 Прислать сейчас', '⬅️ Назад']));

    // a figure on, the level up, the time later, the mailing off
    await p.press(menu.id, `x:${p.u.id}:f:humidity`);
    await p.press(menu.id, `x:${p.u.id}:f:temp`);
    await p.press(menu.id, `x:${p.u.id}:lv:3`);
    await p.press(menu.id, `x:${p.u.id}:tm:60`);
    expect(getCfg(p.u.id)).toMatchObject({ time: '09:00', level: 3, fields: { humidity: true, temp: false } });
    screen = await p.lastBot();
    expect(screen.text).toContain('каждый день в 09:00, подробно');
    await p.press(menu.id, `x:${p.u.id}:tm:-30`);
    await p.press(menu.id, `x:${p.u.id}:tm:-60`);
    await p.press(menu.id, `x:${p.u.id}:tm:-60`);
    expect(getCfg(p.u.id)!.time).toBe('06:30');
    await p.press(menu.id, `x:${p.u.id}:en`);
    expect(getCfg(p.u.id)!.enabled).toBe(false);
    expect((await p.lastBot()).text).toContain('рассылка выключена');
    await p.press(menu.id, `x:${p.u.id}:en`);

    // «Прислать сейчас» uses the chat's own look
    const before = await p.count();
    await p.press(menu.id, `x:${p.u.id}:test`);
    const sent = await next(p, before);
    expect(sent.text).toContain('Влажность: 80%');
    expect(sent.text).not.toContain('Температура');
    expect(sent.text).toContain('По времени суток');

    // nothing of anybody else's: a button that is not on the person's own message is refused
    const other = await person('wx_setup_other');
    await other.say('/start');
    const otherMenu = await other.botSays(1);
    const forged = await other.u.req('POST', `/api/messages/${otherMenu.id}/callback`, { data: `x:${p.u.id}:en` });
    expect(forged.status).toBe(400);
    expect(getCfg(p.u.id)!.enabled).toBe(true);
  });

  it('takes the time typed by hand', async () => {
    const p = await person('wx_time');
    await p.say('/start');
    const menu = await p.botSays(1);
    await p.press(menu.id, `x:${p.u.id}:menu`);
    await p.press(menu.id, `x:${p.u.id}:ti`);
    expect((await p.botSays(2)).text).toContain('Пришлите время рассылки');
    await p.say('позже');
    expect((await p.botSays(3)).text).toContain('Не похоже на время');
    expect(getCfg(p.u.id)!.time).toBe('08:00');
    // the first answer was taken: the time is asked for again
    await p.press(menu.id, `x:${p.u.id}:ti`);
    await p.botSays(4);
    await p.say('7.30');
    const done = await p.botSays(5);
    expect(done.text).toContain('Готово: рассылка в 07:30');
    expect(done.text).toContain('Рассылка: вам в личные сообщения');
    expect(getCfg(p.u.id)!.time).toBe('07:30');
    // a command in place of the time cancels the question
    await p.press(menu.id, `x:${p.u.id}:ti`);
    await p.botSays(6);
    await p.say('/week');
    expect((await p.botSays(7)).text).toContain('на неделю');
    await p.say('9:00');
    await new Promise((r) => setTimeout(r, 200));
    expect(getCfg(p.u.id)!.time).toBe('07:30');
  });
});

// ---------- the mailing ----------

describe('the daily mailing', () => {
  /** The clock of the tests: Архангельск, `time` today. */
  const clockAt = (time: string) => {
    const [h, m] = time.split(':').map(Number) as [number, number];
    const midnight = Math.floor((Date.now() + 3 * 3600_000) / DAY) * DAY - 3 * 3600_000;
    deps.now = () => midnight + (h * 60 + m) * 60_000;
  };

  it('sends the forecast once a day to everybody whose time has come, and catches up for 3 hours', async () => {
    const p = await person('wx_mail');
    await p.say('/start');
    await p.botSays(1);
    const today = localTime(Date.now(), 'Europe/Moscow').date;

    clockAt('07:59');
    await tickWeather();
    expect(await p.count()).toBe(1);

    clockAt('08:01');
    await tickWeather();
    const mail = await p.botSays(2);
    expect(mail.text).toContain('Архангельск — сегодня');
    expect(getCfg(p.u.id)!.lastSent).toBe(localTime(deps.now(), 'Europe/Moscow').date);
    await tickWeather();
    await new Promise((r) => setTimeout(r, 150));
    expect(await p.count()).toBe(2);

    // the next day it comes again, 3 hours late it is too late
    getCfg(p.u.id);
    db.prepare('UPDATE weather_chats SET last_sent = ? WHERE chat_key = ?').run('2000-01-01', p.u.id);
    clockAt('11:01');
    await tickWeather();
    await new Promise((r) => setTimeout(r, 150));
    expect(await p.count()).toBe(2);
    clockAt('10:59');
    await tickWeather();
    await next(p, 2);
    void today;
  });

  it('keeps to the chosen time and to the switch, and waits when the weather is down', async () => {
    const p = await person('wx_mail2');
    await p.say('/start');
    await p.botSays(1);
    db.prepare('UPDATE weather_chats SET time = ?, enabled = 0 WHERE chat_key = ?').run('06:00', p.u.id);
    clockAt('06:30');
    await tickWeather();
    await new Promise((r) => setTimeout(r, 150));
    expect(await p.count()).toBe(1);

    db.prepare('UPDATE weather_chats SET enabled = 1 WHERE chat_key = ?').run(p.u.id);
    // both services are down: nothing is sent and nothing is marked as sent
    deps.fetch = fakeServices({ openmeteo: 'fail' });
    await tickWeather();
    await new Promise((r) => setTimeout(r, 150));
    expect(await p.count()).toBe(1);
    expect(getCfg(p.u.id)!.lastSent).toBeNull();
    // /weather says so, too
    await p.say('/weather');
    expect((await p.botSays(2)).text).toContain('Не получилось узнать погоду');

    // the services are back (the failure is forgotten after half a minute: here, at once)
    resetWeather();
    deps.fetch = fakeServices();
    await tickWeather();
    expect((await next(p, 2)).text).toContain('Архангельск — сегодня');
    expect(getCfg(p.u.id)!.lastSent).toBe(localTime(deps.now(), 'Europe/Moscow').date);
  });

  it('forgets a person who blocked the bot and a chat that is gone', async () => {
    const p = await person('wx_block');
    await p.say('/start');
    await p.botSays(1);
    expect(getCfg(p.u.id)).toBeTruthy();
    expect((await p.u.req('POST', `/api/users/${p.botId}/block`)).status).toBe(200);
    await waitFor(() => !getCfg(p.u.id));

    // a chat the bot cannot reach any more is dropped by the mailing
    saveCfg({ ...newCfg(-987654, 'group', 'Нет такой'), city: ARKHANGELSK, time: '00:00' });
    clockAt('01:00');
    await tickWeather();
    expect(getCfg(-987654)).toBeUndefined();
  });
});

// ---------- the sources ----------

describe('the sources of the weather', () => {
  it('prefers MET Norway, writes down its forecast like Open-Meteo\'s and asks the sun separately', async () => {
    const calls: string[] = [];
    deps.fetch = fakeServices({ metno: metno(), calls });
    const p = await person('wx_metno');
    await p.say('/weather');
    const today = await p.botSays(1);
    expect(today.text).toContain('Архангельск — сегодня');
    expect(today.text).toMatch(/Небольшой дождь|Дождь/);
    expect(today.text).toContain('Температура: +2°…+8°');
    expect(today.text).toContain('Ветер: до 4 м/с Ю');
    expect(calls.some((u) => u.includes('locationforecast'))).toBe(true);
    expect(calls.some((u) => u.includes('sunrise'))).toBe(true);
    expect(calls.some((u) => u.includes('open-meteo'))).toBe(false);
    await p.say('/week');
    expect((await p.botSays(2)).text.split('\n').filter((l: string) => l.includes('ветер')).length).toBeGreaterThanOrEqual(6);
    await p.say('/details');
    const details = await p.botSays(3);
    expect(details.text).toContain('Восход 05:41, закат 19:09');
    // tomorrow is there in full: the hours, without a probability of rain (MET Norway gives none)
    await p.press(details.id, 'v:details1');
    expect((await p.lastBot()).text).toContain('**По часам**  (температура · ветер)');
    // the forecast is kept: no new requests
    const asked = calls.length;
    await p.say('/tomorrow');
    await p.botSays(4);
    expect(calls.length).toBe(asked);
  });

  it('falls back to Open-Meteo when MET Norway does not answer, and shows an old forecast when both are down', async () => {
    const calls: string[] = [];
    deps.fetch = fakeServices({ calls });
    const p = await person('wx_fallback');
    await p.say('/weather');
    expect((await p.botSays(1)).text).toContain('Температура: +3°…+9°');
    expect(calls.filter((u) => u.includes('locationforecast'))).toHaveLength(1);
    expect(calls.filter((u) => u.includes('open-meteo'))).toHaveLength(1);

    // 11 minutes later both are down: the forecast of 11 minutes ago is still shown
    const t0 = Date.now();
    deps.now = () => t0 + 11 * 60_000;
    deps.fetch = fakeServices({ metno: 'fail', openmeteo: 'fail' });
    await p.say('/weather');
    expect((await p.botSays(2)).text).toContain('Температура: +3°…+9°');
    // but not one older than 2 hours
    deps.now = () => t0 + 3 * 3600_000;
    resetWeather();
    await p.say('/weather');
    expect((await p.botSays(3)).text).toContain('Не получилось узнать погоду');
  });
});

// ---------- groups ----------

describe('groups', () => {
  it('joins a group, tells who sets it up, answers commands there and leaves when asked', async () => {
    const owner = await register('wx_gowner');
    const botId = (await owner.req('GET', '/api/resolve/WeatherBot')).body.user.id as number;
    // the owner writes to the bot first, so that it can tell them about the group
    saveCfg({ ...newCfg(owner.id, 'private', 'wx_gowner'), city: ARKHANGELSK });
    const dm = (await owner.req('POST', '/api/chats/private', { userId: botId })).body.id as number;
    await owner.req('POST', `/api/chats/${dm}/messages`, { text: '/start' });
    const group = (await owner.req('POST', '/api/chats/group', { title: 'Семья', memberIds: [] })).body.id as number;
    const member = await register('wx_gmember');
    await owner.req('POST', `/api/chats/${group}/members`, { userIds: [member.id] });

    expect((await owner.req('POST', `/api/chats/${group}/members`, { userIds: [botId] })).status).toBe(200);
    const inGroup = async () => ((await owner.req('GET', `/api/chats/${group}/messages?limit=100`)).body as any[]).filter((m) => m.senderId === botId);
    const hello = await waitFor(async () => (await inGroup())[0]);
    expect(hello.text).toContain('Сначала нужно выбрать город');
    expect(hello.text).toContain('@wx_gowner');
    expect(getCfg(-group)).toMatchObject({ type: 'group', title: 'Семья', managerId: owner.id, managerUsername: 'wx_gowner', enabled: true, time: '08:00', city: null });
    const dmMessages = async () => ((await owner.req('GET', `/api/chats/${dm}/messages?limit=100`)).body as any[]).filter((m) => m.senderId === botId);
    const notice = await waitFor(async () => (await dmMessages()).find((m) => m.text.includes('подключена к рассылке')));
    expect(notice.text).toContain('«Семья»');
    expect(notice.replyMarkup.rows.flat()).toEqual([expect.objectContaining({ text: '🏙 Выбрать город', callbackData: `x:${-group}:ci` })]);

    // without a city the group gets no forecast, only the way to choose one
    await member.req('POST', `/api/chats/${group}/messages`, { text: '/weather@WeatherBot' });
    expect((await waitFor(async () => (await inGroup()).find((m) => m.text.includes('ещё не выбран город')))).text).toContain('@wx_gowner');
    // the person who added the bot chooses it in a private chat: the button, the name, the list
    expect((await owner.req('POST', `/api/messages/${notice.id}/callback`, { data: `x:${-group}:ci` })).status).toBe(200);
    await waitFor(async () => (await dmMessages()).find((m) => m.text.includes('Напишите название города')));
    await owner.req('POST', `/api/chats/${dm}/messages`, { text: 'Архангельск' });
    const pick = await waitFor(async () => (await dmMessages()).find((m) => m.text.includes('Выберите город из списка')));
    expect((await owner.req('POST', `/api/messages/${pick.id}/callback`, { data: `x:${-group}:cs:581049` })).status).toBe(200);
    await waitFor(() => getCfg(-group)?.city);
    expect(getCfg(-group)!.city).toMatchObject({ id: 581049, name: 'Архангельск', tz: 'Europe/Moscow' });
    // somebody else cannot choose it
    const alien = await person('wx_galien', null);
    await alien.say('/start');
    const alienMenu = await alien.botSays(1);
    expect((await alien.u.req('POST', `/api/messages/${alienMenu.id}/callback`, { data: `x:${-group}:ci` })).status).toBe(400);

    // commands work for everybody, without the buttons
    await member.req('POST', `/api/chats/${group}/messages`, { text: '/weather@WeatherBot' });
    const answer = await waitFor(async () => (await inGroup()).find((m) => m.text.includes('Архангельск — сегодня')));
    expect(answer.replyMarkup?.rows ?? []).toHaveLength(0);
    await member.req('POST', `/api/chats/${group}/messages`, { text: '/settings@WeatherBot' });
    expect((await waitFor(async () => (await inGroup()).find((m) => m.text.includes('Рассылкой группы и городом управляет')))).text).toContain('@wx_gowner');

    // the group is in the list of the person who added the bot, and only theirs
    await owner.req('POST', `/api/chats/${dm}/messages`, { text: '/menu' });
    const menu = await waitFor(async () => (await dmMessages()).find((m) => m.text.includes('Ваша рассылка') && m.replyMarkup?.rows.flat().some((b: any) => b.text.includes('Мои группы (1)'))));
    expect(menu).toBeTruthy();
    const press = async (c: Client, chat: number, id: number, data: string) => {
      const r = await c.req('POST', `/api/messages/${id}/callback`, { data });
      expect(r.status).toBe(200);
      await new Promise((res) => setTimeout(res, 150));
    };
    await press(owner, dm, menu.id, 'gl');
    let screen = (await dmMessages()).find((m) => m.id === menu.id)!;
    expect(screen.text).toContain('Ваши группы');
    expect(screen.replyMarkup.rows.flat().map((b: any) => b.text)).toContain('✅ Семья');
    await press(owner, dm, menu.id, `x:${-group}:menu`);
    screen = (await dmMessages()).find((m) => m.id === menu.id)!;
    expect(screen.text).toContain('Рассылка: группа «Семья»');
    await press(owner, dm, menu.id, `x:${-group}:lv:1`);
    expect(getCfg(-group)!.level).toBe(1);
    // somebody else cannot touch the group
    const stranger = await person('wx_gstranger');
    await stranger.say('/start');
    const smenu = await stranger.botSays(1);
    expect((await stranger.u.req('POST', `/api/messages/${smenu.id}/callback`, { data: `x:${-group}:lv:3` })).status).toBe(400);
    expect(getCfg(-group)!.level).toBe(1);

    // «Отключить группу»: asked, then done, and the bot leaves
    await press(owner, dm, menu.id, `x:${-group}:un`);
    expect(((await dmMessages()).find((m) => m.id === menu.id)!).text).toContain('Отключить группу «Семья»?');
    expect(getCfg(-group)).toBeTruthy();
    await press(owner, dm, menu.id, `x:${-group}:unc`);
    expect(getCfg(-group)).toBeUndefined();
    expect(((await dmMessages()).find((m) => m.id === menu.id)!).text).toContain('У вас нет подключённых групп');
    await waitFor(async () => {
      const members = (await owner.req('GET', `/api/chats/${group}/members`)).body as any[];
      return !members.some((m) => m.user?.id === botId || m.id === botId);
    });
  });

  it('forgets a group when it is removed from it', async () => {
    const owner = await register('wx_gowner2');
    const botId = (await owner.req('GET', '/api/resolve/WeatherBot')).body.user.id as number;
    const group = (await owner.req('POST', '/api/chats/group', { title: 'Работа', memberIds: [] })).body.id as number;
    await owner.req('POST', `/api/chats/${group}/members`, { userIds: [botId] });
    await waitFor(() => getCfg(-group));
    expect((await owner.req('POST', `/api/chats/${group}/members/${botId}/kick`)).status).toBe(200);
    await waitFor(() => !getCfg(-group));
    expect(allCfgs().some((c) => c.key === -group)).toBe(false);
  });
});

// ---------- cities ----------

describe('the cities', () => {
  const labels = (q: string) => searchLocal(q).map((c) => c.label);

  it('has Russia down to small towns and finds cities the way people write them', () => {
    const all = allCities();
    expect(all.filter((c) => c.cc === 'RU').length).toBeGreaterThan(4500);
    expect(all.length).toBeGreaterThan(7000);
    expect(labels('архангельск')[0]).toBe('Архангельск, Архангельская область');
    expect(labels('Орел')[0]).toContain('Орёл'); // «е» finds «ё»
    expect(labels('ростов-на-дону')[0]).toContain('Ростов-на-Дону');
    expect(labels('ростов на дону')[0]).toContain('Ростов-на-Дону');
    expect(labels('Нижний')[0]).toContain('Нижний Новгород');
    expect(labels('новгород').some((l) => l?.startsWith('Великий Новгород'))).toBe(true); // a word inside the name
    expect(labels('питер')[0]).toBe('Санкт-Петербург');
    expect(labels('спб')[0]).toBe('Санкт-Петербург');
    expect(labels('Moscow')[0]).toBe('Москва');
    expect(labels('нью-йорк')[0]).toBe('Нью-Йорк, США');
    expect(labels('минск')[0]).toBe('Минск, Беларусь');
    // many places of one name: the region tells them apart
    expect(labels('никольское').length).toBeGreaterThan(3);
    expect(labels('никольское ленинградская')[0]).toBe('Никольское, Ленинградская область');
    expect(searchLocal('х')).toEqual([]);
    expect(searchLocal('   ')).toEqual([]);
    expect(searchLocal('абырвалг')).toEqual([]);
  });

  it('knows the main cities of every part of the country, each with its own time zone', () => {
    const zone = (name: string) => searchLocal(name)[0]!;
    for (const [name, tz] of [
      ['Калининград', 'Europe/Kaliningrad'], ['Москва', 'Europe/Moscow'], ['Мурманск', 'Europe/Moscow'], ['Сыктывкар', 'Europe/Moscow'],
      ['Самара', 'Europe/Samara'], ['Екатеринбург', 'Asia/Yekaterinburg'], ['Омск', 'Asia/Omsk'], ['Новосибирск', 'Asia/Novosibirsk'],
      ['Красноярск', 'Asia/Krasnoyarsk'], ['Иркутск', 'Asia/Irkutsk'], ['Якутск', 'Asia/Yakutsk'], ['Владивосток', 'Asia/Vladivostok'],
      ['Магадан', 'Asia/Magadan'], ['Петропавловск-Камчатский', 'Asia/Kamchatka'], ['Анадырь', 'Asia/Anadyr'],
      ['Нарьян-Мар', 'Europe/Moscow'], ['Северодвинск', 'Europe/Moscow'], ['Южно-Сахалинск', 'Asia/Sakhalin'], ['Норильск', 'Asia/Krasnoyarsk'],
    ] as const) {
      expect(zone(name), name).toMatchObject({ name, tz, cc: 'RU' });
    }
  });

  it('every city has a place on the map and a time zone the server understands', () => {
    for (const c of allCities()) {
      expect(c.lat >= -90 && c.lat <= 90 && c.lon >= -180 && c.lon <= 180, c.label).toBe(true);
      expect(() => localTime(0, c.tz), `${c.label}: ${c.tz}`).not.toThrow();
    }
  });

  it('reads the clock of a time zone, with daylight saving time', () => {
    expect(localTime(Date.UTC(2026, 6, 1, 12), 'Europe/Berlin').time).toBe('14:00');
    expect(localTime(Date.UTC(2026, 0, 1, 12), 'Europe/Berlin').time).toBe('13:00');
    expect(localTime(Date.UTC(2026, 9, 6, 21, 30), 'Asia/Vladivostok')).toMatchObject({ date: '2026-10-07', time: '07:30', weekday: 2 });
    expect(localTime(Date.UTC(2026, 9, 6, 21, 30), 'Europe/Moscow')).toMatchObject({ date: '2026-10-07', time: '00:30' });
    expect(localTime(Date.UTC(2026, 9, 6, 1, 0), 'America/New_York')).toMatchObject({ date: '2026-10-05', time: '21:00' });
  });

  it('asks the geocoder when the list has few answers, and shrugs when it is down', async () => {
    deps.fetch = fakeServices({
      geocoder: {
        results: [
          { id: 1111111, name: 'Выдуманск', latitude: 10.5, longitude: 20.25, timezone: 'Asia/Almaty', country_code: 'KZ', country: 'Казахстан', admin1: 'Тихая область', feature_code: 'PPL', population: 5 },
          { id: 2222222, name: 'Выдуманская гора', latitude: 1, longitude: 2, timezone: 'Asia/Almaty', country_code: 'KZ', country: 'Казахстан', feature_code: 'MT' },
          { id: 3333333, name: 'Без пояса', latitude: 1, longitude: 2, country_code: 'KZ', feature_code: 'PPL' },
        ],
      },
    });
    const found = await findCities('Выдуманск');
    expect(found.map((c) => c.label)).toEqual(['Выдуманск, Тихая область, Казахстан']);
    expect(cityById(1111111)).toMatchObject({ lat: 10.5, lon: 20.25, tz: 'Asia/Almaty' });
    // the list answers alone when it has enough: the geocoder is not asked
    const calls: string[] = [];
    deps.fetch = fakeServices({ calls });
    expect((await findCities('никольское')).length).toBeGreaterThan(3);
    expect(calls).toEqual([]);
    deps.fetch = fakeServices({ geocoder: 'fail' });
    expect(await findCities('абырвалг')).toEqual([]);
  });
});

describe('choosing the city', () => {
  it('asks first, searches by name, offers the choice and remembers it', async () => {
    const calls: string[] = [];
    deps.fetch = fakeServices({ calls });
    const p = await person('wx_city', null);
    await p.say('/weather');
    expect((await p.botSays(1)).text).toContain('Для начала выберите город');
    expect(calls).toEqual([]); // no forecast for a place nobody named
    await p.say('абырвалг');
    expect((await p.botSays(2)).text).toContain('Не нашёл город «абырвалг»');
    expect(getCfg(p.u.id)!.city).toBeNull();
    await p.say('никольское');
    const many = await p.botSays(3);
    expect(p.buttons(many).length).toBeGreaterThan(3);
    await p.say('казань');
    const pick = await p.botSays(4);
    const kazan = cityById(551487)!;
    expect(p.buttons(pick)[0]).toMatchObject({ text: 'Казань, Республика Татарстан', callbackData: `x:${p.u.id}:cs:551487` });
    await p.press(pick.id, `x:${p.u.id}:cs:551487`);
    expect(getCfg(p.u.id)!.city).toMatchObject({ id: 551487, name: 'Казань', lat: kazan.lat, lon: kazan.lon, tz: 'Europe/Moscow' });
    expect((await p.lastBot()).text).toContain('Погода — Казань');
    // the old list does not work any more: the choice is made
    await p.say('/weather');
    expect((await p.botSays(5)).text).toContain('Казань — сегодня');
    expect(calls.some((u) => u.includes(`lat=${kazan.lat}&lon=${kazan.lon}`))).toBe(true);
    // a text after that is just a text
    await p.say('спасибо');
    await new Promise((r) => setTimeout(r, 200));
    expect(await p.count()).toBe(5);
  });

  it('takes a city that only the geocoder knows', async () => {
    deps.fetch = fakeServices({
      geocoder: { results: [{ id: 1111112, name: 'Тихогорск', latitude: 50.5, longitude: 60.25, timezone: 'Asia/Aqtobe', country_code: 'KZ', country: 'Казахстан', admin1: 'Тихая область', feature_code: 'PPLA2', population: 900 }] },
    });
    const p = await person('wx_online', null);
    await p.say('/city Тихогорск');
    const pick = await p.botSays(1);
    expect(p.buttons(pick).map((b) => b.text)).toEqual(['Тихогорск, Тихая область, Казахстан']);
    await p.press(pick.id, p.buttons(pick)[0]!.callbackData);
    expect(getCfg(p.u.id)!.city).toMatchObject({ id: 1111112, name: 'Тихогорск', tz: 'Asia/Aqtobe', lat: 50.5, lon: 60.25 });
  });

  it('changes the city from the settings, and the mailing follows the clock of the new one', async () => {
    const p = await person('wx_move');
    await p.say('/start');
    const menu = await p.botSays(1);
    await p.press(menu.id, `x:${p.u.id}:ci`);
    expect((await p.botSays(2)).text).toContain('Напишите название города');
    await p.say('владивосток');
    const pick = await p.botSays(3);
    await p.press(pick.id, `x:${p.u.id}:cs:2013348`);
    expect(getCfg(p.u.id)!.city).toMatchObject({ name: 'Владивосток', tz: 'Asia/Vladivostok' });
    const screen = await p.lastBot();
    expect(screen.id).toBe(pick.id);
    expect(screen.text).toContain('Город: Владивосток, Приморский край');
    // a command in place of the name cancels the question
    await p.press(menu.id, `x:${p.u.id}:ci`);
    await p.botSays(4);
    await p.say('/week');
    expect((await p.botSays(5)).text).toContain('Владивосток — на неделю');
    await p.say('москва');
    await new Promise((r) => setTimeout(r, 200));
    expect(getCfg(p.u.id)!.city!.name).toBe('Владивосток');
    expect(await p.count()).toBe(5);
  });

  it('shows the forecast of the chosen place, on its own clock', async () => {
    const calls: string[] = [];
    deps.fetch = fakeServices({ metno: metno(), calls });
    const vl: Place = { id: 2013348, name: 'Владивосток', lat: 43.1056, lon: 131.8735, tz: 'Asia/Vladivostok' };
    const p = await person('wx_vlad', vl);
    await p.say('/details');
    const details = await p.botSays(1);
    expect(details.text).toContain('Владивосток — сегодня');
    expect(calls.some((u) => u.includes('locationforecast') && u.includes('lat=43.1056&lon=131.8735'))).toBe(true);
    expect(calls.some((u) => u.includes('sunrise') && u.includes('offset=%2B10:00'))).toBe(true);
    // the forecast is kept per place: another city is another request
    const before = calls.length;
    const q = await person('wx_msk_again');
    await q.say('/weather');
    await q.botSays(1);
    expect(calls.length).toBeGreaterThan(before);
    expect(calls.slice(before).some((u) => u.includes('lat=64.5461&lon=40.5518'))).toBe(true);
  });
});

describe('the mailing of several cities', () => {
  it('sends to each chat at the time of its own city and skips the chats that have no city', async () => {
    const msk = await person('wx_tz_msk');
    const vl = await person('wx_tz_vl', { id: 2013348, name: 'Владивосток', lat: 43.1056, lon: 131.8735, tz: 'Asia/Vladivostok' });
    saveCfg({ ...newCfg(-777001, 'group', 'Без города'), time: '00:00' });
    const day = Math.floor(Date.now() / DAY) * DAY;

    // 22:30 UTC: 08:30 in Владивосток (UTC+10), 01:30 in Архангельск
    deps.now = () => day - 90 * 60_000;
    await tickWeather();
    const mail = await vl.botSays(1);
    expect(mail.text).toContain('Владивосток — сегодня');
    expect(await msk.count()).toBe(0);
    expect(getCfg(vl.u.id)!.lastSent).toBe(localTime(deps.now(), 'Asia/Vladivostok').date);
    expect(getCfg(-777001)!.lastSent).toBeNull();

    // 05:01 UTC: 08:01 in Архангельск; Владивосток has had its mailing today, and it is 15:01 there
    deps.now = () => day + 5 * 3600_000 + 60_000;
    await tickWeather();
    expect((await msk.botSays(1)).text).toContain('Архангельск — сегодня');
    await new Promise((r) => setTimeout(r, 150));
    expect(await vl.count()).toBe(1);
    db.prepare('DELETE FROM weather_chats WHERE chat_key = ?').run(-777001);
  });

  it('does not stop the others when one city has no forecast', async () => {
    const msk = await person('wx_tz_ok');
    const bad = await person('wx_tz_bad', { id: 5555555, name: 'Глухомань', lat: 1, lon: 1, tz: 'Europe/Moscow' });
    const day = Math.floor(Date.now() / DAY) * DAY;
    deps.now = () => day + 5 * 3600_000 + 60_000; // 08:01 on the clock of both
    const fine = fakeServices();
    deps.fetch = (async (url: string, init?: RequestInit) => (url.includes('latitude=1&') || url.includes('lat=1&') ? new Response('no', { status: 503 }) : fine(url, init))) as typeof deps.fetch;
    await tickWeather();
    expect((await msk.botSays(1)).text).toContain('Архангельск — сегодня');
    expect(await bad.count()).toBe(0);
    expect(getCfg(bad.u.id)!.lastSent).toBeNull(); // it is tried again at the next round
  });
});

// ---------- the subscribers of the old bot ----------

describe('taking over the data of the old weather bot', () => {
  const settings = (over: Record<string, unknown> = {}) => ({
    type: 'private',
    manager_id: null,
    manager_username: null,
    enabled: true,
    time: '07:15',
    level: 3,
    fields: { temp: true, feels: false, precip: true, wind: true, humidity: true, pressure: false, uv: true, sun: true },
    last_sent: null,
    ...over,
  });

  it('keeps the settings, gives the bot a chat with the person and a place in the group, and starts mailing', async () => {
    const person = await register('imp_person');
    const owner = await register('imp_owner');
    const group = (await owner.req('POST', '/api/chats/group', { title: 'Семья', memberIds: [] })).body.id as number;
    const botId = (await owner.req('GET', '/api/resolve/WeatherBot')).body.user.id as number;
    expect(((await owner.req('GET', `/api/chats/${group}/members`)).body as any[]).some((m) => (m.user?.id ?? m.id) === botId)).toBe(false);

    const result = importWeatherData({
      chats: {
        [String(person.id)]: settings({ title: 'imp_person' }),
        [String(-group)]: settings({ type: 'group', title: 'семья', manager_id: owner.id, manager_username: 'imp_owner', time: '06:00', level: 1 }),
      },
    });
    expect(result.skipped).toEqual([]);
    expect(result.imported.sort()).toEqual([String(-group), String(person.id)].sort());
    expect(getCfg(person.id)).toMatchObject({
      type: 'private', title: 'imp_person', enabled: true, time: '07:15', level: 3,
      fields: { temp: true, feels: false, precip: true, wind: true, humidity: true, pressure: false, uv: true, sun: true },
    });
    expect(getCfg(-group)).toMatchObject({ type: 'group', title: 'Семья', managerId: owner.id, managerUsername: 'imp_owner', time: '06:00', level: 1 });

    // the person has a chat with the bot, the bot is in the group
    expect(((await person.req('GET', '/api/chats')).body as any[]).some((c) => c.peer?.id === botId)).toBe(true);
    await waitFor(async () => ((await owner.req('GET', `/api/chats/${group}/members`)).body as any[]).some((m) => (m.user?.id ?? m.id) === botId));

    // and the mailing reaches both
    const midnight = Math.floor((Date.now() + 3 * 3600_000) / 86400_000) * 86400_000 - 3 * 3600_000;
    deps.now = () => midnight + 8 * 3600_000;
    await tickWeather();
    const inGroup = await waitFor(async () => ((await owner.req('GET', `/api/chats/${group}/messages?limit=50`)).body as any[]).find((m) => m.senderId === botId && m.text.includes('Архангельск — сегодня')));
    expect(inGroup.text).toContain('+3°…+9°'); // «Кратко»: one line
    const chat = ((await person.req('GET', '/api/chats')).body as any[]).find((c) => c.peer?.id === botId);
    const mail = await waitFor(async () => ((await person.req('GET', `/api/chats/${chat.id}/messages?limit=50`)).body as any[]).find((m) => m.senderId === botId));
    expect(mail.text).toContain('По времени суток');
    expect(mail.text).toContain('Влажность: 80%');
  });

  it('refuses what does not fit this messenger, repairs bad values and leaves known chats alone', async () => {
    const person = await register('imp_other');
    const owner = await register('imp_owner2');
    const group = (await owner.req('POST', '/api/chats/group', { title: 'Работа', memberIds: [] })).body.id as number;
    const known = await register('imp_known');
    importWeatherData({ chats: { [String(known.id)]: settings({ title: 'imp_known', time: '09:00' }) } });

    const result = importWeatherData({
      chats: {
        '99999': settings({ title: 'Никого' }),
        [String(-group)]: settings({ type: 'group', title: 'Не та группа' }),
        '-99999': settings({ type: 'group', title: 'Нет такой' }),
        [String(known.id)]: settings({ title: 'imp_known', time: '11:00' }),
        abc: settings(),
      },
    });
    expect(result.imported).toEqual([]);
    expect(result.skipped.map((s) => s.key).sort()).toEqual(['99999', String(-group), '-99999', String(known.id), 'abc'].sort());
    expect(result.skipped.find((s) => s.key === String(-group))!.why).toMatch(/название не совпадает/);
    expect(getCfg(-group)).toBeUndefined();
    expect(getCfg(known.id)!.time).toBe('09:00');

    // a person whose name differs is taken, with a warning
    const renamed = importWeatherData({ chats: { [String(person.id)]: settings({ title: 'Кирилл Резаев' }) } });
    expect(renamed.imported).toEqual([String(person.id)]);
    expect(renamed.warnings[0]).toMatchObject({ key: String(person.id) });
    expect(renamed.warnings[0]!.text).toContain('Кирилл Резаев');
    expect(getCfg(person.id)!.title).toBe('imp_other');

    // bad values become the usual ones; a manager who is not in the group is not made one
    const fixed = await register('imp_fixed');
    importWeatherData({ chats: { [String(fixed.id)]: { title: 'imp_fixed', time: '25:99', level: 7, fields: { temp: 'yes', nonsense: true, wind: false }, last_sent: 'вчера', enabled: false } } });
    expect(getCfg(fixed.id)).toMatchObject({ time: '08:00', level: 2, enabled: false, lastSent: null, fields: { temp: true, wind: false } });
    const g2 = (await owner.req('POST', '/api/chats/group', { title: 'Клуб', memberIds: [] })).body.id as number;
    importWeatherData({ chats: { [String(-g2)]: settings({ type: 'group', title: 'Клуб', manager_id: person.id }) } });
    expect(getCfg(-g2)).toMatchObject({ type: 'group', managerId: null });
  });

  it('reads the file once and not again', async () => {
    const user = await register('imp_once');
    const file = path.join(tmp, 'weather_once.json');
    fs.writeFileSync(file, JSON.stringify({ chats: { [String(user.id)]: settings({ title: 'imp_once', time: '10:00' }) } }));
    expect(importWeatherSeed(file)?.imported).toEqual([String(user.id)]);
    expect(getCfg(user.id)!.time).toBe('10:00');
    // the person blocks the bot; the next start does not bring the mailing back
    db.prepare('DELETE FROM weather_chats WHERE chat_key = ?').run(user.id);
    expect(importWeatherSeed(file)).toBeNull();
    expect(getCfg(user.id)).toBeUndefined();
    // the file that comes with the server is not read by the tests, and a missing one is no error
    expect(importWeatherSeed()).toBeNull();
  });

  it('the shipped file is the old bot\'s data: a private chat and a group', () => {
    const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, '../seed/weather_data.json'), 'utf8'));
    expect(Object.keys(shipped.chats).sort()).toEqual(['-6', '1']);
    expect(shipped.chats['-6']).toMatchObject({ type: 'group', title: 'Семья', level: 3 });
    expect(JSON.stringify(shipped)).not.toMatch(/\d+:[A-Za-z0-9_-]{30,}/); // no token inside
  });
});
