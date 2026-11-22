import type { Bar } from '../lib/types';

/**
 * "Bottom bot": go long on Binance COIN-M BTCUSD_PERP when a swing low (bottom) is
 * confirmed, with the stop a little below that bottom.
 *
 * A bar is a bottom when its low is lower than the `left` bars before it and no lower
 * than the `right` bars after it. It can only be known `right` bars later, so the
 * signal fires at the close of bar p+right and the order fills at the next bar's open.
 * Nothing here looks at a bar before it has closed.
 *
 * COIN-M contracts are inverse: each contract is worth $100, margin and PnL are in BTC.
 *   PnL (BTC) = contracts × 100 × (1/entry − 1/exit)
 */

export const CONTRACT_USD = 100;

export interface BotParams {
  /** Bars that must be higher on the left of the bottom. */
  left: number;
  /** Bars that must not undercut the bottom on its right (= confirmation delay). */
  right: number;
  /** Stop goes this % below the bottom's low. */
  slBufferPct: number;
  /** Take profit at this multiple of the initial risk; 0 = no fixed target. */
  tpR: number;
  /** Raise the stop to each new, higher confirmed bottom (minus the buffer). */
  trail: boolean;
  /** Only take bottoms while the close is above the EMA of this length; 0 = off. */
  trendEma: number;
  /** Only open trades while price is at least this % below its all-time high; 0 = off. */
  athDrawdownPct: number;
  /** % of equity lost if the stop is hit (before fees and slippage). */
  riskPct: number;
  /** Position notional is capped at this multiple of equity. */
  maxLeverage: number;
  /** Taker fee per side, %. Binance COIN-M default taker is 0.05%. */
  feePct: number;
  /** Apply real funding payments (longs pay positive rates). */
  funding: boolean;
  /**
   * After a stop-out, buy again once a bar closes back above the level where the stop
   * was hit. The new stop goes under the lowest low made since the stop-out.
   */
  reentry: boolean;
}

export const DEFAULT_BOT: BotParams = {
  left: 10,
  right: 3,
  slBufferPct: 0.5,
  tpR: 2,
  trail: true,
  trendEma: 0,
  athDrawdownPct: 50,
  riskPct: 1,
  maxLeverage: 5,
  feePct: 0.05,
  funding: true,
  reentry: true,
};

export interface FundingEvent { time: number; rate: number; markPrice: number }

export type ExitReason = 'Stop' | 'Trail stop' | 'Target' | 'Open';

export interface Trade {
  /** Opened by the re-entry rule rather than a fresh bottom. */
  reentry: boolean;
  bottomTime: number;
  bottomPrice: number;
  entryTime: number;
  entryPrice: number;
  initialStop: number;
  target: number | null;
  contracts: number;
  exitTime: number;
  exitPrice: number;
  reason: ExitReason;
  /** Net of fees and funding, BTC. */
  pnlBtc: number;
  /** pnl / risk at entry. */
  r: number;
  feesBtc: number;
  fundingBtc: number;
  equityAfter: number;
}

export interface BacktestResult {
  trades: Trade[];
  /** Mark-to-market equity at each bar close, BTC. */
  equity: { time: number; value: number }[];
  /** Active stop / target per bar while in a trade (NaN when flat). */
  stops: { time: number; value: number }[];
  targets: { time: number; value: number }[];
  bottoms: { time: number; price: number; taken: boolean }[];
  /** The bear-market trigger level (ATH × (1 − drawdown)) at each bar; empty when off. */
  zone: { time: number; value: number }[];
  stats: BacktestStats;
}

export interface BacktestStats {
  startEquity: number;
  endEquity: number;
  returnPct: number;
  /** Same equity valued in USD at the first and last close. */
  usdStart: number;
  usdEnd: number;
  usdReturnPct: number;
  /** Holding the starting BTC unchanged, USD return. */
  holdUsdReturnPct: number;
  trades: number;
  wins: number;
  winRate: number;
  profitFactor: number;
  avgR: number;
  maxDrawdownPct: number;
  feesBtc: number;
  fundingBtc: number;
  exposurePct: number;
}

export function ema(values: number[], n: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (n <= 0) return out;
  const k = 2 / (n + 1);
  let e = NaN;
  for (let i = 0; i < values.length; i++) {
    e = Number.isNaN(e) ? values[i] : values[i] * k + e * (1 - k);
    if (i >= n - 1) out[i] = e;
  }
  return out;
}

/** Index of the bottom confirmed at the close of bar `i`, or -1. */
export function confirmedBottom(bars: Bar[], i: number, left: number, right: number): number {
  const p = i - right;
  if (p - left < 0) return -1;
  const lo = bars[p].low;
  for (let j = p - left; j < p; j++) if (bars[j].low <= lo) return -1;
  for (let j = p + 1; j <= i; j++) if (bars[j].low < lo) return -1;
  return p;
}

