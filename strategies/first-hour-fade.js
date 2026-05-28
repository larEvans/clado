/**
 * First-Hour Fade — countertrend the strong-trending opening hour
 *
 * Setup: when the first 60 minutes (9:30–10:30 ET) produces a strong
 * directional move (≥ minFirstHourPct), the move often exhausts and a
 * counter-move develops between 10:30 and noon. Reportedly 55–60% win
 * rate on liquid equities — see "Markets in Profile" (Dalton) and Linda
 * Raschke's "First Cross" pattern, plus Pristine's "Opening Range Fade".
 *
 * Entry (SHORT — fade strong-up open):
 *   - First-hour close is ≥ minFirstHourPct above 9:30 open
 *   - First-hour close is in the TOP 25% of the hour's range (failing to
 *     pull back during the hour = exhaustion signal)
 *   - Next bar (10:30-10:35) closes BELOW the first-hour close
 *
 * Entry (LONG — fade strong-down open): mirror.
 *
 * Risk:
 *   - Stop: today's high (short) or low (long)  — fade is invalid if the
 *     trend extends
 *   - Target: 50% retracement of the first-hour move
 *
 * Time stop: close at 1:30 PM ET if neither side hit (afternoon dynamics differ).
 */

export const meta = {
  id:          "first-hour-fade",
  name:        "First-Hour Fade",
  description: "Countertrend fade of strong-trending first-hour moves. Enters in hour two after a confirmation candle against the morning direction, targeting a 50% retracement. Published studies show 55–60% win rate on liquid equities when the first hour closes at its extreme.",
  timeframe:   "5m",
  watchlist:   ["SPY", "QQQ", "AAPL", "MSFT", "NVDA"],
  pineFile:    "pinescript/first-hour-fade.pine",
  params: {
    minFirstHourPct: 0.6,   // require ≥ this % move in hour 1
    exhaustionTop:   25,    // close must be in top/bottom this % of hour-1 range
    retracePct:      50,    // target is this % retrace of hour-1 move
    timeExitMin:     240,   // ~1:30 PM ET force close
  },
};
