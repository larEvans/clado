/**
 * Backtester — stock R-based or options dollar P&L
 *
 * CLI:    node backtest.js --strategy=orb  --symbol=SPY
 *         node backtest.js --strategy=vwap --symbol=NVDA --mode=options --iv=28 --dte=7
 * Module: import { runBacktest } from './backtest.js'
 */

import "dotenv/config";
import { meta as orbMeta, calcRange, checkSignal as orbSignal }       from "./strategies/orb.js";
import { meta as vwapMeta, checkSignal as vwapSignal, checkBiasFlip } from "./strategies/vwap.js";
import { meta as trendMeta }   from "./strategies/trend.js";
import { meta as meanrevMeta } from "./strategies/meanrev.js";
import { meta as momentumMeta } from "./strategies/momentum.js";
import { meta as hybridMeta }  from "./strategies/hybrid.js";
import { meta as reversalMeta } from "./strategies/reversal.js";
import { meta as hybridReversalMeta } from "./strategies/hybrid-reversal.js";
import { meta as hybrid10Meta }       from "./strategies/hybrid10.js";
import { meta as gapFillMeta }        from "./strategies/gap-fill.js";
import { meta as vwapReclaimMeta }    from "./strategies/vwap-reclaim.js";
import { meta as firstHourFadeMeta }  from "./strategies/first-hour-fade.js";
import { meta as smcMeta, checkSignal as smcSignal } from "./strategies/smc.js";
import { classifyRegime }              from "./regime.js";

// ─── Market data ──────────────────────────────────────────────────────────────

/**
 * Fetch historical bars from Alpaca.
 *
 * Default day window per timeframe is short to keep typical backtests fast.
 * Pass { yearWindow: true } or set BACKTEST_DAYS env var to override and pull
 * a full year (or longer) of data for sub-hour timeframes. Pagination cap
 * scales accordingly.
 */
export async function fetchCandles(symbol, interval, opts = {}) {
  const tfMap  = { "1m":"1Min","5m":"5Min","15m":"15Min","30m":"30Min","1H":"1Hour","4H":"4Hour","1D":"1Day" };
  const tf     = tfMap[interval] || "1Hour";

  const yearWindow = opts.yearWindow || process.env.BACKTEST_DAYS;
  const envDays    = parseInt(process.env.BACKTEST_DAYS || "0") || null;

  const shortDays = { "1Min":7,"5Min":60,"15Min":60,"30Min":60,"1Hour":365,"4Hour":365,"1Day":730 };
  const yearDays  = { "1Min":30,"5Min":365,"15Min":365,"30Min":365,"1Hour":730,"4Hour":730,"1Day":1825 };
  const days = envDays
    || (yearWindow ? (yearDays[tf] || 365) : (shortDays[tf] || 60));

  const start = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

  const BASE    = "https://data.alpaca.markets";
  const headers = {
    "APCA-API-KEY-ID":     process.env.ALPACA_API_KEY,
    "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY,
  };

  // Crypto symbols (BTC/USD, ETH/USD…) use a different historical endpoint
  // and parameter set: /v1beta3/crypto/us/bars?symbols=BTC/USD&timeframe=…
  const isCrypto = symbol.includes("/");
  const candleCap = (yearWindow || envDays) ? 30_000 : 5_000;

  const candles = [];
  let nextToken = null;

  if (isCrypto) {
    do {
      const qs = new URLSearchParams({
        symbols:   symbol,
        timeframe: tf,
        start,
        limit:     "10000",
        sort:      "asc",
        ...(nextToken && { page_token: nextToken }),
      });
      const res = await fetch(`${BASE}/v1beta3/crypto/us/bars?${qs}`, { headers, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`Alpaca crypto bars ${res.status} for ${symbol} — check the symbol format (e.g. BTC/USD)`);
      const json = await res.json();
      const bars = json.bars?.[symbol] || [];
      for (const b of bars) candles.push({ time: new Date(b.t).getTime(), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v });
      nextToken = json.next_page_token || null;
    } while (nextToken && candles.length < candleCap);
  } else {
    do {
      const qs = new URLSearchParams({ timeframe: tf, start, limit: "10000", adjustment: "split", feed: "iex", ...(nextToken && { page_token: nextToken }) });
      const res = await fetch(`${BASE}/v2/stocks/${symbol}/bars?${qs}`, { headers, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`Alpaca bars ${res.status} for ${symbol} — check the ticker`);
      const json = await res.json();
      for (const b of (json.bars || [])) candles.push({ time: new Date(b.t).getTime(), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v });
      nextToken = json.next_page_token || null;
    } while (nextToken && candles.length < candleCap);
  }

  if (candles.length === 0) throw new Error(`No data returned for ${symbol}`);
  return candles;
}

// ─── Black-Scholes option pricing ────────────────────────────────────────────

function normCDF(x) {
  const neg = x < 0;
  x = Math.abs(x);
  const t   = 1 / (1 + 0.2316419 * x);
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const pdf  = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
  const cdf  = 1 - pdf * poly;
  return neg ? 1 - cdf : cdf;
}

function bsPrice(S, K, T, iv, type) {
  if (T <= 0) return type === "call" ? Math.max(S - K, 0) : Math.max(K - S, 0);
  const r  = 0.05;
  const d1 = (Math.log(S / K) + (r + 0.5 * iv * iv) * T) / (iv * Math.sqrt(T));
  const d2 = d1 - iv * Math.sqrt(T);
  if (type === "call") return S * normCDF(d1) - K * Math.exp(-r * T) * normCDF(d2);
  return K * Math.exp(-r * T) * normCDF(-d2) - S * normCDF(-d1);
}

function atmStrike(price, interval = 1) {
  return Math.round(price / interval) * interval;
}

function optionPremium(stockPrice, strike, daysRemaining, iv, type) {
  const T = Math.max(daysRemaining, 0.001) / 365;
  return Math.max(bsPrice(stockPrice, strike, T, iv, type), 0);
}

// ─── DST / NYSE helpers ───────────────────────────────────────────────────────

function isEDT(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  if (m < 3 || m > 11) return false;
  if (m > 3 && m < 11) return true;
  const mar1 = new Date(Date.UTC(y, 2, 1));
  const ss   = new Date(mar1.getTime() + ((mar1.getUTCDay()===0 ? 0 : 7-mar1.getUTCDay()) + 7)*86400000);
  ss.setUTCHours(7,0,0,0);
  const nov1 = new Date(Date.UTC(y, 10, 1));
  const fs   = new Date(nov1.getTime() + (nov1.getUTCDay()===0 ? 0 : 7-nov1.getUTCDay())*86400000);
  fs.setUTCHours(6,0,0,0);
  if (m === 3) return ms >= ss.getTime();
  return ms < fs.getTime();
}

function nyseOpenMs(ms) {
  const d = new Date(ms), h = isEDT(ms) ? 13 : 14;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, 30, 0);
}

function etDateKey(ms) {
  const etMs = ms - (isEDT(ms) ? 4 : 5) * 3600000;
  return new Date(etMs).toISOString().slice(0, 10);
}

function groupByDay(candles) {
  const groups = {};
  for (const c of candles) {
    const key = etDateKey(c.time);
    if (!groups[key]) groups[key] = [];
    groups[key].push(c);
  }
  return Object.entries(groups)
    .sort(([a],[b]) => a.localeCompare(b))
    .map(([date, candles]) => ({ date, candles: candles.sort((a,b) => a.time-b.time) }));
}

// ─── Near-target early exit ──────────────────────────────────────────────────
// Default: when price comes within 5% of the planned target distance, close
// the trade at the near-target price. "Within 5%" = the trade has captured
// 95% of the entry→target move, so we lock the win instead of waiting for the
// exact tag. Configurable via NEAR_TARGET_PCT env var or per-call param.

const DEFAULT_NEAR_TARGET_PCT = parseFloat(process.env.NEAR_TARGET_PCT || "5");

export function nearTargetTrigger(side, entry, target, bar, pct = DEFAULT_NEAR_TARGET_PCT) {
  if (!entry || !target || !bar) return null;
  const dist  = Math.abs(target - entry);
  if (dist <= 0) return null;
  const ratio = Math.max(0, Math.min(1, (100 - pct) / 100)); // 0.95 for pct=5
  if (side === "buy") {
    const trigger = entry + dist * ratio;
    if (bar.high >= trigger && bar.high < target) return trigger;
  } else {
    const trigger = entry - dist * ratio;
    if (bar.low  <= trigger && bar.low  > target) return trigger;
  }
  return null;
}

// ─── Order Blocks (SMC liquidity zones) ──────────────────────────────────────
//
// An "order block" is the last opposite-direction candle before a strong
// impulse move — the place where smart money got positioned before pushing
// price the other way. For a LONG entry we want the most recent BULLISH OB:
// the last DOWN-close candle that was followed by ≥ `impulseBars` consecutive
// UP-close candles, the last of which broke above the OB's high. For a SHORT
// we want the mirror: the last UP-close candle followed by ≥ impulseBars down
// closes that broke below the OB's low.
//
// Returns { high, low, time, side } of the order block, or null if none found
// in the lookback window. Caller places stop just beyond OB low (long) or
// OB high (short).

export function findOrderBlock(bars, entrySide, opts = {}) {
  const { lookback = 30, impulseBars = 2, minImpulsePct = 0.15 } = opts;
  if (!bars || bars.length < impulseBars + 2) return null;

  const start = Math.max(0, bars.length - lookback);
  const end   = bars.length - impulseBars - 1; // need impulseBars after the OB

  if (entrySide === "buy") {
    // Walk backwards: find a DOWN candle (close < open) where the next
    // `impulseBars` are all UP candles and the impulse broke above OB high.
    for (let i = end; i >= start; i--) {
      const c = bars[i];
      if (c.close >= c.open) continue; // need a down candle
      const obHigh = c.high, obLow = c.low;

      let impulseOK = true;
      let impulseEnd = bars[Math.min(i + impulseBars, bars.length - 1)];
      for (let j = 1; j <= impulseBars; j++) {
        const n = bars[i + j];
        if (!n || n.close <= n.open) { impulseOK = false; break; }
      }
      if (!impulseOK) continue;

      // Must have broken above the OB high during the impulse
      if (impulseEnd.high <= obHigh) continue;
      const movePct = ((impulseEnd.high - obHigh) / obHigh) * 100;
      if (movePct < minImpulsePct) continue;

      return { side: "bullish", high: obHigh, low: obLow, time: c.time, impulsePct: movePct };
    }
    return null;
  }

  if (entrySide === "sell") {
    for (let i = end; i >= start; i--) {
      const c = bars[i];
      if (c.close <= c.open) continue; // need an up candle
      const obHigh = c.high, obLow = c.low;

      let impulseOK = true;
      let impulseEnd = bars[Math.min(i + impulseBars, bars.length - 1)];
      for (let j = 1; j <= impulseBars; j++) {
        const n = bars[i + j];
        if (!n || n.close >= n.open) { impulseOK = false; break; }
      }
      if (!impulseOK) continue;

      if (impulseEnd.low >= obLow) continue;
      const movePct = ((obLow - impulseEnd.low) / obLow) * 100;
      if (movePct < minImpulsePct) continue;

      return { side: "bearish", high: obHigh, low: obLow, time: c.time, impulsePct: movePct };
    }
    return null;
  }
  return null;
}

// Helper: pick the stop price for an entry. Returns { stop, source } where
// source is "order-block" or "orb-fallback".
export function pickStop(side, entryPrice, bars, orbHigh, orbLow, opts = {}) {
  const { padPct = 0.05 } = opts;
  const ob = findOrderBlock(bars, side, opts);
  if (ob) {
    const pad = entryPrice * (padPct / 100);
    if (side === "buy"  && ob.low  < entryPrice) return { stop: ob.low  - pad, source: "order-block", ob };
    if (side === "sell" && ob.high > entryPrice) return { stop: ob.high + pad, source: "order-block", ob };
  }
  return { stop: side === "buy" ? orbLow : orbHigh, source: "orb-fallback", ob: null };
}

// ─── Indicators ───────────────────────────────────────────────────────────────

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a,b) => a+b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i]*k + ema*(1-k);
  return ema;
}

function calcRSI(closes, period) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) gains += d; else losses -= d;
  }
  const ag = gains/period, al = losses/period;
  return al === 0 ? 100 : 100 - 100/(1 + ag/al);
}

