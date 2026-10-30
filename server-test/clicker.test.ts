import type { ClickerState } from '@timba/shared';
import { describe, expect, it } from 'vitest';
import {
  ADMIN_GAMES,
  ADMIN_GAME_KEYS,
  Big,
  CLICKER_ITEMS,
  CORE_ITEMS,
  E,
  MAX_NAMED_ORDER,
  ACH_BONUS,
  ACHIEVEMENTS,
  COMBO_BASE_CAP,
  COMBO_BASE_STEP,
  INCOME_TIERS,
  PRESTIGE_MIN,
  achievementsEarned,
  affordable,
  betterSave,
  bigSuffix,
  bulkPrice,
  buyCore,
  buyItem,
  clickerStats,
  comboMult,
  earn,
  formatBig,
  incomeTier,
  freshClicker,
  maxLevel,
  milestoneMult,
  nextMilestone,
  normalizeClicker,
  offlineGain,
  prestige,
  prestigeGain,
  prestigeNeed,
  priceOf,
  SCORE_GAMES,
  adminGame,
  fieldValues,
  gameKeys,
  parseBig,
  rollGolden,
  saveProgress,
  serializeClicker,
  validFieldValue,
} from '@timba/shared';

const b = (v: number) => Big.of(v);

describe('big numbers: arithmetic', () => {
  it('adds, subtracts, multiplies and divides far beyond a double', () => {
    expect(b(2).add(3).toNumber()).toBe(5);
    expect(b(5).sub(8).isZero).toBe(true);
    expect(b(1e300).mul(1e300).e).toBe(600);
    expect(E(1, 1000).mul(E(5, 1000)).cmp(E(5, 2000))).toBe(0);
    expect(E(1, 2000).div(E(1, 1999)).toNumber()).toBe(10);
    // a number far smaller than the other one changes nothing
    expect(E(1, 100).add(1).cmp(E(1, 100))).toBe(0);
    // cancelling digits (about 15 significant ones are kept)
    expect(b(1e12).add(1).sub(1e12).toNumber()).toBeCloseTo(1, 2);
    expect(E(1, 400).sqrt().cmp(E(1, 200))).toBe(0);
    expect(E(1, 401).sqrt().e).toBe(200);
    expect(b(16).sqrt().toNumber()).toBe(4);
  });

  it('compares, floors, and keeps zero zero', () => {
    expect(b(3).gt(2)).toBe(true);
    expect(E(1, 500).gt(E(9, 499))).toBe(true);
    expect(Big.ZERO.lt(1e-300)).toBe(true);
    expect(Big.ZERO.cmp(0)).toBe(0);
    expect(b(12.9).floor().toNumber()).toBe(12);
    expect(Big.ZERO.mul(E(1, 900)).isZero).toBe(true);
    expect(b(-5).isZero).toBe(true);
    expect(Big.from(NaN).isZero).toBe(true);
    expect(E(1, 400).toNumber()).toBe(Infinity);
  });

  it('is saved as a number while it fits, as a pair after, and reads both (and rubbish)', () => {
    expect(b(1234).encode()).toBe(1234);
    expect(E(1.5, 500).encode()).toEqual([1.5, 500]);
    expect(Big.decode([1.5, 500]).cmp(E(1.5, 500))).toBe(0);
    expect(Big.decode(77).toNumber()).toBe(77);
    for (const junk of [null, 'x', NaN, [1], [NaN, 3], {}, -4]) expect(Big.decode(junk).isZero).toBe(true);
  });
});

