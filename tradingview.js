/**
 * TradingView webhook alerts → bot signals.
 *
 * TradingView has no public market-data API, so the bot keeps streaming prices
 * from Alpaca. What TradingView contributes is *signals*: an alert on a chart,
 * indicator or Pine strategy POSTs a JSON message to the dashboard's
 * /webhook/tradingview endpoint. The dashboard validates it and appends it to
 * tv-signals.json in DATA_DIR; bot-stream.js reads that file and treats a fresh
 * alert as a candidate from the "tradingview" strategy, so it goes through the
 * same router, risk limits, predictor gate and options planner as everything
 * else. (The two processes share DATA_DIR when started together by start.js.)
 *
 * Alert message (paste into the TradingView alert's "Message" box):
 *   {"secret":"<TV_WEBHOOK_SECRET>","symbol":"{{ticker}}",
 *    "action":"{{strategy.order.action}}","position":"{{strategy.market_position}}",
 *    "price":{{close}}}
 * Optional fields: "stop", "target" (prices), "strategy" (a label for logs).
 * For plain indicator alerts, hard-code "action":"buy" / "sell" / "exit".
 */

import { readFileSync, writeFileSync, renameSync, existsSync, statSync } from "fs";
import { timingSafeEqual, randomBytes } from "crypto";
import { atr } from "./indicators.js";
import { dataPath } from "./state.js";

const SIGNALS_FILE = dataPath("tv-signals.json");
const MAX_STORED   = 200;

export const TV_SECRET      = () => (process.env.TV_WEBHOOK_SECRET || "").trim();
export const TV_ENABLED     = () => TV_SECRET().length > 0;
export const TV_MAX_AGE_SEC = () => parseInt(process.env.TV_SIGNAL_MAX_AGE_SEC || "300");

/** Constant-time comparison against TV_WEBHOOK_SECRET (false when unset). */
export function secretMatches(candidate) {
  const secret = TV_SECRET();
  if (!secret || candidate == null) return false;
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

const num = v => (v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * Normalize a raw alert body into { id, symbol, side, price, stop, target,
 * strategy, receivedAt }. side is "buy" | "sell" | "exit". Throws on bad input.
 *
 * With strategy alerts, "position" ({{strategy.market_position}}) wins over
 * "action": a long-only strategy's exit arrives as action "sell" but position
 * "flat", which must close the long — not open a short.
 */
export function parseTvAlert(body) {
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { throw new Error("alert message is not valid JSON"); }
  }
  if (!body || typeof body !== "object") throw new Error("alert body must be a JSON object");

  const rawSymbol = String(body.symbol ?? body.ticker ?? "").trim().toUpperCase();
  const symbol = rawSymbol.includes(":") ? rawSymbol.split(":").pop() : rawSymbol; // "NASDAQ:TSLA" → "TSLA"
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(symbol)) throw new Error(`invalid symbol "${rawSymbol}"`);

  const position = String(body.position ?? body.market_position ?? "").trim().toLowerCase();
  const action   = String(body.action ?? body.side ?? "").trim().toLowerCase();
  let side;
  if (position === "flat")                           side = "exit";
  else if (position === "long")                      side = "buy";
  else if (position === "short")                     side = "sell";
  else if (["buy", "long"].includes(action))         side = "buy";
  else if (["sell", "short"].includes(action))       side = "sell";
  else if (["exit", "close", "flat", "closeall"].includes(action)) side = "exit";
  else throw new Error(`unrecognized action "${action || "(missing)"}" — use buy, sell or exit`);

  return {
    id:         `${Date.now()}-${randomBytes(3).toString("hex")}`,
    symbol,
    side,
    price:      num(body.price),
    stop:       num(body.stop),
    target:     num(body.target),
    strategy:   body.strategy ? String(body.strategy).slice(0, 60) : null,
    receivedAt: new Date().toISOString(),
  };
}

// ── Signal store (dashboard writes, bot reads) ────────────────────────────────

let _cache = { mtimeMs: -1, alerts: [] };

/** All stored alerts, oldest → newest. Cached on file mtime (read every bar). */
export function readTvAlerts() {
  try {
    if (!existsSync(SIGNALS_FILE)) return [];
    const mtimeMs = statSync(SIGNALS_FILE).mtimeMs;
    if (mtimeMs !== _cache.mtimeMs) {
      const parsed = JSON.parse(readFileSync(SIGNALS_FILE, "utf8"));
      _cache = { mtimeMs, alerts: Array.isArray(parsed) ? parsed : [] };
    }
  } catch { /* mid-write or corrupt — keep the last good copy */ }
  return _cache.alerts;
}

/** Append one alert; atomic write (temp file + rename) so readers never see half a file. */
export function appendTvAlert(alert) {
  const alerts = [...readTvAlerts(), alert].slice(-MAX_STORED);
  const tmp = `${SIGNALS_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(alerts, null, 2));
  renameSync(tmp, SIGNALS_FILE);
  _cache = { mtimeMs: -1, alerts };
  return alert;
}

export const alertAgeSec = (a, now = Date.now()) => (now - new Date(a.receivedAt).getTime()) / 1000;

/**
 * Newest alert for `symbol` whose side is in `sides`, not yet consumed, fresher
 * than maxAgeSec, and (optionally) received after `afterIso`.
 */
export function findFreshAlert(alerts, symbol, sides, { consumed = new Set(), maxAgeSec = TV_MAX_AGE_SEC(), afterIso = null, now = Date.now() } = {}) {
  const after = afterIso ? new Date(afterIso).getTime() : -Infinity;
  for (let i = alerts.length - 1; i >= 0; i--) {
    const a = alerts[i];
    if (a.symbol !== symbol || !sides.includes(a.side) || consumed.has(a.id)) continue;
    const t = new Date(a.receivedAt).getTime();
    if (alertAgeSec(a, now) > maxAgeSec) return null; // everything older is stale too
    if (t <= after) continue;
    return a;
  }
  return null;
}

/**
 * Turn an entry alert into a router-shaped signal priced off the live bar
 * buffer (the alert's price may come from a different feed or be seconds old).
 * Uses the alert's stop/target when they sit on the correct side of entry,
 * else stop = ATR(14) × stopAtrMult and target = rr × risk.
 */
export function buildTvTradeSignal(alert, bars, { stopAtrMult = 1.5, rr = 2 } = {}) {
  if (!alert || (alert.side !== "buy" && alert.side !== "sell")) return null;
  const entry = bars?.length ? bars[bars.length - 1].close : alert.price;
  if (!entry) return null;
  const long = alert.side === "buy";

  let stop = alert.stop;
  if (stop == null || (long ? stop >= entry : stop <= entry)) {
    const a = atr(bars || [], 14);
    if (!a) return null; // no usable stop and not enough bars for ATR
    stop = long ? entry - a * stopAtrMult : entry + a * stopAtrMult;
  }
  const risk = Math.abs(entry - stop);

  let target = alert.target;
  if (target == null || (long ? target <= entry : target >= entry)) {
    target = long ? entry + risk * rr : entry - risk * rr;
  }

  return {
    side: alert.side,
    entry, stop, target,
    entrySignal: "tradingview",
    tvAlertId: alert.id,
    tv: { id: alert.id, strategy: alert.strategy, price: alert.price, receivedAt: alert.receivedAt },
  };
}
