import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseSignal } from "../router.js";

const buy  = { side: "buy",  entry: 100, stop: 99, target: 102 };
const sell = { side: "sell", entry: 100, stop: 101, target: 98 };

// statsLookup stub: stats[strategy][regime ?? "__global__"] → { winRate, sampleSize, avgPnl }
function lookupFrom(stats) {
  return (strategy, regime) => stats[strategy]?.[regime ?? "__global__"] ?? null;
}

const noStats  = () => null;
const noFired  = { strategiesFiredToday: new Set() };

test("no candidates → no trade", () => {
  const res = chooseSignal({ candidates: [], regime: "range:normal-vol", statsLookup: noStats, todayState: noFired });
  assert.equal(res.chosen, null);
  assert.equal(res.reason, "no candidates fired");
});

test("candidates with null signals are ignored", () => {
  const res = chooseSignal({
    candidates: [{ strategy: "orb", signal: null }, null],
    regime: "range:normal-vol", statsLookup: noStats, todayState: noFired,
  });
  assert.equal(res.chosen, null);
});

test("higher win rate wins with equal samples", () => {
  const statsLookup = lookupFrom({
    orb:  { "trend-up:high-vol": { winRate: 0.7, sampleSize: 30, avgPnl: 0.5 } },
    vwap: { "trend-up:high-vol": { winRate: 0.5, sampleSize: 30, avgPnl: 0.1 } },
  });
  const res = chooseSignal({
    candidates: [{ strategy: "orb", signal: buy }, { strategy: "vwap", signal: buy }],
    regime: "trend-up:high-vol", statsLookup, todayState: noFired,
  });
  assert.equal(res.chosen.strategy, "orb");
  assert.equal(res.chosen.source, "regime");
  assert.equal(res.ranking.length, 2);
});

test("falls back to global stats when regime bucket is empty", () => {
  const statsLookup = lookupFrom({
    orb: { __global__: { winRate: 0.6, sampleSize: 20, avgPnl: 0.2 } },
  });
  const res = chooseSignal({
    candidates: [{ strategy: "orb", signal: buy }],
    regime: "trend-down:low-vol", statsLookup, todayState: noFired,
  });
  assert.equal(res.chosen.strategy, "orb");
  assert.equal(res.chosen.source, "global");
});

test("unknown strategy scores with neutral prior", () => {
  const res = chooseSignal({
    candidates: [{ strategy: "brand-new", signal: buy }],
    regime: "range:normal-vol", statsLookup: noStats, todayState: noFired,
  });
  assert.equal(res.chosen.strategy, "brand-new");
  assert.equal(res.chosen.source, "prior");
  assert.equal(res.chosen.sampleSize, 0);
});

test("diversification discount can flip the winner", () => {
  const statsLookup = lookupFrom({
    orb:  { __global__: { winRate: 0.62, sampleSize: 30, avgPnl: 0.3 } },
    vwap: { __global__: { winRate: 0.60, sampleSize: 30, avgPnl: 0.3 } },
  });
  const candidates = [{ strategy: "orb", signal: buy }, { strategy: "vwap", signal: buy }];
  const fresh = chooseSignal({ candidates, regime: "r", statsLookup, todayState: noFired });
  assert.equal(fresh.chosen.strategy, "orb");

  const orbFired = chooseSignal({
    candidates, regime: "r", statsLookup,
    todayState: { strategiesFiredToday: new Set(["orb"]) },
  });
  assert.equal(orbFired.chosen.strategy, "vwap");
  const orbRank = orbFired.ranking.find(r => r.strategy === "orb");
  assert.equal(orbRank.diverseDiscount, 0.8);
});

test("consensus not met → no trade, with vote counts", () => {
  const res = chooseSignal({
    candidates: [{ strategy: "orb", signal: buy }, { strategy: "vwap", signal: sell }],
    regime: "r", statsLookup: noStats, todayState: noFired, consensusMin: 2,
  });
  assert.equal(res.chosen, null);
  assert.deepEqual(res.consensus, { required: 2, buys: 1, sells: 1, met: false });
});

test("consensus met → contrarian side excluded from ranking", () => {
  // "solo" has by far the best stats but is alone on the sell side.
  const statsLookup = lookupFrom({
    solo: { __global__: { winRate: 0.9, sampleSize: 30, avgPnl: 1.0 } },
    orb:  { __global__: { winRate: 0.55, sampleSize: 30, avgPnl: 0.2 } },
    vwap: { __global__: { winRate: 0.50, sampleSize: 30, avgPnl: 0.1 } },
  });
  const res = chooseSignal({
    candidates: [
      { strategy: "solo", signal: sell },
      { strategy: "orb",  signal: buy },
      { strategy: "vwap", signal: buy },
    ],
    regime: "r", statsLookup, todayState: noFired, consensusMin: 2,
  });
  assert.equal(res.chosen.strategy, "orb");
  assert.ok(!res.ranking.some(r => r.strategy === "solo"));
});

test("strict mode blocks picks without regime history", () => {
  const res = chooseSignal({
    candidates: [{ strategy: "orb", signal: buy }],
    regime: "trend-up:high-vol", statsLookup: noStats, todayState: noFired, strict: true,
  });
  assert.equal(res.chosen, null);
  assert.match(res.reason, /strict-router/);
});

test("strict mode allows picks with enough samples", () => {
  const statsLookup = lookupFrom({
    orb: { "trend-up:high-vol": { winRate: 0.65, sampleSize: 12, avgPnl: 0.4 } },
  });
  const res = chooseSignal({
    candidates: [{ strategy: "orb", signal: buy }],
    regime: "trend-up:high-vol", statsLookup, todayState: noFired, strict: true,
  });
  assert.equal(res.chosen.strategy, "orb");
});