function sessionVWAP(candles) {
  let tpv = 0, vol = 0;
  for (const c of candles) { tpv += ((c.high+c.low+c.close)/3)*c.volume; vol += c.volume; }
  return vol === 0 ? null : tpv / vol;
}

// ─── ORB Backtest ─────────────────────────────────────────────────────────────

function runORBBacktest(allCandles, params, opts = {}) {
  const { orbMinutes, tradeWindowMins, volumeMultiplier, volMaPeriod, maxRangePct, rrRatio } = { ...orbMeta.params, ...params };
  const { mode = "stock", iv = 0.18, dteDays = 7, numContracts = 1, strikeInterval = 1 } = opts;
  const sessions = groupByDay(allCandles);
  const trades   = [];

  for (const { date, candles } of sessions) {
    const open     = nyseOpenMs(candles[0].time);
    const orbEnd   = open + orbMinutes * 60000;
    const tradeEnd = open + tradeWindowMins * 60000;
    const sessEnd  = open + 6.25 * 3600000;

    const sessCandles = candles.filter(c => c.time >= open && c.time < open + 7*3600000);
    if (sessCandles.length < 3) continue;

    const orbCandles = sessCandles.filter(c => c.time < orbEnd);
    if (orbCandles.length === 0) continue;

    const orb = calcRange(orbCandles);
    if (!orb) continue;

    const mid = (orb.orbHigh + orb.orbLow) / 2;
    if ((orb.orbRange / mid) * 100 >= maxRangePct) continue;

    const postOrb = sessCandles.filter(c => c.time >= orbEnd);
    let tradeEntered = false;
    let openTrade    = null;

    for (let i = 0; i < postOrb.length; i++) {
      const bar = postOrb[i];

      if (openTrade) {
        const { side, entry, stop, target, entryTime, optionStrike, optionType, entryPremium, entryDTE } = openTrade;
        let exitPrice = null, exitReason = null;

        if (side === "buy") {
          if (bar.low  <= stop)   { exitPrice = stop;   exitReason = "stop";   }
          else if (bar.high >= target) { exitPrice = target; exitReason = "target"; }
          else {
            const nt = nearTargetTrigger(side, entry, target, bar);
            if (nt != null) { exitPrice = nt; exitReason = "near-target"; }
          }
        } else {
          if (bar.high >= stop)   { exitPrice = stop;   exitReason = "stop";   }
          else if (bar.low  <= target) { exitPrice = target; exitReason = "target"; }
          else {
            const nt = nearTargetTrigger(side, entry, target, bar);
            if (nt != null) { exitPrice = nt; exitReason = "near-target"; }
          }
        }
        if (!exitPrice && bar.time >= sessEnd) { exitPrice = bar.close; exitReason = "time"; }

        if (exitPrice) {
          const risk   = Math.abs(entry - stop);
          const pnlUSD = side === "buy" ? exitPrice - entry : entry - exitPrice;
          const pnlR   = risk > 0 ? pnlUSD / risk : 0;

          let optResult = {};
          if (mode === "options" && entryPremium != null) {
            const elapsedDays = (bar.time - entryTime) / 86400000;
            const remDTE      = Math.max(entryDTE - elapsedDays, 0.01);
            const exitPremium = optionPremium(exitPrice, optionStrike, remDTE, iv, optionType);
            const optPnL      = (exitPremium - entryPremium) * 100 * numContracts;
            const optPnLPct   = entryPremium > 0 ? ((exitPremium - entryPremium) / entryPremium) * 100 : 0;
            optResult = { optionType, optionStrike, entryPremium, exitPremium, optionsPnL: optPnL, optionsPnLPct: optPnLPct, optionDTE: entryDTE };
          }

          trades.push({ date, entryTime, exitTime: bar.time, side, entry, stop, target, exit: exitPrice, exitReason, pnlR, pnlPct: (pnlUSD/entry)*100, ...optResult });
          openTrade = null;
        }
        continue;
      }

      if (tradeEntered || bar.time >= tradeEnd) continue;

      const vwap = sessionVWAP([...orbCandles, ...postOrb.slice(0, i+1)]);
      const sig  = orbSignal(bar, orb, vwap, sessCandles.slice(0, sessCandles.indexOf(bar)), { orbMinutes, rrRatio, volumeMultiplier, volMaPeriod, maxRangePct });
      if (sig) {
        const entry = bar.close;
        if (sig.side === "buy"  && entry >= sig.target) continue;
        if (sig.side === "sell" && entry <= sig.target) continue;

        let optInfo = {};
        if (mode === "options") {
          const optionType   = sig.side === "buy" ? "call" : "put";
          const optionStrike = atmStrike(entry, strikeInterval);
          const entryPremium = optionPremium(entry, optionStrike, dteDays, iv, optionType);
          optInfo = { optionType, optionStrike, entryPremium, entryDTE: dteDays };
        }

        openTrade = { ...sig, entry, entryTime: bar.time, ...optInfo };
        tradeEntered = true;
      }
    }

    if (openTrade && postOrb.length > 0) {
      const last = postOrb[postOrb.length - 1];
      const { side, entry, stop, entryTime, optionStrike, optionType, entryPremium, entryDTE } = openTrade;
      const pnlUSD = side === "buy" ? last.close - entry : entry - last.close;
      const risk   = Math.abs(entry - stop);
      const pnlR   = risk > 0 ? pnlUSD/risk : 0;

      let optResult = {};
      if (mode === "options" && entryPremium != null) {
        const elapsedDays = (last.time - entryTime) / 86400000;
        const exitPremium = optionPremium(last.close, optionStrike, Math.max(entryDTE - elapsedDays, 0.01), iv, optionType);
        const optPnL      = (exitPremium - entryPremium) * 100 * numContracts;
        optResult = { optionType, optionStrike, entryPremium, exitPremium, optionsPnL: optPnL, optionsPnLPct: entryPremium > 0 ? ((exitPremium-entryPremium)/entryPremium)*100 : 0, optionDTE: entryDTE };
      }

      trades.push({ date, entryTime, exitTime: last.time, side, entry, stop, target: openTrade.target, exit: last.close, exitReason: "time", pnlR, pnlPct: (pnlUSD/entry)*100, ...optResult });
    }
  }

  return trades;
}

// ─── VWAP Backtest ────────────────────────────────────────────────────────────

function runVWAPBacktest(allCandles, params, opts = {}) {
  const { emaPeriod, rsiPeriod, rsiOversold, rsiOverbought, maxVwapDistPct, stopPct, rrRatio } = { ...vwapMeta.params, ...params };
  const { mode = "stock", iv = 0.18, dteDays = 7, numContracts = 1, strikeInterval = 1 } = opts;
  const sorted = [...allCandles].sort((a,b) => a.time - b.time);
  const trades = [];
  let sessionStartIdx = 0;
  let openTrade       = null;
  let prevDay         = null;

  for (let i = 1; i < sorted.length; i++) {
    const bar = sorted[i];
    const day = etDateKey(bar.time);

    if (day !== prevDay && prevDay !== null) {
      if (openTrade) {
        const last = sorted[i - 1];
        const { side, entry, stop, entryTime, optionStrike, optionType, entryPremium, entryDTE } = openTrade;
        const pnlUSD = side === "buy" ? last.close - entry : entry - last.close;
        const risk   = Math.abs(entry - stop);
        const pnlR   = risk > 0 ? pnlUSD/risk : 0;

        let optResult = {};
        if (mode === "options" && entryPremium != null) {
          const elapsedDays = (last.time - entryTime) / 86400000;
          const exitPremium = optionPremium(last.close, optionStrike, Math.max(entryDTE - elapsedDays, 0.01), iv, optionType);
          const optPnL = (exitPremium - entryPremium) * 100 * numContracts;
          optResult = { optionType, optionStrike, entryPremium, exitPremium, optionsPnL: optPnL, optionsPnLPct: entryPremium > 0 ? ((exitPremium-entryPremium)/entryPremium)*100 : 0, optionDTE: entryDTE };
        }

        trades.push({ date: prevDay, entryTime, exitTime: last.time, side, entry, stop, target: openTrade.target, exit: last.close, exitReason: "session_end", pnlR, pnlPct: (pnlUSD/entry)*100, ...optResult });
        openTrade = null;
      }
      sessionStartIdx = i;
    }
    prevDay = day;

    if (i < emaPeriod + rsiPeriod + 1) continue;

    const slice  = sorted.slice(0, i+1);
    const closes = slice.map(c => c.close);
    const price  = bar.close;
    const ema8   = calcEMA(closes, emaPeriod);
    const rsi3   = calcRSI(closes, rsiPeriod);
    const vwap   = sessionVWAP(sorted.slice(sessionStartIdx, i+1));
    if (!ema8 || !rsi3 || !vwap) continue;

    if (openTrade) {
      const { side, entry, stop, target, entryTime, optionStrike, optionType, entryPremium, entryDTE } = openTrade;
      const flip = checkBiasFlip(price, ema8, vwap, side);
      let exitPrice = null, exitReason = null;

      if (side === "buy") {
        if (bar.low  <= stop)   { exitPrice = stop;   exitReason = "stop";     }
        else if (target && bar.high >= target) { exitPrice = target; exitReason = "target";   }
        else if (target) {
          const nt = nearTargetTrigger(side, entry, target, bar);
          if (nt != null) { exitPrice = nt; exitReason = "near-target"; }
        }
        if (!exitPrice && flip) { exitPrice = price;  exitReason = "bias_flip"; }
      } else {
        if (bar.high >= stop)   { exitPrice = stop;   exitReason = "stop";     }
        else if (target && bar.low  <= target) { exitPrice = target; exitReason = "target";   }
        else if (target) {
          const nt = nearTargetTrigger(side, entry, target, bar);
          if (nt != null) { exitPrice = nt; exitReason = "near-target"; }
        }
        if (!exitPrice && flip) { exitPrice = price;  exitReason = "bias_flip"; }
      }

      if (exitPrice) {
        const risk   = Math.abs(entry - stop);
        const pnlUSD = side === "buy" ? exitPrice - entry : entry - exitPrice;
        const pnlR   = risk > 0 ? pnlUSD/risk : 0;

        let optResult = {};
        if (mode === "options" && entryPremium != null) {
          const elapsedDays = (bar.time - entryTime) / 86400000;
          const exitPremium = optionPremium(exitPrice, optionStrike, Math.max(entryDTE - elapsedDays, 0.01), iv, optionType);
          const optPnL = (exitPremium - entryPremium) * 100 * numContracts;
          optResult = { optionType, optionStrike, entryPremium, exitPremium, optionsPnL: optPnL, optionsPnLPct: entryPremium > 0 ? ((exitPremium-entryPremium)/entryPremium)*100 : 0, optionDTE: entryDTE };
        }

        trades.push({ date: day, entryTime, exitTime: bar.time, side, entry, stop, target, exit: exitPrice, exitReason, pnlR, pnlPct: (pnlUSD/entry)*100, ...optResult });
        openTrade = null;
      }
      if (openTrade) continue;
    }

    const sig = vwapSignal(price, ema8, vwap, rsi3, { emaPeriod, rsiPeriod, rsiOversold, rsiOverbought, maxVwapDistPct, stopPct, rrRatio });
    if (sig) {
      if (sig.side === "buy"  && price >= sig.target) continue;
      if (sig.side === "sell" && price <= sig.target) continue;

      let optInfo = {};
      if (mode === "options") {
        const optionType   = sig.side === "buy" ? "call" : "put";
        const optionStrike = atmStrike(price, strikeInterval);
        const entryPremium = optionPremium(price, optionStrike, dteDays, iv, optionType);
        optInfo = { optionType, optionStrike, entryPremium, entryDTE: dteDays };
      }

      openTrade = { ...sig, entry: price, entryTime: bar.time, ...optInfo };
    }
  }

  return trades;
}

// ─── Array indicators (for daily strategies) ─────────────────────────────────

function emaFull(closes, period) {
  const k = 2 / (period + 1);
  const out = new Array(closes.length).fill(null);
  if (closes.length < period) return out;
  out[period - 1] = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) out[i] = closes[i] * k + out[i - 1] * (1 - k);
  return out;
}

function smaArray(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++)
    out[i] = values.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
  return out;
}

