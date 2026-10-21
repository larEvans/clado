/**
 * Noise-band intraday momentum ("Beat the Market").
 *
 * Zarattini, Aziz & Barbon (2024), SSRN 4824172: around each day's open,
 * price wanders inside a "noise area" sized by the average absolute move from
 * the open at that time of day over the last 14 days. A break outside it
 * signals real supply/demand imbalance; follow it. Bands are widened on the
 * side of an overnight gap (upper uses max(open, prev close), lower uses
 * min). Checked every 30 minutes from 10:00; exit when price closes back
 * through max(band, VWAP) at a check, or at the end of the day.
 *
 * Entry logic lives in signals.js (noiseMomentumEntry).
 */
export const meta = {
  id:          "noise-momentum",
  name:        "Noise-Band Momentum",
  description: "Trend-follow breaks out of the 14-day intraday noise band (gap-adjusted), checked every 30 min; trailing exit at max(band, VWAP). Research: Zarattini, Aziz & Barbon (2024).",
  timeframe:   "5m",
  watchlist:   ["SPY", "QQQ", "TSLA", "MSFT", "META"],
  params: {
    lookbackDays: 14,    // days in the noise estimate
    minDays:      10,    // need at least this many to trade
    bandMult:     1.0,   // band width × this
    checkMinutes: 30,    // decision / trailing-exit cadence
    firstCheck:   "10:00",
    lastCheck:    "15:30",
    stopAtrMult:  6.0,   // disaster stop only (the paper exits on the band / VWAP trail)
  },
};
