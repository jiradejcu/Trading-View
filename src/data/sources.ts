import type { Bar, Point } from '../lib/types';
import { DAY, dayStart, parseISODate } from '../lib/time';

/** Data starts here; older history isn't needed for the comparison and keeps payloads small. */
export const HISTORY_START = '2012-01-01';
export const HISTORY_START_SEC = parseISODate(HISTORY_START);

/** FRED series that make up the global liquidity index. */
export const FRED_IDS = ['WALCL', 'WTREGEN', 'RRPONTSYD', 'ECBASSETSW', 'JPNASSETS', 'DEXUSEU', 'DEXJPUS'] as const;
export type FredId = (typeof FRED_IDS)[number];

/** App symbol -> Yahoo Finance ticker. */
export const YAHOO_TICKERS = {
  BTCUSD: 'BTC-USD',
  ETHUSD: 'ETH-USD',
  SPX: '^GSPC',
  MOVE: '^MOVE',
  VIX: '^VIX',
  DXY: 'DX-Y.NYB',
} as const;
export type YahooSymbol = keyof typeof YAHOO_TICKERS;

export const fredUrl = (id: string, base = '/api/fred') =>
  `${base}/graph/fredgraph.csv?id=${encodeURIComponent(id)}&cosd=${HISTORY_START}`;

export function yahooUrl(ticker: string, base = '/api/yahoo', nowSec = Math.floor(Date.now() / 1000)) {
  return `${base}/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${HISTORY_START_SEC}&period2=${nowSec + DAY}&interval=1d&includePrePost=false`;
}

/** Parse FRED's `fredgraph.csv` (header `observation_date,ID` or `DATE,ID`; missing values are "."). */
export function parseFredCsv(text: string): Point[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2 || !/^(observation_date|DATE),/i.test(lines[0])) {
    throw new Error('Not a FRED CSV response');
  }
  const out: Point[] = [];
  for (let i = 1; i < lines.length; i++) {
    const [d, v] = lines[i].split(',');
    const time = parseISODate(d);
    const value = Number(v);
    if (Number.isFinite(time) && v !== '.' && v !== '' && Number.isFinite(value)) out.push({ time, value });
  }
  if (!out.length) throw new Error('FRED CSV had no observations');
  return out;
}

interface YahooChartJson {
  chart?: {
    result?: Array<{
      timestamp?: number[];
      indicators?: { quote?: Array<Record<'open' | 'high' | 'low' | 'close' | 'volume', (number | null)[]>> };
    }> | null;
    error?: { description?: string } | null;
  };
}

/** Parse a Yahoo Finance v8 chart response into daily bars (one per UTC day, last wins). */
export function parseYahooChart(json: unknown): Bar[] {
  const chart = (json as YahooChartJson)?.chart;
  const r = chart?.result?.[0];
  const q = r?.indicators?.quote?.[0];
  if (!r?.timestamp || !q) throw new Error(chart?.error?.description ?? 'Not a Yahoo chart response');
  const out: Bar[] = [];
  r.timestamp.forEach((ts, i) => {
    const close = q.close?.[i];
    if (close == null || !Number.isFinite(close)) return;
    const open = q.open?.[i] ?? close;
    const bar: Bar = {
      time: dayStart(ts),
      open,
      high: Math.max(q.high?.[i] ?? close, open, close),
      low: Math.min(q.low?.[i] ?? close, open, close),
      close,
      volume: q.volume?.[i] ?? undefined,
    };
    const last = out[out.length - 1];
    if (last && last.time === bar.time) out[out.length - 1] = bar;
    else out.push(bar);
  });
  if (!out.length) throw new Error('Yahoo response had no bars');
  return out;
}

/** Shape of public/data/snapshot.json written by scripts/fetch-data.mjs. */
export interface Snapshot {
  fetchedAt: string;
  fred: Partial<Record<FredId, string>>;
  yahoo: Partial<Record<YahooSymbol, unknown>>;
}