function atrArray(bars, period = 14) {
  const out = new Array(bars.length).fill(null);
  if (bars.length < period + 1) return out;
  const trs = [null];
  for (let i = 1; i < bars.length; i++)
    trs.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i-1].close), Math.abs(bars[i].low - bars[i-1].close)));
  let atr = trs.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  out[period] = atr;
  for (let i = period + 1; i < bars.length; i++) { atr = (atr * (period - 1) + trs[i]) / period; out[i] = atr; }
  return out;
}

function bbArray(closes, period = 20, mult = 2.0) {
  const out = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const sl = closes.slice(i - period + 1, i + 1);
    const mean = sl.reduce((a, b) => a + b, 0) / period;
    const std  = Math.sqrt(sl.reduce((s, c) => s + (c - mean) ** 2, 0) / period);
    out[i] = { upper: mean + mult * std, middle: mean, lower: mean - mult * std };
  }
  return out;
}

function rsiArray(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i-1]; if (d > 0) gains += d; else losses -= d; }
  let ag = gains / period, al = losses / period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    ag = (ag * (period - 1) + g) / period; al = (al * (period - 1) + l) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}

function macdFull(closes, fast = 12, slow = 26, sig = 9) {
  const fastE = emaFull(closes, fast), slowE = emaFull(closes, slow);
  const macdLine = closes.map((_, i) => fastE[i] !== null && slowE[i] !== null ? fastE[i] - slowE[i] : null);
  const nonNull  = macdLine.map((v, i) => ({ v, i })).filter(x => x.v !== null);
  const result   = { macd: macdLine, signal: new Array(closes.length).fill(null), hist: new Array(closes.length).fill(null) };
  if (nonNull.length < sig) return result;
  const k = 2 / (sig + 1);
  let sigEma = nonNull.slice(0, sig).reduce((a, x) => a + x.v, 0) / sig;
  result.signal[nonNull[sig - 1].i] = sigEma;
  result.hist[nonNull[sig - 1].i]   = nonNull[sig - 1].v - sigEma;
  for (let j = sig; j < nonNull.length; j++) {
    const { v, i } = nonNull[j];
    sigEma = v * k + sigEma * (1 - k);
    result.signal[i] = sigEma; result.hist[i] = v - sigEma;
  }
  return result;
}

// Shared exit helper for daily strategies
function dailyExit(trade, bar, mode, iv, numContracts) {
  const { side, entry, stop, target, entryTime } = trade;
  let exitPrice = null, exitReason = null;
  if (side === "buy") {
    if (bar.low  <= stop)   { exitPrice = stop;   exitReason = "stop"; }
    else if (bar.high >= target) { exitPrice = target; exitReason = "target"; }
    else {
      const nt = nearTargetTrigger(side, entry, target, bar);
      if (nt != null) { exitPrice = nt; exitReason = "near-target"; }
    }
  } else {
    if (bar.high >= stop)   { exitPrice = stop;   exitReason = "stop"; }
    else if (bar.low  <= target) { exitPrice = target; exitReason = "target"; }
    else {
      const nt = nearTargetTrigger(side, entry, target, bar);
      if (nt != null) { exitPrice = nt; exitReason = "near-target"; }
    }
  }
  if (!exitPrice) return null;

  const risk   = Math.abs(entry - stop);
  const pnlUSD = side === "buy" ? exitPrice - entry : entry - exitPrice;
  const pnlR   = risk > 0 ? pnlUSD / risk : 0;
  const date   = new Date(bar.time).toISOString().slice(0, 10);

  let optResult = {};
  if (mode === "options" && trade.entryPremium != null) {
    const elapsed    = (bar.time - entryTime) / 86400000;
    const exitPrem   = optionPremium(exitPrice, trade.optionStrike, Math.max(trade.optionDTE - elapsed, 0.01), iv, trade.optionType);
    const optPnL     = (exitPrem - trade.entryPremium) * 100 * numContracts;
    optResult = { optionType: trade.optionType, optionStrike: trade.optionStrike, entryPremium: trade.entryPremium, exitPremium: exitPrem, optionsPnL: optPnL, optionsPnLPct: trade.entryPremium > 0 ? ((exitPrem - trade.entryPremium) / trade.entryPremium) * 100 : 0, optionDTE: trade.optionDTE };
  }
  return { date, entryTime, exitTime: bar.time, side, entry, stop, target, exit: exitPrice, exitReason, pnlR, pnlPct: (pnlUSD / entry) * 100, ...optResult };
}

// ─── Trend Following Backtest ─────────────────────────────────────────────────

function runTrendBacktest(allCandles, params = {}, opts = {}) {
  const { fastEMA: fastP = 9, slowEMA: slowP = 21, volMaPeriod = 20, volMultiplier = 1.1, atrPeriod = 14, atrMult = 1.5, rrRatio = 2.0 } = { ...trendMeta.params, ...params };
  const { mode = "stock", iv = 0.18, dteDays = 7, numContracts = 1, strikeInterval = 1 } = opts;

  const closes  = allCandles.map(c => c.close);
  const volumes = allCandles.map(c => c.volume);
  const fast    = emaFull(closes, fastP);
  const slow    = emaFull(closes, slowP);
  const volMA   = smaArray(volumes, volMaPeriod);
  const atr     = atrArray(allCandles, atrPeriod);
  const trades  = [];
  let openTrade = null;

  for (let i = slowP + 1; i < allCandles.length; i++) {
    const bar  = allCandles[i];
    const date = new Date(bar.time).toISOString().slice(0, 10);

    if (openTrade) {
      // Also exit on opposite cross
      const crossExit = (openTrade.side === "buy"  && fast[i] < slow[i] && fast[i-1] >= slow[i-1]) ||
                        (openTrade.side === "sell" && fast[i] > slow[i] && fast[i-1] <= slow[i-1]);
      let result = dailyExit(openTrade, bar, mode, iv, numContracts);
      if (!result && crossExit) {
        const pnlUSD = openTrade.side === "buy" ? bar.close - openTrade.entry : openTrade.entry - bar.close;
        const risk   = Math.abs(openTrade.entry - openTrade.stop);
        result = { date, entryTime: openTrade.entryTime, exitTime: bar.time, side: openTrade.side, entry: openTrade.entry, stop: openTrade.stop, target: openTrade.target, exit: bar.close, exitReason: "cross-exit", pnlR: risk > 0 ? pnlUSD/risk : 0, pnlPct: (pnlUSD/openTrade.entry)*100 };
      }
      if (result) { trades.push(result); openTrade = null; }
    }
    if (openTrade) continue;

    if (!fast[i] || !slow[i] || !volMA[i] || !atr[i]) continue;
    if (allCandles[i].volume < volMA[i] * volMultiplier) continue;

    const crossUp   = fast[i-1] <= slow[i-1] && fast[i] > slow[i];
    const crossDown = fast[i-1] >= slow[i-1] && fast[i] < slow[i];
    if (!crossUp && !crossDown) continue;

    const side   = crossUp ? "buy" : "sell";
    const price  = bar.close;
    const dist   = atr[i] * atrMult;
    const stop   = side === "buy" ? price - dist : price + dist;
    const target = side === "buy" ? price + dist * rrRatio : price - dist * rrRatio;
    if (side === "buy" && price >= target) continue;
    if (side === "sell" && price <= target) continue;

    let optInfo = {};
    if (mode === "options") {
      const optionType   = side === "buy" ? "call" : "put";
      const optionStrike = atmStrike(price, strikeInterval);
      const entryPremium = optionPremium(price, optionStrike, dteDays, iv, optionType);
      optInfo = { optionType, optionStrike, entryPremium, optionDTE: dteDays };
    }
    openTrade = { side, entry: price, stop, target, entryTime: bar.time, ...optInfo };
  }
  return trades;
}

// ─── Mean Reversion Backtest ──────────────────────────────────────────────────

function runMeanRevBacktest(allCandles, params = {}, opts = {}) {
  const { bbPeriod = 20, bbMult = 2.0, rsiPeriod = 14, rsiOversold = 35, rsiOverbought = 65, atrPeriod = 14, maxHoldBars = 15 } = { ...meanrevMeta.params, ...params };
  const { mode = "stock", iv = 0.18, dteDays = 7, numContracts = 1, strikeInterval = 1 } = opts;

  const closes = allCandles.map(c => c.close);
  const bb     = bbArray(closes, bbPeriod, bbMult);
  const rsi    = rsiArray(closes, rsiPeriod);
  const atr    = atrArray(allCandles, atrPeriod);
  const trades = [];
  let openTrade = null;
  let barsHeld  = 0;

  for (let i = bbPeriod + rsiPeriod; i < allCandles.length; i++) {
    const bar   = allCandles[i];
    const price = bar.close;

    if (openTrade) {
      barsHeld++;
      let result = dailyExit(openTrade, bar, mode, iv, numContracts);
      if (!result && barsHeld >= maxHoldBars) {
        const pnlUSD = openTrade.side === "buy" ? price - openTrade.entry : openTrade.entry - price;
        const risk   = Math.abs(openTrade.entry - openTrade.stop);
        const date   = new Date(bar.time).toISOString().slice(0, 10);
        result = { date, entryTime: openTrade.entryTime, exitTime: bar.time, side: openTrade.side, entry: openTrade.entry, stop: openTrade.stop, target: openTrade.target, exit: price, exitReason: "timeout", pnlR: risk > 0 ? pnlUSD/risk : 0, pnlPct: (pnlUSD/openTrade.entry)*100 };
      }
      if (result) { trades.push(result); openTrade = null; barsHeld = 0; }
    }
    if (openTrade) continue;

    const b = bb[i], r = rsi[i], a = atr[i];
    if (!b || r == null || !a) continue;

    const longSig  = price < b.lower && r < rsiOversold;
    const shortSig = price > b.upper && r > rsiOverbought;
    if (!longSig && !shortSig) continue;

    const side   = longSig ? "buy" : "sell";
    const stop   = side === "buy" ? b.lower - a : b.upper + a;
    const target = b.middle;
    if (side === "buy" && price >= target) continue;
    if (side === "sell" && price <= target) continue;

    let optInfo = {};
    if (mode === "options") {
      const optionType   = side === "buy" ? "call" : "put";
      const optionStrike = atmStrike(price, strikeInterval);
      const entryPremium = optionPremium(price, optionStrike, dteDays, iv, optionType);
      optInfo = { optionType, optionStrike, entryPremium, optionDTE: dteDays };
    }
    openTrade = { side, entry: price, stop, target, entryTime: bar.time, ...optInfo };
    barsHeld  = 0;
  }
  return trades;
}

// ─── Momentum Backtest ────────────────────────────────────────────────────────

function runMomentumBacktest(allCandles, params = {}, opts = {}) {
  const { macdFast = 12, macdSlow = 26, macdSig = 9, rsiPeriod = 14, atrPeriod = 14, atrMult = 2.0, rrRatio = 2.0 } = { ...momentumMeta.params, ...params };
  const { mode = "stock", iv = 0.18, dteDays = 7, numContracts = 1, strikeInterval = 1 } = opts;

  const closes = allCandles.map(c => c.close);
  const { hist } = macdFull(closes, macdFast, macdSlow, macdSig);
  const rsi    = rsiArray(closes, rsiPeriod);
  const atr    = atrArray(allCandles, atrPeriod);
  const trades = [];
  let openTrade = null;
  const warmup  = macdSlow + macdSig + 5;

  for (let i = warmup; i < allCandles.length; i++) {
    const bar   = allCandles[i];
    const price = bar.close;

    if (openTrade) {
      const macdFlipExit = (openTrade.side === "buy"  && hist[i] !== null && hist[i] < 0 && hist[i-1] !== null && hist[i-1] >= 0) ||
                           (openTrade.side === "sell" && hist[i] !== null && hist[i] > 0 && hist[i-1] !== null && hist[i-1] <= 0);
      let result = dailyExit(openTrade, bar, mode, iv, numContracts);
      if (!result && macdFlipExit) {
        const pnlUSD = openTrade.side === "buy" ? price - openTrade.entry : openTrade.entry - price;
        const risk   = Math.abs(openTrade.entry - openTrade.stop);
        const date   = new Date(bar.time).toISOString().slice(0, 10);
        result = { date, entryTime: openTrade.entryTime, exitTime: bar.time, side: openTrade.side, entry: openTrade.entry, stop: openTrade.stop, target: openTrade.target, exit: price, exitReason: "macd-flip", pnlR: risk > 0 ? pnlUSD/risk : 0, pnlPct: (pnlUSD/openTrade.entry)*100 };
      }
      if (result) { trades.push(result); openTrade = null; }
    }
    if (openTrade) continue;

    const h = hist[i], hp = hist[i-1], r = rsi[i], a = atr[i];
    if (h === null || hp === null || r === null || !a) continue;

    const crossUp   = hp <= 0 && h > 0 && r > 50;
    const crossDown = hp >= 0 && h < 0 && r < 50;
    if (!crossUp && !crossDown) continue;

    const side   = crossUp ? "buy" : "sell";
    const dist   = a * atrMult;
    const stop   = side === "buy" ? price - dist : price + dist;
    const target = side === "buy" ? price + dist * rrRatio : price - dist * rrRatio;
    if (side === "buy" && price >= target) continue;
    if (side === "sell" && price <= target) continue;

    let optInfo = {};
    if (mode === "options") {
      const optionType   = side === "buy" ? "call" : "put";
      const optionStrike = atmStrike(price, strikeInterval);
      const entryPremium = optionPremium(price, optionStrike, dteDays, iv, optionType);
      optInfo = { optionType, optionStrike, entryPremium, optionDTE: dteDays };
    }
    openTrade = { side, entry: price, stop, target, entryTime: bar.time, ...optInfo };
  }
  return trades;
}

