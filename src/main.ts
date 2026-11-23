import './styles.css';
import { loadDataset } from './data/store';
import { ChartView, type Drawing, type Tool } from './ui/chartView';
import { ModelPanel, type ModelPanelState } from './ui/modelPanel';
import {
  INDICATORS, SYMBOLS, Universe, buildSpec, rankModelLines, symbolDef, type ChartType, type IndicatorId, type ViewState,
} from './ui/symbols';
import type { SourceKind, Timeframe } from './lib/types';
import { fmtDate } from './lib/time';
import { BOT_DEFAULTS_VERSION, BotPanel, DEFAULT_BOT_SETTINGS, buildBotSpec, type BotSettings } from './ui/botPanel';
import { athSeries, backtest, type BacktestResult } from './bot/bottomBot';
import { loadBotData } from './data/binance';
import type { Bar } from './lib/types';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

// ---- PWA: register the service worker (production builds only) --------------
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => { /* app still works without it */ });
  });
}

// ---- Persisted per-viewer preferences (best-effort) -------------------------
const STORE_KEY = 'lagline:state:v1';
const DRAW_KEY = 'lagline:drawings:v1';
const load = <T>(k: string, fallback: T): T => {
  try { const v = localStorage.getItem(k); return v ? { ...fallback, ...JSON.parse(v) } : fallback; } catch { return fallback; }
};
const save = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } };

const defaults: ViewState = {
  symbol: 'LAGMODEL',
  tf: 'D',
  chartType: 'candle',
  scale: 'normal',
  indicators: ['vol'],
  compare: null,
  lag: { lagGli: 12, lagMove: 6, wGli: 0.5, norm: 'rollz', dynamic: true },
  btcAsPrice: false,
  showComponents: true,
  showAllLines: false,
  bot: DEFAULT_BOT_SETTINGS,
};
const st: ViewState = load(STORE_KEY, defaults);
if (!SYMBOLS.some((s) => s.id === st.symbol)) st.symbol = defaults.symbol;
st.lag.dynamic ??= true; // dynamic leads are the default
{
  const saved = st.bot as Partial<BotSettings> | undefined;
  // Settings saved under older defaults move to the current (optimized) ones once.
  // From v2/v3, keep the user's other settings and apply what changed:
  // v3 added the uptrend zone; v4 moved to right 12, slippage and history since 2017.
  const { trendEma: _old, ...kept } = (saved ?? {}) as BotSettings & { trendEma?: number };
  const D = DEFAULT_BOT_SETTINGS;
  st.bot = saved?.v === BOT_DEFAULTS_VERSION ? { ...D, ...saved }
    : saved?.v === 2 || saved?.v === 3 ? {
      ...D, ...kept, right: D.right, slipPct: D.slipPct, v: BOT_DEFAULTS_VERSION,
      ...(saved.v === 2 ? { uptrendEma: D.uptrendEma } : {}),
      ...(kept.interval === '1h' ? {} : { years: D.years }),
    }
    : { ...D };
}
const drawings: Record<string, Drawing[]> = load(DRAW_KEY, {});

// ---- Views --------------------------------------------------------------------
const view = new ChartView($('#chart'), $('#legend'));

// ---- Collapsible legend (remembered per viewer) -----------------------------
const LEGEND_KEY = 'lagline:legend:v1';
const legendPref = load(LEGEND_KEY, { collapsed: false });
function applyLegend() {
  const btn = $<HTMLButtonElement>('#legend-toggle');
  $('#legend').hidden = legendPref.collapsed;
  btn.textContent = legendPref.collapsed ? '▸' : '▾';
  btn.setAttribute('aria-expanded', String(!legendPref.collapsed));
  btn.title = legendPref.collapsed ? 'Show legend' : 'Hide legend';
}
$('#legend-toggle').addEventListener('click', () => {
  legendPref.collapsed = !legendPref.collapsed;
  save(LEGEND_KEY, legendPref);
  applyLegend();
});
applyLegend();
const panel = new ModelPanel($('#model-panel'), (patch: Partial<ModelPanelState>) => {
  Object.assign(st, patch);
  scheduleRender();
});
let uni: Universe | null = null;

