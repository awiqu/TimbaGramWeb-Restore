import { randomInt } from 'node:crypto';
import type { DuelAction, PvpAction, PvpGame, PvpMatchDTO, PvpMove, PvpStatus, RpsPick } from '@timba/shared';
import {
  C4_SIZE,
  DUEL_AIM_STEP,
  DUEL_BASE_CHANCE,
  DUEL_MAX_CHANCE,
  EV,
  NIM_MAX_ADD,
  NIM_TARGET,
  PVP_INVITE_MS,
  PVP_MAX_OPEN,
  PVP_TURN_GAMES,
  PVP_TURN_MS,
  RPS_PICKS,
  RPS_WINS,
  TTT_SIZE,
  c4Drop,
  c4Result,
  rpsBeats,
  tttResult,
} from '@timba/shared';
import { db, now } from '../db.js';
import { HttpError, badRequest, forbidden, notFound } from '../errors.js';
import { notifyUser } from '../push.js';
import { isUserActive, toUser } from '../realtime.js';
import { type UserRow, displayName, getUserRow, isBlockedBy, isPremium, userDTOFor } from '../serialize.js';
import { txt } from '../strings.js';
import { INFINITE, balanceOfUser, ensureAccount, pvpPay, pvpTakeStakes } from './bank.js';

/**
 * Multiplayer games on ТимбаКоины: the duel and the dice. One player invites another (a push
 * reaches a closed app), the stakes of both are taken when the invite is accepted, the server
 * makes every roll and shot, and the winner takes both stakes. The state lives in the database,
 * so a restart of the server does not lose a game or its coins.
 */

interface MatchRow {
  id: number;
  game: PvpGame;
  creator_id: number;
  opponent_id: number;
  stake: number;
  status: PvpStatus;
  state: string;
  winner_id: number | null;
  created_at: number;
  updated_at: number;
}

interface State {
  turn: number | null;
  deadline: number | null;
  aim: Record<number, number>;
  round: number;
  rolls: Record<number, number>;
  moves: PvpMove[];
  forfeit: boolean;
  /** tictactoe, connect4: 0 empty, 1 the inviter, 2 the invited */
  board: number[];
  /** rock-paper-scissors: rounds won, and the choices of the running round (secret until both chose) */
  wins: Record<number, number>;
  picks: Record<number, RpsPick>;
  /** who of them was given a random choice because the time ran out (shown when the round is decided) */
  autoPicks: number[];
  /** nim */
  total: number;
}

/** moves kept in a match (the duel can go on for a while) */
const MOVES_MAX = 60;

