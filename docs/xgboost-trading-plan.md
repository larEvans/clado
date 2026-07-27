# XGBoost Trading Strategy — Build Plan (handoff spec)

**Goal:** turn the XGBoost predictor from a *filter* into a *signal generator* that
reliably produces **≥ 2 trades/day** across the watchlist, wire in a research-grounded
path toward profitability, and surface price targets / potential trades / taken trades
on the dashboard.

**Watchlist:** SPY, TSLA, QQQ, MSFT, META, + one more (see note below).

> ⚠️ **"SPCX" is not a tradeable ticker.** SpaceX is a private company — there is no
> stock/option for it on Alpaca. Options that were likely meant: **SPCE** (Virgin
> Galactic), **SPXL** (3× S&P ETF), or just drop it. Confirm before build.

---

## 0. Honest framing on "make it profitable"

No one can *guarantee* profitability, and any plan that claims to is lying. What this
plan **can** do is (a) make the bot trade on a real, testable signal, and (b) put a
rigorous validation loop around it so profitability is *measured*, not hoped for. The
non-negotiable rule: **nothing goes live until it clears backtest + CPCV + a paper-trading
window.** Forcing a fixed number of trades/day and chasing profit are in direct tension —
see §3.4.

---

## 1. Root cause (already verified in `bot-stream.js`)

| # | Cause | Location |
|---|-------|----------|
| 1 | Predictor only gates (veto/size), never generates a signal | `onRouterBar` ~840–872 |
| 2 | Only `hybrid/hybrid10/orb/smc` emit live signals; others return `null` | `candidateSignals` 703–716 |
| 3 | Stacked frequency gates (9:45 ET, 1/symbol, 1/strategy/day, strict, consensus, capacity) | 814–847 |

---

## 2. New component: predictor as a signal generator

Create **`strategies/predictor-strat.js`** exporting `meta` + `checkSignal(bars, opts)`
in the same shape as the other strategies so it slots into the existing router with
zero special-casing.

```js
// checkSignal(bars, { atr, price, minEdge, minConfidence }) -> signal | null
// Uses ml/predictor.js predict(bars) to build a concrete trade:
//   side   = prediction.side
//   entry  = current close
//   target = prediction.priceTarget            (model's forecast)
//   stop   = entry ∓ ATR(14) * STOP_ATR_MULT   (risk defined by volatility)
// Fire only when edge is real:
//   edge = |expectedReturnPct| * confidence
//   return null unless confidence >= minConfidence AND edge >= minEdge
```

Design points:
- **Stop from ATR, target from the model.** Keeps R:R tied to real volatility and the
  model's own forecast rather than a fixed %.
- **Reject weak forecasts.** The `minEdge`/`minConfidence` thresholds are what keep this
  from trading noise. These are the primary tunables (§4).
- **Reuse `ml/features.js` + `ml/predictor.js`** — no duplicate feature logic.

### Router integration (`bot-stream.js`)
1. Add `"predictor"` (or `"ml"`) as a recognized strategy in `candidateSignals`
   (703–716): `if (strategy === "predictor") return predictorStratSignal(barBuffer, {...})`.
