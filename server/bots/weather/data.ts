/**
 * The weather itself. The main source is MET Norway (api.met.no), the spare one is Open-Meteo: both are free, need no
 * key and give real forecasts. Whatever answers is turned into one shape (the one Open-Meteo returns), and the
 * rest of the bot works on that.
 */

/** A place the forecast is asked for: where it is and which clock its people live by. */
export interface Place {
  /** GeoNames id: the same one in the built-in list and in the Open-Meteo geocoder */
  id: number;
  name: string;
  /** «Никольское, Вологодская область»: to tell places of one name apart */
  label?: string;
  lat: number;
  lon: number;
  /** IANA name: «Europe/Moscow» */
  tz: string;
}

/** The first city of the bot: what the chats that subscribed before the choice of the city existed have. */
export const ARKHANGELSK: Place = { id: 581049, name: 'Архангельск', label: 'Архангельск, Архангельская область', lat: 64.5461, lon: 40.5518, tz: 'Europe/Moscow' };

const HOUR = 3600_000;
const DAY = 24 * HOUR;

const WEATHER_TTL = 600_000; // the forecast is kept for 10 minutes
const STALE_TTL = 7200_000; // and when the services are down, a forecast up to 2 hours old is still shown
const RETRY_AFTER_FAILURE = 30_000;
const TIMEOUT_MS = 15_000;
const HEADERS = { 'User-Agent': 'TimbaGramWeatherBot/1.0 (https://timgram.ru)' };

export class WeatherError extends Error {}

type Num = number | null;

export interface Weather {
  hourly: {
    time: string[];
    temperature_2m: Num[];
    apparent_temperature: Num[];
    precipitation_probability: Num[];
    precipitation: Num[];
    weather_code: Num[];
    wind_speed_10m: Num[];
    wind_gusts_10m: Num[];
    wind_direction_10m: Num[];
    relative_humidity_2m: Num[];
    surface_pressure: Num[];
    uv_index?: Num[];
  };
  daily: {
    time: string[];
    weather_code: Num[];
    temperature_2m_max: Num[];
    temperature_2m_min: Num[];
    apparent_temperature_max: Num[];
    apparent_temperature_min: Num[];
    sunrise: (string | null)[];
    sunset: (string | null)[];
    uv_index_max: Num[];
    precipitation_sum: Num[];
    snowfall_sum: Num[];
    precipitation_probability_max: Num[];
    wind_speed_10m_max: Num[];
    wind_gusts_10m_max: Num[];
    wind_direction_10m_dominant: Num[];
  };
  current: {
    temperature_2m: number;
    apparent_temperature: number;
    weather_code: number;
    wind_speed_10m: number;
    wind_direction_10m: number;
    relative_humidity_2m: number;
    surface_pressure: number;
  };
}

// ---------- time in a city ----------

export interface LocalTime {
  /** 2026-10-04 */
  date: string;
  /** 08:30 */
  time: string;
  hour: number;
  minutes: number;
  seconds: number;
  /** 0 = понедельник */
  weekday: number;
}

const formats = new Map<string, Intl.DateTimeFormat>();

/** What the clock of the time zone `tz` shows at the moment `ms` (daylight saving time included). */
export function localTime(ms: number, tz: string): LocalTime {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formats.set(tz, f);
  }
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(ms))) if (x.type !== 'literal') p[x.type] = Number(x.value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${String(p.year).padStart(4, '0')}-${pad(p.month!)}-${pad(p.day!)}`,
    time: `${pad(p.hour!)}:${pad(p.minute!)}`,
    hour: p.hour!,
    minutes: p.minute!,
    seconds: p.second!,
    weekday: (new Date(Date.UTC(p.year!, p.month! - 1, p.day!)).getUTCDay() + 6) % 7,
  };
}

/** How far the clock of `tz` is ahead of UTC at the moment `ms` */
function offsetMs(ms: number, tz: string): number {
  const l = localTime(ms, tz);
  const [y, m, d] = l.date.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d, l.hour, l.minutes, l.seconds) - Math.floor(ms / 1000) * 1000;
}

/** The moment the day that `ms` belongs to began in `tz` */
function localMidnight(ms: number, tz: string): number {
  const [y, m, d] = localTime(ms, tz).date.split('-').map(Number) as [number, number, number];
  const base = Date.UTC(y, m - 1, d);
  return base - offsetMs(base - offsetMs(ms, tz), tz);
}

const slotString = (ms: number, tz: string) => {
  const l = localTime(ms, tz);
  return `${l.date}T${String(l.hour).padStart(2, '0')}:00`;
};

/** «+05:30» */
function offsetString(ms: number, tz: string): string {
  const minutes = Math.round(offsetMs(ms, tz) / 60_000);
  const abs = Math.abs(minutes);
  return `${minutes < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

// ---------- what the bot may swap in the tests ----------

export const deps = {
  fetch: (url: string, init?: RequestInit) => globalThis.fetch(url, init),
  now: () => Date.now(),
};

async function getJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  const res = await deps.fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new WeatherError(`HTTP ${res.status}`);
  return res.json();
}

// ---------- MET Norway ----------

const METNO_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/complete';
const METNO_SUN_URL = 'https://api.met.no/weatherapi/sunrise/3.0/sun';
const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);
const METNO_SYMBOLS: Record<string, number> = {
  clearsky: 0, fair: 1, partlycloudy: 2, cloudy: 3, fog: 45,
  lightrain: 61, rain: 63, heavyrain: 65,
  lightrainshowers: 80, rainshowers: 81, heavyrainshowers: 82,
  lightsleet: 68, sleet: 68, heavysleet: 69,
  lightsleetshowers: 68, sleetshowers: 68, heavysleetshowers: 69,
  lightsnow: 71, snow: 73, heavysnow: 75,
  lightsnowshowers: 85, snowshowers: 85, heavysnowshowers: 86,
};
const HOURLY_NAMES = [
  'temperature_2m', 'apparent_temperature', 'precipitation_probability', 'precipitation', 'weather_code',
  'wind_speed_10m', 'wind_gusts_10m', 'wind_direction_10m', 'relative_humidity_2m', 'surface_pressure', 'uv_index',
] as const;
type HourlyName = (typeof HOURLY_NAMES)[number];
type Row = Partial<Record<HourlyName, Num>>;