const pnl = (contracts: number, entry: number, exit: number) => contracts * CONTRACT_USD * (1 / entry - 1 / exit);
const notionalBtc = (contracts: number, price: number) => (contracts * CONTRACT_USD) / price;

/**
 * All-time high known at the close of each bar: the highest high of `history` (daily bars)
 * from days that ended by this bar's open, and of `bars` up to and including this one.
 */
export function athSeries(bars: Bar[], history: Bar[] = []): number[] {
  const out: number[] = [];
  const hist = history.slice().sort((a, b) => a.time - b.time);
  let h = 0, histMax = 0, runMax = 0;
  for (const b of bars) {
    while (h < hist.length && hist[h].time + 86400 <= b.time) histMax = Math.max(histMax, hist[h++].high);
    runMax = Math.max(runMax, b.high);
    out.push(Math.max(histMax, runMax));
  }
  return out;
}

/**
 * @param ath all-time high known at each bar's close (see athSeries). Defaults to the
 *            running high of `bars` alone, which understates it if the data starts late.
 */
export function backtest(bars: Bar[], p: BotParams, funding: FundingEvent[] = [], startEquity = 1, ath?: number[]): BacktestResult {
  const trades: Trade[] = [];
  const equityCurve: BacktestResult['equity'] = [];
  const stops: BacktestResult['stops'] = [];
  const targets: BacktestResult['targets'] = [];
  const bottoms: BacktestResult['bottoms'] = [];
  const trend = p.trendEma > 0 ? ema(bars.map((b) => b.close), p.trendEma) : null;
  const athAt = ath ?? athSeries(bars);
  const zoneLevel = (i: number) => athAt[i] * (1 - p.athDrawdownPct / 100);
  const inZone = (i: number) => p.athDrawdownPct <= 0 || bars[i].close <= zoneLevel(i);
  const zone: BacktestResult['zone'] = p.athDrawdownPct > 0 ? bars.map((b, i) => ({ time: b.time, value: zoneLevel(i) })) : [];
  const buf = 1 - p.slBufferPct / 100;
  const fee = p.feePct / 100;
  const barSec = bars.length > 1 ? bars[1].time - bars[0].time : 86400;

  let equity = startEquity;
  let pending: { stop: number; bottom: number; bottomTime: number; reentry: boolean } | null = null;
  /** Armed after a stop-out: re-enter if price closes back above `level`. */
  let rearm: { level: number; low: number; lowTime: number } | null = null;
  let pos: {
    entryTime: number; entry: number; stop: number; initialStop: number; target: number | null; contracts: number;
    bottom: number; bottomTime: number; risk: number; fees: number; funding: number; reentry: boolean;
  } | null = null;
  let fi = 0;
  let barsIn = 0;

  const close = (time: number, price: number, reason: ExitReason) => {
    const c = pos!;
    const exitFee = notionalBtc(c.contracts, price) * fee;
    const gross = pnl(c.contracts, c.entry, price);
    equity += gross - exitFee; // entry fee and funding were already booked
    const net = gross - c.fees - exitFee + c.funding;
    trades.push({
      reentry: c.reentry, bottomTime: c.bottomTime, bottomPrice: c.bottom, entryTime: c.entryTime, entryPrice: c.entry,
      initialStop: c.initialStop, target: c.target, contracts: c.contracts, exitTime: time, exitPrice: price, reason,
      pnlBtc: net, r: net / c.risk, feesBtc: c.fees + exitFee, fundingBtc: c.funding, equityAfter: equity,
    });
    pos = null;
  };

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];

    // 1) Fill a signal from the previous close at this bar's open.
    if (pending && !pos) {
      const entry = b.open;
      const stop: number = pending.stop;
      if (entry > stop) {
        const lossPerContract = pnl(1, entry, stop) * -1; // BTC lost per contract at the stop
        const byRisk = Math.floor((equity * p.riskPct / 100) / lossPerContract);
        const byLev = Math.floor((p.maxLeverage * equity * entry) / CONTRACT_USD);
        const contracts = Math.min(byRisk, byLev);
        if (contracts >= 1) {
          const entryFee = notionalBtc(contracts, entry) * fee;
          equity -= entryFee;
          pos = {
            entryTime: b.time, entry, stop, initialStop: stop,
            target: p.tpR > 0 ? entry + p.tpR * (entry - stop) : null,
            contracts, bottom: pending.bottom, bottomTime: pending.bottomTime,
            risk: contracts * lossPerContract, fees: entryFee, funding: 0, reentry: pending.reentry,
          };
        }
      }
      pending = null;
    }

    // 2) Funding settlements that fall inside this bar.
    const barEnd = b.time + barSec;
    while (fi < funding.length && funding[fi].time < b.time) fi++;
    while (fi < funding.length && funding[fi].time < barEnd) {
      if (pos && p.funding) {
        const f = funding[fi];
        const pay = -f.rate * notionalBtc(pos.contracts, f.markPrice || b.close);
        pos.funding += pay;
        equity += pay;
      }
      fi++;
    }

    // 3) Stop / target inside the bar. If both could have hit, assume the stop did.
    if (pos) {
      barsIn++;
      if (b.low <= pos.stop) {
        const level: number = pos.stop;
        close(b.time, Math.min(b.open, level), level > pos.initialStop ? 'Trail stop' : 'Stop');
        if (p.reentry) rearm = { level, low: b.low, lowTime: b.time };
      } else if (pos.target != null && b.high >= pos.target) {
        close(b.time, Math.max(b.open, pos.target), 'Target');
      }
    }

    // 4) At the close: look for a newly confirmed bottom.
    const k = confirmedBottom(bars, i, p.left, p.right);
    if (k >= 0) {
      const bottom = bars[k].low;
      const stop = bottom * buf;
      const trendOk = !trend || (Number.isFinite(trend[i]) && b.close > trend[i]);
      let taken = false;
      if (pos) {
        if (p.trail && stop > pos.stop && stop < b.close) pos.stop = stop;
      } else if (trendOk && inZone(i) && i < bars.length - 1) {
        pending = { stop, bottom, bottomTime: bars[k].time, reentry: false };
        rearm = null; // a fresh bottom replaces the re-entry setup
        taken = true;
      }
      bottoms.push({ time: bars[k].time, price: bottom, taken });
    }

    // 5) Re-entry: price reclaimed the level where we were stopped out.
    if (rearm && !pos && !pending) {
      if (b.low < rearm.low) { rearm.low = b.low; rearm.lowTime = b.time; }
      if (b.close > rearm.level && inZone(i) && i < bars.length - 1) {
        pending = { stop: rearm.low * buf, bottom: rearm.low, bottomTime: rearm.lowTime, reentry: true };
        rearm = null;
      }
    }

    const mtm = pos ? equity + pnl(pos.contracts, pos.entry, b.close) : equity;
    equityCurve.push({ time: b.time, value: mtm });
    stops.push({ time: b.time, value: pos ? pos.stop : NaN });
    targets.push({ time: b.time, value: pos?.target ?? NaN });
  }

  if (pos) {
    const last = bars[bars.length - 1];
    const c = pos as NonNullable<typeof pos>;
    const net = pnl(c.contracts, c.entry, last.close) - c.fees + c.funding;
    trades.push({
      reentry: c.reentry, bottomTime: c.bottomTime, bottomPrice: c.bottom, entryTime: c.entryTime, entryPrice: c.entry,
      initialStop: c.initialStop, target: c.target, contracts: c.contracts, exitTime: last.time, exitPrice: last.close,
      reason: 'Open', pnlBtc: net, r: net / c.risk, feesBtc: c.fees, fundingBtc: c.funding,
      equityAfter: equityCurve[equityCurve.length - 1]?.value ?? equity,
    });
  }

  return { trades, equity: equityCurve, stops, targets, bottoms, zone, stats: stats(bars, trades, equityCurve, startEquity, barsIn) };
}

