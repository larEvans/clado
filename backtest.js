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

// ─── Market data ──────────────────────────────────────────────────────────────

export async function fetchCandles(symbol, interval) {
  const yahooMap = { "1m":"1m","5m":"5m","15m":"15m","30m":"30m","1H":"60m","4H":"60m","1D":"1d" };
  const rangeMap = { "1m":"7d","5m":"60d","15m":"60d","30m":"60d","60m":"60d","1d":"1y" };
  const yi = yahooMap[interval] || "60m";
  const range = rangeMap[yi] || "60d";
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${yi}&range=${range}`;
  const res = await fetch(url, { headers:{ "User-Agent":"Mozilla/5.0" }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Yahoo Finance ${res.status} for ${symbol} — check the ticker symbol`);
  const json = await res.json();
  const r = json.chart?.result?.[0];
  if (!r) throw new Error(`No data returned for ${symbol}`);
  const { open, high, low, close, volume } = r.indicators.quote[0];
  return r.timestamp
    .map((t,i) => ({ time: t*1000, open: open[i], high: high[i], low: low[i], close: close[i], volume: volume[i]||0 }))
    .filter(c => c.open != null && c.close != null && !isNaN(c.close));
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
        } else {
          if (bar.high >= stop)   { exitPrice = stop;   exitReason = "stop";   }
          else if (bar.low  <= target) { exitPrice = target; exitReason = "target"; }
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
        else if (flip)          { exitPrice = price;  exitReason = "bias_flip"; }
      } else {
        if (bar.high >= stop)   { exitPrice = stop;   exitReason = "stop";     }
        else if (target && bar.low  <= target) { exitPrice = target; exitReason = "target";   }
        else if (flip)          { exitPrice = price;  exitReason = "bias_flip"; }
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
  } else {
    if (bar.high >= stop)   { exitPrice = stop;   exitReason = "stop"; }
    else if (bar.low  <= target) { exitPrice = target; exitReason = "target"; }
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

// ─── Hybrid Backtest — ORB + VWAP + EMA triple confirmation ──────────────────

function runHybridBacktest(allCandles, params = {}, opts = {}) {
  const {
    orbMinutes    = 15,
    rrRatio       = 2.0,
    volMultiplier = 1.3,
    maxRangePct   = 1.0,
    emaPeriod     = 9,
    emaSlowPeriod = 21,
  } = { ...hybridMeta.params, ...params };
  const { mode = "stock", iv = 0.18, dteDays = 7, numContracts = 1, strikeInterval = 1 } = opts;

  // Pre-compute EMAs across all candles (warm up with full history for accuracy)
  const closes       = allCandles.map(c => c.close);
  const ema9arr      = emaFull(closes, emaPeriod);
  const ema21arr     = emaFull(closes, emaSlowPeriod);
  const timeToIdx    = new Map(allCandles.map((c, i) => [c.time, i]));

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

    const postOrb      = sessCandles.filter(c => c.time >= orbEnd);
    let openTrade      = null;
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
        } else {
          if (bar.high >= stop)   { exitPrice = stop;   exitReason = "stop";   }
          if (bar.low  <= target) { exitPrice = target; exitReason = "target"; }
        }
        if (!exitPrice && bar.time >= sessEnd) { exitPrice = bar.close; exitReason = "time"; }

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

          trades.push({ date, entryTime, exitTime: bar.time, side, entry, stop, target, exit: exitPrice, exitReason, pnlR, pnlPct: (pnlUSD / entry) * 100, ...optResult });
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

      // LONG: breakout above ORB high + above VWAP + EMA bullish + volume
      if (price > orb.orbHigh && price > vwap && fastEMA > slowEMA && volOK) {
        const stop   = orb.orbLow;
        const target = orb.orbHigh + orb.orbRange * rrRatio;
        if (price >= target) continue;

        let optInfo = {};
        if (mode === "options") {
          const optionStrike = atmStrike(price, strikeInterval);
          const entryPremium = optionPremium(price, optionStrike, dteDays, iv, "call");
          optInfo = { optionType: "call", optionStrike, entryPremium, entryDTE: dteDays };
        }

        openTrade   = { side: "buy",  entry: price, stop, target, entryTime: bar.time, ...optInfo };
        tradeEntered = true;
        continue;
      }

      // SHORT: breakdown below ORB low + below VWAP + EMA bearish + volume
      if (price < orb.orbLow && price < vwap && fastEMA < slowEMA && volOK) {
        const stop   = orb.orbHigh;
        const target = orb.orbLow - orb.orbRange * rrRatio;
        if (price <= target) continue;

        let optInfo = {};
        if (mode === "options") {
          const optionStrike = atmStrike(price, strikeInterval);
          const entryPremium = optionPremium(price, optionStrike, dteDays, iv, "put");
          optInfo = { optionType: "put", optionStrike, entryPremium, entryDTE: dteDays };
        }

        openTrade   = { side: "sell", entry: price, stop, target, entryTime: bar.time, ...optInfo };
        tradeEntered = true;
      }
    }

    // Close any position still open at session end
    if (openTrade && postOrb.length > 0) {
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

      trades.push({ date, entryTime, exitTime: last.time, side, entry, stop, target: openTrade.target, exit: last.close, exitReason: "time", pnlR: risk > 0 ? pnlUSD / risk : 0, pnlPct: (pnlUSD / entry) * 100, ...optResult });
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
    const optTrades     = trades.filter(t => t.optionsPnL != null);
    const totalOptPnL   = optTrades.reduce((s,t) => s + (t.optionsPnL||0), 0);
    const optWins       = optTrades.filter(t => (t.optionsPnL||0) > 0);
    const avgEntryPrem  = optTrades.reduce((s,t) => s + (t.entryPremium||0), 0) / optTrades.length;
    result.optionsMetrics = {
      totalPnL:    "$" + totalOptPnL.toFixed(2),
      winRate:     optTrades.length > 0 ? ((optWins.length/optTrades.length)*100).toFixed(1)+"%" : "—",
      avgPremium:  "$" + avgEntryPrem.toFixed(2) + "/share",
    };
  }

  return result;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function runBacktest(strategyId, symbol, opts = {}) {
  const TIMEFRAMES = { orb: "5m", vwap: "1H", trend: "1D", meanrev: "1D", momentum: "1D", hybrid: "5m" };
  const timeframe  = TIMEFRAMES[strategyId] || "1H";
  console.log(`Backtesting ${strategyId.toUpperCase()} on ${symbol} (${timeframe}) — mode: ${opts.mode || "stock"}`);
  const candles = opts._candles || await fetchCandles(symbol, timeframe);
  if (!opts._candles) console.log(`  Got ${candles.length} candles`);

  const params = opts.params || {};
  let trades;
  if      (strategyId === "orb")      trades = runORBBacktest(candles, params, opts);
  else if (strategyId === "vwap")     trades = runVWAPBacktest(candles, params, opts);
  else if (strategyId === "trend")    trades = runTrendBacktest(candles, params, opts);
  else if (strategyId === "meanrev")  trades = runMeanRevBacktest(candles, params, opts);
  else if (strategyId === "momentum") trades = runMomentumBacktest(candles, params, opts);
  else if (strategyId === "hybrid")   trades = runHybridBacktest(candles, params, opts);
  else throw new Error(`Unknown strategy: ${strategyId}`);

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

  runBacktest(stratArg, symArg, { mode: modeArg, iv: ivArg, dteDays: dteArg }).then(results => {
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