/** The table lives outside the numbered migrations, like the notifications. */
export function initPvp() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pvp_matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game TEXT NOT NULL,
      creator_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      opponent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      stake INTEGER NOT NULL,
      status TEXT NOT NULL,
      state TEXT NOT NULL,
      winner_id INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pvp_creator ON pvp_matches(creator_id, status);
    CREATE INDEX IF NOT EXISTS idx_pvp_opponent ON pvp_matches(opponent_id, status);
    CREATE INDEX IF NOT EXISTS idx_pvp_status ON pvp_matches(status);
  `);
}

let timer: NodeJS.Timeout | null = null;

/** Expire invites and time out moves every few seconds. */
export function startPvpTimer() {
  if (timer) return;
  timer = setInterval(() => {
    try {
      tickPvp();
    } catch {
      /* one broken match must not stop the others */
    }
  }, 5000);
  timer.unref();
}

export function stopPvpTimer() {
  if (timer) clearInterval(timer);
  timer = null;
}

const getRow = (id: number) => db.prepare('SELECT * FROM pvp_matches WHERE id = ?').get(id) as MatchRow | undefined;
/** Matches saved before the newer games have no board, wins, picks and counter */
const parseState = (r: MatchRow): State => ({ board: [], wins: {}, picks: {}, autoPicks: [], total: 0, ...(JSON.parse(r.state) as Partial<State>) }) as State;
const freshState = (deadline: number): State => ({
  turn: null,
  deadline,
  aim: {},
  round: 1,
  rolls: {},
  moves: [],
  forfeit: false,
  board: [],
  wins: {},
  picks: {},
  autoPicks: [],
  total: 0,
});

function save(r: MatchRow, st: State, patch: Partial<Pick<MatchRow, 'status' | 'winner_id'>> = {}): MatchRow {
  st.moves = st.moves.slice(-MOVES_MAX);
  const next = { ...r, ...patch, state: JSON.stringify(st), updated_at: now() };
  db.prepare('UPDATE pvp_matches SET status = ?, state = ?, winner_id = ?, updated_at = ? WHERE id = ?').run(
    next.status,
    next.state,
    next.winner_id,
    next.updated_at,
    r.id,
  );
  return next;
}

function toDTO(r: MatchRow, viewerId: number): PvpMatchDTO {
  const st = parseState(r);
  const creator = getUserRow(r.creator_id)!;
  const opponent = getUserRow(r.opponent_id)!;
  return {
    id: r.id,
    game: r.game,
    status: r.status,
    stake: r.stake,
    creator: userDTOFor(creator, viewerId),
    opponent: userDTOFor(opponent, viewerId),
    turn: st.turn,
    deadline: st.deadline,
    aim: st.aim,
    round: st.round,
    rolls: st.rolls,
    moves: st.moves,
    board: st.board,
    wins: st.wins,
    picked: Object.keys(st.picks).map(Number),
    total: st.total,
    winnerId: r.winner_id,
    forfeit: st.forfeit,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Both players see the new state in every open tab. */
function broadcast(r: MatchRow) {
  for (const id of [r.creator_id, r.opponent_id]) toUser(id, EV.pvp, toDTO(r, id));
}

/** A push to a player who is not looking at the app; one per match, the newest replaces the rest. */
function push(r: MatchRow, userId: number, body: string, always = false) {
  if (!always && isUserActive(userId)) return;
  notifyUser(userId, { title: txt.pvp.title(), body, chatId: 0, url: `/games/pvp/${r.id}`, tag: `pvp-${r.id}` });
}

const other = (r: MatchRow, id: number) => (r.creator_id === id ? r.opponent_id : r.creator_id);
const nameOf = (id: number) => {
  const u = getUserRow(id);
  return u ? displayName(u) : '—';
};

function requireMatch(u: UserRow, id: number): MatchRow {
  const r = getRow(id);
  if (!r || (r.creator_id !== u.id && r.opponent_id !== u.id)) throw notFound(txt.pvp.notFound);
  return r;
}

// ---------- invites ----------

export function listMatches(u: UserRow): PvpMatchDTO[] {
  const open = db
    .prepare(
      `SELECT * FROM pvp_matches WHERE (creator_id = ? OR opponent_id = ?) AND status IN ('pending', 'active') ORDER BY id DESC`,
    )
    .all(u.id, u.id) as MatchRow[];
  const done = db
    .prepare(
      `SELECT * FROM pvp_matches WHERE (creator_id = ? OR opponent_id = ?) AND status NOT IN ('pending', 'active')
       ORDER BY updated_at DESC LIMIT 20`,
    )
    .all(u.id, u.id) as MatchRow[];
  return [...open, ...done].map((r) => toDTO(r, u.id));
}

export function getMatch(u: UserRow, id: number): PvpMatchDTO {
  return toDTO(requireMatch(u, id), u.id);
}

/**
 * Invite somebody to a game. Only TimbaGram Premium can invite, like every other game; the invited
 * player can accept without it. No coins move until the invite is accepted.
 */
export function createMatch(u: UserRow, game: PvpGame, opponentId: number, stake: number): PvpMatchDTO {
  if (!isPremium(u)) throw forbidden(txt.pvp.premiumOnly, 'premium_required');
  if (opponentId === u.id) throw badRequest(txt.pvp.self);
  const opp = getUserRow(opponentId);
  if (!opp || opp.is_banned) throw notFound(txt.errors.userNotFound);
  if (isBlockedBy(opp.id, u.id) || isBlockedBy(u.id, opp.id)) throw forbidden(txt.pvp.blocked);
  const pair = db
    .prepare(
      `SELECT 1 FROM pvp_matches WHERE status IN ('pending', 'active')
       AND ((creator_id = ? AND opponent_id = ?) OR (creator_id = ? AND opponent_id = ?))`,
    )
    .get(u.id, opp.id, opp.id, u.id);
  if (pair) throw badRequest(txt.pvp.alreadyPlaying);
  const open = db.prepare(`SELECT COUNT(*) n FROM pvp_matches WHERE creator_id = ? AND status = 'pending'`).get(u.id) as { n: number };
  if (open.n >= PVP_MAX_OPEN) throw badRequest(txt.pvp.tooManyInvites(PVP_MAX_OPEN));

  ensureAccount(u);
  const balance = balanceOfUser(u);
  if (balance !== INFINITE && balance < stake) throw new HttpError(400, 'insufficient_funds', txt.pvp.noMoney);
  const t = now();
  const st = freshState(t + PVP_INVITE_MS);
  const res = db
    .prepare(
      `INSERT INTO pvp_matches (game, creator_id, opponent_id, stake, status, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
    )
    .run(game, u.id, opp.id, stake, JSON.stringify(st), t, t);
  const r = getRow(Number(res.lastInsertRowid))!;
  broadcast(r);
  // the invite always comes as a push too: the phone may be in a pocket with the app open
  push(r, opp.id, txt.pvp.invitePush(displayName(u), r.game, stake), true);
  return toDTO(r, u.id);
}

