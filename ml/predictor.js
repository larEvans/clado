/**
 * ml/predictor.js — the 4th brain: a supervised price-target model.
 *
 * Unlike the three LLM/agent layers (Claude debate, Hermes, Options Strategist),
 * this is a numeric regression model that predicts the forward return of a
 * symbol from its recent price action, and turns that into a concrete price
 * target + horizon + confidence.
 *
 *   predict(bars) → {
 *     side,              // "buy" | "sell"
 *     expectedReturnPct, // model's forecast forward return (%)
 *     priceTarget,       // price * (1 + expectedReturnPct/100)
 *     horizonDays,       // forecast horizon, in days (drives options DTE)
 *     confidence,        // 0..1
 *     source,            // "xgboost" | "heuristic"
 *     price,             // last close used
 *   }
 *
 * When a trained model (ml/model.json, or PREDICTOR_MODEL_PATH, or one dropped
 * in DATA_DIR) is present it is used. Otherwise a transparent heuristic baseline
 * runs so the screener and gating work end-to-end before you've trained anything.
 */

import { readFileSync, existsSync, statSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { extractFeatures, MIN_BARS, featuresAsObject } from "./features.js";
import { compileModel, predictRaw } from "./xgb-runtime.js";
import { dataPath } from "../state.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Interval (in minutes) of the bars the model was trained on, so we can turn a
// horizon expressed in bars into a horizon in days. Overridable per deploy.
const BAR_MINUTES = Number(process.env.PREDICTOR_BAR_MINUTES || 5);
// Fallback horizon (days) used by the heuristic and when the model omits one.
const DEFAULT_HORIZON_DAYS = Number(process.env.PREDICTOR_HORIZON_DAYS || 5);

// ── Model loading (cached, hot-reloaded on file mtime change) ─────────────────

function candidatePaths() {
  const paths = [];
  if (process.env.PREDICTOR_MODEL_PATH) paths.push(process.env.PREDICTOR_MODEL_PATH);
  paths.push(dataPath("model.json"));       // persistent volume (survives redeploys)
  paths.push(join(__dirname, "model.json")); // checked-in / bundled model
  return paths;
}

let _cache = { path: null, mtimeMs: 0, compiled: null, meta: null };

function loadModel() {
  for (const p of candidatePaths()) {
    if (!p || !existsSync(p)) continue;
    const mtimeMs = statSync(p).mtimeMs;
    if (_cache.path === p && _cache.mtimeMs === mtimeMs) return _cache; // unchanged
    try {
      const raw = JSON.parse(readFileSync(p, "utf8"));
      _cache = { path: p, mtimeMs, compiled: compileModel(raw), meta: raw };
      console.log(`[Predictor] loaded XGBoost model from ${p} (${(raw.trees || []).length} trees, trained ${raw.trained_at || "?"})`);
      return _cache;
    } catch (e) {
      console.warn(`[Predictor] failed to load model at ${p}: ${e.message}`);
    }
  }
  if (_cache.path) _cache = { path: null, mtimeMs: 0, compiled: null, meta: null };
  return _cache;
}

/** Is a trained model available right now? */
export function hasModel() {
  return !!loadModel().compiled;
}

/** Metadata about the loaded model (or null): trained_at, metrics, horizon… */
export function modelInfo() {
  const c = loadModel();
  if (!c.meta) return null;
  const { trees, ...meta } = c.meta; // omit the bulky tree array
  return { ...meta, tree_count: (trees || []).length, path: c.path };
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function horizonDaysFrom(meta) {
  const bars = meta?.horizon_bars;
  if (bars && BAR_MINUTES) {
    // ~390 trading minutes per session; convert bar-count → trading days, min 1.
    return Math.max(1, Math.round((bars * BAR_MINUTES) / 390));
  }
  return DEFAULT_HORIZON_DAYS;
}

// ── Heuristic baseline (used until a model is trained) ────────────────────────
//
// Transparent, no magic: blend trend (ema spread + slope), momentum, and a mild
// RSI mean-reversion tilt, then scale the forecast by the symbol's own ATR% so
// the expected move is in a realistic range for that volatility.
function heuristicPredict(f, price) {
  const [ret1, ret5, ret10, , emaSpread, emaSlope, rsi14, atrPct, , , , , , mom10] = f;
  const trend = clamp(emaSpread * 0.6 + emaSlope * 0.4, -3, 3);
  const momo  = clamp(mom10 * 0.5 + (ret5 + ret10) * 0.05, -3, 3);
  const meanRev = rsi14 > 70 ? -0.5 : rsi14 < 30 ? 0.5 : 0; // fade extremes
  const rawScore = trend + momo + meanRev; // roughly -6..6
  const direction = Math.sign(rawScore) || (ret1 >= 0 ? 1 : -1);
  const scale = clamp(atrPct || 0.5, 0.2, 5);          // expected-move size ~ volatility
  const expectedReturnPct = clamp(direction * scale * clamp(Math.abs(rawScore) / 3, 0.15, 1.2), -6, 6);
  const confidence = clamp(Math.abs(rawScore) / 6, 0.05, 0.75); // heuristic never fully confident
  return { expectedReturnPct, confidence };
}

// ── Model-based prediction ────────────────────────────────────────────────────

function modelPredict(compiled, meta, f) {
  const expectedReturnPct = predictRaw(compiled, f); // model target is forward return in %
  // Confidence: how large is the forecast relative to the label's own spread?
  // A move of ~1 std → ~0.6 confidence; capped into (0.05, 0.95).
  const std = Number(meta?.label?.std) || 1;
  const confidence = clamp(Math.abs(expectedReturnPct) / (2 * std), 0.05, 0.95);
  return { expectedReturnPct, confidence };
}

/**
 * Main entry point. `bars` = { open, high, low, close, volume } oldest→newest.
 * Returns a prediction object (never throws for well-formed input).
 */
export function predict(bars, opts = {}) {
  const n = Array.isArray(bars) ? bars.length : 0;
  const price = n ? bars[n - 1].close : 0;
  const f = extractFeatures(bars);

  const { compiled, meta } = loadModel();
  const base = compiled
    ? { ...modelPredict(compiled, meta, f), source: "xgboost" }
    : { ...heuristicPredict(f, price), source: "heuristic" };

  // Penalize confidence when we don't have enough history for stable features.
  let confidence = base.confidence;
  if (n < MIN_BARS) confidence *= clamp(n / MIN_BARS, 0, 1);

  const expectedReturnPct = base.expectedReturnPct;
  const priceTarget = price * (1 + expectedReturnPct / 100);
  const horizonDays = opts.horizonDays || horizonDaysFrom(meta);

  return {
    side: expectedReturnPct >= 0 ? "buy" : "sell",
    expectedReturnPct,
    priceTarget,
    horizonDays,
    confidence: clamp(confidence, 0, 1),
    source: base.source,
    price,
    bars: n,
    features: opts.withFeatures ? featuresAsObject(bars) : undefined,
  };
}
