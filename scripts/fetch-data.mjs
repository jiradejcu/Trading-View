#!/usr/bin/env node
// Downloads raw FRED CSVs and Yahoo Finance chart JSON into public/data/snapshot.json so a
// static build (no dev proxy) can still show real data. Run: npm run fetch-data
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const START = '2012-01-01';
const START_SEC = Date.UTC(2012, 0, 1) / 1000;
const FRED_IDS = ['WALCL', 'WTREGEN', 'RRPONTSYD', 'ECBASSETSW', 'JPNASSETS', 'DEXUSEU', 'DEXJPUS'];
const YAHOO = { BTCUSD: 'BTC-USD', ETHUSD: 'ETH-USD', SPX: '^GSPC', MOVE: '^MOVE', VIX: '^VIX', DXY: 'DX-Y.NYB' };
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

const snapshot = { fetchedAt: new Date().toISOString(), fred: {}, yahoo: {} };
let failures = 0;

for (const id of FRED_IDS) {
  try {
    const csv = await get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${START}`);
    if (!/^(observation_date|DATE),/i.test(csv)) throw new Error('unexpected response');
    snapshot.fred[id] = csv;
    console.log(`FRED  ${id.padEnd(10)} ok (${csv.split('\n').length - 1} rows)`);
  } catch (e) {
    failures++;
    console.error(`FRED  ${id.padEnd(10)} FAILED: ${e.message}`);
  }
}

const now = Math.floor(Date.now() / 1000);
for (const [sym, ticker] of Object.entries(YAHOO)) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${START_SEC}&period2=${now + 86400}&interval=1d&includePrePost=false`;
    const json = JSON.parse(await get(url));
    const n = json?.chart?.result?.[0]?.timestamp?.length;
    if (!n) throw new Error(json?.chart?.error?.description ?? 'no data');
    snapshot.yahoo[sym] = json;
    console.log(`Yahoo ${sym.padEnd(10)} ok (${n} bars)`);
  } catch (e) {
    failures++;
    console.error(`Yahoo ${sym.padEnd(10)} FAILED: ${e.message}`);
  }
}

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../public/data/snapshot.json');
await mkdir(dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(snapshot));
console.log(`\nWrote ${out}${failures ? ` (${failures} series failed; the app uses demo data for those)` : ''}`);
process.exitCode = failures ? 1 : 0;
