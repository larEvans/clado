# Multi-Strategy Trading Bot

An automated intraday trading system for stocks, crypto, and options on
**Alpaca**. It streams 1-minute bars, classifies the current market regime,
evaluates a portfolio of strategies, routes the highest-probability signal,
and learns from every closed trade. A web dashboard handles monitoring,
backtesting, and live configuration.

> This project grew out of the "Claude + TradingView MCP" tutorial series.
> The original tutorial (BitGet, TradingView MCP, cron-based `bot.js`) still
> works and is documented in [docs/legacy.md](docs/legacy.md).

**This is not financial advice.** Backtest, paper trade, and never risk more
than you can afford to lose.

---

## How It Works

On every completed bar, the streaming bot runs this pipeline:

```
1-min bars (Alpaca WebSocket)
        │
        ▼
regime.js      classify market: "trend-up:high-vol:gap-up" etc.
        │
        ▼
strategies/    every active strategy evaluates the bars → signal or null
        │
        ▼
router.js      score fired signals by per-regime win rate × confidence,
               apply diversification discount + optional consensus vote
        │
        ▼
ml/predictor.js  optional XGBoost price-target model (the "4th brain"):
               veto/size the trade + feed a price target & horizon to options
        │
        ▼
agents.js      optional Bull/Bear/Risk-Manager LLM debate veto
agents-options.js  optional Options Strategist picks the contract
        │
        ▼
execution      Alpaca order (or paper log) → stop/target management
        │
        ▼
learner.js     record the closed trade, update per-regime stats,
               adapt parameters — feeds back into the router
```

### Modules

| File | Role |
|------|------|
| `start.js` | Production launcher — supervises `bot-stream.js` + `dashboard.js`, auto-restarts on crash |
| `bot-stream.js` | Live trading engine (WebSocket bars, order execution, position management) |
| `stream.js` | Alpaca WebSocket wrapper (stocks + crypto feeds) |
| `regime.js` | Market regime classifier (trend / volatility / gap / ORB quality) |
| `router.js` | Strategy selection: per-regime win-rate scoring, consensus mode, diversification |
| `signals.js` | Shared by the live bot and `replay.js`: 5/15/60-minute bars from the 1-minute stream, each strategy's entry check on its native bars, exits (incl. trailing stops), the router's entry decision |
| `replay.js` | Full-system replay backtest of the live router |
| `strategy-screener.js` | Which symbols suit hybrid10 / vwap-reclaim: backtests each on ~2 years of 5m bars per symbol, split into an older and newer year, after a 0.02% round-trip cost; also 0DTE expiries/week and option spreads. `node strategy-screener.js [--most-actives=30]` or the dashboard's Screener tab. Its built-in check (does a good older year predict the newer year?) was negative on the first run for 51 liquid symbols, so treat "fits" as candidates, not proof |
| `strategies/dip-buy.js` | **Active.** Index dip-buy: SPY/QQQ/IWM/DIA above the 200-day average with RSI(2) < 10 at 3:55 PM → buy shares; exit at 3:55 on RSI(2) > 70, a close above the prior day's high, or after 7 sessions; held overnight (exempt from the 3:45 close; positions are restored after a restart). 2025–Sep 2026: 72 trades, 76% win, +0.75%/trade after costs — see docs/edge-study.md |
| `ict.js`, `strategies/ict-2024.js` | ICT concepts (liquidity pools, fair value gaps, sweeps) used for optional liquidity targets, model features, and the ICT 2024 Mentorship Lecture 1 "8:30 model" strategy (available, not active). Jul 2020–Sep 2026, 7 symbols (SPY QQQ TSLA MSFT META IWM DIA), 5m bars: 574 trades, 41% win, +0.180R/trade before costs (95% CI +0.07 to +0.30, t≈3), positive on every symbol and 6 of 7 years (2026 YTD −0.17R). Thin: median stop 0.42% of price, so a 0.02% round-trip cost halves it and 0.05% erases it |
| `strategies/late-momentum.js`, `strategies/noise-momentum.js` | Research-based intraday momentum strategies (last-half-hour momentum; noise-band momentum). Available but not active: neither added edge in a 1-year replay on SPY/TSLA/QQQ/MSFT/META |
| `runtime-config.js` | Router settings: env defaults overridden by `bot-config.json` |
| `strategies/*.js` | Pluggable strategies — each exports `meta` + a signal function |
| `learner.js` | Trade history, per-regime stats, adaptive parameter learning |
| `backtest.js` | Backtesting engine + indicator math |
| `cpcv.js` | Combinatorially Purged Cross-Validation (overfitting check) |
| `agents.js` | Bull / Bear / Risk-Manager debate (Claude API, optional) |
| `agents-options.js` | Options Strategist — contract selection + exit triggers |
| `ml/*` | Price-target model (XGBoost): feature extraction, in-process inference, watchlist screener, offline trainer — see [ml/README.md](ml/README.md) |
| `options.js` | Alpaca options chain / order helpers |
| `hermes.js` | Post-trade analyst (Ollama → Claude API → rule-based fallback) |
| `dashboard.js` + `dashboard.html` | Express dashboard: live status, backtests, config toggles |
| `pinescript/*.pine` | TradingView overlays matching each strategy |
| `bot.js` | **Legacy** one-shot cron bot from the tutorial ([docs/legacy.md](docs/legacy.md)) |

