/**
 * ml/features.js — the single source of truth for the numeric feature vector
 * the price-target model consumes.
 *
 * The SAME function is used in three places, so the model never sees a feature
 * computed one way at training time and a different way at inference time:
 *   1. ml/export-dataset.js   — build the training CSV from historical candles
 *   2. ml/predictor.js        — live inference inside the bot / options planner
 *   3. ml/screener.js         — the watchlist advisory screener
 *
 * Bars are `{ open, high, low, close, volume }` oldest → newest. Every helper
 * returns a finite number (0 when there isn't enough data) so the feature
 * vector is always the same fixed length — XGBoost needs a stable column order.
 */

import { ema, atr } from "../indicators.js";

// Order matters and must stay stable: train.py writes columns in this order,
// and xgb-runtime.js indexes features by position (f0, f1, …).
export const FEATURE_NAMES = [
  "ret_1",        // 1-bar return (%)
  "ret_5",        // 5-bar return (%)
  "ret_10",       // 10-bar return (%)
  "ret_20",       // 20-bar return (%)
  "ema9_21_spread", // (ema9 - ema21) / price (%) — trend direction/strength
  "ema9_slope",   // ema9 change over last 5 bars (%)
  "rsi_14",       // 0..100
  "atr_pct",      // ATR(14) / price (%) — volatility
  "realized_vol", // stdev of 1-bar returns over 20 (%)
  "range_pos",    // where price sits in the trailing 20-bar high/low range (0..1)
  "vol_ratio",    // last volume / avg 20-bar volume
  "dist_hi_20",   // (high20 - price) / price (%) — headroom to recent high
  "dist_lo_20",   // (price - low20) / price (%) — cushion above recent low
  "momentum_10",  // (price - close[-10]) / atr — normalized momentum
];

export const FEATURE_COUNT = FEATURE_NAMES.length;

// Minimum bars needed before the vector is meaningful. Below this we still
// return a full-length vector (zero-padded) but callers should treat the
// prediction as low-confidence.
export const MIN_BARS = 25;

function pctReturn(bars, lookback) {
  const n = bars.length;
  if (n <= lookback) return 0;
  const now = bars[n - 1].close;
  const then = bars[n - 1 - lookback].close;
  if (!then) return 0;
  return ((now - then) / then) * 100;
}

function rsi(bars, period = 14) {
  const n = bars.length;
  if (n <= period) return 50;
  let gain = 0, loss = 0;
  for (let i = n - period; i < n; i++) {
    const d = bars[i].close - bars[i - 1].close;
    if (d >= 0) gain += d; else loss -= d;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  const rs = (gain / period) / (loss / period);
  return 100 - 100 / (1 + rs);
}

function realizedVol(bars, period = 20) {
  const n = bars.length;
  if (n <= period) return 0;
  const rets = [];
  for (let i = n - period; i < n; i++) {
    const prev = bars[i - 1].close;
    if (prev) rets.push((bars[i].close - prev) / prev);
  }
  if (rets.length === 0) return 0;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varc = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  return Math.sqrt(varc) * 100;
}

function highLow(bars, period = 20) {
  const slice = bars.slice(-period);
  let hi = -Infinity, lo = Infinity;
  for (const b of slice) { if (b.high > hi) hi = b.high; if (b.low < lo) lo = b.low; }
  return { hi, lo };
}

const finite = (x, fallback = 0) => (Number.isFinite(x) ? x : fallback);

/**
 * Turn a bar buffer into the fixed-length feature vector (array of numbers,
 * aligned to FEATURE_NAMES). Never throws; pads with zeros when data is short.
 */
export function extractFeatures(bars) {
  if (!Array.isArray(bars) || bars.length === 0) {
    return new Array(FEATURE_COUNT).fill(0);
  }
  const n = bars.length;
  const price = bars[n - 1].close || 0;
  const closes = bars.map(b => b.close);

  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema9Prev = ema(closes.slice(0, n - 5), 9); // ema9 five bars ago
  const a = atr(bars, 14);
  const { hi, lo } = highLow(bars, 20);
  const avgVol = bars.slice(-20).reduce((s, b) => s + (b.volume || 0), 0) / Math.min(20, n);
  const lastVol = bars[n - 1].volume || 0;

  const emaSpread = ema9 != null && ema21 != null && price ? ((ema9 - ema21) / price) * 100 : 0;
  const emaSlope = ema9 != null && ema9Prev != null && ema9Prev ? ((ema9 - ema9Prev) / ema9Prev) * 100 : 0;
  const atrPct = a != null && price ? (a / price) * 100 : 0;
  const rangePos = hi > lo ? (price - lo) / (hi - lo) : 0.5;
  const volRatio = avgVol > 0 ? lastVol / avgVol : 1;
  const distHi = price ? ((hi - price) / price) * 100 : 0;
  const distLo = price ? ((price - lo) / price) * 100 : 0;
  const mom10 = a && n > 10 ? (price - bars[n - 11].close) / a : 0;

  return [
    finite(pctReturn(bars, 1)),
    finite(pctReturn(bars, 5)),
    finite(pctReturn(bars, 10)),
    finite(pctReturn(bars, 20)),
    finite(emaSpread),
    finite(emaSlope),
    finite(rsi(bars, 14), 50),
    finite(atrPct),
    finite(realizedVol(bars, 20)),
    finite(rangePos, 0.5),
    finite(volRatio, 1),
    finite(distHi),
    finite(distLo),
    finite(mom10),
  ];
}

/** Convenience: feature vector as a { name: value } object (for the dashboard). */
export function featuresAsObject(bars) {
  const v = extractFeatures(bars);
  return Object.fromEntries(FEATURE_NAMES.map((name, i) => [name, v[i]]));
}