export function acceptMatch(u: UserRow, id: number): PvpMatchDTO {
  let r = requireMatch(u, id);
  if (r.status !== 'pending') throw badRequest(txt.pvp.notPending);
  if (r.opponent_id !== u.id) throw forbidden(txt.pvp.notYours);
  const deadline = parseState(r).deadline;
  if (deadline && deadline < now()) throw badRequest(txt.pvp.expired);
  const creator = getUserRow(r.creator_id)!;
  try {
    pvpTakeStakes(creator, u, r.stake, txt.pvp.opStake(r.game, r.id));
  } catch (e) {
    const who = (e as { who?: number }).who;
    if (who === creator.id) {
      // the inviter can no longer pay: the invite is void
      r = save(r, { ...parseState(r), deadline: null }, { status: 'cancelled' });
      broadcast(r);
      push(r, creator.id, txt.pvp.creatorNoMoney(displayName(u)));
      throw new HttpError(400, 'opponent_insufficient', txt.pvp.opponentNoMoney);
    }
    throw e;
  }
  const st = parseState(r);
  const t = now();
  st.deadline = t + PVP_TURN_MS;
  if (r.game === 'duel') st.aim = { [r.creator_id]: DUEL_BASE_CHANCE, [r.opponent_id]: DUEL_BASE_CHANCE };
  if (r.game === 'tictactoe') st.board = Array(TTT_SIZE).fill(0);
  if (r.game === 'connect4') st.board = Array(C4_SIZE).fill(0);
  // who moves first is up to the coin
  if ((PVP_TURN_GAMES as readonly string[]).includes(r.game)) st.turn = randomInt(2) ? r.creator_id : r.opponent_id;
  r = save(r, st, { status: 'active' });
  broadcast(r);
  push(r, r.creator_id, txt.pvp.acceptedPush(displayName(u), r.game, st.turn === r.creator_id));
  return toDTO(r, u.id);
}

/** The invited player says no, or the inviter takes the invite back. */
export function declineMatch(u: UserRow, id: number): PvpMatchDTO {
  let r = requireMatch(u, id);
  if (r.status !== 'pending') throw badRequest(txt.pvp.notPending);
  const mine = r.creator_id === u.id;
  r = save(r, { ...parseState(r), deadline: null }, { status: mine ? 'cancelled' : 'declined' });
  broadcast(r);
  if (!mine) push(r, r.creator_id, txt.pvp.declinedPush(displayName(u)));
  return toDTO(r, u.id);
}

// ---------- the games ----------

/** The winner takes both stakes. */
function finish(r: MatchRow, st: State, winnerId: number, forfeit = false): MatchRow {
  st.turn = null;
  st.deadline = null;
  st.forfeit = forfeit;
  const next = save(r, st, { status: 'finished', winner_id: winnerId });
  const loserId = other(r, winnerId);
  const winner = getUserRow(winnerId)!;
  const loser = getUserRow(loserId)!;
  pvpPay(winner, r.stake * 2, loser, txt.pvp.opWin(r.game, r.id));
  broadcast(next);
  push(next, winnerId, txt.pvp.wonPush(displayName(loser), r.stake * 2));
  push(next, loserId, txt.pvp.lostPush(displayName(winner), r.stake));
  return next;
}

/** A draw: nobody wins, each player gets the stake back. */
function finishDraw(r: MatchRow, st: State): MatchRow {
  st.turn = null;
  st.deadline = null;
  const next = save(r, st, { status: 'finished', winner_id: null });
  const a = getUserRow(r.creator_id)!;
  const b = getUserRow(r.opponent_id)!;
  pvpPay(a, r.stake, b, txt.pvp.opDraw(r.game, r.id));
  pvpPay(b, r.stake, a, txt.pvp.opDraw(r.game, r.id));
  broadcast(next);
  for (const id of [a.id, b.id]) push(next, id, txt.pvp.drawPush(r.stake));
  return next;
}

/** The turn goes to the other player with a fresh timer. */
function passTurn(r: MatchRow, st: State, by: number, what: string): MatchRow {
  st.turn = other(r, by);
  st.deadline = now() + PVP_TURN_MS;
  const next = save(r, st);
  broadcast(next);
  push(next, st.turn, txt.pvp.yourTurnPush(nameOf(by), what));
  return next;
}

