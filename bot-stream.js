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
import { pickStop, nearTargetTrigger } from "./backtest.js";
import { classifyRegime } from "./regime.js";
import { chooseSignal }   from "./router.js";
import { getRegimeStats, getAllRegimeStats } from "./learner.js";
import { runAgentDebate, debateEnabled } from "./agents.js";

const ROUTER_ENABLED   = process.env.ROUTER_ENABLED === "true";
const STRICT_ROUTER    = process.env.STRICT_ROUTER === "true";
const ACTIVE_STRATS    = (process.env.ACTIVE_STRATEGIES || "hybrid,hybrid10,hybrid-reversal,reversal,vwap")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const MAX_CONCURRENT   = parseInt(process.env.MAX_CONCURRENT_POSITIONS || "5");
// CONSENSUS_MODE: require ≥ CONSENSUS_MIN strategies to agree on direction
// before the router lets a trade through. Off (=1) by default.
const CONSENSUS_MIN    = Math.max(1, parseInt(process.env.CONSENSUS_MIN || "1"));

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

    // Near-target early exit: if price comes within 5% of the planned target,
    // lock in the win rather than waiting for the exact tag.
    if (!exitReason) {
      const nt = nearTargetTrigger(pos.side, pos.entry, pos.target, bar);
      if (nt != null) { exitReason = "near-target"; exitPrice = nt; }
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

saveState({ symbol: SYMBOL, strategy: STRATEGY, botStarted: new Date().toISOString(), routerEnabled: ROUTER_ENABLED });

// ── Router mode: multi-symbol per-bar regime-based dispatch ─────────────────
//
// When ROUTER_ENABLED=true, the bot subscribes to every Alpaca watchlist
// symbol, classifies each symbol's regime on every bar, asks each active
// strategy's signal evaluator whether it wants to enter, and routes to the
// strategy with the best historical win rate in that regime.
//
// Position state is tracked per symbol in routerStates Map.

const routerStates = new Map(); // symbol → { bars, ema9, ema21, position, tradedToday, lastRegime, lastChoice }
const ROUTER_STATE_FILE = "bot-router-state.json";

function getSymState(sym) {
  if (!routerStates.has(sym)) {
    routerStates.set(sym, {
      bars: [],
      ema9: new RollingEMA(9),
      ema21: new RollingEMA(21),
      position: null,
      tradedToday: false,
      date: "",
      lastRegime: null,
      lastChoice: null,
    });
  }
  return routerStates.get(sym);
}

function saveRouterState() {
  const out = {};
  for (const [sym, s] of routerStates.entries()) {
    out[sym] = {
      position:     s.position,
      tradedToday:  s.tradedToday,
      date:         s.date,
      lastRegime:   s.lastRegime,
      lastChoice:   s.lastChoice,
      barCount:     s.bars.length,
    };
  }
  try {
    writeFileSync(ROUTER_STATE_FILE, JSON.stringify({
      symbols: out,
      strategiesFiredToday: [...(routerDay.strategiesFiredToday || [])],
      date: routerDay.date,
      updatedAt: new Date().toISOString(),
    }, null, 2));
  } catch (e) { console.warn("[Router] state save failed:", e.message); }
}

const routerDay = { date: "", strategiesFiredToday: new Set() };
function resetRouterDayIfNew(today) {
  if (routerDay.date !== today) {
    routerDay.date = today;
    routerDay.strategiesFiredToday = new Set();
    for (const [, s] of routerStates.entries()) {
      s.tradedToday = false;
      s.date = today;
    }
  }
}

// Lookup helper for router scoring. Strategy×regime stats from history;
// when regime is null, global per-strategy stats are returned.
function routerStatsLookup(strategy, regime) {
  if (regime) return getRegimeStats(strategy, regime);
  // Global (all regimes) lookup
  const all = getRegimeStats(strategy, null);
  return all; // getRegimeStats returns per-regime only — null case yields null;
}

// Each strategy's signal evaluator wrapped to accept a per-symbol bar buffer.
// evalORB and evalHybrid already accept barBuffer — wrap others.
function candidateSignals(strategy, sym, barBuffer) {
  try {
    if (strategy === "hybrid"   || strategy === "hybrid10")  return evalHybrid(barBuffer);
    if (strategy === "orb")                                  return evalORB(barBuffer);
    // For strategies that aren't natively in this bot file yet, return null —
    // they're still tracked in stats from backtests but live signals only fire
    // for the two evaluators above.
    return null;
  } catch (e) {
    console.warn(`[Router] ${strategy} eval error for ${sym}:`, e.message);
    return null;
  }
}

async function onRouterBar(bar) {
  const sym = bar.symbol;
  const s   = getSymState(sym);
  s.bars.push(bar);
  if (s.bars.length > 500) s.bars.shift();
  s.ema9.update(bar.close);
  s.ema21.update(bar.close);

  const now    = new Date();
  const etMins = etMinutesOf(now);
  const today  = todayET(now);

  if (etMins < MARKET_OPEN || etMins >= MARKET_CLOSE) return;
  resetRouterDayIfNew(today);

  // ── EOD close ─────────────────────────────────────────────────────────
  if (etMins >= EOD_CLOSE && s.position) {
    console.log(`[Router] ${sym} EOD — close @ $${bar.close.toFixed(2)}`);
    await closeRouterPosition(sym, bar.close, "eod");
    return;
  }

  // ── Manage open position (same exit logic as single-symbol path) ──────
  if (s.position) {
    const pos = s.position;
    let exitPrice = null, exitReason = null;
    if (pos.side === "buy") {
      if (bar.low  <= pos.stop)   { exitReason = "stop";   exitPrice = pos.stop;   }
      if (bar.high >= pos.target) { exitReason = "target"; exitPrice = pos.target; }
    } else {
      if (bar.high >= pos.stop)   { exitReason = "stop";   exitPrice = pos.stop;   }
      if (bar.low  <= pos.target) { exitReason = "target"; exitPrice = pos.target; }
    }
    if (!exitReason) {
      const nt = nearTargetTrigger(pos.side, pos.entry, pos.target, bar);
      if (nt != null) { exitReason = "near-target"; exitPrice = nt; }
    }
    if (exitReason) {
      console.log(`[Router] ${sym} exit: ${exitReason} @ $${exitPrice.toFixed(2)}`);
      await closeRouterPosition(sym, exitPrice, exitReason);
    }
    saveRouterState();
    return;
  }

  // ── Entry: classify regime, gather candidates, route ──────────────────
  if (s.tradedToday) return;
  if (etMins < ORB_READY) return;
  if (s.bars.length < 20) return;

  // Capacity check: don't exceed max concurrent positions
  const openCount = [...routerStates.values()].filter(x => x.position).length;
  if (openCount >= MAX_CONCURRENT) return;

  const r = classifyRegime(s.bars);
  s.lastRegime = r.tag;

  const candidates = ACTIVE_STRATS.map(strategy => ({
    strategy,
    signal: candidateSignals(strategy, sym, s.bars),
  }));

  const decision = chooseSignal({
    candidates,
    regime:       r.tag,
    statsLookup:  routerStatsLookup,
    todayState:   routerDay,
    strict:       STRICT_ROUTER,
    consensusMin: CONSENSUS_MIN,
  });
  s.lastChoice = decision.chosen ? { strategy: decision.chosen.strategy, score: decision.chosen.score, winRate: decision.chosen.winRate, reason: decision.reason } : { reason: decision.reason };

  if (!decision.chosen) { saveRouterState(); return; }

  console.log(`[Router] ${sym} ${r.tag} → ${decision.reason}`);

  // AGENT_DEBATE: Bull / Bear / Risk Manager weigh in before entry fires.
  let sizeMultiplier = 1.0;
  if (debateEnabled()) {
    const tradeCandidate = {
      symbol:    sym,
      strategy:  decision.chosen.strategy,
      side:      decision.chosen.signal.side,
      entry:     decision.chosen.signal.entry,
      stop:      decision.chosen.signal.stop,
      target:    decision.chosen.signal.target,
      regime:    r.tag,
      orderBlock: decision.chosen.signal.orderBlock || null,
      forced:    !!decision.chosen.signal.forced,
      entrySignal: decision.chosen.signal.entrySignal || decision.chosen.strategy,
    };
    const ctx = {
      regimeStats:   getAllRegimeStats(),
      openPositions: [...routerStates.values()].filter(x => x.position).length,
      sessionPnl:    0, // could compute from today's recorded trades; 0 is safe default
    };
    try {
      const debate = await runAgentDebate(tradeCandidate, ctx);
      console.log(`[Agents] ${sym}: ${debate.verdict} (bull ${debate.bull.confidence}, bear ${debate.bear.confidence}) → ${debate.risk.reasoning}`);
      s.lastChoice = { ...s.lastChoice, debate };
      if (debate.verdict !== "APPROVE") { saveRouterState(); return; }
      sizeMultiplier = debate.risk.sizeMultiplier || 1.0;
    } catch (e) {
      console.warn(`[Agents] ${sym} debate failed (proceeding with full size):`, e.message);
    }
  }

  await enterRouterTrade(sym, decision.chosen.strategy, decision.chosen.signal, bar, r.tag, sizeMultiplier);
  saveRouterState();
}

async function enterRouterTrade(sym, strategy, signal, bar, regime, sizeMultiplier = 1.0) {
  const s = getSymState(sym);
  const perPositionUSD = (TRADE_USD / Math.min(MAX_CONCURRENT, routerStates.size || 1)) * sizeMultiplier;
  if (IS_PAPER) {
    console.log(`[Router] PAPER ${signal.side.toUpperCase()} ${sym} via ${strategy} $${perPositionUSD.toFixed(2)} @ ~${bar.close.toFixed(2)} [regime: ${regime}]`);
  } else {
    try { await placeOrder(sym, signal.side, perPositionUSD); }
    catch (e) { console.error(`[Router] ${sym} order failed:`, e.message); return; }
  }
  s.position = {
    side:   signal.side,
    entry:  signal.entry,
    stop:   signal.stop,
    target: signal.target,
    strategy,
    regime,
    entryTime: new Date().toISOString(),
    entryBar:  bar,
  };
  s.tradedToday = true;
  routerDay.strategiesFiredToday.add(strategy);
}

async function closeRouterPosition(sym, exitPrice, exitReason) {
  const s = getSymState(sym);
  const pos = s.position;
  if (!pos) return;
  if (!IS_PAPER) {
    try { await closeAlpacaPosition(sym); } catch (e) { console.error(`[Router] ${sym} close failed:`, e.message); }
  }
  const hourET = etMinutesOf(new Date(pos.entryTime || Date.now())) / 60 | 0;
  recordTradeClosed({
    symbol: sym, strategy: pos.strategy, side: pos.side,
    entryPrice: pos.entry, exitPrice,
    entryTime: pos.entryTime, exitTime: new Date().toISOString(),
    exitReason,
    regime: pos.regime,
    hourET,
  });
  s.position = null;
}

// ── Wire up the stream ────────────────────────────────────────────────────────

let resolvedSymbols = [SYMBOL];
if (ROUTER_ENABLED) {
  console.log(`[Router] ENABLED — strategies: ${ACTIVE_STRATS.join(", ")} — fetching watchlist…`);
  try {
    const wlRes = await fetch(`${ALPACA_BASE}/v2/watchlists`, { headers: ALPACA_HEADERS });
    const wl    = wlRes.ok ? await wlRes.json() : [];
    if (wl?.length) {
      const detailRes = await fetch(`${ALPACA_BASE}/v2/watchlists/${wl[0].id}`, { headers: ALPACA_HEADERS });
      const detail    = detailRes.ok ? await detailRes.json() : { assets: [] };
      const syms      = (detail.assets || []).map(a => a.symbol).filter(Boolean);
      if (syms.length) resolvedSymbols = syms;
    }
  } catch (e) { console.warn("[Router] watchlist fetch failed:", e.message); }
  console.log(`[Router] subscribing to ${resolvedSymbols.length} symbols: ${resolvedSymbols.join(", ")}`);
} else {
  console.log(`[Bot] single-strategy mode (${STRATEGY} on ${SYMBOL}) — set ROUTER_ENABLED=true for multi-strategy routing`);
}

const stream = new AlpacaStream(resolvedSymbols);
stream.on("connected",    () => console.log("[Bot] Stream connected and authenticated"));
stream.on("disconnected", () => console.log("[Bot] Stream disconnected — auto-reconnecting"));
stream.on("error",        err => console.error("[Bot] Stream error:", err.message));
stream.on("bar",          ROUTER_ENABLED ? onRouterBar : onBar);
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
