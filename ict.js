/**
 * ICT (Inner Circle Trader) concepts as pure functions over 5-minute bars.
 *
 *   Liquidity   Resting stop orders sit just above old highs ("buy-side
 *               liquidity") and below old lows ("sell-side liquidity"). ICT
 *               treats the nearest untaken pool as price's "draw" — the
 *               natural target. Pools used here:
 *                 PDH / PDL   previous regular session's high / low
 *                 ONH / ONL   overnight (4:00 PM → 9:30 AM) high / low
 *                 SH  / SL    today's session high / low so far
 *                 swing-high / swing-low   fractal pivots from the last two
 *                             sessions that price hasn't traded through since
 *   Fair value gap (FVG)  a 3-bar imbalance: bar 1's high below bar 3's low
 *               (bullish) or bar 1's low above bar 3's high (bearish), still
 *               unfilled.
 *   Sweep       a bar that trades through a recent high/low and closes back
 *               inside — stops taken, move often reverses.
 *   Premium / discount   where price sits in the previous day's range
 *               (> 0.5 = premium, < 0.5 = discount).
 *
 * Used by signals.js (liquidity targets) and ml/features.js (model features).
 * Reads time from the bars only; no I/O.
 */

import { etInfo, MARKET_OPEN, MARKET_CLOSE } from "./et.js";

/** Group bars by ET day, keeping each day's RTH and extended-hours bars apart. */
function byDay(bars) {
  const days = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const { day, mins } = etInfo(b.time);
    let d = days[days.length - 1];
    if (!d || d.day !== day) days.push(d = { day, rth: [], pre: [], post: [] });
    (mins < MARKET_OPEN ? d.pre : mins >= MARKET_CLOSE ? d.post : d.rth).push(i);
  }
  return days;
}

const hiOf = (bars, idx) => idx.reduce((m, i) => Math.max(m, bars[i].high), -Infinity);
const loOf = (bars, idx) => idx.reduce((m, i) => Math.min(m, bars[i].low), Infinity);

/**
 * Liquidity pools relative to the last bar.
 * @returns {{ pdh, pdl, onh, onl, sessionHigh, sessionLow,
 *             levels: Array<{ price, kind, side: "buy"|"sell" }> }}
 *   side "buy" = buy-side liquidity (above highs), "sell" = below lows.
 */
export function liquidityLevels(bars, { swingLookback = 2 } = {}) {
  const n = bars.length;
  const out = { pdh: null, pdl: null, onh: null, onl: null, sessionHigh: null, sessionLow: null, levels: [] };
  if (n < 10) return out;
  const days = byDay(bars);
  const today = days[days.length - 1];
  const prev = [...days].reverse().find(d => d !== today && d.rth.length);
  if (prev) {
    out.pdh = hiOf(bars, prev.rth);
    out.pdl = loOf(bars, prev.rth);
    const overnight = [...prev.post, ...today.pre];
    if (overnight.length) { out.onh = hiOf(bars, overnight); out.onl = loOf(bars, overnight); }
  }
  const sessionSoFar = today.rth.filter(i => i < n - 1);        // exclude the current bar
  if (sessionSoFar.length) { out.sessionHigh = hiOf(bars, sessionSoFar); out.sessionLow = loOf(bars, sessionSoFar); }

  const add = (price, kind, side) => { if (Number.isFinite(price)) out.levels.push({ price, kind, side }); };
  add(out.pdh, "PDH", "buy");  add(out.pdl, "PDL", "sell");
  add(out.onh, "ONH", "buy");  add(out.onl, "ONL", "sell");
  add(out.sessionHigh, "SH", "buy"); add(out.sessionLow, "SL", "sell");

  // Untaken swing highs/lows from the previous and current session.
  const start = prev ? Math.min(...[...prev.pre, ...prev.rth, ...prev.post]) : 0;
  let runHigh = -Infinity, runLow = Infinity;                     // extremes AFTER each pivot
  const k = swingLookback;
  for (let i = n - 1; i >= start; i--) {
    if (i >= start + k && i <= n - 1 - k) {
      let isHigh = true, isLow = true;
      for (let j = i - k; j <= i + k; j++) {
        if (j === i) continue;
        if (bars[j].high >= bars[i].high) isHigh = false;
        if (bars[j].low  <= bars[i].low)  isLow  = false;
      }
      if (isHigh && runHigh < bars[i].high) add(bars[i].high, "swing-high", "buy");
      if (isLow  && runLow  > bars[i].low)  add(bars[i].low,  "swing-low",  "sell");
    }
    runHigh = Math.max(runHigh, bars[i].high);
    runLow  = Math.min(runLow, bars[i].low);
  }
  return out;
}

/**
 * ICT target: the nearest liquidity pool beyond entry that pays at least
 * `minRR` × the risk. Longs aim at buy-side liquidity above, shorts at
 * sell-side liquidity below. Returns { price, kind } or null (no draw worth
 * trading toward).
 */
export function liquidityTarget(side, entry, stop, bars, minRR = 2) {
  const risk = Math.abs(entry - stop);
  if (!(risk > 0)) return null;
  const { levels } = liquidityLevels(bars);
  let best = null;
  for (const l of levels) {
    const reward = side === "buy" ? l.price - entry : entry - l.price;
    if (reward >= minRR * risk && (!best || reward < best.reward)) best = { price: l.price, kind: l.kind, reward };
  }
  return best && { price: best.price, kind: best.kind };
}

/** Unfilled fair value gaps among the last `lookback` bars: { bull, bear } counts. */
export function fairValueGaps(bars, lookback = 20) {
  const n = bars.length;
  let bull = 0, bear = 0;
  for (let i = Math.max(2, n - lookback); i < n; i++) {
    const a = bars[i - 2], c = bars[i];
    if (a.high < c.low) {                                         // bullish gap [a.high, c.low]
      let filled = false;
      for (let j = i + 1; j < n && !filled; j++) filled = bars[j].low <= a.high;
      if (!filled) bull++;
    } else if (a.low > c.high) {                                  // bearish gap [c.high, a.low]
      let filled = false;
      for (let j = i + 1; j < n && !filled; j++) filled = bars[j].high >= a.low;
      if (!filled) bear++;
    }
  }
  return { bull, bear };
}

/** Liquidity sweeps in the last `recent` bars against the prior `window` bars'
 *  extremes: high = buy-side taken and closed back below (bearish), low = mirror. */
export function sweeps(bars, recent = 6, window = 20) {
  const n = bars.length;
  let high = 0, low = 0;
  for (let i = Math.max(window, n - recent); i < n; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - window; j < i; j++) { hi = Math.max(hi, bars[j].high); lo = Math.min(lo, bars[j].low); }
    if (bars[i].high > hi && bars[i].close < hi) high = 1;
    if (bars[i].low  < lo && bars[i].close > lo) low = 1;
  }
  return { high, low };
}
