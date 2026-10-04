/**
 * Smart-money / Wyckoff concept detection over OHLC bars (oldest → newest).
 * Pure functions; used by the sd-mtf strategy (signals.js), the concept chart
 * and as the reference for pinescript/concepts.pine.
 *
 *   structure()      swing points, BOS / CHoCH, trend, protected & weak points
 *   orderBlocks()    supply/demand zones: the last opposite candle before a
 *                    displacement that broke structure, with mitigation status
 *   fvgs()           inefficiencies (fair value gaps), filled or not
 *   wyckoff()        trading ranges and springs / upthrusts
 *   Liquidity pools come from ict.js (liquidityLevels).
 */

/** Fractal swing points: a high (low) higher (lower) than k bars each side. */
export function swings(bars, k = 2) {
  const out = [];
  for (let i = k; i < bars.length - k; i++) {
    let hi = true, lo = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (bars[j].high >= bars[i].high) hi = false;
      if (bars[j].low <= bars[i].low) lo = false;
    }
    if (hi) out.push({ i, type: "high", price: bars[i].high, time: bars[i].time });
    if (lo) out.push({ i, type: "low", price: bars[i].low, time: bars[i].time });
  }
  return out;
}

/**
 * Market structure. Walks the bars; a close above the last swing high is a
 * bullish break of structure (BOS), below the last swing low a bearish one.
 * A break against the current trend is a change of character (CHoCH).
 *   protected: the swing that launched the last BOS (a long's invalidation)
 *   weak:      the opposite extreme since then (the natural target)
 * @returns {{ trend, events: [{ i, type:"BOS"|"CHoCH", dir, level, from }], swings, protectedLevel, weakLevel, lastBreak }}
 */
export function structure(bars, k = 2) {
  const sw = swings(bars, k);
  const events = [];
  let trend = null, lastHigh = null, lastLow = null, s = 0;
  for (let i = 0; i < bars.length; i++) {
    // swings become known k bars after they print
    while (s < sw.length && sw[s].i + k <= i) {
      if (sw[s].type === "high") lastHigh = sw[s]; else lastLow = sw[s];
      s++;
    }
    const c = bars[i].close;
    if (lastHigh && c > lastHigh.price && !lastHigh.broken) {
      events.push({ i, type: trend === "down" ? "CHoCH" : "BOS", dir: "up", level: lastHigh.price, from: lastHigh.i, protectedIdx: lastLow?.i ?? null });
      lastHigh.broken = true; trend = "up";
    } else if (lastLow && c < lastLow.price && !lastLow.broken) {
      events.push({ i, type: trend === "up" ? "CHoCH" : "BOS", dir: "down", level: lastLow.price, from: lastLow.i, protectedIdx: lastHigh?.i ?? null });
      lastLow.broken = true; trend = "down";
    }
  }
  const last = events[events.length - 1] || null;
  let protectedLevel = null, weakLevel = null;
  if (last) {
    const after = bars.slice(last.i);
    if (last.dir === "up") {
      protectedLevel = last.protectedIdx != null ? bars[last.protectedIdx].low : null;
      weakLevel = Math.max(...after.map(b => b.high));
    } else {
      protectedLevel = last.protectedIdx != null ? bars[last.protectedIdx].high : null;
      weakLevel = Math.min(...after.map(b => b.low));
    }
  }
  return { trend, events, swings: sw, protectedLevel, weakLevel, lastBreak: last };
}

/** Fair value gaps (inefficiencies): 3-bar imbalances, with fill status. */
export function fvgs(bars, from = 2) {
  const out = [];
  for (let i = Math.max(2, from); i < bars.length; i++) {
    const a = bars[i - 2], c = bars[i];
    let g = null;
    if (a.high < c.low) g = { i, dir: "up", lo: a.high, hi: c.low };
    else if (a.low > c.high) g = { i, dir: "down", lo: c.high, hi: a.low };
    if (!g) continue;
    g.filledAt = null;
    for (let j = i + 1; j < bars.length; j++) {
      if (g.dir === "up" ? bars[j].low <= g.lo : bars[j].high >= g.hi) { g.filledAt = j; break; }
    }
    out.push(g);
  }
  return out;
}