// ─── Reversal Backtest — RSI divergence + ATR trailing stop ──────────────────

function runReversalBacktest(allCandles, params = {}, opts = {}) {
  const {
    rsiPeriod     = 14,
    atrPeriod     = 14,
    atrMult       = 1.5,
    trailMult     = 1.0,
    rrRatio       = 2.0,
    swingLookback = 10,
    breakEvenR    = 1.0,
    confirmCandle = true,
  } = { ...reversalMeta.params, ...params };
  const { mode = "stock", iv = 0.18, dteDays = 7, numContracts = 1, strikeInterval = 1 } = opts;

  const closes = allCandles.map(c => c.close);
  const rsi    = rsiArray(closes, rsiPeriod);
  const atr    = atrArray(allCandles, atrPeriod);
  const trades = [];
  let openTrade = null;

  const warmup = Math.max(rsiPeriod, atrPeriod, swingLookback) + 2;

  for (let i = warmup; i < allCandles.length; i++) {
    const bar   = allCandles[i];
    const price = bar.close;

    // ── Exit management with dynamic trailing stop ───────────────────────────
    if (openTrade) {
      const { side, entry, target, atrAtEntry } = openTrade;
      const a = atr[i] || atrAtEntry;
      const trailDist = a * trailMult;
      const initRisk  = Math.abs(entry - openTrade.initialStop);

      // Move stop in the direction of profit
      if (side === "buy") {
        const newStop = price - trailDist;
        if (newStop > openTrade.stop) openTrade.stop = newStop;
        // After breakEvenR profit, never let stop fall below entry
        const rProfit = (price - entry) / initRisk;
        if (rProfit >= breakEvenR && openTrade.stop < entry) openTrade.stop = entry;
      } else {
        const newStop = price + trailDist;
        if (newStop < openTrade.stop) openTrade.stop = newStop;
        const rProfit = (entry - price) / initRisk;
        if (rProfit >= breakEvenR && openTrade.stop > entry) openTrade.stop = entry;
      }

      let exitPrice = null, exitReason = null;
      if (side === "buy") {
        if (bar.low  <= openTrade.stop) { exitPrice = openTrade.stop; exitReason = "trail-stop"; }
        else if (bar.high >= target)    { exitPrice = target;         exitReason = "target"; }
        else {
          const nt = nearTargetTrigger(side, entry, target, bar);
          if (nt != null) { exitPrice = nt; exitReason = "near-target"; }
        }
      } else {
        if (bar.high >= openTrade.stop) { exitPrice = openTrade.stop; exitReason = "trail-stop"; }
        else if (bar.low  <= target)    { exitPrice = target;         exitReason = "target"; }
        else {
          const nt = nearTargetTrigger(side, entry, target, bar);
          if (nt != null) { exitPrice = nt; exitReason = "near-target"; }
        }
      }

      if (exitPrice) {
        const pnlUSD = side === "buy" ? exitPrice - entry : entry - exitPrice;
        const pnlR   = initRisk > 0 ? pnlUSD / initRisk : 0;
        const date   = new Date(bar.time).toISOString().slice(0, 10);

        let optResult = {};
        if (mode === "options" && openTrade.entryPremium != null) {
          const elapsed     = (bar.time - openTrade.entryTime) / 86400000;
          const exitPremium = optionPremium(exitPrice, openTrade.optionStrike, Math.max(openTrade.entryDTE - elapsed, 0.01), iv, openTrade.optionType);
          const optPnL      = (exitPremium - openTrade.entryPremium) * 100 * numContracts;
          optResult = { optionType: openTrade.optionType, optionStrike: openTrade.optionStrike, entryPremium: openTrade.entryPremium, exitPremium, optionsPnL: optPnL, optionsPnLPct: openTrade.entryPremium > 0 ? ((exitPremium - openTrade.entryPremium) / openTrade.entryPremium) * 100 : 0, optionDTE: openTrade.entryDTE };
        }

        trades.push({
          date, entryTime: openTrade.entryTime, exitTime: bar.time,
          side, entry, stop: openTrade.initialStop, trailStop: openTrade.stop, target, exit: exitPrice, exitReason,
          pnlR, pnlPct: (pnlUSD / entry) * 100,
          stopSource: "atr-trail",
          ...optResult,
        });
        openTrade = null;
      }
      if (openTrade) continue;
    }

    if (openTrade) continue;
    if (!rsi[i] || !atr[i]) continue;

    // ── Entry: detect RSI divergence vs prior swing ──────────────────────────
    const lb       = swingLookback;
    const window   = allCandles.slice(i - lb, i + 1);
    const rsiWin   = rsi.slice(i - lb, i + 1);
    if (window.length < lb || rsiWin.some(v => v == null)) continue;

    // Lowest low and highest high in the lookback window (excluding the current bar)
    let lowIdx = 0, highIdx = 0;
    for (let k = 1; k < window.length - 1; k++) {
      if (window[k].low  < window[lowIdx].low)   lowIdx  = k;
      if (window[k].high > window[highIdx].high) highIdx = k;
    }

    const curLow  = window[window.length - 1].low;
    const curHigh = window[window.length - 1].high;
    const curRsi  = rsiWin[rsiWin.length - 1];

    // Bullish divergence: current bar made a lower low BUT RSI higher than the prior swing low's RSI
    const bullishDiv = curLow < window[lowIdx].low && curRsi > rsiWin[lowIdx] && curRsi < 50;
    // Bearish divergence: current bar made a higher high BUT RSI lower than the prior swing high's RSI
    const bearishDiv = curHigh > window[highIdx].high && curRsi < rsiWin[highIdx] && curRsi > 50;

    const prevClose = allCandles[i - 1].close;
    const confirmL  = !confirmCandle || price > prevClose;
    const confirmS  = !confirmCandle || price < prevClose;

    if (bullishDiv && confirmL) {
      const initRisk    = atr[i] * atrMult;
      const initialStop = price - initRisk;
      const target      = price + initRisk * rrRatio;

      let optInfo = {};
      if (mode === "options") {
        const optionStrike = atmStrike(price, strikeInterval);
        const entryPremium = optionPremium(price, optionStrike, dteDays, iv, "call");
        optInfo = { optionType: "call", optionStrike, entryPremium, entryDTE: dteDays };
      }

      openTrade = { side: "buy", entry: price, initialStop, stop: initialStop, target, entryTime: bar.time, atrAtEntry: atr[i], ...optInfo };
      continue;
    }

    if (bearishDiv && confirmS) {
      const initRisk    = atr[i] * atrMult;
      const initialStop = price + initRisk;
      const target      = price - initRisk * rrRatio;

      let optInfo = {};
      if (mode === "options") {
        const optionStrike = atmStrike(price, strikeInterval);
        const entryPremium = optionPremium(price, optionStrike, dteDays, iv, "put");
        optInfo = { optionType: "put", optionStrike, entryPremium, entryDTE: dteDays };
      }

      openTrade = { side: "sell", entry: price, initialStop, stop: initialStop, target, entryTime: bar.time, atrAtEntry: atr[i], ...optInfo };
    }
  }
  return trades;
}

// ─── Hybrid Backtest — ORB + VWAP + EMA triple confirmation ──────────────────