function duelMove(r: MatchRow, st: State, by: number, action: DuelAction, auto = false): MatchRow {
  const foe = other(r, by);
  const move: PvpMove = { by, action, at: now(), ...(auto ? { auto } : {}) };
  if (action === 'shoot') {
    const chance = st.aim[by] ?? DUEL_BASE_CHANCE;
    move.chance = chance;
    move.hit = randomInt(100) < chance;
    st.moves.push(move);
    if (move.hit) return finish(r, st, by);
  } else if (action === 'aim') {
    st.aim[by] = Math.min(DUEL_MAX_CHANCE, (st.aim[by] ?? DUEL_BASE_CHANCE) + DUEL_AIM_STEP);
    st.moves.push(move);
  } else {
    st.aim[foe] = DUEL_BASE_CHANCE;
    st.moves.push(move);
  }
  st.turn = foe;
  st.deadline = now() + PVP_TURN_MS;
  const next = save(r, st);
  broadcast(next);
  push(next, foe, txt.pvp.yourTurnPush(nameOf(by), txt.pvp.actionDone[action]!));
  return next;
}

function diceRoll(r: MatchRow, st: State, by: number, auto = false): MatchRow {
  const roll = randomInt(1, 7);
  st.rolls[by] = roll;
  st.moves.push({ by, action: 'roll', roll, round: st.round, at: now(), ...(auto ? { auto } : {}) });
  const a = st.rolls[r.creator_id];
  const b = st.rolls[r.opponent_id];
  if (a !== undefined && b !== undefined) {
    if (a !== b) return finish(r, st, a > b ? r.creator_id : r.opponent_id);
    // a tie: both roll again
    st.round += 1;
    st.rolls = {};
    st.deadline = now() + PVP_TURN_MS;
    const next = save(r, st);
    broadcast(next);
    for (const id of [r.creator_id, r.opponent_id]) push(next, id, txt.pvp.tiePush(a));
    return next;
  }
  const next = save(r, st);
  broadcast(next);
  push(next, other(r, by), txt.pvp.rolledPush(nameOf(by), roll));
  return next;
}

/** The side of a player on the boards: 1 the inviter, 2 the invited */
const sideOf = (r: MatchRow, id: number) => (r.creator_id === id ? 1 : 2);

/** The end of a board game after a move: a win, a draw, or the turn goes on. */
function afterBoardMove(r: MatchRow, st: State, by: number, result: ReturnType<typeof tttResult>, what: string): MatchRow {
  if (result && 'winner' in result) return finish(r, st, by);
  if (result) return finishDraw(r, st);
  return passTurn(r, st, by, what);
}

function tttMark(r: MatchRow, st: State, by: number, cell: number): MatchRow {
  if (!Number.isInteger(cell) || cell < 0 || cell >= TTT_SIZE || st.board[cell]) throw badRequest(txt.pvp.badMove);
  st.board[cell] = sideOf(r, by);
  st.moves.push({ by, action: 'mark', cell, at: now() });
  return afterBoardMove(r, st, by, tttResult(st.board), txt.pvp.markDone);
}

function c4DropDisc(r: MatchRow, st: State, by: number, col: number): MatchRow {
  const at = c4Drop(st.board, col);
  if (at === null) throw badRequest(txt.pvp.badMove);
  st.board[at] = sideOf(r, by);
  st.moves.push({ by, action: 'drop', cell: col, at: now() });
  return afterBoardMove(r, st, by, c4Result(st.board), txt.pvp.dropDone);
}

function nimAdd(r: MatchRow, st: State, by: number, n: number, auto = false): MatchRow {
  if (!Number.isInteger(n) || n < 1 || n > NIM_MAX_ADD || st.total + n > NIM_TARGET) throw badRequest(txt.pvp.badMove);
  st.total += n;
  st.moves.push({ by, action: 'add', n, at: now(), ...(auto ? { auto } : {}) });
  if (st.total >= NIM_TARGET) return finish(r, st, by);
  return passTurn(r, st, by, txt.pvp.addDone(n, st.total));
}