// ---- Bottom-bot backtest (Binance data loads on first use) ------------------
const botPanel = new BotPanel($('#bot-panel'), (s: BotSettings) => { st.bot = s; scheduleRender(); });
botPanel.onFocusTrade = (t) => view.focusRange(t.entryTime, t.exitTime);
let bot: { key: string; bars: Bar[]; result: BacktestResult } | null = null;
let botData: (Awaited<ReturnType<typeof loadBotData>> & { key: string; ath: number[] }) | null = null;
let botLoading = '';
let botError = '';

/** Returns the current backtest, or null while Binance data is loading. */
function currentBacktest() {
  const dataKey = `${st.bot.interval}|${st.bot.years}`;
  if (botData?.key !== dataKey) {
    if (botLoading !== dataKey) {
      botLoading = dataKey;
      botError = '';
      loadBotData(st.bot.interval, st.bot.years)
        .then((d) => {
          if (botLoading !== dataKey) return;
          // ATH from Binance daily: spot BTCUSDT since 2017 plus the contract since 2020.
          botData = { key: dataKey, ...d, ath: athSeries(d.bars, d.daily) };
          botLoading = '';
        })
        .catch((e: Error) => { if (botLoading === dataKey) { botError = e.message; botLoading = ''; } })
        .finally(scheduleRender);
    }
    return null;
  }
  const key = JSON.stringify(st.bot);
  if (bot?.key !== key) bot = { key, bars: botData.bars, result: backtest(botData.bars, st.bot, botData.funding, 1, botData.ath) };
  return bot;
}

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

const fmtNum = (v: number, p: number) => v.toLocaleString(undefined, { minimumFractionDigits: p, maximumFractionDigits: p });

