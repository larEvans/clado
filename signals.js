/**
 * Shared per-bar signal + position logic for the router.
 *
 * Used by BOTH the live bot (bot-stream.js) and the replay backtest
 * (replay.js), so a replay tests exactly the code that trades:
 *
 *   SymbolSeries      builds 5/15/60-minute bars from the 1-minute stream
 *   STRATEGY_TF       each strategy's native bar size (what it was backtested on)
 *   nativeCandidate   runs a strategy only when one of ITS bars just closed
 *   evaluateStrategy  pure entry check: bars in → { side, entry, stop, target } | null
 *   updatePosition    stop / trailing stop / target / near-target / bias-flip exits
 *   decideEntry       the router's gates + choice + predictor veto/sizing
 *
 * Everything here reads time from the bars, never the wall clock, so the same
 * calls work on historical data. No I/O, no orders.
 */

import { ema, atr } from "./indicators.js";
import { pickStop, nearTargetTrigger } from "./backtest.js";
import { calcRange } from "./strategies/orb.js";
import { checkSignal as vwapSignal, checkBiasFlip, meta as vwapMeta } from "./strategies/vwap.js";
import { checkSignal as smcSignal, meta as smcMeta } from "./strategies/smc.js";
import { evaluatePrediction, effectiveThresholds, meta as predictorMeta } from "./strategies/predictor-strat.js";
import { meta as hybridMeta } from "./strategies/hybrid.js";
import { meta as hybrid10Meta } from "./strategies/hybrid10.js";
import { meta as reversalMeta } from "./strategies/reversal.js";
import { meta as hybridReversalMeta } from "./strategies/hybrid-reversal.js";
import { meta as orbMeta } from "./strategies/orb.js";
import { meta as vwapReclaimMeta } from "./strategies/vwap-reclaim.js";
import { meta as gapFillMeta } from "./strategies/gap-fill.js";
import { meta as firstHourFadeMeta } from "./strategies/first-hour-fade.js";
import { meta as lateMomentumMeta } from "./strategies/late-momentum.js";
import { meta as noiseMomentumMeta } from "./strategies/noise-momentum.js";
import { classifyRegime } from "./regime.js";
import { chooseSignal } from "./router.js";

// ── Eastern time (bar timestamps are UTC ms) — et.js, re-exported ────────────

import { etInfo, sessionOpenMs, MARKET_OPEN, ENTRY_READY, EOD_CLOSE, MARKET_CLOSE } from "./et.js";
import { liquidityTarget, liquidityLevels } from "./ict.js";
import { meta as ict2024Meta } from "./strategies/ict-2024.js";
import { meta as sdMtfMeta } from "./strategies/sd-mtf.js";
import { meta as dipBuyMeta } from "./strategies/dip-buy.js";
import { structure, orderBlocks, wyckoff } from "./concepts.js";
export { etInfo, sessionOpenMs, MARKET_OPEN, ENTRY_READY, EOD_CLOSE, MARKET_CLOSE };

// ── Multi-timeframe bars ──────────────────────────────────────────────────────

/** Native bar size (minutes) per strategy — the timeframe it was backtested on. */
export const STRATEGY_TF = {
  hybrid: 5, hybrid10: 5, orb: 5, reversal: 5, "hybrid-reversal": 5, predictor: 5,
  "vwap-reclaim": 5, "gap-fill": 5, "first-hour-fade": 5,
  "late-momentum": 5, "noise-momentum": 5, "ict-2024": 5, "sd-mtf": 5, "dip-buy": 5,
  smc: 15,
  vwap: 60,
};
const SERIES_TFS = [5, 15, 60];
const MAX_BARS   = 4000;   // noise-momentum needs ~15 days of 5m bars
const LOOKBACK   = 600;    // what every other strategy sees (and what the model trained on)
// noise-momentum and the relative-volume filter need ~15 days of 5m bars.
const STRATEGY_LOOKBACK = { "noise-momentum": MAX_BARS, hybrid: MAX_BARS, hybrid10: MAX_BARS };

/**
 * Per-symbol bar store. push() takes base bars (1-minute live, or 5-minute in
 * a coarse replay) and aggregates them into 5/15/60-minute bars aligned to the
 * clock (the same alignment as Alpaca's historical bars). A bar is "completed"
 * when its last base bar arrives — or, if that bar is missing (thin IEX
 * minutes), when the first bar of the next bucket arrives.
 */
export class SymbolSeries {
  constructor(baseMinutes = 1) {
    this.baseMinutes = baseMinutes;
    this.daily = [];                     // RTH sessions: { day, open, high, low, close } (last = today, updating)
    this.bars = { [baseMinutes]: [] };
    this.open = {};
    for (const tf of SERIES_TFS) if (tf !== baseMinutes) { this.bars[tf] = []; this.open[tf] = null; }
  }

  /** @returns {Set<number>} timeframes whose bar completed with this push */
  push(bar) {
    const base = this.bars[this.baseMinutes];
    if (base.length && bar.time <= base[base.length - 1].time) return new Set();   // duplicate / out of order
    const completed = new Set([this.baseMinutes]);
    this.#append(this.baseMinutes, bar);
    const { day, mins } = etInfo(bar.time);
    if (mins >= MARKET_OPEN && mins < MARKET_CLOSE) {
      let d = this.daily[this.daily.length - 1];
      if (!d || d.day !== day) {
        this.daily.push(d = { day, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
        if (this.daily.length > 400) this.daily.shift();
      } else {
        d.high = Math.max(d.high, bar.high); d.low = Math.min(d.low, bar.low); d.close = bar.close;
      }
    }
    for (const tf of Object.keys(this.open).map(Number)) {
      if (tf < this.baseMinutes) continue;
      const ms = tf * 60_000;
      const bucket = Math.floor(bar.time / ms) * ms;
      let cur = this.open[tf];
      if (cur && cur.time !== bucket) {            // missed the bucket's last bar — close it late
        this.#append(tf, cur);
        completed.add(tf);
        cur = null;
      }
      cur = cur
        ? { ...cur, high: Math.max(cur.high, bar.high), low: Math.min(cur.low, bar.low), close: bar.close, volume: cur.volume + bar.volume }
        : { time: bucket, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume };
      if (bar.time + this.baseMinutes * 60_000 >= bucket + ms) {   // bucket's final base bar
        this.#append(tf, cur);
        completed.add(tf);
        cur = null;
      }
      this.open[tf] = cur;
    }
    return completed;
  }

  get(tf) { return this.bars[tf] || []; }

  /** Seed completed daily sessions (oldest first) before intraday warm-up —
   *  daily strategies need ~200 sessions, more than the intraday warm-up. */
  seedDaily(sessions) {
    const firstIntraday = this.daily[0]?.day;
    const older = sessions.filter(s => !firstIntraday || s.day < firstIntraday);
    this.daily = [...older, ...this.daily].slice(-400);
  }

  #append(tf, bar) {
    const arr = this.bars[tf];
    arr.push(bar);
    if (arr.length > MAX_BARS) arr.shift();
  }
}

// ── Indicator helpers (same math as backtest.js, which built the router stats) ─

function rsiLast(closes, period) {                   // Wilder RSI, last value
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) gains += d; else losses -= d; }
  let ag = gains / period, al = losses / period;
  const out = [al === 0 ? 100 : 100 - 100 / (1 + ag / al)];
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
    out.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  }
  return out;                                        // aligned to closes[period..]
}