/** The name of an icon of MET Norway («lightrain_day») -> a WMO weather code. */
export function metnoCode(symbol: string | undefined | null): number | null {
  if (!symbol) return null;
  let base = symbol.split('_')[0]!;
  const thunder = base.includes('andthunder');
  base = base.replace('andthunder', '');
  if (thunder) return base.startsWith('heavy') ? 99 : 95;
  return METNO_SYMBOLS[base] ?? 3;
}

interface Entry {
  when: number;
  data: any;
}

/** The values of the hour `slot` from one entry of the forecast (the first ~60 hours have an entry per hour, then one per 6 hours). */
function metnoHour(entry: Entry, slot: number): Row {
  const f = entry.data;
  const inst = f.instant.details;
  const one = f.next_1_hours;
  const six = f.next_6_hours;
  const twelve = f.next_12_hours;
  let block: any;
  let share: number;
  if (entry.when === slot && one) [block, share] = [one, 1];
  else if (six) [block, share] = [six, 6]; // the rain of 6 hours is shared out between them
  else [block, share] = [one ?? twelve, 1];
  const precip = block?.details?.precipitation_amount;
  return {
    temperature_2m: inst.air_temperature ?? null,
    apparent_temperature: inst.apparent_air_temperature ?? null,
    precipitation_probability: null,
    precipitation: precip !== undefined && precip !== null ? precip / share : null,
    weather_code: metnoCode(block?.summary?.symbol_code),
    wind_speed_10m: inst.wind_speed ?? null,
    wind_gusts_10m: null,
    wind_direction_10m: inst.wind_from_direction ?? null,
    relative_humidity_2m: inst.relative_humidity ?? null,
    surface_pressure: inst.air_pressure_at_sea_level ?? null,
    uv_index: inst.ultraviolet_index_clear_sky ?? null,
  };
}

const bisectRight = (xs: number[], x: number) => {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (x < xs[mid]!) hi = mid;
    else lo = mid + 1;
  }
  return lo;
};

const nums = (xs: Num[]) => xs.filter((x): x is number => x !== null);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function modeCode(codes: number[]): number {
  if (!codes.length) return 0;
  const counts = new Map<number, number>();
  for (const c of codes) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts.entries()].reduce((best, kv) => (kv[1] > best[1] || (kv[1] === best[1] && kv[0] > best[0]) ? kv : best))[0];
}

const sunCache = new Map<string, [string, string]>();

/** (sunrise, sunset) as «HH:MM» for a date; null when the service did not answer (the weather does not suffer). */
async function sunOf(place: Place, date: string): Promise<[string, string] | null> {
  const key = `${place.lat},${place.lon},${date}`;
  const hit = sunCache.get(key);
  if (hit) return hit;
  try {
    const noon = localMidnight(Date.parse(`${date}T12:00:00Z`), place.tz) + 12 * HOUR;
    const offset = offsetString(noon, place.tz).replace('+', '%2B');
    const j = await getJson(`${METNO_SUN_URL}?lat=${place.lat}&lon=${place.lon}&date=${date}&offset=${offset}`, HEADERS);
    const p = j.properties;
    const pair: [string, string] = [String(p.sunrise.time).slice(11, 16), String(p.sunset.time).slice(11, 16)];
    if (sunCache.size > 2000) sunCache.clear();
    sunCache.set(key, pair);
    return pair;
  } catch {
    return null;
  }
}

