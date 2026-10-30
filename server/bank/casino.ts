import { randomInt } from 'node:crypto';
import type { CasinoResult, RouletteBet } from '@timba/shared';
import { ROULETTE_RED, SLOT_PAIR, SLOT_SYMBOLS, SLOT_THREE } from '@timba/shared';
import { forbidden } from '../errors.js';
import { isPremium, type UserRow } from '../serialize.js';
import { txt } from '../strings.js';
import { playRound } from './bank.js';

/**
 * Казино TimbaGram Premium: the server decides every spin and moves the coins in one step.
 * Slots return about 90% of the bets in the long run (checked by a test), the roulette is European (one zero).
 */

/** symbol weights on a reel; the rarer the symbol, the bigger the win */
const WEIGHTS = [30, 25, 20, 12, 8, 4, 1];
const TOTAL = WEIGHTS.reduce((a, b) => a + b, 0);

function reel(): number {
  let r = randomInt(TOTAL);
  for (let i = 0; i < WEIGHTS.length; i++) {
    r -= WEIGHTS[i]!;
    if (r < 0) return i;
  }
  return 0;
}

/** Multiplier for the three symbols, left to right. */
export function slotsMultiplier([a, b, c]: number[]): number {
  if (a === b && b === c) return SLOT_THREE[a!]!;
  // two of a kind count on any two reels (1+2, 2+3 or 1+3), not only on the first two
  const pair = a === b || a === c ? a : b === c ? b : undefined;
  return pair === undefined ? 0 : SLOT_PAIR[pair]!;
}

function requirePremium(u: UserRow) {
  if (!isPremium(u)) throw forbidden(txt.casino.premiumOnly, 'premium_required');
}

export function spinSlots(u: UserRow, bet: number): CasinoResult {
  requirePremium(u);
  const reels = [reel(), reel(), reel()];
  const win = bet * slotsMultiplier(reels);
  const balance = playRound(u, bet, win, txt.casino.slotsOp(reels.map((i) => SLOT_SYMBOLS[i]).join('')));
  return { win, balance, reels };
}

/** How many times the bet is paid on top of it, or null when the number loses. */
export function rouletteWins(bet: RouletteBet, n: number): number | null {
  if (bet.type === 'number') return n === bet.value ? 35 : null;
  if (n === 0) return null;
  const red = ROULETTE_RED.includes(n);
  switch (bet.type) {
    case 'red':
      return red ? 1 : null;
    case 'black':
      return red ? null : 1;
    case 'even':
      return n % 2 === 0 ? 1 : null;
    case 'odd':
      return n % 2 === 1 ? 1 : null;
    case 'low':
      return n <= 18 ? 1 : null;
    case 'high':
      return n >= 19 ? 1 : null;
    case 'dozen':
      return Math.ceil(n / 12) === bet.value ? 2 : null;
  }
}

export function spinRoulette(u: UserRow, bet: RouletteBet): CasinoResult {
  requirePremium(u);
  const number = randomInt(37);
  const times = rouletteWins(bet, number);
  const win = times === null ? 0 : bet.amount * (times + 1);
  const balance = playRound(u, bet.amount, win, txt.casino.rouletteOp(number));
  return { win, balance, number };
}
