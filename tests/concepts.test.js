import { test } from "node:test";
import assert from "node:assert/strict";
import { structure, orderBlocks, fvgs, wyckoff } from "../concepts.js";

const bar = (o, h, l, c) => ({ time: 0, open: o, high: h, low: l, close: c, volume: 1 });

// Down leg to a swing low, a down candle at the low, then a displacement up
// through the prior swing high.
const path = [
  bar(105, 106, 104, 105), bar(105, 107, 104, 106), bar(106, 108, 105, 107),   // swing high 108 at i=2
  bar(107, 107, 103, 104), bar(104, 105, 102, 103), bar(103, 104, 100, 101),   // leg down
  bar(101, 101.5, 99, 100),                                                    // down candle at the low (order block)
  bar(100, 103, 100, 102.5), bar(102.5, 106, 102.4, 105.8), bar(105.8, 110, 105.9, 109.5), // displacement, FVG, close > 108
  bar(109.5, 110, 108, 108.5), bar(108.5, 109, 101, 102),                      // back into the demand zone
];

test("break of structure and the order block that caused it", () => {
  const st = structure(path, 2);
  const bos = st.events.find(e => e.dir === "up");
  assert.ok(bos, "bullish break detected");
  assert.equal(bos.level, 108);
  const z = orderBlocks(path, st).find(z => z.dir === "demand");
  assert.equal(z.i, 6, "last down candle at the leg's low");
  assert.deepEqual([z.lo, z.hi], [99, 101.5]);
  assert.ok(z.fvg, "the displacement left an inefficiency");
  assert.equal(z.mitigatedAt, 11, "first return into the zone");
});

test("fair value gaps and Wyckoff springs", () => {
  const g = fvgs(path).find(g => g.dir === "up");
  assert.ok(g && g.lo < g.hi);
  const flat = Array.from({ length: 40 }, (_, i) => bar(100, 100.5 + (i % 3) * 0.1, 99.5 - (i % 2) * 0.1, 100));
  const wy = wyckoff([...flat, bar(100, 100.2, 98.8, 99.9)], { minBars: 20, maxAtrs: 4 });
  assert.ok(wy.ranges.length >= 1);
  assert.equal(wy.events.at(-1).type, "spring");
});
