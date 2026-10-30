import type { LeaderboardDTO } from '@timba/shared';
import {
  LEADERBOARD_SIZE,
  LEADER_AWARD_DEGREE,
  type ScoreGame,
  leaderAwardCaption,
  ratingPeriod,
  ratingPrize,
  ratingPeriodEnd,
  scoreGame,
} from '@timba/shared';
import { addOp, ensureAccount, move } from './bank/bank.js';
import { db, now } from './db.js';
import { badRequest } from './errors.js';
import { notify } from './notifications.js';
import { notifyUser } from './push.js';
import { type UserRow, getUserRow, userDTOFor } from './serialize.js';
import { txt } from './strings.js';

/**
 * The monthly rating of the mini-games. The client sends the result of every finished game; the
 * server keeps the best one of the month for each player and shows the top. A month needs no reset:
 * the rows carry their month, and the first look at a month that is over gives its leader an award.
 * The tables live outside the numbered migrations, like the notifications.
 */
export function initLeaderboard() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS game_scores (
      game TEXT NOT NULL,
      period TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      score REAL NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (game, period, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_game_scores_top ON game_scores(game, period, score);
    CREATE TABLE IF NOT EXISTS game_leader_awards (
      game TEXT NOT NULL,
      period TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      PRIMARY KEY (game, period)
    );
  `);
  settleMonths();
}

/** «score is better» for a game, as an SQL comparison of the column and a value */
const better = (g: ScoreGame) => (g.lower ? '<' : '>');
const order = (g: ScoreGame) => (g.lower ? 'ASC' : 'DESC');

function gameOrThrow(id: string): ScoreGame {
  const g = scoreGame(id);
  if (!g) throw badRequest(txt.leaderboard.noGame);
  return g;
}

/** Keep the player's best result of this month. */
export function submitScore(userId: number, gameId: string, raw: number) {
  const g = gameOrThrow(gameId);
  if (raw < g.min || raw > g.max) throw badRequest(txt.leaderboard.badScore);
  // one decimal is enough (Paper.io shows tenths of a percent); the rest is whole
  const score = g.unit === 'percent' ? Math.round(raw * 10) / 10 : Math.round(raw);
  settleMonths();
  const t = now();
  db.prepare(
    `INSERT INTO game_scores (game, period, user_id, score, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(game, period, user_id) DO UPDATE SET score = excluded.score, updated_at = excluded.updated_at
     WHERE excluded.score ${better(g)} game_scores.score`,
  ).run(g.id, ratingPeriod(t), userId, score, t);
}

interface ScoreRow {
  user_id: number;
  score: number;
}

export function leaderboard(gameId: string, viewer: UserRow): LeaderboardDTO {
  const g = gameOrThrow(gameId);
  settleMonths();
  const period = ratingPeriod(now());
  // banned players are not shown; earlier result wins a tie
  const top = db
    .prepare(
      `SELECT s.user_id, s.score FROM game_scores s JOIN users u ON u.id = s.user_id
       WHERE s.game = ? AND s.period = ? AND u.is_banned = 0
       ORDER BY s.score ${order(g)}, s.updated_at, s.user_id LIMIT ?`,
    )
    .all(g.id, period, LEADERBOARD_SIZE) as ScoreRow[];
  const entries = top.flatMap((r, i) => {
    const u = getUserRow(r.user_id);
    return u ? [{ rank: i + 1, user: userDTOFor(u, viewer.id), score: r.score }] : [];
  });

  let me: LeaderboardDTO['me'] = null;
  const mine = db.prepare('SELECT score, updated_at FROM game_scores WHERE game = ? AND period = ? AND user_id = ?').get(g.id, period, viewer.id) as
    | { score: number; updated_at: number }
    | undefined;
  if (mine) {
    const ahead = db
      .prepare(
        `SELECT COUNT(*) c FROM game_scores s JOIN users u ON u.id = s.user_id
         WHERE s.game = ? AND s.period = ? AND u.is_banned = 0
           AND (s.score ${better(g)} ? OR (s.score = ? AND (s.updated_at < ? OR (s.updated_at = ? AND s.user_id < ?))))`,
      )
      .get(g.id, period, mine.score, mine.score, mine.updated_at, mine.updated_at, viewer.id) as { c: number };
    me = { rank: ahead.c + 1, score: mine.score };
  }

  const prev = db
    .prepare('SELECT period, user_id FROM game_leader_awards WHERE game = ? AND user_id IS NOT NULL ORDER BY period DESC LIMIT 1')
    .get(g.id) as { period: string; user_id: number } | undefined;
  const prevUser = prev && getUserRow(prev.user_id);
  return {
    game: g.id,
    period,
    endsAt: ratingPeriodEnd(period),
    entries,
    me,
    previous: prev && prevUser ? { period: prev.period, user: userDTOFor(prevUser, viewer.id) } : null,
  };
}

/**
 * Every finished month of every game gets its award, once: the leader receives an award of a low
 * degree with a caption like «Лидер по тетрису Мая 2026», and the top three get ТК (RATING_PRIZE). Safe to call at any moment.
 */
export function settleMonths() {
  const current = ratingPeriod(now());
  const open = db
    .prepare(
      `SELECT DISTINCT s.game, s.period FROM game_scores s
       WHERE s.period < ? AND NOT EXISTS (SELECT 1 FROM game_leader_awards a WHERE a.game = s.game AND a.period = s.period)
       ORDER BY s.period`,
    )
    .all(current) as { game: string; period: string }[];
  for (const { game, period } of open) {
    const g = scoreGame(game);
    // the top three of the month (banned players are out; the earlier result wins a tie)
    const top = g
      ? (db
          .prepare(
            `SELECT s.user_id FROM game_scores s JOIN users u ON u.id = s.user_id
             WHERE s.game = ? AND s.period = ? AND u.is_banned = 0
             ORDER BY s.score ${order(g)}, s.updated_at, s.user_id LIMIT 3`,
          )
          .all(game, period) as { user_id: number }[])
      : [];
    const winner = top[0];
    const caption = g && winner ? leaderAwardCaption(g, period) : '';
    const prizes: { userId: number; place: number; amount: number }[] = [];
    db.transaction(() => {
      db.prepare('INSERT INTO game_leader_awards (game, period, user_id) VALUES (?, ?, ?)').run(game, period, winner?.user_id ?? null);
      // not through addAward: the limit of awards in a profile must not take this one away
      if (winner)
        db.prepare('INSERT INTO user_awards (user_id, degree, caption, awarded_at, created_at) VALUES (?, ?, ?, ?, ?)').run(
          winner.user_id,
          LEADER_AWARD_DEGREE,
          caption,
          now(),
          now(),
        );
      // ТК for the places of the top three
      top.forEach((r, i) => {
        const u = getUserRow(r.user_id);
        const amount = ratingPrize(game, i + 1);
        if (!u || !amount || !g) return;
        ensureAccount(u);
        move(u.id, amount);
        addOp(u.id, 'rating_prize', amount, null, txt.leaderboard.prizeOp(i + 1, g.caption));
        prizes.push({ userId: u.id, place: i + 1, amount });
      });
    })();
    for (const p of prizes) notify('bank', p.userId, txt.leaderboard.prizeBody(p.place, g!.caption, p.amount));
    if (winner) notifyUser(winner.user_id, { title: txt.leaderboard.awardTitle, body: txt.leaderboard.awardBody(caption), chatId: 0, url: '/', tag: `leader-${game}-${period}` });
  }
}

let timer: ReturnType<typeof setInterval> | null = null;

/** The month can turn while nobody looks at the rating: check once an hour */
export function startLeaderboardTimer() {
  if (timer) return;
  timer = setInterval(() => {
    try {
      settleMonths();
    } catch {
      /* the next hour will try again */
    }
  }, 3_600_000);
  timer.unref();
}

export function stopLeaderboardTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}
