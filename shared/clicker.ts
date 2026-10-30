/**
 * Тимба Кликер: данные улучшений, расчёт добычи, цены, фоновая добыча, перерождение и форматирование
 * больших чисел. Это чистые функции: клиент рисует игру, тесты проверяют арифметику. Числа — `Big`
 * (shared/bignum.ts), поэтому добыча может уйти далеко за 1e308.
 */
import { Big, type BigLike, E } from './bignum.js';

export { Big, E, big } from './bignum.js';
export type { BigLike } from './bignum.js';

/** С какого заработка за один заход можно переродиться в первый раз */
export const PRESTIGE_MIN = 1e10;
/** Во сколько раз порог растёт с каждым перерождением: ядро всегда одно, а заработать надо больше */
export const PRESTIGE_GROWTH = 5;
/** Бонус каждого ядра ко всей добыче, доля */
export const CORE_BONUS = 0.25;
/** Бонус каждого достижения к добыче и к силе нажатия, доля */
export const ACH_BONUS = 0.02;
/** Комбо: нажатия подряд (не реже, чем раз в COMBO_GAP_MS) растят множитель клика */
export const COMBO_GAP_MS = 1500;
export const COMBO_BASE_CAP = 30;
export const COMBO_BASE_STEP = 0.01;
/** КПД фоновой добычи в самом начале (потолка по времени у фона нет) */
export const OFFLINE_BASE_EFF = 0.25;

// ---------- названия чисел ----------

/** Буквы «разрядов»: Q — самый младший, L — самый старший */
const TIERS = ['Q', 'S', 'D', 'G', 'X', 'F', 'L'] as const;
/** Сколько раз подряд может повториться буква разряда (Q, QQ, QQQ — и дальше следующая буква) */
const RUN_MAX = 3;
const UNITS = ['', 'K', 'M', 'B', 'T'] as const;
/** Последний порядок (по 3 нуля), у которого есть название */
export const MAX_NAMED_ORDER = 5 * (RUN_MAX + 1) ** TIERS.length - 1;

/**
 * Название порядка i (число = 1000^i): 1 → K, 2 → M, 3 → B, 4 → T, 5 → Q, 6 → QK … 19 → QQQT,
 * 20 → S, 21 → SK … 39 → SQQQT, 40 → SS … 79 → SSSQQQT, 80 → D … дальше G, X, F, L.
 * Устройство как у счётчика: младший «разряд» — K, M, B, T (пять значений), каждый следующий — повтор
 * своей буквы от 0 до 3 раз. null — выше последнего названия.
 */
export function bigSuffix(i: number): string | null {
  if (i <= 0) return '';
  if (i > MAX_NAMED_ORDER) return null;
  let r = Math.floor(i / 5);
  const runs: number[] = [];
  for (let j = 0; j < TIERS.length; j++) {
    runs.push(r % (RUN_MAX + 1));
    r = Math.floor(r / (RUN_MAX + 1));
  }
  let name = '';
  for (let j = TIERS.length - 1; j >= 0; j--) name += TIERS[j]!.repeat(runs[j]!);
  return name + UNITS[i % 5]!;
}

const trim = (v: number, digits: number) => {
  const s = v.toFixed(digits);
  return (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s).replace('.', ',');
};

/** 950 → «950», 12 345 → «12,3K», 4,5e18 → «4,5QK», 1e60 → «1S», 1e240 → «1D», выше названий — «1,5e250000» */
export function formatBig(value: BigLike): string {
  const n = Big.of(value);
  if (n.isZero) return '0';
  if (n.e < 3) {
    const v = n.toNumber();
    return v >= 100 || Number.isInteger(v) ? String(Math.floor(v)) : trim(v, v >= 10 ? 1 : 2);
  }
  let i = Math.floor(n.e / 3);
  let v = n.m * 10 ** (n.e - i * 3);
  const digits = v < 10 ? 2 : v < 100 ? 1 : 0;
  // 999,96K округляется до 1000K: это уже 1M
  if (Number(v.toFixed(digits)) >= 1000) {
    v /= 1000;
    i++;
  }
  const suffix = bigSuffix(i);
  if (suffix === null) return `${trim(n.m, 2)}e${n.e}`;
  return trim(v, v < 10 ? 2 : v < 100 ? 1 : 0) + suffix;
}

/** Порядок по названию («K» → 1, «QK» → 6), собирается при первом чтении */
let orderBySuffix: Map<string, number> | undefined;
const orderOf = (suffix: string): number | undefined => {
  if (!orderBySuffix) {
    orderBySuffix = new Map();
    for (let i = 1; i <= MAX_NAMED_ORDER; i++) orderBySuffix.set(bigSuffix(i)!, i);
  }
  return orderBySuffix.get(suffix);
};

/**
 * Обратное к formatBig: «1500», «12 345», «12,5K», «4,5QK», «1e60», «1,5e250000». null — это не число
 * (или оно отрицательное). Буквы можно писать строчными.
 */
export function parseBig(text: string): Big | null {
  const s = text.trim().replace(/\s+/g, '').replace(',', '.');
  const sci = /^(\d+(?:\.\d+)?|\.\d+)e\+?(\d{1,9})$/i.exec(s);
  if (sci) return Big.from(Number(sci[1]), Number(sci[2]));
  const named = /^(\d+(?:\.\d+)?|\.\d+)([a-z]*)$/i.exec(s);
  if (!named) return null;
  const m = Number(named[1]);
  if (!Number.isFinite(m)) return null;
  const suffix = named[2]!.toUpperCase();
  if (!suffix) return Big.from(m);
  const order = orderOf(suffix);
  return order === undefined ? null : Big.from(m, order * 3);
}

