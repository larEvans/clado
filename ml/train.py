#!/usr/bin/env python3
"""
ml/train.py — train the REAL XGBoost price-target model.

This is the only part of the system that needs Python + xgboost, and it runs
OFFLINE. It reads the CSV produced by `node ml/export-dataset.js`, trains a
gradient-boosted regressor to predict the forward return (%), and exports the
booster as a plain JSON tree dump into ml/model.json. The live Node bot walks
those trees in-process (ml/xgb-runtime.js) — no Python in the trading path.

Usage:
    pip install xgboost numpy pandas scikit-learn
    python ml/train.py --data ml/dataset.csv --horizon 12 --interval 5m

Validation is a TIME-ORDERED split: the model trains on the oldest
(1 - test_frac) of the data and is scored on the newest test_frac, which it
has never seen, the same situation it faces live. Training rows whose label
window reaches into the test period are purged (neighbouring bars share most
of their forward-return window, so keeping them leaks test outcomes into
training). A random split, which this script used to do, inflates accuracy.

The exported model is the one trained WITHOUT the test period, and model.json
records split.test_start_ms, so backtest.js can run the predictor on data the
model never saw. --refit-all instead retrains on everything for production;
that model has no clean out-of-sample window left to backtest.

Output: ml/model.json  (feature list + trees + base_score + label stats + metrics + split)
"""

import argparse
import json
import datetime as dt

