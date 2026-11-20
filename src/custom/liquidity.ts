import type { Bar, Point } from '../lib/types';
import { WEEK, weekStart } from '../lib/time';
import {
  bestLag, closes, crossCorrelation, ffillOnGrid, logPoints, pairOnTime, pearson, rollingCorrelation,
  rollingZ, shift, toWeekly, weeklyGrid, yoy, zscore, type LagCorr,
} from '../lib/series';
import type { FredId } from '../data/sources';

// ---- Global Liquidity Index -------------------------------------------------

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : NaN;
}

/**
 * FRED publishes some H.4.1 items in millions and others in billions. Anything whose median
 * is below 10,000 can't be a USD-millions balance-sheet item since 2012, so treat it as billions.
 */
export function toMillions(points: Point[]): Point[] {
  return median(points.map((p) => p.value)) < 1e4 ? points.map((p) => ({ time: p.time, value: p.value * 1000 })) : points;
}

export interface GliResult {
  /** Global liquidity in USD trillions, weekly (Monday-stamped). */
  total: Point[];
  fedNet: Point[];
  ecb: Point[];
  boj: Point[];
}

/**
 * GLI = Fed net liquidity (WALCL − TGA − RRP) + ECB assets × EURUSD + BOJ assets ÷ USDJPY.
 * Each input is reduced to its last value per week and forward-filled onto a weekly grid
 * (BOJ is monthly, FX and RRP daily). PBoC isn't on FRED, so it isn't included.
 */
export function computeGLI(fred: Record<FredId, Point[]>): GliResult {
  const wk = {
    fed: toWeekly(toMillions(fred.WALCL)),
    tga: toWeekly(toMillions(fred.WTREGEN)),
    rrp: toWeekly(toMillions(fred.RRPONTSYD)),
    ecb: toWeekly(fred.ECBASSETSW), // EUR millions
    boj: toWeekly(fred.JPNASSETS), // JPY 100 millions
    eurusd: toWeekly(fred.DEXUSEU),
    usdjpy: toWeekly(fred.DEXJPUS),
  };
  const lists = Object.values(wk);
  if (lists.some((l) => !l.length)) return { total: [], fedNet: [], ecb: [], boj: [] };
  const start = Math.max(...lists.map((l) => l[0].time));
  const end = wk.fed[wk.fed.length - 1].time;
  const grid = weeklyGrid(start, end);
  const f = Object.fromEntries(Object.entries(wk).map(([k, v]) => [k, ffillOnGrid(v, grid)])) as Record<
    keyof typeof wk,
    (number | undefined)[]
  >;

  const res: GliResult = { total: [], fedNet: [], ecb: [], boj: [] };
  grid.forEach((time, i) => {
    const vals = [f.fed[i], f.tga[i], f.rrp[i], f.ecb[i], f.boj[i], f.eurusd[i], f.usdjpy[i]];
    if (vals.some((v) => v === undefined)) return;
    const [fed, tga, rrp, ecb, boj, eurusd, usdjpy] = vals as number[];
    const fedNet = (fed - tga - rrp) / 1e6;
    const ecbUsd = (ecb * eurusd) / 1e6;
    const bojUsd = (boj * 1e8) / usdjpy / 1e12;
    res.fedNet.push({ time, value: fedNet });
    res.ecb.push({ time, value: ecbUsd });
    res.boj.push({ time, value: bojUsd });
    res.total.push({ time, value: fedNet + ecbUsd + bojUsd });
  });
  return res;
}

/** Inverse MOVE (100 / MOVE) as daily bars: low bond volatility → high value. */
export function inverseMoveBars(move: Bar[]): Bar[] {
  return move
    .filter((b) => b.close > 0 && b.low > 0)
    .map((b) => ({ time: b.time, open: 100 / b.open, high: 100 / b.low, low: 100 / b.high, close: 100 / b.close }));
}

// ---- Lag model --------------------------------------------------------------

export type Norm = 'z' | 'rollz' | 'yoy';

export const NORM_LABEL: Record<Norm, string> = {
  rollz: 'Rolling 2-year z-score of log level',
  z: 'Full-sample z-score of log level',
  yoy: 'Z-score of year-over-year % change',
};

export const ROLL_WINDOW_WEEKS = 104;
export const MAX_LAG_WEEKS = 52;

/** Put a weekly series in comparable z-units (log level for positive series). */
export function normalize(weekly: Point[], norm: Norm): Point[] {
  switch (norm) {
    case 'z': return zscore(logPoints(weekly));
    case 'rollz': return rollingZ(logPoints(weekly), ROLL_WINDOW_WEEKS);
    case 'yoy': return zscore(yoy(weekly));
  }
}

export interface LagParams {
  /** Weeks the liquidity index is shifted forward (it leads BTC). */
  lagGli: number;
  /** Weeks inverse MOVE is shifted forward. */
  lagMove: number;
  /** Weight of GLI in the composite, 0..1 (inverse MOVE gets the rest). */
  wGli: number;
  norm: Norm;
}

export interface LagModel {
  gliShifted: Point[];
  moveShifted: Point[];
  composite: Point[];
  btcNorm: Point[];
  btcWeekly: Point[];
  rollingCorr: Point[];
  xcGli: LagCorr[];
  xcMove: LagCorr[];
  bestGli: LagCorr;
  bestMove: LagCorr;
  rComposite: number;
  nComposite: number;
  /** Last week with a BTC close; composite points after this are a projection. */
  lastBtcTime: number;
}

export interface LagInputs {
  gliWeekly: Point[];
  invMoveWeekly: Point[];
  btcWeekly: Point[];
}

export function prepareLagInputs(gli: Point[], move: Bar[], btc: Bar[]): LagInputs {
  return {
    gliWeekly: gli,
    invMoveWeekly: toWeekly(move.filter((b) => b.close > 0).map((b) => ({ time: b.time, value: 100 / b.close }))),
    btcWeekly: toWeekly(closes(btc)),
  };
}

export function buildLagModel(inp: LagInputs, p: LagParams): LagModel {
  const gliN = normalize(inp.gliWeekly, p.norm);
  const moveN = normalize(inp.invMoveWeekly, p.norm);
  const btcNorm = normalize(inp.btcWeekly, p.norm);

  const gliShifted = shift(gliN, p.lagGli * WEEK);
  const moveShifted = shift(moveN, p.lagMove * WEEK);

  const moveMap = new Map(moveShifted.map((pt) => [pt.time, pt.value]));
  const composite: Point[] = [];
  for (const g of gliShifted) {
    const m = moveMap.get(g.time);
    if (m !== undefined) composite.push({ time: g.time, value: p.wGli * g.value + (1 - p.wGli) * m });
  }

  const xcGli = crossCorrelation(gliN, btcNorm, MAX_LAG_WEEKS);
  const xcMove = crossCorrelation(moveN, btcNorm, MAX_LAG_WEEKS);
  const { a, b } = pairOnTime(composite, btcNorm);

  return {
    gliShifted,
    moveShifted,
    composite,
    btcNorm,
    btcWeekly: inp.btcWeekly,
    rollingCorr: rollingCorrelation(composite, btcNorm, 26),
    xcGli,
    xcMove,
    bestGli: bestLag(xcGli),
    bestMove: bestLag(xcMove),
    rComposite: pearson(a, b),
    nComposite: a.length,
    lastBtcTime: inp.btcWeekly.length ? weekStart(inp.btcWeekly[inp.btcWeekly.length - 1].time) : 0,
  };
}