/** A choice in rock-paper-scissors; when both have chosen the round is decided. */
function rpsPick(r: MatchRow, st: State, by: number, pick: RpsPick, auto = false): MatchRow {
  st.picks[by] = pick;
  if (auto) st.autoPicks.push(by);
  const a = st.picks[r.creator_id];
  const b = st.picks[r.opponent_id];
  if (!a || !b) {
    // the first choice stays secret; the other player is told it is their turn
    const next = save(r, st);
    broadcast(next);
    push(next, other(r, by), txt.pvp.pickedPush(nameOf(by)));
    return next;
  }
  // both are in: now the choices are shown
  const t = now();
  for (const [id, p] of [
    [r.creator_id, a],
    [r.opponent_id, b],
  ] as const)
    st.moves.push({ by: id, action: 'pick', round: st.round, pick: p, at: t, ...(st.autoPicks.includes(id) ? { auto: true } : {}) });
  st.autoPicks = [];
  const winner = rpsBeats(a, b) ? r.creator_id : rpsBeats(b, a) ? r.opponent_id : null;
  if (winner) st.wins[winner] = (st.wins[winner] ?? 0) + 1;
  st.round += 1;
  st.picks = {};
  if (winner && st.wins[winner]! >= RPS_WINS) return finish(r, st, winner);
  st.deadline = t + PVP_TURN_MS;
  const next = save(r, st);
  broadcast(next);
  for (const id of [r.creator_id, r.opponent_id]) push(next, id, winner ? txt.pvp.roundPush(winner === id, st.wins[r.creator_id] ?? 0, st.wins[r.opponent_id] ?? 0, id === r.creator_id) : txt.pvp.roundTiePush);
  return next;
}

export function makeMove(u: UserRow, id: number, action: PvpAction, value?: number | string): PvpMatchDTO {
  const r = requireMatch(u, id);
  if (r.status !== 'active') throw badRequest(txt.pvp.notActive);
  const st = parseState(r);
  const ownTurn = () => {
    if (st.turn !== u.id) throw badRequest(txt.pvp.notYourTurn);
  };
  const wrong = () => badRequest(txt.pvp.badMove);
  switch (r.game) {
    case 'duel':
      if (action !== 'shoot' && action !== 'aim' && action !== 'knock') throw wrong();
      ownTurn();
      return toDTO(duelMove(r, st, u.id, action), u.id);
    case 'dice':
      if (action !== 'roll') throw wrong();
      if (st.rolls[u.id] !== undefined) throw badRequest(txt.pvp.alreadyRolled);
      return toDTO(diceRoll(r, st, u.id), u.id);
    case 'tictactoe':
      if (action !== 'mark' || typeof value !== 'number') throw wrong();
      ownTurn();
      return toDTO(tttMark(r, st, u.id, value), u.id);
    case 'connect4':
      if (action !== 'drop' || typeof value !== 'number') throw wrong();
      ownTurn();
      return toDTO(c4DropDisc(r, st, u.id, value), u.id);
    case 'nim':
      if (action !== 'add' || typeof value !== 'number') throw wrong();
      ownTurn();
      return toDTO(nimAdd(r, st, u.id, value), u.id);
    case 'rps':
      if (action !== 'pick' || typeof value !== 'string' || !RPS_PICKS.includes(value as RpsPick)) throw wrong();
      if (st.picks[u.id]) throw badRequest(txt.pvp.alreadyPicked);
      return toDTO(rpsPick(r, st, u.id, value as RpsPick), u.id);
  }
}

/** Give up: the other player takes the pot. */
export function surrender(u: UserRow, id: number): PvpMatchDTO {
  const r = requireMatch(u, id);
  if (r.status !== 'active') throw badRequest(txt.pvp.notActive);
  return toDTO(finish(r, parseState(r), other(r, u.id), true), u.id);
}

/**
 * Invites expire; a move not made in time loses a game played in turns; a die not rolled (or a hand
 * not chosen) in time is rolled (chosen) by the server.
 */
export function tickPvp(at = now()) {
  const rows = db.prepare(`SELECT * FROM pvp_matches WHERE status IN ('pending', 'active')`).all() as MatchRow[];
  for (const r of rows) {
    const st = parseState(r);
    if (!st.deadline || st.deadline > at) continue;
    if (r.status === 'pending') {
      const next = save(r, { ...st, deadline: null }, { status: 'expired' });
      broadcast(next);
    } else if (st.turn) {
      finish(r, st, other(r, st.turn), true);
    } else if (r.game === 'dice' || r.game === 'rps') {
      // only for the round that ran out: a tie starts a new one with its own time
      let cur: MatchRow = r;
      const missing = (s: State, p: number) => (r.game === 'dice' ? s.rolls[p] === undefined : !s.picks[p]);
      for (const id of [r.creator_id, r.opponent_id].filter((p) => missing(st, p))) {
        const s = parseState(cur);
        if (cur.status !== 'active' || s.round !== st.round) break;
        cur = r.game === 'dice' ? diceRoll(cur, s, id, true) : rpsPick(cur, s, id, RPS_PICKS[randomInt(RPS_PICKS.length)]!, true);
      }
    }
  }
}