describe('big numbers: names', () => {
  it('K, M, B, T, then Q with its repeats, then S, D, G, X, F, L like a counter', () => {
    const names = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => bigSuffix(from + k));
    expect(names(1, 11)).toEqual(['K', 'M', 'B', 'T', 'Q', 'QK', 'QM', 'QB', 'QT', 'QQ', 'QQK']);
    // the end of Q: QQQ…, then S begins
    expect(names(15, 20)).toEqual(['QQQ', 'QQQK', 'QQQM', 'QQQB', 'QQQT', 'S']);
    expect(bigSuffix(19)).toBe('QQQT');
    expect(bigSuffix(20)).toBe('S');
    expect(names(20, 26)).toEqual(['S', 'SK', 'SM', 'SB', 'ST', 'SQ', 'SQK']);
    expect(bigSuffix(39)).toBe('SQQQT');
    expect(bigSuffix(40)).toBe('SS');
    expect(bigSuffix(41)).toBe('SSK');
    expect(bigSuffix(79)).toBe('SSSQQQT');
    expect(bigSuffix(80)).toBe('D');
    expect(bigSuffix(81)).toBe('DK');
    expect(bigSuffix(99)).toBe('DQQQT');
    expect(bigSuffix(100)).toBe('DS');
    expect(bigSuffix(159)).toBe('DSSSQQQT');
    expect(bigSuffix(160)).toBe('DD');
    expect(bigSuffix(319)).toBe('DDDSSSQQQT');
    expect(bigSuffix(320)).toBe('G');
    expect(bigSuffix(1280)).toBe('X');
    expect(bigSuffix(5120)).toBe('F');
    expect(bigSuffix(20480)).toBe('L');
    expect(bigSuffix(MAX_NAMED_ORDER)).toBe('LLLFFFXXXGGGDDDSSSQQQT');
    expect(bigSuffix(MAX_NAMED_ORDER + 1)).toBeNull();
    // every order has its own name
    const all = new Set<string>();
    for (let i = 1; i <= 5000; i++) all.add(bigSuffix(i)!);
    expect(all.size).toBe(5000);
  });

  it('formats numbers short, with a comma, rounding up into the next order', () => {
    expect(formatBig(0)).toBe('0');
    expect(formatBig(7)).toBe('7');
    expect(formatBig(0.5)).toBe('0,5');
    expect(formatBig(999)).toBe('999');
    expect(formatBig(1000)).toBe('1K');
    expect(formatBig(12_345)).toBe('12,3K');
    expect(formatBig(999_960)).toBe('1M');
    expect(formatBig(4.5e9)).toBe('4,5B');
    expect(formatBig(1e12)).toBe('1T');
    expect(formatBig(2.5e15)).toBe('2,5Q');
    expect(formatBig(7e18)).toBe('7QK');
    expect(formatBig(1e30)).toBe('1QQ');
    expect(formatBig(1e57)).toBe('1QQQT');
    expect(formatBig(E(1, 60))).toBe('1S');
    expect(formatBig(E(2.5, 63))).toBe('2,5SK');
    expect(formatBig(E(1, 117))).toBe('1SQQQT');
    expect(formatBig(E(1, 240))).toBe('1D');
    expect(formatBig(E(3.2, 243))).toBe('3,2DK');
    expect(formatBig(E(1, 960))).toBe('1G');
    expect(formatBig(E(1, 3840))).toBe('1X');
    expect(formatBig(E(1, 15360))).toBe('1F');
    expect(formatBig(E(1, 61440))).toBe('1L');
    // 999,96 of an order rounds up into the next one
    expect(formatBig(E(9.9996, 62))).toBe('1SK');
    // above the last name: the exponent
    expect(formatBig(E(1.5, 250_000))).toBe('1,5e250000');
  });
});

describe('big numbers: typed by hand', () => {
  it('reads what formatBig writes, plain numbers and exponents', () => {
    expect(parseBig('1500')?.toNumber()).toBe(1500);
    expect(parseBig(' 12 345 ')?.toNumber()).toBe(12_345);
    expect(parseBig('0,5')?.toNumber()).toBe(0.5);
    expect(parseBig('12,5K')?.toNumber()).toBe(12_500);
    expect(parseBig('4.5b')?.toNumber()).toBe(4.5e9);
    expect(parseBig('7QK')?.toNumber()).toBe(7e18);
    expect(formatBig(parseBig('2,5SK')!)).toBe('2,5SK');
    expect(parseBig('1e60')?.e).toBe(60);
    expect(parseBig('1,5e250000')).toMatchObject({ e: 250_000, m: expect.closeTo(1.5, 9) });
    expect(parseBig('0')?.isZero).toBe(true);
    // every name it writes it reads back
    for (const v of [1e3, 3.3e7, 9e15, E(1, 60), E(6.4, 123), E(1, 3840), E(2.2, 61443)]) expect(formatBig(parseBig(formatBig(v))!)).toBe(formatBig(v));
  });

  it('refuses what is not a number', () => {
    for (const text of ['', 'abc', '-5', '1e', '12KZ', '1,2,3', '5 K K', 'e5', 'NaN', 'Infinity', '1e1000000000000']) expect(parseBig(text), text).toBeNull();
  });
});

