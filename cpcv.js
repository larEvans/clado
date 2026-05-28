/**
 * Combinatorial Purged K-Fold Cross-Validation (CPCV)
 *
 * Why CPCV instead of plain walk-forward or k-fold:
 *  - Financial time series are non-stationary AND have serial dependence
 *  - Standard k-fold leaks information across folds (test set "knows" about
 *    train set because trades span fold boundaries)
 *  - Walk-forward only validates ONE ordering of train/test windows
 *
 * CPCV:
 *  1. Slice candles into K equal time blocks
 *  2. Generate all C(K, N) combinations of N test blocks
 *  3. For each combination:
 *       - Purge any trades that span the train/test boundary
 *       - Run the backtest on the test blocks
 *  4. Aggregate the metric (e.g. winRate) across all combinations
 *  5. Compute Probability of Backtest Overfitting (PBO) as
 *     the fraction of combinations where the metric falls below the median
 *
 * Reference: López de Prado, "Advances in Financial Machine Learning" Ch. 7
 *
 * Public API:
 *   runCPCV(strategyId, symbol, candles, { K, N, purgeBars, params, opts })
 *     → { folds, aggregate, pbo }
 */

import { runBacktest } from "./backtest.js";

// Generate all combinations of `n` items from indices [0..k)
function combinations(k, n) {
  const out = [];
  const recurse = (start, picked) => {
    if (picked.length === n) { out.push([...picked]); return; }
    for (let i = start; i < k; i++) {
      picked.push(i);
      recurse(i + 1, picked);
      picked.pop();
    }
  };
  recurse(0, []);
  return out;
}

function pickMetric(metrics, name) {
  if (name === "winRate") return parseFloat((metrics.winRate || "0").toString().replace("%", "")) || 0;
  if (name === "totalReturnR") return parseFloat((metrics.totalReturnR || "0").toString().replace("R", "").replace("+", "")) || 0;
  if (name === "profitFactor") return metrics.profitFactor === "∞" ? 999 : (parseFloat(metrics.profitFactor) || 0);
  return 0;
}

export async function runCPCV(strategyId, symbol, candles, {
  K = 6,
  N = 2,
  purgeBars = 20,   // drop bars within `purgeBars` of a block boundary on the test side
  params    = {},
  opts      = {},
  metric    = "winRate",
} = {}) {
  if (!candles || candles.length < K * 30) {
    throw new Error(`Not enough candles for CPCV: need ≥ ${K * 30}, got ${candles?.length || 0}`);
  }
  if (N >= K) throw new Error(`N (${N}) must be < K (${K})`);

  // 1. Slice candles into K equal-size time blocks
  const blockSize = Math.floor(candles.length / K);
  const blocks    = [];
  for (let i = 0; i < K; i++) {
    const start = i * blockSize;
    const end   = i === K - 1 ? candles.length : (i + 1) * blockSize;
    blocks.push({ index: i, start, end, bars: candles.slice(start, end) });
  }

  // 2. Generate all C(K, N) test combinations
  const combos = combinations(K, N);

  // 3. For each combo, run the backtest on the joined test blocks (purged)
  const folds = [];
  for (const combo of combos) {
    // Concatenate test blocks; apply purge by trimming a buffer from each block's start
    const testCandles = [];
    for (const blockIdx of combo) {
      const blk = blocks[blockIdx];
      // Purge: drop first `purgeBars` of each test block to avoid carry-over from
      // a position that opened just before the boundary in the (excluded) train set
      const safeBars = blk.bars.slice(purgeBars);
      testCandles.push(...safeBars);
    }
    if (testCandles.length < 50) {
      folds.push({ combo, skipped: "too few bars after purge" });
      continue;
    }

    try {
      const result = await runBacktest(strategyId, symbol, { ...opts, params, _candles: testCandles });
      const value  = pickMetric(result, metric);
      folds.push({
        combo,
        bars:        testCandles.length,
        totalTrades: result.totalTrades,
        winRate:     result.winRate,
        totalReturnR: result.totalReturnR,
        profitFactor: result.profitFactor,
        maxDrawdown:  result.maxDrawdown,
        metricValue:  value,
      });
    } catch (e) {
      folds.push({ combo, error: e.message });
    }
  }

  // 4. Aggregate
  const valid    = folds.filter(f => typeof f.metricValue === "number");
  const values   = valid.map(f => f.metricValue);
  const mean     = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  const variance = values.length > 0 ? values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length : 0;
  const stddev   = Math.sqrt(variance);
  const median   = values.length > 0 ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : 0;
  const min      = values.length > 0 ? Math.min(...values) : 0;
  const max      = values.length > 0 ? Math.max(...values) : 0;

  // 5. Probability of Backtest Overfitting — % of folds where the metric is
  //    below the median. Robust target ≥ 50% means the strategy at least
  //    half the folds matches the median performance. Closer to 0 means
  //    most folds *underperform* the median, which is a strong overfit
  //    warning. We invert: pbo = fraction of folds whose metric < mean.
  const below = valid.filter(f => f.metricValue < mean).length;
  const pbo   = valid.length > 0 ? below / valid.length : 0;

  // Quality interpretation
  let verdict;
  if (valid.length < 3) verdict = "INSUFFICIENT_DATA";
  else if (stddev / Math.max(Math.abs(mean), 0.0001) > 0.5) verdict = "UNSTABLE";
  else if (pbo > 0.6) verdict = "LIKELY_OVERFIT";
  else if (mean > 50 && stddev / mean < 0.25) verdict = "ROBUST";
  else verdict = "OK";

  return {
    strategy: strategyId,
    symbol,
    K, N, purgeBars,
    metric,
    totalCombinations: combos.length,
    validFolds:        valid.length,
    aggregate: {
      mean:   +mean.toFixed(3),
      stddev: +stddev.toFixed(3),
      median: +median.toFixed(3),
      min:    +min.toFixed(3),
      max:    +max.toFixed(3),
      cv:     mean !== 0 ? +(stddev / Math.abs(mean)).toFixed(3) : null, // coefficient of variation
    },
    pbo:     +pbo.toFixed(3),
    verdict,
    folds,
  };
}
