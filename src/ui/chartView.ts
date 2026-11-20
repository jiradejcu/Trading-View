import {
  AreaSeries, BarSeries, CandlestickSeries, ColorType, CrosshairMode, HistogramSeries, LineSeries, LineStyle,
  PriceScaleMode, createChart, createSeriesMarkers,
  type IChartApi, type IPriceLine, type ISeriesApi, type MouseEventParams, type SeriesMarker, type SeriesType,
  type Time, type UTCTimestamp,
} from 'lightweight-charts';
import { C } from './theme';
import { YEAR } from '../lib/time';

export type SeriesKind = 'candle' | 'bar' | 'line' | 'area' | 'histogram';

export interface SeriesSpec {
  id: string;
  kind: SeriesKind;
  title: string;
  /** {time,value} for line/area/histogram, OHLC for candle/bar. */
  data: Array<{ time: number; value?: number; open?: number; high?: number; low?: number; close?: number; color?: string }>;
  color?: string;
  lineWidth?: 1 | 2 | 3 | 4;
  dashed?: boolean;
  pane?: number;
  priceScaleId?: string;
  /** The series drawings and the header price attach to. Exactly one per chart. */
  main?: boolean;
  /** Hide from legend (e.g. volume). */
  hideInLegend?: boolean;
  precision?: number;
  lastValueVisible?: boolean;
  markers?: { time: number; text: string }[];
}

export interface ChartSpec {
  /** Changing key resets the visible range; same key keeps it (e.g. while dragging a lag slider). */
  key: string;
  series: SeriesSpec[];
  scaleMode?: 'normal' | 'log' | 'percent';
  defaultYears?: number | 'all';
  /** Pane size relative to the main pane (which is 1). */
  paneStretch?: Record<number, number>;
  scaleMargins?: Record<string, { top: number; bottom: number }>;
  horzLines?: { pane: number; value: number }[];
  /** Extra panes whose right scale is logarithmic. */
  logPanes?: number[];
}

export type Drawing =
  | { type: 'trend'; a: { t: number; p: number }; b: { t: number; p: number } }
  | { type: 'hline'; p: number };

export type Tool = 'cursor' | 'trend' | 'hline';

const ctor = { candle: CandlestickSeries, bar: BarSeries, line: LineSeries, area: AreaSeries, histogram: HistogramSeries };

const fmt = (v: number, precision = 2) =>
  Math.abs(v) >= 1e6 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : v.toLocaleString(undefined, {
    minimumFractionDigits: precision, maximumFractionDigits: precision,
  });

export class ChartView {
  private chart: IChartApi | null = null;
  private apis: { spec: SeriesSpec; api: ISeriesApi<SeriesType> }[] = [];
  private main: { spec: SeriesSpec; api: ISeriesApi<SeriesType> } | null = null;
  private key = '';
  private times: number[] = [];
  private canvas: HTMLCanvasElement;
  private priceLines: IPriceLine[] = [];
  private pending: { t: number; p: number } | null = null;
  private hover: { t: number; p: number } | null = null;
  private raf = 0;

  tool: Tool = 'cursor';
  drawings: Drawing[] = [];
  onDrawingsChange: (d: Drawing[]) => void = () => {};
  onToolDone: () => void = () => {};