### Strategies

| ID | Name | Timeframe |
|----|------|-----------|
| `orb` | Opening Range Breakout | 5m |
| `hybrid` | Hybrid ORB + VWAP + EMA | 5m |
| `hybrid10` | Hybrid-10 (10-min ORB + overnight hold) | 5m |
| `reversal` | Reversal + dynamic stop | 5m |
| `hybrid-reversal` | Hybrid + reversal + dynamic stop | 5m |
| `smc` | Smart Money Concepts (liquidity sweeps + BOS) | 15m |
| `vwap` | VWAP + EMA momentum | 1H |
| `vwap-reclaim` | VWAP reclaim | 5m |
| `gap-fill` | Gap fill fade | 5m |
| `first-hour-fade` | First-hour fade | 5m |
| `trend` | EMA trend following | 1D |
| `meanrev` | Mean reversion (Bollinger + RSI) | 1D |
| `momentum` | Momentum (MACD + RSI) | 1D |

---

## Quick Start

Requires **Node.js 22+** and an [Alpaca](https://alpaca.markets) account
(paper trading is free).

```bash
git clone <this-repo>
cd <repo-dir>
npm install
cp .env.example .env   # fill in your Alpaca keys
npm start              # runs bot-stream.js + dashboard.js
```

Open http://localhost:3000 for the dashboard.

Other entry points:

```bash
npm run bot        # streaming bot only
npm run backtest   # backtesting CLI
npm test           # unit tests
node dashboard.js  # dashboard only
```

## Configuration

Everything lives in `.env` (see [.env.example](.env.example) for the full
annotated list). The important ones:

| Variable | Default | Meaning |
|----------|---------|---------|
| `ALPACA_API_KEY` / `ALPACA_SECRET_KEY` | — | Alpaca credentials |
| `ALPACA_BASE_URL` | paper URL | `https://paper-api.alpaca.markets` or the live URL |
| `PAPER_TRADING` | `true` | `true` logs decisions only; `false` submits real orders to `ALPACA_BASE_URL` |
| `DASHBOARD_TOKEN` | *(empty)* | **Set this on any internet-reachable deployment.** Protects the whole dashboard; open `/?token=...` once or send an `x-dashboard-token` header |
| `ROUTER_ENABLED` | `true` | Multi-strategy router vs. single-strategy mode |
| `ROUTER_SCORE` | `winrate` | How the router ranks candidates: `winrate`, or `expectancy` (average P&L per trade; also refuses trades whose regime history loses money). In a 1-year replay `expectancy` did worse: per-regime samples are small |
| `PAPER_TRADING` / `LIVE_TRADING_CONFIRM` | `true` / — | `PAPER_TRADING=true`: no orders; trades are simulated at bar prices (source `paper`). `false` with `ALPACA_BASE_URL=https://paper-api.alpaca.markets`: real orders in Alpaca's paper account, recorded at their actual fills with slippage vs the signal (source `paper-account`). Against the live API the bot refuses to start unless `LIVE_TRADING_CONFIRM=yes`. Stock shorts are whole shares (Alpaca can't short fractional) and need a margin account with shorting enabled |
| `STOCK_ONLY_STRATEGIES` (or `stockOnlyStrategies` in bot-config.json) | — | Strategies that trade shares even when `OPTIONS_MODE` is on, e.g. `ict-2024`, whose edge is too thin for option spreads |
| `strategySymbols` (bot-config.json) | `{}` | Per-strategy symbol whitelist, e.g. `{"ict-2024": ["SPY","QQQ","DIA"]}`; a strategy with no entry trades every symbol |
| `TARGET_MODE` / `LIQUIDITY_MIN_RR` | `strategy` / `2` | `liquidity` = ICT targets: each trade aims at the nearest liquidity pool (previous-day/overnight high-low, session high-low, untaken swing points — `ict.js`) at least `LIQUIDITY_MIN_RR` × risk away, and the options premium take-profit/time exits are dropped. Off: in a 1-year stock-mode replay it cut the active strategies from +0.060R to −0.121R per trade (pools were reached on ~8% of trades) |
| `minRelVol` (hybrid / hybrid10 param) | `0` (off) | Relative-volume filter: take the opening-range breakout only if opening volume ≥ this × its 14-session average (Zarattini, Barbon & Aziz 2024). Off because at 1.0 it cut hybrid10 from +0.088R to +0.047R per trade in a 1-year replay on these symbols |
| `ACTIVE_STRATEGIES` | `hybrid,hybrid10,smc,...` | Comma list of strategy IDs the router evaluates |
| `STRATEGY` / `TIMEFRAME` | `hybrid` / `1H` | Single-strategy mode settings (trades the first entry in `SYMBOLS`) |
| `SYMBOLS` | — | Comma-separated stock symbols to stream and trade (e.g. `SPY,TSLA,QQQ,MSFT,META`). Seeds `symbols.json` in `DATA_DIR`; the dashboard's Add/Remove stock controls edit that file. No Alpaca watchlist is used |
| `CRYPTO_SYMBOLS` | *(empty)* | e.g. `BTC/USD,ETH/USD` — adds a 24/7 crypto stream |
| `CONSENSUS_MIN` | `1` | Require ≥ N strategies agreeing on a side before trading |
| `MAX_CONCURRENT_POSITIONS` | `5` | Open-position cap |
| `MAX_TRADE_SIZE_USD` / `MAX_TRADES_PER_DAY` | `100` / `3` | Hard risk caps |
| `MAX_DAILY_LOSS_PCT` | `0` (off) | Kill switch: halt new entries for the day once realized P&L hits −N% |
| `PORTFOLIO_VALUE_USD` | `1000` | Position sizing basis (max 1% risk per trade) |
| `OPTIONS_MODE` | `false` | Route stock signals through the Options Strategist (buys calls/puts) |
| `OPTIONS_DTE` / `OPTIONS_MAX_PREMIUM` / `OPTIONS_CONTRACTS` | `7` / `500` / `1` | Options trade shape |
| `ANTHROPIC_API_KEY` | *(empty)* | Enables the agent debate + Hermes LLM analysis |
| `OLLAMA_HOST` | *(empty)* | Use a local model for Hermes instead |
| `PREDICTOR_ENABLED` | `false` | Let the XGBoost price-target model veto/size router entries and steer options |
| `PREDICTOR_MIN_CONFIDENCE` / `PREDICTOR_VETO` / `PREDICTOR_SIZE_SCALING` | `0.5` / `true` / `true` | How the model gates and sizes trades (see [ml/README.md](ml/README.md)) |
| `PREDICTOR_SIGNAL_ENABLED` | `false` | **Signal mode**: the model itself generates trades (strategy id `predictor`) — target from the forecast, stop from ATR, strike/expiry from target/horizon in options mode. See [docs/xgboost-trading-plan.md](docs/xgboost-trading-plan.md) |
| `MIN_TRADES_PER_DAY` / `FLOOR_TIME_ET` | `2` / `14:30` | Soft daily floor: after this ET time, if behind, thresholds relax to the `*_FLOOR` values (still positive-edge only) |
| `TV_WEBHOOK_SECRET` | *(empty)* | Turns on TradingView alert trading: alerts POST to `/webhook/tradingview` and the bot trades them through the router. See [docs/tradingview.md](docs/tradingview.md) |
| `STRIKE_MODE` / `OPTIONS_DTE_BUFFER` | `between` / `2` | Options shaping: strike aimed at spot↔target midpoint; expiry = forecast horizon + buffer |

