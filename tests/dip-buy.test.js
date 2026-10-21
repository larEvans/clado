import { test } from "node:test";
import assert from "node:assert/strict";
import { SymbolSeries, decideEntry, updatePosition, evaluateStrategy, rsi2Daily } from "../signals.js";

// Daily history: 205 sessions drifting up (so price > 200-day SMA), then a
// sharp 3-day pullback that pushes RSI(2) near zero.
function history() {
  const d = [];
  for (let k = 0; k < 205; k++) d.push({ day: `2025-${String(1 + Math.floor(k / 28)).padStart(2, "0")}-${String(1 + (k % 28)).padStart(2, "0")}`, open: 100 + k * 0.2, high: 101 + k * 0.2, low: 99 + k * 0.2, close: 100 + k * 0.2 });
  return d;
}
const S0 = Date.UTC(2026, 0, 6, 14, 30);                     // 9:30 ET (EST) on the entry day

function sessionSeries(closes) {
  // one RTH session of 5m bars ending at `closes` pattern; daily history seeded before it
  const s = new SymbolSeries(5);
  s.seedDaily(history());
  let px = 140;
  for (let k = 0; k < 78; k++) {
    const c = closes(k, px);
    s.push({ time: S0 + k * 300_000, open: px, high: Math.max(px, c) + 0.05, low: Math.min(px, c) - 0.05, close: c, volume: 1000 });
    px = c;
  }
  return s;
}

test("rsi2Daily is low after consecutive down closes and high after up closes", () => {
  const down = [100, 101, 102, 101, 99, 96].map((c, i) => ({ day: String(i), close: c }));
  const up = [100, 99, 98, 99, 101, 104].map((c, i) => ({ day: String(i), close: c }));
  assert.ok(rsi2Daily(down, 96) < 10);
  assert.ok(rsi2Daily(up, 104) > 90);
});

test("dip-buy fires only at the 3:55 bar close, above the 200-day SMA with RSI(2) < 10", () => {
  // history ends at 140.8; today sells off to ~138 → RSI(2) collapses, still > SMA (~120)
  const s = sessionSeries((k, px) => px - 0.035);
  const bars = s.get(5);
  const at355 = bars.findIndex(b => new Date(b.time + 300_000).getUTCHours() === 20 && new Date(b.time + 300_000).getUTCMinutes() === 55);
  const sig = evaluateStrategy("dip-buy", bars.slice(0, at355 + 1), {}, s);
  assert.ok(sig, "fires at 15:55");
  assert.equal(sig.side, "buy");
  assert.equal(sig.overnight, true);
  assert.equal(evaluateStrategy("dip-buy", bars.slice(0, at355), {}, s), null, "not on other bars");
});

test("after 3:45 only overnight strategies may enter", () => {
  const s = sessionSeries((k, px) => px - 0.035);
  const base = { state: { series: s, position: null, strategiesTradedToday: new Set() }, completed: new Set([5]), etMins: 15 * 60 + 55,
    day: { strategiesFiredToday: new Set(), tradesToday: 0 }, openCount: 0, halted: false, statsLookup: () => null, predict: () => null };
  const cfg = { activeStrategies: ["hybrid10"], maxConcurrentPositions: 5, predictorEnabled: false };
  assert.match(decideEntry({ ...base, cfg }).reason, /after 3:45/);
  const withDip = decideEntry({ ...base, cfg: { ...cfg, activeStrategies: ["hybrid10", "dip-buy"] } });
  assert.notEqual(withDip.reason, "after 3:45 ET (EOD close)");
});

test("dip-buy exits at 3:55 on a later day when the close clears the prior day's high", () => {
  const s = new SymbolSeries(5);
  s.seedDaily(history());
  const pos = { side: "buy", entry: 140, stop: 0.014, target: 14000, tf: 5, overnight: true, entryDay: "2025-09-15",
    dipExit: { signalTime: "15:55", rsiExit: 70, maxDays: 7 } };
  s.daily.push({ day: "2025-09-15", open: 141, high: 141, low: 139, close: 140 });   // entry day (after the history)
  let px = 140, exit = null;
  for (let k = 0; k < 78 && !exit; k++) {                                           // next session rallies
    const c = px + 0.05;
    const bar = { time: S0 + k * 300_000, open: px, high: c + 0.02, low: px - 0.02, close: c, volume: 1 };
    exit = updatePosition(pos, bar, { series: s, completedTfs: s.push(bar), nearTargetPct: 0 });
    px = c;
  }
  assert.ok(exit, "exited");
  assert.ok(["rsi2-exit", "above-prior-high"].includes(exit.exitReason));
  assert.ok(exit.exitPrice > 141, "above the prior day's high");
});
