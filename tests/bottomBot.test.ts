import { describe, expect, it } from 'vitest';
import { CONTRACT_USD, DEFAULT_BOT, backtest, confirmedBottom, type BotParams } from '../src/bot/bottomBot';
import type { Bar } from '../src/lib/types';

const H = 3600;
/** Bars from a list of lows; highs sit 1% above, open/close in between. */
function barsFromLows(lows: number[], highs?: number[]): Bar[] {
  // Prices scaled to BTC levels so whole $100 contracts can be sized.
  return lows.map((l, i) => {
    const lo = l * 1000, hi = (highs?.[i] ?? l * 1.01) * 1000;
    return { time: i * H, open: (lo + hi) / 2, high: hi, low: lo, close: (lo + hi) / 2 };
  });
}

const P: BotParams = { ...DEFAULT_BOT, left: 3, right: 2, slBufferPct: 1, tpR: 2, trail: false, funding: false, feePct: 0, riskPct: 1, maxLeverage: 100 };

describe('confirmedBottom', () => {
  const lows = [105, 104, 103, 100, 101, 102, 103];
  const bars = barsFromLows(lows);
  it('fires only once `right` bars have closed after the low', () => {
    expect(confirmedBottom(bars, 4, 3, 2)).toBe(-1); // only one bar after the low
    expect(confirmedBottom(bars, 5, 3, 2)).toBe(3);
  });
  it('rejects a low that is undercut afterwards', () => {
    const b2 = barsFromLows([105, 104, 103, 100, 99, 102, 103]);
    expect(confirmedBottom(b2, 5, 3, 2)).toBe(-1);
  });
});

describe('backtest', () => {
  it('enters at the next open after confirmation with the stop under the bottom', () => {
    const lows = [105, 104, 103, 100, 101, 102, 103, 104, 105, 106];
    const bars = barsFromLows(lows);
    const r = backtest(bars, P);
    const t = r.trades[0];
    expect(t.entryTime).toBe(bars[6].time); // bottom at 3, confirmed at close of 5
    expect(t.entryPrice).toBe(bars[6].open);
    expect(t.initialStop).toBeCloseTo(100_000 * 0.99);
    expect(t.bottomPrice).toBe(100_000);
  });

  it('loses about riskPct when stopped out (inverse contract maths)', () => {
    const lows = [105, 104, 103, 100, 101, 102, 103, 95, 95, 95];
    const highs = lows.map((l, i) => (i === 7 ? 104 : l * 1.01)); // opens above the stop, then falls through it
    const r = backtest(barsFromLows(lows, highs), P);
    const t = r.trades[0];
    expect(t.reason).toBe('Stop');
    expect(t.exitPrice).toBeCloseTo(99_000);
    // Whole contracts round the size down, so the loss is at most 1%.
    expect(t.pnlBtc).toBeLessThan(0);
    expect(-t.pnlBtc).toBeLessThanOrEqual(0.01 + 1e-12);
    expect(t.pnlBtc).toBeCloseTo(t.contracts * CONTRACT_USD * (1 / t.entryPrice - 1 / t.exitPrice));
  });

  it('fills at the open when a bar gaps through the stop', () => {
    const lows = [105, 104, 103, 100, 101, 102, 103, 95, 95, 95];
    const bars = barsFromLows(lows);
    const t = backtest(bars, P).trades[0];
    expect(t.exitPrice).toBe(bars[7].open);
  });

  it('takes profit at the R target', () => {
    const lows = [105, 104, 103, 100, 101, 102, 103, 104, 110, 120];
    const highs = lows.map((l) => l * 1.01);
    const r = backtest(barsFromLows(lows, highs), P);
    const t = r.trades[0];
    expect(t.reason).toBe('Target');
    expect(t.r).toBeGreaterThan(1.9);
  });

  it('never uses a bar it has not seen: truncating the data does not change earlier trades', () => {
    const lows = Array.from({ length: 300 }, (_, i) => 100 + 10 * Math.sin(i / 7) + 3 * Math.sin(i / 2.3));
    const full = backtest(barsFromLows(lows), { ...P, trail: true });
    const part = backtest(barsFromLows(lows.slice(0, 200)), { ...P, trail: true });
    const done = part.trades.filter((t) => t.reason !== 'Open');
    expect(done.length).toBeGreaterThan(2);
    expect(full.trades.slice(0, done.length)).toEqual(done);
  });
});

describe('stop management', () => {
  it('raises the stop under a new higher low', () => {
    // bottom 100 → rally → higher low 104 (confirmed) → keeps going
    const lows = [105, 104, 103, 100, 101, 102, 106, 108, 109, 104, 106, 107, 108, 110, 111, 112];
    const r = backtest(barsFromLows(lows), { ...P, tpR: 0, trail: true });
    const i = 12; // after the higher low at index 9 is confirmed (close of 11)
    expect(r.stops[i].value).toBeCloseTo(104_000 * 0.99);
  });

  it('re-enters when price closes back above the level that stopped it out', () => {
    // bottom 100, stop 99k; a wick to 97 stops it out, next bars close back above 99k
    const lows = [105, 104, 103, 100, 101, 102, 103, 97, 100, 101, 102, 103];
    const highs = lows.map((l, i) => (i === 7 ? 104 : l * 1.01));
    const on = backtest(barsFromLows(lows, highs), { ...P, tpR: 0, reentry: true });
    expect(on.trades[0].reason).toBe('Stop');
    const re = on.trades[1];
    expect(re.reentry).toBe(true);
    expect(re.initialStop).toBeCloseTo(97_000 * 0.99); // under the shakeout low
    expect(re.entryTime).toBe(8 * H * 1); // the stop-out bar closed back above 99k → fill at the next open
    // Without the rule it waits for the shakeout low to confirm as a normal bottom (2 bars later).
    const off = backtest(barsFromLows(lows, highs), { ...P, tpR: 0, reentry: false });
    expect(off.trades[1].reentry).toBe(false);
    expect(off.trades[1].entryTime).toBe(10 * H);
  });
});
