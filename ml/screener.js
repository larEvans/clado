/**
 * ml/screener.js — advisory watchlist screener.
 *
 * Runs the price-target model across every symbol in the watchlist and ranks
 * them, so the dashboard can show "here's what the model likes right now" —
 * purely advisory, it never places an order. Optionally folds in which strategy
 * signals are currently firing per symbol, so you can see model + signal
 * agreement at a glance ("looks through all the signals in the watchlist").
 *
 * Kept free of network/strategy imports so it's unit-testable: the caller
 * supplies `{ symbol, bars, signals }` rows; we predict + rank.
 */

import { predict } from "./predictor.js";

/**
 * @param {Array<{symbol:string, bars:Array, signals?:Array}>} rows
 * @param {object} opts { minConfidence?, withFeatures?, horizonDays? }
 * @returns {{ generatedAt, source, count, picks: Array }}
 *   picks are sorted best→worst by rankScore (expectedReturn × confidence,
 *   signed so strong shorts rank high too).
 */
export function screenWatchlist(rows, opts = {}) {
  const minConfidence = opts.minConfidence ?? 0;
  let source = "heuristic";

  const picks = (rows || []).map(row => {
    let prediction, error = null;
    try {
      prediction = predict(row.bars, { withFeatures: opts.withFeatures, horizonDays: opts.horizonDays });
      source = prediction.source; // all rows share the same loaded model
    } catch (e) {
      error = e.message;
      prediction = null;
    }

    if (!prediction) {
      return { symbol: row.symbol, error, rankScore: -Infinity };
    }

    const signals = row.signals || [];
    const firing = signals.filter(s => s && s.signal);
    // Does any firing strategy agree with the model's direction?
    const agrees = firing.some(s => s.signal.side === prediction.side);
    // Rank by conviction-weighted expected edge; a confirming signal nudges it up.
    const edge = prediction.expectedReturnPct * prediction.confidence;
    const rankScore = edge * (agrees ? 1.15 : 1.0);

    return {
      symbol:           row.symbol,
      side:             prediction.side,
      expectedReturnPct: Number(prediction.expectedReturnPct.toFixed(3)),
      priceTarget:      Number(prediction.priceTarget.toFixed(4)),
      price:            Number(prediction.price.toFixed(4)),
      horizonDays:      prediction.horizonDays,
      confidence:       Number(prediction.confidence.toFixed(3)),
      firingStrategies: firing.map(s => s.strategy),
      signalAgrees:     agrees,
      features:         prediction.features,
      rankScore:        Number(rankScore.toFixed(4)),
    };
  })
  .filter(p => p.error || p.confidence == null || p.confidence >= minConfidence)
  .sort((a, b) => (b.rankScore ?? -Infinity) - (a.rankScore ?? -Infinity));

  return {
    generatedAt: new Date().toISOString(),
    source,
    count: picks.length,
    picks,
  };
}