function runHybridBacktest(allCandles, params = {}, opts = {}) {
  const {
    orbMinutes        = 15,
    rrRatio           = 2.0,
    volMultiplier     = 1.3,
    maxRangePct       = 1.0,
    emaPeriod         = 9,
    emaSlowPeriod     = 21,
    holdOvernight     = false,
    minOvernightR     = 0.5,
    closeRangePct     = 25,
    overnightStopMult = 1.5,
    atrPeriod         = 14,
  } = { ...hybridMeta.params, ...params };
  const { mode = "stock", iv = 0.18, dteDays = 7, numContracts = 1, strikeInterval = 1, forceDaily = false } = opts;
  const atrArr = holdOvernight ? atrArray(allCandles, atrPeriod) : null;

  // Pre-compute EMAs across all candles (warm up with full history for accuracy)
  const closes       = allCandles.map(c => c.close);
  const ema9arr      = emaFull(closes, emaPeriod);
  const ema21arr     = emaFull(closes, emaSlowPeriod);
  const timeToIdx    = new Map(allCandles.map((c, i) => [c.time, i]));

  const sessions = groupByDay(allCandles);
  const trades   = [];
  // Position persists across sessions when holdOvernight is true and the
  // EOD gap-continuation setup triggers.
  let openTrade = null;

  // Helper: does the day's close justify holding overnight?
  const shouldHoldOvernight = (trade, sessBars) => {
    if (!holdOvernight || !trade) return false;
    const last = sessBars[sessBars.length - 1];
    const dayHigh = Math.max(...sessBars.map(b => b.high));
    const dayLow  = Math.min(...sessBars.map(b => b.low));
    const range   = dayHigh - dayLow;
    if (range <= 0) return false;
    const risk    = Math.abs(trade.entry - trade.initialStop || trade.entry - trade.stop);
    const pnlUSD  = trade.side === "buy" ? last.close - trade.entry : trade.entry - last.close;
    const rProfit = risk > 0 ? pnlUSD / risk : 0;
    if (rProfit < minOvernightR) return false;
    const cutoff = (closeRangePct / 100) * range;
    if (trade.side === "buy"  && last.close >= dayHigh - cutoff) return true;
    if (trade.side === "sell" && last.close <= dayLow  + cutoff) return true;
    return false;
  };

  for (const { date, candles } of sessions) {
    const open    = nyseOpenMs(candles[0].time);
    const orbEnd  = open + orbMinutes * 60_000;
    const sessEnd = open + 6.25 * 3600_000;

    const sessCandles = candles.filter(c => c.time >= open && c.time < open + 7 * 3600_000);
    if (sessCandles.length < 4) continue;

    // ── Carried-over trade: just manage exits this session, no new entries ──
    if (openTrade) {
      for (const bar of sessCandles) {
        const { side, target } = openTrade;
        let exitPrice = null, exitReason = null;
        if (side === "buy") {
          if (bar.low  <= openTrade.stop) { exitPrice = openTrade.stop; exitReason = "overnight-stop"; }
          else if (bar.high >= target)    { exitPrice = target;         exitReason = "target"; }
        } else {
          if (bar.high >= openTrade.stop) { exitPrice = openTrade.stop; exitReason = "overnight-stop"; }
          else if (bar.low  <= target)    { exitPrice = target;         exitReason = "target"; }
        }
        // After 11 AM ET on the next session, if still open, close it.
        const elapsedMin = (bar.time - open) / 60_000;
        if (!exitPrice && elapsedMin >= 90) { exitPrice = bar.close; exitReason = "next-session-close"; }
        if (exitPrice) {
          const risk   = Math.abs(openTrade.entry - (openTrade.initialStop || openTrade.stop));
          const pnlUSD = side === "buy" ? exitPrice - openTrade.entry : openTrade.entry - exitPrice;
          trades.push({
            date, entryTime: openTrade.entryTime, exitTime: bar.time,
            side, entry: openTrade.entry, stop: openTrade.stop, target,
            exit: exitPrice, exitReason,
            pnlR: risk > 0 ? pnlUSD / risk : 0, pnlPct: (pnlUSD / openTrade.entry) * 100,
            stopSource: openTrade.stopSource || "overnight",
            heldOvernight: true,
          });
          openTrade = null;
          break;
        }
      }
      // If still holding after this session, continue rolling; skip new entries.
      if (openTrade) continue;
    }

    const orbCandles = sessCandles.filter(c => c.time < orbEnd);
    if (orbCandles.length === 0) continue;

    const orb = calcRange(orbCandles);
    if (!orb) continue;

    const mid = (orb.orbHigh + orb.orbLow) / 2;
    if ((orb.orbRange / mid) * 100 >= maxRangePct) continue;

    const postOrb      = sessCandles.filter(c => c.time >= orbEnd);
    let tradeEntered   = false;

    for (let i = 0; i < postOrb.length; i++) {
      const bar = postOrb[i];

      // ── Exit management ──────────────────────────────────────────────────
      if (openTrade) {
        const { side, entry, stop, target, entryTime } = openTrade;
        let exitPrice = null, exitReason = null;

        if (side === "buy") {
          if (bar.low  <= stop)   { exitPrice = stop;   exitReason = "stop";   }
          if (bar.high >= target) { exitPrice = target; exitReason = "target"; }
          if (!exitPrice) {
            const nt = nearTargetTrigger(side, entry, target, bar);
            if (nt != null) { exitPrice = nt; exitReason = "near-target"; }
          }
        } else {
          if (bar.high >= stop)   { exitPrice = stop;   exitReason = "stop";   }
          if (bar.low  <= target) { exitPrice = target; exitReason = "target"; }
          if (!exitPrice) {
            const nt = nearTargetTrigger(side, entry, target, bar);
            if (nt != null) { exitPrice = nt; exitReason = "near-target"; }
          }
        }
        // EOD: only force-close if NOT holding overnight or conditions aren't met.
        if (!exitPrice && bar.time >= sessEnd) {
          if (holdOvernight && shouldHoldOvernight({ ...openTrade, initialStop: openTrade.initialStop || openTrade.stop }, sessCandles)) {
            // Widen the stop for overnight; carry the position to next session.
            const idxBar = timeToIdx.get(bar.time);
            const a      = atrArr && idxBar != null ? atrArr[idxBar] : null;
            if (a) {
              if (side === "buy")  openTrade.stop = Math.min(openTrade.stop, bar.close - a * overnightStopMult);
              else                 openTrade.stop = Math.max(openTrade.stop, bar.close + a * overnightStopMult);
            }
            openTrade.heldOvernight = true;
            break; // exit the inner bar loop; carry to next session
          }
          exitPrice = bar.close; exitReason = "time";
        }

        if (exitPrice) {
          const risk   = Math.abs(entry - stop);
          const pnlUSD = side === "buy" ? exitPrice - entry : entry - exitPrice;
          const pnlR   = risk > 0 ? pnlUSD / risk : 0;

          let optResult = {};
          if (mode === "options" && openTrade.entryPremium != null) {
            const elapsed    = (bar.time - entryTime) / 86_400_000;
            const exitPremium = optionPremium(exitPrice, openTrade.optionStrike, Math.max(openTrade.entryDTE - elapsed, 0.01), iv, openTrade.optionType);
            const optPnL     = (exitPremium - openTrade.entryPremium) * 100 * numContracts;
            optResult = { optionType: openTrade.optionType, optionStrike: openTrade.optionStrike, entryPremium: openTrade.entryPremium, exitPremium, optionsPnL: optPnL, optionsPnLPct: openTrade.entryPremium > 0 ? ((exitPremium - openTrade.entryPremium) / openTrade.entryPremium) * 100 : 0, optionDTE: openTrade.entryDTE };
          }

          trades.push({ date, entryTime, exitTime: bar.time, side, entry, stop, target, exit: exitPrice, exitReason, pnlR, pnlPct: (pnlUSD / entry) * 100, stopSource: openTrade.stopSource || "orb-fallback", orderBlock: openTrade.orderBlock || null, ...optResult });
          openTrade = null;
        }
        continue;
      }

      if (tradeEntered) continue;

      // ── Entry signal: ORB + VWAP + EMA + volume ──────────────────────────
      const idx = timeToIdx.get(bar.time);
      if (idx === undefined) continue;

      const fastEMA = ema9arr[idx];
      const slowEMA = ema21arr[idx];
      if (!fastEMA || !slowEMA) continue;

      // Session VWAP (cumulative from open to this bar)
      const vwap = sessionVWAP([...orbCandles, ...postOrb.slice(0, i + 1)]);
      if (!vwap) continue;

      // Volume MA (20-bar look-back across all candles)
      const startIdx = Math.max(0, idx - 20);
      const volSlice = allCandles.slice(startIdx, idx);
      const volMA    = volSlice.length > 0 ? volSlice.reduce((s, b) => s + b.volume, 0) / volSlice.length : 0;
      const volOK    = volMA > 0 && bar.volume >= volMA * volMultiplier;

      const price = bar.close;

      // Recent bars for order-block lookback (this session + a bit before)
      const recentBars = allCandles.slice(Math.max(0, idx - 30), idx + 1);

      // LONG: breakout above ORB high + above VWAP + EMA bullish + volume
      if (price > orb.orbHigh && price > vwap && fastEMA > slowEMA && volOK) {
        const { stop, source, ob } = pickStop("buy", price, recentBars, orb.orbHigh, orb.orbLow);
        const target = orb.orbHigh + orb.orbRange * rrRatio;
        if (price >= target) continue;

        let optInfo = {};
        if (mode === "options") {
          const optionStrike = atmStrike(price, strikeInterval);
          const entryPremium = optionPremium(price, optionStrike, dteDays, iv, "call");
          optInfo = { optionType: "call", optionStrike, entryPremium, entryDTE: dteDays };
        }

        openTrade   = { side: "buy",  entry: price, stop, target, entryTime: bar.time, stopSource: source, orderBlock: ob, ...optInfo };
        tradeEntered = true;
        continue;
      }

      // SHORT: breakdown below ORB low + below VWAP + EMA bearish + volume
      if (price < orb.orbLow && price < vwap && fastEMA < slowEMA && volOK) {
        const { stop, source, ob } = pickStop("sell", price, recentBars, orb.orbHigh, orb.orbLow);
        const target = orb.orbLow - orb.orbRange * rrRatio;
        if (price <= target) continue;

        let optInfo = {};
        if (mode === "options") {
          const optionStrike = atmStrike(price, strikeInterval);
          const entryPremium = optionPremium(price, optionStrike, dteDays, iv, "put");
          optInfo = { optionType: "put", optionStrike, entryPremium, entryDTE: dteDays };
        }

        openTrade   = { side: "sell", entry: price, stop, target, entryTime: bar.time, stopSource: source, orderBlock: ob, ...optInfo };
        tradeEntered = true;
      }
    }

    // ── Force-daily fallback ─────────────────────────────────────────────
    // If no triple-confirmation trade fired and forceDaily=true, enter at the
    // first post-ORB bar's close in the direction of the break vs ORB midpoint
    // (or VWAP if available). Stop/target follow the standard ORB geometry.
    if (forceDaily && !tradeEntered && postOrb.length > 0) {
      const firstBar = postOrb[0];
      const refVwap  = sessionVWAP([...orbCandles, firstBar]) ?? ((orb.orbHigh + orb.orbLow) / 2);
      const price    = firstBar.close;
      const side     = price >= refVwap ? "buy" : "sell";
      const idxFB    = timeToIdx.get(firstBar.time);
      const recent   = idxFB != null ? allCandles.slice(Math.max(0, idxFB - 30), idxFB + 1) : [...orbCandles, firstBar];
      const { stop, source: stopSource, ob } = pickStop(side, price, recent, orb.orbHigh, orb.orbLow);
      const target   = side === "buy"
        ? orb.orbHigh + orb.orbRange * rrRatio
        : orb.orbLow  - orb.orbRange * rrRatio;

      let optInfo = {};
      if (mode === "options") {
        const optionType   = side === "buy" ? "call" : "put";
        const optionStrike = atmStrike(price, strikeInterval);
        const entryPremium = optionPremium(price, optionStrike, dteDays, iv, optionType);
        optInfo = { optionType, optionStrike, entryPremium, entryDTE: dteDays };
      }
      openTrade    = { side, entry: price, stop, target, entryTime: firstBar.time, forced: true, stopSource, orderBlock: ob, ...optInfo };
      tradeEntered = true;

      // Walk remaining bars to find stop/target/session-end exit
      for (let j = 1; j < postOrb.length && openTrade; j++) {
        const bar = postOrb[j];
        let exitPrice = null, exitReason = null;
        if (side === "buy") {
          if (bar.low  <= stop)   { exitPrice = stop;   exitReason = "stop";   }
          if (bar.high >= target) { exitPrice = target; exitReason = "target"; }
          if (!exitPrice) {
            const nt = nearTargetTrigger(side, price, target, bar);
            if (nt != null) { exitPrice = nt; exitReason = "near-target"; }
          }
        } else {
          if (bar.high >= stop)   { exitPrice = stop;   exitReason = "stop";   }
          if (bar.low  <= target) { exitPrice = target; exitReason = "target"; }
          if (!exitPrice) {
            const nt = nearTargetTrigger(side, price, target, bar);
            if (nt != null) { exitPrice = nt; exitReason = "near-target"; }
          }
        }
        if (!exitPrice && bar.time >= sessEnd) { exitPrice = bar.close; exitReason = "time"; }
        if (exitPrice) {
          const risk   = Math.abs(price - stop);
          const pnlUSD = side === "buy" ? exitPrice - price : price - exitPrice;
          let optResult = {};
          if (mode === "options" && openTrade.entryPremium != null) {
            const elapsed     = (bar.time - openTrade.entryTime) / 86_400_000;
            const exitPremium = optionPremium(exitPrice, openTrade.optionStrike, Math.max(openTrade.entryDTE - elapsed, 0.01), iv, openTrade.optionType);
            const optPnL      = (exitPremium - openTrade.entryPremium) * 100 * numContracts;
            optResult = { optionType: openTrade.optionType, optionStrike: openTrade.optionStrike, entryPremium: openTrade.entryPremium, exitPremium, optionsPnL: optPnL, optionsPnLPct: openTrade.entryPremium > 0 ? ((exitPremium - openTrade.entryPremium) / openTrade.entryPremium) * 100 : 0, optionDTE: openTrade.entryDTE };
          }
          trades.push({ date, entryTime: openTrade.entryTime, exitTime: bar.time, side, entry: price, stop, target, exit: exitPrice, exitReason, pnlR: risk > 0 ? pnlUSD / risk : 0, pnlPct: (pnlUSD / price) * 100, forced: true, stopSource: openTrade.stopSource || "orb-fallback", orderBlock: openTrade.orderBlock || null, ...optResult });
          openTrade = null;
        }
      }
    }

    // Close any position still open at session end — UNLESS overnight setup triggers.
    if (openTrade && postOrb.length > 0) {
      if (holdOvernight && shouldHoldOvernight({ ...openTrade, initialStop: openTrade.initialStop || openTrade.stop }, sessCandles)) {
        // Widen the stop for the gap and carry to next session.
        const last  = postOrb[postOrb.length - 1];
        const idxL  = timeToIdx.get(last.time);
        const a     = atrArr && idxL != null ? atrArr[idxL] : null;
        if (a) {
          if (openTrade.side === "buy") openTrade.stop = Math.min(openTrade.stop, last.close - a * overnightStopMult);
          else                          openTrade.stop = Math.max(openTrade.stop, last.close + a * overnightStopMult);
        }
        openTrade.heldOvernight = true;
        // Don't push — keep openTrade alive for next session
      } else {
        const last   = postOrb[postOrb.length - 1];
        const { side, entry, stop, entryTime } = openTrade;
        const pnlUSD = side === "buy" ? last.close - entry : entry - last.close;
        const risk   = Math.abs(entry - stop);

        let optResult = {};
        if (mode === "options" && openTrade.entryPremium != null) {
          const elapsed    = (last.time - entryTime) / 86_400_000;
          const exitPremium = optionPremium(last.close, openTrade.optionStrike, Math.max(openTrade.entryDTE - elapsed, 0.01), iv, openTrade.optionType);
          const optPnL     = (exitPremium - openTrade.entryPremium) * 100 * numContracts;
          optResult = { optionType: openTrade.optionType, optionStrike: openTrade.optionStrike, entryPremium: openTrade.entryPremium, exitPremium, optionsPnL: optPnL, optionsPnLPct: openTrade.entryPremium > 0 ? ((exitPremium - openTrade.entryPremium) / openTrade.entryPremium) * 100 : 0, optionDTE: openTrade.entryDTE };
        }

        trades.push({ date, entryTime, exitTime: last.time, side, entry, stop, target: openTrade.target, exit: last.close, exitReason: "time", pnlR: risk > 0 ? pnlUSD / risk : 0, pnlPct: (pnlUSD / entry) * 100, forced: openTrade.forced || false, stopSource: openTrade.stopSource || "orb-fallback", orderBlock: openTrade.orderBlock || null, ...optResult });
        openTrade = null;
      }
    }
  }

  return trades;
}

