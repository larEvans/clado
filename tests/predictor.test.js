import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFeatures, FEATURE_NAMES, FEATURE_COUNT } from "../ml/features.js";
import { predict } from "../ml/predictor.js";
import { screenWatchlist } from "../ml/screener.js";
import { compileModel, predictRaw } from "../ml/xgb-runtime.js";
import { checkSignal as predictorSignal, evaluatePrediction, effectiveThresholds, meta as predictorMeta } from "../strategies/predictor-strat.js";

// Build synthetic bars from a list of closes; range is ±0.1% around close.
function mkBars(closes, vol = 1000) {
  return closes.map(c => ({ open: c, high: c * 1.001, low: c * 0.999, close: c, volume: vol }));
}

const RISING = mkBars(Array.from({ length: 60 }, (_, i) => 100 + i));      // steady uptrend
const FALLING = mkBars(Array.from({ length: 60 }, (_, i) => 160 - i));     // steady downtrend
const FLAT = mkBars(Array(60).fill(100));

// ── features ──────────────────────────────────────────────────────────────────

test("feature vector is always the declared length", () => {
  assert.equal(FEATURE_NAMES.length, FEATURE_COUNT);
  assert.equal(extractFeatures(RISING).length, FEATURE_COUNT);
  assert.equal(extractFeatures([]).length, FEATURE_COUNT); // empty → zero-padded
  assert.equal(extractFeatures([{ open: 1, high: 1, low: 1, close: 1, volume: 1 }]).length, FEATURE_COUNT);
});

test("feature values are all finite", () => {
  for (const v of extractFeatures(RISING)) assert.ok(Number.isFinite(v), `non-finite feature: ${v}`);
  for (const v of extractFeatures(FALLING)) assert.ok(Number.isFinite(v));
});

test("ema spread is positive in an uptrend and negative in a downtrend", () => {
  const iSpread = FEATURE_NAMES.indexOf("ema9_21_spread");
  assert.ok(extractFeatures(RISING)[iSpread] > 0);
  assert.ok(extractFeatures(FALLING)[iSpread] < 0);
});

// ── heuristic predictor (no model.json present in CI) ──────────────────────────

test("predict returns a well-formed prediction", () => {
  const p = predict(RISING);
  assert.ok(["buy", "sell"].includes(p.side));
  assert.ok(Number.isFinite(p.expectedReturnPct));
  assert.ok(Number.isFinite(p.priceTarget) && p.priceTarget > 0);
  assert.ok(p.confidence >= 0 && p.confidence <= 1);
  assert.ok(p.horizonDays >= 1);
});

test("price target is consistent with expected return and price", () => {
  const p = predict(RISING);
  const expected = p.price * (1 + p.expectedReturnPct / 100);
  assert.ok(Math.abs(p.priceTarget - expected) < 1e-6);
});

test("heuristic leans long on an uptrend and short on a downtrend", () => {
  assert.equal(predict(RISING).side, "buy");
  assert.equal(predict(FALLING).side, "sell");
});

test("confidence is dampened when there is too little history", () => {
  const few = predict(mkBars([100, 101, 102, 103, 104])); // < MIN_BARS
  const many = predict(RISING);
  assert.ok(few.confidence <= many.confidence);
});

// ── screener ranking ───────────────────────────────────────────────────────────

test("screener ranks stronger expected edge higher", () => {
  const rows = [
    { symbol: "FLAT", bars: FLAT },
    { symbol: "UP", bars: RISING },
    { symbol: "DOWN", bars: FALLING },
  ];
  const { picks, count } = screenWatchlist(rows);
  assert.equal(count, 3);
  // Every pick sorted by rankScore descending
  for (let i = 1; i < picks.length; i++) {
    assert.ok(picks[i - 1].rankScore >= picks[i].rankScore);
  }
});

test("screener honors a minConfidence filter", () => {
  const rows = [{ symbol: "UP", bars: RISING }, { symbol: "FLAT", bars: FLAT }];
  const filtered = screenWatchlist(rows, { minConfidence: 1.01 }); // impossible → none pass
  assert.equal(filtered.picks.length, 0);
});

// ── XGBoost JS runtime (matches XGBoost's dump semantics) ───────────────────────