function wilderAtr(bars, period) {                   // Wilder ATR, last value
  if (bars.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < bars.length; i++)
    trs.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close)));
  let a = trs.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (let i = period; i < trs.length; i++) a = (a * (period - 1) + trs[i]) / period;
  return a;
}

function vwapOf(bars) {
  let tpv = 0, vol = 0;
  for (const c of bars) { tpv += ((c.high + c.low + c.close) / 3) * c.volume; vol += c.volume; }
  return vol === 0 ? null : tpv / vol;
}

function simpleRsi(closes, period) {                 // backtest.js calcRSI (used by VWAP)
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  const ag = gains / period, al = losses / period;
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

/** Opening range + RTH session bars for the ET day of the last bar, or null
 *  while the range is still forming. */
function openingRange(bars, orbMinutes) {
  const last   = bars[bars.length - 1];
  const open   = sessionOpenMs(last.time);
  const orbEnd = open + orbMinutes * 60_000;
  if (last.time < orbEnd) return null;
  const sess = bars.filter(b => b.time >= open && b.time < open + 7 * 3600_000);
  const orbBars = sess.filter(b => b.time < orbEnd);
  const orb = calcRange(orbBars);
  if (!orb || orb.orbRange <= 0) return null;
  return { ...orb, sess, open };
}

function volumeOK(bars, mult) {
  const prior = bars.slice(-21, -1);
  const volMA = prior.length ? prior.reduce((s, b) => s + b.volume, 0) / prior.length : 0;
  return volMA > 0 && bars[bars.length - 1].volume >= volMA * mult;
}

// ── Strategy entry checks ─────────────────────────────────────────────────────

/** Opening-range volume today ÷ its average over the previous `days`
 *  sessions (same definition as backtest.js runHybridBacktest), or null. */
function relativeVolume(bars, orbMinutes, days) {
  const sessions = rthDays(bars);
  if (!sessions.length) return null;
  const openVol = d => {
    const end = sessionOpenMs(d.bars[0].time) + orbMinutes * 60_000;
    return d.bars.filter(b => b.time < end).reduce((s, b) => s + b.volume, 0);
  };
  const prior = sessions.slice(-1 - days, -1).map(openVol).filter(v => v > 0);
  if (prior.length < days / 2) return null;
  return openVol(sessions[sessions.length - 1]) / (prior.reduce((a, b) => a + b, 0) / prior.length);
}

/** Hybrid's relative-volume filter on a would-be signal (checked only when
 *  everything else already fired, since it scans ~15 days of bars). */
function relVolGate(sig, bars, p) {
  if (!sig || !(p.minRelVol > 0)) return sig;
  const rv = relativeVolume(bars, p.orbMinutes ?? 15, p.relVolDays ?? 14);
  return rv >= p.minRelVol ? { ...sig, relVol: +rv.toFixed(2) } : null;
}

function hybridEntry(bars, p) {
  return relVolGate(hybridSignal(bars, p), bars, p);
}

function hybridSignal(bars, p) {
  const r = openingRange(bars, p.orbMinutes ?? 15);
  if (!r) return null;
  if ((r.orbRange / ((r.orbHigh + r.orbLow) / 2)) * 100 >= (p.maxRangePct ?? 1.0)) return null;
  const closes = bars.map(b => b.close);
  const fast = ema(closes, p.emaPeriod ?? 9), slow = ema(closes, p.emaSlowPeriod ?? 21);
  const vwap = vwapOf(r.sess);
  if (!fast || !slow || !vwap) return null;
  const price = bars[bars.length - 1].close;
  const volOK = volumeOK(bars, p.volMultiplier ?? 1.3);
  const rr = p.rrRatio ?? 2.0;
  const recent = bars.slice(-31);
  if (price > r.orbHigh && price > vwap && fast > slow && volOK) {
    const target = r.orbHigh + r.orbRange * rr;
    if (price >= target) return null;
    const { stop, source, ob } = pickStop("buy", price, recent, r.orbHigh, r.orbLow);
    return { side: "buy", entry: price, stop, target, orbHigh: r.orbHigh, orbLow: r.orbLow, stopSource: source, orderBlock: ob };
  }
  if (price < r.orbLow && price < vwap && fast < slow && volOK) {
    const target = r.orbLow - r.orbRange * rr;
    if (price <= target) return null;
    const { stop, source, ob } = pickStop("sell", price, recent, r.orbHigh, r.orbLow);
    return { side: "sell", entry: price, stop, target, orbHigh: r.orbHigh, orbLow: r.orbLow, stopSource: source, orderBlock: ob };
  }
  return null;
}

function orbEntry(bars, p) {
  const r = openingRange(bars, p.orbMinutes ?? 15);
  if (!r) return null;
  const price = bars[bars.length - 1].close;
  if ((r.orbRange / price) * 100 > (p.maxRangePct ?? 1.0)) return null;
  if (!volumeOK(bars, p.volumeMultiplier ?? p.volMultiplier ?? 1.5)) return null;
  const rr = p.rrRatio ?? 2.0;
  if (price > r.orbHigh) return { side: "buy",  entry: price, stop: r.orbLow,  target: r.orbHigh + r.orbRange * rr };
  if (price < r.orbLow)  return { side: "sell", entry: price, stop: r.orbHigh, target: r.orbLow - r.orbRange * rr };
  return null;
}

/** RSI divergence vs the prior swing in the last `lookback` bars (reversal). */
function divergence(bars, p) {
  const lb = p.swingLookback ?? 10;
  const closes = bars.map(b => b.close);
  const rsi = rsiLast(closes, p.rsiPeriod ?? 14);
  if (!rsi || rsi.length < lb + 2) return null;       // rsi is aligned to the last bars
  const n = bars.length;
  const win = bars.slice(n - 1 - lb), rWin = rsi.slice(rsi.length - 1 - lb);
  let lowIdx = 0, highIdx = 0;
  for (let k = 1; k < win.length - 1; k++) {
    if (win[k].low  < win[lowIdx].low)   lowIdx  = k;
    if (win[k].high > win[highIdx].high) highIdx = k;
  }
  const cur = win[win.length - 1], curRsi = rWin[rWin.length - 1];
  const prevClose = bars[n - 2].close;
  const confirm = p.confirmCandle !== false;
  if (cur.low < win[lowIdx].low && curRsi > rWin[lowIdx] && curRsi < 50 && (!confirm || cur.close > prevClose)) return "buy";
  if (cur.high > win[highIdx].high && curRsi < rWin[highIdx] && curRsi > 50 && (!confirm || cur.close < prevClose)) return "sell";
  return null;
}

function atrStopSignal(bars, side, p, entrySignal) {
  const a = wilderAtr(bars, p.atrPeriod ?? 14);
  if (!a) return null;
  const price = bars[bars.length - 1].close;
  const risk = a * (p.atrMult ?? 1.5);
  const rr = p.rrRatio ?? 2.0;
  return {
    side, entry: price,
    stop:   side === "buy" ? price - risk : price + risk,
    target: side === "buy" ? price + risk * rr : price - risk * rr,
    entrySignal, stopSource: "atr-trail",
    trail: { mult: p.trailMult ?? 1.0, breakEvenR: p.breakEvenR ?? 1.0, atrPeriod: p.atrPeriod ?? 14 },
  };
}

function reversalEntry(bars, p) {
  const side = divergence(bars, p);
  return side ? atrStopSignal(bars, side, p, "reversal-div") : null;
}

function hybridReversalEntry(bars, p) {
  const r = openingRange(bars, p.orbMinutes ?? 15);
  if (!r) return null;
  if ((r.orbRange / ((r.orbHigh + r.orbLow) / 2)) * 100 >= (p.maxRangePct ?? 1.0)) return null;
  const closes = bars.map(b => b.close);
  const fast = ema(closes, p.emaPeriod ?? 9), slow = ema(closes, p.emaSlowPeriod ?? 21);
  const vwap = vwapOf(r.sess);
  if (!fast || !slow || !vwap) return null;
  const price = bars[bars.length - 1].close;
  const volOK = volumeOK(bars, p.volMultiplier ?? 1.3);
  let side = null, source = null;
  if (price > r.orbHigh && price > vwap && fast > slow && volOK)      { side = "buy";  source = "hybrid-breakout"; }
  else if (price < r.orbLow && price < vwap && fast < slow && volOK) { side = "sell"; source = "hybrid-breakout"; }
  if (!side) { side = divergence(bars, { ...p, confirmCandle: true }); source = "reversal-div"; }
  return side ? atrStopSignal(bars, side, p, source) : null;
}

function vwapEntry(bars, p) {
  const closes = bars.map(b => b.close);
  if (closes.length < (p.emaPeriod ?? 8) + (p.rsiPeriod ?? 3) + 1) return null;
  const day = etInfo(bars[bars.length - 1].time).day;
  const vwap = vwapOf(bars.filter(b => etInfo(b.time).day === day));
  const ema8 = ema(closes, p.emaPeriod ?? 8);
  const rsi3 = simpleRsi(closes, p.rsiPeriod ?? 3);
  if (!vwap || !ema8 || !rsi3) return null;
  const price = closes[closes.length - 1];
  const sig = vwapSignal(price, ema8, vwap, rsi3, p);
  return sig ? { ...sig, entry: price, biasFlip: true } : null;
}

/** Session (RTH) bars of the last bar's day and the last bar's index in it. */
function rthSession(bars) {
  const open = sessionOpenMs(bars[bars.length - 1].time);
  const sess = bars.filter(b => b.time >= open && b.time < open + 7 * 3600_000);
  return { open, sess, i: sess.length - 1 };
}

function vwapReclaimEntry(bars, p) {
  const { sess, i } = rthSession(bars);
  if (i < p.minBarsAfterOpen || sess[i] !== bars[bars.length - 1]) return null;
  const bar = sess[i];
  const vwap = vwapOf(sess.slice(0, i + 1)), prevVwap = vwapOf(sess.slice(0, i));
  if (!vwap || !prevVwap) return null;
  const prevSide = sess[i - 1].close > prevVwap ? "above" : "below";
  const curSide = bar.close > vwap ? "above" : "below";
  const look = sess.slice(Math.max(0, i - 20), i);
  const volAvg = look.length ? look.reduce((a, b) => a + b.volume, 0) / look.length : 0;
  const volOK = volAvg > 0 && bar.volume >= volAvg * p.volMultiplier;
  const long  = prevSide === "below" && curSide === "above" && bar.low  <= vwap && ((bar.close - vwap) / vwap) * 100 >= p.minReclaimPct && volOK;
  const short = prevSide === "above" && curSide === "below" && bar.high >= vwap && ((vwap - bar.close) / vwap) * 100 >= p.minReclaimPct && volOK;
  if (!long && !short) return null;
  const side = long ? "buy" : "sell", entry = bar.close;
  const stop = side === "buy" ? entry * (1 - p.stopPct / 100) : entry * (1 + p.stopPct / 100);
  const dist = Math.abs(entry - vwap) * p.rrRatio;
  const target = side === "buy" ? entry + dist : entry - dist;
  if (side === "buy" ? entry >= target : entry <= target) return null;
  return { side, entry, stop, target };
}

/** Gap fade. Gap = the day's first bar open vs the prior day's last close
 *  (all bars of each ET day, as in backtest.js). */
function gapFillEntry(bars, p) {
  const last = bars[bars.length - 1];
  const { day } = etInfo(last.time);
  const open = sessionOpenMs(last.time);
  if (last.time < open + 5 * 60_000 || last.time >= open + p.timeExitMin * 60_000) return null;
  const today = bars.filter(b => etInfo(b.time).day === day);
  const prior = bars.filter(b => b.time < today[0].time);
  // (backtest.js also requires ≥ 4 bars for the WHOLE day, which live can't
  // know at 9:35 — thin IEX premarkets often have only 2-3 bars by then.)
  if (!today.length || !prior.length) return null;
  const priorClose = prior[prior.length - 1].close, todayOpen = today[0].open;
  const gapPct = ((todayOpen - priorClose) / priorClose) * 100;
  let side = null;
  if (gapPct < -p.minGapPct && last.close > last.open && last.close < priorClose) side = "buy";
  if (gapPct >  p.minGapPct && last.close < last.open && last.close > priorClose) side = "sell";
  if (!side) return null;
  const gapAbs = Math.abs(todayOpen - priorClose);
  const stop = side === "buy" ? todayOpen - gapAbs * p.stopMult : todayOpen + gapAbs * p.stopMult;
  const target = priorClose;
  if (side === "buy" ? last.close >= target : last.close <= target) return null;
  return { side, entry: last.close, stop, target, timeExitAt: open + p.timeExitMin * 60_000 };
}

/** Fade an exhausted first hour, entering on the first bar of hour two. */
function firstHourFadeEntry(bars, p) {
  const { open, sess, i } = rthSession(bars);
  const h1End = open + 60 * 60_000;
  if (i < 0 || sess[i].time !== h1End) return null;
  const h1 = sess.filter(b => b.time < h1End);
  if (h1.length < 4) return null;
  const h1Open = h1[0].open, h1Close = h1[h1.length - 1].close;
  const h1High = Math.max(...h1.map(b => b.high)), h1Low = Math.min(...h1.map(b => b.low));
  const range = h1High - h1Low;
  if (range <= 0) return null;
  const movePct = ((h1Close - h1Open) / h1Open) * 100;
  if (Math.abs(movePct) < p.minFirstHourPct) return null;
  const band = (p.exhaustionTop / 100) * range;
  const fadeShort = movePct > 0 && h1Close >= h1High - band;
  const fadeLong  = movePct < 0 && h1Close <= h1Low + band;
  const confirm = sess[i];
  if (fadeShort && confirm.close >= h1Close) return null;
  if (fadeLong  && confirm.close <= h1Close) return null;
  if (!fadeShort && !fadeLong) return null;
  const side = fadeShort ? "sell" : "buy";
  const target = h1Open + (h1Close - h1Open) * (1 - p.retracePct / 100);
  if (side === "buy" ? confirm.close >= target : confirm.close <= target) return null;
  return { side, entry: confirm.close, stop: side === "sell" ? h1High : h1Low, target, timeExitAt: open + p.timeExitMin * 60_000 };
}

/** RTH bars grouped by ET day, oldest first: [{ day, bars }]. */
function rthDays(bars) {
  const out = [];
  for (const b of bars) {
    const { day, mins } = etInfo(b.time);
    if (mins < MARKET_OPEN || mins >= MARKET_CLOSE) continue;
    if (!out.length || out[out.length - 1].day !== day) out.push({ day, bars: [] });
    out[out.length - 1].bars.push(b);
  }
  return out;
}

const hhmm = s => { const [h, m] = String(s).split(":").map(Number); return h * 60 + (m || 0); };

/** Last-half-hour momentum: at the 3:30 bar close, go with prev close → now. */
function lateMomentumEntry(bars, p, tf) {
  const last = bars[bars.length - 1];
  if (etInfo(last.time + tf * 60_000).mins !== 15 * 60 + 30) return null;
  const days = rthDays(bars.slice(-400));
  if (days.length < 2) return null;
  const prevClose = days[days.length - 2].bars.at(-1).close;
  const move = (last.close - prevClose) / prevClose * 100;
  if (!move || Math.abs(move) < p.minMovePct) return null;
  const a = wilderAtr(bars, 14);
  if (!a) return null;
  const side = move > 0 ? "buy" : "sell", dir = side === "buy" ? 1 : -1;
  return {
    side, entry: last.close,
    stop:   last.close - dir * a * p.stopAtrMult,
    target: last.close + dir * a * 20,             // effectively none: exits at the close
    eodMins: MARKET_CLOSE,                         // hold past the 3:45 EOD close, to the 4:00 close
  };
}

/** Noise-band momentum (Zarattini, Aziz & Barbon 2024). */
function noiseMomentumEntry(bars, p, tf) {
  const last = bars[bars.length - 1];
  const endMins = etInfo(last.time + tf * 60_000).mins;
  if (endMins % p.checkMinutes !== 0 || endMins < hhmm(p.firstCheck) || endMins > hhmm(p.lastCheck)) return null;
  const days = rthDays(bars);
  if (days.length < p.minDays + 2) return null;
  const today = days[days.length - 1];
  if (today.day !== etInfo(last.time).day) return null;
  const open = today.bars[0].open;
  const prevClose = days[days.length - 2].bars.at(-1).close;
  // Average |move from open| at this time of day over the prior lookbackDays.
  const moves = [];
  for (const d of days.slice(Math.max(0, days.length - 1 - p.lookbackDays), -1)) {
    const b = d.bars.find(x => etInfo(x.time + tf * 60_000).mins === endMins);
    if (b) moves.push(Math.abs(b.close / d.bars[0].open - 1));
  }
  if (moves.length < p.minDays) return null;
  const sigma = moves.reduce((a, b) => a + b, 0) / moves.length * p.bandMult;
  const upper = Math.max(open, prevClose) * (1 + sigma);
  const lower = Math.min(open, prevClose) * (1 - sigma);
  const price = last.close;
  const side = price > upper ? "buy" : price < lower ? "sell" : null;
  if (!side) return null;
  const a = wilderAtr(bars.slice(-200), 14);
  if (!a) return null;
  const dir = side === "buy" ? 1 : -1;
  return {
    side, entry: price,
    stop:   price - dir * a * p.stopAtrMult,
    target: price + dir * a * 20,                  // exits come from the band / VWAP trail
    bandStop: { level: side === "buy" ? upper : lower, every: p.checkMinutes },
  };
}

/** Wilder RSI(2) over daily closes, using `lastClose` for the current session
 *  (same math as docs/edge-study.md's test). */
export function rsi2Daily(daily, lastClose) {
  const n = daily.length;
  if (n < 3) return null;
  const closes = daily.map(d => d.close);
  closes[n - 1] = lastClose;
  let ag = 0, al = 0;
  for (let k = Math.max(1, n - 31); k < n; k++) {
    const d = closes[k] - closes[k - 1];
    ag = (ag + Math.max(0, d)) / 2;
    al = (al + Math.max(0, -d)) / 2;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

/** Index dip-buy — see strategies/dip-buy.js. */
function dipBuyEntry(bars, p, series) {
  const last = bars[bars.length - 1];
  const end = etInfo(last.time + STRATEGY_TF["dip-buy"] * 60_000);
  if (end.mins !== hhmm(p.signalTime)) return null;
  const D = series?.daily;
  if (!D || D.length < p.smaDays + 2 || D[D.length - 1].day !== end.day) return null;
  const px = last.close;
  const prior = D.slice(-p.smaDays - 1, -1);                    // completed sessions
  const sma = prior.reduce((a, d) => a + d.close, 0) / prior.length;
  if (!(px > sma)) return null;
  const rsi = rsi2Daily(D, px);
  if (!(rsi < p.rsiEntry)) return null;
  return {
    side: "buy", entry: px,
    stop: px * 0.0001, target: px * 100,                        // no stop / target: rule-based exit
    overnight: true, entryDay: end.day,
    dipExit: { signalTime: p.signalTime, rsiExit: p.rsiExit, maxDays: p.maxDays },
    entrySignal: "dip-buy",
    meta: { rsi2: +rsi.toFixed(1), sma200: +sma.toFixed(2), distSmaPct: +((px / sma - 1) * 100).toFixed(2) },
  };
}

/** Trend of a higher timeframe's structure, cached per closed bar of that
 *  timeframe (it can only change when one closes). */
const _trendCache = new WeakMap();
function tfStructure(series, tf, lookback, k) {
  const bars = series?.get(tf);
  if (!bars || bars.length < 30) return null;
  const lastT = bars[bars.length - 1].time;
  let m = _trendCache.get(series);
  if (!m) _trendCache.set(series, m = new Map());
  const key = `${tf}|${lookback}|${k}`;
  const c = m.get(key);
  if (c && c.t === lastT) return c;
  const w = bars.slice(-lookback);
  const st = structure(w, k);
  const entry = { t: lastT, trend: st.trend, protectedLevel: st.protectedLevel, weakLevel: st.weakLevel, zones: null, w, st };
  m.set(key, entry);
  return entry;
}
const tfTrend = (series, tf, lookback, k) => tfStructure(series, tf, lookback, k)?.trend ?? null;

/** Fresh higher-timeframe zones (order blocks not yet closed through). */
function tfZones(series, tf, lookback, k) {
  const s = tfStructure(series, tf, lookback, k);
  if (!s) return [];
  if (!s.zones) s.zones = orderBlocks(s.w, s.st).filter(z => z.invalidatedAt == null);
  return s.zones;
}

/** Multi-timeframe supply & demand — see strategies/sd-mtf.js. */
function sdMtfEntry(bars, p, series) {
  const tf = STRATEGY_TF["sd-mtf"];
  const last = bars[bars.length - 1];
  const end = etInfo(last.time + tf * 60_000);
  if (end.mins < hhmm(p.firstEntry) || end.mins > hhmm(p.lastEntry)) return null;
  const bias = p.htfTf ? tfTrend(series, p.htfTf, p.htfLookback, p.htfSwingK) : null;
  if (p.htfTf && !bias) return null;
  const mid = p.midTf ? tfTrend(series, p.midTf, p.midLookback, p.htfSwingK) : null;
  if (p.midTf && bias && mid !== bias) return null;            // 15m must agree with 1h
  const w = bars.slice(-p.ltfLookback);
  const n = w.length, i = n - 1, cur = w[i];
  const st = structure(w, p.swingK);
  if (!st.events.length) return null;
  const zones = orderBlocks(w, st);
  for (let zi = zones.length - 1; zi >= 0; zi--) {
    const z = zones[zi];
    if (z.mitigatedAt !== i) continue;                         // first return is this bar
    const up = z.dir === "demand";
    if (bias && bias !== (up ? "up" : "down")) continue;
    if (i - z.breakIdx > p.maxZoneAge) continue;
    if (p.requireFvg && !z.fvg) continue;
    if (up ? cur.close < z.lo : cur.close > z.hi) continue;    // closed through the zone
    const a = wilderAtr(w, 14);
    if (!a) return null;
    const side = up ? "buy" : "sell", entry = cur.close;
    const legExt = up ? w[z.legExtremeIdx].low : w[z.legExtremeIdx].high;
    const protectedLvl = up ? Math.min(z.lo, legExt) : Math.max(z.hi, legExt);
    const stop = up ? protectedLvl - a * p.stopPadAtr : protectedLvl + a * p.stopPadAtr;
    const risk = Math.abs(entry - stop);
    if (!(risk > 0) || risk / entry * 100 < p.minRiskPct) continue;
    let target, targetKind = "rr";
    if (p.targetMode === "rr") target = up ? entry + risk * p.rr : entry - risk * p.rr;
    else {
      const t = liquidityTarget(side, entry, stop, bars.slice(-LOOKBACK), p.minRR);
      if (!t) continue;
      target = t.price; targetKind = t.kind;
    }
    // Higher-timeframe point of interest: price is inside a fresh 15m zone
    // of the same direction.
    const poi = tfZones(series, p.midTf || 15, p.midLookback, p.htfSwingK)
      .some(hz => hz.dir === z.dir && (up ? cur.low <= hz.hi && cur.low >= hz.lo - (hz.hi - hz.lo) * 0.25 : cur.high >= hz.lo && cur.high <= hz.hi + (hz.hi - hz.lo) * 0.25));
    if (p.requirePoi && !poi) continue;
    if (p.avoidPoi && poi) continue;                          // lab: entries AT 15m zones did worse
    // Liquidity sweep: the leg into the zone took out the lows (highs) of the
    // 20 bars before it.
    const pre = w.slice(Math.max(0, z.legExtremeIdx - 20), z.legExtremeIdx);
    const sweep = pre.length >= 5 && (up ? w[z.legExtremeIdx].low < Math.min(...pre.map(b => b.low)) : w[z.legExtremeIdx].high > Math.max(...pre.map(b => b.high)));
    if (p.requireSweep && !sweep) continue;
    // Premium / discount of the 1h dealing range (protected ↔ weak level).
    const hs = p.htfTf ? tfStructure(series, p.htfTf, p.htfLookback, p.htfSwingK) : null;
    let pd = null;
    if (hs?.protectedLevel != null && hs?.weakLevel != null && hs.weakLevel !== hs.protectedLevel) {
      const lo = Math.min(hs.protectedLevel, hs.weakLevel), hi = Math.max(hs.protectedLevel, hs.weakLevel);
      pd = +((entry - lo) / (hi - lo)).toFixed(2);
    }
    if (p.discountOnly && !(pd != null && (up ? pd < 0.5 : pd > 0.5))) continue;
    let spring = null;
    if (p.wyckoffSpring || p.withWyckoffMeta) {
      const wy = wyckoff(w.slice(-80));
      const off = n - Math.min(n, 80);
      spring = wy.events.some(e => e.type === (up ? "spring" : "upthrust") && e.i + off >= z.legExtremeIdx - 3 && e.i + off <= i);
      if (p.wyckoffSpring && !spring) continue;
    }
    const breakBar = w[z.breakIdx];
    return {
      side, entry, stop, target, targetKind, entrySignal: "sd-mtf",
      meta: {
        bias, midTrend: mid, ltfTrend: st.trend, breakType: z.breakType, hasFvg: !!z.fvg,
        zoneAge: i - z.breakIdx, zoneAtr: +((z.hi - z.lo) / a).toFixed(2),
        riskAtr: +(risk / a).toFixed(2), riskPct: +(risk / entry * 100).toFixed(3),
        rrPlanned: +(Math.abs(target - entry) / risk).toFixed(2),
        breakAtr: +((breakBar.high - breakBar.low) / a).toFixed(2),
        depth: +((up ? z.hi - cur.low : cur.high - z.lo) / Math.max(1e-9, z.hi - z.lo)).toFixed(2),
        mins: end.mins, spring, targetKind, poi, sweep, pd,
      },
    };
  }
  return null;
}

/** ICT 2024 Mentorship L1 "8:30 model" — see strategies/ict-2024.js. */
function ict2024Entry(bars, p, tf) {
  const last = bars[bars.length - 1];
  const end = etInfo(last.time + tf * 60_000);
  if (end.mins > hhmm(p.windowEnd)) return null;
  // First bar of today at/after the setup time (8:30).
  let i830 = -1;
  for (let i = bars.length - 1; i >= 0; i--) {
    const e = etInfo(bars[i].time);
    if (e.day !== end.day) break;
    if (e.mins >= hhmm(p.setupTime)) i830 = i;
  }
  if (i830 < 10) return null;
  const liq = liquidityLevels(bars.slice(0, i830));             // pools as of 8:30
  const post = bars.slice(i830);
  const n = post.length;
  if (n < 4) return null;

  for (const side of ["sell", "buy"]) {
    const up = side === "sell";                                  // short after a buy-side raid
    const pools = liq.levels.filter(l => l.side === (up ? "buy" : "sell"));
    if (!pools.length) continue;
    let x = 0;                                                   // post-8:30 extreme
    for (let k = 1; k < n; k++) if (up ? post[k].high > post[x].high : post[k].low < post[x].low) x = k;
    const extreme = up ? post[x].high : post[x].low;
    if (!pools.some(l => up ? extreme > l.price : extreme < l.price)) continue;          // no raid
    const into = post.slice(Math.max(0, x - p.mssLookback), x);
    if (!into.length) continue;
    const swing = up ? Math.min(...into.map(b => b.low)) : Math.max(...into.map(b => b.high));
    let mss = -1;
    for (let k = x + 1; k < n; k++) if (up ? post[k].close < swing : post[k].close > swing) { mss = k; break; }
    if (mss < 0 || mss >= n - 1) continue;                      // need a retrace after the shift
    let fvg = null;                                              // gap left by the displacement
    for (let k = Math.max(x + 2, 2); k <= mss; k++) {
      const a = post[k - 2], c = post[k];
      if (up && a.low > c.high)  fvg = { lo: c.high, hi: a.low };
      if (!up && a.high < c.low) fvg = { lo: a.high, hi: c.low };
    }
    if (!fvg) continue;
    const cur = post[n - 1];
    const retrace = up ? cur.high >= fvg.lo && cur.close < fvg.hi : cur.low <= fvg.hi && cur.close > fvg.lo;
    if (!retrace) continue;
    if (post.slice(mss + 1, n - 1).some(b => up ? b.high >= fvg.lo : b.low <= fvg.hi)) continue;   // first touch only
    const entry = cur.close;
    const stop = up ? extreme * (1 + p.stopPadPct / 100) : extreme * (1 - p.stopPadPct / 100);
    if (up ? stop <= entry : stop >= entry) continue;
    const t = liquidityTarget(side, entry, stop, bars, p.minRR);
    if (!t) continue;
    return { side, entry, stop, target: t.price, targetKind: t.kind, entrySignal: "ict-raid-mss-fvg", fvg, raid: extreme };
  }
  return null;
}

const EVALUATORS = {
  hybrid:            (bars, p) => hybridEntry(bars, { ...hybridMeta.params, ...p }),
  hybrid10:          (bars, p) => hybridEntry(bars, { ...hybrid10Meta.params, ...p }),
  orb:               (bars, p) => orbEntry(bars, { ...orbMeta.params, ...p }),
  reversal:          (bars, p) => reversalEntry(bars, { ...reversalMeta.params, ...p }),
  "hybrid-reversal": (bars, p) => hybridReversalEntry(bars, { ...hybridReversalMeta.params, ...p }),
  vwap:              (bars, p) => vwapEntry(bars, { ...vwapMeta.params, ...p }),
  smc:               (bars, p) => smcSignal(bars, { ...smcMeta.params, ...p }),
  predictor:         (bars, p) => evaluatePrediction(bars, { ...predictorMeta.params, ...p }).signal,
  "vwap-reclaim":    (bars, p) => vwapReclaimEntry(bars, { ...vwapReclaimMeta.params, ...p }),
  "gap-fill":        (bars, p) => gapFillEntry(bars, { ...gapFillMeta.params, ...p }),
  "first-hour-fade": (bars, p) => firstHourFadeEntry(bars, { ...firstHourFadeMeta.params, ...p }),
  "late-momentum":   (bars, p) => lateMomentumEntry(bars, { ...lateMomentumMeta.params, ...p }, STRATEGY_TF["late-momentum"]),
  "noise-momentum":  (bars, p) => noiseMomentumEntry(bars, { ...noiseMomentumMeta.params, ...p }, STRATEGY_TF["noise-momentum"]),
  "ict-2024":        (bars, p) => ict2024Entry(bars, { ...ict2024Meta.params, ...p }, STRATEGY_TF["ict-2024"]),
  "sd-mtf":          (bars, p, series) => sdMtfEntry(bars, { ...sdMtfMeta.params, ...p }, series),
  "dip-buy":         (bars, p, series) => dipBuyEntry(bars, { ...dipBuyMeta.params, ...p }, series),
};

export const SUPPORTED_STRATEGIES = Object.keys(EVALUATORS);
const CRYPTO_STRATEGIES = ["reversal", "vwap-reclaim", "hybrid-reversal"];
/** Strategies that enter at the close and hold overnight (exempt from the 3:45 cut-off). */
export const LATE_STRATEGIES = ["dip-buy"];

/** Pure entry check on a strategy's native bars. */
export function evaluateStrategy(strategy, bars, params = {}, series = null) {
  const fn = EVALUATORS[strategy];
  if (!fn || !bars || bars.length < 22) return null;
  const sig = fn(bars, params, series);          // series: other timeframes (multi-timeframe strategies)
  if (!sig || !Number.isFinite(sig.stop) || !Number.isFinite(sig.target)) return null;
  return { entry: bars[bars.length - 1].close, ...sig, tf: STRATEGY_TF[strategy] };
}

/**
 * Candidate from a strategy for this base bar: evaluated only when the
 * strategy's native bar just completed (so it sees exactly what its backtest
 * saw), otherwise null.
 */
export function nativeCandidate(strategy, series, completedTfs, params = {}) {
  const tf = STRATEGY_TF[strategy];
  if (!tf || !completedTfs.has(tf)) return null;
  return evaluateStrategy(strategy, series.get(tf).slice(-(STRATEGY_LOOKBACK[strategy] || LOOKBACK)), params, series);
}

// ── Position management ───────────────────────────────────────────────────────

/**
 * Update an open position for a new base bar and decide whether it exits.
 * Mutates pos.stop for trailing stops. Stop is checked before target (the
 * conservative intrabar assumption, same as the trailing-stop backtests).
 *
 * @param pos   { side, entry, stop, target, initialStop?, tf?, trail?, biasFlip?, timeExitAt?, bandStop?, dipExit?, entryDay?, overnight? }
 * @param bar   the base bar
 * @param ctx   { series, completedTfs, nearTargetPct }
 * @returns {{ exitPrice, exitReason } | null}
 */
export function updatePosition(pos, bar, { series, completedTfs, nearTargetPct } = {}) {
  const nativeDone = series && pos.tf && completedTfs?.has(pos.tf);
  const native = nativeDone ? series.get(pos.tf) : null;

  if (native && pos.trail) {                         // ratchet on native bar closes
    const a = wilderAtr(native, pos.trail.atrPeriod) ?? pos.trail.atrAtEntry;
    const close = native[native.length - 1].close;
    const init = pos.initialStop ?? pos.stop;
    const risk = Math.abs(pos.entry - init);
    if (a) {
      if (pos.side === "buy") {
        pos.stop = Math.max(pos.stop, close - a * pos.trail.mult);
        if (risk > 0 && (close - pos.entry) / risk >= pos.trail.breakEvenR) pos.stop = Math.max(pos.stop, pos.entry);
      } else {
        pos.stop = Math.min(pos.stop, close + a * pos.trail.mult);
        if (risk > 0 && (pos.entry - close) / risk >= pos.trail.breakEvenR) pos.stop = Math.min(pos.stop, pos.entry);
      }
    }
  }

  // Dip-buy: rule-based exit at the signal time on a later session.
  if (native && pos.dipExit && series.daily?.length > 2) {
    const last = native[native.length - 1];
    const end = etInfo(last.time + pos.tf * 60_000);
    const D = series.daily;
    if (end.mins === hhmm(pos.dipExit.signalTime) && end.day !== pos.entryDay && D[D.length - 1].day === end.day) {
      const px = last.close;
      const held = D.length - 1 - D.findIndex(d => d.day === pos.entryDay);
      const rsi = rsi2Daily(D, px);
      if (rsi > pos.dipExit.rsiExit)    return { exitPrice: px, exitReason: "rsi2-exit" };
      if (px > D[D.length - 2].high)    return { exitPrice: px, exitReason: "above-prior-high" };
      if (held >= pos.dipExit.maxDays)  return { exitPrice: px, exitReason: "time" };
    }
  }

  const stopReason = pos.trail ? "trail-stop" : "stop";
  if (pos.side === "buy") {
    if (bar.low  <= pos.stop)   return { exitPrice: pos.stop,   exitReason: stopReason };
    if (bar.high >= pos.target) return { exitPrice: pos.target, exitReason: "target" };
  } else {
    if (bar.high >= pos.stop)   return { exitPrice: pos.stop,   exitReason: stopReason };
    if (bar.low  <= pos.target) return { exitPrice: pos.target, exitReason: "target" };
  }
  const nt = nearTargetTrigger(pos.side, pos.entry, pos.target, bar, nearTargetPct);
  if (nt != null) return { exitPrice: nt, exitReason: "near-target" };
  if (pos.timeExitAt && bar.time >= pos.timeExitAt) return { exitPrice: bar.close, exitReason: "time" };

  if (native && pos.bandStop) {                      // noise-momentum: close back through max(band, VWAP)
    const last = native[native.length - 1];
    if (etInfo(last.time + pos.tf * 60_000).mins % pos.bandStop.every === 0) {
      const day = etInfo(last.time).day, sess = [];
      for (let i = native.length - 1; i >= 0; i--) {
        const { day: d, mins } = etInfo(native[i].time);
        if (d !== day) break;
        if (mins >= MARKET_OPEN) sess.push(native[i]);
      }
      const vwap = vwapOf(sess) ?? pos.bandStop.level;
      const level = pos.side === "buy" ? Math.max(pos.bandStop.level, vwap) : Math.min(pos.bandStop.level, vwap);
      if (pos.side === "buy" ? last.close < level : last.close > level) return { exitPrice: last.close, exitReason: "band-stop" };
    }
  }

  if (native && pos.biasFlip) {                      // VWAP: exit when bias flips
    const closes = native.map(b => b.close);
    const day = etInfo(native[native.length - 1].time).day;
    const vwap = vwapOf(native.filter(b => etInfo(b.time).day === day));
    const ema8 = ema(closes, vwapMeta.params.emaPeriod);
    const price = closes[closes.length - 1];
    if (vwap && ema8 && checkBiasFlip(price, ema8, vwap, pos.side)) return { exitPrice: price, exitReason: "bias_flip" };
  }
  return null;
}

// ── Router decision ───────────────────────────────────────────────────────────

/** Regime on the same window backtest.js tags trades with (200 5-minute bars). */
export function currentRegime(series) {
  return classifyRegime(series.get(5).slice(-201));
}

/**
 * The router's entry decision for one symbol on one base bar, minus side
 * effects (orders, the LLM agent debate, the options planner). Mirrors the
 * gates in the live onRouterBar.
 *
 * @param o.state      per-symbol { series, position, strategiesTradedToday:Set }
 * @param o.crypto     24/7 symbol: no 9:45 gate, open-independent strategies only
 * @param o.symbol     the symbol (for cfg.strategySymbols whitelists)
 * @param o.completed  Set of timeframes completed by this bar
 * @param o.etMins     ET minutes of the bar
 * @param o.cfg        runtime config (runtime-config.js shape) + { strict, consensusMin }
 * @param o.day        { strategiesFiredToday:Set, tradesToday }
 * @param o.openCount  open positions across all symbols
 * @param o.halted     daily loss limit hit
 * @param o.statsLookup(strategy, regime) → { winRate, sampleSize, avgPnl } | null
 * @param o.paramsFor(strategy)          → learned params (or {})
 * @param o.predict(bars)                → ml/predictor.js predict()
 * @param o.extraCandidate(strategy)     → signal for non-bar strategies (tradingview) or undefined
 * @param o.onPrediction(ev, params)     → hook for the dashboard's prediction snapshots
 * @returns {{ enter: boolean, reason, regime?, decision?, prediction?, sizeMultiplier?, vetoed? }}
 */
export function decideEntry(o) {
  const { state: s, completed, etMins, cfg, day } = o;
  // Crypto trades 24/7, so only strategies that don't need a 9:30 ET open.
  // Per-strategy symbol whitelists (cfg.strategySymbols): no entry = all symbols.
  const onSymbol = st => !o.symbol || !cfg.strategySymbols?.[st] || cfg.strategySymbols[st].includes(o.symbol);
  // After the 3:45 EOD close only overnight strategies (which enter near the
  // close and hold) may still enter.
  const late = !o.crypto && etMins >= EOD_CLOSE;
  const active = (o.crypto ? cfg.activeStrategies.filter(x => CRYPTO_STRATEGIES.includes(x)) : cfg.activeStrategies)
    .filter(onSymbol).filter(x => !late || LATE_STRATEGIES.includes(x));
  if (late && !active.length)          return { enter: false, reason: "after 3:45 ET (EOD close)" };
  if (!active.length)                  return { enter: false, reason: "no strategies for this symbol" };
  const usedUp = st => st !== "tradingview" && s.strategiesTradedToday?.has(st);
  if (active.every(usedUp))            return { enter: false, reason: "all strategies used today" };
  if (!o.crypto && etMins < ENTRY_READY) return { enter: false, reason: "before 9:45 ET" };
  if (s.series.get(5).length < 20)     return { enter: false, reason: "warming up" };
  if (o.halted)                        return { enter: false, reason: "daily loss limit" };
  if (o.openCount >= cfg.maxConcurrentPositions) return { enter: false, reason: "max concurrent positions" };

  const candidates = active.filter(st => !usedUp(st)).map(strategy => {
    const extra = o.extraCandidate?.(strategy);
    if (extra !== undefined) return { strategy, signal: extra };
    if (strategy === "predictor") {
      if (!cfg.predictorSignalEnabled || !completed.has(STRATEGY_TF.predictor)) return { strategy, signal: null };
      const params = predictorParams(cfg, etMins, day.tradesToday || 0);
      const ev = evaluatePrediction(s.series.get(STRATEGY_TF.predictor).slice(-LOOKBACK), params);
      o.onPrediction?.(ev, params);
      return { strategy, signal: ev.signal ? { ...ev.signal, tf: STRATEGY_TF.predictor } : null };
    }
    return { strategy, signal: nativeCandidate(strategy, s.series, completed, o.paramsFor?.(strategy) || {}) };
  });
  // ICT targets: aim each signal at the nearest liquidity pool that pays at
  // least liquidityMinRR × risk; no such pool → no trade from that strategy.
  if (cfg.targetMode === "liquidity") {
    const bars5 = s.series.get(5).slice(-LOOKBACK);
    for (const c of candidates) {
      if (!c.signal || c.strategy === "tradingview") continue;
      const t = liquidityTarget(c.signal.side, c.signal.entry, c.signal.stop, bars5, cfg.liquidityMinRR);
      c.signal = t ? { ...c.signal, target: t.price, targetKind: t.kind, strategyTarget: c.signal.target } : null;
    }
  }
  // Most bars close no strategy's native bar: skip the regime work.
  if (!candidates.some(c => c.signal)) return { enter: false, reason: "no candidates fired" };

  const r = currentRegime(s.series);

  const decision = chooseSignal({
    candidates, regime: r.tag, statsLookup: o.statsLookup, todayState: day,
    strict: cfg.strict, consensusMin: cfg.consensusMin, scoreBy: cfg.routerScore,
  });
  if (!decision.chosen) return { enter: false, reason: decision.reason, regime: r.tag, decision };

  // Predictor gate: veto disagreeing trades, scale size by confidence. Uses
  // 5-minute bars — the bar size the model was trained on.
  const chosen = decision.chosen;
  let prediction = chosen.strategy === "predictor"
    ? { ...chosen.signal.prediction, side: chosen.signal.side, price: chosen.signal.entry }
    : null;
  let sizeMultiplier = 1.0;
  if (cfg.predictorEnabled && chosen.strategy !== "predictor") {
    try { prediction = o.predict(s.series.get(5).slice(-LOOKBACK)); } catch { prediction = null; }
    if (prediction) {
      const agrees = prediction.side === chosen.signal.side;
      if (cfg.predictorVeto && !agrees && prediction.confidence >= cfg.predictorMinConfidence) {
        return { enter: false, vetoed: true, reason: `predictor veto (${prediction.side} @ ${(prediction.confidence * 100).toFixed(0)}%)`, regime: r.tag, decision, prediction };
      }
      if (cfg.predictorSizeScaling) sizeMultiplier *= agrees ? (0.75 + prediction.confidence * 0.5) : 0.5;
    }
  }
  return { enter: true, reason: decision.reason, regime: r.tag, decision, prediction, sizeMultiplier };
}

/** Predictor thresholds with the two-tier daily-floor relaxation. */
export function predictorParams(cfg, etMins, tradesToday) {
  const [h, m] = String(cfg.floorTimeET || "14:30").split(":").map(Number);
  const t = effectiveThresholds({
    etMins, tradesToday,
    minTradesPerDay: cfg.minTradesPerDay,
    floorTimeMins:   h * 60 + (m || 0),
    base:  { minEdge: cfg.predictorMinEdge,      minConfidence: cfg.predictorSignalMinConf },
    floor: { minEdge: cfg.predictorMinEdgeFloor, minConfidence: cfg.predictorMinConfFloor },
  });
  return { ...predictorMeta.params, minEdge: t.minEdge, minConfidence: t.minConfidence, stopAtrMult: cfg.stopAtrMult, _tier: t.tier };
}