// ---------- улучшения ----------

export type ClickerPage = 'click' | 'auto' | 'boost' | 'lab' | 'offline';
export const CLICKER_PAGES: readonly ClickerPage[] = ['click', 'auto', 'boost', 'lab', 'offline'];

/** Что делает улучшение со страниц «Бусты» и «Фон» (за каждый уровень, значение — в `step`) */
export type BoostEffect =
  | 'power' // +step к добыче в секунду (доля: 0,25 = +25%)
  | 'clickpower' // +step к силе клика
  | 'resonance' // клик даёт ещё step от добычи в секунду
  | 'crit' // +step к шансу крита
  | 'critpow' // +step к множителю крита
  | 'auto' // step автокликов в секунду
  | 'golden' // золотая звезда появляется на step секунд чаще
  | 'goldenboost' // золотая звезда даёт ещё step секунд добычи
  | 'discount' // цены ниже на step
  | 'offeff' // фоновая добыча: +step к КПД
  | 'offmult' // фоновая добыча: ещё +step к множителю
  | 'combostep' // комбо: +step к приросту множителя за нажатие
  | 'combocap' // комбо: предел растёт на step нажатий
  | 'combogap' // комбо: пауза между нажатиями длиннее на step секунд
  | 'autocombo' // автонажатия получают step от максимального бонуса комбо
  | 'prodx' // вся добыча умножается на step за каждый уровень
  | 'clickx' // сила нажатия умножается на step за каждый уровень
  | 'hunter' // золотые звёзды и звёзды дождя ловятся сами; каждый уровень быстрее
  | 'echo' // шанс step, что пойманная звезда сработает ещё раз
  | 'frenzypow' // «Ярость»: множитель выше на step
  | 'frenzylen' // «Ярость» длится ещё step секунд
  | 'stormpow' // «Клик-шторм»: множитель выше на step
  | 'rainstars' // «Звёздный дождь»: ещё step звёзд
  | 'raingain' // звезда дождя даёт ещё step от базы (доля)
  | 'synergy' // +step к добыче за каждый уровень улучшений страницы «Авто»
  | 'achboost' // каждое достижение даёт ещё +step
  | 'coreboost'; // каждое ядро даёт ещё +step

export interface ClickerItem {
  id: string;
  page: ClickerPage;
  icon: string;
  price: Big;
  /** цена растёт в столько раз с каждой покупкой */
  growth: number;
  /** сколько раз можно купить (ядра «Расширение» поднимают предел у всех) */
  max: number;
  /** +к клику за уровень (страница «Клик») */
  click?: Big;
  /** +в секунду за уровень (страница «Авто») */
  sec?: Big;
  effect?: BoostEffect;
  step?: number;
}

/** Число или порядок в таблице: 1500 или [1.5, 21] = 1,5e21 */
type Raw = number | [number, number];
const R = (v: Raw): Big => (typeof v === 'number' ? Big.of(v) : E(v[0], v[1]));

interface Def {
  id: string;
  page: ClickerPage;
  icon: string;
  price: Raw;
  growth: number;
  max: number;
  click?: Raw;
  sec?: Raw;
  effect?: BoostEffect;
  step?: number;
}

