/**
 * Smart Money Concepts (SMC) strategy
 *
 * Logic:
 *   1. HTF bias — 48-bar EMA on 15m (~12H MA) determines trade direction
 *   2. Swing pivots — confirmed N-bar highs/lows define market structure
 *   3. BOS / ChoCH — close through last swing level = structural shift
 *   4. Liquidity sweep — wick beyond a swing level, close back inside
 *   5. Entry — BOS in sweep direction within 10 bars of the sweep
 *   6. Stop — behind the sweep wick (where smart money grabbed stops)
 *   7. Target — R:R multiple of risk
 */

export const meta = {
  id:          "smc",
  name:        "Smart Money Concepts",
  description: "Liquidity sweep + Break of Structure entries with multi-timeframe bias. Identifies buy-side/sell-side liquidity grabs, then enters on the displacement move. Order blocks and FVGs shown on chart.",
  timeframe:   "15m",
  watchlist:   ["SPY", "QQQ", "AAPL", "NVDA", "MSFT"],
  pineFile:    "pinescript/smc.pine",
  params: {
    swingLookback: 5,
    rrRatio:       2.5,
    htfEmaPeriod:  48,
    maxRiskPct:    0.015,
  },
};
