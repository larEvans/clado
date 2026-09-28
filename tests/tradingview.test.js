import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTvAlert, findFreshAlert, buildTvTradeSignal, secretMatches } from "../tradingview.js";

const bars = Array.from({ length: 30 }, (_, i) => {
  const c = 100 + i * 0.1;
  return { open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1000 };
});
const last = bars[bars.length - 1].close;

// ── parsing ────────────────────────────────────────────────────────────────────

test("parses a strategy alert and strips the exchange prefix", () => {
  const a = parseTvAlert({ symbol: "NASDAQ:TSLA", action: "buy", position: "long", price: "250.5" });
  assert.equal(a.symbol, "TSLA");
  assert.equal(a.side, "buy");
  assert.equal(a.price, 250.5);
  assert.ok(a.id && a.receivedAt);
});

test("position 'flat' means exit even when action says sell", () => {
  // A long-only strategy closing its long sends action=sell, position=flat.
  assert.equal(parseTvAlert({ symbol: "SPY", action: "sell", position: "flat" }).side, "exit");
});

test("position 'short' means sell even when action says buy is absent", () => {
  assert.equal(parseTvAlert({ symbol: "SPY", action: "sell", position: "short" }).side, "sell");
});

test("indicator alerts use action alone; accepts a JSON string body", () => {
  assert.equal(parseTvAlert('{"symbol":"QQQ","action":"close"}').side, "exit");
  assert.equal(parseTvAlert({ ticker: "meta", side: "short" }).side, "sell");
});

test("rejects unknown actions, bad symbols and non-JSON", () => {
  assert.throws(() => parseTvAlert({ symbol: "SPY", action: "hold" }), /unrecognized action/);
  assert.throws(() => parseTvAlert({ symbol: "", action: "buy" }), /invalid symbol/);
  assert.throws(() => parseTvAlert("not json"), /not valid JSON/);
});

test("secretMatches is false when TV_WEBHOOK_SECRET is unset", () => {
  delete process.env.TV_WEBHOOK_SECRET;
  assert.equal(secretMatches("anything"), false);
  process.env.TV_WEBHOOK_SECRET = "s3cret";
  assert.equal(secretMatches("s3cret"), true);
  assert.equal(secretMatches("wrong"), false);
  delete process.env.TV_WEBHOOK_SECRET;
});

// ── freshness / consumption ────────────────────────────────────────────────────

const now = Date.parse("2026-09-28T15:00:00Z");
const at = secAgo => new Date(now - secAgo * 1000).toISOString();
const alerts = [
  { id: "old", symbol: "SPY", side: "buy",  receivedAt: at(900) },
  { id: "a1",  symbol: "SPY", side: "buy",  receivedAt: at(120) },
  { id: "x1",  symbol: "SPY", side: "exit", receivedAt: at(30) },
  { id: "t1",  symbol: "TSLA", side: "sell", receivedAt: at(10) },
];

test("finds the newest fresh alert for the symbol and side", () => {
  assert.equal(findFreshAlert(alerts, "SPY", ["buy", "sell"], { maxAgeSec: 300, now }).id, "a1");
  assert.equal(findFreshAlert(alerts, "TSLA", ["buy", "sell"], { maxAgeSec: 300, now }).id, "t1");
});

test("ignores stale and consumed alerts", () => {
  assert.equal(findFreshAlert(alerts, "SPY", ["buy"], { maxAgeSec: 300, consumed: new Set(["a1"]), now }), null);
  assert.equal(findFreshAlert(alerts, "SPY", ["buy"], { maxAgeSec: 60, now }), null);
});

test("afterIso excludes alerts received before a position was opened", () => {
  assert.equal(findFreshAlert(alerts, "SPY", ["exit"], { maxAgeSec: 300, afterIso: at(60), now }).id, "x1");
  assert.equal(findFreshAlert(alerts, "SPY", ["exit"], { maxAgeSec: 300, afterIso: at(10), now }), null);
});

// ── signal construction ────────────────────────────────────────────────────────

test("builds a long with ATR stop and 2R target from the live price", () => {
  const s = buildTvTradeSignal({ id: "a", side: "buy", price: 1 }, bars, { stopAtrMult: 1.5, rr: 2 });
  assert.equal(s.entry, last);            // live bar price, not the alert's price
  assert.ok(s.stop < s.entry);
  assert.ok(Math.abs((s.target - s.entry) - 2 * (s.entry - s.stop)) < 1e-9);
  assert.equal(s.tvAlertId, "a");
});

test("uses the alert's own stop/target when on the correct side", () => {
  const s = buildTvTradeSignal({ id: "b", side: "sell", stop: last + 2, target: last - 5 }, bars);
  assert.equal(s.stop, last + 2);
  assert.equal(s.target, last - 5);
});

test("ignores a stop on the wrong side and falls back to ATR", () => {
  const s = buildTvTradeSignal({ id: "c", side: "buy", stop: last + 1 }, bars);
  assert.ok(s.stop < s.entry);
});

test("exit alerts never build an entry signal", () => {
  assert.equal(buildTvTradeSignal({ id: "d", side: "exit" }, bars), null);
});