describe('admin: the catalog of game saves', () => {
  it('has a place for every rated game, unique fields and keys that fit a save name', () => {
    for (const g of SCORE_GAMES) expect(adminGame(g.id), g.id).toBeDefined();
    const ids = ADMIN_GAMES.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    const fields = ADMIN_GAMES.flatMap((g) => g.fields.map((f) => f.id));
    expect(new Set(fields).size).toBe(fields.length);
    // a key belongs to one game only
    const keys = ADMIN_GAMES.flatMap(gameKeys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(ADMIN_GAME_KEYS.length).toBe(keys.length);
    for (const g of ADMIN_GAMES) expect(g.fields.some((f) => f.id === g.main), g.id).toBe(true);
    // a record is not smaller than the rating takes, so a hand-made one never gets to be out of its range
    for (const g of SCORE_GAMES) {
      const f = adminGame(g.id)!.fields.find((x) => x.id === adminGame(g.id)!.main)!;
      if (g.id !== 'clicker') expect([f.least ?? f.min, f.max], g.id).toEqual([g.min, g.max]);
    }
  });

  it('reads the progress of a game from its saves: none is not zero, the clicker counts rebirths', () => {
    const tetris = adminGame('tetris')!;
    expect(saveProgress(tetris, fieldValues(tetris, new Map([['best:tetris', 1200]])))).toEqual({ progress: 1200, tie: 0 });
    expect(saveProgress(tetris, fieldValues(tetris, new Map([['best:tetris', 0]]))).progress).toBeNull();
    expect(fieldValues(tetris, new Map([['best:tetris', 'junk']]))).toEqual({});
    const clicker = adminGame('clicker')!;
    const saved = serializeClicker({ ...freshClicker(), total: E(5, 400), resets: 4, clicks: 9 });
    const values = fieldValues(clicker, new Map([['clicker', saved]]));
    expect(values).toMatchObject({ 'clicker.resets': 4, 'clicker.total': [5, 400] });
    expect(saveProgress(clicker, values).progress).toBe(4);
    // more earned breaks a tie of rebirths
    expect(saveProgress(clicker, values).tie).toBeGreaterThan(saveProgress(clicker, fieldValues(clicker, new Map([['clicker', { ...saved, total: 1e9 }]]))).tie);
    // a fresh save is "nothing yet"; rebirths of zero with something earned are a progress of zero
    expect(saveProgress(clicker, fieldValues(clicker, new Map([['clicker', serializeClicker(freshClicker())]]))).progress).toBeNull();
    expect(saveProgress(clicker, fieldValues(clicker, new Map([['clicker', serializeClicker({ ...freshClicker(), total: Big.of(50) })]]))).progress).toBe(0);
  });

  it('checks a value against its field', () => {
    const f = (game: string, id: string) => adminGame(game)!.fields.find((x) => x.id === id)!;
    const record = f('minesweeper', 'best:minesweeper');
    expect([0, 2, 90, 86_400].map((v) => validFieldValue(record, v))).toEqual([true, true, true, true]);
    expect([1, -3, 86_401, 4.5, '5', NaN, null].map((v) => validFieldValue(record, v))).toEqual([false, false, false, false, false, false, false]);
    expect(validFieldValue(f('paper', 'best:paper'), 12.5)).toBe(true);
    expect(validFieldValue(f('paper', 'best:paper'), 12.55)).toBe(false);
    expect(validFieldValue(f('paper', 'best:paper'), 0.05)).toBe(false);
    expect(validFieldValue(f('subway', 'subway:own:cat'), 1)).toBe(true);
    expect(validFieldValue(f('subway', 'subway:own:cat'), 2)).toBe(false);
    expect(validFieldValue(f('helix', 'helix:level'), 0)).toBe(false);
    const big = f('clicker', 'clicker.total');
    expect([0, 1e9, [1.5, 400], [0, 0]].map((v) => validFieldValue(big, v))).toEqual([true, true, true, true]);
    expect([-1, [1.5, 4.5], [-1, 3], [1, 2, 3], 'x', Infinity].map((v) => validFieldValue(big, v))).toEqual([false, false, false, false, false, false]);
  });
});

describe('clicker: economy', () => {
  it('has unique items with sane numbers', () => {
    const ids = [...CLICKER_ITEMS, ...CORE_ITEMS].map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const i of CLICKER_ITEMS) {
      expect(i.max).toBeGreaterThan(0);
      expect(i.growth).toBeGreaterThan(1);
      expect(i.price.gt(0)).toBe(true);
    }
    // the ladder of the generators grows in price and in what it gives
    const auto = CLICKER_ITEMS.filter((i) => i.page === 'auto');
    for (let k = 1; k < auto.length; k++) {
      expect(auto[k]!.price.gt(auto[k - 1]!.price)).toBe(true);
      expect(auto[k]!.sec!.gt(auto[k - 1]!.sec!)).toBe(true);
    }
  });

  it('computes clicks and production from levels, with boosts and cores', () => {
    let s = freshClicker(0);
    expect(clickerStats(s).perClick.toNumber()).toBe(1);
    expect(clickerStats(s).perSec.isZero).toBe(true);
    s = { ...s, levels: { finger: 10, glove: 2, cursor: 5, cat: 2 } };
    // ten levels of «Сильный палец» reach the first milestone: its +10 become +20
    expect(clickerStats(s).perClick.toNumber()).toBe(1 + 20 + 20);
    expect(clickerStats(s).perSec.toNumber()).toBe(15);
    // +50% to production for every level of «Усилитель»; +25% for every core
    s = { ...s, levels: { ...s.levels, power: 2 }, coresTotal: b(4) };
    expect(clickerStats(s).buildingsSec.toNumber()).toBeCloseTo(15 * 2 * 2);
    // autoclicks add to the production
    s = { ...freshClicker(0), levels: { finger: 4, auto: 4 } };
    const st = clickerStats(s);
    expect(st.perClick.toNumber()).toBe(5);
    expect(st.autoRate).toBe(4);
    expect(st.perSec.toNumber()).toBe(20);
  });

  it('prices grow, bulk buys add up, the limit of a level stops the purchase', () => {
    const f = CLICKER_ITEMS.find((i) => i.id === 'finger')!;
    expect(priceOf(f, 0, 1).toNumber()).toBe(15);
    expect(priceOf(f, 10, 1).toNumber()).toBe(Math.ceil(15 * 1.15 ** 10));
    expect(bulkPrice(f, 0, 3, 1).toNumber()).toBeGreaterThanOrEqual(priceOf(f, 0, 1).toNumber() + priceOf(f, 1, 1).toNumber() + priceOf(f, 2, 1).toNumber() - 3);
    expect(affordable(f, 0, 100, b(40), 1)).toBe(2);

    let s: ClickerState | null = { ...freshClicker(0), points: E(1, 60), levels: { finger: 98 } };
    // two more fit under the limit of 100: asking for five buys two
    s = buyItem(s, 'finger', 5)!;
    expect(s.levels.finger).toBe(100);
    expect(buyItem(s, 'finger', 1)).toBeNull();
    // the core upgrade «Расширение» lifts the limit of every item by 5 per level
    const lifted = buyCore({ ...s, cores: b(100) }, 'c_cap')!;
    expect(maxLevel(f, lifted)).toBe(105);
    expect(buyItem(lifted, 'finger', 10)!.levels.finger).toBe(105);
    expect(buyItem({ ...freshClicker(0), points: b(14) }, 'finger', 1)).toBeNull();
    expect(buyItem({ ...freshClicker(0), points: b(15) }, 'finger', 1)!.points.isZero).toBe(true);
    // the expensive items cost more than a double holds, and still can be bought
    const top = CLICKER_ITEMS.find((i) => i.id === 'timbaverse')!;
    const rich: ClickerState = { ...freshClicker(0), points: E(1, 140) };
    expect(priceOf(top, 0, 1).e).toBe(138);
    expect(buyItem(rich, 'timbaverse', 1)!.points.lt(E(1, 140))).toBe(true);
    // far richer: the price is a rounding error, the points stay
    expect(buyItem({ ...rich, points: E(1, 200) }, 'timbaverse', 1)!.points.cmp(E(1, 200))).toBe(0);
  });

  it('discounts lower the prices but never below 30%', () => {
    const s = { ...freshClicker(0), levels: { discount: 10 }, coreLevels: { c_discount: 10 } };
    expect(clickerStats(s).priceFactor).toBeCloseTo(0.6);
    expect(clickerStats({ ...s, coreLevels: { c_discount: 15 }, levels: { discount: 40 } }).priceFactor).toBeGreaterThanOrEqual(0.3);
  });

  it('earns and counts the total, with no upper limit', () => {
    let s = freshClicker(0);
    s = earn(s, 50);
    expect([s.points, s.total, s.run].map((x) => x.toNumber())).toEqual([50, 50, 50]);
    expect(earn(s, -5)).toBe(s);
    const huge = earn({ ...s, points: E(1, 400) }, E(1, 400));
    expect(huge.points.cmp(E(2, 400))).toBe(0);
  });
});

