import type { Bar } from '../lib/types';
import type { FundingEvent } from '../bot/bottomBot';

/** Binance COIN-M (inverse, BTC-margined) perpetual. */
export const COINM_SYMBOL = 'BTCUSD_PERP';
export type BotInterval = '1h' | '4h' | '1d';
export const INTERVAL_SEC: Record<BotInterval, number> = { '1h': 3600, '4h': 14400, '1d': 86400 };

const BASE = '/api/binance';
/** A kline endpoint and its page size (spot caps a page at 1000, COIN-M at 1500). */
type Source = { url: string; page: number };
const COINM: Source = { url: `${BASE}/dapi/v1/klines?symbol=${COINM_SYMBOL}`, page: 1500 };
/** Binance spot BTCUSDT: history before the contract existed (Aug 2017 → Aug 2020) and the 2017 high. */
const SPOT: Source = { url: '/api/bnspot/api/v3/klines?symbol=BTCUSDT', page: 1000 };
const TIMEOUT_MS = 20_000;

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Binance ${res.status}`);
  return res.json() as Promise<T>;
}

type Kline = [number, string, string, string, string, string, ...unknown[]];

export function parseKlines(rows: Kline[]): Bar[] {
  return rows.map((k) => ({ time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
}

/** Klines from `startSec` to now, paged backwards. The still-forming last bar is dropped. */
export async function fetchKlines(interval: BotInterval, startSec: number, src: Source = COINM): Promise<Bar[]> {
  const pages: Bar[][] = [];
  let end = Date.now();
  for (let n = 0; n < 60; n++) {
    const rows = await getJson<Kline[]>(`${src.url}&interval=${interval}&limit=${src.page}&endTime=${end}`);
    if (!rows.length) break;
    const bars = parseKlines(rows);
    pages.unshift(bars);
    if (bars[0].time <= startSec || rows.length < src.page) break;
    end = rows[0][0] - 1;
  }
  const all = pages.flat().filter((b) => b.time >= startSec);
  const nowSec = Date.now() / 1000;
  while (all.length && all[all.length - 1].time + INTERVAL_SEC[interval] > nowSec) all.pop();
  return all;
}

export async function fetchFunding(startSec: number): Promise<FundingEvent[]> {
  const out: FundingEvent[] = [];
  let start = startSec * 1000;
  for (let n = 0; n < 20; n++) {
    const rows = await getJson<{ fundingTime: number; fundingRate: string; markPrice: string }[]>(
      `${BASE}/dapi/v1/fundingRate?symbol=${COINM_SYMBOL}&limit=1000&startTime=${start}`);
    for (const r of rows) out.push({ time: Math.floor(r.fundingTime / 1000), rate: +r.fundingRate, markPrice: +r.markPrice });
    if (rows.length < 1000) break;
    start = rows[rows.length - 1].fundingTime + 1;
  }
  return out;
}

/** Contract launch (Aug 2020) and spot BTCUSDT listing (Aug 2017, before the 2017 high). */
const LAUNCH_SEC = Math.floor(Date.UTC(2020, 7, 1) / 1000);
const SPOT_START_SEC = Math.floor(Date.UTC(2017, 7, 1) / 1000);
let dailyAll: Promise<Bar[]> | null = null;
/** Daily highs for the all-time high: spot since 2017 plus the contract's own (its wicks can differ). */
export function loadDailyHistory() {
  dailyAll ??= Promise.all([fetchKlines('1d', SPOT_START_SEC, SPOT), fetchKlines('1d', LAUNCH_SEC)])
    .then(([spot, perp]) => [...spot, ...perp].sort((a, b) => a.time - b.time))
    .catch((e) => { dailyAll = null; throw e; });
  return dailyAll;
}

export interface BotData {
  bars: Bar[]; funding: FundingEvent[]; daily: Bar[];
  /** Bars before this time are spot BTCUSDT (the contract didn't exist yet); null if none. */
  spotUntil: number | null;
}
const cache = new Map<string, Promise<BotData>>();

/** Cached per interval and lookback. Lookbacks before the contract's launch are filled with spot bars. */
export function loadBotData(interval: BotInterval, years: number) {
  const key = `${interval}|${years}`;
  let p = cache.get(key);
  if (!p) {
    const startSec = Math.floor(Date.now() / 1000 - years * 365.25 * 86400);
    const spot = startSec < LAUNCH_SEC + 30 * 86400 ? fetchKlines(interval, Math.max(startSec, SPOT_START_SEC), SPOT) : Promise.resolve([]);
    p = Promise.all([fetchKlines(interval, startSec), spot, fetchFunding(startSec).catch(() => []), loadDailyHistory()])
      .then(([perp, spotBars, funding, daily]) => {
        const first = perp[0]?.time ?? Infinity;
        const before = spotBars.filter((b) => b.time < first);
        return { bars: [...before, ...perp], funding, daily, spotUntil: before.length ? first : null };
      });
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}
