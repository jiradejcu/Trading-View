import { DEFAULT_BOT, type BacktestResult, type BotParams, type Trade } from '../bot/bottomBot';
import type { BotInterval } from '../data/binance';
import { C } from './theme';
import type { ChartSpec, SeriesSpec } from './chartView';
import type { Bar } from '../lib/types';
import { fmtDate } from '../lib/time';

export interface BotSettings extends BotParams { interval: BotInterval; years: number }

export const DEFAULT_BOT_SETTINGS: BotSettings = { ...DEFAULT_BOT, interval: '4h', years: 2 };

const YEARS: Record<BotInterval, number[]> = { '1h': [0.5, 1, 2], '4h': [1, 2, 3, 5], '1d': [2, 3, 5, 6] };

type NumKey = 'left' | 'right' | 'slBufferPct' | 'tpR' | 'trendEma' | 'riskPct' | 'maxLeverage' | 'feePct';
const NUMS: { key: NumKey; label: string; min: number; max: number; step: number; title: string }[] = [
  { key: 'left', label: 'Bottom: bars left', min: 1, max: 100, step: 1, title: 'The bottom must be lower than this many bars before it' },
  { key: 'right', label: 'Bottom: bars right', min: 1, max: 50, step: 1, title: 'This many bars must close without a lower low. This is also how late the entry is.' },
  { key: 'slBufferPct', label: 'Stop below bottom %', min: 0, max: 20, step: 0.1, title: 'Stop-loss distance under the bottom\'s low' },
  { key: 'tpR', label: 'Take profit (R)', min: 0, max: 20, step: 0.5, title: 'Target at this multiple of the initial risk. 0 = no target (exit only by stop).' },
  { key: 'riskPct', label: 'Risk per trade %', min: 0.1, max: 20, step: 0.1, title: 'Equity lost if the initial stop is hit' },
  { key: 'maxLeverage', label: 'Max leverage', min: 1, max: 125, step: 1, title: 'Caps position size when the stop is very close' },
  { key: 'feePct', label: 'Fee per side %', min: 0, max: 1, step: 0.01, title: 'Binance COIN-M taker fee is 0.05% (VIP 0)' },
  { key: 'trendEma', label: 'Trend filter EMA', min: 0, max: 500, step: 10, title: 'Only buy bottoms while price closes above this EMA. 0 = off.' },
];

