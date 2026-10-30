import type { PvpMatchDTO } from './types.js';

/**
 * Rules of the multiplayer games that are the same on the server (which decides) and on the
 * client (which draws): the boards, the winning lines, the counter.
 * Cells hold 0 (empty), 1 (the player who invited) or 2 (the invited one).
 */

export type RpsPick = 'rock' | 'scissors' | 'paper';
export const RPS_PICKS: readonly RpsPick[] = ['rock', 'scissors', 'paper'];
/** rock-paper-scissors is played until somebody wins this many rounds (a tie is played again) */
export const RPS_WINS = 2;
export const rpsBeats = (a: RpsPick, b: RpsPick) => (a === 'rock' && b === 'scissors') || (a === 'scissors' && b === 'paper') || (a === 'paper' && b === 'rock');

/** «Двадцать одна»: players add 1…3 in turn, whoever makes the counter 21 wins */
export const NIM_TARGET = 21;
export const NIM_MAX_ADD = 3;

export const TTT_SIZE = 9;
const TTT_LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

export const C4_COLS = 7;
export const C4_ROWS = 6;
export const C4_SIZE = C4_COLS * C4_ROWS;

export type BoardResult = { winner: 1 | 2; line: number[] } | { draw: true } | null;

export function tttResult(b: readonly number[]): BoardResult {
  for (const line of TTT_LINES) {
    const v = b[line[0]!];
    if (v && v === b[line[1]!] && v === b[line[2]!]) return { winner: v as 1 | 2, line };
  }
  return b.every((c) => c) ? { draw: true } : null;
}

/** Drop a disc into a column: the index it lands on, or null when the column is full or does not exist. */
export function c4Drop(b: readonly number[], col: number): number | null {
  if (!Number.isInteger(col) || col < 0 || col >= C4_COLS) return null;
  for (let row = C4_ROWS - 1; row >= 0; row--) if (!b[row * C4_COLS + col]) return row * C4_COLS + col;
  return null;
}

export function c4Result(b: readonly number[]): BoardResult {
  const at = (r: number, c: number) => (r >= 0 && r < C4_ROWS && c >= 0 && c < C4_COLS ? (b[r * C4_COLS + c] ?? 0) : 0);
  for (let r = 0; r < C4_ROWS; r++)
    for (let c = 0; c < C4_COLS; c++) {
      const v = at(r, c);
      if (!v) continue;
      for (const [dr, dc] of [
        [0, 1],
        [1, 0],
        [1, 1],
        [1, -1],
      ] as const) {
        if ([1, 2, 3].every((k) => at(r + dr * k, c + dc * k) === v))
          return { winner: v as 1 | 2, line: [0, 1, 2, 3].map((k) => (r + dr * k) * C4_COLS + c + dc * k) };
      }
    }
  return b.length >= C4_SIZE && b.every((c) => c) ? { draw: true } : null;
}

/** A game where a player moves in turn (the match has `turn`) */
export const PVP_TURN_GAMES = ['duel', 'tictactoe', 'connect4', 'nim'] as const;

/** Does this match wait for the player to move? An invite to answer is up to the caller. */
export function pvpMyMove(m: Pick<PvpMatchDTO, 'game' | 'turn' | 'rolls' | 'picked'>, me: number): boolean {
  if (m.game === 'dice') return m.rolls[me] === undefined;
  if (m.game === 'rps') return !m.picked.includes(me);
  return m.turn === me;
}
