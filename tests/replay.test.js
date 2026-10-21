import { test } from "node:test";
import assert from "node:assert/strict";
import { simulate } from "../replay.js";
import { etInfo } from "../signals.js";

// Two symbols, 15 sessions of RTH 5m bars from a seeded random walk.
function data() {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const bars = {};
  for (const sym of ["AAA", "BBB"]) {
    let px = 100;
    bars[sym] = [];
    for (let d = 0; d < 21; d++) {
      const day = new Date(Date.UTC(2026, 0, 5 + d));
      if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
      const open = Date.UTC(2026, 0, 5 + d, 14, 30);
      for (let k = 0; k < 78; k++) {
        const o = px;
        px *= 1 + (rnd() - 0.5) * 0.006;
        bars[sym].push({ symbol: sym, time: open + k * 300_000, open: o, high: Math.max(o, px) * (1 + rnd() * 0.002), low: Math.min(o, px) * (1 - rnd() * 0.002), close: px, volume: 1000 + rnd() * 1000 });
      }
    }
  }
  return { symbols: ["AAA", "BBB"], base: "5m", baseMinutes: 5, bars, statTrades: [] };
}

test("replay applies the live router's rules across days and symbols", () => {
  const { summary, trades } = simulate(data(), {
    mode: "stock", tradeUSD: 100, warmupDays: 2,
    cfg: { activeStrategies: ["reversal", "hybrid-reversal"], predictorEnabled: false, maxConcurrentPositions: 1 },
  });
  assert.ok(trades.length > 0, "random walk should trigger some reversals");
  const perDay = new Map();
  for (const t of trades) {
    const inn = etInfo(t.entryTime), out = etInfo(t.exitTime);
    assert.ok(inn.mins >= 9 * 60 + 45 && inn.mins < 15 * 60 + 45, `entry at ${inn.mins}`);
    assert.equal(inn.day, out.day, "flat by the close — nothing held overnight");
    const k = `${inn.day}|${t.symbol}|${t.strategy}`;
    perDay.set(k, (perDay.get(k) || 0) + 1);
  }
  assert.ok([...perDay.values()].every(n => n === 1), "each strategy trades a symbol at most once a day");
  // maxConcurrentPositions = 1: no two trades overlap in time.
  const sorted = [...trades].sort((a, b) => a.entryTime - b.entryTime);
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].entryTime >= sorted[i - 1].exitTime, "one position at a time");
  assert.equal(summary.trades, trades.length);
  assert.equal(summary.predictorGate, false);
});

test("options mode: stockOnlyStrategies trade shares, symbol whitelists hold", () => {
  const { trades } = simulate(data(), {
    mode: "options", tradeUSD: 100, warmupDays: 2, iv: 0.3,
    cfg: {
      activeStrategies: ["reversal", "hybrid-reversal"], predictorEnabled: false, maxConcurrentPositions: 2, optionsDte: 7,
      stockOnlyStrategies: ["reversal"], strategySymbols: { "hybrid-reversal": ["AAA"] },
    },
  });
  const rev = trades.filter(t => t.strategy === "reversal"), hr = trades.filter(t => t.strategy === "hybrid-reversal");
  assert.ok(rev.length > 0);
  assert.ok(rev.every(t => !t.option), "reversal traded shares");
  assert.ok(hr.every(t => t.option), "hybrid-reversal traded options");
  assert.ok(hr.every(t => t.symbol === "AAA"), "hybrid-reversal only on its whitelisted symbol");
});