describe('clicker: background farming', () => {
  const hour = 3600 * 1000;

  it('gives the production for the whole time away, with no limit', () => {
    const s = { ...freshClicker(0), levels: { cursor: 9 } }; // 9 per second
    // 25% by default
    expect(offlineGain(s, hour).gained.toNumber()).toBe(9 * 3600 * 0.25);
    // a week away is a week of production, not 8 hours of it
    expect(offlineGain(s, 168 * hour).gained.toNumber()).toBe(9 * 3600 * 168 * 0.25);
    expect(offlineGain(s, 168 * hour).seconds).toBe(168 * 3600);
    // a clock set back gives nothing
    expect(offlineGain({ ...s, savedAt: 5000 }, 1000).gained.isZero).toBe(true);
  });

  it('«Автопилот» raises the share, «Разгон» multiplies it, the autoclickers work too', () => {
    // 5 + 15 + 4 = 24 levels: no milestone and no «levels» achievement yet
    const s = { ...freshClicker(0), levels: { cursor: 5, autopilot: 15 } };
    expect(clickerStats(s).offEff).toBeCloseTo(1);
    expect(Math.abs(offlineGain(s, hour).gained.toNumber() - 5 * 3600)).toBeLessThanOrEqual(1);
    const fast = { ...s, levels: { ...s.levels, overclock: 4 } };
    expect(clickerStats(fast).offMult).toBe(3);
    expect(Math.abs(offlineGain(fast, hour).gained.toNumber() - 5 * 3600 * 3)).toBeLessThanOrEqual(1);
    const auto = { ...freshClicker(0), levels: { finger: 4, auto: 4 } };
    expect(offlineGain(auto, hour).gained.toNumber()).toBe(Math.floor(3600 * 20 * 0.25));
    // in a huge economy the gain goes beyond a double and stays exact enough
    const mega = { ...freshClicker(0), levels: { timbaverse: 20 } };
    expect(offlineGain(mega, 1000 * hour).gained.e).toBeGreaterThan(140);
  });
});