const f2 = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '–');
const pct = (v: number) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(1)}%` : '–');
const cls = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const fmtPrice = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 1 });
const fmtWhen = (t: number, iv: BotInterval) => (iv === '1d' ? fmtDate(t) : `${fmtDate(t)} ${new Date(t * 1000).toISOString().slice(11, 16)}`);

export class BotPanel {
  private st!: BotSettings;
  onFocusTrade: (t: Trade) => void = () => {};

  constructor(private el: HTMLElement, private onChange: (s: BotSettings) => void) {}

  mount(st: BotSettings) {
    this.st = { ...st };
    const years = YEARS[st.interval].map((y) => `<option value="${y}"${y === st.years ? ' selected' : ''}>${y < 1 ? `${y * 12} months` : `${y} year${y > 1 ? 's' : ''}`}</option>`).join('');
    this.el.innerHTML = `
      <h3>Bottom bot · backtest</h3>
      <p class="sub">Binance COIN-M BTCUSD_PERP, long only. Buys when a bottom is confirmed; stop a bit under that bottom.</p>
      <div class="bp-grid">
        <label>Timeframe<select id="b-interval">${(['1h', '4h', '1d'] as BotInterval[]).map((i) => `<option${i === st.interval ? ' selected' : ''}>${i}</option>`).join('')}</select></label>
        <label>History<select id="b-years">${years}</select></label>
        ${NUMS.map((n) => `<label title="${n.title}">${n.label}<input id="b-${n.key}" type="number" min="${n.min}" max="${n.max}" step="${n.step}" value="${st[n.key]}" inputmode="decimal"/></label>`).join('')}
      </div>
      <label class="mp-check" title="Each new higher bottom while in a trade raises the stop to just under it"><input id="b-trail" type="checkbox"${st.trail ? ' checked' : ''}/> Trail stop to new bottoms</label>
      <label class="mp-check" title="After a stop-out, buy again when a bar closes back above the stop level; new stop under the shakeout low"><input id="b-reentry" type="checkbox"${st.reentry ? ' checked' : ''}/> Re-enter if price reclaims the stop</label>
      <label class="mp-check" title="Uses Binance's actual 8-hourly funding rates"><input id="b-funding" type="checkbox"${st.funding ? ' checked' : ''}/> Include funding payments</label>
      <div class="bp-key">
        <span><i style="background:${C.draw}"></i>bottom taken</span><span><i style="background:${C.muted}"></i>bottom skipped</span>
        <span><b style="color:${C.s1}">▲</b> long</span><span><b style="color:${C.s7}">▲</b> re-entry</span>
        <span><b style="color:${C.up}">▼</b>/<b style="color:${C.down}">▼</b> exit, R</span>
        <span><em style="border-color:${C.down}"></em>stop</span><span><em style="border-color:${C.up}"></em>target</span>
      </div>
      <button id="b-reset" class="mp-btn secondary">Reset to defaults</button>
      <dl class="stats" id="b-stats"><dt>Loading…</dt><dd></dd></dl>
      <div class="bp-trades-head"><b>Trades</b><span class="muted" id="b-count"></span></div>
      <div class="bp-trades" id="b-trades"></div>
      <p class="note"><b>Rules.</b> A bottom is a bar whose low is below the previous <i>left</i> bars and is not undercut by the next <i>right</i> bars.
        The order fills at the next bar's open. While in a trade, each new higher bottom raises the stop to just under it.
        After a stop-out, a close back above the stop level re-opens the long, with the stop under the lowest low since the stop-out. Size = risk % ÷ distance to stop, in whole $100 contracts. If a bar touches both stop and target, the stop counts.
        A bar that opens through the stop fills at the open. Equity and PnL are in BTC (COIN-M is BTC-margined); liquidation and slippage are not modelled.
        Past results don't predict future ones.</p>`;

    const $ = <T extends HTMLElement>(id: string) => this.el.querySelector<T>(`#${id}`)!;
    const emit = () => this.onChange({ ...this.st });
    for (const n of NUMS) {
      $<HTMLInputElement>(`b-${n.key}`).addEventListener('change', (e) => {
        const inp = e.target as HTMLInputElement;
        let v = Number(inp.value);
        if (!Number.isFinite(v)) v = DEFAULT_BOT[n.key];
        v = Math.min(n.max, Math.max(n.min, v));
        if (n.step === 1 || n.key === 'trendEma') v = Math.round(v);
        inp.value = String(v);
        this.st[n.key] = v;
        emit();
      });
    }
    $('b-trail').addEventListener('change', (e) => { this.st.trail = (e.target as HTMLInputElement).checked; emit(); });
    $('b-reentry').addEventListener('change', (e) => { this.st.reentry = (e.target as HTMLInputElement).checked; emit(); });
    $('b-funding').addEventListener('change', (e) => { this.st.funding = (e.target as HTMLInputElement).checked; emit(); });
    $('b-interval').addEventListener('change', (e) => {
      const iv = (e.target as HTMLSelectElement).value as BotInterval;
      const ys = YEARS[iv];
      this.st.interval = iv;
      if (!ys.includes(this.st.years)) this.st.years = ys.reduce((a, b) => (Math.abs(b - this.st.years) < Math.abs(a - this.st.years) ? b : a));
      this.mount(this.st);
      emit();
    });
    $('b-years').addEventListener('change', (e) => { this.st.years = +(e.target as HTMLSelectElement).value; emit(); });
    $('b-reset').addEventListener('click', () => { this.mount({ ...DEFAULT_BOT_SETTINGS }); emit(); });
  }

  setStatus(msg: string) {
    this.el.querySelector('#b-stats')!.innerHTML = `<dt>${msg}</dt><dd></dd>`;
    this.el.querySelector('#b-trades')!.innerHTML = '';
    this.el.querySelector('#b-count')!.textContent = '';
  }

  update(r: BacktestResult, bars: Bar[]) {
    const s = r.stats;
    const span = bars.length ? `${fmtDate(bars[0].time)} → ${fmtDate(bars[bars.length - 1].time)}` : '';
    this.el.querySelector('#b-stats')!.innerHTML = `
      <dt>Period</dt><dd>${span}</dd>
      <dt>Equity (BTC)</dt><dd>${f2(s.startEquity, 2)} → ${f2(s.endEquity, 4)}</dd>
      <dt>Return in BTC</dt><dd class="${cls(s.returnPct)}">${pct(s.returnPct)}</dd>
      <dt title="Equity valued in USD at the first and last close">Return in USD</dt><dd class="${cls(s.usdReturnPct)}">${pct(s.usdReturnPct)}</dd>
      <dt title="Just holding the starting BTC">Hold BTC, USD</dt><dd class="${cls(s.holdUsdReturnPct)}">${pct(s.holdUsdReturnPct)}</dd>
      <dt>Closed trades</dt><dd>${s.trades}</dd>
      <dt>Win rate</dt><dd>${Number.isFinite(s.winRate) ? `${s.winRate.toFixed(0)}%` : '–'}</dd>
      <dt title="Gross wins ÷ gross losses. Above 1 = profitable.">Profit factor</dt><dd class="${cls(s.profitFactor - 1)}">${s.profitFactor === Infinity ? '∞' : f2(s.profitFactor)}</dd>
      <dt title="Average result in multiples of the risk taken">Avg trade</dt><dd class="${cls(s.avgR)}">${f2(s.avgR)} R</dd>
      <dt>Max drawdown</dt><dd>${f2(s.maxDrawdownPct, 1)}%</dd>
      <dt>Fees</dt><dd>${f2(s.feesBtc, 4)} BTC</dd>
      <dt title="Negative = paid">Funding</dt><dd>${f2(s.fundingBtc, 4)} BTC</dd>
      <dt>Time in market</dt><dd>${f2(s.exposurePct, 0)}%</dd>`;
    this.el.querySelector('#b-count')!.textContent = `${r.trades.length} · newest first · tap to view`;
    const rows = r.trades.slice().reverse().map((t, i) => {
      const idx = r.trades.length - 1 - i;
      return `<button class="bp-trade" data-i="${idx}">
        <span>${fmtWhen(t.entryTime, this.st.interval)}<small>${fmtPrice(t.entryPrice)} → ${fmtPrice(t.exitPrice)}</small></span>
        <span class="muted">${t.reentry ? 'Re-entry · ' : ''}${t.reason}</span>
        <span class="${cls(t.pnlBtc)}">${t.r >= 0 ? '+' : ''}${f2(t.r)}R<small>${t.pnlBtc >= 0 ? '+' : ''}${t.pnlBtc.toFixed(4)}</small></span></button>`;
    });
    const list = this.el.querySelector<HTMLElement>('#b-trades')!;
    list.innerHTML = rows.join('') || '<p class="note">No trades with these settings.</p>';
    list.onclick = (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('.bp-trade');
      if (b) this.onFocusTrade(r.trades[+b.dataset.i!]);
    };
  }
}

