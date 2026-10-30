/**
 * Рейтинг мини-игр: топ месяца по каждой игре, где есть результат (очки, уровень, время).
 * Месяц считается по Москве; в первых числах следующего месяца рейтинг начинается заново,
 * а лидер прошлого месяца получает награду 7-й степени.
 */

export const LEADERBOARD_SIZE = 5;
/** ТК for the first place of a month, by the game (the harder and the better liked, the more); the second place gets a third of it, the third a fifth */
export const RATING_PRIZE: Record<string, number> = {
  clicker: 40,
  subway: 40,
  helix: 35,
  paper: 35,
  tetris: 35,
  breakout: 30,
  flappy: 30,
  g2048: 30,
  minesweeper: 30,
  snake: 25,
  stack: 25,
  reaction: 25,
  memory: 20,
  fifteen: 20,
  guess: 20,
};
/** ТК for a place of the top three (0 for the others) */
export function ratingPrize(gameId: string, place: number): number {
  const first = RATING_PRIZE[gameId] ?? 20;
  return place === 1 ? first : place === 2 ? Math.round(first / 3) : place === 3 ? Math.round(first / 5) : 0;
}
/** the degree of the award for the leader of a month: low, but not the simplest one */
export const LEADER_AWARD_DEGREE = 7;

/** what the result means; the client writes it as «1 200 очков», «Ур. 7», «42 с» */
export type ScoreUnit = 'points' | 'level' | 'seconds' | 'moves' | 'tries' | 'ms' | 'percent' | 'rebirths';

export interface ScoreGame {
  id: string;
  unit: ScoreUnit;
  /** fewer is better (time, moves) */
  lower?: boolean;
  /** results outside this range are not accepted */
  min: number;
  max: number;
  /** «Лидер по …» — the game in the dative case */
  caption: string;
}

/** Games with a result. Hangman, sudoku, boards against the bot and the like have none. The clicker is rated by its rebirths. */
export const SCORE_GAMES: readonly ScoreGame[] = [
  { id: 'tetris', unit: 'points', min: 1, max: 5_000_000, caption: 'тетрису' },
  { id: 'subway', unit: 'points', min: 1, max: 10_000_000, caption: 'Тимба Серфу' },
  { id: 'helix', unit: 'level', min: 1, max: 9999, caption: 'Helix Jump' },
  { id: 'paper', unit: 'percent', min: 0.1, max: 100, caption: 'Paper.io' },
  { id: 'flappy', unit: 'points', min: 1, max: 100_000, caption: 'Флэппи Бёрду' },
  { id: 'snake', unit: 'points', min: 1, max: 100_000, caption: 'змейке' },
  { id: 'g2048', unit: 'points', min: 4, max: 10_000_000, caption: '2048' },
  { id: 'minesweeper', unit: 'seconds', lower: true, min: 2, max: 86_400, caption: 'сапёру' },
  { id: 'memory', unit: 'moves', lower: true, min: 2, max: 10_000, caption: 'игре «Найди пару»' },
  { id: 'fifteen', unit: 'moves', lower: true, min: 1, max: 100_000, caption: 'пятнашкам' },
  { id: 'guess', unit: 'tries', lower: true, min: 1, max: 7, caption: 'игре «Угадай число»' },
  { id: 'reaction', unit: 'ms', lower: true, min: 90, max: 5000, caption: 'реакции' },
  { id: 'breakout', unit: 'points', min: 1, max: 1_000_000, caption: 'арканоиду' },
  { id: 'stack', unit: 'points', min: 1, max: 100_000, caption: 'башне' },
  { id: 'clicker', unit: 'rebirths', min: 1, max: 100_000, caption: 'кликеру' },
];

export const scoreGame = (id: string): ScoreGame | undefined => SCORE_GAMES.find((g) => g.id === id);

/** month names in the genitive case, as the award caption writes them: «Лидер по тетрису Мая 2026» */
export const MONTHS_GENITIVE = [
  'Января',
  'Февраля',
  'Марта',
  'Апреля',
  'Мая',
  'Июня',
  'Июля',
  'Августа',
  'Сентября',
  'Октября',
  'Ноября',
  'Декабря',
] as const;

/** The months of the rating begin at midnight of Moscow time (UTC+3, no daylight saving) */
const MSK_OFFSET_MS = 3 * 3_600_000;

/** «2026-05» for a moment in time */
export function ratingPeriod(ts: number): string {
  const d = new Date(ts + MSK_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** When the month of `period` ends (the moment the next one starts), ms */
export function ratingPeriodEnd(period: string): number {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return Date.UTC(y, m, 1) - MSK_OFFSET_MS;
}

/** «Мая 2026» */
export function ratingPeriodLabel(period: string): string {
  const [y, m] = period.split('-').map(Number) as [number, number];
  return `${MONTHS_GENITIVE[m - 1]} ${y}`;
}

export const leaderAwardCaption = (game: ScoreGame, period: string) => `Лидер по ${game.caption} ${ratingPeriodLabel(period)}`;
