import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Place, deps } from './data.js';

/**
 * The cities of the weather bot. The list ships with the server (server/seed/cities.json, made by
 * scripts/build-cities.mjs from GeoNames): Russia down to villages, the neighbours and the big cities of the world.
 * What it does not know is looked up in the Open-Meteo geocoder, which uses the same GeoNames ids.
 */

export interface City extends Place {
  region: string;
  country: string;
  cc: string;
  pop: number;
  /** the Latin name, for people who type «Moscow» */
  en: string;
}

interface Indexed extends City {
  /** the names written the way a search compares them */
  n: string;
  e: string;
  r: string;
  c: string;
}

const LIST_FILE = fileURLToPath(new URL('../../../seed/cities.json', import.meta.url));

/** lower case, «ё» is «е», every punctuation mark and the hyphen are a space: «Ростов-на-Дону» = «ростов на дону» */
export const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** what people call the cities: «питер», «екб» */
const ALIASES: Record<string, string> = {
  спб: 'санкт петербург',
  питер: 'санкт петербург',
  ленинград: 'санкт петербург',
  мск: 'москва',
  екб: 'екатеринбург',
  ебург: 'екатеринбург',
  нн: 'нижний новгород',
  нск: 'новосибирск',
  кзн: 'казань',
};

let index: Indexed[] | null = null;
let byId: Map<number, Indexed> | null = null;

function load(): Indexed[] {
  if (index) return index;
  const raw = JSON.parse(fs.readFileSync(LIST_FILE, 'utf8')) as {
    countries: Record<string, string>;
    regions: string[];
    timezones: string[];
    cities: [number, string, string, number, string, number, number, number, number][];
  };
  index = raw.cities.map(([id, name, en, region, cc, lat, lon, tz, pop]) => {
    const regionName = raw.regions[region] ?? '';
    const country = raw.countries[cc] ?? cc;
    return {
      id,
      name,
      en: en || '',
      region: regionName,
      country,
      cc,
      lat,
      lon,
      tz: raw.timezones[tz]!,
      pop,
      label: label(name, regionName, cc, country),
      n: normalize(name),
      e: normalize(en),
      r: normalize(regionName),
      c: normalize(country),
    };
  });
  byId = new Map(index.map((c) => [c.id, c]));
  return index;
}

/** «Никольское, Вологодская область»; a city of another country gets the country, too */
function label(name: string, region: string, cc: string, country: string): string {
  const parts = [name];
  if (region && normalize(region) !== normalize(name)) parts.push(region);
  if (cc !== 'RU') parts.push(country);
  return parts.join(', ');
}

/** Every city of the built-in list (tests). */
export const allCities = (): readonly City[] => load();

// ---------- the cities found online, kept until the person picks one ----------

const found = new Map<number, City>();
const FOUND_MAX = 300;

function rememberFound(cities: City[]) {
  for (const c of cities) {
    found.delete(c.id);
    found.set(c.id, c);
  }
  for (const k of found.keys()) {
    if (found.size <= FOUND_MAX) break;
    found.delete(k);
  }
}

/** The city with this id: from the list, or one that a search just found online. */
export function cityById(id: number): City | undefined {
  load();
  return byId!.get(id) ?? found.get(id);
}

/** The part of a city a chat keeps: no population, no Latin name. */
export const placeOf = (c: City): Place => ({ id: c.id, name: c.name, label: c.label, lat: c.lat, lon: c.lon, tz: c.tz });

// ---------- searching ----------

const words = (s: string) => s.split(' ');

function score(c: Indexed, q: string, tokens: string[]): number {
  let s = 0;
  const full = `${c.n} ${c.r}`;
  if (c.n === q) s = 1000;
  else if (c.e && c.e === q) s = 900;
  else if (c.n.startsWith(q)) s = 800;
  else if (full.startsWith(q) || `${c.n} ${c.c}`.startsWith(q) || `${c.n} ${c.r} ${c.c}`.startsWith(q)) s = 700;
  else if (c.e && c.e.startsWith(q)) s = 650;
  else if (words(c.n).some((w) => w.startsWith(q))) s = 300;
  else if (tokens.length > 1) {
    // «никольское вологодская»: every word of the request begins some word of the city, its region or its country
    const pool = words(`${c.n} ${c.e} ${c.r} ${c.c}`);
    if (tokens.every((t) => pool.some((w) => w.startsWith(t)))) s = 400;
  }
  if (!s) return 0;
  // the same name: the bigger place first, and the Russian one before a foreign one
  return s + Math.log10(c.pop + 10) * 4 + (c.cc === 'RU' ? 15 : 0);
}

/** The cities of the built-in list that fit the request, the best first. */
export function searchLocal(query: string, limit = 8): City[] {
  let q = normalize(query);
  if (q.length < 2) return [];
  q = ALIASES[q] ?? q;
  const tokens = words(q);
  const hits: { c: Indexed; s: number }[] = [];
  for (const c of load()) {
    const s = score(c, q, tokens);
    if (s) hits.push({ c, s });
  }
  hits.sort((a, b) => b.s - a.s || b.c.pop - a.c.pop);
  return hits.slice(0, limit).map((h) => h.c);
}

const GEOCODER = 'https://geocoding-api.open-meteo.com/v1/search';

/** The Open-Meteo geocoder: for what the list does not have (a small town, a foreign city). Silent when it is down. */
export async function searchOnline(query: string, limit = 8): Promise<City[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  try {
    const res = await deps.fetch(`${GEOCODER}?${new URLSearchParams({ name: q, count: '10', language: 'ru', format: 'json' })}`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return [];
    const body = (await res.json()) as { results?: Record<string, unknown>[] };
    const out: City[] = [];
    for (const r of body.results ?? []) {
      const id = Number(r.id);
      const lat = Number(r.latitude);
      const lon = Number(r.longitude);
      if (!Number.isInteger(id) || !Number.isFinite(lat) || !Number.isFinite(lon) || typeof r.name !== 'string' || typeof r.timezone !== 'string') continue;
      if (typeof r.feature_code === 'string' && !r.feature_code.startsWith('PPL')) continue; // not a settlement
      const cc = typeof r.country_code === 'string' ? r.country_code : '';
      const country = typeof r.country === 'string' ? r.country : cc;
      const region = typeof r.admin1 === 'string' ? r.admin1 : '';
      out.push({ id, name: r.name, en: '', region, country, cc, lat, lon, tz: r.timezone, pop: Number(r.population) || 0, label: label(r.name, region, cc, country) });
    }
    rememberFound(out);
    return out.slice(0, limit);
  } catch {
    return [];
  }
}

/** What the person typed -> the cities to choose from: the list first, and the geocoder when the list has few answers. */
export async function findCities(query: string, limit = 8): Promise<City[]> {
  const local = searchLocal(query, limit);
  if (local.length >= 3) return local;
  const online = await searchOnline(query, limit);
  const seen = new Set(local.map((c) => c.id));
  return [...local, ...online.filter((c) => !seen.has(c.id))].slice(0, limit);
}
