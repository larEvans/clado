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

Output: ml/model.json  (feature list + trees + base_score + label stats + metrics)
"""

import argparse
import json
import datetime as dt

import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.model_selection import train_test_split
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
    args = ap.parse_args()

    df = pd.read_csv(args.data)
    label_col = "fwd_return"
    feature_names = [c for c in df.columns if c != label_col]
    X = df[feature_names].values.astype(np.float32)
    y = df[label_col].values.astype(np.float32)
    print(f"Loaded {len(df):,} rows · {len(feature_names)} features")

    # Time-ordered split is safer for markets, but the exporter interleaves
    # symbols, so a plain holdout is a reasonable, honest sanity check.
    X_tr, X_te, y_tr, y_te = train_test_split(X, y, test_size=0.2, random_state=42)

    model = xgb.XGBRegressor(
        objective="reg:squarederror",
        n_estimators=args.n_estimators,
        max_depth=args.max_depth,
        learning_rate=args.learning_rate,
        subsample=args.subsample,
        colsample_bytree=args.colsample,
        random_state=42,
        n_jobs=-1,
    )
    model.fit(X_tr, y_tr, eval_set=[(X_te, y_te)], verbose=False)

    pred = model.predict(X_te)
    rmse = float(np.sqrt(mean_squared_error(y_te, pred)))
    mae = float(mean_absolute_error(y_te, pred))
    # Directional accuracy — the metric that actually matters for trade gating.
    dir_acc = float(np.mean(np.sign(pred) == np.sign(y_te)))
    print(f"Holdout  RMSE={rmse:.4f}  MAE={mae:.4f}  DirAcc={dir_acc*100:.1f}%")

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
            "mean": float(np.mean(y)),
            "std": float(np.std(y)),
        },
        "metrics": {"rmse": rmse, "mae": mae, "dir_acc": dir_acc, "n_samples": int(len(df))},
        "n_estimators": args.n_estimators,
        "max_depth": args.max_depth,
        "trained_at": dt.datetime.utcnow().isoformat() + "Z",
        "trees": trees,
    }
    with open(args.out, "w") as f:
        json.dump(out, f)
    print(f"Wrote {args.out}  ({len(trees)} trees)")
    print("The bot will hot-load it on the next prediction (no restart needed).")


if __name__ == "__main__":
    main()
