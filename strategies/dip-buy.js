/**
 * Index dip-buy — short-term reversal in index ETFs, held overnight.
 *
 * Evidence: index ETFs' daily returns have been negatively autocorrelated
 * since the 2000s (Baltussen et al., JFE 2019); practitioner RSI(2) tests on
 * SPY. Tested here (docs/edge-study.md), rules fixed before testing:
 *   2021–24: 116 trades, 67% win, +0.23%/trade (≈ buy-and-hold per day held)
 *   2025–Sep 2026 holdout: 53 trades, 77% win, +0.65%/trade
 *
 *   Entry  at the 15:50–15:55 bar close: close > 200-day SMA (completed days)
 *          and RSI(2) < 10 → buy shares, filled at 15:55.
 *   Exit   at the same time on a later day: RSI(2) > 70, or close > the
 *          previous session's high, or after 7 sessions. No stop (stops hurt
 *          mean reversion); held overnight, exempt from the 3:45 EOD close.
 *
 * Logic: signals.js (dipBuyEntry / updatePosition's dipExit).
 */
export const meta = {
  id:          "dip-buy",
  name:        "Index Dip-Buy (RSI 2)",
  description: "Buy index ETFs at 3:55 PM when above the 200-day average and RSI(2) < 10; exit on RSI(2) > 70, a close above the prior day's high, or after 7 sessions. Multi-day, shares, no stop.",
  timeframe:   "5m",
  watchlist:   ["SPY", "QQQ", "IWM", "DIA"],
  params: {
    signalTime: "15:55",   // end of the 5m bar whose close is the signal (15:50–15:55)
    smaDays:    200,
    rsiEntry:   10,
    rsiExit:    70,
    maxDays:    7,
  },
};
