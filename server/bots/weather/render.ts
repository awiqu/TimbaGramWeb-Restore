import { type LocalTime, type Place, type Weather, deps, getWeather, localTime, modeCode } from './data.js';

/** How a forecast is written down (HTML: <b>, <i>, <code>). */

export const FIELDS: Record<string, string> = {
  temp: '🌡 Температура',
  feels: '🤔 Ощущается',
  precip: '🌧 Осадки',
  wind: '💨 Ветер',
  humidity: '💧 Влажность',
  pressure: '🧭 Давление',
  uv: '🔆 УФ-индекс',
  sun: '🌇 Восход и закат',
};
export const DEFAULT_FIELDS: Record<string, boolean> = {
  temp: true, feels: true, precip: true, wind: true, humidity: false, pressure: false, uv: false, sun: false,
};
export const LEVELS: Record<number, string> = { 1: 'Кратко', 2: 'Стандарт', 3: 'Подробно' };

/** weather codes (WMO) -> (icon, description) */
const WEATHER_CODES: Record<number, [string, string]> = {
  0: ['☀️', 'ясно'], 1: ['🌤', 'преимущественно ясно'], 2: ['⛅', 'переменная облачность'], 3: ['☁️', 'пасмурно'],
  45: ['🌫', 'туман'], 48: ['🌫', 'изморозевый туман'],
  51: ['🌦', 'слабая морось'], 53: ['🌦', 'морось'], 55: ['🌧', 'сильная морось'],
  56: ['🌧', 'ледяная морось'], 57: ['🌧', 'сильная ледяная морось'],
  61: ['🌦', 'небольшой дождь'], 63: ['🌧', 'дождь'], 65: ['🌧', 'сильный дождь'],
  66: ['🌧', 'ледяной дождь'], 67: ['🌧', 'сильный ледяной дождь'],
  68: ['🌨', 'дождь со снегом'], 69: ['🌨', 'сильный дождь со снегом'],
  71: ['🌨', 'небольшой снег'], 73: ['🌨', 'снег'], 75: ['❄️', 'сильный снег'], 77: ['🌨', 'снежная крупа'],
  80: ['🌦', 'небольшие ливни'], 81: ['🌧', 'ливни'], 82: ['⛈', 'сильные ливни'],
  85: ['🌨', 'снегопад'], 86: ['❄️', 'сильный снегопад'],
  95: ['⛈', 'гроза'], 96: ['⛈', 'гроза с градом'], 99: ['⛈', 'сильная гроза с градом'],
};
const PARTS: [string, number, number][] = [['🌙 Ночь', 0, 6], ['🌅 Утро', 6, 12], ['☀️ День', 12, 18], ['🌆 Вечер', 18, 24]];
const WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const COMPASS = ['С', 'СВ', 'В', 'ЮВ', 'Ю', 'ЮЗ', 'З', 'СЗ'];

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Python's round(): halves go to the even number, so «+2,5°» reads as «+2°», like in the original bot. */
export function pyRound(x: number): number {
  const r = Math.round(x);
  return (Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r) || 0; // no «-0»
}

const codeInfo = (code: number | null): [string, string] => (code === null ? ['🌡', 'погода'] : (WEATHER_CODES[code] ?? ['🌡', 'погода']));

type Num = number | null;
const vals = (xs: Num[], ks: number[]) => ks.map((k) => xs[k]).filter((x): x is number => x !== null && x !== undefined);
const hoursOf = (w: Weather, date: string) => w.hourly.time.flatMap((t, k) => (t.startsWith(date) ? [k] : []));

interface Day {
  date: string;
  code: number;
  tmax: number;
  tmin: number;
  fmax: number;
  fmin: number;
  precip: number;
  snow: number;
  pop: number | null;
  wind: number;
  gust: number | null;
  dir: number | null;
  uv: number | null;
  sunrise: string | null;
  sunset: string | null;
  humidity: number | null;
  pressure: number | null;
  hours: number[];
}