// ─── Hybrid + Reversal combo — two entry paths under one ATR trailing stop ───

function runHybridReversalBacktest(allCandles, params = {}, opts = {}) {
  const {
    orbMinutes    = 15,
    rrRatio       = 2.0,
    volMultiplier = 1.3,
    maxRangePct   = 1.0,
    emaPeriod     = 9,
    emaSlowPeriod = 21,
    rsiPeriod     = 14,
    atrPeriod     = 14,
    atrMult       = 1.5,
    trailMult     = 1.0,
    swingLookback = 10,
    breakEvenR    = 1.0,
  } = { ...hybridReversalMeta.params, ...params };
  const { mode = "stock", iv = 0.18, dteDays = 7, numContracts = 1, strikeInterval = 1 } = opts;

  const closes  = allCandles.map(c => c.close);
  const ema9arr = emaFull(closes, emaPeriod);
  const ema21arr = emaFull(closes, emaSlowPeriod);
  const rsi     = rsiArray(closes, rsiPeriod);
  const atr     = atrArray(allCandles, atrPeriod);
  const timeToIdx = new Map(allCandles.map((c, i) => [c.time, i]));

  const sessions = groupByDay(allCandles);
  const trades   = [];

  for (const { date, candles } of sessions) {
    const open    = nyseOpenMs(candles[0].time);
    const orbEnd  = open + orbMinutes * 60_000;
    const sessEnd = open + 6.25 * 3600_000;
    const sessCandles = candles.filter(c => c.time >= open && c.time < open + 7 * 3600_000);
    if (sessCandles.length < 4) continue;
    const orbCandles = sessCandles.filter(c => c.time < orbEnd);
    if (orbCandles.length === 0) continue;
    const orb = calcRange(orbCandles);
    if (!orb) continue;
    const mid = (orb.orbHigh + orb.orbLow) / 2;
    if ((orb.orbRange / mid) * 100 >= maxRangePct) continue;
    const postOrb = sessCandles.filter(c => c.time >= orbEnd);

    let openTrade = null, tradeEntered = false;

    for (let i = 0; i < postOrb.length; i++) {
      const bar = postOrb[i];
      const idx = timeToIdx.get(bar.time);
      if (idx === undefined) continue;

      // ── Trailing-stop exit management ────────────────────────────────────
      if (openTrade) {
        const a = atr[idx] || openTrade.atrAtEntry;
        const trail = a * trailMult;
        const initRisk = Math.abs(openTrade.entry - openTrade.initialStop);
        if (openTrade.side === "buy") {
          const newStop = bar.close - trail;
          if (newStop > openTrade.stop) openTrade.stop = newStop;
          const rProfit = (bar.close - openTrade.entry) / initRisk;
          if (rProfit >= breakEvenR && openTrade.stop < openTrade.entry) openTrade.stop = openTrade.entry;
        } else {
          const newStop = bar.close + trail;
          if (newStop < openTrade.stop) openTrade.stop = newStop;
          const rProfit = (openTrade.entry - bar.close) / initRisk;
          if (rProfit >= breakEvenR && openTrade.stop > openTrade.entry) openTrade.stop = openTrade.entry;
        }
        let exitPrice = null, exitReason = null;
        if (openTrade.side === "buy") {
          if (bar.low  <= openTrade.stop) { exitPrice = openTrade.stop; exitReason = "trail-stop"; }
          else if (bar.high >= openTrade.target) { exitPrice = openTrade.target; exitReason = "target"; }
          else {
            const nt = nearTargetTrigger(openTrade.side, openTrade.entry, openTrade.target, bar);
            if (nt != null) { exitPrice = nt; exitReason = "near-target"; }
          }
        } else {
          if (bar.high >= openTrade.stop) { exitPrice = openTrade.stop; exitReason = "trail-stop"; }
          else if (bar.low  <= openTrade.target) { exitPrice = openTrade.target; exitReason = "target"; }
          else {
            const nt = nearTargetTrigger(openTrade.side, openTrade.entry, openTrade.target, bar);
            if (nt != null) { exitPrice = nt; exitReason = "near-target"; }
          }
        }
        if (!exitPrice && bar.time >= sessEnd) { exitPrice = bar.close; exitReason = "time"; }
        if (exitPrice) {
          const pnlUSD = openTrade.side === "buy" ? exitPrice - openTrade.entry : openTrade.entry - exitPrice;
          const pnlR   = initRisk > 0 ? pnlUSD / initRisk : 0;
          let optResult = {};
          if (mode === "options" && openTrade.entryPremium != null) {
            const elapsed     = (bar.time - openTrade.entryTime) / 86_400_000;
            const exitPremium = optionPremium(exitPrice, openTrade.optionStrike, Math.max(openTrade.entryDTE - elapsed, 0.01), iv, openTrade.optionType);
            const optPnL      = (exitPremium - openTrade.entryPremium) * 100 * numContracts;
            optResult = { optionType: openTrade.optionType, optionStrike: openTrade.optionStrike, entryPremium: openTrade.entryPremium, exitPremium, optionsPnL: optPnL, optionsPnLPct: openTrade.entryPremium > 0 ? ((exitPremium - openTrade.entryPremium) / openTrade.entryPremium) * 100 : 0, optionDTE: openTrade.entryDTE };
          }
          trades.push({
            date, entryTime: openTrade.entryTime, exitTime: bar.time,
            side: openTrade.side, entry: openTrade.entry, stop: openTrade.initialStop, trailStop: openTrade.stop, target: openTrade.target,
            exit: exitPrice, exitReason, pnlR, pnlPct: (pnlUSD / openTrade.entry) * 100,
            stopSource: "atr-trail", entrySignal: openTrade.entrySignal, ...optResult,
          });
          openTrade = null;
        }
        continue;
      }
      if (tradeEntered) continue;

      const fastEMA = ema9arr[idx], slowEMA = ema21arr[idx];
      if (!fastEMA || !slowEMA || !rsi[idx] || !atr[idx]) continue;
      const vwap = sessionVWAP([...orbCandles, ...postOrb.slice(0, i + 1)]);
      if (!vwap) continue;
      const startIdx = Math.max(0, idx - 20);
      const volSlice = allCandles.slice(startIdx, idx);
      const volMA    = volSlice.length > 0 ? volSlice.reduce((s, b) => s + b.volume, 0) / volSlice.length : 0;
      const volOK    = volMA > 0 && bar.volume >= volMA * volMultiplier;
      const price    = bar.close;

      // ── PATH A: Hybrid triple-confirmation ───────────────────────────────
      let signal = null;
      if (price > orb.orbHigh && price > vwap && fastEMA > slowEMA && volOK)      signal = { side: "buy",  source: "hybrid-breakout" };
      else if (price < orb.orbLow && price < vwap && fastEMA < slowEMA && volOK) signal = { side: "sell", source: "hybrid-breakout" };

      // ── PATH B: Reversal divergence ──────────────────────────────────────
      if (!signal && idx > swingLookback) {
        const win    = allCandles.slice(idx - swingLookback, idx + 1);
        const rWin   = rsi.slice(idx - swingLookback, idx + 1);
        let lowIdx = 0, highIdx = 0;
        for (let k = 1; k < win.length - 1; k++) {
          if (win[k].low  < win[lowIdx].low)   lowIdx  = k;
          if (win[k].high > win[highIdx].high) highIdx = k;
        }
        const bullishDiv = bar.low  < win[lowIdx].low  && rsi[idx] > rWin[lowIdx]  && rsi[idx] < 50 && price > allCandles[idx - 1].close;
        const bearishDiv = bar.high > win[highIdx].high && rsi[idx] < rWin[highIdx] && rsi[idx] > 50 && price < allCandles[idx - 1].close;
        if (bullishDiv) signal = { side: "buy",  source: "reversal-div" };
        if (bearishDiv) signal = { side: "sell", source: "reversal-div" };
      }

      if (!signal) continue;

      // ATR-based initial stop + target
      const initRisk    = atr[idx] * atrMult;
      const initialStop = signal.side === "buy" ? price - initRisk : price + initRisk;
      const target      = signal.side === "buy" ? price + initRisk * rrRatio : price - initRisk * rrRatio;

      let optInfo = {};
      if (mode === "options") {
        const optionType   = signal.side === "buy" ? "call" : "put";
        const optionStrike = atmStrike(price, strikeInterval);
        const entryPremium = optionPremium(price, optionStrike, dteDays, iv, optionType);
        optInfo = { optionType, optionStrike, entryPremium, entryDTE: dteDays };
      }

      openTrade = { side: signal.side, entry: price, initialStop, stop: initialStop, target, entryTime: bar.time, atrAtEntry: atr[idx], entrySignal: signal.source, ...optInfo };
      tradeEntered = true;
    }
  }
  return trades;
}

// ─── Gap Fill Backtest ───────────────────────────────────────────────────────

function runGapFillBacktest(allCandles, params = {}, opts = {}) {
  const { minGapPct = 0.4, stopMult = 0.5, timeExitMin = 150 } = { ...gapFillMeta.params, ...params };
  const { mode = "stock", iv = 0.18, dteDays = 7, numContracts = 1, strikeInterval = 1 } = opts;

  const sessions = groupByDay(allCandles);
  const trades   = [];

  for (let d = 1; d < sessions.length; d++) {
    const today = sessions[d].candles;
    const prior = sessions[d - 1].candles;
    if (today.length < 4 || prior.length < 1) continue;

    const priorClose = prior[prior.length - 1].close;
    const todayOpen  = today[0].open;
    const gapPct     = ((todayOpen - priorClose) / priorClose) * 100;
    if (Math.abs(gapPct) < minGapPct) continue;

    const sessionStart = nyseOpenMs(today[0].time);
    const confirmStart = sessionStart + 5 * 60_000; // first bar after 9:35
    const sessExit     = sessionStart + timeExitMin * 60_000;

    // Find the first confirmation bar after 9:35 ET
    const postOpen = today.filter(c => c.time >= confirmStart);
    if (postOpen.length === 0) continue;

    // LONG fade of gap-down
    const isGapDown = gapPct < -minGapPct;
    const isGapUp   = gapPct >  minGapPct;
    let entryBar = null;
    let side     = null;
    for (const bar of postOpen) {
      if (isGapDown && bar.close > bar.open && bar.close < priorClose) { entryBar = bar; side = "buy";  break; }
      if (isGapUp   && bar.close < bar.open && bar.close > priorClose) { entryBar = bar; side = "sell"; break; }
    }
    if (!entryBar) continue;

    const entry      = entryBar.close;
    const gapAbs     = Math.abs(todayOpen - priorClose);
    const stop       = side === "buy" ? todayOpen - gapAbs * stopMult : todayOpen + gapAbs * stopMult;
    const target     = priorClose;
    if (side === "buy"  && entry >= target) continue;
    if (side === "sell" && entry <= target) continue;

    let optInfo = {};
    if (mode === "options") {
      const optionType   = side === "buy" ? "call" : "put";
      const optionStrike = atmStrike(entry, strikeInterval);
      const entryPremium = optionPremium(entry, optionStrike, dteDays, iv, optionType);
      optInfo = { optionType, optionStrike, entryPremium, entryDTE: dteDays };
    }

    const idx = today.indexOf(entryBar);
    let openTrade = { side, entry, stop, target, entryTime: entryBar.time, ...optInfo };
    let exitPrice = null, exitReason = null;
    for (let i = idx + 1; i < today.length && openTrade; i++) {
      const bar = today[i];
      if (side === "buy") {
        if (bar.low  <= stop)   { exitPrice = stop;   exitReason = "stop";   }
        if (bar.high >= target) { exitPrice = target; exitReason = "target"; }
      } else {
        if (bar.high >= stop)   { exitPrice = stop;   exitReason = "stop";   }
        if (bar.low  <= target) { exitPrice = target; exitReason = "target"; }
      }
      if (!exitPrice && bar.time >= sessExit) { exitPrice = bar.close; exitReason = "time"; }
      if (exitPrice) {
        const risk   = Math.abs(entry - stop);
        const pnlUSD = side === "buy" ? exitPrice - entry : entry - exitPrice;
        let optResult = {};
        if (mode === "options" && openTrade.entryPremium != null) {
          const elapsed     = (bar.time - openTrade.entryTime) / 86_400_000;
          const exitPremium = optionPremium(exitPrice, openTrade.optionStrike, Math.max(openTrade.entryDTE - elapsed, 0.01), iv, openTrade.optionType);
          const optPnL      = (exitPremium - openTrade.entryPremium) * 100 * numContracts;
          optResult = { optionType: openTrade.optionType, optionStrike: openTrade.optionStrike, entryPremium: openTrade.entryPremium, exitPremium, optionsPnL: optPnL, optionsPnLPct: openTrade.entryPremium > 0 ? ((exitPremium - openTrade.entryPremium) / openTrade.entryPremium) * 100 : 0, optionDTE: openTrade.entryDTE };
        }
        trades.push({ date: sessions[d].date, entryTime: entryBar.time, exitTime: bar.time, side, entry, stop, target, exit: exitPrice, exitReason, pnlR: risk > 0 ? pnlUSD/risk : 0, pnlPct: (pnlUSD/entry)*100, gapPct: +gapPct.toFixed(3), ...optResult });
        openTrade = null;
      }
    }
  }
  return trades;
}

