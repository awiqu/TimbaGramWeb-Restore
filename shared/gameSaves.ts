import { Big } from './bignum.js';
import { type ScoreUnit, scoreGame } from './leaderboard.js';

/**
 * Progress of the mini-games (records, the clicker, the level of Helix Jump) is kept on the server
 * per account, so it survives a cleared browser, a second device and an evicted localStorage.
 * Client and server share the rule of which of two saves is better: progress never goes backwards.
 */

export const GAME_SAVE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,39}$/;
/** keys per account */
export const GAME_SAVES_MAX = 60;
/** one value, JSON */
export const GAME_SAVE_MAX_BYTES = 8192;

/** `best:minesweeper` → a record where fewer is better */
function lowerIsBetter(key: string): boolean {
  const m = /^best:(.+)$/.exec(key);
  if (!m) return false;
  return !!scoreGame(m[1] === '2048' ? 'g2048' : m[1]!)?.lower;
}

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const field = (v: unknown, name: string): unknown => (v && typeof v === 'object' ? (v as Record<string, unknown>)[name] : undefined);

/** Should `next` replace `old`? A save that is not worse wins; unknown shapes are last-write-wins. */
export function betterSave(key: string, old: unknown, next: unknown): boolean {
  if (old === undefined || old === null) return true;
  if (num(old) && num(next)) {
    if (!lowerIsBetter(key)) return next > old;
    // 0 means "no record yet"
    return next > 0 && (old <= 0 || next < old);
  }
  if (key === 'clicker') {
    // a deliberate reset starts a new epoch, which beats any progress of the old one
    const [ea, eb] = [Number(field(old, 'epoch') ?? 0), Number(field(next, 'epoch') ?? 0)];
    if (ea !== eb) return eb > ea;
    // a rebirth (more of them made) beats a save from before it, even if that one earned more in total
    const [ra, rb] = [Number(field(old, 'resets') ?? 0), Number(field(next, 'resets') ?? 0)];
    if (ra !== rb) return rb > ra;
    // the one that earned more all-time wins; a save without the total falls back to the time of saving
    // totals can be beyond a double: they are saved as a number or as a pair [mantissa, exponent]
    const dec = (v: unknown) => (v === undefined || v === null ? null : Big.decode(v));
    const [a, b] = [dec(field(old, 'total')), dec(field(next, 'total'))];
    // equal totals (nothing was earned between two saves, e.g. only upgrades were bought) go to the later save,
    // otherwise the purchase would be thrown away by the older copy
    if (a && b) return b.cmp(a) !== 0 ? b.gt(a) : Number(field(next, 'savedAt') ?? 0) >= Number(field(old, 'savedAt') ?? 0);
    if (b && !a) return true;
    if (a && !b) return false;
    return Number(field(next, 'savedAt') ?? 0) >= Number(field(old, 'savedAt') ?? 0);
  }
  return true;
}

// ---------- admin panel → «Игры»: what every game keeps ----------

/**
 * How a saved number is edited: whole (`int`), with one decimal (`decimal`, Paper.io's share of the map),
 * a yes/no (`flag`, a skin that is owned) or a number that may be beyond a double (`big`, the clicker):
 * a number or a pair [mantissa, exponent] as the clicker saves them.
 */
export type SaveFieldKind = 'int' | 'decimal' | 'flag' | 'big';

export interface SaveField {
  /** how the API and the panel name it: the save key, or `clicker.points` for a field inside the clicker's object */
  id: string;
  /** the key in game_saves */
  key: string;
  /** a field inside a save that is an object */
  path?: string;
  kind: SaveFieldKind;
  /** the smallest value (0 when not given) */
  min?: number;
  /** for a record: 0 means "no record yet", otherwise at least this */
  least?: number;
  max?: number;
  /** a heading of the editor the field is shown under */
  group: string;
}

export type AdminGameUnit = ScoreUnit | 'wins';

export interface AdminGameDef {
  id: string;
  /** the id of the field the progress is read from: the filter and the sorting use it */
  main: string;
  unit: AdminGameUnit;
  /** fewer is better (time, moves) */
  lower?: boolean;
  fields: SaveField[];
  /** keys of the game the panel does not show, with what a reset puts there (the old coins of the surfer, the worn skin) */
  extra?: Readonly<Record<string, unknown>>;
}

/** a game with a monthly rating keeps its record in `best:<id>` (2048 is `best:2048`); the limits are those of the rating */
function rated(id: string): AdminGameDef {
  const g = scoreGame(id)!;
  const key = `best:${id === 'g2048' ? '2048' : id}`;
  return {
    id,
    main: key,
    unit: g.unit,
    lower: g.lower,
    fields: [{ id: key, key, kind: g.unit === 'percent' ? 'decimal' : 'int', least: g.min, max: g.max, group: 'record' }],
  };
}

const int = (key: string, group: string, max: number, min = 0): SaveField => ({ id: key, key, kind: 'int', min, max, group });
const flag = (key: string, group: string): SaveField => ({ id: key, key, kind: 'flag', max: 1, group });
const inClicker = (path: string, kind: 'big' | 'int', group: string): SaveField => ({
  id: `clicker.${path}`,
  key: 'clicker',
  path,
  kind,
  max: kind === 'int' ? 1e12 : undefined,
  group,
});

