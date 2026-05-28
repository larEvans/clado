/**
 * Gap Fill — fade morning gaps back toward prior close
 *
 * Statistically robust setup: equity-index ETFs (SPY/QQQ) fill ~70% of gaps
 * within the same session, with mid-cap stocks somewhat lower (~55–65%).
 * Research literature reports 60–70% win rates on disciplined gap-fade
 * setups (Kissell 2014, "Algorithmic Trading Methods").
 *
 * Entry (LONG — gap-down fade):
 *   - Today's open is at least `minGapPct` BELOW prior-day close
 *   - First confirmation bar after 9:35 ET closes green (close > open)
 *   - Price still BELOW prior close (fill target hasn't fired yet)
 *
 * Entry (SHORT — gap-up fade):
 *   - Today's open is at least `minGapPct` ABOVE prior-day close
 *   - First confirmation bar after 9:35 ET closes red
 *   - Price still ABOVE prior close
 *
 * Stop: today's open ± (gap × stopMult)  — invalidation if gap extends
 * Target: prior-day close (the "fill")
 * Time exit: close at noon ET if neither stop nor target hit (gap fades that
 * survive past midday rarely complete)
 */

export const meta = {
  id:          "gap-fill",
  name:        "Gap Fill Fade",
  description: "Fades morning gaps back toward prior-day close. Statistical research shows 60–70% of gaps fill same-day on liquid equities/ETFs. Enters after a confirmation bar in the fade direction, targets the fill level, force-closes at noon ET.",
  timeframe:   "5m",
  watchlist:   ["SPY", "QQQ", "AAPL", "MSFT", "NVDA"],
  pineFile:    "pinescript/gap-fill.pine",
  params: {
    minGapPct:    0.4,    // minimum gap size to qualify
    stopMult:     0.5,    // stop = gap × this beyond today's open
    timeExitMin:  150,    // close after 150 min (~12:00 ET) if neither side hit
  },
};
