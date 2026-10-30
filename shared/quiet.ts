/** «Тихие часы»: в это время уведомления приходят без звука. Минуты отсчитываются от местной полуночи. */
export interface QuietHours {
  on: boolean;
  /** start, minutes after local midnight (0..1439) */
  from: number;
  /** end (exclusive); less than `from` — the interval goes over midnight */
  to: number;
  /** Date.getTimezoneOffset() of the device that saved the setting */
  tz: number;
}

export const DEFAULT_QUIET_HOURS: QuietHours = { on: true, from: 22 * 60, to: 8 * 60, tz: 0 };

export function isQuietNow(q: QuietHours | null | undefined, at = Date.now()): boolean {
  if (!q || !q.on || q.from === q.to) return false;
  const local = (((Math.floor(at / 60000) - q.tz) % 1440) + 1440) % 1440;
  return q.from < q.to ? local >= q.from && local < q.to : local >= q.from || local < q.to;
}

/** 0..1439 → «22:30» */
export const minutesToTime = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** «22:30» → 1350, or null for anything else */
export function timeToMinutes(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}