import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.metrics import mean_squared_error, mean_absolute_error


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="ml/dataset.csv")
    ap.add_argument("--out", default="ml/model.json")
    ap.add_argument("--horizon", type=int, default=12, help="label horizon in bars (metadata)")
    ap.add_argument("--interval", default="5m", help="bar interval (metadata)")
    ap.add_argument("--n-estimators", type=int, default=300)
    ap.add_argument("--max-depth", type=int, default=5)
    ap.add_argument("--learning-rate", type=float, default=0.05)
    ap.add_argument("--subsample", type=float, default=0.8)
    ap.add_argument("--colsample", type=float, default=0.8)
    ap.add_argument("--test-frac", type=float, default=0.2, help="newest fraction of the data held out for testing")
    ap.add_argument("--refit-all", action="store_true",
                    help="after scoring, retrain on ALL rows for production (leaves no out-of-sample window to backtest)")
    args = ap.parse_args()

    df = pd.read_csv(args.data)
    label_col = "fwd_return"
    meta_cols = [c for c in ("ts", "symbol", "label_end_ts") if c in df.columns]
    feature_names = [c for c in df.columns if c != label_col and c not in meta_cols]
    print(f"Loaded {len(df):,} rows, {len(feature_names)} features")

    if "ts" in df.columns:
        df = df.sort_values("ts", kind="stable").reset_index(drop=True)
        test_start = int(df["ts"].quantile(1 - args.test_frac))
        test_mask = (df["ts"] >= test_start).values
        # Purge: drop training rows whose label window ends inside the test period.
        label_end = df["label_end_ts"] if "label_end_ts" in df.columns else df["ts"]
        train_mask = (label_end < test_start).values & ~test_mask
        n_purged = int((~test_mask).sum() - train_mask.sum())
        iso = lambda ms: pd.to_datetime(int(ms), unit="ms", utc=True).isoformat()
        split = {
            "method": "time",
            "test_frac": args.test_frac,
            "test_start_ms": test_start,
            "test_start_iso": iso(test_start),
            "train_start_iso": iso(df["ts"].iloc[0]),
            "data_end_iso": iso(df["ts"].iloc[-1]),
            "n_train": int(train_mask.sum()),
            "n_test": int(test_mask.sum()),
            "n_purged": n_purged,
        }
        print(f"Time split: train {split['train_start_iso'][:10]} -> {split['test_start_iso'][:10]} "
              f"({split['n_train']:,} rows, {n_purged:,} purged) | test {split['test_start_iso'][:10]} -> "
              f"{split['data_end_iso'][:10]} ({split['n_test']:,} rows)")
    else:
        # Old dataset without timestamps: fall back to a random split, but say
        # loudly that its score is optimistic, and record that in model.json.
        print("WARNING: dataset has no 'ts' column - re-export it with `node ml/export-dataset.js`.")
        print("WARNING: using a RANDOM split; the accuracy below is inflated by overlapping labels.")
        rng = np.random.default_rng(42)
        test_mask = rng.random(len(df)) < args.test_frac
        train_mask = ~test_mask
        split = {"method": "random (leaky)", "test_frac": args.test_frac, "test_start_ms": None,
                 "n_train": int(train_mask.sum()), "n_test": int(test_mask.sum()), "n_purged": 0}

    X = df[feature_names].values.astype(np.float32)
    y = df[label_col].values.astype(np.float32)
    X_tr, y_tr, X_te, y_te = X[train_mask], y[train_mask], X[test_mask], y[test_mask]
    if len(X_tr) == 0 or len(X_te) == 0:
        raise SystemExit("Not enough data for a train/test split - export more history.")

    def make_model():
        return xgb.XGBRegressor(
            objective="reg:squarederror",
            n_estimators=args.n_estimators,
            max_depth=args.max_depth,
            learning_rate=args.learning_rate,
            subsample=args.subsample,
            colsample_bytree=args.colsample,
            random_state=42,
            n_jobs=-1,
        )

    model = make_model()
    model.fit(X_tr, y_tr, verbose=False)   # the test set plays no part in fitting
    y_fit = y_tr                            # labels the shipped model was fit on

    pred = model.predict(X_te)
    rmse = float(np.sqrt(mean_squared_error(y_te, pred)))
    mae = float(mean_absolute_error(y_te, pred))
    # Directional accuracy - the metric that actually matters for trade gating.
    dir_acc = float(np.mean(np.sign(pred) == np.sign(y_te)))
    # Baseline: always guess the direction that was most common in training.
    # The model is only useful if it beats this.
    majority = 1.0 if np.mean(y_tr > 0) >= 0.5 else -1.0
    baseline_dir_acc = float(np.mean(np.sign(y_te) == majority))
    # Accuracy on the model's most confident 20% - roughly the trades that
    # would clear the live minEdge/minConfidence thresholds.
    top = np.abs(pred) >= np.quantile(np.abs(pred), 0.8)
    dir_acc_top20 = float(np.mean(np.sign(pred[top]) == np.sign(y_te[top])))
    print(f"Test     RMSE={rmse:.4f}  MAE={mae:.4f}")
    print(f"DirAcc   all={dir_acc*100:.1f}%  most-confident-20%={dir_acc_top20*100:.1f}%  "
          f"baseline(always {'up' if majority > 0 else 'down'})={baseline_dir_acc*100:.1f}%")

    per_symbol = {}
    if "symbol" in df.columns:
        syms = df["symbol"].values[test_mask]
        for sym in sorted(set(syms)):
            m = syms == sym
            per_symbol[sym] = {"n": int(m.sum()), "dir_acc": float(np.mean(np.sign(pred[m]) == np.sign(y_te[m])))}
        print("Per symbol: " + "  ".join(f"{k} {v['dir_acc']*100:.1f}%" for k, v in per_symbol.items()))

    if args.refit_all:
        print("Refitting on ALL rows (--refit-all): the shipped model has seen the test period,")
        print("so backtests of it are in-sample.")
        model = make_model()
        model.fit(X, y, verbose=False)
        y_fit = y
        split["refit_all"] = True
        split["test_start_ms"] = None

    booster = model.get_booster()
    booster.feature_names = feature_names  # so splits dump as real feature names
    trees = [json.loads(t) for t in booster.get_dump(dump_format="json")]

    # base_score (global bias) lives in the learner config in modern xgboost.
    try:
        cfg = json.loads(booster.save_config())
        base_score = float(cfg["learner"]["learner_model_param"]["base_score"])
    except Exception:
        base_score = 0.5

    out = {
        "format": "xgb-json-dump-v1",
        "objective": "reg:squarederror",
        "base_score": base_score,
        "feature_names": feature_names,
        "horizon_bars": args.horizon,
        "interval": args.interval,
        "label": {
            "mean": float(np.mean(y_fit)),
            "std": float(np.std(y_fit)),
        },
        "metrics": {
            "rmse": rmse, "mae": mae, "dir_acc": dir_acc,
            "dir_acc_top20": dir_acc_top20, "baseline_dir_acc": baseline_dir_acc,
            "per_symbol": per_symbol, "n_samples": int(len(df)),
        },
        "split": split,
        "n_estimators": args.n_estimators,
        "max_depth": args.max_depth,
        "trained_at": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
        "trees": trees,
    }
    with open(args.out, "w") as f:
        json.dump(out, f)
    print(f"Wrote {args.out}  ({len(trees)} trees)")
    print("The bot will hot-load it on the next prediction (no restart needed).")


if __name__ == "__main__":
    main()
