/**
 * Strategy router — picks the highest-probability strategy for the
 * current market regime, with a diversification penalty to spread risk
 * across symbols/strategies (so failure of one strategy doesn't sink the day).
 *
 * Inputs:
 *   - candidates: array of { strategy, signal } pairs (signal is whatever
 *     the strategy's evaluator returned, including null for no-go)
 *   - regime:     regime tag string ("trend-up:high-vol", etc.)
 *   - statsLookup: function(strategy, regime) → { winRate, sampleSize, avgPnl } | null
 *   - todayState: { strategiesFiredToday: Set<string> }
 *
 * Output: { chosen, ranking, reason } where `chosen` is the picked
 *         candidate (or null) and `ranking` lists all candidates with scores.
 */

const MIN_SAMPLE_FOR_STRICT = 5;
const SAMPLE_FOR_FULL_TRUST = 30;
const DIVERSIFICATION_DISCOUNT = 0.8;

function scoreCandidate(strategy, regime, statsLookup) {
  const regStats = statsLookup(strategy, regime);
  // Without per-regime history, fall back to global win rate (looked up with regime=null)
  const stats = regStats || statsLookup(strategy, null);
  if (!stats) {
    // No data at all — neutral prior of 0.5 winRate × tiny confidence weight
    return { winRate: 0.5, sampleSize: 0, score: 0.5 * Math.sqrt(1 / SAMPLE_FOR_FULL_TRUST), source: "prior" };
  }
  const confidence = Math.sqrt(Math.min(stats.sampleSize, SAMPLE_FOR_FULL_TRUST) / SAMPLE_FOR_FULL_TRUST);
  return {
    winRate:    stats.winRate,
    sampleSize: stats.sampleSize,
    score:      stats.winRate * confidence,
    source:     regStats ? "regime" : "global",
    avgPnl:     stats.avgPnl,
  };
}

export function chooseSignal({ candidates, regime, statsLookup, todayState, strict = false }) {
  const live = (candidates || []).filter(c => c && c.signal);
  if (live.length === 0) return { chosen: null, ranking: [], reason: "no candidates fired" };

  const fired = todayState?.strategiesFiredToday || new Set();

  const ranking = live.map(c => {
    const s = scoreCandidate(c.strategy, regime, statsLookup);
    // Diversification: discount strategies already used today
    const diverseMultiplier = fired.has(c.strategy) ? DIVERSIFICATION_DISCOUNT : 1.0;
    return {
      strategy:        c.strategy,
      signal:          c.signal,
      winRate:         s.winRate,
      sampleSize:      s.sampleSize,
      avgPnl:          s.avgPnl,
      rawScore:        s.score,
      diverseDiscount: diverseMultiplier,
      score:           s.score * diverseMultiplier,
      source:          s.source,
    };
  }).sort((a, b) => b.score - a.score);

  const top = ranking[0];

  // Strict mode: require at least one candidate to have meaningful regime data
  if (strict && (top.source === "prior" || top.sampleSize < MIN_SAMPLE_FOR_STRICT)) {
    return {
      chosen:  null,
      ranking,
      reason:  `strict-router: best candidate (${top.strategy}) has only ${top.sampleSize} samples in regime "${regime}"`,
    };
  }

  const reason = `${top.strategy} chosen: ${(top.winRate * 100).toFixed(0)}% win rate (${top.sampleSize} samples, ${top.source})` +
    (top.diverseDiscount < 1 ? ` · diversification ×${top.diverseDiscount}` : "") +
    (ranking.length > 1 ? ` · beat ${ranking[1].strategy} (${(ranking[1].winRate * 100).toFixed(0)}%)` : "");

  return { chosen: top, ranking, reason };
}
