import type { Bar } from '../lib/types';
import type { FundingEvent } from '../bot/bottomBot';

/** Binance COIN-M (inverse, BTC-margined) perpetual. */
export const COINM_SYMBOL = 'BTCUSD_PERP';
export type BotInterval = '1h' | '4h' | '1d';
export const INTERVAL_SEC: Record<BotInterval, number> = { '1h': 3600, '4h': 14400, '1d': 86400 };

const BASE = '/api/binance';
const TIMEOUT_MS = 20_000;
const PAGE = 1500;

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
export async function fetchKlines(interval: BotInterval, startSec: number): Promise<Bar[]> {
  const pages: Bar[][] = [];
  let end = Date.now();
  for (let n = 0; n < 40; n++) {
    const rows = await getJson<Kline[]>(`${BASE}/dapi/v1/klines?symbol=${COINM_SYMBOL}&interval=${interval}&limit=${PAGE}&endTime=${end}`);
    if (!rows.length) break;
    const bars = parseKlines(rows);
    pages.unshift(bars);
    if (bars[0].time <= startSec || rows.length < PAGE) break;
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

const cache = new Map<string, Promise<{ bars: Bar[]; funding: FundingEvent[] }>>();

/** Cached per interval and lookback. */
export function loadBotData(interval: BotInterval, years: number) {
  const key = `${interval}|${years}`;
  let p = cache.get(key);
  if (!p) {
    const startSec = Math.floor(Date.now() / 1000 - years * 365.25 * 86400);
    p = Promise.all([fetchKlines(interval, startSec), fetchFunding(startSec).catch(() => [])])
      .then(([bars, funding]) => ({ bars, funding }));
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}
