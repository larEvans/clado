import { test } from "node:test";
import assert from "node:assert/strict";
import { ema, atr } from "../indicators.js";

test("ema returns null with insufficient data", () => {
  assert.equal(ema([1, 2, 3], 5), null);
});

test("ema of a constant series is the constant", () => {
  assert.equal(ema(Array(30).fill(42), 9), 42);
});

test("ema tracks toward recent values", () => {
  const rising = Array.from({ length: 30 }, (_, i) => i + 1); // 1..30
  const e = ema(rising, 9);
  assert.ok(e > 20 && e < 30, `expected ema near recent values, got ${e}`);
});

test("atr returns null with insufficient bars", () => {
  assert.equal(atr([{ high: 1, low: 0, close: 0.5 }], 14), null);
});

test("atr of constant-range bars equals the range", () => {
  const bars = Array.from({ length: 20 }, () => ({ high: 101, low: 100, close: 100.5 }));
  assert.ok(Math.abs(atr(bars, 14) - 1) < 1e-9);
});