The dashboard writes runtime toggles (router on/off, active strategies,
crypto symbols, consensus, options mode) to `bot-config.json`, which the bot
re-reads every 30 seconds — no restart needed. Symbol changes still require a
restart (WebSocket resubscription).

## Dashboard

- Live bot status, account, positions, orders, P&L history
- Per-strategy backtests and a dedicated options backtest tab
- CPCV validation runs
- Regime statistics and learned parameters, with one-click deploy to the bot
- Hermes trade analysis and parameter suggestions
- Strategy router controls: toggle, consensus mode, symbol management
- 🔮 Screener tab: the price-target model ranks every configured symbol (price targets, horizon, confidence, signal agreement) — advisory, never trades
- Pine Script overlays served per strategy (e.g. `/api/pinescript/smc`)

**Auth:** set `DASHBOARD_TOKEN` and open the dashboard as
`https://your-app/?token=YOUR_TOKEN` (the server sets a cookie; API clients
use the `x-dashboard-token` header). Without a token the dashboard is open —
fine locally, not on the internet. `/healthz` is always unauthenticated for
platform healthchecks.

## Backtesting

```bash
node backtest.js --strategy=orb --symbol=SPY          # one strategy, one symbol
node backtest.js --strategy=predictor --symbol=TSLA --year   # the ML model (see ml/README.md)
```