const DEFS: Def[] = [
  // ---- Клик: сила нажатия ----
  { id: 'finger', page: 'click', icon: '👆', price: 15, growth: 1.15, max: 100, click: 1 },
  { id: 'glove', page: 'click', icon: '🧤', price: 800, growth: 1.15, max: 100, click: 10 },
  { id: 'lucky', page: 'click', icon: '🍀', price: 25_000, growth: 1.15, max: 80, click: 60 },
  { id: 'magnet', page: 'click', icon: '🧲', price: 600_000, growth: 1.16, max: 80, click: 400 },
  { id: 'hand', page: 'click', icon: '🦾', price: 25_000_000, growth: 1.16, max: 60, click: 5000 },
  { id: 'titan', page: 'click', icon: '🔨', price: 5e9, growth: 1.17, max: 50, click: 2.5e5 },
  { id: 'starfist', page: 'click', icon: '🌟', price: 2e12, growth: 1.17, max: 50, click: 5e7 },
  { id: 'nova', page: 'click', icon: '💥', price: 8e15, growth: 1.18, max: 40, click: 2e10 },
  { id: 'abyss', page: 'click', icon: '🕳️', price: 6e20, growth: 1.18, max: 40, click: 4e14 },
  { id: 'omega', page: 'click', icon: '🔱', price: 4e27, growth: 1.19, max: 30, click: 5e21 },
  { id: 'dragonfist', page: 'click', icon: '🐉', price: [3, 34], growth: 1.19, max: 30, click: [3, 28] },
  { id: 'cometfist', page: 'click', icon: '☄️', price: [5, 44], growth: 1.2, max: 30, click: [4, 38] },
  { id: 'worldfist', page: 'click', icon: '🌍', price: [8, 56], growth: 1.2, max: 28, click: [6, 50] },
  { id: 'godfist', page: 'click', icon: '🙌', price: [1, 72], growth: 1.21, max: 26, click: [8, 65] },
  { id: 'fatefist', page: 'click', icon: '🎴', price: [5, 90], growth: 1.21, max: 25, click: [3, 83] },
  // ---- Авто: добыча в секунду ----
  { id: 'cursor', page: 'auto', icon: '🖱️', price: 50, growth: 1.15, max: 100, sec: 1 },
  { id: 'cat', page: 'auto', icon: '🐈', price: 250, growth: 1.15, max: 100, sec: 5 },
  { id: 'farm', page: 'auto', icon: '🌾', price: 1500, growth: 1.15, max: 100, sec: 25 },
  { id: 'factory', page: 'auto', icon: '🏭', price: 9000, growth: 1.15, max: 100, sec: 120 },
  { id: 'rocket', page: 'auto', icon: '🚀', price: 50_000, growth: 1.15, max: 90, sec: 600 },
  { id: 'robot', page: 'auto', icon: '🤖', price: 250_000, growth: 1.15, max: 90, sec: 3000 },
  { id: 'portal', page: 'auto', icon: '🌀', price: 1_500_000, growth: 1.15, max: 80, sec: 16_000 },
  { id: 'bank', page: 'auto', icon: '🏦', price: 9_000_000, growth: 1.15, max: 80, sec: 90_000 },
  { id: 'galaxy', page: 'auto', icon: '🌌', price: 80_000_000, growth: 1.15, max: 70, sec: 600_000 },
  { id: 'timba', page: 'auto', icon: '👑', price: 750_000_000, growth: 1.15, max: 60, sec: 5_000_000 },
  { id: 'blackhole', page: 'auto', icon: '⚫', price: 8e9, growth: 1.16, max: 50, sec: 4e7 },
  { id: 'timemachine', page: 'auto', icon: '⏳', price: 9e10, growth: 1.16, max: 50, sec: 3.5e8 },
  { id: 'multiverse', page: 'auto', icon: '🪐', price: 1.5e12, growth: 1.16, max: 50, sec: 3e9 },
  { id: 'reality', page: 'auto', icon: '🧬', price: 3e14, growth: 1.17, max: 40, sec: 5e10 },
  { id: 'entropy', page: 'auto', icon: '⚛️', price: 4e16, growth: 1.17, max: 40, sec: 4e13 },
  { id: 'dimension', page: 'auto', icon: '🚪', price: 1e19, growth: 1.18, max: 35, sec: 8e15 },
  { id: 'deity', page: 'auto', icon: '🔆', price: 5e22, growth: 1.18, max: 30, sec: 3e19 },
  { id: 'cosmos', page: 'auto', icon: '🌠', price: 2e27, growth: 1.19, max: 30, sec: 1e24 },
  { id: 'infinity', page: 'auto', icon: '♾️', price: [1, 33], growth: 1.2, max: 25, sec: [5, 29] },
  { id: 'quasar', page: 'auto', icon: '💫', price: [8, 38], growth: 1.2, max: 25, sec: [3, 35] },
  { id: 'hypernova', page: 'auto', icon: '🎆', price: [6, 45], growth: 1.2, max: 25, sec: [2, 42] },
  { id: 'dyson', page: 'auto', icon: '☀️', price: [5, 53], growth: 1.21, max: 25, sec: [1.5, 50] },
  { id: 'akasha', page: 'auto', icon: '📜', price: [4, 62], growth: 1.21, max: 25, sec: [1, 59] },
  { id: 'omniverse', page: 'auto', icon: '🌐', price: [3, 72], growth: 1.22, max: 25, sec: [7, 68] },
  { id: 'creator', page: 'auto', icon: '🎛️', price: [2, 83], growth: 1.22, max: 22, sec: [4, 79] },
  { id: 'absolute', page: 'auto', icon: '🔮', price: [1, 95], growth: 1.22, max: 22, sec: [2, 91] },
  { id: 'beyond', page: 'auto', icon: '🌫️', price: [8, 107], growth: 1.23, max: 20, sec: [1.5, 104] },
  { id: 'glitch', page: 'auto', icon: '👾', price: [5, 122], growth: 1.23, max: 20, sec: [8, 118] },
  { id: 'timbaverse', page: 'auto', icon: '🧿', price: [3, 138], growth: 1.24, max: 20, sec: [4, 134] },
  // ---- Бусты: множители ----
  { id: 'power', page: 'boost', icon: '🔋', price: 5000, growth: 3.2, max: 25, effect: 'power', step: 0.5 },
  { id: 'clickpower', page: 'boost', icon: '💪', price: 2000, growth: 3.2, max: 25, effect: 'clickpower', step: 0.5 },
  { id: 'resonance', page: 'boost', icon: '🔔', price: 2e5, growth: 3, max: 20, effect: 'resonance', step: 0.01 },
  { id: 'crit', page: 'boost', icon: '🎯', price: 1e5, growth: 2.6, max: 20, effect: 'crit', step: 0.03 },
  { id: 'critpow', page: 'boost', icon: '⚡', price: 5e5, growth: 2.5, max: 20, effect: 'critpow', step: 2 },
  { id: 'auto', page: 'boost', icon: '🤚', price: 1e4, growth: 2.4, max: 20, effect: 'auto', step: 1 },
  { id: 'golden', page: 'boost', icon: '🌠', price: 3e4, growth: 3, max: 10, effect: 'golden', step: 1.5 },
  { id: 'goldenboost', page: 'boost', icon: '🌟', price: 2e5, growth: 2.4, max: 20, effect: 'goldenboost', step: 30 },
  { id: 'discount', page: 'boost', icon: '🏷️', price: 1e6, growth: 3, max: 20, effect: 'discount', step: 0.02 },
  // ---- Лаборатория: множители, комбо, золотые звёзды ----
  { id: 'prodx', page: 'lab', icon: '🚀', price: 1e6, growth: 4, max: 25, effect: 'prodx', step: 1.1 },
  { id: 'clickx', page: 'lab', icon: '🥊', price: 5e5, growth: 4, max: 25, effect: 'clickx', step: 1.1 },
  { id: 'synergy', page: 'lab', icon: '🧩', price: 1e9, growth: 3.5, max: 20, effect: 'synergy', step: 0.0003 },
  { id: 'hunter', page: 'lab', icon: '🪝', price: 4e6, growth: 6, max: 5, effect: 'hunter', step: 1 },
  { id: 'echo', page: 'lab', icon: '🔁', price: 5e8, growth: 3.5, max: 10, effect: 'echo', step: 0.05 },
  { id: 'combostep', page: 'lab', icon: '🔥', price: 5e5, growth: 2.8, max: 20, effect: 'combostep', step: 0.005 },
  { id: 'combocap', page: 'lab', icon: '📶', price: 2e6, growth: 2.8, max: 20, effect: 'combocap', step: 10 },
  { id: 'combogap', page: 'lab', icon: '🥁', price: 3e6, growth: 2.5, max: 10, effect: 'combogap', step: 0.3 },
  { id: 'autocombo', page: 'lab', icon: '🎼', price: 3e8, growth: 3.2, max: 10, effect: 'autocombo', step: 0.1 },
  { id: 'frenzypow', page: 'lab', icon: '🌋', price: 5e8, growth: 3.2, max: 20, effect: 'frenzypow', step: 1 },
  { id: 'frenzylen', page: 'lab', icon: '⌛', price: 2e9, growth: 3, max: 15, effect: 'frenzylen', step: 5 },
  { id: 'stormpow', page: 'lab', icon: '🌪️', price: 1e11, growth: 3.2, max: 15, effect: 'stormpow', step: 3 },
  { id: 'rainstars', page: 'lab', icon: '🌧️', price: 5e12, growth: 3.5, max: 10, effect: 'rainstars', step: 2 },
  { id: 'raingain', page: 'lab', icon: '💧', price: 1e15, growth: 3, max: 15, effect: 'raingain', step: 0.5 },
  { id: 'achboost', page: 'lab', icon: '🏆', price: 1e18, growth: 4, max: 10, effect: 'achboost', step: 0.02 },
  { id: 'coreboost', page: 'lab', icon: '☢️', price: 1e25, growth: 5, max: 10, effect: 'coreboost', step: 0.1 },
  // ---- Фон: добыча, пока игры нет (по времени она не ограничена) ----
  { id: 'autopilot', page: 'offline', icon: '🛰️', price: 1e4, growth: 2.2, max: 15, effect: 'offeff', step: 0.05 },
  { id: 'overclock', page: 'offline', icon: '🚄', price: 3e5, growth: 2.7, max: 20, effect: 'offmult', step: 0.5 },
];