// ─── VWAP Reclaim Backtest ───────────────────────────────────────────────────

function runVWAPReclaimBacktest(allCandles, params = {}, opts = {}) {
  const {
    minReclaimPct    = 0.05,
    volMultiplier    = 1.2,
    stopPct          = 0.4,
    rrRatio          = 1.5,
    minBarsAfterOpen = 6,
  } = { ...vwapReclaimMeta.params, ...params };
  const { mode = "stock", iv = 0.18, dteDays = 7, numContracts = 1, strikeInterval = 1 } = opts;

  const sessions = groupByDay(allCandles);
  const trades   = [];

  for (const { date, candles } of sessions) {
    if (candles.length < minBarsAfterOpen + 3) continue;
    const open = nyseOpenMs(candles[0].time);
    const sessEnd = open + 6.25 * 3600_000;
    const sess = candles.filter(c => c.time >= open && c.time < open + 7 * 3600_000);
    if (sess.length < minBarsAfterOpen + 3) continue;

    let openTrade = null;
    let prevPrice = null, prevVWAPside = null;

    for (let i = minBarsAfterOpen; i < sess.length; i++) {
      const bar = sess[i];
      const slice = sess.slice(0, i + 1);
      const vwap = sessionVWAP(slice);
      if (!vwap) continue;

      // Exit management
      if (openTrade) {
        let exitPrice = null, exitReason = null;
        if (openTrade.side === "buy") {
          if (bar.low  <= openTrade.stop)   { exitPrice = openTrade.stop;   exitReason = "stop";   }
          if (bar.high >= openTrade.target) { exitPrice = openTrade.target; exitReason = "target"; }
        } else {
          if (bar.high >= openTrade.stop)   { exitPrice = openTrade.stop;   exitReason = "stop";   }
          if (bar.low  <= openTrade.target) { exitPrice = openTrade.target; exitReason = "target"; }
        }
        if (!exitPrice && bar.time >= sessEnd) { exitPrice = bar.close; exitReason = "time"; }
        if (exitPrice) {
          const risk   = Math.abs(openTrade.entry - openTrade.stop);
          const pnlUSD = openTrade.side === "buy" ? exitPrice - openTrade.entry : openTrade.entry - exitPrice;
          let optResult = {};
          if (mode === "options" && openTrade.entryPremium != null) {
            const elapsed     = (bar.time - openTrade.entryTime) / 86_400_000;
            const exitPremium = optionPremium(exitPrice, openTrade.optionStrike, Math.max(openTrade.entryDTE - elapsed, 0.01), iv, openTrade.optionType);
            const optPnL      = (exitPremium - openTrade.entryPremium) * 100 * numContracts;
            optResult = { optionType: openTrade.optionType, optionStrike: openTrade.optionStrike, entryPremium: openTrade.entryPremium, exitPremium, optionsPnL: optPnL, optionsPnLPct: openTrade.entryPremium > 0 ? ((exitPremium - openTrade.entryPremium) / openTrade.entryPremium) * 100 : 0, optionDTE: openTrade.entryDTE };
          }
          trades.push({ date, entryTime: openTrade.entryTime, exitTime: bar.time, side: openTrade.side, entry: openTrade.entry, stop: openTrade.stop, target: openTrade.target, exit: exitPrice, exitReason, pnlR: risk > 0 ? pnlUSD/risk : 0, pnlPct: (pnlUSD/openTrade.entry)*100, ...optResult });
          openTrade = null;
        }
        continue;
      }

      // Track prior bar's side of VWAP
      const curSide = bar.close > vwap ? "above" : "below";

      // Volume check
      const lookback = sess.slice(Math.max(0, i - 20), i);
      const volAvg = lookback.length ? lookback.reduce((s, b) => s + b.volume, 0) / lookback.length : 0;
      const volOK  = volAvg > 0 && bar.volume >= volAvg * volMultiplier;

      // Reclaim: prior bar low dipped below VWAP, current bar closes above VWAP
      const reclaimLong  = prevVWAPside === "below" && curSide === "above" &&
                           bar.low <= vwap && ((bar.close - vwap) / vwap) * 100 >= minReclaimPct && volOK;
      const reclaimShort = prevVWAPside === "above" && curSide === "below" &&
                           bar.high >= vwap && ((vwap - bar.close) / vwap) * 100 >= minReclaimPct && volOK;

      prevVWAPside = curSide;
      prevPrice = bar.close;

      if (!reclaimLong && !reclaimShort) continue;

      const side  = reclaimLong ? "buy" : "sell";
      const entry = bar.close;
      const stop  = side === "buy" ? entry - entry * (stopPct / 100) : entry + entry * (stopPct / 100);
      const vwapDist = Math.abs(entry - vwap);
      const target = side === "buy" ? entry + vwapDist * rrRatio : entry - vwapDist * rrRatio;
      if (side === "buy" && entry >= target) continue;
      if (side === "sell" && entry <= target) continue;

      let optInfo = {};
      if (mode === "options") {
        const optionType   = side === "buy" ? "call" : "put";
        const optionStrike = atmStrike(entry, strikeInterval);
        const entryPremium = optionPremium(entry, optionStrike, dteDays, iv, optionType);
        optInfo = { optionType, optionStrike, entryPremium, entryDTE: dteDays };
      }
      openTrade = { side, entry, stop, target, entryTime: bar.time, ...optInfo };
    }
  }
  return trades;
}

// ─── First-Hour Fade Backtest ────────────────────────────────────────────────

function runFirstHourFadeBacktest(allCandles, params = {}, opts = {}) {
  const {
    minFirstHourPct = 0.6,
    exhaustionTop   = 25,
    retracePct      = 50,
    timeExitMin     = 240,
  } = { ...firstHourFadeMeta.params, ...params };
  const { mode = "stock", iv = 0.18, dteDays = 7, numContracts = 1, strikeInterval = 1 } = opts;

  const sessions = groupByDay(allCandles);
  const trades   = [];

  for (const { date, candles } of sessions) {
    const open      = nyseOpenMs(candles[0].time);
    const hourOneEnd = open + 60 * 60_000;
    const sessExit  = open + timeExitMin * 60_000;
    const sessEnd   = open + 6.25 * 3600_000;

    const sess = candles.filter(c => c.time >= open && c.time < open + 7 * 3600_000);
    const h1   = sess.filter(c => c.time >= open && c.time < hourOneEnd);
    if (h1.length < 4) continue;

    const h1Open  = h1[0].open;
    const h1Close = h1[h1.length - 1].close;
    const h1High  = Math.max(...h1.map(b => b.high));
    const h1Low   = Math.min(...h1.map(b => b.low));
    const h1Range = h1High - h1Low;
    if (h1Range <= 0) continue;

    const movePct = ((h1Close - h1Open) / h1Open) * 100;
    if (Math.abs(movePct) < minFirstHourPct) continue;

    const cutoff = (exhaustionTop / 100) * h1Range;
    const closeInTopBand = h1Close >= h1High - cutoff;
    const closeInBotBand = h1Close <= h1Low + cutoff;
    const fadeShort = movePct > 0 && closeInTopBand;
    const fadeLong  = movePct < 0 && closeInBotBand;
    if (!fadeShort && !fadeLong) continue;

    const postH1 = sess.filter(c => c.time >= hourOneEnd);
    if (postH1.length === 0) continue;

    // Confirmation: the first bar in hour 2 closes against the morning direction
    const confirm = postH1[0];
    if (fadeShort && confirm.close >= h1Close) continue;
    if (fadeLong  && confirm.close <= h1Close) continue;

    const side   = fadeShort ? "sell" : "buy";
    const entry  = confirm.close;
    const stop   = side === "sell" ? h1High : h1Low;
    const target = side === "sell"
      ? h1Open + (h1Close - h1Open) * (1 - retracePct / 100)
      : h1Open + (h1Close - h1Open) * (1 - retracePct / 100);
    if (side === "buy"  && entry >= target) continue;
    if (side === "sell" && entry <= target) continue;

    let optInfo = {};
    if (mode === "options") {
      const optionType   = side === "buy" ? "call" : "put";
      const optionStrike = atmStrike(entry, strikeInterval);
      const entryPremium = optionPremium(entry, optionStrike, dteDays, iv, optionType);
      optInfo = { optionType, optionStrike, entryPremium, entryDTE: dteDays };
    }

    let openTrade = { side, entry, stop, target, entryTime: confirm.time, ...optInfo };
    for (let i = 1; i < postH1.length && openTrade; i++) {
      const bar = postH1[i];
      let exitPrice = null, exitReason = null;
      if (side === "buy") {
        if (bar.low  <= stop)   { exitPrice = stop;   exitReason = "stop";   }
        if (bar.high >= target) { exitPrice = target; exitReason = "target"; }
      } else {
        if (bar.high >= stop)   { exitPrice = stop;   exitReason = "stop";   }
        if (bar.low  <= target) { exitPrice = target; exitReason = "target"; }
      }
      if (!exitPrice && (bar.time >= sessExit || bar.time >= sessEnd)) { exitPrice = bar.close; exitReason = "time"; }
      if (exitPrice) {
        const risk   = Math.abs(entry - stop);
        const pnlUSD = side === "buy" ? exitPrice - entry : entry - exitPrice;
        let optResult = {};
        if (mode === "options" && openTrade.entryPremium != null) {
          const elapsed     = (bar.time - openTrade.entryTime) / 86_400_000;
          const exitPremium = optionPremium(exitPrice, openTrade.optionStrike, Math.max(openTrade.entryDTE - elapsed, 0.01), iv, openTrade.optionType);
          const optPnL      = (exitPremium - openTrade.entryPremium) * 100 * numContracts;
          optResult = { optionType: openTrade.optionType, optionStrike: openTrade.optionStrike, entryPremium: openTrade.entryPremium, exitPremium, optionsPnL: optPnL, optionsPnLPct: openTrade.entryPremium > 0 ? ((exitPremium - openTrade.entryPremium) / openTrade.entryPremium) * 100 : 0, optionDTE: openTrade.entryDTE };
        }
        trades.push({ date, entryTime: confirm.time, exitTime: bar.time, side, entry, stop, target, exit: exitPrice, exitReason, pnlR: risk > 0 ? pnlUSD/risk : 0, pnlPct: (pnlUSD/entry)*100, h1MovePct: +movePct.toFixed(3), ...optResult });
        openTrade = null;
      }
    }
  }
  return trades;
}


