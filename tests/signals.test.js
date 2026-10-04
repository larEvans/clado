import { test } from "node:test";
import assert from "node:assert/strict";
import { SymbolSeries, updatePosition, decideEntry, etInfo, sessionOpenMs } from "../signals.js";

const OPEN = Date.UTC(2026, 0, 6, 14, 30);           // 9:30 ET (EST)
const minute = (k, px = 100, extra = {}) => ({ time: OPEN + k * 60_000, open: px, high: px + 0.5, low: px - 0.5, close: px, volume: 100, ...extra });

test("ET helpers", () => {
  assert.deepEqual(etInfo(OPEN), { day: "2026-01-06", mins: 570 });
  assert.equal(sessionOpenMs(OPEN + 3 * 3600_000), OPEN);
  assert.equal(sessionOpenMs(Date.UTC(2026, 6, 6, 18)), Date.UTC(2026, 6, 6, 13, 30));   // EDT
});

test("SymbolSeries aggregates 1m bars into clock-aligned 5m bars", () => {
  const s = new SymbolSeries(1);
  let done;
  for (let k = 0; k < 5; k++) done = s.push(minute(k, 100 + k, { high: 101 + k, low: 99 - k }));
  assert.ok(done.has(5), "the 9:34 bar completes the 9:30 5m bar");
  assert.deepEqual(s.get(5)[0], { time: OPEN, open: 100, high: 105, low: 95, close: 104, volume: 500 });
  assert.equal(s.push(minute(4)).size, 0, "duplicate bar ignored");
});

test("a missing final minute closes the 5m bar late, when the next bucket starts", () => {
  const s = new SymbolSeries(1);
  for (const k of [0, 1, 2, 3]) s.push(minute(k));            // 9:34 never arrives
  assert.equal(s.get(5).length, 0);
  const done = s.push(minute(5));
  assert.ok(done.has(5));
  assert.equal(s.get(5).length, 1);
  assert.equal(s.get(5)[0].volume, 400);
});

test("trailing stop ratchets on native closes, moves to break-even, then stops out", () => {
  const s = new SymbolSeries(5);
  for (let k = 0; k < 30; k++) s.push({ time: OPEN + k * 300_000, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1 });
  const pos = { side: "buy", entry: 100, stop: 98.5, initialStop: 98.5, target: 110, tf: 5, trail: { mult: 1.0, breakEvenR: 1.0, atrPeriod: 14 } };
  let t = OPEN + 30 * 300_000;
  const step = (bar) => { const c = s.push(bar); return updatePosition(pos, bar, { series: s, completedTfs: c, nearTargetPct: 0 }); };
  // The stop ratchets on this bar's close, then this bar's low is checked
  // against it (same order as the reversal backtests), so keep the low above.
  assert.equal(step({ time: t, open: 101.6, high: 102, low: 101.6, close: 102, volume: 1 }), null);
  assert.ok(pos.stop >= 100, "≥ 1R in profit → stop at or above entry");
  const before = pos.stop;
  t += 300_000;
  assert.equal(step({ time: t, open: 102, high: 102.2, low: 101.2, close: 101.3, volume: 1 }), null);
  assert.ok(pos.stop >= before, "stop never loosens");
  t += 300_000;
  const ex = step({ time: t, open: 101, high: 101, low: 99, close: 99.5, volume: 1 });
  assert.equal(ex.exitReason, "trail-stop");
  assert.equal(ex.exitPrice, pos.stop);
});

test("time exits and stop-before-target", () => {
  const pos = { side: "sell", entry: 100, stop: 101, target: 99, timeExitAt: OPEN + 60_000 };
  assert.equal(updatePosition(pos, minute(0, 100, { high: 100.2, low: 99.8 }), { nearTargetPct: 0 }), null);
  assert.equal(updatePosition(pos, minute(1, 100, { high: 100.2, low: 99.8 }), { nearTargetPct: 0 }).exitReason, "time");
  const both = updatePosition({ ...pos, timeExitAt: null }, minute(0, 100, { high: 101.5, low: 98.5 }), { nearTargetPct: 0 });
  assert.equal(both.exitReason, "stop", "a bar through both levels counts as the stop");
});

// decideEntry with a stub strategy fed through extraCandidate.
function ctx(over = {}) {
  const series = new SymbolSeries(5);
  for (let k = 0; k < 40; k++) series.push({ time: OPEN - 40 * 300_000 + k * 300_000, open: 100, high: 101, low: 99, close: 100, volume: 10 });
  return {
    state: { series, position: null, strategiesTradedToday: new Set() },
    completed: new Set([5]), etMins: 10 * 60, openCount: 0, halted: false,
    day: { strategiesFiredToday: new Set(), tradesToday: 0 },
    cfg: { activeStrategies: ["stub"], maxConcurrentPositions: 5, strict: false, consensusMin: 1,
           predictorEnabled: false, predictorVeto: true, predictorMinConfidence: 0.5, predictorSizeScaling: true },
    statsLookup: () => null,
    predict: () => ({ side: "buy", confidence: 0.9, expectedReturnPct: 1, priceTarget: 101 }),
    extraCandidate: () => ({ side: "buy", entry: 100, stop: 99, target: 102 }),
    ...over,
  };
}

test("decideEntry gates", () => {
  assert.equal(decideEntry(ctx({ etMins: 9 * 60 + 40 })).reason, "before 9:45 ET");
  assert.match(decideEntry(ctx({ etMins: 15 * 60 + 50 })).reason, /after 3:45/);
  assert.equal(decideEntry(ctx({ openCount: 5 })).reason, "max concurrent positions");
  assert.equal(decideEntry(ctx({ halted: true })).reason, "daily loss limit");
  const used = ctx(); used.state.strategiesTradedToday.add("stub");
  assert.equal(decideEntry(used).reason, "all strategies used today");
  const d = decideEntry(ctx());
  assert.equal(d.enter, true);
  assert.equal(d.decision.chosen.strategy, "stub");
  assert.equal(d.sizeMultiplier, 1);
});

test("strategySymbols limits a strategy to its whitelisted symbols", () => {
  const cfg = { ...ctx().cfg, strategySymbols: { stub: ["SPY", "QQQ"] } };
  assert.equal(decideEntry(ctx({ cfg, symbol: "SPY" })).enter, true);
  assert.equal(decideEntry(ctx({ cfg, symbol: "TSLA" })).reason, "no strategies for this symbol");
  assert.equal(decideEntry(ctx({ cfg: { ...cfg, strategySymbols: {} }, symbol: "TSLA" })).enter, true, "no entry = all symbols");
});

test("predictor gate: vetoes confident disagreement, scales agreeing trades", () => {
  const on = { predictorEnabled: true, predictorVeto: true, predictorMinConfidence: 0.5, predictorSizeScaling: true };
  const veto = decideEntry(ctx({ cfg: { ...ctx().cfg, ...on }, predict: () => ({ side: "sell", confidence: 0.8 }) }));
  assert.equal(veto.enter, false);
  assert.equal(veto.vetoed, true);
  const weak = decideEntry(ctx({ cfg: { ...ctx().cfg, ...on }, predict: () => ({ side: "sell", confidence: 0.3 }) }));
  assert.equal(weak.enter, true);
  assert.equal(weak.sizeMultiplier, 0.5, "unconfident disagreement halves size");
  const agree = decideEntry(ctx({ cfg: { ...ctx().cfg, ...on }, predict: () => ({ side: "buy", confidence: 0.8 }) }));
  assert.equal(+agree.sizeMultiplier.toFixed(2), 1.15);
});