/**
 * Order blocks = supply/demand zones. For every BOS/CHoCH, the last
 * opposite-colour candle before the displacement that caused it: a down
 * candle before a bullish break (demand), an up candle before a bearish one
 * (supply). Tracks first mitigation (price returning into the zone) and
 * whether the displacement left a fair value gap.
 */
export function orderBlocks(bars, st = structure(bars)) {
  const gaps = fvgs(bars);
  const out = [];
  for (const e of st.events) {
    const start = e.protectedIdx ?? Math.max(0, e.from - 10);
    // lowest (highest) bar of the leg into the break, then the last opposite candle at/before it
    let ext = start;
    for (let j = start; j <= e.i; j++) {
      if (e.dir === "up" ? bars[j].low < bars[ext].low : bars[j].high > bars[ext].high) ext = j;
    }
    let ob = -1;
    for (let j = ext; j >= Math.max(0, ext - 5); j--) {
      const b = bars[j];
      if (e.dir === "up" ? b.close < b.open : b.close > b.open) { ob = j; break; }
    }
    if (ob < 0) ob = ext;
    const zone = { i: ob, dir: e.dir === "up" ? "demand" : "supply", lo: bars[ob].low, hi: bars[ob].high, breakIdx: e.i, breakType: e.type, legExtremeIdx: ext };
    zone.fvg = gaps.find(g => g.dir === e.dir && g.i > ext && g.i <= e.i) || null;
    zone.mitigatedAt = null;
    for (let j = e.i + 1; j < bars.length; j++) {
      if (zone.dir === "demand" ? bars[j].low <= zone.hi : bars[j].high >= zone.lo) { zone.mitigatedAt = j; break; }
    }
    zone.invalidatedAt = null;
    for (let j = e.i + 1; j < bars.length; j++) {
      if (zone.dir === "demand" ? bars[j].close < zone.lo : bars[j].close > zone.hi) { zone.invalidatedAt = j; break; }
    }
    out.push(zone);
  }
  return out;
}

/**
 * Wyckoff trading ranges: stretches of ≥ minBars whose high-low span is
 * ≤ maxAtrs × ATR. A spring is a bar that trades below the range low and
 * closes back inside (accumulation); an upthrust the mirror (distribution).
 */
export function wyckoff(bars, { minBars = 20, maxAtrs = 4, atrPeriod = 14 } = {}) {
  const n = bars.length;
  if (n < minBars + atrPeriod + 2) return { ranges: [], events: [] };
  const tr = bars.map((b, i) => i ? Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)) : b.high - b.low);
  const ranges = [], events = [];
  let i = atrPeriod;
  while (i + minBars < n) {
    const atr = tr.slice(i - atrPeriod, i).reduce((a, b) => a + b, 0) / atrPeriod;
    let hi = -Infinity, lo = Infinity, j = i, event = null;
    for (; j < n; j++) {
      const b = bars[j];
      // Once the range is established, a poke outside it that closes back
      // inside is a spring / upthrust — it ends the range instead of
      // widening it.
      if (j - i >= minBars) {
        if (b.low < lo && b.close > lo) { event = "spring"; break; }
        if (b.high > hi && b.close < hi) { event = "upthrust"; break; }
      }
      const h = Math.max(hi, b.high), l = Math.min(lo, b.low);
      if (h - l > maxAtrs * atr) break;
      hi = h; lo = l;
    }
    if (j - i >= minBars) {
      const r = { start: i, end: j - 1, hi, lo };
      ranges.push(r);
      // the bar that ended it, or one of the next two: spring / upthrust if
      // it traded outside and closed back inside
      for (let m = j; m < Math.min(n, j + 3); m++) {
        const b = bars[m];
        if ((event === "spring" || !event) && b.low < lo && b.close > lo) { events.push({ i: m, type: "spring", level: lo, range: r }); break; }
        if ((event === "upthrust" || !event) && b.high > hi && b.close < hi) { events.push({ i: m, type: "upthrust", level: hi, range: r }); break; }
      }
      i = j;
    } else i++;
  }
  return { ranges, events };
}
