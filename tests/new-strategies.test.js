import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateStrategy, updatePosition, SymbolSeries } from "../signals.js";

// 5m RTH bars for `days` weekdays (January = EST: 9:30 ET = 14:30 UTC).
// dayPath(d, k) → close of bar k (0..77) on day d.
function sessions(days, dayPath) {
  const bars = [];
  let d = 0;
  for (let cal = 0; d < days; cal++) {
    const date = new Date(Date.UTC(2026, 0, 5 + cal));
    if (date.getUTCDay() === 0 || date.getUTCDay() === 6) continue;
    const open = Date.UTC(2026, 0, 5 + cal, 14, 30);
    let prev = dayPath(d, 0);
    for (let k = 0; k < 78; k++) {
      const c = dayPath(d, k);
      bars.push({ time: open + k * 300_000, open: prev, high: Math.max(prev, c) + 0.05, low: Math.min(prev, c) - 0.05, close: c, volume: 1000 });
      prev = c;
    }
    d++;
  }
  return bars;
}
const barEndingAt = (bars, hh, mm) => bars.findIndex(b => { const d = new Date(b.time + 300_000); return d.getUTCHours() === hh + 5 && d.getUTCMinutes() === mm; });

test("hybrid10 relative-volume filter keeps breakouts on heavy-volume opens only", () => {
  // 15 flat days with normal opening volume, then a 9:45 breakout day whose
  // first 10 minutes trade `openVol` per 5m bar (normal = 1000).
  const day = openVol => sessions(16, (d, k) => 100 + (d < 15 ? 0.02 * Math.sin(k) : k < 2 ? 0.02 * k : 100.3 - 100))
    .map((b, i, all) => {
      const last = i >= all.length - 78, k = i % 78;
      if (!last) return b;
      return { ...b, volume: k < 2 ? openVol : k === 2 ? 5000 : 1000 };
    });
  const at945 = bars => bars.slice(0, bars.length - 78 + 3);        // up to the bar ending 9:45
  assert.ok(evaluateStrategy("hybrid10", at945(day(500))), "filter off: breakout fires");
  const on = { minRelVol: 1.0 };
  const heavy = evaluateStrategy("hybrid10", at945(day(3000)), on);
  assert.ok(heavy, "3× normal opening volume: in play");
  assert.equal(heavy.relVol, 3);
  assert.equal(evaluateStrategy("hybrid10", at945(day(500)), on), null, "half normal volume: filtered out");
});

test("late-momentum fires only at 3:30 ET, with the day's direction, held to the close", () => {
  // Each day drifts up 0.5%; the last day drifts down.
  const bars = sessions(3, (d, k) => d < 2 ? 100 + d + k * 0.0065 : 101.5 - k * 0.02);
  const lastDayStart = bars.length - 78;
  const i330 = lastDayStart + barEndingAt(bars.slice(lastDayStart), 15, 30);
  const sig = evaluateStrategy("late-momentum", bars.slice(0, i330 + 1));
  assert.equal(sig.side, "sell", "down since the prior close → short");
  assert.equal(sig.eodMins, 16 * 60, "held to the 4:00 close, past the 3:45 EOD");
  assert.equal(evaluateStrategy("late-momentum", bars.slice(0, i330)), null, "no signal on other bars");
});

test("noise-momentum: breaks out of the 14-day noise band at a 30-minute check", () => {
  // 15 quiet days wiggling ±0.2%, then a day that runs +1.5% by 10:00.
  const quiet = (d, k) => 100 * (1 + 0.002 * Math.sin(k / 3 + d));
  const bars = sessions(16, (d, k) => d < 15 ? quiet(d, k) : 100 * (1 + Math.min(k, 6) * 0.0025));
  const last = bars.length - 78;
  const i1000 = last + barEndingAt(bars.slice(last), 10, 0);
  const sig = evaluateStrategy("noise-momentum", bars.slice(0, i1000 + 1));
  assert.equal(sig.side, "buy");
  assert.ok(sig.bandStop && sig.bandStop.every === 30);
  assert.ok(sig.bandStop.level < sig.entry, "band edge is below the breakout price");
  assert.equal(evaluateStrategy("noise-momentum", bars.slice(0, i1000)), null, "9:55 is not a check time");
});

test("band-stop exits on a 30-minute close back through max(band, VWAP)", () => {
  const s = new SymbolSeries(5);
  const open = Date.UTC(2026, 0, 6, 14, 30);
  for (let k = 0; k < 12; k++) s.push({ time: open + k * 300_000, open: 100, high: 100.2, low: 99.8, close: 100, volume: 100 });
  const pos = { side: "buy", entry: 101, stop: 95, target: 120, tf: 5, bandStop: { level: 100.5, every: 30 } };
  // Bar ending 10:35 (not a check) closes below the band: no exit yet.
  let bar = { time: open + 12 * 300_000, open: 100.3, high: 100.4, low: 100.1, close: 100.2, volume: 100 };
  assert.equal(updatePosition(pos, bar, { series: s, completedTfs: s.push(bar), nearTargetPct: 0 }), null);
  // Walk to the bar ending 11:00 (a check), still below the band: exit at its close.
  for (let k = 13; k < 17; k++) { bar = { ...bar, time: open + k * 300_000 }; updatePosition(pos, bar, { series: s, completedTfs: s.push(bar), nearTargetPct: 0 }); }
  bar = { ...bar, time: open + 17 * 300_000 };
  const ex = updatePosition(pos, bar, { series: s, completedTfs: s.push(bar), nearTargetPct: 0 });
  assert.equal(ex?.exitReason, "band-stop");
});