function stats(bars: Bar[], trades: Trade[], eq: { value: number }[], start: number, barsIn: number): BacktestStats {
  const end = eq.length ? eq[eq.length - 1].value : start;
  const closed = trades.filter((t) => t.reason !== 'Open');
  const wins = closed.filter((t) => t.pnlBtc > 0);
  const gw = wins.reduce((s, t) => s + t.pnlBtc, 0);
  const gl = closed.filter((t) => t.pnlBtc <= 0).reduce((s, t) => s - t.pnlBtc, 0);
  let peak = -Infinity, mdd = 0;
  for (const e of eq) { peak = Math.max(peak, e.value); mdd = Math.max(mdd, 1 - e.value / peak); }
  const p0 = bars[0]?.close ?? NaN, p1 = bars[bars.length - 1]?.close ?? NaN;
  return {
    startEquity: start,
    endEquity: end,
    returnPct: (end / start - 1) * 100,
    usdStart: start * p0,
    usdEnd: end * p1,
    usdReturnPct: ((end * p1) / (start * p0) - 1) * 100,
    holdUsdReturnPct: (p1 / p0 - 1) * 100,
    trades: closed.length,
    wins: wins.length,
    winRate: closed.length ? (wins.length / closed.length) * 100 : NaN,
    profitFactor: gl > 0 ? gw / gl : gw > 0 ? Infinity : NaN,
    avgR: closed.length ? closed.reduce((s, t) => s + t.r, 0) / closed.length : NaN,
    maxDrawdownPct: mdd * 100,
    feesBtc: trades.reduce((s, t) => s + t.feesBtc, 0),
    fundingBtc: trades.reduce((s, t) => s + t.fundingBtc, 0),
    exposurePct: bars.length ? (barsIn / bars.length) * 100 : 0,
  };
}