export const CLICKER_ITEMS: readonly ClickerItem[] = DEFS.map((d) => ({
  id: d.id,
  page: d.page,
  icon: d.icon,
  price: R(d.price),
  growth: d.growth,
  max: d.max,
  ...(d.click !== undefined ? { click: R(d.click) } : {}),
  ...(d.sec !== undefined ? { sec: R(d.sec) } : {}),
  ...(d.effect ? { effect: d.effect, step: d.step } : {}),
}));

export type CoreEffect = 'start' | 'prod' | 'click' | 'discount' | 'cap' | 'offeff' | 'combo' | 'head' | 'memory' | 'synth';
export interface CoreItem {
  id: string;
  icon: string;
  /** цена в ядрах */
  price: number;
  growth: number;
  max: number;
  effect: CoreEffect;
  step: number;
}

/** Покупки за ядра: остаются навсегда, перерождение их не сбрасывает. Ядро одно за перерождение, поэтому каждая покупка весомая. */
export const CORE_ITEMS: readonly CoreItem[] = [
  { id: 'c_prod', icon: '⚙️', price: 2, growth: 1.7, max: 10, effect: 'prod', step: 1.5 },
  { id: 'c_click', icon: '👊', price: 2, growth: 1.7, max: 10, effect: 'click', step: 1.5 },
  { id: 'c_head', icon: '🏁', price: 3, growth: 1.8, max: 6, effect: 'head', step: 5 },
  { id: 'c_memory', icon: '🧠', price: 4, growth: 1.8, max: 8, effect: 'memory', step: 0.1 },
  { id: 'c_synth', icon: '🧪', price: 5, growth: 1.9, max: 10, effect: 'synth', step: 0.05 },
  { id: 'c_start', icon: '🚀', price: 1, growth: 1.6, max: 10, effect: 'start', step: 10 },
  { id: 'c_discount', icon: '💸', price: 3, growth: 1.5, max: 15, effect: 'discount', step: 0.02 },
  { id: 'c_cap', icon: '🏗️', price: 4, growth: 1.8, max: 10, effect: 'cap', step: 5 },
  { id: 'c_combo', icon: '🥇', price: 3, growth: 1.7, max: 8, effect: 'combo', step: 0.01 },
  { id: 'c_offline', icon: '🌙', price: 2, growth: 1.6, max: 5, effect: 'offeff', step: 0.1 },
];