describe('clicker: rebirth', () => {
  it('gives exactly one core, asks five times more each time, resets the run and keeps the cores and their upgrades', () => {
    expect(prestigeNeed(0).toNumber()).toBe(PRESTIGE_MIN);
    expect(prestigeNeed(2).toNumber()).toBe(PRESTIGE_MIN * 25);
    expect(prestigeGain(b(PRESTIGE_MIN - 1)).isZero).toBe(true);
    expect(prestigeGain(b(PRESTIGE_MIN)).toNumber()).toBe(1);
    // a huge run is still one core
    expect(prestigeGain(E(1, 410)).toNumber()).toBe(1);
    // the next rebirth asks for more
    expect(prestigeGain(b(PRESTIGE_MIN * 4), 1).isZero).toBe(true);
    expect(prestigeGain(b(PRESTIGE_MIN * 5), 1).toNumber()).toBe(1);
    let s: ClickerState = { ...freshClicker(0), points: b(5e10), total: b(5e10), run: b(4e12), levels: { cursor: 30, power: 3 }, coreLevels: { c_start: 2 }, clicks: 77 };
    expect(prestige({ ...s, run: b(1) })).toBeNull();
    const r = prestige(s, 99)!;
    expect(r).toMatchObject({ levels: {}, resets: 1, clicks: 77, savedAt: 99 });
    expect(r.run.isZero).toBe(true);
    expect(r.total.toNumber()).toBe(5e10);
    expect(r.cores.toNumber()).toBe(1);
    expect(r.coresTotal.toNumber()).toBe(1);
    // «Стартовый капитал» level 2 = 100 × 10² points to begin with
    expect(r.points.toNumber()).toBe(10_000);
    expect(r.coreLevels).toEqual({ c_start: 2 });
    // the second rebirth needs 5e10: 4e10 is not enough
    expect(prestige({ ...r, run: b(4e10) })).toBeNull();
    expect(prestige({ ...r, run: b(5e10) })!.cores.toNumber()).toBe(2);
    s = { ...r, cores: b(20), coresTotal: b(20) };
    const bought = buyCore(s, 'c_prod')!;
    expect(bought.coreLevels.c_prod).toBe(1);
    expect(bought.cores.toNumber()).toBe(20 - 2);
    expect(buyCore({ ...s, cores: Big.ZERO }, 'c_prod')).toBeNull();
    expect(buyCore({ ...s, cores: b(1e9), coreLevels: { c_prod: 10 } }, 'c_prod')).toBeNull();
    // every core gives +25% to everything
    // (24 levels: the milestone of 10 doubles the output, the core bonus is ×2 on top)
    expect(clickerStats({ ...freshClicker(0), levels: { cursor: 24 }, coresTotal: b(4) }).perSec.toNumber()).toBeCloseTo(24 * 2 * 2);
  });
});

