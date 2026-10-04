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
import { getDefaultParams, loadLearnedParams, recordTradeClosed, runLearner, getEarlyExitConfig } from "./learner.js";
import { pickStop, nearTargetTrigger } from "./backtest.js";
import { getRegimeStats, getAllRegimeStats } from "./learner.js";
import { planOptionsTrade, shouldExitOption } from "./agents-options.js";
import { placeOptionsOrder, fetchSnapshots }  from "./options.js";
import { runAgentDebate, debateEnabled } from "./agents.js";
import { predict as predictPrice, hasModel } from "./ml/predictor.js";
import { dataPath } from "./state.js";
import { loadSymbols } from "./symbols.js";
import { SymbolSeries, decideEntry, updatePosition, etInfo, STRATEGY_TF, SUPPORTED_STRATEGIES } from "./signals.js";
import { fetchCandles } from "./backtest.js";
import { TV_ENABLED, TV_MAX_AGE_SEC, readTvAlerts, findFreshAlert, buildTvTradeSignal } from "./tradingview.js";

import { loadRuntimeConfig, parseEnvBool } from "./runtime-config.js";

let runtimeCfg = loadRuntimeConfig();

// Reload the config file every 30 s so dashboard toggles take effect without
// restarting the bot process. Symbol changes still need a restart (would
// require resubscribing the WebSocket); routerEnabled toggles live.
setInterval(() => {
  try {
    const next = loadRuntimeConfig();
    const flipped = next.routerEnabled !== runtimeCfg.routerEnabled;
    runtimeCfg = next;
    if (flipped) console.log(`[Bot] runtime config: routerEnabled → ${runtimeCfg.routerEnabled}`);
  } catch {}
}, 30_000);

// Convenience getters used through the bar handler so each tick reads the
// latest config without us threading it everywhere.
const ROUTER_ENABLED   = () => runtimeCfg.routerEnabled;
// "tradingview" joins automatically whenever TV_WEBHOOK_SECRET is set, so a
// dashboard-saved activeStrategies list can't silently drop alert trading.
const ACTIVE_STRATS    = () => {
  const list = runtimeCfg.activeStrategies || [];
  return TV_ENABLED() && !list.includes("tradingview") ? [...list, "tradingview"] : list;
};
const MAX_CONCURRENT   = () => runtimeCfg.maxConcurrentPositions;
const OPTIONS_MODE     = () => runtimeCfg.optionsMode;
const OPTIONS_DTE      = () => runtimeCfg.optionsDte || 7;
const PREDICTOR_ENABLED       = () => runtimeCfg.predictorEnabled;
const PREDICTOR_MIN_CONF      = () => runtimeCfg.predictorMinConfidence;
const PREDICTOR_VETO          = () => runtimeCfg.predictorVeto;
const PREDICTOR_SIZE_SCALING  = () => runtimeCfg.predictorSizeScaling;
const PREDICTOR_SIGNAL_ENABLED = () => runtimeCfg.predictorSignalEnabled;
const MIN_TRADES_PER_DAY      = () => runtimeCfg.minTradesPerDay;
const STRIKE_MODE             = () => runtimeCfg.strikeMode;
const OPTIONS_DTE_BUFFER      = () => runtimeCfg.optionsDteBuffer;

const STRICT_ROUTER    = process.env.STRICT_ROUTER === "true";
const CRYPTO_SYMBOLS   = runtimeCfg.cryptoSymbols;

// Crypto helpers
const isCryptoSymbol = sym => typeof sym === "string" && sym.includes("/");
// CONSENSUS_MODE: require ≥ CONSENSUS_MIN strategies to agree on direction
// before the router lets a trade through. Off (=1) by default.
const CONSENSUS_MIN    = Math.max(1, parseInt(process.env.CONSENSUS_MIN || "1"));

// ── Daily loss kill switch ────────────────────────────────────────────────────
// Once the day's realized P&L (sum of closed-trade pnlPct across all symbols
// and strategies) drops to -MAX_DAILY_LOSS_PCT or below, no new positions are
// opened until the next trading day. Exits and EOD closes still process.
// 0 disables the switch. Tally is in-memory: a process restart resets it.
const MAX_DAILY_LOSS_PCT = Math.max(0, parseFloat(process.env.MAX_DAILY_LOSS_PCT || "0"));
const dayPnl = { date: "", totalPct: 0, halted: false };

function recordDayPnl(pnlPct) {
  const today = todayET(new Date());
  if (dayPnl.date !== today) { dayPnl.date = today; dayPnl.totalPct = 0; dayPnl.halted = false; }
  dayPnl.totalPct += pnlPct;
  if (MAX_DAILY_LOSS_PCT > 0 && !dayPnl.halted && dayPnl.totalPct <= -MAX_DAILY_LOSS_PCT) {
    dayPnl.halted = true;
    console.log(
      `[Bot] DAILY LOSS LIMIT HIT: ${dayPnl.totalPct.toFixed(2)}% ≤ -${MAX_DAILY_LOSS_PCT}% ` +
      `— halting new entries until the next trading day`
    );
  }
}

function dailyLossHalted() {
  if (MAX_DAILY_LOSS_PCT <= 0) return false;
  return dayPnl.halted && dayPnl.date === todayET(new Date());
}

// Traded symbols come from symbols.js (symbols.json, seeded from SYMBOLS env).
// SYMBOL is resolved at startup (single-strategy mode uses the first entry).
let SYMBOL        = null;
const STRATEGY    = (process.env.STRATEGY || "hybrid").toLowerCase();
const TRADE_USD   = parseFloat(process.env.MAX_TRADE_SIZE_USD || "200");
function normalizeAlpacaBase(raw) {
  if (!raw) return "https://paper-api.alpaca.markets";
  return String(raw)
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v\d[^/]*$/, "");
}

function describeAlpacaAccount(baseUrl) {
  return /paper-api\.alpaca\.markets$/i.test(baseUrl) ? "PAPER ACCOUNT" : "LIVE ACCOUNT";
}

