import type { Bar, Point, SourceKind } from '../lib/types';
import {
  FRED_IDS, YAHOO_TICKERS, fredUrl, parseFredCsv, parseYahooChart, yahooUrl,
  type FredId, type Snapshot, type YahooSymbol,
} from './sources';
import { generateDemo, type DemoData } from './synthetic';

export interface BarSeries { bars: Bar[]; source: SourceKind }

export interface Dataset {
  bars: Record<YahooSymbol, BarSeries>;
  /** The liquidity inputs always come from one tier so units and dates stay consistent. */
  fred: { points: Record<FredId, Point[]>; source: SourceKind };
  snapshotAt?: string;
}

const LIVE_TIMEOUT_MS = 20_000;

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(LIVE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

async function loadSnapshot(): Promise<Snapshot | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data/snapshot.json`, { cache: 'no-cache' });
    if (!res.ok) return null;
    return (await res.json()) as Snapshot;
  } catch {
    return null;
  }
}

export async function loadDataset(progress: (msg: string) => void = () => {}): Promise<Dataset> {
  const snapshotP = loadSnapshot();
  let demo: DemoData | null = null;
  const getDemo = () => (demo ??= generateDemo());

  progress('Fetching market data…');

  const fredP = (async (): Promise<Dataset['fred']> => {
    try {
      const entries = await Promise.all(
        FRED_IDS.map(async (id) => [id, parseFredCsv(await fetchText(fredUrl(id)))] as const),
      );
      return { points: Object.fromEntries(entries) as Record<FredId, Point[]>, source: 'live' };
    } catch (e) {
      console.info('[data] live FRED unavailable:', (e as Error).message);
    }
    const snap = await snapshotP;
    try {
      if (snap) {
        const points = Object.fromEntries(
          FRED_IDS.map((id) => {
            const csv = snap.fred[id];
            if (!csv) throw new Error(`snapshot missing ${id}`);
            return [id, parseFredCsv(csv)];
          }),
        ) as Record<FredId, Point[]>;
        return { points, source: 'snapshot' };
      }
    } catch (e) {
      console.info('[data] snapshot FRED unusable:', (e as Error).message);
    }
    return { points: getDemo().fred, source: 'demo' };
  })();

  const yahooP = Promise.all(
    (Object.keys(YAHOO_TICKERS) as YahooSymbol[]).map(async (sym): Promise<[YahooSymbol, BarSeries]> => {
      try {
        const json = JSON.parse(await fetchText(yahooUrl(YAHOO_TICKERS[sym])));
        return [sym, { bars: parseYahooChart(json), source: 'live' }];
      } catch (e) {
        console.info(`[data] live ${sym} unavailable:`, (e as Error).message);
      }
      const snap = await snapshotP;
      try {
        if (snap?.yahoo[sym]) return [sym, { bars: parseYahooChart(snap.yahoo[sym]), source: 'snapshot' }];
      } catch (e) {
        console.info(`[data] snapshot ${sym} unusable:`, (e as Error).message);
      }
      return [sym, { bars: getDemo().bars[sym], source: 'demo' }];
    }),
  );

  const [fred, yahoo, snap] = await Promise.all([fredP, yahooP, snapshotP]);
  return {
    fred,
    bars: Object.fromEntries(yahoo) as Record<YahooSymbol, BarSeries>,
    snapshotAt: snap?.fetchedAt,
  };
}
