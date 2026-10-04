# Price-target model (the 4th brain)

A supervised **XGBoost** regressor that predicts each symbol's forward return
and turns it into a concrete **price target + horizon + confidence**. It is
*not* an LLM — it's a gradient-boosted tree model, which is the right tool for
forecasting a number. It complements the three LLM layers (Claude debate,
Hermes, Options Strategist).

## How it plugs in

```
recent candles ─► ml/features.js ─► ml/predictor.js ─► { side, expectedReturnPct,
                  (14 features)      (XGBoost or           priceTarget, horizonDays,
                                      heuristic)            confidence }
                                          │
              ┌───────────────────────────┼───────────────────────────┐
              ▼                           ▼                            ▼
     Screener (advisory)         Router entry gate           Options Strategist
     ranks the whole             (PREDICTOR_ENABLED):        gets priceTarget +
     watchlist on the            veto/scale trades the       horizonDays → smarter
     dashboard                   model disagrees with        strike & expiry
```

Until you train a model, `predictor.js` runs a **transparent heuristic baseline**
(trend + momentum + RSI mean-reversion, scaled by ATR), so the screener and
gating work immediately. Drop in a trained `model.json` and it's used
automatically — hot-loaded on the next prediction, no restart.

## Training workflow (offline, needs Python)

The live bot is pure Node. Python is only for training.

```bash
# 1. Build the dataset from historical candles (uses your Alpaca keys)
node ml/export-dataset.js --symbols SPY,QQQ,AAPL,MSFT,NVDA,TSLA,AMD,META \
     --interval 5m --horizon 12 --out ml/dataset.csv

# 2. Train real XGBoost and export the booster to JSON
pip install xgboost numpy pandas scikit-learn
python ml/train.py --data ml/dataset.csv --horizon 12 --interval 5m

# → writes ml/model.json (feature list + trees + label stats + test metrics + split)
#   The running bot hot-loads ml/model.json, so write elsewhere with --out to
#   evaluate a model without changing live decisions.

# 3. Backtest it as a strategy, on the period it never trained on
PREDICTOR_MODEL_PATH=ml/model.json node backtest.js --strategy=predictor --symbol=TSLA --year
```

`horizon` is how many bars ahead the label looks (12 × 5m = one hour).
Keep `--interval`/`--horizon` consistent between the two commands so the horizon
metadata matches the training label.

### 0DTE training

```bash
node ml/export-dataset.js --preset=0dte --out ml/dataset-0dte.csv
python ml/train.py --data ml/dataset-0dte.csv --out /tmp/model-0dte.json
```

`--preset=0dte` = triple-barrier labels walked on **1-minute** bars (so the
barrier really touched first decides the label), only rows the live bot could
trade (9:45-15:45 ET), and labels that end by the 15:45 EOD close.

## Honest validation

`export-dataset.js` writes `ts`, `symbol` and `label_end_ts` columns (not
features). `train.py` uses them to train on the oldest 80% of the data and
test on the newest 20% (`--test-frac`), dropping training rows whose label
window runs into the test period. A random split scores much better on paper
only because neighbouring bars share most of their future-return window. The
trainer prints test accuracy next to an "always guess the common direction"
baseline, plus accuracy on the model's most confident 20% of calls. A model
is only worth using if it beats the baseline there.

`model.json` records `split.test_start_ms`. `node backtest.js --strategy=predictor`
only takes entries from that date on, using the live router's rules (entries
from 9:45 ET, one predictor trade per symbol per day, stop/target/near-target
exits, flat by 3:45 ET). Flags:

| Flag | Effect |
|------|--------|
| `--year` | a year of history instead of 60 days |
| `--timeframe=1m` | replay on 1-minute bars, which is what the live stream feeds the bot |
| `--params='{"minEdge":0.2,"minConfidence":0.5}'` | try other firing thresholds |
| `--mode=options` | price the trades as options (Black-Scholes) |
| `--include-in-sample` | also trade the training period (optimistic) |

`train.py --refit-all` retrains on everything after scoring. That model has no
unseen period left, so its backtests are in-sample and the backtester says so.

## Where the model is loaded from

`predictor.js` checks, in order:

1. `PREDICTOR_MODEL_PATH` (explicit path)
2. `$DATA_DIR/model.json` (persistent volume — survives redeploys; recommended)
3. `ml/model.json` (checked-in / bundled)

## Files

| File | Runtime | Purpose |
|------|---------|---------|
| `features.js` | Node | 14-feature vector — the single source of truth |
| `predictor.js` | Node | `predict(bars)` — XGBoost inference or heuristic fallback |
| `xgb-runtime.js` | Node | evaluates the exported booster in-process |
| `screener.js` | Node | ranks the whole watchlist for the dashboard |
| `export-dataset.js` | Node | builds the training CSV from historical candles |
| `train.py` | Python (offline) | trains real XGBoost, exports `model.json` |

## Config (see `.env.example`)

`PREDICTOR_ENABLED`, `PREDICTOR_MIN_CONFIDENCE`, `PREDICTOR_VETO`,
`PREDICTOR_SIZE_SCALING`, `PREDICTOR_HORIZON_BARS`, `PREDICTOR_BAR_MINUTES`,
`PREDICTOR_HORIZON_DAYS`, `PREDICTOR_SYMBOLS`, `PREDICTOR_MODEL_PATH`.