export const clickerItem = (id: string) => CLICKER_ITEMS.find((i) => i.id === id);
export const coreItem = (id: string) => CORE_ITEMS.find((i) => i.id === id);

// ---------- состояние ----------

export interface ClickerState {
  /** сейчас на счету */
  points: Big;
  /** всего заработано за всё время (по нему из двух сохранений выбирается лучшее) */
  total: Big;
  /** заработано с последнего перерождения */
  run: Big;
  /** уровни улучшений четырёх страниц */
  levels: Record<string, number>;
  /** ядра перерождения: можно тратить, а все когда-либо полученные дают +1% к добыче */
  cores: Big;
  coresTotal: Big;
  coreLevels: Record<string, number>;
  /** сколько раз перерождались */
  resets: number;
  /** сколько раз нажали */
  clicks: number;
  /** сколько золотых звёзд поймано и какое комбо было самым длинным (для достижений) */
  goldens: number;
  bestCombo: number;
  savedAt: number;
  /** начало новой эпохи после «Сбросить прогресс» */
  epoch?: number;
}

export function freshClicker(now = Date.now()): ClickerState {
  return { points: Big.ZERO, total: Big.ZERO, run: Big.ZERO, levels: {}, cores: Big.ZERO, coresTotal: Big.ZERO, coreLevels: {}, resets: 0, clicks: 0, goldens: 0, bestCombo: 0, savedAt: now };
}

const count = (v: unknown, fallback = 0) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback);

const coreStep = (id: string) => coreItem(id)!.step;

/** Сколько можно купить с учётом ядер «Расширение» */
export const maxLevel = (item: ClickerItem, s: Pick<ClickerState, 'coreLevels'>) => item.max + (s.coreLevels.c_cap ?? 0) * coreStep('c_cap');

/** Читает сохранение любой версии: старое (поле `owned`, числа), битое, чужое — всегда возвращает целое состояние. */
export function normalizeClicker(raw: unknown, now = Date.now()): ClickerState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const s = freshClicker(now);
  s.points = Big.decode(r.points);
  const legacy = (r.owned ?? r.levels) as Record<string, unknown> | undefined;
  const coreLv = r.coreLevels as Record<string, unknown> | undefined;
  for (const [id, v] of Object.entries(coreLv ?? {})) if (coreItem(id)) s.coreLevels[id] = Math.min(count(v), coreItem(id)!.max);
  for (const item of CLICKER_ITEMS) {
    const lv = count(legacy?.[item.id]);
    if (lv > 0) s.levels[item.id] = Math.min(lv, maxLevel(item, s));
  }
  s.cores = Big.decode(r.cores).floor();
  s.coresTotal = Big.decode(r.coresTotal).floor().max(s.cores);
  s.resets = count(r.resets);
  s.clicks = count(r.clicks);
  s.goldens = count(r.goldens);
  s.bestCombo = count(r.bestCombo);
  s.savedAt = typeof r.savedAt === 'number' && Number.isFinite(r.savedAt) && r.savedAt > 0 ? r.savedAt : now;
  // сохранения до «total»: заработанное ≈ очки на счету + цена купленного
  const hasTotal = Big.decode(r.total).gt(0);
  s.total = hasTotal ? Big.decode(r.total) : s.points.add(spentOn(s));
  // 0 is a real value right after a rebirth; only a save without the field falls back to the total
  s.run = r.run === undefined || r.run === null ? s.total : Big.decode(r.run).min(s.total);
  if (typeof r.epoch === 'number' && Number.isFinite(r.epoch)) s.epoch = r.epoch;
  return s;
}

/** Состояние в виде, который можно положить в JSON (числа, пока влезают, иначе пары [мантисса, порядок]) */
export function serializeClicker(s: ClickerState): Record<string, unknown> {
  return {
    points: s.points.encode(),
    total: s.total.encode(),
    run: s.run.encode(),
    levels: s.levels,
    cores: s.cores.encode(),
    coresTotal: s.coresTotal.encode(),
    coreLevels: s.coreLevels,
    resets: s.resets,
    clicks: s.clicks,
    goldens: s.goldens,
    bestCombo: s.bestCombo,
    savedAt: s.savedAt,
    ...(s.epoch !== undefined ? { epoch: s.epoch } : {}),
  };
}

/** Сколько очков потрачено на купленное (без скидок: ориентир для старых сохранений) */
function spentOn(s: ClickerState): Big {
  let sum = Big.ZERO;
  for (const item of CLICKER_ITEMS) {
    const lv = s.levels[item.id] ?? 0;
    if (lv > 0) sum = sum.add(item.price.mul((item.growth ** lv - 1) / (item.growth - 1)));
  }
  return sum;
}

// ---------- расчёт ----------

