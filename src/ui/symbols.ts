import type { Bar, Point, SourceKind, Timeframe } from '../lib/types';
import { bollinger, closes, ema, resampleBars, resamplePoints, rollingCorrelation, rsi, sma } from '../lib/series';
import type { Dataset } from '../data/store';
import type { YahooSymbol } from '../data/sources';
import {
  NORM_LABEL, buildLagModel, computeGLI, inverseMoveBars, prepareLagInputs,
  type GliResult, type LagInputs, type LagModel, type LagParams,
} from '../custom/liquidity';
import type { ChartSpec, SeriesSpec } from './chartView';
import { C } from './theme';

export type SymbolKind = 'ohlc' | 'line' | 'model';

export interface SymbolDef {
  id: string;
  name: string;
  desc: string;
  exchange: string;
  kind: SymbolKind;
  precision: number;
  custom?: boolean;
}

export const SYMBOLS: SymbolDef[] = [
  { id: 'LAGMODEL', name: 'LIQ·MOVE→BTC', desc: 'Custom: inverse MOVE + global liquidity vs lagged Bitcoin', exchange: 'CUSTOM', kind: 'model', precision: 2, custom: true },
  { id: 'GLI', name: 'GLI', desc: 'Custom: Global liquidity index (Fed net + ECB + BOJ), USD trillions', exchange: 'CUSTOM', kind: 'line', precision: 2, custom: true },
  { id: 'INVMOVE', name: 'INVMOVE', desc: 'Custom: Inverse ICE BofA MOVE index (100 / MOVE)', exchange: 'CUSTOM', kind: 'ohlc', precision: 3, custom: true },
  { id: 'BTCUSD', name: 'BTCUSD', desc: 'Bitcoin / U.S. Dollar', exchange: 'CRYPTO', kind: 'ohlc', precision: 0 },
  { id: 'ETHUSD', name: 'ETHUSD', desc: 'Ethereum / U.S. Dollar', exchange: 'CRYPTO', kind: 'ohlc', precision: 2 },
  { id: 'SPX', name: 'SPX', desc: 'S&P 500 Index', exchange: 'INDEX', kind: 'ohlc', precision: 2 },
  { id: 'MOVE', name: 'MOVE', desc: 'ICE BofA MOVE Index (Treasury implied vol)', exchange: 'INDEX', kind: 'ohlc', precision: 2 },
  { id: 'VIX', name: 'VIX', desc: 'CBOE Volatility Index', exchange: 'INDEX', kind: 'ohlc', precision: 2 },
  { id: 'DXY', name: 'DXY', desc: 'U.S. Dollar Index', exchange: 'INDEX', kind: 'ohlc', precision: 3 },
];

export const symbolDef = (id: string) => SYMBOLS.find((s) => s.id === id) ?? SYMBOLS[0];

export type ChartType = 'candle' | 'bar' | 'line' | 'area';
export type IndicatorId = 'vol' | 'sma20' | 'sma50' | 'ema200' | 'bb' | 'rsi';

export const INDICATORS: { id: IndicatorId; name: string }[] = [
  { id: 'vol', name: 'Volume' },
  { id: 'sma20', name: 'SMA 20' },
  { id: 'sma50', name: 'SMA 50' },
  { id: 'ema200', name: 'EMA 200' },
  { id: 'bb', name: 'Bollinger Bands (20, 2)' },
  { id: 'rsi', name: 'RSI 14' },
];

export interface ViewState {
  symbol: string;
  tf: Timeframe;
  chartType: ChartType;
  scale: 'normal' | 'log' | 'percent';
  indicators: IndicatorId[];
  compare: string | null;
  lag: LagParams;
  btcAsPrice: boolean;
  showComponents: boolean;
  /** Lag model: show all indicator lines instead of only the two best-correlated. */
  showAllLines: boolean;
}

const rank: Record<SourceKind, number> = { live: 0, snapshot: 1, demo: 2 };
const worst = (...s: SourceKind[]) => s.reduce((a, b) => (rank[b] > rank[a] ? b : a));

/** All symbols resolved to plain data, including the custom ones. */
export class Universe {
  readonly gli: GliResult;
  readonly lagInputs: LagInputs;
  private cache = new Map<string, LagModel>();

  constructor(readonly ds: Dataset) {
    this.gli = computeGLI(ds.fred.points);
    this.lagInputs = prepareLagInputs(this.gli.total, ds.bars.MOVE.bars, ds.bars.BTCUSD.bars);
  }

  source(id: string): SourceKind {
    if (id === 'GLI') return this.ds.fred.source;
    if (id === 'INVMOVE') return this.ds.bars.MOVE.source;
    if (id === 'LAGMODEL') return worst(this.ds.fred.source, this.ds.bars.MOVE.source, this.ds.bars.BTCUSD.source);
    return this.ds.bars[id as YahooSymbol]?.source ?? 'demo';
  }

