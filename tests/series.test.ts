import { describe, expect, it } from 'vitest';
import { WEEK, parseISODate, weekStart } from '../src/lib/time';
import {
  correlateAtLag, crossCorrelation, bestLag, ffillOnGrid, pearson, resampleBars, rsi, sma, weeklyGrid, yoy,
} from '../src/lib/series';
import type { Point } from '../src/lib/types';

describe('time', () => {
  it('weekStart returns the Monday', () => {
    const wed = parseISODate('2024-11-20');
    expect(new Date(weekStart(wed) * 1000).toISOString().slice(0, 10)).toBe('2024-11-18');
    const mon = parseISODate('2024-11-18');
    expect(weekStart(mon)).toBe(mon);
  });
});

describe('series', () => {
  it('resamples daily bars to weekly OHLCV', () => {
    const d = (s: string) => parseISODate(s);
    const bars = [
      { time: d('2024-11-18'), open: 10, high: 12, low: 9, close: 11, volume: 1 },
      { time: d('2024-11-19'), open: 11, high: 15, low: 10, close: 14, volume: 2 },
      { time: d('2024-11-25'), open: 14, high: 14, low: 8, close: 9, volume: 3 },
    ];
    const w = resampleBars(bars, 'W');
    expect(w).toHaveLength(2);
    expect(w[0]).toEqual({ time: d('2024-11-18'), open: 10, high: 15, low: 9, close: 14, volume: 3 });
  });

  it('forward-fills onto a grid', () => {
    const grid = weeklyGrid(0, 4 * WEEK).map((t) => t);
    const pts: Point[] = [{ time: grid[1], value: 5 }, { time: grid[3] + 1, value: 7 }];
    expect(ffillOnGrid(pts, grid)).toEqual([undefined, 5, 5, 5, 7]);
  });

  it('pearson is 1 for linear, -1 for inverse', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1);
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1);
  });

  it('finds the lag at which x leads y', () => {
    const n = 300;
    const x: Point[] = [], y: Point[] = [];
    const sig = (i: number) => Math.sin(i / 7) + 0.5 * Math.sin(i / 3.1);
    for (let i = 0; i < n; i++) {
      x.push({ time: i * WEEK, value: sig(i) });
      y.push({ time: i * WEEK, value: sig(i - 9) });
    }
    expect(correlateAtLag(x, y, 9).r).toBeCloseTo(1, 6);
    expect(bestLag(crossCorrelation(x, y, 30)).lag).toBe(9);
  });

  it('yoy compares to 52 weeks earlier', () => {
    const p: Point[] = Array.from({ length: 53 }, (_, i) => ({ time: i * WEEK, value: i === 0 ? 100 : 110 }));
    expect(yoy(p)).toEqual([{ time: 52 * WEEK, value: expect.closeTo(10, 9) }]);
  });

  it('sma and rsi basics', () => {
    const p: Point[] = Array.from({ length: 30 }, (_, i) => ({ time: i, value: i }));
    expect(sma(p, 3)[0]).toEqual({ time: 2, value: 1 });
    expect(rsi(p, 14).every((x) => x.value === 100)).toBe(true);
  });
});