export interface ClickerStats {
  /** множитель всей добычи (усилители, ядра) */
  prodMult: Big;
  clickMult: Big;
  /** очков за нажатие без крита */
  perClick: Big;
  critChance: number;
  critMult: number;
  /** добыча зданий в секунду */
  buildingsSec: Big;
  /** автокликов в секунду и очков от них в секунду (с критами) */
  autoRate: number;
  autoSec: Big;
  /** всего в секунду */
  perSec: Big;
  /** цены умножаются на это */
  priceFactor: number;
  /** через сколько секунд в среднем может прилететь золотая звезда, и сколько секунд добычи она даёт */
  goldenEvery: number;
  goldenSecs: number;
  /** фон: доля добычи и множитель сверху */
  offEff: number;
  offMult: number;
  startPoints: Big;
  /** комбо: на сколько растёт множитель за нажатие и до скольки нажатий */
  comboStep: number;
  comboCap: number;
  /** золотая звезда: шанс появиться при каждом броске, сколько секунд висит */
  goldenChance: number;
  goldenLife: number;
  /** пауза между нажатиями, после которой комбо рассыпается, мс */
  comboGapMs: number;
  /** через сколько секунд звёзды ловятся сами (0 — не ловятся) */
  hunterDelay: number;
  /** шанс, что пойманная золотая звезда сработает ещё раз */
  echoChance: number;
  /** «Ярость»: множитель добычи и длительность, секунд */
  frenzyMult: number;
  frenzySecs: number;
  /** «Клик-шторм»: множитель клика (15 с) */
  stormMult: number;
  /** «Звёздный дождь»: сколько звёзд и сколько секунд добычи в каждой */
  rainStars: number;
  rainSecs: number;
  /** сколько достижений получено */
  achievements: number;
}

function boostSum(s: Pick<ClickerState, 'levels'>, effect: BoostEffect): number {
  let sum = 0;
  for (const item of CLICKER_ITEMS) if (item.effect === effect) sum += (s.levels[item.id] ?? 0) * item.step!;
  return sum;
}

/** Уровни, на которых каждое улучшение «Клик» и «Авто» удваивает свою отдачу */
export const MILESTONES: readonly number[] = [10, 25, 50, 75, 100, 150, 200];

/** Во сколько раз отдача улучшения выше из-за достигнутых рубежей: ×2 на каждом */
export const milestoneMult = (level: number): number => 2 ** MILESTONES.filter((m) => level >= m).length;

/** Следующий рубеж улучшения (null — все пройдены) */
export const nextMilestone = (level: number): number | null => MILESTONES.find((m) => level < m) ?? null;

/** Произведение: каждый уровень умножает на step (для «Двигателя» и «Кулака-мультипликатора») */
function boostProduct(s: Pick<ClickerState, 'levels'>, effect: BoostEffect): number {
  let p = 1;
  for (const item of CLICKER_ITEMS) if (item.effect === effect) p *= item.step! ** (s.levels[item.id] ?? 0);
  return p;
}

export function clickerStats(s: ClickerState): ClickerStats {
  const cl = (id: string) => s.coreLevels[id] ?? 0;
  const coreBonus = Big.ONE.add(s.coresTotal.mul(CORE_BONUS + boostSum(s, 'coreboost') + cl('c_synth') * coreStep('c_synth')));
  const achievements = achievementsEarned(s).length;
  const achBonus = 1 + achievements * (ACH_BONUS + boostSum(s, 'achboost'));
  // «Синергия»: каждый уровень улучшений страницы «Авто» чуть поднимает добычу
  let autoLevels = 0;
  for (const item of CLICKER_ITEMS) if (item.page === 'auto') autoLevels += s.levels[item.id] ?? 0;
  const synergy = 1 + autoLevels * boostSum(s, 'synergy');
  const prodMult = coreBonus.mul((1 + boostSum(s, 'power')) * coreStep('c_prod') ** cl('c_prod') * achBonus * synergy * boostProduct(s, 'prodx'));
  const clickMult = coreBonus.mul((1 + boostSum(s, 'clickpower')) * coreStep('c_click') ** cl('c_click') * achBonus * boostProduct(s, 'clickx'));
  let baseClick = Big.ONE;
  let baseSec = Big.ZERO;
  for (const item of CLICKER_ITEMS) {
    const lv = s.levels[item.id] ?? 0;
    if (!lv) continue;
    // каждый рубеж уровня (10, 25, 50…) удваивает отдачу этого улучшения
    const m = milestoneMult(lv);
    if (item.click) baseClick = baseClick.add(item.click.mul(lv * m));
    if (item.sec) baseSec = baseSec.add(item.sec.mul(lv * m));
  }
  const buildingsSec = baseSec.mul(prodMult);
  const perClick = baseClick.mul(clickMult).add(buildingsSec.mul(boostSum(s, 'resonance')));
  const critChance = Math.min(0.6, boostSum(s, 'crit'));
  const critMult = 5 + boostSum(s, 'critpow');
  const autoRate = boostSum(s, 'auto');
  const comboCap = COMBO_BASE_CAP + boostSum(s, 'combocap');
  const comboStep = COMBO_BASE_STEP + boostSum(s, 'combostep') + cl('c_combo') * coreItem('c_combo')!.step;
  // «Метроном»: автонажатия получают часть самого большого бонуса комбо
  const autoCombo = 1 + Math.min(1, boostSum(s, 'autocombo')) * comboCap * comboStep;
  const autoSec = perClick.mul(autoRate * (1 + critChance * (critMult - 1)) * autoCombo);
  return {
    prodMult,
    clickMult,
    perClick,
    critChance,
    critMult,
    buildingsSec,
    autoRate,
    autoSec,
    perSec: buildingsSec.add(autoSec),
    priceFactor: Math.max(0.3, 1 - boostSum(s, 'discount') - cl('c_discount') * coreItem('c_discount')!.step),
    goldenEvery: Math.max(5, 20 - boostSum(s, 'golden')),
    goldenSecs: 60 + boostSum(s, 'goldenboost'),
    offEff: Math.min(1, OFFLINE_BASE_EFF + boostSum(s, 'offeff') + cl('c_offline') * coreItem('c_offline')!.step),
    offMult: 1 + boostSum(s, 'offmult'),
    startPoints: cl('c_start') ? Big.from(100 * 10 ** cl('c_start')) : Big.ZERO,
    comboStep,
    comboCap,
    comboGapMs: COMBO_GAP_MS + boostSum(s, 'combogap') * 1000,
    hunterDelay: boostSum(s, 'hunter') > 0 ? Math.max(0.4, 4.2 - boostSum(s, 'hunter') * 0.8) : 0,
    echoChance: Math.min(0.75, boostSum(s, 'echo')),
    goldenChance: 0.35,
    goldenLife: 6,
    frenzyMult: 7 + boostSum(s, 'frenzypow'),
    frenzySecs: 30 + boostSum(s, 'frenzylen'),
    stormMult: 10 + boostSum(s, 'stormpow'),
    rainStars: 6 + boostSum(s, 'rainstars'),
    rainSecs: 5 * (1 + boostSum(s, 'raingain')),
    achievements,
  };
}