async function fetchMetno(place: Place): Promise<Weather> {
  const body = await getJson(`${METNO_URL}?lat=${place.lat}&lon=${place.lon}`, HEADERS);
  const entries: Entry[] = (body.properties.timeseries as { time: string; data: any }[])
    .map((x) => ({ when: Date.parse(x.time), data: x.data }))
    .sort((a, b) => a.when - b.when);
  if (!entries.length) throw new WeatherError('пустой прогноз');
  const times = entries.map((e) => e.when);
  const now = deps.now();

  const start = localMidnight(now, place.tz);
  const hourly = { time: [] as string[] } as Record<string, any[]>;
  for (const name of HOURLY_NAMES) hourly[name] = [];
  for (let n = 0; n < 7 * 24; n++) {
    const slot = start + n * HOUR;
    const k = bisectRight(times, slot) - 1;
    const row: Row = k >= 0 && slot - times[k]! <= 6 * HOUR ? metnoHour(entries[k]!, slot) : {};
    hourly.time!.push(slotString(slot, place.tz));
    for (const name of HOURLY_NAMES) hourly[name]!.push(row[name] ?? null);
  }

  const daily: Record<string, any[]> = {};
  for (const name of [
    'time', 'weather_code', 'temperature_2m_max', 'temperature_2m_min', 'apparent_temperature_max', 'apparent_temperature_min',
    'sunrise', 'sunset', 'uv_index_max', 'precipitation_sum', 'snowfall_sum', 'precipitation_probability_max',
    'wind_speed_10m_max', 'wind_gusts_10m_max', 'wind_direction_10m_dominant',
  ]) daily[name] = [];

  const dates = Array.from({ length: 7 }, (_, i) => localTime(start + i * DAY + DAY / 2, place.tz).date);
  const suns = await Promise.all(dates.map((d) => sunOf(place, d)));
  for (let i = 0; i < 7; i++) {
    const date = dates[i]!;
    const ks = hourly.time!.flatMap((t: string, k: number) => (t.startsWith(date) && hourly.temperature_2m![k] !== null ? [k] : []));
    if (!ks.length) continue;
    const col = (name: string) => ks.map((k) => hourly[name]![k] as Num).filter((x): x is number => x !== null);

    const temps = col('temperature_2m');
    for (const e of entries) {
      // the extremes over 6 hours are more exact than the hourly values
      const six = e.data.next_6_hours;
      if (six && localTime(e.when, place.tz).date === date) {
        for (const v of [six.details?.air_temperature_max, six.details?.air_temperature_min]) if (v !== undefined && v !== null) temps.push(v);
      }
    }
    const feels = col('apparent_temperature');
    const feelsOrTemps = feels.length ? feels : temps;
    const precip = sum(col('precipitation'));
    const snow = sum(ks.filter((k) => SNOW_CODES.has(hourly.weather_code![k])).map((k) => hourly.precipitation![k] ?? 0)); // 1 mm ≈ 1 cm
    const daytime = ks
      .filter((k) => hourly.weather_code![k] !== null && Number(hourly.time![k].slice(11, 13)) >= 6 && Number(hourly.time![k].slice(11, 13)) < 22)
      .map((k) => hourly.weather_code![k] as number);
    const codes = daytime.length ? daytime : col('weather_code');
    const wet = codes.filter((c) => c >= 51);
    const code = wet.length && (wet.length >= 3 || precip >= 1) ? modeCode(wet) : modeCode(codes);
    const windiest = ks.reduce((best, k) => ((hourly.wind_speed_10m![k] ?? 0) > (hourly.wind_speed_10m![best] ?? 0) ? k : best), ks[0]!);
    const sun = suns[i];
    const uv = col('uv_index');

    daily.time!.push(date);
    daily.weather_code!.push(code);
    daily.temperature_2m_max!.push(Math.max(...temps));
    daily.temperature_2m_min!.push(Math.min(...temps));
    daily.apparent_temperature_max!.push(Math.max(...feelsOrTemps));
    daily.apparent_temperature_min!.push(Math.min(...feelsOrTemps));
    daily.sunrise!.push(sun ? `${date}T${sun[0]}` : null);
    daily.sunset!.push(sun ? `${date}T${sun[1]}` : null);
    daily.uv_index_max!.push(uv.length ? Math.max(...uv) : null);
    daily.precipitation_sum!.push(precip);
    daily.snowfall_sum!.push(snow);
    daily.precipitation_probability_max!.push(null); // MET Norway gives no probability
    daily.wind_speed_10m_max!.push(hourly.wind_speed_10m![windiest] ?? 0);
    daily.wind_gusts_10m_max!.push(null);
    daily.wind_direction_10m_dominant!.push(hourly.wind_direction_10m![windiest]);
  }

  const cur = entries[Math.max(bisectRight(times, now) - 1, 0)]!;
  const row = metnoHour(cur, cur.when);
  return {
    hourly: hourly as unknown as Weather['hourly'],
    daily: daily as unknown as Weather['daily'],
    current: {
      temperature_2m: row.temperature_2m ?? 0,
      apparent_temperature: row.apparent_temperature ?? row.temperature_2m ?? 0,
      weather_code: row.weather_code ?? 3,
      wind_speed_10m: row.wind_speed_10m ?? 0,
      wind_direction_10m: row.wind_direction_10m ?? 0,
      relative_humidity_2m: row.relative_humidity_2m ?? 0,
      surface_pressure: row.surface_pressure ?? 0,
    },
  };
}