function runSMCBacktest(allCandles, params = {}, opts = {}) {
  const p = { ...smcMeta.params, ...params };
  const days = groupByDay(allCandles);
  const trades = [];
  for (const { date, candles } of days) {
    if (candles.length < 20) continue;
    const sessEnd = candles[candles.length - 1].time;
    let openTrade = null;
    for (let i = 0; i < candles.length; i++) {
      const bar = candles[i];
      const hist = allCandles.filter(c => c.time <= bar.time).slice(-120);
      if (!openTrade && hist.length >= Math.max(50, p.htfEmaPeriod || 48)) {
        const sig = smcSignal(hist, p);
        if (sig) {
          const optInfo = makeOptionInfo(sig.side, bar.close, opts);
          openTrade = { side: sig.side, entry: bar.close, stop: sig.stop, target: sig.target, entryTime: bar.time, entrySignal: sig.entrySignal, liquidity: sig.liquidity, orderBlock: sig.orderBlock, supplyDemand: sig.supplyDemand, ...optInfo };
          continue;
        }
      }
      if (!openTrade) continue;
      let exitPrice = null, exitReason = null;
      if (openTrade.side === "buy") {
        if (bar.low <= openTrade.stop) { exitPrice = openTrade.stop; exitReason = "stop"; }
        else if (bar.high >= openTrade.target) { exitPrice = openTrade.target; exitReason = "target"; }
      } else {
        if (bar.high >= openTrade.stop) { exitPrice = openTrade.stop; exitReason = "stop"; }
        else if (bar.low <= openTrade.target) { exitPrice = openTrade.target; exitReason = "target"; }
      }
      if (!exitPrice && bar.time >= sessEnd) { exitPrice = bar.close; exitReason = "time"; }
      if (exitPrice) {
        const risk = Math.abs(openTrade.entry - openTrade.stop);
        const pnlUSD = openTrade.side === "buy" ? exitPrice - openTrade.entry : openTrade.entry - exitPrice;
        let optResult = {};
        if (opts.mode === "options" && openTrade.optionType) {
          const elapsed = Math.max((bar.time - openTrade.entryTime) / 86_400_000, 0);
          const iv = opts.iv || 0.25;
          const exitPremium = optionPremium(exitPrice, openTrade.optionStrike, Math.max(openTrade.entryDTE - elapsed, 0.01), iv, openTrade.optionType);
          const optPnL = (exitPremium - openTrade.entryPremium) * 100 * (opts.numContracts || 1);
          optResult = { optionType: openTrade.optionType, optionStrike: openTrade.optionStrike, entryPremium: openTrade.entryPremium, exitPremium, optionsPnL: optPnL, optionsPnLPct: openTrade.entryPremium > 0 ? ((exitPremium - openTrade.entryPremium) / openTrade.entryPremium) * 100 : 0, optionDTE: openTrade.entryDTE };
        }
        trades.push({ date, entryTime: openTrade.entryTime, exitTime: bar.time, side: openTrade.side, entry: openTrade.entry, stop: openTrade.stop, target: openTrade.target, exit: exitPrice, exitReason, pnlR: risk > 0 ? pnlUSD / risk : 0, pnlPct: (pnlUSD / openTrade.entry) * 100, entrySignal: openTrade.entrySignal, liquidity: openTrade.liquidity, orderBlock: openTrade.orderBlock, supplyDemand: openTrade.supplyDemand, stopSource: openTrade.orderBlock ? "order-block" : "liquidity-sweep", ...optResult });
        break;
      }
    }
  }
  return trades;
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

export function calcMetrics(trades, mode = "stock") {
  if (trades.length === 0) return { totalTrades: 0, message: "No trades found in backtest window" };

  const wins   = trades.filter(t => t.pnlR > 0);
  const losses = trades.filter(t => t.pnlR <= 0);

  const avgWinR  = wins.length   > 0 ? wins.reduce((s,t)   => s + t.pnlR, 0) / wins.length   : 0;
  const avgLossR = losses.length > 0 ? Math.abs(losses.reduce((s,t) => s + t.pnlR, 0) / losses.length) : 0;
  const pf       = avgLossR * losses.length > 0 ? (avgWinR * wins.length) / (avgLossR * losses.length) : Infinity;

  let equity = 0, hwm = 0, maxDD = 0;
  const equityCurve = [];
  for (const t of trades) {
    equity += t.pnlR;
    equityCurve.push({ date: t.date, equity: parseFloat(equity.toFixed(3)) });
    if (equity > hwm) hwm = equity;
    if (hwm - equity > maxDD) maxDD = hwm - equity;
  }

  const result = {
    totalTrades:  trades.length,
    wins:         wins.length,
    losses:       losses.length,
    winRate:      ((wins.length / trades.length) * 100).toFixed(1) + "%",
    avgWinR:      avgWinR.toFixed(2) + "R",
    avgLossR:     avgLossR.toFixed(2) + "R",
    profitFactor: isFinite(pf) ? pf.toFixed(2) : "∞",
    totalReturnR: (equity >= 0 ? "+" : "") + equity.toFixed(2) + "R",
    maxDrawdown:  maxDD.toFixed(2) + "R",
    equityCurve,
    trades,
  };

  // Options aggregate metrics
  if (mode === "options" && trades.some(t => t.optionsPnL != null)) {
    const optTrades        = trades.filter(t => t.optionsPnL != null);
    const totalOptPnL      = optTrades.reduce((s,t) => s + (t.optionsPnL||0), 0);
    const optWins          = optTrades.filter(t => (t.optionsPnL||0) > 0);
    const avgEntryPrem     = optTrades.reduce((s,t) => s + (t.entryPremium||0), 0) / optTrades.length;
    // Total dollars of option premium moved (entry + exit), per-contract premium × 100 shares × contracts
    // We infer the contracts-per-trade multiplier from the first trade with both entryPremium and optionsPnL.
    const sample           = optTrades.find(t => t.entryPremium > 0 && t.exitPremium != null);
    const multiplier       = sample
      ? Math.round(Math.abs(sample.optionsPnL) / Math.max(Math.abs(sample.exitPremium - sample.entryPremium), 1e-9))
      : 100;
    const totalEntryDollars = optTrades.reduce((s,t) => s + (t.entryPremium||0) * multiplier, 0);
    const totalExitDollars  = optTrades.reduce((s,t) => s + (t.exitPremium ||0) * multiplier, 0);
    const totalPremiumTraded = totalEntryDollars + totalExitDollars;
    result.optionsMetrics = {
      totalPnL:             "$" + totalOptPnL.toFixed(2),
      winRate:              optTrades.length > 0 ? ((optWins.length/optTrades.length)*100).toFixed(1)+"%" : "—",
      avgPremium:           "$" + avgEntryPrem.toFixed(2) + "/share",
      totalEntryPremium:    "$" + totalEntryDollars.toFixed(2),
      totalExitPremium:     "$" + totalExitDollars.toFixed(2),
      totalPremiumTraded:   "$" + totalPremiumTraded.toFixed(2),
      contractsTraded:      optTrades.length,
    };
  }

  return result;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function runBacktest(strategyId, symbol, opts = {}) {
  const TIMEFRAMES = { orb: "5m", vwap: "1H", trend: "1D", meanrev: "1D", momentum: "1D", hybrid: "5m", reversal: "5m", "hybrid-reversal": "5m", hybrid10: "5m", "gap-fill": "5m", "vwap-reclaim": "5m", "first-hour-fade": "5m", smc: "15m" };
  const timeframe  = TIMEFRAMES[strategyId] || "1H";
  console.log(`Backtesting ${strategyId.toUpperCase()} on ${symbol} (${timeframe}) — mode: ${opts.mode || "stock"}`);
  const candles = opts._candles || await fetchCandles(symbol, timeframe, { yearWindow: !!opts.yearWindow });
  if (!opts._candles) console.log(`  Got ${candles.length} candles`);

  const params = opts.params || {};
  let trades;
  if      (strategyId === "orb")      trades = runORBBacktest(candles, params, opts);
  else if (strategyId === "vwap")     trades = runVWAPBacktest(candles, params, opts);
  else if (strategyId === "trend")    trades = runTrendBacktest(candles, params, opts);
  else if (strategyId === "meanrev")  trades = runMeanRevBacktest(candles, params, opts);
  else if (strategyId === "momentum") trades = runMomentumBacktest(candles, params, opts);
  else if (strategyId === "hybrid")   trades = runHybridBacktest(candles, params, opts);
  else if (strategyId === "reversal") trades = runReversalBacktest(candles, params, opts);
  else if (strategyId === "hybrid-reversal") trades = runHybridReversalBacktest(candles, params, opts);
  else if (strategyId === "hybrid10") trades = runHybridBacktest(candles, { ...hybrid10Meta.params, ...params }, opts);
  else if (strategyId === "gap-fill")        trades = runGapFillBacktest(candles, params, opts);
  else if (strategyId === "vwap-reclaim")    trades = runVWAPReclaimBacktest(candles, params, opts);
  else if (strategyId === "first-hour-fade") trades = runFirstHourFadeBacktest(candles, params, opts);
  else if (strategyId === "smc")             trades = runSMCBacktest(candles, params, opts);
  else throw new Error(`Unknown strategy: ${strategyId}`);

  // Tag each trade with the market regime at its entry time. Same classifier
  // used live, so regime stats bucket consistently across backtest+live data.
  // Slice candles up to entry so we don't peek into the future.
  for (const t of trades) {
    if (t.regime) continue;
    if (!t.entryTime) continue;
    const cutoff = candles.findIndex(c => c.time >= t.entryTime);
    const slice  = cutoff > 0 ? candles.slice(Math.max(0, cutoff - 200), cutoff + 1) : candles.slice(0, 1);
    try {
      const r   = classifyRegime(slice);
      t.regime  = r.tag;
      t.regimeParts = r.parts;
    } catch { t.regime = "unknown"; }
    // Convenient ET hour for per-hour bucketing
    const d = new Date(t.entryTime);
    const offsetMin = (d.getUTCMonth() >= 2 && d.getUTCMonth() <= 10) ? -240 : -300;
    const et = new Date(d.getTime() + offsetMin * 60_000);
    t.hourET = et.getUTCHours();
  }

  const metrics = calcMetrics(trades, opts.mode || "stock");

  // Return a candle sample for chart rendering (max 3000 bars)
  const sample = candles.length > 3000 ? candles.slice(-3000) : candles;
  metrics.candles = sample.map(c => ({ time: Math.floor(c.time/1000), open: c.open, high: c.high, low: c.low, close: c.close }));

  return metrics;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (process.argv.find(a => a.startsWith("--strategy"))) {
  const stratArg = process.argv.find(a => a.startsWith("--strategy="))?.split("=")[1] || "orb";
  const symArg   = process.argv.find(a => a.startsWith("--symbol="))?.split("=")[1]   || "SPY";
  const modeArg  = process.argv.find(a => a.startsWith("--mode="))?.split("=")[1]     || "stock";
  const ivArg    = parseFloat(process.argv.find(a => a.startsWith("--iv="))?.split("=")[1]  || "18") / 100;
  const dteArg   = parseInt(process.argv.find(a => a.startsWith("--dte="))?.split("=")[1]   || "7");
  const forceArg = process.argv.find(a => a.startsWith("--force-daily"))
                   ? (process.argv.find(a => a.startsWith("--force-daily="))?.split("=")[1] !== "false")
                   : false;

  runBacktest(stratArg, symArg, { mode: modeArg, iv: ivArg, dteDays: dteArg, forceDaily: forceArg }).then(results => {
    const { trades, equityCurve, candles, ...summary } = results;
    console.log("\n══ Backtest Results ══════════════════════════════════\n");
    for (const [k,v] of Object.entries(summary)) {
      if (typeof v !== "object") console.log(`  ${k.padEnd(16)}: ${v}`);
    }
    if (summary.optionsMetrics) {
      console.log("\n── Options P&L ─────────────────────────────────────");
      for (const [k,v] of Object.entries(summary.optionsMetrics)) console.log(`  ${k.padEnd(16)}: ${v}`);
    }
    console.log("\n── Trades ───────────────────────────────────────────");
    (trades||[]).forEach(t => {
      const p    = t.pnlR >= 0 ? "+" : "";
      const opt  = t.optionsPnL != null ? `  opt: ${t.optionsPnL>=0?"+":""}$${t.optionsPnL.toFixed(2)}` : "";
      console.log(`  ${t.date}  ${t.side.padEnd(4)} ${(t.exitReason||"").padEnd(11)} ${p}${t.pnlR.toFixed(2)}R${opt}`);
    });
    console.log("\n═════════════════════════════════════════════════════\n");
  }).catch(err => { console.error("Backtest error:", err.message); process.exit(1); });
}
