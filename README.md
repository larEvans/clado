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
| `strategies/*.js` | Pluggable strategies — each exports `meta` + a signal function |
| `learner.js` | Trade history, per-regime stats, adaptive parameter learning |
| `backtest.js` | Backtesting engine + indicator math |
| `cpcv.js` | Combinatorially Purged Cross-Validation (overfitting check) |
| `agents.js` | Bull / Bear / Risk-Manager debate (Claude API, optional) |
| `agents-options.js` | Options Strategist — contract selection + exit triggers |
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
| `ACTIVE_STRATEGIES` | `hybrid,hybrid10,smc,...` | Comma list of strategy IDs the router evaluates |
| `STRATEGY` / `SYMBOL` / `TIMEFRAME` | `hybrid` / `SPY` / `1H` | Single-strategy mode settings |
| `CRYPTO_SYMBOLS` | *(empty)* | e.g. `BTC/USD,ETH/USD` — adds a 24/7 crypto stream |
| `CONSENSUS_MIN` | `1` | Require ≥ N strategies agreeing on a side before trading |
| `MAX_CONCURRENT_POSITIONS` | `5` | Open-position cap |
| `MAX_TRADE_SIZE_USD` / `MAX_TRADES_PER_DAY` | `100` / `3` | Hard risk caps |
| `PORTFOLIO_VALUE_USD` | `1000` | Position sizing basis (max 1% risk per trade) |
| `OPTIONS_MODE` | `false` | Route stock signals through the Options Strategist (buys calls/puts) |
| `OPTIONS_DTE` / `OPTIONS_MAX_PREMIUM` / `OPTIONS_CONTRACTS` | `7` / `500` / `1` | Options trade shape |
| `ANTHROPIC_API_KEY` | *(empty)* | Enables the agent debate + Hermes LLM analysis |
| `OLLAMA_HOST` | *(empty)* | Use a local model for Hermes instead |

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
- Pine Script overlays served per strategy (e.g. `/api/pinescript/smc`)

**Auth:** set `DASHBOARD_TOKEN` and open the dashboard as
`https://your-app/?token=YOUR_TOKEN` (the server sets a cookie; API clients
use the `x-dashboard-token` header). Without a token the dashboard is open —
fine locally, not on the internet. `/healthz` is always unauthenticated for
platform healthchecks.

## Backtesting

```bash
npm run backtest                      # defaults
STRATEGY=orb SYMBOL=SPY node backtest.js
```

The dashboard's Backtest tab runs the same engine, and the CPCV tab runs
Combinatorially Purged Cross-Validation to estimate how much of a strategy's
edge is overfitting.

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
- Position sizing risks at most 1% of `PORTFOLIO_VALUE_USD` per trade
- Optional consensus mode requires multiple strategies to agree
- Every decision is logged; every fill lands in `trades.csv` (tax-ready columns)