// ---------- Open-Meteo ----------

const openMeteoUrl = (place: Place) =>
  'https://api.open-meteo.com/v1/forecast?' +
  new URLSearchParams({
    latitude: String(place.lat),
    longitude: String(place.lon),
    timezone: place.tz,
    forecast_days: '7',
    wind_speed_unit: 'ms',
    current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,relative_humidity_2m,surface_pressure',
    hourly:
      'temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,' +
      'wind_speed_10m,wind_gusts_10m,wind_direction_10m,relative_humidity_2m,surface_pressure',
    daily:
      'weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,' +
      'sunrise,sunset,uv_index_max,precipitation_sum,snowfall_sum,precipitation_probability_max,' +
      'wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant',
  }).toString();

async function fetchOpenMeteo(place: Place): Promise<Weather> {
  const r = await getJson(openMeteoUrl(place));
  if (!r?.daily || !r?.hourly || !r?.current) throw new WeatherError('в ответе нет прогноза');
  return r as Weather;
}

// ---------- the forecast, kept for a while ----------

const providers: { name: string; fetch: (place: Place) => Promise<Weather> }[] = [
  { name: 'MET Norway', fetch: fetchMetno },
  { name: 'Open-Meteo', fetch: fetchOpenMeteo },
];

/** What is known about one place: the forecast and, when the services failed just now, why. */
interface Cached {
  at: number;
  data: Weather | null;
  day: string | null;
  failedAt: number;
  error: string;
}
const cache = new Map<string, Cached>();
const inflight = new Map<string, Promise<Weather>>();
const MAX_PLACES = 400;

/** The same figures for places a couple of kilometres apart: one forecast serves them both */
const placeKey = (p: Place) => `${p.lat.toFixed(2)},${p.lon.toFixed(2)},${p.tz}`;

/** Forget everything (tests). */
export function resetWeather() {
  cache.clear();
  inflight.clear();
  providers.sort((a, b) => (a.name === 'MET Norway' ? -1 : 0) - (b.name === 'MET Norway' ? -1 : 0));
  sunCache.clear();
}

/** The forecast for 7 days. Kept for 10 minutes; the source that worked is asked first next time. */
export function getWeather(place: Place): Promise<Weather> {
  const key = placeKey(place);
  let job = inflight.get(key);
  if (!job) {
    job = load(place, key).finally(() => inflight.delete(key));
    inflight.set(key, job);
  }
  return job;
}

async function load(place: Place, key: string): Promise<Weather> {
  const now = deps.now();
  const today = localTime(now, place.tz).date;
  const slot = cache.get(key) ?? { at: 0, data: null, day: null, failedAt: 0, error: '' };
  const age = now - slot.at;
  const usable = slot.data !== null && slot.day === today; // yesterday's forecast is never «today's»
  if (usable && age < WEATHER_TTL) return slot.data!;
  if (now - slot.failedAt < RETRY_AFTER_FAILURE) {
    // it failed just now: nobody waits for timeouts again
    if (usable && age < STALE_TTL) return slot.data!;
    throw new WeatherError(slot.error);
  }
  const errors: string[] = [];
  for (const p of providers) {
    try {
      const data = await p.fetch(place);
      remember(key, { at: now, data, day: today, failedAt: 0, error: '' });
      providers.sort((a, b) => Number(a.name !== p.name) - Number(b.name !== p.name));
      return data;
    } catch (e) {
      errors.push(`${p.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  remember(key, { ...slot, failedAt: now, error: errors.join('; ') });
  if (usable && age < STALE_TTL) return slot.data!;
  throw new WeatherError(errors.join('; '));
}

function remember(key: string, value: Cached) {
  cache.delete(key);
  cache.set(key, value);
  // the oldest places go first: a bot with many cities does not grow without end
  for (const k of cache.keys()) {
    if (cache.size <= MAX_PLACES) break;
    cache.delete(k);
  }
}
