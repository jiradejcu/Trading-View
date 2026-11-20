import { describe, expect, it } from 'vitest';
import { buildLagModel, computeGLI, prepareLagInputs, toMillions } from '../src/custom/liquidity';
import { generateDemo } from '../src/data/synthetic';
import { parseFredCsv, parseYahooChart } from '../src/data/sources';
import { parseISODate } from '../src/lib/time';

describe('parsers', () => {
  it('parses FRED csv and skips missing values', () => {
    const pts = parseFredCsv('observation_date,WALCL\n2024-01-03,7713598\n2024-01-10,.\n2024-01-17,7677000\n');
    expect(pts).toEqual([
      { time: parseISODate('2024-01-03'), value: 7713598 },
      { time: parseISODate('2024-01-17'), value: 7677000 },
    ]);
  });
  it('rejects an HTML page posing as FRED csv', () => {
    expect(() => parseFredCsv('<!doctype html><html></html>')).toThrow();
  });
  it('parses Yahoo chart JSON', () => {
    const json = { chart: { result: [{ timestamp: [1700000000, 1700086400], indicators: { quote: [{
      open: [1, 2], high: [3, 4], low: [0.5, 1.5], close: [2, null], volume: [10, 20] }] } }] } };
    const bars = parseYahooChart(json);
    expect(bars).toHaveLength(1);
    expect(bars[0]).toMatchObject({ open: 1, high: 3, low: 0.5, close: 2, volume: 10 });
  });
});

describe('global liquidity', () => {
  it('scales billions to millions', () => {
    expect(toMillions([{ time: 0, value: 500 }])[0].value).toBe(500_000);
    expect(toMillions([{ time: 0, value: 500_000 }])[0].value).toBe(500_000);
  });

  it('combines Fed, ECB and BOJ into USD trillions', () => {
    const t = parseISODate('2024-01-01'); // Monday
    const one = (v: number) => [{ time: t, value: v }];
    const g = computeGLI({
      WALCL: one(7_700_000), // $7.7T (millions)
      WTREGEN: one(700), // $0.7T (billions)
      RRPONTSYD: one(600), // $0.6T (billions)
      ECBASSETSW: one(7_000_000), // €7T (millions)
      JPNASSETS: one(7_500_000), // ¥750T (100 millions)
      DEXUSEU: one(1.1),
      DEXJPUS: one(150),
    });
    expect(g.fedNet[0].value).toBeCloseTo(6.4);
    expect(g.ecb[0].value).toBeCloseTo(7.7);
    expect(g.boj[0].value).toBeCloseTo(5);
    expect(g.total[0].value).toBeCloseTo(19.1);
  });

  it('recovers the lead built into the demo data', () => {
    const demo = generateDemo(parseISODate('2026-11-20'));
    const gli = computeGLI(demo.fred);
    expect(gli.total.length).toBeGreaterThan(500);
    const last = gli.total[gli.total.length - 1].value;
    expect(last).toBeGreaterThan(10);
    expect(last).toBeLessThan(60);
    const inp = prepareLagInputs(gli.total, demo.bars.MOVE, demo.bars.BTCUSD);
    const m = buildLagModel(inp, { lagGli: 10, lagMove: 10, wGli: 0.5, norm: 'rollz' });
    expect(m.bestGli.lag).toBeGreaterThanOrEqual(5);
    expect(m.bestGli.lag).toBeLessThanOrEqual(16);
    expect(m.rComposite).toBeGreaterThan(0.3);
    // Composite extends past the last BTC week by the lead.
    expect(m.composite[m.composite.length - 1].time).toBeGreaterThan(m.lastBtcTime);
  });
});