const IS_PAPER    = parseEnvBool(process.env.PAPER_TRADING, true);
const ALPACA_BASE = normalizeAlpacaBase(process.env.ALPACA_BASE_URL);
// Trade-history provenance: "paper" = simulated in the bot (no orders),
// "paper-account" = real orders filled in Alpaca's paper account, "live".
const TRADE_SOURCE = IS_PAPER ? "paper" : describeAlpacaAccount(ALPACA_BASE) === "PAPER ACCOUNT" ? "paper-account" : "live";
const LOG_FILE    = dataPath("safety-check-log.json");
const STATE_FILE  = dataPath("bot-state.json");

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

async function placeOrder(symbol, side, notionalUSD, price = null) {
  // Crypto requires time_in_force=gtc and minimum $10 notional; stocks use day TIF.
  const isCrypto = isCryptoSymbol(symbol);
  const tif      = isCrypto ? "gtc" : "day";
  const notional = isCrypto ? Math.max(notionalUSD, 10) : notionalUSD;

  // Alpaca can't short fractional shares, so a stock SHORT is whole shares —
  // at least 1, which can exceed the per-position budget on high-priced ETFs.
  let size = { notional: notional.toFixed(2) };
  if (side === "sell" && !isCrypto) {
    if (!(price > 0)) throw new Error("short entry needs a price to size whole shares");
    const qty = Math.max(1, Math.floor(notionalUSD / price));
    if (qty * price > notionalUSD * 1.5) console.warn(`[Bot] ${symbol} short: 1 share ≈ $${price.toFixed(2)} exceeds the $${notionalUSD.toFixed(2)} budget`);
    size = { qty: String(qty) };
  }

  const res = await fetch(`${ALPACA_BASE}/v2/orders`, {
    method: "POST",
    headers: ALPACA_HEADERS,
    body: JSON.stringify({
      symbol,
      ...size,
      side,
      type:         "market",
      time_in_force: tif,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Alpaca order failed: ${data.message || JSON.stringify(data)}`);
  return data;
}

async function closeAlpacaPosition(symbol) {
  const res = await fetch(`${ALPACA_BASE}/v2/positions/${encodeURIComponent(symbol)}`, {
    method: "DELETE",
    headers: ALPACA_HEADERS,
  });
  if (!res.ok && res.status !== 422) {
    const data = await res.json();
    throw new Error(`Close position failed: ${data.message || JSON.stringify(data)}`);
  }
  return res.ok ? res.json().catch(() => null) : null;   // the closing order
}

/** Average fill price of an order, polling briefly (market orders fill in
 *  well under a second during RTH). null if not filled within `waitMs`. */
async function orderFillPrice(orderId, waitMs = 10_000) {
  if (!orderId) return null;
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    try {
      const res = await fetch(`${ALPACA_BASE}/v2/orders/${orderId}`, { headers: ALPACA_HEADERS });
      const o = res.ok ? await res.json() : null;
      const px = parseFloat(o?.filled_avg_price);
      if (o?.status === "filled" && px > 0) return px;
      if (["canceled", "expired", "rejected"].includes(o?.status)) return null;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
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

function learnedNearTargetPct(strategy, regime = null) {
  return getEarlyExitConfig(strategy, regime).nearTargetPct;
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
    source:     IS_PAPER ? "paper" : "live",
    entryPrice: pos.entryPrice,
    exitPrice,
    entryTime:  pos.entryTime,
    exitTime:   Date.now(),
    exitReason,
  });
  recordDayPnl(pnlPct);

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

    // Learned near-target early exit: each strategy can tune how soon to
    // lock in the win rather than waiting for the exact target tag.
    if (!exitReason) {
      const nt = nearTargetTrigger(pos.side, pos.entry, pos.target, bar, learnedNearTargetPct(pos.strategy || STRATEGY));
      if (nt != null) { exitReason = "near-target"; exitPrice = nt; }
    }

    if (exitReason) {
      console.log(`[Bot] Exit: ${exitReason} @ $${exitPrice.toFixed(2)}`);
      await closePosition(pos, exitPrice, exitReason);
    }
    return;
  }

  // ── Look for entry signal ─────────────────────────────────────────────────
  if (dailyLossHalted()) return;   // daily loss limit hit — no new entries
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
console.log(`  Symbols  : (from symbols.json / SYMBOLS env at startup)`);
console.log(`  Strategy : ${STRATEGY}`);
console.log(`  Trade $  : $${TRADE_USD}`);
console.log(`  Mode     : ${IS_PAPER ? "PAPER (no orders sent)" : "ORDERS ENABLED"}`);
console.log(`  Alpaca   : ${describeAlpacaAccount(ALPACA_BASE)} (${ALPACA_BASE})`);
console.log("=".repeat(60));

if (!process.env.ALPACA_API_KEY || !process.env.ALPACA_SECRET_KEY) {
  console.error("ERROR: ALPACA_API_KEY and ALPACA_SECRET_KEY must be set in .env");
  process.exit(1);
}

if (!IS_PAPER && !/^https:\/\/(paper-api|api)\.alpaca\.markets$/i.test(ALPACA_BASE)) {
  console.error(`ERROR: Refusing to send Alpaca orders to unsupported ALPACA_BASE_URL: ${ALPACA_BASE}`);
  console.error("Use https://paper-api.alpaca.markets for Alpaca paper orders or https://api.alpaca.markets for live Alpaca orders.");
  process.exit(1);
}

if (!IS_PAPER && describeAlpacaAccount(ALPACA_BASE) === "PAPER ACCOUNT") {
  console.warn("[Bot] PAPER_TRADING=false, but ALPACA_BASE_URL points at Alpaca paper. Orders will execute in the Alpaca paper account, not the live brokerage account.");
}

// Real-money guard: pointing ALPACA_BASE_URL at the live API is not enough on
// its own to send live orders — that also takes LIVE_TRADING_CONFIRM=yes.
if (!IS_PAPER && describeAlpacaAccount(ALPACA_BASE) === "LIVE ACCOUNT" && process.env.LIVE_TRADING_CONFIRM !== "yes") {
  console.error("ERROR: orders are enabled against the LIVE Alpaca account but LIVE_TRADING_CONFIRM is not \"yes\". Refusing to start.");
  console.error("Set LIVE_TRADING_CONFIRM=yes to trade real money, or use ALPACA_BASE_URL=https://paper-api.alpaca.markets.");
  process.exit(1);
}

// Show current learned params at startup
const startParams = loadLearnedParams(STRATEGY) || getDefaultParams(STRATEGY);
console.log(`[Bot] Active ${STRATEGY} params:`, startParams);

saveState({ symbol: null, strategy: STRATEGY, botStarted: new Date().toISOString(), routerEnabled: ROUTER_ENABLED() });

// ── Router mode: multi-symbol per-bar regime-based dispatch ─────────────────
//
// When ROUTER_ENABLED=true, the bot subscribes to every configured
// symbol, classifies each symbol's regime on every bar, asks each active
// strategy's signal evaluator whether it wants to enter, and routes to the
// strategy with the best historical win rate in that regime.
//
// Position state is tracked per symbol in routerStates Map.

const routerStates = new Map(); // symbol → { bars, ema9, ema21, position, tradedToday, lastRegime, lastChoice }
const ROUTER_STATE_FILE = dataPath("bot-router-state.json");

function getSymState(sym) {
  if (!routerStates.has(sym)) {
    routerStates.set(sym, {
      bars: [],
      series: new SymbolSeries(1),   // 5/15/60-minute bars built from the 1-minute stream
      ema9: new RollingEMA(9),
      ema21: new RollingEMA(21),
      position: null,
      tradedToday: false,
      strategiesTradedToday: new Set(),
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
      strategiesTradedToday: [...(s.strategiesTradedToday || [])],
      barCount:     s.bars.length,
    };
  }
  try {
    writeFileSync(ROUTER_STATE_FILE, JSON.stringify({
      symbols: out,
      strategiesFiredToday: [...(routerDay.strategiesFiredToday || [])],
      tradesToday: routerDay.tradesToday || 0,
      date: routerDay.date,
      updatedAt: new Date().toISOString(),
    }, null, 2));
  } catch (e) { console.warn("[Router] state save failed:", e.message); }
}

const routerDay = { date: "", strategiesFiredToday: new Set(), tradesToday: 0 };
function resetRouterDayIfNew(today) {
  if (routerDay.date !== today) {
    routerDay.date = today;
    routerDay.strategiesFiredToday = new Set();
    routerDay.tradesToday = 0;
    for (const [, s] of routerStates.entries()) {
      s.tradedToday = false;
      s.strategiesTradedToday = new Set();
      s.date = today;
    }
  }
}

// ── Prediction snapshots → predictions.json (dashboard: targets/potential) ────
// The bot and dashboard are separate processes, so persist what the model saw
// on each evaluation. Throttled writes; one entry per symbol (latest wins).
const PREDICTIONS_FILE = dataPath("predictions.json");
const predictionSnapshots = new Map();
let _lastPredictionsWrite = 0;

function recordPredictionSnapshot(sym, ev, params) {
  if (!ev) return;
  predictionSnapshots.set(sym, {
    symbol:      sym,
    updatedAt:   new Date().toISOString(),
    wouldFire:   ev.wouldFire,
    skipReason:  ev.skipReason,
    edge:        +(ev.edge || 0).toFixed(3),
    tier:        params?._tier || 1,
    thresholds:  { minEdge: params?.minEdge, minConfidence: params?.minConfidence },
    prediction:  ev.prediction ? {
      side:              ev.prediction.side,
      price:             +(+ev.prediction.price).toFixed(4),
      priceTarget:       +(+ev.prediction.priceTarget).toFixed(4),
      expectedReturnPct: +(+ev.prediction.expectedReturnPct).toFixed(3),
      horizonDays:       ev.prediction.horizonDays,
      confidence:        +(+ev.prediction.confidence).toFixed(3),
      source:            ev.prediction.source,
    } : null,
  });
  const now = Date.now();
  if (now - _lastPredictionsWrite < 30_000) return;  // throttle disk writes
  _lastPredictionsWrite = now;
  try {
    writeFileSync(PREDICTIONS_FILE, JSON.stringify({
      generatedAt:  new Date().toISOString(),
      date:         routerDay.date,
      tradesToday:  routerDay.tradesToday || 0,
      minTradesPerDay: MIN_TRADES_PER_DAY(),
      perSymbol:    [...predictionSnapshots.values()],
    }, null, 2));
  } catch (e) { console.warn("[Predictor] predictions.json write failed:", e.message); }
}

// Lookup helper for router scoring. Strategy×regime stats from history;
// when regime is null, global per-strategy stats are returned.
function routerStatsLookup(strategy, regime) {
  if (regime) return getRegimeStats(strategy, regime);
  // Global (all regimes) lookup
  const all = getRegimeStats(strategy, null);
  return all; // getRegimeStats returns per-regime only — null case yields null;
}

// ── TradingView alerts (written by the dashboard's /webhook/tradingview) ──────
// An alert is used at most once (consumed on entry/exit); unused alerts expire
// after TV_SIGNAL_MAX_AGE_SEC. Consumption is in-memory — after a restart,
// the age limit alone keeps old alerts from re-firing.
const tvConsumed = new Set();
const TV_STOP_ATR_MULT = parseFloat(process.env.TV_STOP_ATR_MULT || "1.5");
const TV_RR            = parseFloat(process.env.TV_RR || "2");

function freshTvAlert(sym, sides, afterIso = null) {
  if (!TV_ENABLED()) return null;
  return findFreshAlert(readTvAlerts(), sym, sides, { consumed: tvConsumed, maxAgeSec: TV_MAX_AGE_SEC(), afterIso });
}

// TradingView alerts may fire many times a day — the TV strategy decides its
// own entries — so "tradingview" is exempt from the once-per-symbol-per-day
// rule. One open position per symbol, capacity and the daily loss limit
// still apply.
function strategyUsedUp(s, strategy) {
  return strategy !== "tradingview" && !!s.strategiesTradedToday?.has(strategy);
}

// TradingView alerts aren't bar-driven, so they bypass signals.js: a fresh
// alert is a candidate on whatever bar it arrives. Returns undefined for every
// other strategy so decideEntry evaluates those on their native bars.
function tvCandidate(strategy, sym, barBuffer) {
  if (strategy !== "tradingview") return undefined;
  try {
    const alert = freshTvAlert(sym, ["buy", "sell"]);
    return alert ? buildTvTradeSignal(alert, barBuffer, { stopAtrMult: TV_STOP_ATR_MULT, rr: TV_RR }) : null;
  } catch (e) {
    console.warn(`[Router] tradingview eval error for ${sym}:`, e.message);
    return null;
  }
}

// Active strategies with no live evaluator are called out at startup instead
// of silently never firing.
const UNSUPPORTED_ACTIVE = () => ACTIVE_STRATS().filter(x => x !== "tradingview" && !SUPPORTED_STRATEGIES.includes(x));

async function onRouterBar(bar) {
  const sym = bar.symbol;
  const s   = getSymState(sym);
  s.bars.push(bar);
  if (s.bars.length > 500) s.bars.shift();
  s.ema9.update(bar.close);
  s.ema21.update(bar.close);
  const completed = s.series.push(bar);

  // Clock = end of this 1-minute bar (when it arrives), so live and replay.js
  // make identical time-of-day decisions.
  const { mins: etMins, day: today } = etInfo(bar.time + 60_000);
  const crypto = isCryptoSymbol(sym);

  // Crypto trades 24/7 — bypass NYSE market-hours gating. For stocks, only
  // act inside RTH; for crypto, every bar at any hour is fair game.
  if (!crypto && (etMins < MARKET_OPEN || etMins > MARKET_CLOSE)) return;   // the bar ending at 4:00 can still exit
  resetRouterDayIfNew(today);

  // ── EOD close (stocks only — crypto positions can roll overnight) ───
  if (!crypto && s.position && !s.position.overnight && etMins >= (s.position.eodMins ?? EOD_CLOSE)) {
    console.log(`[Router] ${sym} EOD — close @ $${bar.close.toFixed(2)}`);
    await closeRouterPosition(sym, bar.close, "eod");
    return;
  }

  // ── Manage open position (same exit logic as single-symbol path) ──────
  if (s.position) {
    const pos = s.position;
    // Underlying stop / trailing stop / target / near-target / bias flip,
    // shared with replay.js (works for both stock and option positions).
    const ex = updatePosition(pos, bar, { series: s.series, completedTfs: completed, nearTargetPct: learnedNearTargetPct(pos.strategy, pos.regime) });
    let exitPrice = ex?.exitPrice ?? null, exitReason = ex?.exitReason ?? null;

    // TradingView exit: for positions the TV strategy opened, an "exit" alert —
    // or an opposite-side alert (a reversal) — closes it at the bar close. Only
    // alerts received after entry count. Reversal alerts aren't consumed here,
    // so the next bar can open the new side through the normal entry path.
    if (!exitReason && pos.strategy === "tradingview") {
      const opposite = pos.side === "buy" ? "sell" : "buy";
      const x = freshTvAlert(sym, ["exit", opposite], pos.entryTime);
      if (x) {
        exitReason = x.side === "exit" ? "tv-exit" : "tv-reversal";
        exitPrice  = bar.close;
        if (x.side === "exit") tvConsumed.add(x.id);
      }
    }

    // Options-specific exit triggers: profit-target %, max-loss %, time, IV crush.
    // Checked roughly once per minute (every ~5 bars at 1-min cadence) to avoid
    // hammering the snapshot endpoint.
    if (!exitReason && pos.isOption && pos.contractSymbol) {
      const lastCheck = pos._lastOptionCheck || 0;
      const ageMs = Date.now() - lastCheck;
      if (ageMs >= 60_000) {
        pos._lastOptionCheck = Date.now();
        try {
          const snaps = await fetchSnapshots(sym, {
            type:      pos.contract.type,
            expDate:   pos.contract.expiry,
            strikeGte: pos.contract.strike - 0.5,
            strikeLte: pos.contract.strike + 0.5,
          });
          const snap = snaps[pos.contractSymbol];
          const cur  = snap?.latestQuote ? { bid: snap.latestQuote.bp, ask: snap.latestQuote.ap, mid: (snap.latestQuote.bp + snap.latestQuote.ap) / 2, iv: snap.impliedVolatility } : null;
          const verdict = shouldExitOption(pos, bar.close, cur);
          if (verdict.exit) {
            exitReason = verdict.reason;
            // For options exits we still pass the stock price (the trade record
            // tracks underlying price); the options PnL is computed from the
            // contract's bid/ask if we had it. Detailed options PnL needs the
            // close-order fill price which Alpaca returns asynchronously.
            exitPrice = bar.close;
            console.log(`[OptionsAgent] ${sym} ${pos.contractSymbol} exit: ${verdict.reason}${verdict.pnlPct != null ? ` (option PnL ${verdict.pnlPct.toFixed(1)}%)` : ""}`);
          }
        } catch (e) { /* snapshot fetch is best-effort */ }
      }
    }

    if (exitReason) {
      console.log(`[Router] ${sym} exit: ${exitReason} @ $${exitPrice.toFixed(2)}`);
      await closeRouterPosition(sym, exitPrice, exitReason);
    }
    saveRouterState();
    return;
  }

  // ── Entry: gates, regime, candidates, route, predictor gate (signals.js) ──
  // Each strategy is evaluated only when one of its native bars (5/15/60 min)
  // closes, exactly as in its backtest. Shared with replay.js.
  const dec = decideEntry({
    state:     s,
    completed,
    etMins,
    crypto,
    symbol:    sym,
    cfg:       { ...runtimeCfg, strict: STRICT_ROUTER, consensusMin: CONSENSUS_MIN },
    day:       routerDay,
    openCount: [...routerStates.values()].filter(x => x.position).length,
    halted:    dailyLossHalted(),
    statsLookup:    routerStatsLookup,
    paramsFor:      strategy => loadLearnedParams(strategy) || {},
    predict:        predictPrice,
    extraCandidate: strategy => tvCandidate(strategy, sym, s.bars),
    onPrediction:   (ev, params) => recordPredictionSnapshot(sym, ev, params),
  });
  if (dec.regime) s.lastRegime = dec.regime;
  if (!dec.decision) return;                       // a gate stopped it before routing
  const decision = dec.decision;
  s.lastChoice = decision.chosen ? { strategy: decision.chosen.strategy, score: decision.chosen.score, winRate: decision.chosen.winRate, reason: decision.reason } : { reason: decision.reason };
  if (dec.prediction && decision.chosen) {
    const p = dec.prediction;
    s.lastChoice.prediction = {
      side: p.side, expectedReturnPct: +(+p.expectedReturnPct).toFixed(2), priceTarget: +(+p.priceTarget).toFixed(2),
      confidence: +(+p.confidence).toFixed(2), horizonDays: p.horizonDays, source: p.source,
      agrees: p.side === decision.chosen.signal.side,
    };
  }
  if (!decision.chosen) { saveRouterState(); return; }
  console.log(`[Router] ${sym} ${dec.regime} → ${decision.reason}`);
  if (dec.vetoed) {
    console.log(`[Predictor] ${sym} VETO — ${dec.reason} vs ${decision.chosen.signal.side} signal`);
    saveRouterState();
    return;
  }
  const r = { tag: dec.regime };
  const prediction = dec.prediction || null;
  if (prediction && decision.chosen.strategy !== "predictor") {
    const agrees = prediction.side === decision.chosen.signal.side;
    console.log(`[Predictor] ${sym} ${prediction.source} → ${prediction.side} ${prediction.expectedReturnPct >= 0 ? "+" : ""}${prediction.expectedReturnPct.toFixed(2)}% · target $${prediction.priceTarget.toFixed(2)} · ${(prediction.confidence * 100).toFixed(0)}% conf${agrees ? " ✓" : " (disagrees, not vetoed)"}`);
  }

  // AGENT_DEBATE: Bull / Bear / Risk Manager weigh in before entry fires.
  // decideEntry already applied the predictor's confidence sizing.
  let sizeMultiplier = dec.sizeMultiplier ?? 1.0;
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
      sizeMultiplier *= debate.risk.sizeMultiplier || 1.0;
    } catch (e) {
      console.warn(`[Agents] ${sym} debate failed (proceeding with full size):`, e.message);
    }
  }

  await enterRouterTrade(sym, decision.chosen.strategy, decision.chosen.signal, bar, r.tag, sizeMultiplier, prediction);
  saveRouterState();
}

// How signals.js manages the position: native bar size (trailing stops and
// bias-flip exits update on its closes), trailing-stop settings, initial stop.
function exitPlan(strategy, signal) {
  return {
    tf:          signal.tf || STRATEGY_TF[strategy] || null,
    initialStop: signal.stop,
    ...(signal.trail    ? { trail: signal.trail } : {}),
    ...(signal.biasFlip ? { biasFlip: true }      : {}),
    ...(signal.timeExitAt ? { timeExitAt: signal.timeExitAt } : {}),
    ...(signal.bandStop ? { bandStop: signal.bandStop } : {}),
    ...(signal.eodMins ? { eodMins: signal.eodMins } : {}),
    ...(signal.overnight ? { overnight: true, entryDay: signal.entryDay, dipExit: signal.dipExit } : {}),
  };
}

async function enterRouterTrade(sym, strategy, signal, bar, regime, sizeMultiplier = 1.0, prediction = null) {
  const s = getSymState(sym);
  const perPositionUSD = (TRADE_USD / Math.min(MAX_CONCURRENT(), routerStates.size || 1)) * sizeMultiplier;
  const crypto = isCryptoSymbol(sym);

  // Options Strategist routes ALL stock-direction trades through the agent
  // when OPTIONS_MODE is on. Crypto is excluded (Alpaca has no crypto options),
  // and so are strategies in stockOnlyStrategies, which always trade shares.
  let optionsPlan = null;
  if (OPTIONS_MODE() && !crypto && !(runtimeCfg.stockOnlyStrategies || []).includes(strategy)) {
    try {
      // When the predictor agrees with the trade (or generated it), hand its
      // price target and horizon to the options planner so it picks a
      // target-aligned strike and a matching expiry — not blind ATM/fixed-DTE.
      const usePrediction = (PREDICTOR_ENABLED() || PREDICTOR_SIGNAL_ENABLED())
        && prediction && prediction.side === signal.side;
      // STRIKE_MODE shapes where the strike lands by adjusting the target the
      // planner aims at: atm = spot (highest delta), target = the model's full
      // forecast, between = midpoint (default — balances delta vs. cost).
      let strikeTarget = signal.target;
      if (usePrediction) {
        const t = prediction.priceTarget;
        strikeTarget = STRIKE_MODE() === "atm"    ? bar.close
                     : STRIKE_MODE() === "target" ? t
                     : (bar.close + t) / 2;                       // "between"
      }
      const optionSignal = { ...signal, symbol: sym, strategy, regime, target: strikeTarget };
      // Expiry: forecast horizon + buffer so theta doesn't strangle the trade
      // if the move takes the full horizon.
      // OPTIONS_DTE 0 = 0DTE: always same-day contracts, even when the
      // predictor supplies a multi-day horizon.
      const optionDte = OPTIONS_DTE() === 0 ? 0
        : usePrediction ? Math.max(1, (prediction.horizonDays || OPTIONS_DTE()) + OPTIONS_DTE_BUFFER())
        : OPTIONS_DTE();
      optionsPlan = await planOptionsTrade(
        optionSignal,
        bar.close,
        { dte: optionDte, underlying: sym },
      );
      if (optionsPlan?.contract && runtimeCfg.targetMode === "liquidity" && optionsPlan.exitTriggers) {
        // ICT liquidity targets: let the underlying reach its target; keep
        // only the premium max-loss stop (plus the underlying stop / EOD).
        optionsPlan.exitTriggers = { ...optionsPlan.exitTriggers, profitTargetPct: null, timeExitMinutes: null };
      }
      if (optionsPlan?.contract) {
        console.log(`[OptionsAgent] ${sym} → ${optionsPlan.contract.symbol} (${optionsPlan.contract.type} ${optionsPlan.contract.strike}@${optionsPlan.contract.expiry}, premium $${(optionsPlan.contract.mid||0).toFixed(2)}, delta ${optionsPlan.contract.delta?.toFixed(2)}) · ${optionsPlan.reasoning}`);
      } else {
        console.warn(`[OptionsAgent] ${sym} — no contract qualified, skipping trade`);
        return;  // refuse the trade if the agent can't find a clean contract
      }
    } catch (e) {
      console.warn(`[OptionsAgent] ${sym} planning failed: ${e.message} — falling back to stock entry`);
      optionsPlan = null;
    }
  }

  // Execute the trade
  let optionsOrder = null, stockOrder = null;
  if (optionsPlan?.contract) {
    // Options leg
    const contractMid = optionsPlan.contract.mid || optionsPlan.contract.ask || 1;
    const numContracts = Math.max(1, Math.floor(perPositionUSD / (contractMid * 100)));
    if (IS_PAPER) {
      console.log(`[Router] PAPER BUY ${numContracts}× ${optionsPlan.contract.symbol} (~$${(numContracts * contractMid * 100).toFixed(2)}) for stock ${signal.side.toUpperCase()} ${sym} [regime: ${regime}]`);
    } else {
      try { optionsOrder = await placeOptionsOrder(optionsPlan.contract.symbol, "buy", numContracts); }
      catch (e) { console.error(`[Router] ${sym} options order failed:`, e.message); return; }
    }
    s.position = {
      side:           signal.side,
      entry:          signal.entry,
      stop:           signal.stop,
      target:         signal.target,
      ...exitPlan(strategy, signal),
      strategy, regime,
      entryTime:      new Date().toISOString(),
      entryBar:       bar,
      // Options-specific
      isOption:       true,
      contract:       optionsPlan.contract,
      contractSymbol: optionsPlan.contract.symbol,
      numContracts,
      entryPremium:   contractMid,
      entryIv:        optionsPlan.contract.iv,
      exitTriggers:   optionsPlan.exitTriggers,
      agentReasoning: optionsPlan.reasoning,
      agentConfidence: optionsPlan.confidence,
      agentSource:    optionsPlan.source,
    };
  } else {
    // Stock leg (existing path)
    if (IS_PAPER) {
      console.log(`[Router] PAPER ${signal.side.toUpperCase()} ${sym} via ${strategy} $${perPositionUSD.toFixed(2)} @ ~${bar.close.toFixed(2)} [regime: ${regime}]`);
    } else {
      try { stockOrder = await placeOrder(sym, signal.side, perPositionUSD, bar.close); }
      catch (e) { console.error(`[Router] ${sym} order failed:`, e.message); return; }
    }
    s.position = {
      side:   signal.side,
      entry:  signal.entry,
      stop:   signal.stop,
      target: signal.target,
      ...exitPlan(strategy, signal),
      strategy, regime,
      entryTime: new Date().toISOString(),
      entryBar:  bar,
      isOption:  false,
    };
  }

  // Orders sent: record the real fill so the trade history shows actual
  // slippage/spread vs the signal price (what paper-account testing is for).
  const order = optionsOrder || stockOrder;
  if (order && s.position) {
    s.position.entryOrderId = order.id;
    const fill = await orderFillPrice(order.id);
    if (fill != null) {
      s.position.entryFill = fill;
      console.log(`[Router] ${sym} filled @ ${fill} (${optionsOrder ? "premium" : "signal " + signal.entry.toFixed(2)})`);
    }
  }

  s.tradedToday = true;
  s.strategiesTradedToday = s.strategiesTradedToday || new Set();
  s.strategiesTradedToday.add(strategy);
  routerDay.strategiesFiredToday.add(strategy);
  routerDay.tradesToday = (routerDay.tradesToday || 0) + 1;
  if (signal.tvAlertId) tvConsumed.add(signal.tvAlertId); // each TradingView alert trades once
  // Keep the prediction that drove (or accompanied) the trade on the position
  // so the close path can record target-vs-actual for the dashboard.
  if (s.position && prediction) {
    s.position.prediction = {
      side:              prediction.side,
      priceTarget:       prediction.priceTarget,
      expectedReturnPct: prediction.expectedReturnPct,
      horizonDays:       prediction.horizonDays,
      confidence:        prediction.confidence,
      source:            prediction.source,
    };
  }
}

async function closeRouterPosition(sym, exitPrice, exitReason) {
  const s = getSymState(sym);
  const pos = s.position;
  if (!pos) return;
  let exitFill = null;
  if (!IS_PAPER) {
    // For option positions, close the option contract directly (its OCC symbol),
    // not the underlying stock symbol.
    const closeSymbol = pos.isOption && pos.contractSymbol ? pos.contractSymbol : sym;
    try {
      const closeOrder = await closeAlpacaPosition(closeSymbol);
      exitFill = await orderFillPrice(closeOrder?.id);
    } catch (e) { console.error(`[Router] ${closeSymbol} close failed:`, e.message); }
  }
  // Stock trades are scored on the real fills when both are known; the signal
  // prices are kept alongside so slippage can be measured.
  const stockFills = !pos.isOption && pos.entryFill != null && exitFill != null;
  const dir = pos.side === "buy" ? 1 : -1;
  const fills = pos.entryFill != null || exitFill != null ? {
    entry: pos.entryFill ?? null, exit: exitFill,
    signalEntry: pos.entry, signalExit: exitPrice,
    ...(!pos.isOption && pos.entryFill != null ? { entrySlipPct: +(dir * (pos.entryFill - pos.entry) / pos.entry * 100).toFixed(4) } : {}),
    ...(!pos.isOption && exitFill != null ? { exitSlipPct: +(dir * (exitPrice - exitFill) / exitPrice * 100).toFixed(4) } : {}),
  } : null;
  const hourET = etMinutesOf(new Date(pos.entryTime || Date.now())) / 60 | 0;
  const { pnlPct } = recordTradeClosed({
    symbol: sym, strategy: pos.strategy, side: pos.side,
    source: TRADE_SOURCE,
    entryPrice: stockFills ? pos.entryFill : pos.entry,
    exitPrice:  stockFills ? exitFill : exitPrice,
    fills,
    entryTime: pos.entryTime, exitTime: new Date().toISOString(),
    exitReason,
    regime: pos.regime,
    hourET,
    // Prediction that drove/accompanied the trade (target-vs-actual analysis)
    ...(pos.prediction ? { prediction: pos.prediction } : {}),
    // Options metadata so the agent can learn from outcomes
    ...(pos.isOption ? {
      isOption:       true,
      contractSymbol: pos.contractSymbol,
      optionType:     pos.contract?.type,
      optionStrike:   pos.contract?.strike,
      optionDte:      pos.contract?.dte,
      optionDelta:    pos.contract?.delta,
      optionIv:       pos.entryIv,
      entryPremium:   pos.entryFill ?? pos.entryPremium,
      // With orders enabled these are real fills; in PAPER_TRADING mode the
      // exit premium isn't known and only the underlying move is recorded.
      ...(pos.entryFill != null && exitFill != null ? {
        exitPremium: exitFill,
        optionsPnL:  +((exitFill - pos.entryFill) * 100 * (pos.numContracts || 1)).toFixed(2),
      } : { optionsPnL: null }),
      agentSource:    pos.agentSource,
      agentReasoning: pos.agentReasoning,
      agentConfidence: pos.agentConfidence,
    } : {}),
  });
  recordDayPnl(pnlPct);
  s.position = null;
}

// ── Wire up the stream ────────────────────────────────────────────────────────

// Traded stock symbols come from the bot's own list (symbols.json / SYMBOLS
// env — see symbols.js), not an Alpaca watchlist. Alpaca only supplies prices.
let resolvedSymbols = loadSymbols();

if (ROUTER_ENABLED()) {
  console.log(`[Router] ENABLED — strategies: ${ACTIVE_STRATS().join(", ")}`);
  if (PREDICTOR_ENABLED()) {
    console.log(`[Predictor] gate ENABLED — engine: ${hasModel() ? "XGBoost model" : "heuristic baseline (no model.json yet — see ml/README.md)"} · min-conf ${PREDICTOR_MIN_CONF()} · veto ${PREDICTOR_VETO()} · size-scaling ${PREDICTOR_SIZE_SCALING()}`);
  }
  if (PREDICTOR_SIGNAL_ENABLED()) {
    console.log(`[Predictor] SIGNAL MODE — the model generates trades: minEdge ${runtimeCfg.predictorMinEdge} · minConf ${runtimeCfg.predictorSignalMinConf} · floor ${MIN_TRADES_PER_DAY()}/day after ${runtimeCfg.floorTimeET} ET (edge ≥ ${runtimeCfg.predictorMinEdgeFloor}) · strike ${STRIKE_MODE()} · DTE +${OPTIONS_DTE_BUFFER()}`);
  }
  console.log(TV_ENABLED()
    ? `[TradingView] alerts ENABLED — POST /webhook/tradingview · alerts expire after ${TV_MAX_AGE_SEC()}s · default stop ${TV_STOP_ATR_MULT}×ATR, target ${TV_RR}R`
    : `[TradingView] alerts off — set TV_WEBHOOK_SECRET to trade TradingView alerts`);
  console.log(`[Router] subscribing to ${resolvedSymbols.length} symbols: ${resolvedSymbols.join(", ") || "(none)"}`);
} else {
  // Single-strategy mode trades the FIRST configured symbol.
  SYMBOL = resolvedSymbols[0] || null;
  resolvedSymbols = SYMBOL ? [SYMBOL] : [];
  console.log(SYMBOL
    ? `[Bot] single-strategy mode (${STRATEGY} on ${SYMBOL} — first configured symbol) — toggle Router ON for multi-strategy routing`
    : `[Bot] single-strategy mode, but no symbols are configured — nothing to trade`);
  if (SYMBOL) saveState({ symbol: SYMBOL });
}

if (resolvedSymbols.length === 0 && CRYPTO_SYMBOLS.length === 0) {
  console.error("═".repeat(60));
  console.error("[Bot] NO SYMBOLS TO TRADE — no stock symbols configured.");
  console.error("[Bot] Set SYMBOLS=SPY,TSLA,QQQ,MSFT,META in .env, or add stocks in");
  console.error("[Bot] the dashboard's Account tab, then restart.");
  console.error("═".repeat(60));
}

// ── Heartbeat — proves the bot PROCESS is alive even when no bars arrive ──────
// (bars stop overnight/weekends, so state-file mtimes go stale while the
// process is perfectly healthy; the dashboard's status pill reads this file.)
const HEARTBEAT_FILE = dataPath("bot-heartbeat.json");
function writeHeartbeat() {
  try {
    writeFileSync(HEARTBEAT_FILE, JSON.stringify({
      at:              new Date().toISOString(),
      pid:             process.pid,
      routerEnabled:   ROUTER_ENABLED(),
      predictorSignal: PREDICTOR_SIGNAL_ENABLED(),
      optionsMode:     OPTIONS_MODE(),
      paper:           IS_PAPER,
      symbols:         resolvedSymbols,
      // Bars on hand per symbol (5m/15m/1h) — shows the startup warm-up worked.
      bars: Object.fromEntries([...routerStates].map(([sym, s]) => [sym, { m5: s.series.get(5).length, m15: s.series.get(15).length, h1: s.series.get(60).length, daily: s.series.daily.length }])),
      activeStrategies: ACTIVE_STRATS(),
      unsupportedStrategies: UNSUPPORTED_ACTIVE(),
    }));
  } catch {}
}
writeHeartbeat();
setInterval(writeHeartbeat, 60_000);

// Split symbols by feed: stocks go to the IEX stream, crypto to the v1beta3 stream.
const stockSymbols  = resolvedSymbols.filter(s => !isCryptoSymbol(s));
const cryptoSymbols = [...new Set([...resolvedSymbols.filter(isCryptoSymbol), ...CRYPTO_SYMBOLS])];

// Warm up each stock symbol's bar series from recent history, so strategies
// on 5/15/60-minute bars (EMAs, ATR, regime, the predictor) can trade from the
// first bar after a restart instead of waiting hours to fill their buffers.
const WARMUP_DAYS = parseInt(process.env.WARMUP_DAYS || "21");  // calendar days: noise-momentum needs 14 trading days
for (const sym of stockSymbols) {
  try {
    const hist = await fetchCandles(sym, "1m", { days: WARMUP_DAYS, cap: 50_000 });
    const s = getSymState(sym);
    for (const b of hist) {
      s.series.push(b);
      s.bars.push({ ...b, symbol: sym });
      if (s.bars.length > 500) s.bars.shift();
    }
    // Daily sessions for daily-bar strategies (dip-buy's 200-day average):
    // older than the intraday warm-up. Stamp +12h so the UTC-midnight daily
    // bar maps to its own ET date in winter too.
    try {
      const days = await fetchCandles(sym, "1D", { days: 420, cap: 1_000 });
      s.series.seedDaily(days.map(d => ({ day: etInfo(d.time + 12 * 3600_000).day, open: d.open, high: d.high, low: d.low, close: d.close })));
    } catch (e) { console.warn(`[Bot] daily history ${sym} failed (${e.message}) — daily strategies wait for 200 sessions`); }
    console.log(`[Bot] warm-up ${sym}: ${hist.length} 1m bars → ${s.series.get(5).length}×5m ${s.series.get(15).length}×15m ${s.series.get(60).length}×1h, ${s.series.daily.length} daily`);
  } catch (e) {
    console.warn(`[Bot] warm-up ${sym} failed (${e.message}) — its strategies start once enough live bars arrive`);
  }
}

// Overnight positions (dip-buy) survive restarts: restore them from the last
// saved router state. Intraday positions are not restored — they would have
// been closed at 3:45 anyway.
const restored = [];
try {
  const saved = existsSync(ROUTER_STATE_FILE) ? JSON.parse(readFileSync(ROUTER_STATE_FILE, "utf8")) : null;
  for (const [sym, v] of Object.entries(saved?.symbols || {})) {
    if (v.position?.overnight && stockSymbols.includes(sym)) {
      getSymState(sym).position = v.position;
      restored.push(`${sym} ${v.position.strategy} from ${v.position.entryDay}`);
    }
  }
  if (restored.length) console.log(`[Router] restored overnight position(s): ${restored.join(", ")}`);
} catch (e) { console.warn("[Router] could not restore positions:", e.message); }

// With orders enabled, the bot only manages positions it opened since this
// start (plus restored overnight ones). Flag anything else already open in the
// account on its symbols — it will NOT be managed or closed automatically.
if (!IS_PAPER) {
  try {
    const res = await fetch(`${ALPACA_BASE}/v2/positions`, { headers: ALPACA_HEADERS });
    const open = res.ok ? await res.json() : [];
    const ours = open.filter(p => stockSymbols.some(sym => p.symbol === sym || p.symbol.startsWith(sym)) && !routerStates.get(p.symbol)?.position);
    if (ours.length) console.warn(`[Bot] ${ours.length} open ${TRADE_SOURCE} position(s) the bot is NOT tracking (from before this start): ${ours.map(p => `${p.symbol} ${p.qty}`).join(", ")} — close them in Alpaca if unwanted`);
  } catch (e) { console.warn("[Bot] could not list open positions:", e.message); }
}

if (UNSUPPORTED_ACTIVE().length) {
  console.warn(`[Router] no live evaluator for: ${UNSUPPORTED_ACTIVE().join(", ")} — these never fire live (backtest-only)`);
}
writeHeartbeat();   // record the warm-up

const streams = [];

// Dispatcher reads the LATEST routerEnabled flag on every bar event so the
// dashboard toggle flips behavior live without restarting the bot process.
async function dispatchStockBar(bar) {
  if (ROUTER_ENABLED()) return onRouterBar(bar);
  return onBar(bar);
}

if (stockSymbols.length > 0) {
  const s = new AlpacaStream(stockSymbols, { feed: "stocks" });
  s.on("connected",    () => console.log(`[Bot] STOCKS stream connected — ${stockSymbols.join(", ")}`));
  s.on("disconnected", () => console.log("[Bot] STOCKS stream disconnected — auto-reconnecting"));
  s.on("error",        err => console.error("[Bot] STOCKS stream error:", err.message));
  s.on("bar",          dispatchStockBar);
  s.connect();
  streams.push(s);
}

if (cryptoSymbols.length > 0) {
  if (!ROUTER_ENABLED()) {
    console.log(`[Bot] CRYPTO_SYMBOLS set but Router is off — crypto bars will stream but no trades will fire. Toggle Router ON in the dashboard.`);
  }
  const s = new AlpacaStream(cryptoSymbols, { feed: "crypto" });
  s.on("connected",    () => console.log(`[Bot] CRYPTO stream connected — ${cryptoSymbols.join(", ")}`));
  s.on("disconnected", () => console.log("[Bot] CRYPTO stream disconnected — auto-reconnecting"));
  s.on("error",        err => console.error("[Bot] CRYPTO stream error:", err.message));
  // Crypto always goes through the router (the single-strategy onBar is too NYSE-centric)
  s.on("bar",          onRouterBar);
  s.connect();
  streams.push(s);
}

const stream = streams[0] || null; // keep `stream` reference for SIGINT close below

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n[Bot] Shutting down…");
  const state = loadState();
  if (state.position) {
    console.warn("[Bot] WARNING: Open position not closed — check your Alpaca account!");
  }
  saveState({ botStopped: new Date().toISOString() });
  for (const s of streams) { try { s.close(); } catch {} }
  process.exit(0);
});