describe('clicker: achievements, combo, golden events, backgrounds', () => {
  it('counts achievements from the state itself and each one adds +2%', () => {
    const none = freshClicker(0);
    expect(achievementsEarned(none)).toEqual([]);
    const some: ClickerState = { ...none, clicks: 1500, goldens: 1, resets: 2, bestCombo: 30, total: E(1, 9) };
    const ids = achievementsEarned(some);
    expect(ids).toEqual(expect.arrayContaining(['clicks_100', 'clicks_1000', 'goldens_1', 'resets_1', 'resets_2', 'combo_10', 'combo_25', 'total_3', 'total_6', 'total_9']));
    expect(ids).not.toContain('clicks_10000');
    expect(new Set(ACHIEVEMENTS.map((a) => a.id)).size).toBe(ACHIEVEMENTS.length);
    const base = clickerStats({ ...none, levels: { finger: 10 } }).perClick.toNumber();
    const withAch = clickerStats({ ...some, levels: { finger: 10 } });
    expect(withAch.achievements).toBe(ids.length);
    expect(withAch.perClick.toNumber()).toBeCloseTo(base * (1 + ids.length * ACH_BONUS));
    // «Трофейная полка» makes each one worth more
    const more = clickerStats({ ...some, levels: { finger: 10, achboost: 5 } });
    expect(more.perClick.toNumber()).toBeCloseTo(base * (1 + ids.length * (ACH_BONUS + 0.1)));
  });

  it('combo grows the click up to a cap, the lab raises both', () => {
    const base = clickerStats(freshClicker(0));
    expect(comboMult(0, base)).toBe(1);
    expect(comboMult(10, base)).toBeCloseTo(1.1);
    expect(comboMult(1000, base)).toBeCloseTo(1 + COMBO_BASE_CAP * COMBO_BASE_STEP);
    const lab = clickerStats({ ...freshClicker(0), levels: { combocap: 3, combostep: 2 }, coreLevels: { c_combo: 1 } });
    expect(lab.comboCap).toBe(COMBO_BASE_CAP + 30);
    expect(lab.comboStep).toBeCloseTo(COMBO_BASE_STEP + 0.01 + 0.01);
    expect(comboMult(-5, lab)).toBe(1);
  });

  it('lab upgrades multiply the economy and change the golden events', () => {
    const base = clickerStats(freshClicker(0));
    expect([base.frenzyMult, base.frenzySecs, base.stormMult, base.rainStars, base.hunterDelay, base.echoChance, base.comboGapMs]).toEqual([7, 30, 10, 6, 0, 0, 1500]);
    const lab = clickerStats({ ...freshClicker(0), levels: { frenzypow: 4, frenzylen: 2, stormpow: 3, rainstars: 2, raingain: 4, echo: 4, combogap: 5 } });
    expect(lab.frenzyMult).toBe(11);
    expect(lab.frenzySecs).toBe(40);
    expect(lab.stormMult).toBe(19);
    expect(lab.rainStars).toBe(10);
    expect(lab.rainSecs).toBeCloseTo(15);
    expect(lab.echoChance).toBeCloseTo(0.2);
    expect(lab.comboGapMs).toBe(3000);
    // the hunter: the first level catches in 3.4 s, the fifth in 0.4 s
    expect(clickerStats({ ...freshClicker(0), levels: { hunter: 1 } }).hunterDelay).toBeCloseTo(3.4);
    expect(clickerStats({ ...freshClicker(0), levels: { hunter: 5 } }).hunterDelay).toBeCloseTo(0.4);
    // «Двигатель» and «Кулак-мультипликатор» compound: ×1.1 per level
    const mult = clickerStats({ ...freshClicker(0), levels: { cursor: 4, finger: 4, prodx: 8, clickx: 8 } });
    expect(mult.buildingsSec.toNumber()).toBeCloseTo(4 * 1.1 ** 8);
    expect(mult.perClick.toNumber()).toBeCloseTo((1 + 4) * 1.1 ** 8);
    // «Синергия»: 100 levels of «Авто» × 10 levels × 0.03% = +30% (two «levels» achievements add +4% more)
    const syn = clickerStats({ ...freshClicker(0), levels: { cursor: 100, synergy: 10 } });
    expect(syn.buildingsSec.toNumber()).toBeCloseTo(100 * 32 * 1.3 * 1.04);
    // «Метроном»: the autoclicks get the best bonus of the combo (cap 30 × 1%) = +30%
    const metro = clickerStats({ ...freshClicker(0), levels: { auto: 2, autocombo: 10 } });
    const plain = clickerStats({ ...freshClicker(0), levels: { auto: 2 } });
    expect(metro.autoSec.toNumber() / plain.autoSec.toNumber()).toBeCloseTo(1.3);
    // the odds of the four kinds
    expect([0, 0.39, 0.4, 0.64, 0.65, 0.84, 0.85, 0.99].map(rollGolden)).toEqual(['lucky', 'lucky', 'frenzy', 'frenzy', 'storm', 'storm', 'rain', 'rain']);
  });

  it('every milestone of an upgrade level doubles its output', () => {
    expect([0, 9, 10, 24, 25, 49, 50, 100, 200, 250].map(milestoneMult)).toEqual([1, 1, 2, 2, 4, 4, 8, 32, 128, 128]);
    expect(nextMilestone(0)).toBe(10);
    expect(nextMilestone(30)).toBe(50);
    expect(nextMilestone(200)).toBeNull();
    // 10 levels of «Автокликер» (+1 each): 10 × 2
    expect(clickerStats({ ...freshClicker(0), levels: { cursor: 10 } }).buildingsSec.toNumber()).toBe(20);
    expect(clickerStats({ ...freshClicker(0), levels: { cursor: 25 } }).buildingsSec.toNumber()).toBeCloseTo(25 * 4 * 1.02);
  });

  it('core upgrades: the rebirth keeps part of the boosts and gives a head start to the cheap upgrades', () => {
    const rich: ClickerState = { ...freshClicker(0), run: b(1e12), levels: { power: 10, prodx: 5, cursor: 80, finger: 40 }, coreLevels: { c_memory: 3, c_head: 2 }, cores: b(1), coresTotal: b(1) };
    const r = prestige(rich, 1)!;
    // «Память» level 3 keeps 30% of the levels of the pages «Бусты» and «Лаборатория»
    expect(r.levels.power).toBe(3);
    expect(r.levels.prodx).toBe(1);
    // «Быстрый старт» level 2: the first five upgrades of «Клик» and the first five of «Авто» are on level 10
    expect(r.levels.finger).toBe(10);
    expect(r.levels.cursor).toBe(10);
    expect(r.levels.glove).toBe(10);
    expect(r.levels.magnet).toBe(10);
    expect(r.levels.lucky).toBe(10);
    expect(r.levels.hand).toBe(10);
    expect(r.levels.titan).toBeUndefined();
    // without these upgrades nothing is kept
    expect(prestige({ ...rich, coreLevels: {} }, 1)!.levels).toEqual({});
    // «Ядерный синтез»: each core gives +5% more per level
    const synth = clickerStats({ ...freshClicker(0), levels: { cursor: 9 }, coresTotal: b(4), coreLevels: { c_synth: 2 } });
    expect(synth.buildingsSec.toNumber()).toBeCloseTo(9 * (1 + 4 * 0.35));
  });

  it('the background tier follows the income per second: a new colour every 6 orders', () => {
    expect(incomeTier(Big.ZERO)).toEqual({ tier: 0, hue: 205 });
    expect(incomeTier(b(1)).tier).toBe(1);
    expect(incomeTier(b(999_999)).tier).toBe(1);
    expect(incomeTier(b(1e6)).tier).toBe(2);
    expect(incomeTier(E(1, 600)).tier).toBe(INCOME_TIERS - 1);
    const hues = new Set(Array.from({ length: INCOME_TIERS }, (_, i) => incomeTier(i === 0 ? Big.ZERO : E(1, (i - 1) * 6)).hue));
    expect(hues.size).toBe(INCOME_TIERS);
    expect(incomeTier(b(5)).hue).toBe((205 + 47) % 360);
  });
});

