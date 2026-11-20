export const DAY = 86_400;
export const WEEK = 7 * DAY;
export const YEAR = 365.25 * DAY;

export const dayStart = (t: number): number => Math.floor(t / DAY) * DAY;

/** Monday 00:00 UTC of the week containing `t`. (1970-01-01 was a Thursday.) */
export function weekStart(t: number): number {
  const d = Math.floor(t / DAY);
  return (d - ((d + 3) % 7)) * DAY;
}

export function monthStart(t: number): number {
  const dt = new Date(t * 1000);
  return Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), 1) / 1000;
}

/** Parse `YYYY-MM-DD` to a UTC unix timestamp (seconds). Returns NaN on bad input. */
export function parseISODate(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s.trim());
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3]) / 1000;
}

export function fmtDate(t: number): string {
  return new Date(t * 1000).toISOString().slice(0, 10);
}
