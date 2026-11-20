import type { Bar, Point } from '../lib/types';
import { DAY, YEAR, dayStart, parseISODate } from '../lib/time';
import type { FredId, YahooSymbol } from './sources';

/**
 * Deterministic SYNTHETIC data, used only when neither the live proxy nor a snapshot is
 * available. It is shaped to look plausible (same units as the real FRED/Yahoo series) and
 * has a built-in liquidity -> BTC lead so the lag tools have something to find. It is not
 * market data and the UI labels it as demo data everywhere it appears.
 */
export interface DemoData {
  bars: Record<YahooSymbol, Bar[]>;
  fred: Record<FredId, Point[]>;
}

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateDemo(nowSec = Math.floor(Date.now() / 1000)): DemoData {
  const rand = mulberry32(20241120);
  const gauss = () => {
    const u = Math.max(rand(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  };
  /** Ornstein-Uhlenbeck path with stationary sd `sd` and mean-reversion time `tau` days. */
  const ou = (n: number, sd: number, tau: number) => {
    const th = 1 / tau;
    const out = new Float64Array(n);
    let x = 0;
    for (let i = 0; i < n; i++) {
      x = x * (1 - th) + sd * Math.sqrt(2 * th) * gauss();
      out[i] = x;
    }
    return out;
  };

  const start = parseISODate('2012-01-02');
  const end = dayStart(nowSec) - DAY;
  const n = Math.floor((end - start) / DAY) + 1;
  const time = (i: number) => start + i * DAY;
  const yrs = (i: number) => (i * DAY) / YEAR;
  const dow = (i: number) => (Math.floor(time(i) / DAY) + 4) % 7; // 0 = Sunday
  const isBiz = (i: number) => dow(i) !== 0 && dow(i) !== 6;

  // Latent liquidity cycle.
  const noiseF = ou(n, 0.3, 90);
  const F = Float64Array.from({ length: n }, (_, i) =>
    0.8 * Math.sin((2 * Math.PI * yrs(i)) / 3.7 + 0.6) + 0.4 * Math.sin((2 * Math.PI * yrs(i)) / 1.4 + 1.3) + noiseF[i],
  );
  const lagF = (i: number, days: number) => F[Math.max(0, i - days)];

  const fred: Record<FredId, Point[]> = {
    WALCL: [], WTREGEN: [], RRPONTSYD: [], ECBASSETSW: [], JPNASSETS: [], DEXUSEU: [], DEXJPUS: [],
  };
  const fx1 = ou(n, 0.03, 120), fx2 = ou(n, 6, 200), tgaN = ou(n, 6e4, 30);
  for (let i = 0; i < n; i++) {
    const t = time(i), y = yrs(i);
    if (dow(i) === 3) {
      fred.WALCL.push({ time: t, value: 2.9e6 * Math.exp(0.06 * y) * (1 + 0.07 * F[i]) });
      fred.WTREGEN.push({
        time: t,
        value: Math.max(5e4, (y < 8 ? 0.6 : 1.3) * (3e5 + 2e5 * Math.sin((2 * Math.PI * y) / 2.1)) + tgaN[i]),
      });
    }
    if (dow(i) === 5) fred.ECBASSETSW.push({ time: t, value: 2.7e6 * Math.exp(0.05 * y) * (1 + 0.06 * F[i]) });
    if (new Date(t * 1000).getUTCDate() === 1) {
      fred.JPNASSETS.push({ time: t, value: 1.6e6 * Math.exp(0.11 * y) * (1 + 0.03 * F[i]) });
    }
    if (isBiz(i)) {
      const rrp = y < 1.7 ? 0 : 2200 * Math.exp(-(((y - 10.4) / 1.3) ** 2)) + 60 * Math.abs(gauss());
      fred.RRPONTSYD.push({ time: t, value: rrp });
      fred.DEXUSEU.push({ time: t, value: 1.15 + 0.08 * Math.sin((2 * Math.PI * y) / 5) + 0.02 * F[i] + fx1[i] });
      fred.DEXJPUS.push({ time: t, value: 112 + 22 * Math.sin((2 * Math.PI * (y - 2)) / 9) + fx2[i] });
    }
  }

  const mkBars = (logClose: (i: number) => number | null, filter: (i: number) => boolean, rangePct: number, vol: number) => {
    const out: Bar[] = [];
    let prev: number | null = null;
    for (let i = 0; i < n; i++) {
      if (!filter(i)) continue;
      const lc = logClose(i);
      if (lc == null) continue;
      const close = Math.exp(lc);
      const open = prev ?? close;
      out.push({
        time: time(i),
        open,
        close,
        high: Math.max(open, close) * (1 + Math.abs(gauss()) * rangePct),
        low: Math.min(open, close) * (1 - Math.abs(gauss()) * rangePct),
        volume: vol ? vol * (0.5 + rand()) : undefined,
      });
      prev = close;
    }
    return out;
  };

  const btcStart = Math.floor((parseISODate('2014-09-17') - start) / DAY);
  const ethStart = Math.floor((parseISODate('2017-11-09') - start) / DAY);
  const btcN = ou(n, 0.3, 45), btcJ = ou(n, 0.03, 2), ethN = ou(n, 0.2, 40);
  const moveN = ou(n, 0.18, 25), spxN = ou(n, 0.07, 60), vixN = ou(n, 0.22, 15), dxyN = ou(n, 2.5, 120);
  const btcLog = (i: number) =>
    i < btcStart ? null : Math.log(450) + 0.42 * (yrs(i) - yrs(btcStart)) + 0.9 * lagF(i, 70) + btcN[i] + btcJ[i];

  const bars: Record<YahooSymbol, Bar[]> = {
    BTCUSD: mkBars(btcLog, () => true, 0.015, 2.5e10),
    ETHUSD: mkBars((i) => (i < ethStart ? null : (btcLog(i) as number) - Math.log(17) + 0.15 * F[i] + ethN[i]), () => true, 0.02, 1.2e10),
    SPX: mkBars((i) => Math.log(1300) + 0.1 * yrs(i) + 0.12 * lagF(i, 30) + spxN[i], isBiz, 0.006, 3.5e9),
    MOVE: mkBars((i) => Math.log(85) - 0.35 * F[i] + moveN[i], isBiz, 0.02, 0),
    VIX: mkBars((i) => Math.log(17) - 0.25 * F[i] + vixN[i], isBiz, 0.04, 0),
    DXY: mkBars((i) => Math.log(92 + 6 * Math.sin((2 * Math.PI * yrs(i)) / 6) - 2 * F[i] + dxyN[i]), isBiz, 0.003, 0),
  };
  return { bars, fred };
}
