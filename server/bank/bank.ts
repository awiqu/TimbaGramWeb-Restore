import fs from 'node:fs';
import path from 'node:path';
import type {
  AdminBankAccount,
  AdminBankOp,
  AdminBankOverview,
  BankHistory,
  BankInfo,
  BankOperation,
  BankOpKind,
  BankSettings,
  TopupKind,
} from '@timba/shared';
import { ADMIN_USERNAME, PREMIUM_DAYS, PREMIUM_WEEKLY_BONUS, isPremiumForever, BANK_JOKE_PRICE, BANK_START_BALANCE, BOT_CREATE_PRICE } from '@timba/shared';
import Database from 'better-sqlite3';
import { config } from '../config.js';
import { db, now } from '../db.js';
import { HttpError, badRequest, forbidden, notFound } from '../errors.js';
import { type UserRow, getUserRow, userDTO, usersByIds } from '../serialize.js';
import { txt } from '../strings.js';
import { JOKES } from './jokes.js';
import { extendPremium } from '../premium.js';
import { notify } from '../notifications.js';

/**
 * ТимбаКоины. Every user has an account keyed by their user id. There is no common cash: bought
 * coins (top-ups) and promo codes create new coins, paid purchases (jokes, bots) simply disappear. A balance of
 * -1 (INFINITE) never runs out. Every change of a balance is one row in bank_ops.
 */

/** the balance the admin sets for an account that never runs out */
export const INFINITE = -1;

interface AccountRow {
  user_id: number;
  balance: number;
  banned: number;
  created_at: number;
  ai_tokens_used: number;
  ai_tokens_paid: number;
}

interface OpRow {
  id: number;
  user_id: number;
  kind: BankOpKind;
  amount: number;
  peer_id: number | null;
  peer_name: string | null;
  message: string;
  created_at: number;
}

// ---------- settings ----------

const DEFAULT_SETTINGS: BankSettings = {
  startBalance: BANK_START_BALANCE,
  jokePrice: BANK_JOKE_PRICE,
  botPrice: BOT_CREATE_PRICE,
};

/** Stored as JSON under "bank" (an old price of the removed ЧатБот may still be there and is ignored). */
export function bankSettings(): BankSettings {
  const r = db.prepare(`SELECT value FROM app_settings WHERE key = 'bank'`).get() as { value: string } | undefined;
  const stored = (r ? JSON.parse(r.value) : {}) as Partial<BankSettings> & { aiBlockPrice?: number };
  return {
    startBalance: stored.startBalance ?? DEFAULT_SETTINGS.startBalance,
    jokePrice: stored.jokePrice ?? DEFAULT_SETTINGS.jokePrice,
    botPrice: stored.botPrice ?? DEFAULT_SETTINGS.botPrice,
  };
}