  constructor(private el: HTMLElement, private legendEl: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'draw-layer';
    el.appendChild(this.canvas);
    // Handle drawing clicks ourselves: the chart's click event swallows fast second clicks as a double-click.
    el.addEventListener('click', (e) => this.onClick(e));
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.pending) { this.pending = null; this.requestDraw(); }
    });
  }

  render(spec: ChartSpec) {
    const keepRange = spec.key === this.key && this.chart ? this.chart.timeScale().getVisibleRange() : null;
    this.key = spec.key;
    this.chart?.remove();
    this.apis = [];
    this.priceLines = [];
    this.pending = null;

    const chart = createChart(this.el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: C.bg },
        textColor: C.text,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Trebuchet MS", Roboto, Ubuntu, sans-serif',
        panes: { separatorColor: C.border, separatorHoverColor: C.panel },
      },
      grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: C.border },
      leftPriceScale: { borderColor: C.border, visible: false },
      timeScale: { borderColor: C.border, rightOffset: 6 },
    });
    this.chart = chart;
    this.el.appendChild(this.canvas); // keep overlay above the chart's own canvases

    for (const s of spec.series) {
      const opts: Record<string, unknown> = {
        title: '',
        priceLineVisible: !!s.main,
        lastValueVisible: s.lastValueVisible ?? true,
        priceScaleId: s.priceScaleId ?? 'right',
        priceFormat: { type: 'price', precision: s.precision ?? 2, minMove: 10 ** -(s.precision ?? 2) },
      };
      if (s.kind === 'candle') Object.assign(opts, {
        upColor: C.up, downColor: C.down, borderVisible: false, wickUpColor: C.up, wickDownColor: C.down,
      });
      if (s.kind === 'bar') Object.assign(opts, { upColor: C.up, downColor: C.down });
      if (s.kind === 'line') Object.assign(opts, {
        color: s.color, lineWidth: s.lineWidth ?? 2, lineStyle: s.dashed ? LineStyle.Dashed : LineStyle.Solid,
        crosshairMarkerRadius: 4,
      });
      if (s.kind === 'area') Object.assign(opts, {
        lineColor: s.color, topColor: `${s.color}55`, bottomColor: `${s.color}05`, lineWidth: s.lineWidth ?? 2,
      });
      if (s.kind === 'histogram') Object.assign(opts, { color: s.color, priceFormat: s.precision === 0 ? { type: 'volume' } : opts.priceFormat });

      const api = chart.addSeries(ctor[s.kind] as never, opts, s.pane ?? 0) as ISeriesApi<SeriesType>;
      api.setData(s.data as never);
      if (s.markers?.length) {
        createSeriesMarkers(api, s.markers.map((m): SeriesMarker<Time> => ({
          time: m.time as UTCTimestamp, position: 'aboveBar', color: C.muted, shape: 'arrowDown', text: m.text,
        })));
      }
      const entry = { spec: s, api };
      this.apis.push(entry);
      if (s.main) this.main = entry;
    }
    if (!this.main && this.apis.length) this.main = this.apis[0];

    const mode = spec.scaleMode === 'log' ? PriceScaleMode.Logarithmic
      : spec.scaleMode === 'percent' ? PriceScaleMode.Percentage : PriceScaleMode.Normal;
    chart.priceScale('right', 0).applyOptions({ mode });
    for (const p of spec.logPanes ?? []) chart.priceScale('right', p).applyOptions({ mode: PriceScaleMode.Logarithmic });
    for (const { spec: s, api } of this.apis) {
      const m = s.priceScaleId && spec.scaleMargins?.[s.priceScaleId];
      if (m) api.priceScale().applyOptions({ scaleMargins: m });
    }
    for (const h of spec.horzLines ?? []) {
      const s = this.apis.find((a) => (a.spec.pane ?? 0) === h.pane);
      s?.api.createPriceLine({ price: h.value, color: C.muted, lineStyle: LineStyle.Dotted, lineWidth: 1, axisLabelVisible: false });
    }
    const panes = chart.panes();
    for (const [idx, f] of Object.entries(spec.paneStretch ?? {})) panes[+idx]?.setStretchFactor(f);

    this.times = [...new Set(spec.series.flatMap((s) => s.data.map((d) => d.time)))].sort((a, b) => a - b);

    if (keepRange) chart.timeScale().setVisibleRange(keepRange);
    else this.setRangeYears(spec.defaultYears ?? 1);

    chart.subscribeCrosshairMove((p) => this.onCrosshair(p));
    this.renderLegend(null);
    this.syncPriceLines();
    this.requestDraw();
  }

  setRangeYears(years: number | 'all') {
    if (!this.chart || !this.main) return;
    const data = this.main.spec.data;
    if (years === 'all' || !data.length) { this.chart.timeScale().fitContent(); return; }
    const end = this.times[this.times.length - 1];
    const lastMain = data[data.length - 1].time;
    this.chart.timeScale().setVisibleRange({
      from: (lastMain - years * YEAR) as UTCTimestamp,
      to: Math.max(end, lastMain) as UTCTimestamp,
    });
  }

  lastMainValue(): { value: number; prev: number } | null {
    const d = this.main?.spec.data;
    if (!d?.length) return null;
    const v = (x: (typeof d)[number]) => x.close ?? x.value ?? NaN;
    return { value: v(d[d.length - 1]), prev: d.length > 1 ? v(d[d.length - 2]) : v(d[d.length - 1]) };
  }

  // ---- Legend ---------------------------------------------------------------

  private onCrosshair(p: MouseEventParams) {
    this.renderLegend(p.time ? p : null);
    if (this.tool !== 'cursor' && p.point && p.logical != null && this.main) {
      const price = this.main.api.coordinateToPrice(p.point.y);
      this.hover = price == null ? null : { t: this.logicalToTime(p.logical), p: price };
    } else this.hover = null;
    this.requestDraw();
  }

  private renderLegend(p: MouseEventParams | null) {
    const rows: string[] = [];
    for (const { spec, api } of this.apis) {
      if (spec.hideInLegend) continue;
      let d: Record<string, number> | undefined = p ? (p.seriesData.get(api) as Record<string, number> | undefined) : undefined;
      if (!p) d = spec.data[spec.data.length - 1] as unknown as Record<string, number> | undefined;
      const prec = spec.precision ?? 2;
      const sw = `<i class="sw" style="background:${spec.kind === 'candle' || spec.kind === 'bar' ? C.up : spec.color}"></i>`;
      let val = '<span class="muted">–</span>';
      if (d && d.close !== undefined) {
        const cls = d.close >= d.open ? 'up' : 'down';
        val = ['O', 'H', 'L', 'C'].map((k, i) =>
          `<span class="muted">${k}</span><span class="${cls}">${fmt([d!.open, d!.high, d!.low, d!.close][i], prec)}</span>`).join(' ');
      } else if (d && d.value !== undefined) val = `<span>${fmt(d.value, prec)}</span>`;
      rows.push(`<div class="lg-row${spec.main ? ' lg-main' : ''}">${sw}<span class="lg-title">${spec.title}</span> ${val}</div>`);
    }
    this.legendEl.innerHTML = rows.join('');
  }

  // ---- Drawings -------------------------------------------------------------

  setDrawings(d: Drawing[]) {
    this.drawings = d;
    this.syncPriceLines();
    this.requestDraw();
  }

  setTool(t: Tool) {
    this.tool = t;
    this.pending = null;
    this.el.classList.toggle('drawing', t !== 'cursor');
    this.requestDraw();
  }

  private onClick(e: MouseEvent) {
    if (this.tool === 'cursor' || !this.chart || !this.main) return;
    const rect = this.el.getBoundingClientRect();
    const xOff = this.chart.priceScale('left').width();
    const x = e.clientX - rect.left - xOff, y = e.clientY - rect.top;
    const paneH = this.chart.panes()[0]?.getHeight() ?? rect.height;
    if (x < 0 || x > this.chart.timeScale().width() || y > paneH) return;
    const logical = this.chart.timeScale().coordinateToLogical(x);
    const price = this.main.api.coordinateToPrice(y);
    if (logical == null || price == null) return;
    const pt = { t: this.logicalToTime(logical), p: price };
    if (this.tool === 'hline') {
      this.commit({ type: 'hline', p: price });
    } else if (!this.pending) {
      this.pending = pt;
    } else {
      this.commit({ type: 'trend', a: this.pending, b: pt });
      this.pending = null;
    }
    this.requestDraw();
  }

  private commit(d: Drawing) {
    this.drawings = [...this.drawings, d];
    this.onDrawingsChange(this.drawings);
    this.syncPriceLines();
    this.onToolDone();
  }

  private syncPriceLines() {
    if (!this.main) return;
    for (const pl of this.priceLines) this.main.api.removePriceLine(pl);
    this.priceLines = this.drawings
      .filter((d): d is Extract<Drawing, { type: 'hline' }> => d.type === 'hline')
      .map((d) => this.main!.api.createPriceLine({ price: d.p, color: C.draw, lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true }));
  }

  /** Fractional bar index -> time, interpolating between (and extrapolating past) known bars. */
  private logicalToTime(l: number): number {
    const t = this.times;
    if (t.length < 2) return t[0] ?? 0;
    const i = Math.floor(l);
    if (i < 0) return t[0] + l * (t[1] - t[0]);
    if (i >= t.length - 1) return t[t.length - 1] + (l - (t.length - 1)) * (t[t.length - 1] - t[t.length - 2]);
    return t[i] + (l - i) * (t[i + 1] - t[i]);
  }

  private timeToLogical(time: number): number {
    const t = this.times;
    if (t.length < 2) return 0;
    if (time <= t[0]) return (time - t[0]) / (t[1] - t[0]);
    const n = t.length - 1;
    if (time >= t[n]) return n + (time - t[n]) / (t[n] - t[n - 1]);
    let lo = 0, hi = n;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t[mid] <= time) lo = mid; else hi = mid; }
    return lo + (time - t[lo]) / (t[hi] - t[lo]);
  }

  private requestDraw() {
    if (!this.raf) this.raf = requestAnimationFrame(() => this.drawLoop());
  }

  /** Redraw every frame while trend lines exist (price-scale drags emit no events). */
  private drawLoop() {
    this.raf = 0;
    this.draw();
    if (this.drawings.some((d) => d.type === 'trend') || this.pending) this.requestDraw();
  }

  private draw() {
    const cv = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (cv.width !== w * dpr || cv.height !== h * dpr) {
      cv.width = w * dpr; cv.height = h * dpr; cv.style.width = `${w}px`; cv.style.height = `${h}px`;
    }
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!this.chart || !this.main) return;
    const ts = this.chart.timeScale();
    const xOff = this.chart.priceScale('left').width();
    const paneH = this.chart.panes()[0]?.getHeight() ?? h;
    const toXY = (pt: { t: number; p: number }) => {
      const x = ts.logicalToCoordinate(this.timeToLogical(pt.t) as never);
      const y = this.main!.api.priceToCoordinate(pt.p);
      return x == null || y == null ? null : [x + xOff, y] as const;
    };
    ctx.save();
    ctx.beginPath();
    ctx.rect(xOff, 0, ts.width(), paneH);
    ctx.clip();
    ctx.lineWidth = 2;
    ctx.strokeStyle = C.draw;
    ctx.fillStyle = C.draw;
    const segs = this.drawings.filter((d) => d.type === 'trend').map((d) => [d.a, d.b] as const);
    if (this.pending && this.hover) segs.push([this.pending, this.hover]);
    for (const [a, b] of segs) {
      const A = toXY(a), B = toXY(b);
      if (!A || !B) continue;
      ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.lineTo(B[0], B[1]); ctx.stroke();
      for (const P of [A, B]) { ctx.beginPath(); ctx.arc(P[0], P[1], 3.5, 0, Math.PI * 2); ctx.fill(); }
    }
    if (this.pending) {
      const A = toXY(this.pending);
      if (A) { ctx.beginPath(); ctx.arc(A[0], A[1], 4, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.restore();
  }
}
