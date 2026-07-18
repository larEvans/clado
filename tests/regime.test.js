import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRegime, regimeTag } from "../regime.js";

const FIVE_MIN = 5 * 60_000;
// A Monday 9:30 AM ET (14:30 UTC during EDT)
const OPEN_TS = Date.parse("2026-06-01T13:30:00Z");

// Build 5-minute bars from a list of closes; each bar's range is ±0.05%.
function mkBars(closes, startTime = OPEN_TS) {
  return closes.map((c, i) => ({
    time:   startTime + i * FIVE_MIN,
    open:   i === 0 ? c : closes[i - 1],
    high:   c * 1.0005,
    low:    c * 0.9995,
    close:  c,
    volume: 1000,
  }));
}

test("too few bars → unknown", () => {
  assert.equal(regimeTag(null), "unknown");
  assert.equal(regimeTag([]), "unknown");
  assert.equal(regimeTag(mkBars(Array(10).fill(100))), "unknown");
});

test("steadily rising closes → trend-up", () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 * (1 + 0.001 * i));
  const { tag, parts } = classifyRegime(mkBars(closes));
  assert.equal(parts.trend, "trend-up");
  assert.match(tag, /^trend-up:/);
});

test("steadily falling closes → trend-down", () => {
  const closes = Array.from({ length: 60 }, (_, i) => 100 * (1 - 0.001 * i));
  const { parts } = classifyRegime(mkBars(closes));
  assert.equal(parts.trend, "trend-down");
});

test("flat closes → range with normal vol", () => {
  const closes = Array(60).fill(100);
  const { tag, parts } = classifyRegime(mkBars(closes));
  assert.equal(parts.trend, "range");
  assert.equal(parts.vol, "normal-vol"); // no 20-day history → normal
  assert.equal(tag, "range:normal-vol");
});

test("open gapping >0.5% above prior close → gap-up", () => {
  const day1 = mkBars(Array(30).fill(100), OPEN_TS);
  const day2 = mkBars(Array(25).fill(101.5), OPEN_TS + 24 * 3600_000);
  const { parts } = classifyRegime([...day1, ...day2]);
  assert.equal(parts.gap, "gap-up");
});

test("open gapping >0.5% below prior close → gap-down", () => {
  const day1 = mkBars(Array(30).fill(100), OPEN_TS);
  const day2 = mkBars(Array(25).fill(98.8), OPEN_TS + 24 * 3600_000);
  const { parts } = classifyRegime([...day1, ...day2]);
  assert.equal(parts.gap, "gap-down");
});

test("tag composes only the present parts", () => {
  const closes = Array(60).fill(100);
  const { tag } = classifyRegime(mkBars(closes));
  // no gap, no orb quality → exactly two segments
  assert.equal(tag.split(":").length, 2);
});