function render() {
  if (!uni) return;
  save(STORE_KEY, st);
  const def = symbolDef(st.symbol);
  const isModel = def.kind === 'model';
  const isBot = def.kind === 'backtest';
  const bt = isBot ? currentBacktest() : null;
  $('#loading').hidden = !(isBot && !bt && !botError);
  if (isBot && !bt) $('#loading-msg').textContent = 'Loading Binance BTCUSD_PERP…';

  if (!isBot) view.render(buildSpec(uni, st));
  else if (bt) view.render(buildBotSpec(bt.bars, bt.result, st.bot, st.scale === 'percent' ? 'normal' : st.scale, botData?.spotUntil ?? null));
  view.setDrawings(drawings[def.id] ?? []);

  // Header
  $('#symbol-label').textContent = def.name;
  $('#ch-name').textContent = def.name;
  $('#ch-desc').textContent = `· ${def.desc} · ${def.exchange}`;
  const last = view.lastMainValue();
  if (isModel) {
    const m = uni.model(st.lag);
    const best = rankModelLines(m, st.lag)[0];
    const ch = $('#ch-last');
    ch.innerHTML = `<span class="ch-label">corr</span> ${Number.isFinite(best.r) ? best.r.toFixed(2) : '–'}`;
    ch.title = `Correlation between ${best.name} and BTC. 1 = move together, 0 = unrelated, −1 = opposite.`;
    $('#ch-change').innerHTML = `<span class="muted">${best.name} vs BTC<span class="wide-only"> · latest BTC week ${fmtDate(m.lastBtcTime)}</span></span>`;
  } else if (isBot) {
    const s = bt?.result.stats;
    $('#ch-last').title = 'Backtest return, measured in BTC (COIN-M is BTC-margined)';
    $('#ch-last').innerHTML = s ? `<span class="ch-label">BTC</span> <span class="${s.returnPct >= 0 ? 'up' : 'down'}">${s.returnPct >= 0 ? '+' : ''}${s.returnPct.toFixed(1)}%</span>` : '';
    $('#ch-change').innerHTML = s
      ? `<span class="muted">${s.trades} trades · win ${Number.isFinite(s.winRate) ? s.winRate.toFixed(0) : '–'}% · PF ${Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '–'}<span class="wide-only"> · max DD ${s.maxDrawdownPct.toFixed(1)}%</span></span>`
      : botError ? `<span class="down">Binance unreachable: ${botError}</span>` : '';
  } else if (last) {
    $('#ch-last').title = '';
    const ch = last.value - last.prev, pct = (ch / last.prev) * 100;
    $('#ch-last').textContent = fmtNum(last.value, def.precision);
    $('#ch-change').innerHTML = `<span class="${ch >= 0 ? 'up' : 'down'}">${ch >= 0 ? '+' : ''}${fmtNum(ch, def.precision)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)</span>`;
  }

  // Toolbar state: controls that don't apply to this symbol are hidden (see .topbar[data-kind] CSS).
  $('.topbar').dataset.kind = def.kind;
  document.querySelectorAll<HTMLButtonElement>('#tf-group button').forEach((b) => {
    b.classList.toggle('active', b.dataset.tf === st.tf);
    b.disabled = isModel || isBot || (def.kind === 'line' && b.dataset.tf === 'D');
  });
  const ct = $<HTMLSelectElement>('#chart-type');
  ct.value = st.chartType;
  ct.disabled = def.kind !== 'ohlc';
  $<HTMLButtonElement>('#compare-btn').disabled = isModel || isBot;
  $<HTMLButtonElement>('#ind-btn').disabled = isModel || isBot;
  $('#compare-btn').innerHTML = st.compare && !isModel
    ? `＋<span class="wide-only"> vs</span> ${symbolDef(st.compare).name} ✕`
    : '＋<span class="wide-only"> Compare</span>';
  document.querySelectorAll<HTMLButtonElement>('#scale-group button').forEach((b) => {
    b.disabled = isModel || (isBot && b.dataset.scale === 'percent');
    b.classList.toggle('active', !isModel && b.dataset.scale === (st.compare && !isBot ? 'percent' : st.scale));
  });

  // Model panel
  const mp = $('#model-panel');
  mp.hidden = !isModel;
  if (isModel) {
    if (!mp.dataset.mounted) { panel.mount(st); mp.dataset.mounted = '1'; }
    panel.update(st, uni.model(st.lag));
  }
  const bp = $('#bot-panel');
  bp.hidden = !isBot;
  if (isBot) {
    if (!bp.dataset.mounted) { botPanel.mount(st.bot); bp.dataset.mounted = '1'; }
    if (bt) botPanel.update(bt.result, bt.bars, botData?.spotUntil ?? null);
    else botPanel.setStatus(botError ? `Couldn't load Binance data (${botError}).` : 'Loading Binance data…');
  }

  renderSource(def.id);
  renderWatchlist();
}

const SOURCE_TEXT: Record<SourceKind, string> = { live: 'Live data', snapshot: 'Snapshot data', demo: 'Demo data' };

function renderSource(id: string) {
  if (!uni) return;
  const src = uni.source(id);
  const b = $('#source-badge');
  b.className = `badge ${src}`;
  b.textContent = src === 'snapshot' && uni.ds.snapshotAt ? `Snapshot ${uni.ds.snapshotAt.slice(0, 10)}` : SOURCE_TEXT[src];
  b.title = src === 'demo'
    ? 'Synthetic data generated in the browser – not market data'
    : src === 'live' ? 'Fetched just now from FRED / Yahoo Finance via the dev proxy' : 'From public/data/snapshot.json';
}