/** Everything about day №i (0 is today), in a handy form. */
function dayData(w: Weather, i: number): Day {
  const d = w.daily;
  const h = w.hourly;
  const date = d.time[i]!;
  const ks = hoursOf(w, date);
  const humidity = vals(h.relative_humidity_2m, ks);
  const pressure = vals(h.surface_pressure, ks);
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    date,
    code: d.weather_code[i]!,
    tmax: d.temperature_2m_max[i]!,
    tmin: d.temperature_2m_min[i]!,
    fmax: d.apparent_temperature_max[i]!,
    fmin: d.apparent_temperature_min[i]!,
    precip: d.precipitation_sum[i] || 0,
    snow: d.snowfall_sum[i] || 0,
    pop: d.precipitation_probability_max[i] ?? null,
    wind: d.wind_speed_10m_max[i]!,
    gust: d.wind_gusts_10m_max[i] ?? null,
    dir: d.wind_direction_10m_dominant[i] ?? null,
    uv: d.uv_index_max[i] ?? null,
    sunrise: (d.sunrise[i] || '').slice(11, 16) || null,
    sunset: (d.sunset[i] || '').slice(11, 16) || null,
    humidity: humidity.length ? pyRound(avg(humidity)) : null,
    pressure: pressure.length ? pyRound(avg(pressure) * 0.750062) : null,
    hours: ks,
  };
}

interface Part {
  name: string;
  tmin: number;
  tmax: number;
  precip: number;
  pop: number | null;
  wind: number | null;
  code: number;
}

/** Night / morning / day / evening; for today only what is still ahead. */
function dayParts(w: Weather, d: Day, fromHour = 0): Part[] {
  const h = w.hourly;
  const out: Part[] = [];
  for (const [name, start, end] of PARTS) {
    const ks = d.hours.filter((k) => {
      const hour = Number(h.time[k]!.slice(11, 13));
      return hour >= start && hour < end && hour >= fromHour;
    });
    const temps = vals(h.temperature_2m, ks);
    if (!temps.length) continue;
    const winds = vals(h.wind_speed_10m, ks);
    const pops = vals(h.precipitation_probability, ks);
    out.push({
      name,
      tmin: Math.min(...temps),
      tmax: Math.max(...temps),
      precip: vals(h.precipitation, ks).reduce((a, b) => a + b, 0),
      pop: pops.length ? Math.max(...pops) : null,
      wind: winds.length ? Math.max(...winds) : null,
      code: modeCode(vals(h.weather_code, ks)),
    });
  }
  return out;
}

// ---------- the little formatters ----------

export function temp(value: number): string {
  const r = pyRound(value);
  return r === 0 ? '0°' : `${r > 0 ? '+' : '−'}${Math.abs(r)}°`;
}
const tempRange = (lo: number, hi: number) => (pyRound(lo) === pyRound(hi) ? temp(lo) : `${temp(lo)}…${temp(hi)}`);

export function mm(value: number): string {
  if (value <= 0) return '0';
  if (value < 0.1) return '&lt;0,1';
  return value.toFixed(1).replace(/0+$/, '').replace(/\.$/, '').replace('.', ',');
}
const compass = (deg: number | null) => (deg === null ? '' : COMPASS[pyRound(deg / 45) % 8]!);

function uvName(v: number): string {
  for (const [limit, name] of [[3, 'низкий'], [6, 'умеренный'], [8, 'высокий'], [11, 'очень высокий']] as const) if (v < limit) return name;
  return 'экстремальный';
}