  bars(id: string): Bar[] | null {
    if (id === 'INVMOVE') return inverseMoveBars(this.ds.bars.MOVE.bars);
    return this.ds.bars[id as YahooSymbol]?.bars ?? null;
  }

  /** Daily close-like series for any non-model symbol. */
  points(id: string): Point[] {
    if (id === 'GLI') return this.gli.total;
    const b = this.bars(id);
    return b ? closes(b) : [];
  }

  model(p: LagParams): LagModel {
    const k = JSON.stringify(p);
    let m = this.cache.get(k);
    if (!m) {
      m = buildLagModel(this.lagInputs, p);
      if (this.cache.size > 200) this.cache.clear();
      this.cache.set(k, m);
    }
    return m;
  }
}

const pts = (p: Point[]) => p.map((x) => ({ time: x.time, value: x.value }));

function indicatorSeries(close: Point[], st: ViewState, precision: number): SeriesSpec[] {
  const out: SeriesSpec[] = [];
  const on = (id: IndicatorId) => st.indicators.includes(id);
  if (on('sma20')) out.push({ id: 'sma20', kind: 'line', title: 'SMA 20', data: pts(sma(close, 20)), color: C.s4, lineWidth: 1, precision, lastValueVisible: false });
  if (on('sma50')) out.push({ id: 'sma50', kind: 'line', title: 'SMA 50', data: pts(sma(close, 50)), color: C.s1, lineWidth: 1, precision, lastValueVisible: false });
  if (on('ema200')) out.push({ id: 'ema200', kind: 'line', title: 'EMA 200', data: pts(ema(close, 200)), color: C.s7, lineWidth: 2, precision, lastValueVisible: false });
  if (on('bb')) {
    const bb = bollinger(close);
    out.push(
      { id: 'bbu', kind: 'line', title: 'BB upper', data: pts(bb.upper), color: C.s3, lineWidth: 1, precision, lastValueVisible: false },
      { id: 'bbm', kind: 'line', title: 'BB basis', data: pts(bb.middle), color: C.s2, lineWidth: 1, dashed: true, precision, lastValueVisible: false },
      { id: 'bbl', kind: 'line', title: 'BB lower', data: pts(bb.lower), color: C.s3, lineWidth: 1, precision, lastValueVisible: false },
    );
  }
  if (on('rsi')) out.push({ id: 'rsi', kind: 'line', title: 'RSI 14', data: pts(rsi(close)), color: C.s7, lineWidth: 1, pane: 1, precision: 1 });
  return out;
}

export function buildSpec(u: Universe, st: ViewState): ChartSpec {
  const def = symbolDef(st.symbol);
  if (def.kind === 'model') return buildModelSpec(u, st);

  const series: SeriesSpec[] = [];
  const precision = def.precision;
  let close: Point[];
  if (def.kind === 'ohlc') {
    const bars = resampleBars(u.bars(def.id) ?? [], st.tf);
    close = closes(bars);
    const t = st.chartType;
    series.push(t === 'candle' || t === 'bar'
      ? { id: 'main', kind: t, title: def.name, data: bars, main: true, precision }
      : { id: 'main', kind: t, title: def.name, data: pts(close), color: C.s1, main: true, precision });
    if (st.indicators.includes('vol') && bars.some((b) => b.volume)) {
      series.push({
        id: 'vol', kind: 'histogram', title: 'Vol', priceScaleId: 'vol', hideInLegend: true, lastValueVisible: false, precision: 0,
        data: bars.map((b) => ({ time: b.time, value: b.volume ?? 0, color: b.close >= b.open ? `${C.up}66` : `${C.down}66` })),
      });
    }
  } else {
    close = resamplePoints(u.points(def.id), st.tf === 'D' ? 'W' : st.tf);
    series.push({ id: 'main', kind: 'area', title: `${def.name} (USD T)`, data: pts(close), color: C.s3, main: true, precision });
    if (def.id === 'GLI' && st.showComponents) {
      const tf = st.tf === 'M' ? 'M' : 'W';
      series.push(
        { id: 'fed', kind: 'line', title: 'Fed net liquidity', data: pts(resamplePoints(u.gli.fedNet, tf)), color: C.s1, lineWidth: 1, precision },
        { id: 'ecb', kind: 'line', title: 'ECB (USD)', data: pts(resamplePoints(u.gli.ecb, tf)), color: C.s2, lineWidth: 1, precision },
        { id: 'boj', kind: 'line', title: 'BOJ (USD)', data: pts(resamplePoints(u.gli.boj, tf)), color: C.s4, lineWidth: 1, precision },
      );
    }
  }
  series.push(...indicatorSeries(close, st, precision));

  if (st.compare && st.compare !== def.id) {
    const cdef = symbolDef(st.compare);
    let cmp = u.points(cdef.id);
    cmp = def.kind === 'line' || cdef.kind === 'line' ? resamplePoints(cmp, st.tf === 'M' ? 'M' : 'W') : resamplePoints(cmp, st.tf);
    series.push({ id: 'cmp', kind: 'line', title: cdef.name, data: pts(cmp), color: C.s2, lineWidth: 2, precision: cdef.precision });
  }

  return {
    key: `${def.id}|${st.tf}`,
    series,
    scaleMode: st.compare ? 'percent' : st.scale,
    defaultYears: def.kind === 'line' ? 5 : st.tf === 'D' ? 0.5 : st.tf === 'W' ? 2 : 10,
    paneStretch: st.indicators.includes('rsi') ? { 1: 0.25 } : undefined,
    scaleMargins: { vol: { top: 0.82, bottom: 0 } },
    horzLines: st.indicators.includes('rsi') ? [{ pane: 1, value: 70 }, { pane: 1, value: 30 }] : undefined,
  };
}