export function updateBankSettings(patch: Partial<BankSettings>): BankSettings {
  const cur = bankSettings();
  const next: BankSettings = {
    startBalance: patch.startBalance ?? cur.startBalance,
    jokePrice: patch.jokePrice ?? cur.jokePrice,
    botPrice: patch.botPrice ?? cur.botPrice,
  };
  const stored = { startBalance: next.startBalance, jokePrice: next.jokePrice, botPrice: next.botPrice };
  db.prepare(`INSERT INTO app_settings (key, value) VALUES ('bank', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(
    JSON.stringify(stored),
  );
  return next;
}

// ---------- accounts ----------

export function cashUser(): UserRow {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(ADMIN_USERNAME) as UserRow;
}

const getAccount = (userId: number) => db.prepare('SELECT * FROM bank_accounts WHERE user_id = ?').get(userId) as AccountRow | undefined;

export function addOp(userId: number, kind: BankOpKind, amount: number, peer?: UserRow | null, message = '', peerName?: string) {
  db.prepare(
    `INSERT INTO bank_ops (user_id, kind, amount, peer_id, peer_name, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(userId, kind, amount, peer?.id ?? null, peerName ?? peer?.username ?? null, message, now());
}

/** Change a balance; an infinite one stays infinite. */
export const move = (userId: number, delta: number) =>
  db.prepare('UPDATE bank_accounts SET balance = balance + ? WHERE user_id = ? AND balance != ?').run(delta, userId, INFINITE);

export const infinite = (userId: number) => getAccount(userId)?.balance === INFINITE;

/** Open the account with the starting balance; returns true when it was just opened. */
export function ensureAccount(u: UserRow): boolean {
  if (getAccount(u.id)) return false;
  // a bot's till starts empty
  const start = u.is_bot ? 0 : bankSettings().startBalance;
  return db.transaction(() => {
    const res = db.prepare('INSERT OR IGNORE INTO bank_accounts (user_id, balance, created_at) VALUES (?, ?, ?)').run(u.id, start, now());
    if (res.changes && start) addOp(u.id, 'start', start);
    return res.changes > 0;
  })();
}

export function requireActive(u: UserRow): AccountRow {
  ensureAccount(u);
  const acc = getAccount(u.id)!;
  if (acc.banned) throw forbidden(txt.bank.banned, 'bank_banned');
  return acc;
}

export const balanceOfUser = (u: UserRow) => getAccount(u.id)?.balance ?? 0;

/** What the user may spend right now. */
export const spendable = (userId: number) => (infinite(userId) ? Number.POSITIVE_INFINITY : (getAccount(userId)?.balance ?? 0));

export function bankInfo(u: UserRow): BankInfo {
  ensureAccount(u);
  const acc = getAccount(u.id)!;
  const s = bankSettings();
  return {
    balance: acc.balance,
    banned: !!acc.banned,
    jokePrice: s.jokePrice,
  };
}

// ---------- operations ----------

export function transfer(from: UserRow, to: UserRow, amount: number, message: string): { balance: number } {
  if (from.id === to.id) throw badRequest(txt.bank.selfTransfer);
  requireActive(from);
  ensureAccount(to);
  db.transaction(() => {
    if (spendable(from.id) < amount) throw new HttpError(400, 'insufficient_funds', txt.bank.insufficient);
    move(from.id, -amount);
    move(to.id, amount);
    addOp(from.id, 'transfer_out', -amount, to, message);
    addOp(to.id, 'transfer_in', amount, from, message);
  })();
  return { balance: balanceOfUser(from) };
}

/** Pay `price` (the coins are gone); call inside a transaction after checking the balance. */
function pay(u: UserRow, kind: 'joke' | 'bot', price: number, message = '') {
  move(u.id, -price);
  addOp(u.id, kind, -price, null, message);
}

/**
 * One round of a casino game: the bet goes, the win (bet included) comes, one history row with
 * the difference. Coins are minted and burned like the other fees. Returns the new balance.
 */
export function playRound(u: UserRow, bet: number, win: number, message: string): number {
  requireActive(u);
  db.transaction(() => {
    if (spendable(u.id) < bet) throw new HttpError(400, 'insufficient_funds', txt.bank.insufficient);
    move(u.id, win - bet);
    addOp(u.id, 'casino', win - bet, null, message);
  })();
  return balanceOfUser(u);
}

/**
 * A multiplayer game starts: both players put in the stake at once, or nobody does. Throws with
 * `who` = the player who cannot pay, so the caller can tell whose balance was short.
 */
export function pvpTakeStakes(a: UserRow, b: UserRow, stake: number, message: string) {
  for (const u of [a, b]) {
    try {
      requireActive(u);
    } catch (e) {
      throw Object.assign(e as HttpError, { who: u.id });
    }
  }
  db.transaction(() => {
    for (const [u, peer] of [
      [a, b],
      [b, a],
    ] as const) {
      if (spendable(u.id) < stake) {
        throw Object.assign(new HttpError(400, 'insufficient_funds', txt.bank.insufficient), { who: u.id });
      }
      move(u.id, -stake);
      addOp(u.id, 'pvp', -stake, peer, message);
    }
  })();
}

/** The pot of a multiplayer game goes to the winner (or a stake back to each player). */
export function pvpPay(u: UserRow, amount: number, peer: UserRow, message: string) {
  ensureAccount(u);
  db.transaction(() => {
    move(u.id, amount);
    addOp(u.id, 'pvp', amount, peer, message);
  })();
}

/**
 * A new bot costs ТК (the admin sets the price); the coins are gone for good, deleting the bot brings nothing back.
 * Run it inside the transaction that creates the bot, so a failed creation costs nothing.
 */
export function payForBot(u: UserRow, message: string): number {
  requireActive(u);
  const price = bankSettings().botPrice;
  if (price > 0) {
    db.transaction(() => {
      if (spendable(u.id) < price) throw new HttpError(400, 'insufficient_funds', txt.bank.insufficient);
      pay(u, 'bot', price, message);
    })();
  }
  return price;
}

export function buyJoke(u: UserRow) {
  requireActive(u);
  const price = bankSettings().jokePrice;
  if (price > 0) {
    db.transaction(() => {
      if (spendable(u.id) < price) throw new HttpError(400, 'insufficient_funds', txt.bank.jokeNoMoney);
      pay(u, 'joke', price);
    })();
  }
  const joke = JOKES[Math.floor(Math.random() * JOKES.length)]!;
  return { joke, balance: balanceOfUser(u) };
}

export function activatePromo(u: UserRow, rawCode: string): { tcoins: number; balance: number } {
  requireActive(u);
  const code = rawCode.trim();
  let tcoins = 0;
  db.transaction(() => {
    const promo = db.prepare('SELECT * FROM bank_promos WHERE code = ? AND active = 1').get(code) as
      | { code: string; tcoins: number; max_uses: number | null; used: number }
      | undefined;
    if (!promo) {
      const premium = db.prepare('SELECT 1 FROM premium_promos WHERE code = ?').get(code.toUpperCase());
      throw badRequest(premium ? txt.bank.promoIsPremium : txt.bank.promoNotFound);
    }
    if (promo.max_uses && promo.used >= promo.max_uses) throw badRequest(txt.bank.promoExhausted);
    if (db.prepare('SELECT 1 FROM bank_promo_uses WHERE code = ? AND user_id = ?').get(promo.code, u.id)) {
      throw badRequest(txt.bank.promoUsed);
    }
    // new coins: nobody pays for a promo code
    move(u.id, promo.tcoins);
    db.prepare('UPDATE bank_promos SET used = used + 1 WHERE code = ?').run(promo.code);
    db.prepare('INSERT INTO bank_promo_uses (code, user_id, created_at) VALUES (?, ?, ?)').run(promo.code, u.id, now());
    addOp(u.id, 'promo', promo.tcoins, null, '', promo.code);
    tcoins = promo.tcoins;
  })();
  return { tcoins, balance: balanceOfUser(u) };
}

const opDTO = (r: OpRow): BankOperation => ({
  id: r.id,
  kind: r.kind,
  amount: r.amount,
  peer: r.peer_name,
  message: r.message,
  createdAt: r.created_at,
});

export function history(u: UserRow, offset = 0, limit = 30): BankHistory {
  ensureAccount(u);
  const rows = db
    .prepare('SELECT * FROM bank_ops WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?')
    .all(u.id, limit + 1, offset) as OpRow[];
  return { items: rows.slice(0, limit).map(opDTO), hasMore: rows.length > limit };
}

/** A deleted user's account (and coins) is gone. */
export function closeAccount(u: UserRow) {
  db.prepare('DELETE FROM bank_accounts WHERE user_id = ?').run(u.id);
}

// ---------- admin ----------

export function adminOverview(): AdminBankOverview {
  const rows = db
    .prepare(`SELECT a.* FROM bank_accounts a JOIN users u ON u.id = a.user_id ORDER BY a.balance DESC`)
    .all() as AccountRow[];
  const users = usersByIds(rows.map((r) => r.user_id));
  const promos = db.prepare('SELECT * FROM bank_promos ORDER BY created_at DESC').all() as {
    code: string;
    tcoins: number;
    max_uses: number | null;
    used: number;
    active: number;
    created_at: number;
  }[];
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  return {
    totalBalance: rows.reduce((s, r) => s + (r.balance === INFINITE ? 0 : r.balance), 0),
    accountCount: rows.length,
    opsToday: (db.prepare('SELECT COUNT(*) c FROM bank_ops WHERE created_at >= ?').get(dayStart.getTime()) as { c: number }).c,
    settings: bankSettings(),
    accounts: rows
      .filter((r) => users.has(r.user_id))
      .map((r) => ({
        user: userDTO(users.get(r.user_id)!, { self: true }),
        balance: r.balance,
        banned: !!r.banned,
        createdAt: r.created_at,
      })),
    promos: promos.map((p) => ({
      code: p.code,
      tcoins: p.tcoins,
      maxUses: p.max_uses,
      used: p.used,
      active: !!p.active,
      createdAt: p.created_at,
    })),
  };
}

/** One account for the admin; opens it if the user never visited the bank. */
export function adminAccount(userId: number): AdminBankAccount {
  const u = getUserRow(userId);
  if (!u) throw notFound(txt.errors.userNotFound);
  ensureAccount(u);
  const a = getAccount(u.id)!;
  return { user: userDTO(u, { self: true }), balance: a.balance, banned: !!a.banned, createdAt: a.created_at };
}

/** Recent operations of one user or of everybody. */
export function adminOps(userId: number | null, offset = 0, limit = 50): { items: AdminBankOp[]; hasMore: boolean } {
  const rows = (
    userId
      ? db.prepare('SELECT * FROM bank_ops WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?').all(userId, limit + 1, offset)
      : db.prepare('SELECT * FROM bank_ops ORDER BY id DESC LIMIT ? OFFSET ?').all(limit + 1, offset)
  ) as OpRow[];
  const users = usersByIds(rows.map((r) => r.user_id));
  return {
    items: rows.slice(0, limit).map((r) => ({
      ...opDTO(r),
      user: users.has(r.user_id) ? userDTO(users.get(r.user_id)!, { self: true }) : null,
    })),
    hasMore: rows.length > limit,
  };
}

/** Add to (or set) a balance — the admin prints and burns coins. Setting -1 makes it infinite. */
export function adminGive(userId: number, amount: number, set: boolean, reason: string) {
  const u = getUserRow(userId);
  if (!u) throw notFound(txt.errors.userNotFound);
  ensureAccount(u);
  const before = getAccount(u.id)!.balance;
  if (set) {
    if (amount < INFINITE) throw badRequest(txt.bank.badBalance);
    if (amount !== before) {
      const delta = amount === INFINITE || before === INFINITE ? 0 : amount - before;
      db.transaction(() => {
        db.prepare('UPDATE bank_accounts SET balance = ? WHERE user_id = ?').run(amount, u.id);
        addOp(u.id, 'admin', delta, null, reason || (amount === INFINITE ? txt.bank.infiniteOn : ''));
      })();
    }
  } else if (amount !== 0 && before !== INFINITE) {
    // an infinite balance stays infinite
    if (before + amount < 0) throw badRequest(txt.bank.insufficient);
    db.transaction(() => {
      move(u.id, amount);
      addOp(u.id, 'admin', amount, null, reason);
    })();
  }
  const balance = balanceOfUser(u);
  const changed = balance !== before;
  return { user: u, delta: !changed ? 0 : balance === INFINITE || before === INFINITE ? 1 : balance - before, balance };
}

export function adminSetBanned(userId: number, banned: boolean) {
  const u = getUserRow(userId);
  if (!u) throw notFound(txt.errors.userNotFound);
  ensureAccount(u);
  db.prepare('UPDATE bank_accounts SET banned = ? WHERE user_id = ?').run(banned ? 1 : 0, userId);
}

export function adminCreatePromo(code: string, tcoins: number, maxUses: number | null) {
  if (db.prepare('SELECT 1 FROM premium_promos WHERE code = ?').get(code.toUpperCase())) throw badRequest(txt.bank.promoExists);
  const res = db
    .prepare('INSERT OR IGNORE INTO bank_promos (code, tcoins, max_uses, created_at) VALUES (?, ?, ?, ?)')
    .run(code.toUpperCase(), tcoins, maxUses, now());
  if (!res.changes) throw badRequest(txt.bank.promoExists);
}

export function adminUpdatePromo(code: string, patch: { active?: boolean; tcoins?: number; maxUses?: number | null }) {
  const p = db.prepare('SELECT code FROM bank_promos WHERE code = ?').get(code) as { code: string } | undefined;
  if (!p) throw notFound(txt.bank.promoNotFound);
  if (patch.active !== undefined) db.prepare('UPDATE bank_promos SET active = ? WHERE code = ?').run(patch.active ? 1 : 0, p.code);
  if (patch.tcoins !== undefined) db.prepare('UPDATE bank_promos SET tcoins = ? WHERE code = ?').run(patch.tcoins, p.code);
  if (patch.maxUses !== undefined) db.prepare('UPDATE bank_promos SET max_uses = ? WHERE code = ?').run(patch.maxUses, p.code);
}

export function adminDeletePromo(code: string) {
  if (!db.prepare('DELETE FROM bank_promos WHERE code = ?').run(code).changes) throw notFound(txt.bank.promoNotFound);
}

// ---------- the bank of the earlier version ----------

/**
 * The previous build kept the bank in data/pupsobank.db (TimbaGram users under negative ids).
 * Balances and promo codes move into the main database once; the old file is renamed.
 */
export function importLegacyBank() {
  const file = path.join(config.dataDir, 'pupsobank.db');
  if (!fs.existsSync(file)) return;
  if ((db.prepare('SELECT COUNT(*) c FROM bank_accounts').get() as { c: number }).c > 0) return;
  let old: Database.Database | null = null;
  try {
    old = new Database(file, { readonly: true });
    const accounts = old.prepare('SELECT tg_id, tcoins, username, banned FROM users').all() as {
      tg_id: number;
      tcoins: number;
      username: string | null;
      banned: number;
    }[];
    const byName = db.prepare('SELECT * FROM users WHERE username = ?');
    db.transaction(() => {
      for (const a of accounts) {
        const u = (a.tg_id < 0 ? getUserRow(-a.tg_id) : undefined) ?? (a.username ? (byName.get(a.username) as UserRow | undefined) : undefined);
        if (!u) continue;
        db.prepare('INSERT OR IGNORE INTO bank_accounts (user_id, balance, banned, created_at) VALUES (?, 0, ?, ?)').run(u.id, a.banned ? 1 : 0, now());
        move(u.id, a.tcoins);
        addOp(u.id, 'admin', a.tcoins, null, txt.bank.imported);
      }
      const promos = old!.prepare('SELECT code, tcoins, max_uses, used, active FROM promo_codes').all() as {
        code: string;
        tcoins: number;
        max_uses: number | null;
        used: number;
        active: number;
      }[];
      for (const p of promos) {
        db.prepare('INSERT OR IGNORE INTO bank_promos (code, tcoins, max_uses, used, active, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
          p.code,
          p.tcoins,
          p.max_uses,
          p.used,
          p.active,
          now(),
        );
      }
    })();
  } catch {
    return;
  } finally {
    old?.close();
  }
  for (const f of [file, `${file}-wal`, `${file}-shm`]) {
    if (fs.existsSync(f)) fs.renameSync(f, f.replace('pupsobank.db', 'pupsobank.db.imported'));
  }
}

// ---------- top-ups (a money transfer, checked by the admin) ----------

export interface TopupRow {
  id: number;
  user_id: number;
  kind: TopupKind;
  amount: number;
  status: 'pending' | 'approved' | 'rejected';
  message_id: number | null;
  created_at: number;
  decided_at: number | null;
}

export const getTopup = (id: number) => db.prepare('SELECT * FROM bank_topups WHERE id = ?').get(id) as TopupRow | undefined;

/** The user says the money was sent; one check of each kind at a time. */
export function createTopup(u: UserRow, amount: number, kind: TopupKind = 'coins'): TopupRow {
  if (kind === 'coins') requireActive(u);
  if (db.prepare(`SELECT 1 FROM bank_topups WHERE user_id = ? AND kind = ? AND status = 'pending'`).get(u.id, kind)) {
    throw badRequest(kind === 'premium' ? txt.premium.pending : txt.bank.topupPending);
  }
  const res = db
    .prepare('INSERT INTO bank_topups (user_id, kind, amount, created_at) VALUES (?, ?, ?, ?)')
    .run(u.id, kind, amount, now());
  return getTopup(Number(res.lastInsertRowid))!;
}

/** Confirm (the coins are credited, 1 ТК = 1 ₽; a premium payment adds a month) or reject a pending top-up. */
export function decideTopup(id: number, approve: boolean): { topup: TopupRow; user: UserRow | undefined; balance: number } {
  const t = getTopup(id);
  if (!t) throw notFound(txt.bank.topupNotFound);
  if (t.status !== 'pending') throw badRequest(txt.bank.topupDecided);
  const user = getUserRow(t.user_id);
  db.transaction(() => {
    db.prepare('UPDATE bank_topups SET status = ?, decided_at = ? WHERE id = ?').run(approve ? 'approved' : 'rejected', now(), id);
    if (approve && user && t.kind === 'premium') {
      extendPremium(user.id, PREMIUM_DAYS);
    } else if (approve && user) {
      ensureAccount(user);
      move(user.id, t.amount);
      addOp(user.id, 'topup', t.amount);
    }
  })();
  return { topup: getTopup(id)!, user, balance: user ? balanceOfUser(user) : 0 };
}

export function pendingTopups() {
  const rows = db.prepare(`SELECT * FROM bank_topups WHERE status = 'pending' ORDER BY id`).all() as TopupRow[];
  const users = usersByIds(rows.map((r) => r.user_id));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    amount: r.amount,
    status: r.status,
    user: users.has(r.user_id) ? userDTO(users.get(r.user_id)!, { self: true }) : null,
    createdAt: r.created_at,
  }));
}