const ws = (p: { time: number; value: number }) => (Number.isFinite(p.value) ? p : { time: p.time });

export function buildBotSpec(bars: Bar[], r: BacktestResult, st: BotSettings, scale: ChartSpec['scaleMode']): ChartSpec {
  type M = NonNullable<SeriesSpec['markers']>[number];
  const markers: M[] = [];
  for (const b of r.bottoms) if (!b.taken) markers.push({ time: b.time, text: '', position: 'belowBar', color: C.muted, shape: 'circle' });
  for (const t of r.trades) {
    // Text only on exits; the panel's legend explains the shapes.
    if (!t.reentry) markers.push({ time: t.bottomTime, text: '', position: 'belowBar', color: C.draw, shape: 'circle' });
    markers.push({ time: t.entryTime, text: '', position: 'belowBar', color: t.reentry ? C.s7 : C.s1, shape: 'arrowUp' });
    if (t.reason !== 'Open') {
      markers.push({ time: t.exitTime, text: `${t.r >= 0 ? '+' : ''}${t.r.toFixed(1)}R`, position: 'aboveBar', color: t.pnlBtc >= 0 ? C.up : C.down, shape: 'arrowDown' });
    }
  }
  markers.sort((a, b) => a.time - b.time);

  const series: SeriesSpec[] = [
    { id: 'main', kind: 'candle', title: `BTCUSD_PERP ${st.interval}`, data: bars, main: true, precision: 1, markers },
    { id: 'stop', kind: 'line', title: 'Stop', data: r.stops.map(ws), color: C.down, lineWidth: 1, dashed: true, steps: true, precision: 1, lastValueVisible: false },
    { id: 'target', kind: 'line', title: 'Target', data: r.targets.map(ws), color: C.up, lineWidth: 1, dashed: true, steps: true, precision: 1, lastValueVisible: false },
    { id: 'equity', kind: 'line', title: 'Equity (BTC)', data: r.equity, color: C.s7, lineWidth: 2, pane: 1, precision: 4 },
  ];
  return {
    key: `BOTTOMBOT|${st.interval}|${st.years}`,
    series,
    scaleMode: scale,
    defaultYears: st.interval === '1h' ? 1 / 12 : st.interval === '4h' ? 0.25 : 1,
    paneStretch: { 1: 0.3 },
    horzLines: [{ pane: 1, value: r.stats.startEquity }],
  };
}