export interface ModelLine { id: string; name: string; title: string; r: number; data: Point[]; color: string }

/** The model's three indicator lines, best correlation with BTC first. */
export function rankModelLines(m: LagModel, lag: LagParams): ModelLine[] {
  const dyn = m.dynamic ? ' dynamic' : '';
  const lines: ModelLine[] = [
    { id: 'comp', name: 'Composite', title: `Composite (${Math.round(lag.wGli * 100)}% GLI +${m.gliLagNow}w / ${Math.round((1 - lag.wGli) * 100)}% inv MOVE +${m.moveLagNow}w${dyn})`,
      r: m.rComposite, data: m.composite, color: C.s2 },
    { id: 'gli', name: `Global liquidity +${m.gliLagNow}w`, title: `Global liquidity, +${m.gliLagNow}w${dyn}`, r: m.rGli, data: m.gliShifted, color: C.s3 },
    { id: 'move', name: `Inverse MOVE +${m.moveLagNow}w`, title: `Inverse MOVE, +${m.moveLagNow}w${dyn}`, r: m.rMove, data: m.moveShifted, color: C.s4 },
  ];
  const key = (r: number) => (Number.isFinite(r) ? r : -Infinity);
  return lines.sort((a, b) => key(b.r) - key(a.r));
}

function buildModelSpec(u: Universe, st: ViewState): ChartSpec {
  const m = u.model(st.lag);
  const series: SeriesSpec[] = [];

  // Pane 0: everything in the same z-units on one axis. BTC plus the two indicator
  // lines that correlate best with it (all three with "Show all lines").
  const shown = rankModelLines(m, st.lag).slice(0, st.showAllLines ? 3 : 2);
  const projWeeks = Math.max(0, ...shown.map((l) => l.data.filter((p) => p.time > m.lastBtcTime).length));
  shown.forEach((l, i) => series.push({
    id: l.id, kind: 'line', title: `${l.title} (r ${Number.isFinite(l.r) ? l.r.toFixed(2) : '–'})`,
    data: pts(l.data), color: l.color, lineWidth: i === 0 ? 3 : 2, main: i === 0, lastValueVisible: i === 0,
  }));
  series.push({ id: 'btcn', kind: 'line', title: 'BTC (same normalization)', data: pts(m.btcNorm), color: C.s1, lineWidth: 2 });

  // Optional pane: BTC price on its own log axis (never a second axis on the comparison pane).
  let corrPane = 1;
  if (st.btcAsPrice) {
    series.push({ id: 'btcp', kind: 'line', title: 'BTCUSD weekly', data: pts(m.btcWeekly), color: C.s1, lineWidth: 2, pane: 1, precision: 0 });
    corrPane = 2;
  }
  series.push({
    id: 'corr', kind: 'histogram', title: '6M rolling corr', pane: corrPane, precision: 2, color: C.up,
    data: (shown[0].id === 'comp' ? m.rollingCorr : rollingCorrelation(shown[0].data, m.btcNorm, 26)).map((p) => ({ time: p.time, value: p.value, color: p.value >= 0 ? `${C.up}aa` : `${C.down}aa` })),
  });

  return {
    key: `LAGMODEL|${st.lag.norm}|${st.btcAsPrice}|${!!st.lag.dynamic}`,
    series,
    scaleMode: 'normal',
    defaultYears: 3,
    forecast: projWeeks ? { from: m.lastBtcTime, weeks: projWeeks } : undefined,
    paneStretch: st.btcAsPrice ? { 1: 0.45, 2: 0.2 } : { 1: 0.2 },
    horzLines: [{ pane: 0, value: 0 }, { pane: corrPane, value: 0 }],
    logPanes: st.btcAsPrice ? [1] : [],
  };
}

export { NORM_LABEL };
