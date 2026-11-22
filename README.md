# Trading View Craft

A TradingView-style charting web app (dark terminal layout, symbol search, watchlist,
candles/bars/line/area, 1D/1W/1M intervals, indicators, compare overlay, log/% scales,
trend-line and horizontal-line drawings) built on TradingView's open-source
[Lightweight Charts](https://github.com/tradingview/lightweight-charts) library.

Its main feature is a **custom asset, `LIQ·MOVE→BTC`**, which compares the inverse of the
MOVE index (bond-market volatility) and global liquidity with the Bitcoin price, with each
indicator shifted forward by an adjustable lead time.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173: live data through the dev proxy
npm test           # unit tests for the math, parsers and the lag model
npm run build      # static build in dist/
```

### Where the data comes from

FRED and Yahoo Finance don't allow cross-origin browser requests, so the app tries these sources in order, **for each series**:

1. **Live**: `npm run dev` / `npm run preview` proxy `/api/fred` → fred.stlouisfed.org, `/api/yahoo` → query1.finance.yahoo.com and `/api/binance` → dapi.binance.com (see `vite.config.ts`). Binance data loads only when the bot backtest is opened and has no snapshot/demo fallback.
2. **Snapshot**: `public/data/snapshot.json`, written by `npm run fetch-data`. Use this for a static deploy, and re-run it to refresh.
3. **Demo**: deterministic synthetic data generated in the browser. It is **not market data**: the header badge, the watchlist `DEMO` tags and a banner all say so.

The liquidity inputs are loaded as one group, so they never mix live and demo values.

## Deployment

Self-hosted at **https://tradingview.vatanutanon.me**: `vite preview` (with the live data proxy)
runs on `127.0.0.1:4173` as the user service `trading-view-web`, and the Cloudflare tunnel
`trading-view` (`~/.cloudflared/trading-view.yml`, service `trading-view-tunnel`) exposes it.
After code changes: `npm run build && systemctl --user restart trading-view-web`.

## Custom assets

| Symbol | Definition |
|---|---|
| `GLI` | Global liquidity, USD trillions, weekly: **Fed net liquidity** (`WALCL − WTREGEN − RRPONTSYD`) + **ECB** assets (`ECBASSETSW × DEXUSEU`) + **BOJ** assets (`JPNASSETS ÷ DEXJPUS`). The PBoC isn't included because FRED doesn't carry it. |
| `INVMOVE` | `100 / MOVE` (Yahoo `^MOVE`), as OHLC. Rising = calmer Treasury market. |
| `LIQ·MOVE→BTC` | The lag model (below). |
| `BOTTOM BOT` | Backtest of a long-only bottom-buying bot on Binance COIN-M `BTCUSD_PERP` (below). |

### The lag model

1. GLI, inverse MOVE and weekly BTC closes are put into the same z-units, using one of:
   - rolling 2-year z-score of the log level (default; removes the long-run trend)
   - full-sample z-score of the log level
   - z-score of the year-over-year % change
2. GLI is shifted forward by *L₁* weeks and inverse MOVE by *L₂* weeks (sliders, 0–52).
3. **Composite** = *w*·GLI(t − L₁) + (1 − *w*)·invMOVE(t − L₂). It runs past the latest
   BTC week by the lead, which acts as a projection.
4. The side panel shows Pearson *r* of the composite vs BTC, *r* for each input at its lead,
   a cross-correlation curve over leads 0–52w, and **Auto-fit**, which sets each lead to its
   peak correlation. A lower pane shows the 26-week rolling correlation.

All series in the comparison pane share one axis (z-units). BTC's price can be shown in its
own log-scale pane. Correlation between trending series overstates the fit, and
in-sample "best lag" is curve-fitting. Treat this as an exploration tool, not a signal.


### The bottom bot (backtest)

Binance COIN-M `BTCUSD_PERP` klines (1h / 4h / 1d) and funding rates, BTC-margined inverse
contracts ($100 each; PnL = contracts × 100 × (1/entry − 1/exit), in BTC). Logic in
`src/bot/bottomBot.ts`:

- **Bottom**: a bar whose low is below the previous *left* bars and isn't undercut by the
  next *right* bars. It's known at the close of the *right*-th bar; the long fills at the next open.
- **Stop**: *buffer %* below the bottom's low. Size = *risk %* of equity ÷ distance to the stop,
  in whole contracts, capped by *max leverage*.
- **Exit**: no take profit. The trade closes only at the stop, which trails up to just
  under each new higher bottom.
- **Re-entry**: after a stop-out, a close back above the stop level re-opens the long,
  with the stop under the lowest low since the stop-out.
- **Bear-market filter**: new trades and re-entries only open while the close is at least
  50% (settable) below the all-time high known at that bar: Binance daily highs since 2020 plus
  Yahoo BTC history since 2012. Trades already open are still managed and exited.
- Fees per side and real funding payments are charged. A bar that opens through the stop fills at its open. Slippage and
  liquidation aren't modelled.

Defaults (4h, left 20, right 3, stop 0.5% under the bottom, no re-entry, ATH −50%) were
picked by tuning on 2020–2023 and checking on 2024–2026, choosing the middle of the region that
was profitable in both rather than the single best result.

This is a backtest only; it places no orders.

## Layout

```
src/lib/          time helpers, resampling, z-scores, correlation, indicators
src/data/         FRED/Yahoo URL builders + parsers, loader with fallbacks, demo generator
src/custom/       GLI construction and the lag model
src/ui/           chart wrapper (legend, drawings), symbol specs, lag-model panel
scripts/          fetch-data.mjs snapshot downloader
tests/            vitest unit tests
```
