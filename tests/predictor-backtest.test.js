import { test } from "node:test";
import assert from "node:assert/strict";
import { runBacktest } from "../backtest.js";

// Three synthetic sessions of 5m RTH bars (Jan = EST, so 9:30 ET = 14:30 UTC),
// trending up with some range so the predictor has something to forecast.
function sessions(days = 3) {
  const out = [];
  let px = 100;
  for (let d = 0; d < days; d++) {
    const open = Date.UTC(2026, 0, 5 + d, 14, 30);
    for (let k = 0; k < 78; k++) {
      const o = px;
      px *= 1 + 0.0008 + (k % 5 === 0 ? -0.0015 : 0);
      out.push({ time: open + k * 5 * 60_000, open: o, high: Math.max(o, px) * 1.001, low: Math.min(o, px) * 0.999, close: px, volume: 1000 });
    }
  }
  return out;
}

const etMins = ms => { const d = new Date(ms - 5 * 3600_000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
// Fire on any forecast, so the test exercises the harness rules, not the model.
const loose = { minEdge: 0, minConfidence: 0, minRR: 0 };

test("predictor backtest follows the live router's session rules", async () => {
  const candles = sessions();
  const r = await runBacktest("predictor", "TEST", { _candles: candles, params: loose, includeInSample: true });
  assert.ok(r.totalTrades > 0, "expected trades with loose thresholds");
  const perDay = {};
  for (const t of r.trades) {
    assert.ok(etMins(t.entryTime) >= 9 * 60 + 45, "no entries before 9:45 ET");
    assert.ok(t.exitTime > t.entryTime);
    assert.ok(etMins(t.exitTime) <= 15 * 60 + 45, "flat by the 3:45 ET EOD close");
    perDay[t.date] = (perDay[t.date] || 0) + 1;
    assert.ok(["stop", "target", "near-target", "eod"].includes(t.exitReason));
    assert.ok(t.prediction && Number.isFinite(t.prediction.confidence));
  }
  assert.ok(Object.values(perDay).every(n => n === 1), "one predictor trade per symbol per day");
  assert.equal(r.tradingDays, 3);
});

test("oosStartMs keeps entries out of the model's training period", async () => {
  const candles = sessions();
  const cutoff = Date.UTC(2026, 0, 7, 14, 30);   // start of day 3
  const r = await runBacktest("predictor", "TEST", { _candles: candles, params: loose, includeInSample: true, oosStartMs: cutoff });
  assert.ok(r.trades.every(t => t.entryTime >= cutoff));
  assert.equal(r.tradingDays, 1);
});

test("default thresholds are the live ones and can reject everything", async () => {
  const r = await runBacktest("predictor", "TEST", { _candles: sessions(), includeInSample: true, params: { minConfidence: 2 } });
  assert.equal(r.totalTrades, 0);
});