/** Цена следующей покупки (мелкие цены — целые) */
export function priceOf(item: ClickerItem, owned: number, priceFactor: number): Big {
  const p = item.price.mul(item.growth ** owned * priceFactor);
  return p.e < 15 ? Big.of(Math.ceil(p.toNumber())) : p;
}

/** Цена `count` покупок подряд */
export function bulkPrice(item: ClickerItem, owned: number, n: number, priceFactor: number): Big {
  if (n <= 0) return Big.ZERO;
  const g = item.growth;
  const p = item.price.mul(((g ** owned * (g ** n - 1)) / (g - 1)) * priceFactor);
  return p.e < 15 ? Big.of(Math.ceil(p.toNumber())) : p;
}

/** Сколько можно купить на `points`, не выходя за предел (не больше `want`) */
export function affordable(item: ClickerItem, owned: number, cap: number, points: Big, priceFactor: number, want = Infinity): number {
  let n = 0;
  let left = points;
  for (let k = owned; k < cap && n < want; k++) {
    const p = priceOf(item, k, priceFactor);
    if (p.gt(left)) break;
    left = left.sub(p);
    n++;
  }
  return n;
}

/** Покупка `count` раз: новое состояние или null, если нельзя */
export function buyItem(s: ClickerState, id: string, n: number): ClickerState | null {
  const item = clickerItem(id);
  if (!item || n < 1) return null;
  const owned = s.levels[id] ?? 0;
  const room = maxLevel(item, s) - owned;
  const k = Math.min(n, room);
  if (k < 1) return null;
  const cost = bulkPrice(item, owned, k, clickerStats(s).priceFactor);
  if (cost.gt(s.points)) return null;
  return { ...s, points: s.points.sub(cost), levels: { ...s.levels, [id]: owned + k } };
}

export const corePrice = (item: CoreItem, owned: number) => Math.ceil(item.price * item.growth ** owned);

export function buyCore(s: ClickerState, id: string): ClickerState | null {
  const item = coreItem(id);
  if (!item) return null;
  const owned = s.coreLevels[id] ?? 0;
  const price = corePrice(item, owned);
  if (owned >= item.max || s.cores.lt(price)) return null;
  return { ...s, cores: s.cores.sub(price), coreLevels: { ...s.coreLevels, [id]: owned + 1 } };
}

/** Сколько надо заработать за заход, чтобы переродиться в (resets + 1)-й раз */
export const prestigeNeed = (resets: number): Big => Big.of(PRESTIGE_MIN).mul(PRESTIGE_GROWTH ** Math.min(resets, 400));

/** Перерождение даёт ровно одно ядро, но порог с каждым разом выше: 1 или 0 */
export const prestigeGain = (run: Big, resets = 0): Big => (run.lt(prestigeNeed(resets)) ? Big.ZERO : Big.ONE);

/**
 * С чем начинается новый заход: «Память» оставляет долю уровней страниц «Бусты» и «Лаборатория»,
 * «Быстрый старт» дарит уровни самым дешёвым улучшениям «Клик» и «Авто».
 */
export function levelsAfterRebirth(s: Pick<ClickerState, 'levels' | 'coreLevels'>): Record<string, number> {
  const out: Record<string, number> = {};
  const keep = (s.coreLevels.c_memory ?? 0) * coreStep('c_memory');
  if (keep > 0) {
    for (const item of CLICKER_ITEMS) {
      if (item.page !== 'boost' && item.page !== 'lab') continue;
      const lv = Math.floor((s.levels[item.id] ?? 0) * keep);
      if (lv > 0) out[item.id] = lv;
    }
  }
  const head = s.coreLevels.c_head ?? 0;
  if (head > 0) {
    for (const page of ['click', 'auto'] as const) {
      const cheapest = CLICKER_ITEMS.filter((i) => i.page === page).slice(0, 3 + head);
      for (const item of cheapest) out[item.id] = Math.min(item.max, head * coreStep('c_head'));
    }
  }
  return out;
}

