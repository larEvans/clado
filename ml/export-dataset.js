/**
 * ml/export-dataset.js — build the supervised training set for the price model.
 *
 * For every symbol we fetch historical candles and slide a window across them:
 * at each bar t we compute the SAME feature vector the live bot uses
 * (ml/features.js) and label it with the realized forward return over the next
 * H bars — that's exactly what the model learns to forecast.
 *
 *   node ml/export-dataset.js --symbols SPY,QQQ,AAPL --interval 5m --horizon 12 --out ml/dataset.csv
 *
 * Defaults come from env so it matches the live predictor:
 *   PREDICTOR_SYMBOLS, PREDICTOR_INTERVAL (5m), PREDICTOR_HORIZON_BARS (12)
 *
 * Labeling (--label):
 *   fwd     — plain forward return over `horizon` bars (default)
 *   triple  — triple-barrier (López de Prado): profit barrier at +ATR×ptMult,
 *             stop barrier at −ATR×slMult, time barrier at `horizon` bars.
 *             The label is the % return realized at the FIRST barrier touched,
 *             which matches how the live bot actually exits (target/stop/time)
 *             far better than a fixed-horizon return does.
 *
 * 0DTE preset (--preset=0dte, = --label=triple --exit-bars=1m --session-only):
 *   --exit-bars=1m   walk the label's price path on 1-minute bars, so the
 *                    barrier that was really touched first decides the label
 *                    (5m bars can't tell stop-vs-target inside one bar)
 *   --session-only   only rows the live bot could trade (9:45-15:45 ET), and
 *                    labels end at the 15:45 EOD close: nothing crosses the
 *                    session close, as with a same-day expiry
 *
 * The CSV columns are: ts,symbol,label_end_ts,<FEATURE_NAMES...>,fwd_return
 * (label is % either way). ts = time (epoch ms) of the bar the features describe;
 * label_end_ts = time of the last bar the label looks at. ml/train.py uses both
 * for a time-ordered, purged train/test split — they are not model features.
 */

import { writeFileSync } from "fs";
import "dotenv/config";
import { cachedCandles } from "../backtest.js";
import { etInfo, sessionOpenMs, ENTRY_READY, EOD_CLOSE } from "../signals.js";
import { extractFeatures, FEATURE_NAMES, MIN_BARS } from "./features.js";
import { atr } from "../indicators.js";

// Accepts both `--name value` and `--name=value`.
function arg(name, fallback) {
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const symbols = (arg("symbols", process.env.PREDICTOR_SYMBOLS || "SPY,TSLA,QQQ,MSFT,META"))
  .split(",").map(s => s.trim()).filter(Boolean);
const interval  = arg("interval", process.env.PREDICTOR_INTERVAL || "5m");
const horizon   = Number(arg("horizon", process.env.PREDICTOR_HORIZON_BARS || 12)); // bars ahead to label
const outPath   = arg("out", "ml/dataset.csv");
const preset    = arg("preset", "");                                  // "0dte"
const labelMode = arg("label", preset === "0dte" ? "triple" : (process.env.PREDICTOR_LABEL || "fwd")); // fwd | triple
const exitBars  = arg("exit-bars", preset === "0dte" ? "1m" : interval);   // bars the label path is walked on
const sessionOnly = process.argv.includes("--session-only") || preset === "0dte";
const days      = Number(arg("days", 365));
const LIVE_BARS = 600;   // the live bot keeps the last 600 bars per timeframe (signals.js)
const ptMult    = Number(arg("pt", 2.0));  // triple: profit barrier = ATR × this
const slMult    = Number(arg("sl", 1.5));  // triple: stop barrier   = ATR × this (matches STOP_ATR_MULT)
// Look back at least a full-length window so features are stable before labeling.
const WARMUP = Math.max(MIN_BARS, 30);

/**
 * Triple-barrier label at bar t (long-side convention; the model learns a
 * signed forward return either way — symmetric barriers keep it unbiased).
 * Returns { label, endIdx }: the % return at the first barrier touched within
 * `horizon` bars, and the index of the bar where that happened.
 */
function tripleBarrierLabel(candles, t, horizon, a) {
  const entry = candles[t].close;
  const upper = entry + a * ptMult;   // profit barrier
  const lower = entry - a * slMult;   // stop barrier
  for (let i = t + 1; i <= t + horizon && i < candles.length; i++) {
    const bar = candles[i];
    // Conservative intrabar ordering: check the stop first (worst case).
    if (bar.low <= lower)  return { label: ((lower - entry) / entry) * 100, endIdx: i };
    if (bar.high >= upper) return { label: ((upper - entry) / entry) * 100, endIdx: i };
  }
  // Time barrier: return at horizon
  const endIdx = Math.min(t + horizon, candles.length - 1);
  return { label: ((candles[endIdx].close - entry) / entry) * 100, endIdx };
}

const TF_MS = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1H": 3_600_000 };

/** First index in sorted `bars` with time >= ms. */
function lowerBound(bars, ms) {
  let lo = 0, hi = bars.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (bars[mid].time < ms) lo = mid + 1; else hi = mid; }
  return lo;
}