describe('clicker: saves', () => {
  it('reads a save of the old version (owned, no total) and clamps the levels', () => {
    const s = normalizeClicker({ points: 120, owned: { finger: 3, cat: 500, nonsense: 9 }, savedAt: 1000 }, 5000);
    expect(s.points.toNumber()).toBe(120);
    expect(s.levels).toEqual({ finger: 3, cat: 100 });
    expect(s.savedAt).toBe(1000);
    expect(s.total.gt(120)).toBe(true);
    expect(normalizeClicker(null, 7)).toMatchObject({ levels: {}, savedAt: 7 });
    const junk = normalizeClicker({ points: -4, levels: { finger: NaN, cat: -1 }, total: 'x' }, 7);
    expect(junk.points.isZero).toBe(true);
    expect(junk.levels).toEqual({});
  });

  it('survives a round trip through JSON, also with numbers beyond a double', () => {
    const s: ClickerState = { ...freshClicker(5), points: E(3.5, 500), total: E(8, 612), run: E(8, 612), levels: { cursor: 7 }, cores: E(1, 300), coresTotal: E(2, 300), resets: 3, clicks: 9 };
    const back = normalizeClicker(JSON.parse(JSON.stringify(serializeClicker(s))), 5);
    expect(back.points.cmp(s.points)).toBe(0);
    expect(back.total.cmp(s.total)).toBe(0);
    expect(back.cores.cmp(s.cores)).toBe(0);
    expect(back).toMatchObject({ levels: { cursor: 7 }, resets: 3, clicks: 9 });
    // a small save is plain numbers, as before
    expect(serializeClicker({ ...freshClicker(1), points: b(42), total: b(42) })).toMatchObject({ points: 42, total: 42 });
  });

  it('keeps a run of zero after a rebirth (it must not fall back to the total and allow another rebirth at once)', () => {
    const rich: ClickerState = { ...freshClicker(5), total: E(1, 12), run: E(1, 12), points: E(1, 12) };
    const reborn = prestige(rich, 6)!;
    expect(reborn.run.isZero).toBe(true);
    const back = normalizeClicker(JSON.parse(JSON.stringify(serializeClicker(reborn))), 7);
    expect(back.run.isZero).toBe(true);
    expect(back.resets).toBe(1);
    expect(prestigeGain(back.run, back.resets).isZero).toBe(true);
    // a save from before the field existed still falls back to the total
    expect(normalizeClicker({ total: 500 }, 1).run.toNumber()).toBe(500);
  });

  it('equal totals go to the later save, so a purchase is not undone by the older copy', () => {
    const before = { total: 5000, resets: 0, savedAt: 1000, levels: { finger: 1 } };
    const bought = { total: 5000, resets: 0, savedAt: 2000, levels: { finger: 2 } };
    expect(betterSave('clicker', before, bought)).toBe(true);
    expect(betterSave('clicker', bought, before)).toBe(false);
    // but a lower total never wins, whatever the time
    expect(betterSave('clicker', bought, { total: 10, savedAt: 9999 })).toBe(false);
  });

  it('a rebirth beats a save from before it, otherwise the more earned wins (also beyond a double)', () => {
    const a = { total: 1e12, resets: 0, savedAt: 1 };
    expect(betterSave('clicker', a, { total: 5e11, resets: 1, savedAt: 2 })).toBe(true);
    expect(betterSave('clicker', { total: 5e11, resets: 1 }, { total: 9e12, resets: 0 })).toBe(false);
    expect(betterSave('clicker', a, { total: 2e12, resets: 0 })).toBe(true);
    expect(betterSave('clicker', a, { total: 5e11, resets: 0 })).toBe(false);
    expect(betterSave('clicker', { total: [1, 400] }, { total: [2, 400] })).toBe(true);
    expect(betterSave('clicker', { total: [2, 400] }, { total: [1, 401] })).toBe(true);
    expect(betterSave('clicker', { total: [1, 401] }, { total: 1e300 })).toBe(false);
  });
});
