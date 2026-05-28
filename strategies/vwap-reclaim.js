/**
 * VWAP Reclaim — buy the recovery, fade the rejection
 *
 * Setup (LONG): price dips below session VWAP, then prints a 5-min bar that
 *   closes BACK above VWAP. This "reclaim" frequently leads to a continuation
 *   move because shorts get squeezed and institutional buyers defend VWAP.
 *
 * Setup (SHORT): price spikes above VWAP and the next bar closes below — a
 *   "rejection" that signals exhaustion at the level.
 *
 * Confirmations:
 *   - Reclaim bar must close ≥ minReclaimPct above (or below for short) VWAP
 *     to filter out marginal pokes
 *   - Volume on the reclaim bar must be ≥ volMultiplier × the 20-bar volume
 *     average — institutional fingerprint
 *   - At least 6 bars after open (avoid the 9:30 opening prints)
 *
 * Risk:
 *   - Stop: opposite side of VWAP by stopPct of price
 *   - Target: distance from reclaim price to VWAP, scaled by rrRatio
 *
 * Win rate target: 55–60% per published studies on VWAP reversal strategies
 * (e.g. Berkowitz "Trading with VWAP"). The reclaim filter alone removes
 * most of the chop that hurts naive VWAP entries.
 */

export const meta = {
  id:          "vwap-reclaim",
  name:        "VWAP Reclaim",
  description: "Mean-reversion entry on VWAP reclaim (long) or rejection (short). Waits for price to wick across VWAP and the NEXT bar to close back across, with volume confirmation. Higher win rate than naive VWAP entries because the reclaim filter removes wick-and-fail setups.",
  timeframe:   "5m",
  watchlist:   ["SPY", "QQQ", "AAPL", "MSFT", "NVDA"],
  pineFile:    "pinescript/vwap-reclaim.pine",
  params: {
    minReclaimPct:  0.05,   // bar close must be ≥ this % beyond VWAP
    volMultiplier:  1.2,    // reclaim volume vs 20-bar avg
    stopPct:        0.4,    // stop distance as % of price
    rrRatio:        1.5,    // target is rrRatio × the entry-to-VWAP distance
    minBarsAfterOpen: 6,    // skip first 6 bars (30 min)
  },
};
