import { test } from "node:test";
import assert from "node:assert/strict";
import { liquidityLevels, liquidityTarget, fairValueGaps, sweeps } from "../ict.js";

// Two sessions of 5m RTH bars (January: 9:30 ET = 14:30 UTC).
const bar = (t, o, h, l, c) => ({ time: t, open: o, high: h, low: l, close: c, volume: 100 });
const D1 = Date.UTC(2026, 0, 6, 14, 30), D2 = Date.UTC(2026, 0, 7, 14, 30), M5 = 300_000;

function twoDays() {
  const bars = [];
  // Day 1 ranges 99..103 (PDH 103, PDL 99).
  for (let k = 0; k < 78; k++) {
    const mid = 101 + 1.5 * Math.sin(k / 12);          // stays inside 99.4..102.6
    bars.push(bar(D1 + k * M5, mid, mid + 0.1, mid - 0.1, mid));
  }
  bars[20] = { ...bars[20], high: 103 };
  bars[50] = { ...bars[50], low: 99 };
  // Day 2 so far: quiet around 101.
  for (let k = 0; k < 20; k++) bars.push(bar(D2 + k * M5, 101, 101.2, 100.8, 101));
  return bars;
}

test("previous-day high/low are liquidity", () => {
  const liq = liquidityLevels(twoDays());
  assert.equal(liq.pdh, 103);
  assert.equal(liq.pdl, 99);
  assert.ok(liq.levels.some(l => l.kind === "PDH" && l.side === "buy"));
  assert.ok(liq.levels.some(l => l.kind === "PDL" && l.side === "sell"));
});

test("target = nearest liquidity pool paying ≥ minRR × risk, else none", () => {
  const bars = twoDays();
  // Long at 101, stop 100.5 (risk 0.5): needs ≥ 102 → PDH 103 (session high 101.2 is too close).
  const t = liquidityTarget("buy", 101, 100.5, bars, 2);
  assert.ok(t.price >= 102, `target ${t?.price}`);
  // Stop 99.5 (risk 1.5): needs ≥ 104 — nothing that far → no trade.
  assert.equal(liquidityTarget("buy", 101, 99.5, bars, 2), null);
  // Short at 101, stop 101.5: needs ≤ 100 → PDL 99 or a swing low ≤ 100.
  const s = liquidityTarget("sell", 101, 101.5, bars, 2);
  assert.ok(s.price <= 100);
});

test("swing highs already traded through are not liquidity", () => {
  const bars = twoDays();
  const before = liquidityLevels(bars).levels.filter(l => l.kind === "swing-high").length;
  // A late bar takes out every high: no untaken swing highs remain.
  bars.push(bar(D2 + 20 * M5, 101, 104, 100.9, 101));
  bars.push(bar(D2 + 21 * M5, 101, 101.1, 100.9, 101));
  const after = liquidityLevels(bars).levels.filter(l => l.kind === "swing-high" && l.price < 104).length;
  assert.ok(before > 0);
  assert.equal(after, 0);
});

test("fair value gaps and sweeps", () => {
  const up = [bar(0, 100, 100.5, 99.5, 100.4), bar(1, 100.4, 102, 100.4, 101.9), bar(2, 101.9, 102.5, 101, 102.4)];
  assert.deepEqual(fairValueGaps(up), { bull: 1, bear: 0 });                    // 100.5 < 101
  const filled = [...up, bar(3, 102.4, 102.4, 100.4, 100.6)];
  assert.deepEqual(fairValueGaps(filled), { bull: 0, bear: 0 });

  const flat = Array.from({ length: 25 }, (_, i) => bar(i, 100, 101, 99, 100));
  const swept = [...flat, bar(25, 100, 101.5, 99.8, 100.5)];                    // above 101, closed back below
  assert.deepEqual(sweeps(swept), { high: 1, low: 0 });
});
