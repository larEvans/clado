/**
 * Streaming Trading Bot — Alpaca 1-minute bars via WebSocket
 *
 * Features:
 *   - Real-time 1-minute bar stream (Alpaca IEX)
 *   - One trade per day enforcement
 *   - ORB strategy (Opening Range Breakout) with stop/target management
 *   - EOD position close at 3:45 PM ET
 *   - Adaptive parameter learning after every closed trade
 *   - Writes bot-state.json so the dashboard can display live status
 *
 * Usage:
 *   node bot-stream.js
 *   STRATEGY=orb SYMBOL=SPY node bot-stream.js
 *   PAPER_TRADING=false node bot-stream.js   ← live orders
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import { AlpacaStream } from "./stream.js";
import { getDefaultParams, loadLearnedParams, recordTradeClosed, runLearner } from "./learner.js";
import { pickStop } from "./backtest.js";

const SYMBOL      = (process.env.SYMBOL   || "SPY").toUpperCase();
const STRATEGY    = (process.env.STRATEGY || "hybrid").toLowerCase();
const TRADE_USD   = parseFloat(process.env.MAX_TRADE_SIZE_USD || "200");
const IS_PAPER    = process.env.PAPER_TRADING !== "false";
const ALPACA_BASE = process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets";
const LOG_FILE    = "safety-check-log.json";
const STATE_FILE  = "bot-state.json";

const ALPACA_HEADERS = {
  "APCA-API-KEY-ID":     process.env.ALPACA_API_KEY,
  "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY,
  "Content-Type":        "application/json",
};

// ── 1-min bar buffer ──────────────────────────────────────────────────────────

const bars = []; // rolling last 500 bars

// ── ET time helpers ───────────────────────────────────────────────────────────

function isEDT(date = new Date()) {
  const y = date.getUTCFullYear();
  // 2nd Sunday in March
  const mar = new Date(Date.UTC(y, 2, 8));
  mar.setUTCDate(8 + (7 - mar.getUTCDay()) % 7);
  // 1st Sunday in November
  const nov = new Date(Date.UTC(y, 10, 1));
  nov.setUTCDate(1 + (7 - nov.getUTCDay()) % 7);
  return date >= mar && date < nov;
}

function etMinutesOf(date = new Date()) {
  const offsetMin = isEDT(date) ? -240 : -300; // -4h or -5h
  const etMs = date.getTime() + offsetMin * 60_000;
  const et   = new Date(etMs);
  return et.getUTCHours() * 60 + et.getUTCMinutes();
}

function todayET(date = new Date()) {
  const offsetMin = isEDT(date) ? -240 : -300;
  const et = new Date(date.getTime() + offsetMin * 60_000);
  return `${et.getUTCFullYear()}-${String(et.getUTCMonth() + 1).padStart(2, "0")}-${String(et.getUTCDate()).padStart(2, "0")}`;
}

// Market timing constants (minutes since midnight ET)
const MARKET_OPEN  = 9 * 60 + 30;   //  9:30 AM
const ORB_READY    = 9 * 60 + 45;   //  9:45 AM — after 15-min ORB window
const EOD_CLOSE    = 15 * 60 + 45;  //  3:45 PM
const MARKET_CLOSE = 16 * 60;       //  4:00 PM

// ── State ─────────────────────────────────────────────────────────────────────

function loadState() {
  if (!existsSync(STATE_FILE)) {
    return { date: "", tradedToday: false, position: null, signal: null, lastBar: null };
  }
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { date: "", tradedToday: false, position: null, signal: null, lastBar: null };
  }
}

function saveState(patch) {
  const current = loadState();
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
  return next;
}

// ── Log entry to safety-check-log.json (shared with bot.js / dashboard) ───────

function appendLog(entry) {
  let log = { trades: [] };
  if (existsSync(LOG_FILE)) {
    try { log = JSON.parse(readFileSync(LOG_FILE, "utf8")); } catch {}
  }
  if (!Array.isArray(log.trades)) log.trades = [];
  log.trades.push(entry);
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

// ── Alpaca REST helpers ───────────────────────────────────────────────────────

async function placeOrder(symbol, side, notionalUSD) {
  const res = await fetch(`${ALPACA_BASE}/v2/orders`, {
    method: "POST",
    headers: ALPACA_HEADERS,
    body: JSON.stringify({
      symbol,
      notional:     notionalUSD.toFixed(2),
      side,
      type:         "market",
      time_in_force:"day",
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Alpaca order failed: ${data.message || JSON.stringify(data)}`);
  return data;
}

async function closeAlpacaPosition(symbol) {
  const res = await fetch(`${ALPACA_BASE}/v2/positions/${symbol}`, {
    method: "DELETE",
    headers: ALPACA_HEADERS,
  });
  if (!res.ok && res.status !== 422) {
    const data = await res.json();
    throw new Error(`Close position failed: ${data.message || JSON.stringify(data)}`);
  }
}

// ── EMA helper (rolling array, O(1) update) ───────────────────────────────────

class RollingEMA {
  #k; #value = null; #count = 0;
  constructor(period) { this.#k = 2 / (period + 1); this.period = period; }
  update(price) {
    this.#count++;
    if (this.#count < this.period) { this.#value = (this.#value || 0) + price; return null; }
    if (this.#count === this.period) { this.#value = (this.#value + price) / this.period; return this.#value; }
    this.#value = price * this.#k + this.#value * (1 - this.#k);
    return this.#value;
  }
  get value() { return this.#count >= this.period ? this.#value : null; }
}

const ema9Stream  = new RollingEMA(9);
const ema21Stream = new RollingEMA(21);

// ── ORB Signal Evaluator ──────────────────────────────────────────────────────

function evalORB(barBuffer) {
  const today = todayET();
  const params = loadLearnedParams(STRATEGY) || getDefaultParams(STRATEGY);

  // Bars that formed the ORB window (9:30–9:45 ET, today)
  const orbBars = barBuffer.filter(b => {
    const d = new Date(b.time);
    if (todayET(d) !== today) return false;
    const m = etMinutesOf(d);
    return m >= MARKET_OPEN && m < ORB_READY;
  });

  if (orbBars.length < 3) {
    console.log(`[ORB] Only ${orbBars.length} bars in ORB window — waiting for more`);
    return null;
  }

  const orbHigh  = Math.max(...orbBars.map(b => b.high));
  const orbLow   = Math.min(...orbBars.map(b => b.low));
  const orbRange = orbHigh - orbLow;
  if (orbRange <= 0) return null;

  const cur      = barBuffer[barBuffer.length - 1];
  const price    = cur.close;
  const rangePct = (orbRange / price) * 100;

  if (rangePct > (params.maxRangePct || 1.0)) {
    console.log(`[ORB] Range too wide: ${rangePct.toFixed(2)}% (max ${params.maxRangePct}%) — skip`);
    return null;
  }

  // 20-bar volume average for confirmation
  const sample   = barBuffer.slice(-21, -1);
  const volMA    = sample.length ? sample.reduce((s, b) => s + b.volume, 0) / sample.length : 0;
  const volThresh = volMA * (params.volMultiplier || 1.5);
  const volOK    = volMA > 0 && cur.volume >= volThresh;
  const rrRatio  = params.rrRatio || 2.0;

  if (price > orbHigh && volOK) {
    return {
      side:   "buy",
      entry:  price,
      stop:   orbLow,
      target: orbHigh + orbRange * rrRatio,
      params,
      orbHigh, orbLow, orbRange,
    };
  }

  if (price < orbLow && volOK) {
    return {
      side:   "sell",
      entry:  price,
      stop:   orbHigh,
      target: orbLow - orbRange * rrRatio,
      params,
      orbHigh, orbLow, orbRange,
    };
  }

  // Diagnostic logs
  if (price > orbHigh) console.log(`[ORB] Long breakout — low volume (${cur.volume.toFixed(0)} < ${volThresh.toFixed(0)})`);
  if (price < orbLow)  console.log(`[ORB] Short breakout — low volume (${cur.volume.toFixed(0)} < ${volThresh.toFixed(0)})`);

  return null;
}

// ── Hybrid Signal Evaluator — ORB + VWAP + EMA ───────────────────────────────

function evalHybrid(barBuffer) {
  const params  = loadLearnedParams(STRATEGY) || getDefaultParams(STRATEGY);
  const rrRatio = params.rrRatio       || 2.0;
  const volMult = params.volMultiplier || 1.3;
  const maxRng  = params.maxRangePct   || 1.0;
  const today   = todayET();

  // Build ORB from today's 9:30-9:45 bars
  const orbBars = barBuffer.filter(b => {
    const d = new Date(b.time);
    if (todayET(d) !== today) return false;
    const m = etMinutesOf(d);
    return m >= MARKET_OPEN && m < ORB_READY;
  });
  if (orbBars.length < 3) return null;

  const orbHigh  = Math.max(...orbBars.map(b => b.high));
  const orbLow   = Math.min(...orbBars.map(b => b.low));
  const orbRange = orbHigh - orbLow;
  if (orbRange <= 0) return null;

  const cur      = barBuffer[barBuffer.length - 1];
  const price    = cur.close;
  const rangePct = (orbRange / price) * 100;
  if (rangePct > maxRng) return null;

  // Session VWAP
  const todayBars = barBuffer.filter(b => {
    const d = new Date(b.time);
    if (todayET(d) !== today) return false;
    return etMinutesOf(d) >= MARKET_OPEN;
  });
  const cumTPV = todayBars.reduce((s, b) => s + ((b.high + b.low + b.close) / 3) * b.volume, 0);
  const cumVol = todayBars.reduce((s, b) => s + b.volume, 0);
  const vwap   = cumVol > 0 ? cumTPV / cumVol : null;
  if (!vwap) return null;

  // EMA
  const fast = ema9Stream.value;
  const slow = ema21Stream.value;
  if (!fast || !slow) return null;

  // Volume
  const sample  = barBuffer.slice(-21, -1);
  const volMA   = sample.length ? sample.reduce((s, b) => s + b.volume, 0) / sample.length : 0;
  const volOK   = volMA > 0 && cur.volume >= volMA * volMult;

  // Use the last ~30 bars for order-block detection (≈ last 30 minutes intraday)
  const recentBars = barBuffer.slice(-30);

  // Triple-confirmation LONG
  if (price > orbHigh && price > vwap && fast > slow && volOK) {
    const { stop, source, ob } = pickStop("buy", price, recentBars, orbHigh, orbLow);
    if (source === "order-block") console.log(`[Hybrid] LONG stop from order block @ ${stop.toFixed(2)} (OB low ${ob.low.toFixed(2)}, impulse ${ob.impulsePct.toFixed(2)}%)`);
    return { side: "buy",  entry: price, stop, target: orbHigh + orbRange * rrRatio, params, orbHigh, orbLow, orbRange, stopSource: source, orderBlock: ob };
  }
  // Triple-confirmation SHORT
  if (price < orbLow && price < vwap && fast < slow && volOK) {
    const { stop, source, ob } = pickStop("sell", price, recentBars, orbHigh, orbLow);
    if (source === "order-block") console.log(`[Hybrid] SHORT stop from order block @ ${stop.toFixed(2)} (OB high ${ob.high.toFixed(2)}, impulse ${ob.impulsePct.toFixed(2)}%)`);
    return { side: "sell", entry: price, stop, target: orbLow - orbRange * rrRatio,  params, orbHigh, orbLow, orbRange, stopSource: source, orderBlock: ob };
  }
  return null;
}

function evaluateSignal(barBuffer) {
  if (STRATEGY === "orb")    return evalORB(barBuffer);
  if (STRATEGY === "hybrid") return evalHybrid(barBuffer);
  return null;
}

// ── Position entry ────────────────────────────────────────────────────────────

async function enterTrade(signal, bar) {
  let orderId = `PAPER-${Date.now()}`;
  let orderOk = true;

  if (IS_PAPER) {
    console.log(`[Bot] PAPER ${signal.side.toUpperCase()} ${SYMBOL} $${TRADE_USD.toFixed(2)} @ ~${signal.entry.toFixed(2)}`);
  } else {
    try {
      const order = await placeOrder(SYMBOL, signal.side, TRADE_USD);
      orderId = order.id;
      console.log(`[Bot] LIVE ORDER placed: ${orderId}`);
    } catch (err) {
      console.error(`[Bot] Order FAILED: ${err.message}`);
      orderOk = false;
    }
  }

  if (!orderOk) return;

  const pos = {
    symbol:     SYMBOL,
    strategy:   STRATEGY,
    side:       signal.side,
    entryPrice: signal.entry,
    entryTime:  bar.time,
    stop:       signal.stop,
    target:     signal.target,
    sizeUSD:    TRADE_USD,
    orderId,
    orbHigh:    signal.orbHigh,
    orbLow:     signal.orbLow,
    orbRange:   signal.orbRange,
  };

  saveState({ position: pos, tradedToday: true, signal: { ...signal, timestamp: new Date().toISOString() } });

  appendLog({
    timestamp:    new Date().toISOString(),
    symbol:       SYMBOL,
    timeframe:    "1m",
    price:        signal.entry,
    strategy:     STRATEGY,
    side:         signal.side,
    stop:         signal.stop,
    target:       signal.target,
    allPass:      true,
    orderPlaced:  true,
    orderId,
    paperTrading: IS_PAPER,
    source:       "bot-stream",
  });

  console.log(
    `[Bot] Position OPEN: ${signal.side.toUpperCase()} ${SYMBOL} @ $${signal.entry.toFixed(2)} ` +
    `| stop $${signal.stop.toFixed(2)} | target $${signal.target.toFixed(2)}`
  );
}

// ── Position exit ─────────────────────────────────────────────────────────────

async function closePosition(pos, exitPrice, exitReason) {
  if (IS_PAPER) {
    const closeSide = pos.side === "buy" ? "SELL" : "BUY";
    console.log(`[Bot] PAPER EXIT: ${closeSide} ${SYMBOL} @ $${exitPrice.toFixed(2)} (${exitReason})`);
  } else {
    try {
      await closeAlpacaPosition(SYMBOL);
      console.log(`[Bot] Position closed on Alpaca (${exitReason})`);
    } catch (err) {
      console.error(`[Bot] Close order failed: ${err.message}`);
    }
  }

  const { pnlPct, win } = recordTradeClosed({
    symbol:     pos.symbol,
    strategy:   pos.strategy,
    side:       pos.side,
    entryPrice: pos.entryPrice,
    exitPrice,
    entryTime:  pos.entryTime,
    exitTime:   Date.now(),
    exitReason,
  });

  const pnlPerShare = pos.side === "buy" ? exitPrice - pos.entryPrice : pos.entryPrice - exitPrice;
  console.log(
    `[Bot] Trade CLOSED: ${win ? "WIN" : "LOSS"} | ${pnlPct.toFixed(2)}% | ` +
    `$${pnlPerShare.toFixed(2)}/share (${exitReason})`
  );

  // Run learning — adjust params for next trade
  const newParams = runLearner(STRATEGY);
  console.log(`[Learner] Updated ${STRATEGY} params:`, newParams);

  saveState({ position: null, signal: null });
}

// ── Main bar handler ──────────────────────────────────────────────────────────

async function onBar(bar) {
  if (bar.symbol !== SYMBOL) return;

  bars.push(bar);
  if (bars.length > 500) bars.shift();
  ema9Stream.update(bar.close);
  ema21Stream.update(bar.close);

  const now    = new Date();
  const etMins = etMinutesOf(now);
  const today  = todayET(now);

  // Outside regular market hours — ignore
  if (etMins < MARKET_OPEN || etMins >= MARKET_CLOSE) return;

  console.log(
    `[Bar] ${SYMBOL} O=${bar.open.toFixed(2)} H=${bar.high.toFixed(2)} ` +
    `L=${bar.low.toFixed(2)} C=${bar.close.toFixed(2)} V=${bar.volume.toLocaleString()} ` +
    `| ${now.toISOString().slice(11, 16)} ET`
  );

  saveState({ lastBar: { ...bar, receivedAt: now.toISOString() } });

  let state = loadState();

  // Reset daily state on a new calendar day (ET)
  if (state.date !== today) {
    console.log(`[Bot] New trading day: ${today}`);
    state = saveState({ date: today, tradedToday: false, signal: null });
  }

  // ── EOD: close any open position ──────────────────────────────────────────
  if (etMins >= EOD_CLOSE && state.position) {
    console.log(`[Bot] EOD — forcing close @ $${bar.close.toFixed(2)}`);
    await closePosition(state.position, bar.close, "eod");
    return;
  }

  // ── Manage open position ──────────────────────────────────────────────────
  if (state.position) {
    const pos = state.position;
    let exitPrice  = null;
    let exitReason = null;

    if (pos.side === "buy") {
      if (bar.low  <= pos.stop)   { exitReason = "stop";   exitPrice = pos.stop;   }
      if (bar.high >= pos.target) { exitReason = "target"; exitPrice = pos.target; }
    } else {
      if (bar.high >= pos.stop)   { exitReason = "stop";   exitPrice = pos.stop;   }
      if (bar.low  <= pos.target) { exitReason = "target"; exitPrice = pos.target; }
    }

    if (exitReason) {
      console.log(`[Bot] Exit: ${exitReason} @ $${exitPrice.toFixed(2)}`);
      await closePosition(pos, exitPrice, exitReason);
    }
    return;
  }

  // ── Look for entry signal ─────────────────────────────────────────────────
  if (state.tradedToday) return;   // one trade per day
  if (etMins < ORB_READY) return;  // wait for ORB to form
  if (bars.length < 20) return;    // need enough history

  const signal = evaluateSignal(bars);
  if (!signal) return;

  await enterTrade(signal, bar);
}

// ── Startup ───────────────────────────────────────────────────────────────────

console.log("=".repeat(60));
console.log("  Alpaca Streaming Bot");
console.log(`  Symbol   : ${SYMBOL}`);
console.log(`  Strategy : ${STRATEGY}`);
console.log(`  Trade $  : $${TRADE_USD}`);
console.log(`  Mode     : ${IS_PAPER ? "PAPER (safe)" : "LIVE"}`);
console.log("=".repeat(60));

if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) {
  console.error("ERROR: ALPACA_API_KEY and ALPACA_SECRET_KEY must be set in .env");
  process.exit(1);
}

// Show current learned params at startup
const startParams = loadLearnedParams(STRATEGY) || getDefaultParams(STRATEGY);
console.log(`[Bot] Active ${STRATEGY} params:`, startParams);

saveState({ symbol: SYMBOL, strategy: STRATEGY, botStarted: new Date().toISOString() });

const stream = new AlpacaStream([SYMBOL]);
stream.on("connected",    () => console.log("[Bot] Stream connected and authenticated"));
stream.on("disconnected", () => console.log("[Bot] Stream disconnected — auto-reconnecting"));
stream.on("error",        err => console.error("[Bot] Stream error:", err.message));
stream.on("bar",          onBar);
stream.connect();

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n[Bot] Shutting down…");
  const state = loadState();
  if (state.position) {
    console.warn("[Bot] WARNING: Open position not closed — check your Alpaca account!");
  }
  saveState({ botStopped: new Date().toISOString() });
  stream.close();
  process.exit(0);
});
