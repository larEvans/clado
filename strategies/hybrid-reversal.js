/**
 * Hybrid + Reversal + Dynamic Stop
 *
 * Two independent entry pathways — either can fire (one trade per day):
 *
 *   PATH A — Triple-confirmation breakout (hybrid):
 *     Price breaks 15-min ORB high/low + on the right side of VWAP +
 *     EMA(9)/EMA(21) trend aligned + volume ≥ 1.3× 20-bar average
 *
 *   PATH B — Reversal divergence:
 *     Price prints a lower-low (long) or higher-high (short) vs the prior
 *     swing while RSI prints the opposite — bullish/bearish divergence.
 *     Requires a confirmation candle in the new direction.
 *
 * Stop management (both pathways):
 *   - Initial stop = entry ± (ATR × atrMult)  (overrides ORB low/high)
 *   - Each bar in our favor, stop trails by ATR × trailMult
 *   - After breakEvenR R of profit, stop locks to entry
 *
 * Target: entry ± (initial-stop-distance × rrRatio)
 */

export const meta = {
  id:          "hybrid-reversal",
  name:        "Hybrid + Reversal + Dynamic Stop",
  description: "Two-pathway intraday system: triple-confirmation ORB breakouts AND RSI-divergence reversals both fire entries. ATR-based dynamic stop trails behind price and locks to break-even after 1R of profit. Combines momentum entries with mean-reversion entries under one risk model.",
  timeframe:   "5m",
  watchlist:   ["SPY", "QQQ", "AAPL", "MSFT", "NVDA"],
  pineFile:    "pinescript/hybrid-reversal.pine",
  params: {
    orbMinutes:    15,
    rrRatio:       2.0,
    volMultiplier: 1.3,
    maxRangePct:   1.0,
    emaPeriod:     9,
    emaSlowPeriod: 21,
    rsiPeriod:     14,
    atrPeriod:     14,
    atrMult:       1.5,
    trailMult:     1.0,
    swingLookback: 10,
    breakEvenR:    1.0,
  },
};