2. Add it to `ACTIVE_STRATEGIES` default so it's in the candidate pool.
3. **Turn off self-veto when the predictor is the signal source.** In the predictor
   gate block (840–872), skip veto/size-scaling for candidates whose strategy is
   `"predictor"` (the model already generated it — don't let it veto itself).
4. Keep the existing gates (capacity, daily-loss, one-position-per-symbol) — those are
   sound risk controls.

---

## 3. Hitting "≥ 2 trades/day" — without wrecking edge

### 3.1 Evaluate every symbol every bar
The predictor strategy runs on all 6 watchlist symbols on each 5-min bar, so there are
~6 × 78 = ~468 evaluation opportunities/day. With sane thresholds this comfortably
produces multiple candidates.

### 3.2 Rank + take top-N (new)
Add a per-bar **cross-symbol ranking**: collect all predictor candidates that clear the
threshold, rank by `edge`, and open the best ones up to `MAX_CONCURRENT`. This is the
`ml/screener.js` logic reused in the live path.

### 3.3 Daily floor (soft, two-tier)
New config `MIN_TRADES_PER_DAY=2`. Track `tradesToday` (new counter in `routerDay`).
Two tiers:
- **Tier 1 (default threshold)** all session.
- **Tier 2 (relaxed threshold)** after `FLOOR_TIME_ET` (default 14:30 ET / 1.5h before
  close): if `tradesToday < MIN_TRADES_PER_DAY`, lower `minConfidence`/`minEdge` to a
  `*_FLOOR` value and take the **highest-ranked** remaining picks to make up the
  shortfall. Never trades a *negative*-edge pick — it only relaxes *how strong* the edge
  must be, never the *direction*.

### 3.4 ⚠️ The tension, stated plainly
A hard minimum forces trades on low-conviction days, which lowers expectancy. Recommended
default: **soft floor** (Tier 2) rather than "always exactly 2." Make it a config toggle
`FORCE_MIN_TRADES` (default `false` = aim-for, `true` = guarantee). Document that `true`
is for testing/among-friends, not for maximizing P&L.

---

## 4. Path to profitability (research-grounded, uses tooling already in repo)

Draws on standard financial-ML practice (López de Prado, *Advances in Financial Machine
Learning*) — the repo already ships `cpcv.js` (Combinatorially Purged CV) for exactly this.

1. **Better labels — triple-barrier method.** Replace the current fixed-horizon
   forward-return label in `ml/export-dataset.js` with a triple-barrier label: for each
   bar, set profit-take / stop / time barriers (from ATR) and label by which is hit
   first. This trains the model on outcomes that match how the bot actually exits.
2. **Meta-labeling (optional, high value).** A second model that predicts *whether to
   act* on the primary signal, sized by its confidence — López de Prado's precision-booster.
3. **Sample weighting + purged CV.** Weight overlapping samples down; validate with the
   existing CPCV so the reported edge isn't an overfit artifact.
4. **Threshold tuning as an optimization.** Sweep `minEdge`/`minConfidence` on the
   backtest to the point that maximizes out-of-sample Sharpe / expectancy while still
   yielding ≥ 2 trades/day. This is *the* knob that decides profitability vs. noise.
5. **Per-symbol calibration.** TSLA and SPY have very different vol; either train
   per-symbol models or include symbol-normalized features (ATR%, not raw ATR — already
   done in `features.js`). Verify feature scaling per symbol.
6. **Walk-forward retraining.** A scheduled job (or `learner.js` hook) that retrains
   weekly on rolling data so the model tracks regime drift.
7. **Go-live gate.** Live only after: positive CPCV expectancy **and** a green paper-trading
   window (`PAPER_TRADING=true`) of ≥ N sessions. Bake this into the runbook.

Deliverable for this workstream: extend `backtest.js` to run the predictor strategy so
steps 1, 4, 5 are measurable before any live change.

---

## 5. Dashboard changes (price targets · potential trades · taken trades)

**Data plumbing first:** the bot (`bot-stream.js`) and dashboard (`dashboard.js`) are
separate processes, so the bot must persist what it sees. Add a state file (via
`state.js` `dataPath`) e.g. `predictions.json`, written each bar:
```
{ generatedAt, perSymbol: [{symbol, side, price, priceTarget, expectedReturnPct,
   horizonDays, confidence, wouldFire, threshold}], taken: [{...trade..., prediction}] }
```

Three dashboard views (extend the existing 🔮 Screener tab or add a "Predictions" tab):

1. **Price Targets** — table of all 6 symbols: current price, model target, expected
   return %, horizon, confidence, LONG/SHORT bias. (Screener already renders most of
   this via `/api/screener`; point it at live `predictions.json` so it matches what the
   bot actually saw, not a fresh recompute.)
2. **Potential Trades** — the subset where `wouldFire = true` (cleared threshold) but
   weren't taken (capacity, already in position, below floor). Shows *why* skipped.
3. **Trades Taken** — executed trades joined to the **prediction that drove them**
   (target vs. actual, confidence, hit/stop/near-target outcome). Pull from the existing
   trade log + `predictions.json`.

New endpoint `GET /api/predictions` in `dashboard.js` serving the three sections from
`predictions.json` + trade history. Add auto-refresh (the tab already has a Refresh
button pattern).

---

## 6. Config additions (`.env.example`)

```
PREDICTOR_SIGNAL_ENABLED=true     # predictor generates signals (not just gates)
PREDICTOR_MIN_EDGE=0.35           # min |expReturn%| × confidence to fire
PREDICTOR_MIN_CONFIDENCE=0.55     # min model confidence to fire
STOP_ATR_MULT=1.5                 # stop distance = ATR × this
MIN_TRADES_PER_DAY=2              # daily floor
FORCE_MIN_TRADES=false            # false = soft target, true = guarantee (lower EV)
FLOOR_TIME_ET=14:30               # when Tier-2 relaxation kicks in
PREDICTOR_MIN_EDGE_FLOOR=0.15     # relaxed threshold for the floor
```

---

## 7. Testing / validation checklist

- Unit: `strategies/predictor-strat.js` returns null below threshold, a well-formed
  signal above it, correct side/stop/target (extend `tests/predictor.test.js`).
- Unit: daily-floor logic (Tier 2 fires only when short and only on positive edge).
- Backtest: predictor strategy over ≥ 1yr, report trades/day, win rate, expectancy, Sharpe.
- CPCV: confirm the edge survives purged cross-validation.
- Paper: run `PAPER_TRADING=true` and verify ≥ 2 trades/day appear in "Trades Taken".

---

## 8. File-by-file task list for Fable 5

| File | Change |
|------|--------|
| `strategies/predictor-strat.js` | **NEW** — `meta` + `checkSignal` signal generator |
| `ml/predictor.js` | expose what's needed (already exports `predict`); no change likely |
| `bot-stream.js` | register `predictor` in `candidateSignals`; skip self-veto; cross-symbol ranking; `tradesToday` counter; daily-floor (Tier 2); write `predictions.json` each bar |
| `ml/export-dataset.js` | triple-barrier labeling option |
| `backtest.js` | run predictor strategy in backtest; report trades/day + expectancy |
| `dashboard.js` | `GET /api/predictions`; read `predictions.json` + trade log |
| `dashboard.html` | Price Targets / Potential Trades / Trades Taken views |
| `.env.example` | new config keys (§6) |
| `state.js` | (reuse `dataPath`) — no change |
| `tests/predictor.test.js` | extend: signal generation + floor logic |
| `docs/` | update README ML section |

---

## 9. Decisions to confirm before build (defaults in **bold**)

1. **6th ticker:** replace SPCX with **SPCE** / SPXL / drop? *(SpaceX isn't tradeable.)*
2. **Instrument:** trade **shares** or route through options (`OPTIONS_MODE`)? Options
   need the strike/expiry logic already stubbed in `agents-options.js`.
3. **Daily floor:** **soft target** (aim for 2, keep EV) or hard `FORCE_MIN_TRADES`?
4. **Risk/trade:** default **1% of `PORTFOLIO_VALUE_USD`** per position — confirm size.
5. **Model:** keep the single global model, or move to **per-symbol** models?
```
```
