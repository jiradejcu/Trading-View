/** A price bar. `time` is a UTC unix timestamp in seconds at 00:00 of the bar's day. */
export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** A single-value observation. `time` is a UTC unix timestamp in seconds. */
export interface Point {
  time: number;
  value: number;
}

/** Where a series came from: proxied live API, bundled snapshot file, or synthetic demo data. */
export type SourceKind = 'live' | 'snapshot' | 'demo';

export type Timeframe = 'D' | 'W' | 'M';