test("xgb-runtime walks a two-tree booster correctly", () => {
  // Two shallow trees over feature f0. Rule: go 'yes' when f0 < split.
  const model = {
    base_score: 0.5,
    feature_names: ["f0", "f1"],
    trees: [
      { nodeid: 0, split: "f0", split_condition: 10, yes: 1, no: 2, missing: 1,
        children: [{ nodeid: 1, leaf: -1 }, { nodeid: 2, leaf: 2 }] },
      { nodeid: 0, split: "f1", split_condition: 5, yes: 1, no: 2, missing: 1,
        children: [{ nodeid: 1, leaf: 0.25 }, { nodeid: 2, leaf: -0.25 }] },
    ],
  };
  const compiled = compileModel(model);
  // f0=5 (<10 → -1), f1=9 (>=5 → -0.25): 0.5 - 1 - 0.25 = -0.75
  assert.ok(Math.abs(predictRaw(compiled, [5, 9]) - (-0.75)) < 1e-9);
  // f0=20 (>=10 → 2), f1=1 (<5 → 0.25): 0.5 + 2 + 0.25 = 2.75
  assert.ok(Math.abs(predictRaw(compiled, [20, 1]) - 2.75) < 1e-9);
});

// ── predictor strategy (signal generator) ──────────────────────────────────────

test("predictor strategy fires a well-formed signal on a strong trend", () => {
  // Loose thresholds so the heuristic's uptrend read clears them
  const sig = predictorSignal(RISING, { ...predictorMeta.params, minEdge: 0.01, minConfidence: 0.1 });
  assert.ok(sig, "expected a signal on a strong uptrend");
  assert.equal(sig.side, "buy");
  assert.ok(sig.target > sig.entry, "long target must be above entry");
  assert.ok(sig.stop < sig.entry, "long stop must be below entry");
  assert.equal(sig.entrySignal, "predictor");
  assert.ok(sig.prediction && sig.prediction.confidence > 0);
});

test("predictor strategy shorts a downtrend with stop above entry", () => {
  const sig = predictorSignal(FALLING, { ...predictorMeta.params, minEdge: 0.01, minConfidence: 0.1 });
  assert.ok(sig);
  assert.equal(sig.side, "sell");
  assert.ok(sig.target < sig.entry);
  assert.ok(sig.stop > sig.entry);
});

test("predictor strategy returns null below thresholds, with the reason", () => {
  const ev = evaluatePrediction(FLAT, { ...predictorMeta.params, minEdge: 99, minConfidence: 0.99 });
  assert.equal(ev.signal, null);
  assert.equal(ev.wouldFire, false);
  assert.ok(ev.skipReason, "skip reason should be populated");
});

test("predictor strategy returns null on insufficient bars", () => {
  const ev = evaluatePrediction(mkBars([100, 101, 102]));
  assert.equal(ev.signal, null);
  assert.match(ev.skipReason, /insufficient/);
});

// ── daily-floor threshold tiers ────────────────────────────────────────────────

const FLOOR_CFG = {
  minTradesPerDay: 2,
  floorTimeMins: 14 * 60 + 30,
  base:  { minEdge: 0.35, minConfidence: 0.55 },
  floor: { minEdge: 0.15, minConfidence: 0.35 },
};

test("floor: tier 1 (strict) before the floor time even when behind", () => {
  const t = effectiveThresholds({ ...FLOOR_CFG, etMins: 10 * 60, tradesToday: 0 });
  assert.equal(t.tier, 1);
  assert.equal(t.minEdge, 0.35);
});

test("floor: tier 2 (relaxed) after floor time when behind the daily minimum", () => {
  const t = effectiveThresholds({ ...FLOOR_CFG, etMins: 15 * 60, tradesToday: 1 });
  assert.equal(t.tier, 2);
  assert.equal(t.minEdge, 0.15);
  assert.equal(t.minConfidence, 0.35);
});

test("floor: stays tier 1 after floor time once the minimum is met", () => {
  const t = effectiveThresholds({ ...FLOOR_CFG, etMins: 15 * 60, tradesToday: 2 });
  assert.equal(t.tier, 1);
});

test("floor: disabled when minTradesPerDay is 0", () => {
  const t = effectiveThresholds({ ...FLOOR_CFG, minTradesPerDay: 0, etMins: 15 * 60, tradesToday: 0 });
  assert.equal(t.tier, 1);
});

test("xgb-runtime sends NaN features down the missing branch", () => {
  const model = {
    base_score: 0,
    feature_names: ["f0"],
    trees: [{ nodeid: 0, split: "f0", split_condition: 10, yes: 1, no: 2, missing: 2,
      children: [{ nodeid: 1, leaf: 1 }, { nodeid: 2, leaf: -1 }] }],
  };
  const compiled = compileModel(model);
  assert.equal(predictRaw(compiled, [NaN]), -1); // missing → node 2 → -1
});
