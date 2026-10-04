import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const dir = mkdtempSync(join(tmpdir(), "symbols-test-"));
process.env.DATA_DIR = dir;
process.env.SYMBOLS  = " spy, tsla,SPY,,bad symbol,QQQ ";
const { loadSymbols, addSymbol, removeSymbol } = await import("../symbols.js");

test("seeds from SYMBOLS env, normalized and de-duplicated", () => {
  assert.deepEqual(loadSymbols(), ["SPY", "TSLA", "QQQ"]);
});

test("add/remove persist to symbols.json and override the env", () => {
  assert.deepEqual(addSymbol("meta").symbols, ["SPY", "TSLA", "QQQ", "META"]);
  assert.equal(addSymbol("META").added, false);
  assert.equal(removeSymbol("tsla").removed, true);
  assert.equal(removeSymbol("NOPE").removed, false);
  process.env.SYMBOLS = "IWM";
  assert.deepEqual(loadSymbols(), ["SPY", "QQQ", "META"]);
  assert.throws(() => addSymbol("BTC/USD"), /invalid symbol/);
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