// ---------- weekly bonus of TimbaGram Premium ----------

const DAY = 86400_000;
const WEEK = 7 * DAY;

/**
 * premium_bonus: last_at is when the user last took the bonus, reminded_at when we last reminded
 * them of a waiting one, expiry_warned the premium_until we already warned about. The table lives
 * outside the numbered migrations, so it never collides with a migration added elsewhere.
 */
export function initPremiumBonus() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS premium_bonus (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      last_at INTEGER
    );
  `);
  const cols = (db.prepare('PRAGMA table_info(premium_bonus)').all() as { name: string; notnull: number }[]);
  // the first version kept only last_at, NOT NULL: rebuild it with the reminders
  if (!cols.some((c) => c.name === 'reminded_at')) {
    db.exec(`
      CREATE TABLE premium_bonus_new (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        last_at INTEGER,
        reminded_at INTEGER,
        expiry_warned INTEGER
      );
      INSERT INTO premium_bonus_new (user_id, last_at) SELECT user_id, last_at FROM premium_bonus;
      DROP TABLE premium_bonus;
      ALTER TABLE premium_bonus_new RENAME TO premium_bonus;
    `);
  }
}

interface BonusRow {
  user_id: number;
  last_at: number | null;
  reminded_at: number | null;
  expiry_warned: number | null;
}

const bonusRow = (userId: number) => db.prepare('SELECT * FROM premium_bonus WHERE user_id = ?').get(userId) as BonusRow | undefined;

function saveBonus(userId: number, patch: Partial<Omit<BonusRow, 'user_id'>>) {
  db.prepare('INSERT OR IGNORE INTO premium_bonus (user_id) VALUES (?)').run(userId);
  for (const [k, v] of Object.entries(patch)) db.prepare(`UPDATE premium_bonus SET ${k} = ? WHERE user_id = ?`).run(v, userId);
}

/** When the next bonus can be taken (0 = never taken: right away); null without premium. */
export function premiumBonusAt(u: UserRow): number | null {
  if (!u.premium_until || u.premium_until <= now()) return null;
  const last = bonusRow(u.id)?.last_at;
  return last ? last + WEEK : 0;
}

/** The user presses «Забрать бонус»: PREMIUM_WEEKLY_BONUS ТК, then the next one in a week. */
export function claimPremiumBonus(u: UserRow): { amount: number; balance: number; nextAt: number } {
  ensureAccount(u);
  db.transaction(() => {
    const at = premiumBonusAt(getUserRow(u.id)!);
    if (at === null) throw forbidden(txt.premium.bonusNoPremium, 'premium_required');
    if (at > now()) throw badRequest(txt.premium.bonusNotYet);
    saveBonus(u.id, { last_at: now() });
    move(u.id, PREMIUM_WEEKLY_BONUS);
    addOp(u.id, 'premium_bonus', PREMIUM_WEEKLY_BONUS, null, txt.premium.weeklyBonusOp);
  })();
  return { amount: PREMIUM_WEEKLY_BONUS, balance: balanceOfUser(u), nextAt: now() + WEEK };
}

/**
 * Reminders: a bonus that is ready (once when it becomes ready, once more a day later if it still
 * waits) and a premium that ends within a day (once per end date; a premium without an end never).
 */
export function sendPremiumReminders() {
  const t = now();
  const rows = db
    .prepare(
      `SELECT u.id, u.premium_until, b.last_at, b.reminded_at, b.expiry_warned FROM users u
       LEFT JOIN premium_bonus b ON b.user_id = u.id WHERE u.premium_until > ?`,
    )
    .all(t) as (Omit<BonusRow, 'user_id'> & { id: number; premium_until: number })[];
  for (const r of rows) {
    const readyAt = r.last_at ? r.last_at + WEEK : 0;
    const reminded = r.reminded_at ?? -1;
    if (readyAt <= t && (reminded < readyAt || (reminded < t - DAY && reminded < readyAt + DAY))) {
      saveBonus(r.id, { reminded_at: t });
      notify('bank', r.id, reminded < readyAt ? txt.premium.bonusReady(PREMIUM_WEEKLY_BONUS) : txt.premium.bonusWaiting(PREMIUM_WEEKLY_BONUS), null, '/premium');
    }
    if (!isPremiumForever(r.premium_until) && r.premium_until - t <= DAY && r.expiry_warned !== r.premium_until) {
      saveBonus(r.id, { expiry_warned: r.premium_until });
      notify('bank', r.id, txt.premium.endsSoon(txt.premium.until(r.premium_until)), null, '/premium');
    }
  }
}

let bonusTimer: ReturnType<typeof setInterval> | null = null;

export function startPremiumBonusTimer() {
  if (bonusTimer) return;
  sendPremiumReminders();
  bonusTimer = setInterval(sendPremiumReminders, 600_000);
}
