/**
 * Hybrid-10 — 10-min ORB triple-confirmation + overnight hold on gap setup
 *
 * Identical entry logic to "hybrid" but uses a faster 10-minute opening range
 * for earlier signals. Key addition: the position is NOT force-closed at
 * session end when a continuation-gap setup is detected.
 *
 * Overnight-hold rules (BOTH must be true at EOD):
 *   1. Position is in profit (current close beats entry by ≥ minOvernightR)
 *   2. The day's close sits in the top 25% of the day's range (long) or
 *      bottom 25% (short) — strong close suggesting next-session continuation
 *
 * When held overnight the stop widens by overnightStopMult × ATR to absorb
 * after-hours noise; intraday stop + target rules resume on the next session.
 */

export const meta = {
  id:          "hybrid10",
  name:        "Hybrid-10 (10-min ORB + Overnight Hold)",
  description: "Same triple-confirmation as hybrid but the opening range is 10 minutes (9:30–9:40) so signals fire 5 min sooner. Detects continuation-gap setups at EOD: when the position is in profit AND the day closes in the top/bottom 25% of range, the bot holds overnight with a widened ATR-based stop to capture gap-up/gap-down moves.",
  timeframe:   "5m",
  watchlist:   ["SPY", "QQQ", "AAPL", "MSFT", "NVDA"],
  pineFile:    "pinescript/hybrid10.pine",
  params: {
    orbMinutes:        10,
    rrRatio:           2.0,
    volMultiplier:     1.3,
    maxRangePct:       1.0,
    emaPeriod:         9,
    emaSlowPeriod:     21,
    holdOvernight:     true,
    minOvernightR:     0.5,    // need 0.5R profit to consider holding overnight
    closeRangePct:     25,     // close must be in top/bottom 25% of day's range
    overnightStopMult: 1.5,    // overnight stop = current stop − (ATR × this)
    atrPeriod:         14,
  },
};
