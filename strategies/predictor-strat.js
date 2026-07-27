/**
 * Predictor strategy — the XGBoost price-target model as a PRIMARY signal
 * source, not just a gate. This is what makes the model actually create
 * trades: it forecasts the forward return for a symbol, and when the
 * conviction-weighted edge clears the threshold it emits a full signal
 * (side / entry / stop / target) in the same shape as every other strategy,
 * so the router treats it like any other candidate.
 *
 *   side    model direction
 *   entry   current close
 *   target  the model's priceTarget (forecast, not a fixed % offset)
 *   stop    entry ∓ ATR(14) × stopAtrMult — risk sized by real volatility
 *
 * Firing rule: edge = |expectedReturnPct| × confidence must be ≥ minEdge
 * AND confidence ≥ minConfidence. These two thresholds are the knobs that
 * separate "trades signal" from "trades noise" — tune them via backtest.
 *
 * Daily floor support: effectiveThresholds() implements the two-tier
 * relaxation — after floorTimeET, if the bot is short of minTradesPerDay,
 * thresholds drop to the *_Floor values (a weaker but still positive edge).
 * It never flips direction or accepts a negative-edge trade.
 */

import { atr } from "../indicators.js";
import { predict } from "../ml/predictor.js";

export const meta = {
  id:          "predictor",
  name:        "XGBoost Price-Target",
  description: "Supervised price-target model as a primary signal source. Forecasts forward return per symbol; fires when conviction-weighted edge clears the threshold. Target from the model, stop from ATR.",
  timeframe:   "5m",
  watchlist:   ["SPY", "TSLA", "QQQ", "MSFT", "META"],
  params: {
    minEdge:        0.35,  // min |expectedReturnPct| × confidence
    minConfidence:  0.55,  // min model confidence
    stopAtrMult:    1.5,   // stop distance in ATRs
    // Reward/risk floor. 0.5 by default: the model's expected move is scaled
    // by the symbol's own ATR, so demanding reward > full stop distance would
    // reject most honest short-horizon forecasts and strangle trade frequency.
    // Raise toward 1.0+ once a trained model produces larger targets.
    minRR:          0.5,
  },
};

/**
 * Two-tier thresholds for the daily trade floor. Pure function → unit-testable.
 *
 * @param {object} o
 *   etMins          minutes since midnight ET (current time)
 *   tradesToday     trades opened so far today
 *   minTradesPerDay the floor (e.g. 2); 0 disables tier 2
 *   floorTimeMins   ET minutes when tier 2 unlocks (e.g. 14:30 → 870)
 *   base            { minEdge, minConfidence }
 *   floor           { minEdge, minConfidence } — relaxed tier-2 values
 * @returns {{ minEdge, minConfidence, tier }}
 */
export function effectiveThresholds({ etMins, tradesToday, minTradesPerDay, floorTimeMins, base, floor }) {
  const behindFloor = minTradesPerDay > 0 && tradesToday < minTradesPerDay;
  if (behindFloor && etMins >= floorTimeMins) {
    return { minEdge: floor.minEdge, minConfidence: floor.minConfidence, tier: 2 };
  }
  return { minEdge: base.minEdge, minConfidence: base.minConfidence, tier: 1 };
}

/**
 * Evaluate the model on a bar buffer and return a router-shaped signal or null.
 * Also returns the raw prediction on the signal (and via evaluatePrediction
 * below) so callers can log/display "what the model saw" even when it didn't fire.
 */
export function checkSignal(bars, params = meta.params) {
  const ev = evaluatePrediction(bars, params);
  return ev.signal;
}

/**
 * Like checkSignal but always returns the prediction + why it did/didn't fire —
 * used by the bot to persist the "potential trades" view for the dashboard.
 * @returns {{ signal: object|null, prediction: object|null, wouldFire: boolean, skipReason: string|null, edge: number }}
 */
export function evaluatePrediction(bars, params = meta.params) {
  if (!Array.isArray(bars) || bars.length < 25) {
    return { signal: null, prediction: null, wouldFire: false, skipReason: "insufficient bars", edge: 0 };
  }

  let prediction;
  try {
    prediction = predict(bars);
  } catch (e) {
    return { signal: null, prediction: null, wouldFire: false, skipReason: `predict failed: ${e.message}`, edge: 0 };
  }

  const edge = Math.abs(prediction.expectedReturnPct) * prediction.confidence;
  const entry = prediction.price;

  if (prediction.confidence < params.minConfidence) {
    return { signal: null, prediction, wouldFire: false, skipReason: `confidence ${(prediction.confidence).toFixed(2)} < ${params.minConfidence}`, edge };
  }
  if (edge < params.minEdge) {
    return { signal: null, prediction, wouldFire: false, skipReason: `edge ${edge.toFixed(2)} < ${params.minEdge}`, edge };
  }

  const a = atr(bars, 14);
  if (!a || !entry) {
    return { signal: null, prediction, wouldFire: false, skipReason: "no ATR/price", edge };
  }

  const stopDist = a * (params.stopAtrMult || 1.5);
  const side = prediction.side;
  const stop = side === "buy" ? entry - stopDist : entry + stopDist;
  const target = prediction.priceTarget;

  // Reward must be on the right side of entry and worth the risk.
  const reward = side === "buy" ? target - entry : entry - target;
  if (reward <= 0) {
    return { signal: null, prediction, wouldFire: false, skipReason: "target not beyond entry", edge };
  }
  if (reward / stopDist < (params.minRR ?? 1.0)) {
    return { signal: null, prediction, wouldFire: false, skipReason: `R:R ${(reward / stopDist).toFixed(2)} < ${params.minRR}`, edge };
  }

  const signal = {
    side,
    entry,
    stop,
    target,
    entrySignal: "predictor",
    prediction: {
      expectedReturnPct: prediction.expectedReturnPct,
      priceTarget:       prediction.priceTarget,
      horizonDays:       prediction.horizonDays,
      confidence:        prediction.confidence,
      source:            prediction.source,
      edge,
    },
  };
  return { signal, prediction, wouldFire: true, skipReason: null, edge };
}
