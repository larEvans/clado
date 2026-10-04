/**
 * Last-half-hour momentum.
 *
 * The market's return from the previous close to 3:30 PM ET predicts the
 * return over the last 30 minutes (Gao, Han, Li & Zhou, "Market Intraday
 * Momentum", JFE 2018; Baltussen, Da, Lammers & Martens, "Hedging Demand and
 * Market Intraday Momentum", JFE 2021 — linked to options dealers' gamma
 * hedging). At 3:30 go with the day's direction, hold to the close.
 *
 * Entry logic lives in signals.js (lateMomentumEntry).
 */
export const meta = {
  id:          "late-momentum",
  name:        "Last-Half-Hour Momentum",
  description: "At 3:30 PM ET, trade in the direction of the return since the previous close; hold to the 4:00 close. Research: Gao et al. (JFE 2018), Baltussen et al. (JFE 2021).",
  timeframe:   "5m",
  watchlist:   ["SPY", "QQQ"],
  params: {
    minMovePct:  0,      // |prev close → 3:30| move needed to trade (0 = sign only, as in the papers)
    stopAtrMult: 6.0,    // disaster stop only (the papers hold to the close): ATR(14) of 5m bars × this
  },
};
