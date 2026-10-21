/**
 * ICT 2024 Mentorship, Lecture #1 (Aug 5, 2024) — the 8:30 AM model.
 *
 *   Draw on liquidity  relative equal highs/lows and the previous session's
 *                      high/low, as they stood before 8:30 AM ET (ict.js)
 *   Raid               after 8:30, price trades through one of those pools
 *   Market structure shift  a close beyond the swing that led into the raid
 *   Entry              first retrace into the fair value gap left by that
 *                      displacement (SIBI for shorts, BISI for longs)
 *   Stop               beyond the extreme made after 8:30
 *   Target             the opposite liquidity pool (≥ minRR × risk)
 *
 * Adapted to this bot: runs on 5m bars (the lecture uses 1m for the trigger),
 * trades the stock during regular hours (entries from 9:45 ET), window to
 * 11:00 ET. Entry logic lives in signals.js (ict2024Entry).
 */
export const meta = {
  id:          "ict-2024",
  name:        "ICT 8:30 Model (2024 Mentorship L1)",
  description: "Raid of pre-8:30 liquidity → market structure shift → entry on the first retrace into the displacement's fair value gap; stop beyond the post-8:30 extreme; target the opposite liquidity pool (≥ 2R).",
  timeframe:   "5m",
  watchlist:   ["SPY", "QQQ"],
  params: {
    setupTime:   "08:30",   // liquidity is marked as of this time; raids count after it
    windowEnd:   "11:00",   // last entry (ET)
    mssLookback: 6,         // bars before the raid extreme that define the swing to break
    stopPadPct:  0.02,      // stop buffer beyond the extreme (% of price)
    minRR:       2,         // target must be a liquidity pool at least this many R away
  },
};