The dashboard's Backtest tab runs the same engine, and the CPCV tab runs
Combinatorially Purged Cross-Validation to estimate how much of a strategy's
edge is overfitting.

### Full-system replay

`replay.js` runs the **live router** over history, not one strategy at a time:
all symbols at once, every active strategy on its native bars, the router's
choice, the predictor veto and sizing, trailing/target/near-target/time/EOD
exits, max concurrent positions and the daily loss limit. It calls the same
code as the live bot (`signals.js`), with settings from `.env` and
`bot-config.json`.

```bash
node replay.js                        # past year, 1-minute bars, live settings
node replay.js --compare-gate         # predictor gate ON vs OFF on the same data
node replay.js --mode=stock           # underlying P&L, no option-pricing assumptions
node replay.js --base=5m              # faster, coarser: 5-minute bars
node replay.js --json=replay.json     # also save every trade
```

Entries fill at the next 1-minute bar's open and exits are checked every
minute, as live. A year of 1-minute bars is cached in `DATA_DIR/cache` for
the day. 0DTE uses each symbol's expiry calendar (SPY/QQQ daily, single
stocks Mon/Wed/Fri; on other days the next listed expiry, as the live
planner does). Or use **Full-System Replay** on the dashboard's Router tab. Router win-rate
stats are walk-forward (the router only knows backtest trades that had
already closed), and a trained model is only scored after its training data.
Not simulated: the LLM agent debate, the LLM options planner (options are
priced with Black-Scholes at a flat IV, no bid/ask spread), slippage and
commissions.

## Deploying (Railway)

The repo ships Railway config (`railway.json`, `nixpacks.toml`, `Procfile`):
`node start.js` runs both processes, and the healthcheck hits `/healthz`.

1. Create a Railway project from this repo
2. Set the env vars from the table above — **including `DASHBOARD_TOKEN`**
3. Keep `PAPER_TRADING=true` until you've watched it behave for a while

State files (`trade-history.json`, `learned-params.json`, `bot-config.json`,
`trades.csv`, …) default to the repo directory, which on Railway is wiped on
every deploy. To keep learning and trade history across deploys, attach a
Railway volume and set `DATA_DIR` to its mount path (e.g. `DATA_DIR=/data`) —
all state reads/writes go through it.

## Tests

```bash
npm test
```

Unit tests cover the router's selection logic and the regime classifier, and
run in CI on every push/PR. When touching decision logic (`router.js`,
`regime.js`, `strategies/`), add a test alongside in `tests/`.

## Safety Guardrails

- `PAPER_TRADING=true` by default — nothing real is submitted until you flip it
- Hard caps: `MAX_TRADE_SIZE_USD`, `MAX_TRADES_PER_DAY`, `MAX_CONCURRENT_POSITIONS`
- Daily loss kill switch: `MAX_DAILY_LOSS_PCT` halts new entries once the day's realized P&L drops that far (set it — e.g. `5`)
- Position sizing risks at most 1% of `PORTFOLIO_VALUE_USD` per trade
- Optional consensus mode requires multiple strategies to agree
- Every decision is logged; every fill lands in `trades.csv` (tax-ready columns)