function daylight(d: Day): string {
  const [ah, am] = d.sunrise!.split(':').map(Number) as [number, number];
  const [bh, bm] = d.sunset!.split(':').map(Number) as [number, number];
  const minutes = bh * 60 + bm - (ah * 60 + am);
  return `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
}

function dateLabel(date: string): string {
  const [y, m, day] = date.split('-').map(Number) as [number, number, number];
  const weekday = (new Date(Date.UTC(y, m - 1, day)).getUTCDay() + 6) % 7;
  return `${WEEKDAYS[weekday]}, ${day} ${MONTHS[m - 1]}`;
}

const dayTitle = (i: number, date: string) => `${({ 0: 'сегодня', 1: 'завтра' } as Record<number, string>)[i] ?? 'день'} (${dateLabel(date)})`;

function precipText(d: Day): string {
  if (d.precip <= 0 && (d.pop ?? 0) < 20) return 'без осадков';
  let text = d.precip > 0 ? `${mm(d.precip)} мм` : 'возможны';
  if (d.snow > 0) text += ` (снег ${mm(d.snow)} см)`;
  if (d.pop !== null) text += `, вероятность до ${d.pop}%`;
  return text;
}

/** «label: value» for the detailed view. */
function fieldLine(key: string, d: Day): string | null {
  if (key === 'temp') return `🌡 Температура: ${tempRange(d.tmin, d.tmax)}`;
  if (key === 'feels') return `🤔 Ощущается: ${tempRange(d.fmin, d.fmax)}`;
  if (key === 'precip') return `🌧 Осадки: ${precipText(d)}`;
  if (key === 'wind') {
    const gust = d.gust && d.gust - d.wind >= 3 ? `, порывы до ${pyRound(d.gust)} м/с` : '';
    return `💨 Ветер: до ${pyRound(d.wind)} м/с ${compass(d.dir)}${gust}`.replace('  ', ' ');
  }
  if (key === 'humidity' && d.humidity !== null) return `💧 Влажность: ${d.humidity}%`;
  if (key === 'pressure' && d.pressure !== null) return `🧭 Давление: ${d.pressure} мм рт. ст.`;
  if (key === 'uv' && d.uv !== null) return `🔆 УФ-индекс: ${pyRound(d.uv)} (${uvName(d.uv)})`;
  if (key === 'sun' && d.sunrise && d.sunset) return `🌇 Восход ${d.sunrise}, закат ${d.sunset} (день ${daylight(d)})`;
  return null;
}

/** The same thing, short: for the «Кратко» view. */
function fieldShort(key: string, d: Day): string | null {
  if (key === 'temp') return tempRange(d.tmin, d.tmax);
  if (key === 'feels') return `ощущается ${tempRange(d.fmin, d.fmax)}`;
  if (key === 'precip') return d.precip > 0 ? `осадки ${mm(d.precip)} мм` : 'без осадков';
  if (key === 'wind') return `ветер ${pyRound(d.wind)} м/с ${compass(d.dir)}`.trim();
  if (key === 'humidity' && d.humidity !== null) return `влажность ${d.humidity}%`;
  if (key === 'pressure' && d.pressure !== null) return `${d.pressure} мм рт. ст.`;
  if (key === 'uv' && d.uv !== null) return `УФ ${pyRound(d.uv)}`;
  if (key === 'sun' && d.sunrise && d.sunset) return `🌇 ${d.sunrise}–${d.sunset}`;
  return null;
}

function partLine(p: Part, fields: Record<string, boolean>): string {
  const [emoji] = codeInfo(p.code);
  const bits = [tempRange(p.tmin, p.tmax)];
  if (fields.precip && p.precip > 0) bits.push(`осадки ${mm(p.precip)} мм`);
  if (fields.wind && p.wind !== null) bits.push(`ветер ${pyRound(p.wind)} м/с`);
  return `${p.name}: ${emoji} ${bits.join(', ')}`;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface Look {
  level: number;
  fields: Record<string, boolean>;
  place: Place;
}

/** The weather for day №i in the chat's own way (level and fields may be replaced). */
export function renderDay(w: Weather, i: number, cfg: Look, now: LocalTime = localTime(deps.now(), cfg.place.tz)): string {
  const d = dayData(w, i);
  const [emoji, text] = codeInfo(d.code);
  const head = `${emoji} <b>${escapeHtml(cfg.place.name)} — ${dayTitle(i, d.date)}</b>`;
  const keys = Object.keys(FIELDS).filter((k) => cfg.fields[k]);
  if (cfg.level === 1) return `${head}\n${[capitalize(text), ...keys.map((k) => fieldShort(k, d)).filter(Boolean)].join(' · ')}`;
  const lines = [head, capitalize(text), ...(keys.map((k) => fieldLine(k, d)).filter(Boolean) as string[])];
  if (cfg.level === 3) {
    const parts = dayParts(w, d, i === 0 ? now.hour : 0);
    if (parts.length) lines.push('', '<b>По времени суток</b>', ...parts.map((p) => partLine(p, cfg.fields)));
  }
  return lines.join('\n');
}

export function renderWeek(w: Weather, place: Place): string {
  const lines = [`📅 <b>${escapeHtml(place.name)} — на неделю</b>`];
  for (let i = 0; i < w.daily.time.length; i++) {
    const d = dayData(w, i);
    const [emoji] = codeInfo(d.code);
    const bits = [tempRange(d.tmin, d.tmax)];
    if (d.precip > 0) bits.push(`${mm(d.precip)} мм`);
    bits.push(`ветер ${pyRound(d.wind)} м/с ${compass(d.dir)}`.trim());
    const [weekday, date] = dateLabel(d.date).split(', ') as [string, string];
    lines.push(`<b>${capitalize(weekday)}, ${date}</b>  ${emoji} ${bits.join(' · ')}`);
  }
  return lines.join('\n');
}

/** Everything known about a day: the figures, the parts of the day and the forecast by hours. */
export function renderDetails(w: Weather, i: number, place: Place, now: LocalTime = localTime(deps.now(), place.tz)): string {
  const allFields = Object.fromEntries(Object.keys(FIELDS).map((k) => [k, true]));
  const full = renderDay(w, i, { level: 3, fields: allFields, place }, now);
  const nl = full.indexOf('\n');
  const lines = [full.slice(0, nl), full.slice(nl + 1)];
  if (i === 0) {
    const c = w.current;
    const [emoji, text] = codeInfo(c.weather_code);
    lines.splice(1, 0, `<i>Сейчас: ${emoji} ${temp(c.temperature_2m)}, ощущается ${temp(c.apparent_temperature)}, ${text}, ветер ${pyRound(c.wind_speed_10m)} м/с ${compass(c.wind_direction_10m)}</i>`);
  }
  const h = w.hourly;
  const hourly: string[] = [];
  for (const k of hoursOf(w, w.daily.time[i]!)) {
    const hour = Number(h.time[k]!.slice(11, 13));
    if (hour % 3 || (i === 0 && hour <= now.hour - 3)) continue;
    if (h.temperature_2m[k] === null) continue;
    const [emoji] = codeInfo(h.weather_code[k] ?? null);
    const bits = [temp(h.temperature_2m[k]!)];
    if (h.precipitation_probability[k] !== null) bits.push(`${h.precipitation_probability[k]}%`);
    if (h.wind_speed_10m[k] !== null) bits.push(`${pyRound(h.wind_speed_10m[k]!)} м/с`);
    hourly.push(`${String(hour).padStart(2, '0')}:00  ${emoji} ${bits.join(' · ')}`);
  }
  if (hourly.length) {
    const legend = h.precipitation_probability.some((p) => p !== null) ? 'температура · вероятность осадков · ветер' : 'температура · ветер';
    lines.push('', `<b>По часам</b>  (${legend})`, ...hourly);
  }
  return lines.join('\n');
}

export type View = 'today' | 'tomorrow' | 'week' | 'details' | 'details1';

export async function renderView(view: View, cfg: Look): Promise<string> {
  const w = await getWeather(cfg.place);
  if (view === 'today') return renderDay(w, 0, cfg);
  if (view === 'tomorrow') return renderDay(w, 1, cfg);
  if (view === 'week') return renderWeek(w, cfg.place);
  return renderDetails(w, view === 'details1' ? 1 : 0, cfg.place);
}