function renderWatchlist() {
  if (!uni) return;
  const rows = SYMBOLS.map((s) => {
    let last = '–', chg = '', cls = '';
    if (s.kind === 'backtest') {
      const r = bot && botData && s.id === 'BOTTOMBOT' ? bot.result.stats.returnPct : NaN;
      last = Number.isFinite(r) ? `${r >= 0 ? '+' : ''}${r.toFixed(1)}% ₿` : 'backtest';
      cls = r >= 0 ? 'up' : r < 0 ? 'down' : '';
    } else if (s.kind === 'model') {
      const r = uni!.model(st.lag).rComposite;
      last = Number.isFinite(r) ? `corr ${r.toFixed(2)}` : '–';
    } else {
      const p = uni!.points(s.id);
      if (p.length > 1) {
        const a = p[p.length - 1].value, b = p[p.length - 2].value, pct = (a / b - 1) * 100;
        last = fmtNum(a, s.precision);
        chg = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
        cls = pct >= 0 ? 'up' : 'down';
      }
    }
    const tags = `${s.custom ? '<span class="tag custom">CUSTOM</span>' : ''}${uni!.source(s.id) === 'demo' ? '<span class="tag demo">DEMO</span>' : ''}`;
    return `<button class="wl-row${s.id === st.symbol ? ' active' : ''}" data-sym="${s.id}">
      <span class="wl-sym"><b>${s.name}${tags}</b><small>${s.desc}</small></span>
      <span>${last}</span><span class="${cls}">${chg}</span></button>`;
  });
  $('#wl-rows').innerHTML = rows.join('');
}

function setSymbol(id: string) {
  st.symbol = id;
  if (st.compare === id) st.compare = null;
  $('#sidebar').classList.remove('open');
  render();
}

// ---- Toolbar wiring -------------------------------------------------------
$('#wl-rows').addEventListener('click', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.wl-row');
  if (row?.dataset.sym) setSymbol(row.dataset.sym);
});
$('#tf-group').addEventListener('click', (e) => {
  const tf = (e.target as HTMLElement).dataset.tf as Timeframe | undefined;
  if (tf) { st.tf = tf; render(); }
});
$('#chart-type').addEventListener('change', (e) => { st.chartType = (e.target as HTMLSelectElement).value as ChartType; render(); });
$('#range-group').addEventListener('click', (e) => {
  const r = (e.target as HTMLElement).dataset.range;
  if (r) view.setRangeYears(r === 'all' ? 'all' : +r);
});
$('#scale-group').addEventListener('click', (e) => {
  const s = (e.target as HTMLElement).dataset.scale as ViewState['scale'] | undefined;
  if (!s) return;
  if (s !== 'percent') st.compare = null;
  st.scale = s;
  render();
});
$('#watch-toggle').addEventListener('click', () => $('#sidebar').classList.toggle('open'));

// Drawing tools
const setTool = (t: Tool) => {
  view.setTool(t);
  document.querySelectorAll<HTMLElement>('.lefttools [data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
};
document.querySelectorAll<HTMLElement>('.lefttools [data-tool]').forEach((b) =>
  b.addEventListener('click', () => setTool(b.dataset.tool as Tool)));
view.onToolDone = () => setTool('cursor');
view.onDrawingsChange = (d) => { drawings[st.symbol] = d; save(DRAW_KEY, drawings); };
$('#clear-drawings').addEventListener('click', () => {
  drawings[st.symbol] = [];
  save(DRAW_KEY, drawings);
  view.setDrawings([]);
});

// Dropdown menu (indicators / compare)
const menu = $('#menu');
function openMenu(anchor: HTMLElement, items: { label: string; checked?: boolean; onClick: () => void }[]) {
  menu.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.innerHTML = `<span class="chk">${it.checked ? '✓' : ''}</span>${it.label}`;
    b.addEventListener('click', () => { it.onClick(); menu.hidden = true; });
    menu.appendChild(b);
  }
  const r = anchor.getBoundingClientRect();
  menu.style.left = `${Math.min(r.left, window.innerWidth - 240)}px`;
  menu.style.top = `${r.bottom + 4}px`;
  menu.hidden = false;
}
document.addEventListener('click', (e) => {
  if (!menu.hidden && !menu.contains(e.target as Node) && !(e.target as HTMLElement).closest('#ind-btn,#compare-btn')) menu.hidden = true;
});
$('#ind-btn').addEventListener('click', (e) => {
  openMenu(e.currentTarget as HTMLElement, INDICATORS.map((i) => ({
    label: i.name,
    checked: st.indicators.includes(i.id),
    onClick: () => {
      st.indicators = st.indicators.includes(i.id) ? st.indicators.filter((x) => x !== i.id) : [...st.indicators, i.id as IndicatorId];
      render();
    },
  })));
});
$('#compare-btn').addEventListener('click', (e) => {
  if (st.compare) { st.compare = null; render(); return; }
  openMenu(e.currentTarget as HTMLElement, SYMBOLS.filter((s) => s.kind !== 'model' && s.id !== st.symbol).map((s) => ({
    label: `${s.name} <span class="muted">${s.exchange}</span>`,
    onClick: () => { st.compare = s.id; render(); },
  })));
});

