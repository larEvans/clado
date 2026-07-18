/**
 * Market regime classifier
 *
 * Pure-function module — given a rolling bar buffer (sorted oldest→newest)
 * for a symbol, classify the current market regime as a compact tag string.
 *
 * Tag format:  "<trend>:<vol>[:<gap>][:<orbQ>]"
 *   trend → "trend-up" | "trend-down" | "range"
 *   vol   → "high-vol" | "normal-vol" | "low-vol"
 *   gap   → "gap-up" | "gap-down"  (omitted when |gap| < 0.5%)
 *   orbQ  → "wide-orb" | "tight-orb"  (omitted when no ORB data yet)
 *
 * Limited cardinality (≈ 8–14 distinct tags in practice) so per-bucket
 * sample sizes stay statistically useful.
 *
 * Inputs are intentionally just bars — no external data — so the same
 * classifier runs in both backtest (historical bars) and live (rolling).
 */

import { ema, atr } from "./indicators.js";

// Group bars by ET calendar date.
function groupByDay(bars) {
  const groups = new Map();
  for (const b of bars) {
    const d = new Date(b.time);
    // approximate ET shift; close enough for daily bucketing
    const etMs  = b.time - (d.getUTCMonth() >= 2 && d.getUTCMonth() <= 10 ? 4 : 5) * 3600_000;
    const key   = new Date(etMs).toISOString().slice(0, 10);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * @param {Array<{time,open,high,low,close,volume}>} bars  rolling buffer, sorted oldest→newest
 * @param {object} [opts]
 * @param {number} [opts.orbMinutes=15]  defines the opening-range window
 * @returns {{ tag: string, parts: object, debug: object }}
 */
export function classifyRegime(bars, opts = {}) {
  const { orbMinutes = 15 } = opts;
  const fallback = { tag: "unknown", parts: {}, debug: { reason: "insufficient-bars" } };
  if (!bars || bars.length < 25) return fallback;

  const today = bars[bars.length - 1];
  const days  = groupByDay(bars);
  if (days.length === 0) return fallback;

  // ── Volatility: today's ATR(14) vs the 20-day rolling ATR ─────────────
  const todayAtr = atr(bars.slice(-15), 14);                          // last 15 bars ≈ today
  const histAtr  = atr(bars.slice(-15 - 20 * 78, -15), 14);           // ~20 days of 5-min bars before today
  let vol = "normal-vol";
  if (todayAtr && histAtr && histAtr > 0) {
    const r = todayAtr / histAtr;
    if (r > 1.3)      vol = "high-vol";
    else if (r < 0.7) vol = "low-vol";
  }

  // ── Trend: EMA(9) slope last 5 bars + EMA(9) vs EMA(21) alignment ────
  const closes = bars.slice(-50).map(b => b.close);
  const e9_now  = ema(closes, 9);
  const e21_now = ema(closes, 21);
  const e9_prev = closes.length > 5 ? ema(closes.slice(0, -5), 9) : null;
  let trend = "range";
  if (e9_now && e21_now && e9_prev) {
    const slope     = (e9_now - e9_prev) / e9_prev;     // 5-bar relative change
    const aligned   = e9_now > e21_now;
    if (slope > 0.0015 && aligned)         trend = "trend-up";
    else if (slope < -0.0015 && !aligned)  trend = "trend-down";
  }

  // ── Gap: today's open vs prior-day close ──────────────────────────────
  let gap = null;
  if (days.length >= 2) {
    const priorDay = days[days.length - 2][1];
    const todayDay = days[days.length - 1][1];
    if (priorDay.length > 0 && todayDay.length > 0) {
      const prevClose = priorDay[priorDay.length - 1].close;
      const todayOpen = todayDay[0].open;
      if (prevClose > 0) {
        const gapPct = ((todayOpen - prevClose) / prevClose) * 100;
        if (gapPct >  0.5) gap = "gap-up";
        if (gapPct < -0.5) gap = "gap-down";
      }
    }
  }

  // ── ORB range quality: today's ORB range % vs 20-day ORB avg ─────────
  let orbQ = null;
  if (days.length >= 5) {
    const orbWindowMs = orbMinutes * 60_000;
    const todayBars   = days[days.length - 1][1];
    const todayOpen   = todayBars[0]?.time;
    const todayOrbBars = todayBars.filter(b => b.time < todayOpen + orbWindowMs);
    if (todayOrbBars.length >= 2) {
      const todayOrbRange = Math.max(...todayOrbBars.map(b => b.high)) - Math.min(...todayOrbBars.map(b => b.low));
      const todayOrbPct   = (todayOrbRange / todayBars[0].open) * 100;

      const lookback = days.slice(-21, -1); // prior 20 days
      const historicalPcts = [];
      for (const [, dayBars] of lookback) {
        const open0 = dayBars[0]?.time;
        if (!open0) continue;
        const orbBars = dayBars.filter(b => b.time < open0 + orbWindowMs);
        if (orbBars.length < 2) continue;
        const r = Math.max(...orbBars.map(b => b.high)) - Math.min(...orbBars.map(b => b.low));
        historicalPcts.push((r / dayBars[0].open) * 100);
      }
      if (historicalPcts.length >= 5) {
        const avgPct = historicalPcts.reduce((a, b) => a + b, 0) / historicalPcts.length;
        if (avgPct > 0) {
          const ratio = todayOrbPct / avgPct;
          if (ratio > 1.4)      orbQ = "wide-orb";
          else if (ratio < 0.7) orbQ = "tight-orb";
        }
      }
    }
  }

  // ── Compose tag ───────────────────────────────────────────────────────
  const parts = { trend, vol, gap, orbQ };
  const tagBits = [trend, vol, gap, orbQ].filter(Boolean);
  return { tag: tagBits.join(":"), parts, debug: { todayAtr, histAtr, e9_now, e21_now, e9_prev } };
}

// Convenience for callers that just want the tag string.
export function regimeTag(bars, opts) {
  return classifyRegime(bars, opts).tag;
}