/**
 * Label from a finer bar path: entry at `entry` at time `from`, walk `path`
 * bars in [from, until). Triple barrier (stop checked first) or plain forward
 * return at the last bar. Returns { label, endTs } or null.
 */
function pathLabel(path, from, until, entry, a) {
  let i = lowerBound(path, from);
  let last = null;
  const upper = a ? entry + a * ptMult : null, lower = a ? entry - a * slMult : null;
  for (; i < path.length && path[i].time < until; i++) {
    const b = path[i];
    last = b;
    if (a && b.low <= lower)  return { label: ((lower - entry) / entry) * 100, endTs: b.time };
    if (a && b.high >= upper) return { label: ((upper - entry) / entry) * 100, endTs: b.time };
  }
  if (!last) return null;
  return { label: ((last.close - entry) / entry) * 100, endTs: last.time };
}

async function buildRows(symbol) {
  const candles = await cachedCandles(symbol, interval, { days, cap: 5_000_000 });
  const path = exitBars !== interval ? await cachedCandles(symbol, exitBars, { days, cap: 5_000_000 }) : null;
  const barMs = TF_MS[interval] || 300_000;
  const rows = [];
  for (let t = WARMUP; t + horizon < candles.length; t++) {
    const entryTs = candles[t].time + barMs;            // decision at the bar's close
    let until = entryTs + horizon * barMs;
    if (sessionOnly) {
      const { mins } = etInfo(entryTs);
      if (mins < ENTRY_READY || mins >= EOD_CLOSE) continue;
      until = Math.min(until, sessionOpenMs(entryTs) + (EOD_CLOSE - 570) * 60_000);
    }
    const window = candles.slice(Math.max(0, t - LIVE_BARS + 1), t + 1);   // what the live bot has
    const feats = extractFeatures(window);
    const now = candles[t].close;
    if (!now) continue;

    let label, labelEndTs;
    const a = labelMode === "triple" ? atr(window, 14) : null;
    if (labelMode === "triple" && !a) continue;
    if (path || sessionOnly) {
      // Walk the label on the finer path (or on these bars, capped at the close).
      const r = pathLabel(path || candles, entryTs, until, now, a);
      if (!r) continue;
      ({ label, endTs: labelEndTs } = r);
    } else if (labelMode === "triple") {
      const r = tripleBarrierLabel(candles, t, horizon, a);
      label = r.label; labelEndTs = candles[r.endIdx].time;
    } else {
      const future = candles[t + horizon].close;
      if (!future) continue;
      label = ((future - now) / now) * 100;             // plain forward return in %
      labelEndTs = candles[t + horizon].time;
    }
    if (!Number.isFinite(label)) continue;
    rows.push({ ts: candles[t].time, symbol, labelEndTs, values: [...feats, label] });
  }
  return rows;
}

async function main() {
  console.log(`Building dataset: ${symbols.join(", ")} · ${interval} · horizon ${horizon} bars · label=${labelMode}${labelMode === "triple" ? ` (pt ${ptMult}×ATR / sl ${slMult}×ATR)` : ""} · label path ${exitBars}${sessionOnly ? " · session only (9:45-15:45 ET, no overnight)" : ""}`);
  const allRows = [];
  for (const sym of symbols) {
    try {
      const rows = await buildRows(sym);
      console.log(`  ${sym}: ${rows.length} samples`);
      for (const r of rows) allRows.push(r);
    } catch (e) {
      console.warn(`  ${sym}: skipped — ${e.message}`);
    }
  }
  if (allRows.length === 0) {
    console.error("No samples produced. Check ALPACA_API_KEY / symbols.");
    process.exit(1);
  }
  allRows.sort((a, b) => a.ts - b.ts);   // chronological across symbols
  const header = ["ts", "symbol", "label_end_ts", ...FEATURE_NAMES, "fwd_return"].join(",");
  const body = allRows.map(r => [
    r.ts, r.symbol, r.labelEndTs,
    ...r.values.map(x => (Number.isFinite(x) ? x.toFixed(6) : "0")),
  ].join(",")).join("\n");
  writeFileSync(outPath, header + "\n" + body + "\n");
  console.log(`Wrote ${allRows.length} rows → ${outPath}`);
  console.log(`Now train:  python ml/train.py --data ${outPath} --horizon ${horizon} --interval ${interval}`);
}

main().catch(e => { console.error(e); process.exit(1); });
