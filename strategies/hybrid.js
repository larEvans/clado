/**
 * Hybrid strategy — 15-min ORB + VWAP + EMA triple-confirmation
 *
 * Entry requires ALL THREE:
 *   1. Price breaks the 15-min Opening Range High (long) or Low (short)
 *   2. Price is above VWAP for long / below VWAP for short
 *   3. EMA(9) > EMA(21) for long / EMA(9) < EMA(21) for short
 *   + Volume > 1.3× 20-bar average
 *
 * Stop  : ORB opposite side
 * Target: Entry ± ORB range × rrRatio
 */

export const meta = {
  id:          "hybrid",
  name:        "Hybrid ORB + VWAP + EMA",
  description: "Combines 15-min Opening Range Breakout with VWAP momentum bias and EMA(9/21) trend filter. All three conditions must align before entering — highest-conviction intraday signal.",
  timeframe:   "5m",
  watchlist:   ["SPY", "QQQ", "AAPL", "MSFT", "NVDA"],
  pineFile:    "pinescript/hybrid.pine",
  params: {
    orbMinutes:    15,
    rrRatio:       2.0,
    volMultiplier: 1.3,
    maxRangePct:   1.0,
    emaPeriod:     9,
    emaSlowPeriod: 21,
  },
};
