import { EV, PREMIUM_FOREVER, PREMIUM_UPLOAD_FACTOR, type PremiumPromoDTO, isPremiumForever } from '@timba/shared';
import { randomBytes } from 'node:crypto';
import { badRequest, notFound } from './errors.js';
import { txt } from './strings.js';
import { db, now } from './db.js';
import { toAll } from './realtime.js';
import { type UserRow, getUserRow, isPremium, userDTO } from './serialize.js';
import { getSettings } from './settings.js';

/**
 * TimbaGram Premium: users.premium_until is the moment it ends. A month is bought like a top-up
 * (the user pays by the admin's link and asks for a check) or given by the admin.
 */

const DAY = 86400_000;

/** The end of an active premium, or null. */
function activeUntil(userId: number): number | null {
  const u = getUserRow(userId);
  return u?.premium_until && u.premium_until > now() ? u.premium_until : null;
}

/** Set the end of the premium exactly; a moment in the past or null takes it away. Returns the new end. */
export function setPremiumUntil(userId: number, until: number | null): number | null {
  const end = until && until > now() ? Math.min(until, PREMIUM_FOREVER) : null;
  db.prepare('UPDATE users SET premium_until = ? WHERE id = ?').run(end, userId);
  return end;
}

/** Add `days` to the premium; an expired one starts over from now, one without an end stays so. */
export function extendPremium(userId: number, days: number | null): number {
  const cur = activeUntil(userId);
  if (days === null || isPremiumForever(cur)) return setPremiumUntil(userId, PREMIUM_FOREVER)!;
  return setPremiumUntil(userId, (cur ?? now()) + days * DAY)!;
}

/** Shorten an active premium by `days`; cutting past now takes it away. */
export function cutPremium(userId: number, days: number): number | null {
  const cur = activeUntil(userId);
  if (!cur) return null;
  if (isPremiumForever(cur)) throw badRequest(txt.premium.cutForever);
  return setPremiumUntil(userId, cur - days * DAY);
}

export function removePremium(userId: number) {
  setPremiumUntil(userId, null);
}

// ---------- promo codes ----------

interface PromoRow {
  id: number;
  code: string;
  days: number | null;
  max_uses: number | null;
  uses: number;
  expires_at: number | null;
  created_at: number;
}

const promoDTO = (r: PromoRow): PremiumPromoDTO => ({
  id: r.id,
  code: r.code,
  days: r.days,
  maxUses: r.max_uses,
  uses: r.uses,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
});

export const listPromos = () =>
  (db.prepare('SELECT * FROM premium_promos ORDER BY id DESC').all() as PromoRow[]).map(promoDTO);

/** 8 characters without look-alikes (0/O, 1/I) */
function randomCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(randomBytes(8), (b) => abc[b % abc.length]).join('');
}

export function createPromo(p: { code?: string; days: number | null; maxUses?: number | null; expiresAt?: number | null }) {
  let code = p.code;
  const taken = (c: string) =>
    !!db.prepare('SELECT 1 FROM premium_promos WHERE code = ?').get(c) || !!db.prepare('SELECT 1 FROM bank_promos WHERE code = ?').get(c);
  if (code && taken(code)) throw badRequest(txt.premium.promoExists);
  while (!code || taken(code)) code = randomCode();
  const id = db
    .prepare('INSERT INTO premium_promos (code, days, max_uses, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(code, p.days, p.maxUses ?? null, p.expiresAt ?? null, now()).lastInsertRowid;
  return promoDTO(db.prepare('SELECT * FROM premium_promos WHERE id = ?').get(id) as PromoRow);
}

export function deletePromo(id: number) {
  if (!db.prepare('DELETE FROM premium_promos WHERE id = ?').run(id).changes) throw notFound(txt.premium.promoNotFound);
}

/** The user enters a code: premium for its days (or forever) on top of what is left. Returns the new end. */
export function redeemPromo(userId: number, code: string): number {
  return db.transaction(() => {
    const p = db.prepare('SELECT * FROM premium_promos WHERE code = ?').get(code) as PromoRow | undefined;
    if (!p && db.prepare('SELECT 1 FROM bank_promos WHERE code = ? AND active = 1').get(code)) throw badRequest(txt.premium.promoIsCoins);
    if (!p || (p.expires_at && p.expires_at <= now())) throw badRequest(txt.premium.promoNotFound);
    if (p.max_uses !== null && p.uses >= p.max_uses) throw badRequest(txt.premium.promoUsedUp);
    if (db.prepare('SELECT 1 FROM premium_promo_uses WHERE promo_id = ? AND user_id = ?').get(p.id, userId)) {
      throw badRequest(txt.premium.promoAlready);
    }
    db.prepare('INSERT INTO premium_promo_uses (promo_id, user_id, used_at) VALUES (?, ?, ?)').run(p.id, userId, now());
    db.prepare('UPDATE premium_promos SET uses = uses + 1 WHERE id = ?').run(p.id);
    return extendPremium(userId, p.days);
  })();
}

/** Everybody sees the badge appear or go away. */
export function announcePremium(userId: number) {
  const u = getUserRow(userId);
  if (u) toAll(EV.userUpdate, userDTO(u));
}

export const premiumPending = (userId: number) =>
  !!db.prepare(`SELECT 1 FROM bank_topups WHERE user_id = ? AND kind = 'premium' AND status = 'pending'`).get(userId);

/** The biggest file this user may upload, MB. */
export function uploadLimitMb(u: UserRow): number {
  const base = getSettings().maxUploadMb;
  return isPremium(u) ? base * PREMIUM_UPLOAD_FACTOR : base;
}