// Symbol search modal
const modal = $('#modal'), input = $<HTMLInputElement>('#modal-input'), list = $('#modal-list');
let sel = 0;
function renderSearch() {
  const q = input.value.trim().toLowerCase();
  const hits = SYMBOLS.filter((s) => !q || `${s.id} ${s.name} ${s.desc}`.toLowerCase().includes(q));
  sel = Math.min(sel, Math.max(0, hits.length - 1));
  list.innerHTML = hits.map((s, i) => `<button class="ml-row${i === sel ? ' sel' : ''}" data-sym="${s.id}">
    <b>${s.name}</b><span>${s.desc}</span><span class="muted">${s.exchange}</span></button>`).join('') || '<p class="note" style="padding:12px 16px">No symbols match.</p>';
  return hits;
}
const openSearch = (prefill = '') => { modal.hidden = false; input.value = prefill; sel = 0; renderSearch(); input.focus(); };
const closeSearch = () => { modal.hidden = true; };
$('#symbol-btn').addEventListener('click', () => openSearch());
$('.modal-close').addEventListener('click', closeSearch);
modal.addEventListener('click', (e) => { if (e.target === modal) closeSearch(); });
input.addEventListener('input', () => { sel = 0; renderSearch(); });
input.addEventListener('keydown', (e) => {
  const hits = renderSearch();
  if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, hits.length - 1); renderSearch(); e.preventDefault(); }
  if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); renderSearch(); e.preventDefault(); }
  if (e.key === 'Enter' && hits[sel]) { closeSearch(); setSymbol(hits[sel].id); }
});
list.addEventListener('click', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.ml-row');
  if (row?.dataset.sym) { closeSearch(); setSymbol(row.dataset.sym); }
});
window.addEventListener('keydown', (e) => {
  const typing = (e.target as HTMLElement).matches('input, select, textarea');
  if (e.key === 'Escape') { closeSearch(); menu.hidden = true; setTool('cursor'); }
  else if (!typing && modal.hidden && /^[a-z]$/i.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); openSearch(e.key); }
  else if (!typing && e.key === '/') { e.preventDefault(); openSearch(); }
});

// UTC clock, as on trading terminals
const tick = () => { $('#clock').textContent = `${new Date().toISOString().slice(11, 19)} UTC`; };
tick();
setInterval(tick, 1000);

// ---- Boot -----------------------------------------------------------------
(async () => {
  const ds = await loadDataset((m) => { $('#loading-msg').textContent = m; });
  uni = new Universe(ds);
  $('#loading').hidden = true;

  const demoIds = SYMBOLS.filter((s) => uni!.source(s.id) === 'demo').map((s) => s.name);
  if (demoIds.length) {
    const banner = $('#banner');
    banner.innerHTML = `<strong>Demo data:</strong> live sources were unreachable, so ${demoIds.length === SYMBOLS.length ? 'every symbol uses' : `${demoIds.join(', ')} use`}
      synthetic data that is not real market data. Run <code>npm run dev</code> for live data through the proxy, or <code>npm run fetch-data</code> to save a snapshot.
      <button aria-label="Dismiss">✕</button>`;
    banner.hidden = false;
    banner.querySelector('button')!.addEventListener('click', () => { banner.hidden = true; });
  }
  render();
})();
