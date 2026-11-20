import type { Bar, Point, Timeframe } from './types';
import { WEEK, monthStart, weekStart } from './time';

const bucketFn = (tf: Timeframe) => (tf === 'W' ? weekStart : monthStart);

/** Aggregate daily bars into weekly (Monday-start) or monthly bars. */
export function resampleBars(bars: Bar[], tf: Timeframe): Bar[] {
  if (tf === 'D') return bars;
  const key = bucketFn(tf);
  const out: Bar[] = [];
  let cur: Bar | null = null;
  for (const b of bars) {
    const k = key(b.time);
    if (cur && cur.time === k) {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      if (b.volume != null) cur.volume = (cur.volume ?? 0) + b.volume;
    } else {
      cur = { time: k, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
      out.push(cur);
    }
  }
  return out;
}

/** Last observation per bucket, stamped at the bucket start. */
export function resamplePoints(points: Point[], tf: Timeframe): Point[] {
  if (tf === 'D') return points;
  const key = bucketFn(tf);
  const out: Point[] = [];
  for (const p of points) {
    const k = key(p.time);
    const last = out[out.length - 1];
    if (last && last.time === k) last.value = p.value;
    else out.push({ time: k, value: p.value });
  }
  return out;
}

export const toWeekly = (points: Point[]): Point[] => resamplePoints(points, 'W');
export const closes = (bars: Bar[]): Point[] => bars.map((b) => ({ time: b.time, value: b.close }));

/** Every Monday from the week of `start` to the week of `end`, inclusive. */
export function weeklyGrid(start: number, end: number): number[] {
  const out: number[] = [];
  for (let t = weekStart(start); t <= weekStart(end); t += WEEK) out.push(t);
  return out;
}

/** Value of the latest observation at or before each grid time (undefined before the first). */
export function ffillOnGrid(points: Point[], grid: number[]): (number | undefined)[] {
  const out: (number | undefined)[] = [];
  let i = 0;
  let last: number | undefined;
  for (const t of grid) {
    while (i < points.length && points[i].time <= t) last = points[i++].value;
    out.push(last);
  }
  return out;
}

export const shift = (points: Point[], seconds: number): Point[] =>
  points.map((p) => ({ time: p.time + seconds, value: p.value }));

export const logPoints = (points: Point[]): Point[] =>
  points.filter((p) => p.value > 0).map((p) => ({ time: p.time, value: Math.log(p.value) }));

export function mean(v: number[]): number {
  let s = 0;
  for (const x of v) s += x;
  return v.length ? s / v.length : NaN;
}

export function std(v: number[]): number {
  if (v.length < 2) return NaN;
  const m = mean(v);
  let s = 0;
  for (const x of v) s += (x - m) ** 2;
  return Math.sqrt(s / (v.length - 1));
}

export function zscore(points: Point[]): Point[] {
  const vals = points.map((p) => p.value);
  const m = mean(vals);
  const s = std(vals) || 1;
  return points.map((p) => ({ time: p.time, value: (p.value - m) / s }));
}

/** Rolling z-score over `window` observations; starts once half a window is available. */
export function rollingZ(points: Point[], window: number): Point[] {
  const out: Point[] = [];
  const minPeriods = Math.max(2, Math.floor(window / 2));
  for (let i = 0; i < points.length; i++) {
    const from = Math.max(0, i - window + 1);
    if (i - from + 1 < minPeriods) continue;
    const slice = points.slice(from, i + 1).map((p) => p.value);
    const s = std(slice);
    if (!s) continue;
    out.push({ time: points[i].time, value: (points[i].value - mean(slice)) / s });
  }
  return out;
}

/** Year-over-year % change for a weekly (Monday-stamped) series. */
export function yoy(points: Point[]): Point[] {
  const byTime = new Map(points.map((p) => [p.time, p.value]));
  const out: Point[] = [];
  for (const p of points) {
    const prev = byTime.get(p.time - 52 * WEEK);
    if (prev) out.push({ time: p.time, value: (p.value / prev - 1) * 100 });
  }
  return out;
}

export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return NaN;
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let cov = 0, va = 0, vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    cov += da * db; va += da * da; vb += db * db;
  }
  return va && vb ? cov / Math.sqrt(va * vb) : NaN;
}

