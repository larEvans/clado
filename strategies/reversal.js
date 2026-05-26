/**
 * Reversal Strategy — RSI-divergence reversal with ATR-trailing dynamic stop
 *
 * Entry — LONG (bullish reversal):
 *   1. Price made a lower low vs the prior swing low (last `swingLookback` bars)
 *   2. RSI made a HIGHER low at the same time → bullish divergence
 *   3. Confirmation candle: current close > prior close
 *
 * Entry — SHORT (bearish reversal):
 *   1. Price made a higher high vs the prior swing high
 *   2. RSI made a LOWER high → bearish divergence
 *   3. Confirmation candle: current close < prior close
 *
 * Dynamic stop:
 *   Initial stop = entry ± (ATR × atrMult)
 *   Trail = each bar in our favor, stop ratchets to max(stop, price - ATR × trailMult)
 *           After breakEvenR R-multiples of profit, stop never drops below entry.
 *
 * Target:
 *   entry ± (ATR × atrMult × rrRatio)
 */

export const meta = {
  id:          "reversal",
  name:        "Reversal + Dynamic Stop",
  description: "RSI-divergence reversal entries with an ATR-based dynamic stop that trails behind price and locks to break-even after 1R of profit. Long on bullish divergence (lower low + higher RSI low) and short on bearish divergence. Catches turning points instead of breakouts.",
  timeframe:   "5m",
  watchlist:   ["SPY", "QQQ", "AAPL", "MSFT", "NVDA"],
  pineFile:    "pinescript/reversal.pine",
  params: {
    rsiPeriod:      14,
    atrPeriod:      14,
    atrMult:        1.5,   // initial stop distance = ATR × atrMult
    trailMult:      1.0,   // trailing stop distance = ATR × trailMult
    rrRatio:        2.0,   // target distance = initial-stop-distance × rrRatio
    swingLookback:  10,    // bars to look back for prior swing high/low
    breakEvenR:     1.0,   // lock stop to entry after this many R of profit
    confirmCandle:  true,
  },
};