/** Перерождение: очки и улучшения страниц сгорают, ядро и покупки за ядра остаются. */
export function prestige(s: ClickerState, now = Date.now()): ClickerState | null {
  const gain = prestigeGain(s.run, s.resets);
  if (gain.lt(1)) return null;
  const next: ClickerState = { ...s, points: Big.ZERO, run: Big.ZERO, levels: levelsAfterRebirth(s), cores: s.cores.add(gain), coresTotal: s.coresTotal.add(gain), resets: s.resets + 1, savedAt: now };
  next.points = clickerStats(next).startPoints;
  return next;
}

/** Добавить заработанное (клик, секунда, золотая звезда) */
export function earn(s: ClickerState, amount: BigLike): ClickerState {
  const a = Big.of(amount);
  if (a.isZero) return s;
  return { ...s, points: s.points.add(a), total: s.total.add(a), run: s.run.add(a) };
}

/**
 * Добыча, пока игры не было: всё время вдали × добыча в секунду × КПД фона × множитель «Разгона».
 * Предела по времени нет. Золотых звёзд и крит-бонусов вдали нет, но автокликеры работают.
 */
export function offlineGain(s: ClickerState, now: number): { seconds: number; gained: Big } {
  const st = clickerStats(s);
  const seconds = Math.max(0, (now - s.savedAt) / 1000);
  return { seconds, gained: st.perSec.mul(seconds * st.offEff * st.offMult).floor() };
}


// ---------- достижения ----------

export type AchKind = 'clicks' | 'total' | 'resets' | 'goldens' | 'levels' | 'combo';
export interface Achievement {
  id: string;
  kind: AchKind;
  /** порог (для `total` — порядок: 6 = 1e6) */
  need: number;
  icon: string;
}

const ACH_TABLE: Record<AchKind, { icon: string; needs: number[] }> = {
  clicks: { icon: '👆', needs: [100, 1000, 10_000, 100_000, 1_000_000] },
  total: { icon: '💰', needs: [3, 6, 9, 12, 18, 30, 45, 60, 90, 120] },
  resets: { icon: '☢️', needs: [1, 2, 3, 5, 8, 12, 20, 30] },
  goldens: { icon: '🌟', needs: [1, 10, 50, 200, 1000] },
  levels: { icon: '🏗️', needs: [25, 100, 300, 700, 1500, 3000] },
  combo: { icon: '🔥', needs: [10, 25, 50, 100, 200] },
};

export const ACHIEVEMENTS: readonly Achievement[] = (Object.keys(ACH_TABLE) as AchKind[]).flatMap((kind) =>
  ACH_TABLE[kind].needs.map((need) => ({ id: `${kind}_${need}`, kind, need, icon: ACH_TABLE[kind].icon })),
);

/** Достижения считаются по самому состоянию, отдельно их хранить не нужно */
export function achievementsEarned(s: ClickerState): string[] {
  let levels = 0;
  for (const v of Object.values(s.levels)) levels += v;
  const order = s.total.isZero ? 0 : s.total.e;
  const value: Record<AchKind, number> = { clicks: s.clicks, total: order, resets: s.resets, goldens: s.goldens, levels, combo: s.bestCombo };
  return ACHIEVEMENTS.filter((a) => value[a.kind] >= a.need).map((a) => a.id);
}

/** Прогресс к достижению для показа: текущее значение того же вида */
export function achievementValue(s: ClickerState, kind: AchKind): number {
  let levels = 0;
  for (const v of Object.values(s.levels)) levels += v;
  return { clicks: s.clicks, total: s.total.isZero ? 0 : s.total.e, resets: s.resets, goldens: s.goldens, levels, combo: s.bestCombo }[kind];
}

// ---------- комбо и золотые события ----------

/** Множитель силы нажатия от комбо: 1 + нажатия подряд × шаг (до предела) */
export const comboMult = (combo: number, st: Pick<ClickerStats, 'comboStep' | 'comboCap'>): number =>
  1 + Math.min(Math.max(0, Math.floor(combo)), st.comboCap) * st.comboStep;

export type GoldenKind = 'lucky' | 'frenzy' | 'storm' | 'rain';
export const GOLDEN_KINDS: readonly GoldenKind[] = ['lucky', 'frenzy', 'storm', 'rain'];

/** Что даст пойманная звезда: r — случайное число от 0 до 1 */
export function rollGolden(r: number): GoldenKind {
  if (r < 0.4) return 'lucky';
  if (r < 0.65) return 'frenzy';
  if (r < 0.85) return 'storm';
  return 'rain';
}

// ---------- фон по доходу ----------

export interface IncomeTier {
  /** 0 — доход меньше 1 в секунду, дальше ступень растёт на каждые 6 порядков */
  tier: number;
  /** оттенок фона, 0..359 */
  hue: number;
}

export const INCOME_TIERS = 25;

/** Ступень дохода в секунду: от неё зависит цвет фона игры */
export function incomeTier(perSec: Big): IncomeTier {
  const tier = perSec.lt(1) ? 0 : Math.min(INCOME_TIERS - 1, 1 + Math.floor(perSec.e / 6));
  return { tier, hue: (205 + tier * 47) % 360 };
}