// keep in step with the shop of Тимба Серф (client/src/components/games/subwayShop.ts)
export const SUBWAY_UPGRADE_MAX: Readonly<Record<string, number>> = { magnet: 5, jet: 5, bank: 4, shield: 3 };
export const SUBWAY_SKINS: readonly string[] = ['cat', 'ninja', 'astro', 'robot', 'pirate', 'gold', 'rainbow'];

const SUBWAY: AdminGameDef = (() => {
  const base = rated('subway');
  return {
    ...base,
    extra: { 'subway:coins': 0, 'subway:skin': 'timba' },
    fields: [
      ...base.fields,
      int('subway:earned', 'coins', 1e9),
      int('subway:spent', 'coins', 1e9),
      ...Object.entries(SUBWAY_UPGRADE_MAX).map(([id, max]) => int(`subway:up:${id}`, 'upgrades', max)),
      ...SUBWAY_SKINS.map((id) => flag(`subway:own:${id}`, 'skins')),
    ],
  };
})();

/** The games that keep progress on the server (Hangman, Sudoku and the boards against the bot keep none). */
export const ADMIN_GAMES: readonly AdminGameDef[] = [
  rated('tetris'),
  SUBWAY,
  {
    id: 'helix',
    main: 'helix:best',
    unit: 'level',
    fields: [int('helix:best', 'progress', 9999, 1), int('helix:level', 'progress', 9999, 1), int('helix:bestScore', 'progress', 1e9)],
  },
  rated('paper'),
  rated('flappy'),
  rated('snake'),
  rated('g2048'),
  rated('minesweeper'),
  rated('memory'),
  rated('fifteen'),
  rated('guess'),
  rated('reaction'),
  rated('breakout'),
  rated('stack'),
  { id: 'battleship', main: 'best:battleship', unit: 'wins', fields: [{ ...int('best:battleship', 'record', 100_000), least: 1 }] },
  {
    id: 'clicker',
    main: 'clicker.resets',
    unit: 'rebirths',
    fields: [
      inClicker('points', 'big', 'account'),
      inClicker('total', 'big', 'account'),
      inClicker('cores', 'big', 'cores'),
      inClicker('coresTotal', 'big', 'cores'),
      inClicker('resets', 'int', 'counters'),
      inClicker('clicks', 'int', 'counters'),
      inClicker('goldens', 'int', 'counters'),
    ],
  },
];

export const adminGame = (id: string): AdminGameDef | undefined => ADMIN_GAMES.find((g) => g.id === id);

/** every save key some game of the panel owns */
export const ADMIN_GAME_KEYS: readonly string[] = [...new Set(ADMIN_GAMES.flatMap((g) => [...g.fields.map((f) => f.key), ...Object.keys(g.extra ?? {})]))];

/** the keys one game owns, the extra ones included */
export const gameKeys = (def: AdminGameDef): string[] => [...new Set([...def.fields.map((f) => f.key), ...Object.keys(def.extra ?? {})])];

/** The value of every field the saves hold: a number, or a clicker number as it was saved. Fields that are not saved are left out. */
export function fieldValues(def: AdminGameDef, saves: ReadonlyMap<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of def.fields) {
    const raw = saves.get(f.key);
    if (raw === undefined) continue;
    const v = f.path ? field(raw, f.path) : raw;
    if (f.kind === 'big') {
      if (v !== undefined) out[f.id] = Big.decode(v).encode();
    } else if (num(v)) out[f.id] = v;
  }
  return out;
}

/**
 * The number a game is judged by. `null`: nothing yet (no record, a fresh clicker), which is not the same as a
 * zero result and is filtered apart. `tie` orders players with an equal number (the clicker: who earned more).
 */
export function saveProgress(def: AdminGameDef, values: Record<string, unknown>): { progress: number | null; tie: number } {
  const main = values[def.main];
  const n = num(main) ? main : 0;
  if (def.id === 'clicker') {
    const total = Big.decode(values['clicker.total']);
    const clicks = values['clicker.clicks'];
    if (total.isZero && !(num(clicks) && clicks > 0) && n === 0) return { progress: null, tie: 0 };
    return { progress: n, tie: total.isZero ? 0 : total.e + Math.log10(total.m) };
  }
  return { progress: n > 0 ? n : null, tie: 0 };
}

/** Is `v` an acceptable value for the field? (A clicker number comes as a number or a pair and is checked as it decodes.) */
export function validFieldValue(f: SaveField, v: unknown): boolean {
  if (f.kind === 'big') {
    if (num(v)) return v >= 0;
    return Array.isArray(v) && v.length === 2 && num(v[0]) && num(v[1]) && v[0] >= 0 && Number.isInteger(v[1]) && v[1] >= 0;
  }
  if (!num(v)) return false;
  if (f.kind === 'flag') return v === 0 || v === 1;
  if (f.kind === 'int' && !Number.isInteger(v)) return false;
  if (f.kind === 'decimal' && Math.abs(v * 10 - Math.round(v * 10)) > 1e-6) return false;
  if (v < (f.min ?? 0) || (f.max !== undefined && v > f.max)) return false;
  return !(f.least !== undefined && v > 0 && v < f.least);
}
