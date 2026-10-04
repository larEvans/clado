/**
 * Multi-timeframe supply & demand (smart-money concepts + Wyckoff context).
 *
 *   1. Bias      1-hour market structure: trade only in the direction of the
 *                last 1h break of structure (concepts.js structure()), and
 *                only when 15-minute structure agrees (midTf).
 *   2. Setup     on 5-minute bars, a break of structure (BOS or CHoCH) in the
 *                bias direction, leaving an order block (the last opposite
 *                candle before the displacement) — a demand zone below price
 *                for longs, a supply zone above for shorts — with a fair value
 *                gap (inefficiency) in the displacement if requireFvg.
 *   3. Entry     the first return into that zone (its first mitigation),
 *                closing back out of it in the trade direction.
 *   4. Stop      beyond the protected low/high (zone / leg extreme) + a pad.
 *   5. Target    fixed R multiple, or the nearest opposite liquidity pool.
 *
 * Entry logic: signals.js (sdMtfEntry). Tuning history: docs/sd-mtf-lab.md.
 */
export const meta = {
  id:          "sd-mtf",
  name:        "Supply/Demand MTF (SMC + Wyckoff)",
  description: "1h structure bias → 5m break of structure → first return into the order block / demand-supply zone (with inefficiency) → stop beyond the protected level → target in R or at liquidity.",
  timeframe:   "5m",
  watchlist:   ["SPY", "QQQ", "DIA", "IWM", "MSFT", "META", "TSLA"],
  params: {
    htfTf:        60,        // bias timeframe (minutes); 0 = no bias filter
    htfLookback:  200,       // 1h bars for the bias structure
    htfSwingK:    2,
    midTf:        15,        // middle timeframe: its structure must agree with the bias; 0 = off
    midLookback:  200,
    swingK:       2,         // 5m swing size
    ltfLookback:  120,       // 5m bars scanned for structure / zones
    maxZoneAge:   24,        // bars between the break and the entry (2h on 5m)
    requireFvg:   true,      // the displacement must leave an inefficiency
    stopPadAtr:   0.1,       // stop buffer beyond the protected level, in ATR
    minRiskPct:   0.05,      // skip stops tighter than this % of price (costs)
    targetMode:   "liquidity", // "liquidity" (nearest opposite pool) or "rr"
    minRR:        1,         // liquidity target must pay ≥ this many R
    rr:           1,         // R multiple when targetMode = "rr"
    firstEntry:   "09:45",
    lastEntry:    "15:00",
    // Filters added by the tuning lab (off = null):
    wyckoffSpring: false,    // require a Wyckoff spring/upthrust in the setup
    requirePoi:    false,    // require a fresh 15m zone at the entry
    avoidPoi:      false,    // skip entries inside a fresh 15m zone
    requireSweep:  false,    // the leg into the zone must sweep the prior 20 bars
    discountOnly:  false,    // longs in the lower half of the 1h range, shorts upper
  },
  // Best development-data setting (72.3% win, −0.010R net) — lost −0.080R on
  // the 2024–26 holdout. See docs/sd-mtf-lab.md.
  labBest: { targetMode: "rr", rr: 0.4, minRiskPct: 0.3, avoidPoi: true },
};