/** Pair two series on identical timestamps. */
export function pairOnTime(x: Point[], y: Point[]): { t: number[]; a: number[]; b: number[] } {
  const ym = new Map(y.map((p) => [p.time, p.value]));
  const t: number[] = [], a: number[] = [], b: number[] = [];
  for (const p of x) {
    const v = ym.get(p.time);
    if (v !== undefined) { t.push(p.time); a.push(p.value); b.push(v); }
  }
  return { t, a, b };
}

/** Correlation of x shifted forward by `lagWeeks` against y (x leads y when r peaks at lag > 0). */
export function correlateAtLag(x: Point[], y: Point[], lagWeeks: number): { r: number; n: number } {
  const { a, b } = pairOnTime(shift(x, lagWeeks * WEEK), y);
  return { r: pearson(a, b), n: a.length };
}

export interface LagCorr { lag: number; r: number; n: number }

export function crossCorrelation(x: Point[], y: Point[], maxLagWeeks: number): LagCorr[] {
  const out: LagCorr[] = [];
  for (let lag = 0; lag <= maxLagWeeks; lag++) out.push({ lag, ...correlateAtLag(x, y, lag) });
  return out;
}

export function bestLag(xc: LagCorr[]): LagCorr {
  return xc.reduce((best, c) => (Number.isFinite(c.r) && (!Number.isFinite(best.r) || c.r > best.r) ? c : best), xc[0]);
}

export function rollingCorrelation(x: Point[], y: Point[], window: number): Point[] {
  const { t, a, b } = pairOnTime(x, y);
  const out: Point[] = [];
  for (let i = window - 1; i < t.length; i++) {
    const r = pearson(a.slice(i - window + 1, i + 1), b.slice(i - window + 1, i + 1));
    if (Number.isFinite(r)) out.push({ time: t[i], value: r });
  }
  return out;
}

// ---- Indicators -------------------------------------------------------------

export function sma(points: Point[], n: number): Point[] {
  const out: Point[] = [];
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    sum += points[i].value;
    if (i >= n) sum -= points[i - n].value;
    if (i >= n - 1) out.push({ time: points[i].time, value: sum / n });
  }
  return out;
}

export function ema(points: Point[], n: number): Point[] {
  const out: Point[] = [];
  const k = 2 / (n + 1);
  let prev: number | undefined;
  for (let i = 0; i < points.length; i++) {
    if (i < n - 1) continue;
    if (prev === undefined) prev = mean(points.slice(0, n).map((p) => p.value));
    else prev = points[i].value * k + prev * (1 - k);
    out.push({ time: points[i].time, value: prev });
  }
  return out;
}

export function bollinger(points: Point[], n = 20, mult = 2): { upper: Point[]; middle: Point[]; lower: Point[] } {
  const upper: Point[] = [], middle: Point[] = [], lower: Point[] = [];
  for (let i = n - 1; i < points.length; i++) {
    const w = points.slice(i - n + 1, i + 1).map((p) => p.value);
    const m = mean(w);
    let v = 0;
    for (const x of w) v += (x - m) ** 2;
    const s = Math.sqrt(v / n);
    const time = points[i].time;
    upper.push({ time, value: m + mult * s });
    middle.push({ time, value: m });
    lower.push({ time, value: m - mult * s });
  }
  return { upper, middle, lower };
}

/** Wilder's RSI. */
export function rsi(points: Point[], n = 14): Point[] {
  const out: Point[] = [];
  if (points.length <= n) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = points[i].value - points[i - 1].value;
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= n; loss /= n;
  const val = () => (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  out.push({ time: points[n].time, value: val() });
  for (let i = n + 1; i < points.length; i++) {
    const d = points[i].value - points[i - 1].value;
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out.push({ time: points[i].time, value: val() });
  }
  return out;
}
