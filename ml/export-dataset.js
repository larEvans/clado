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
 * The CSV columns are: <FEATURE_NAMES...>,fwd_return  (label is % either way,
 * so ml/train.py is unchanged.)
 */

import { writeFileSync } from "fs";
import "dotenv/config";
import { fetchCandles } from "../backtest.js";
import { extractFeatures, FEATURE_NAMES, MIN_BARS } from "./features.js";
import { atr } from "../indicators.js";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const symbols = (arg("symbols", process.env.PREDICTOR_SYMBOLS || "SPY,TSLA,QQQ,MSFT,META"))
  .split(",").map(s => s.trim()).filter(Boolean);
const interval  = arg("interval", process.env.PREDICTOR_INTERVAL || "5m");
const horizon   = Number(arg("horizon", process.env.PREDICTOR_HORIZON_BARS || 12)); // bars ahead to label
const outPath   = arg("out", "ml/dataset.csv");
const labelMode = arg("label", process.env.PREDICTOR_LABEL || "fwd"); // fwd | triple
const ptMult    = Number(arg("pt", 2.0));  // triple: profit barrier = ATR × this
const slMult    = Number(arg("sl", 1.5));  // triple: stop barrier   = ATR × this (matches STOP_ATR_MULT)
// Look back at least a full-length window so features are stable before labeling.
const WARMUP = Math.max(MIN_BARS, 30);

/**
 * Triple-barrier label at bar t (long-side convention; the model learns a
 * signed forward return either way — symmetric barriers keep it unbiased).
 * Returns the % return at the first barrier touched within `horizon` bars.
 */
function tripleBarrierLabel(candles, t, horizon, a) {
  const entry = candles[t].close;
  const upper = entry + a * ptMult;   // profit barrier
  const lower = entry - a * slMult;   // stop barrier
  for (let i = t + 1; i <= t + horizon && i < candles.length; i++) {
    const bar = candles[i];
    // Conservative intrabar ordering: check the stop first (worst case).
    if (bar.low <= lower)  return ((lower - entry) / entry) * 100;
    if (bar.high >= upper) return ((upper - entry) / entry) * 100;
  }
  // Time barrier: return at horizon
  const end = candles[Math.min(t + horizon, candles.length - 1)].close;
  return ((end - entry) / entry) * 100;
}

async function buildRows(symbol) {
  // yearWindow pulls the longest history Alpaca will give for the timeframe.
  const candles = await fetchCandles(symbol, interval, { yearWindow: true });
  const rows = [];
  for (let t = WARMUP; t + horizon < candles.length; t++) {
    const window = candles.slice(0, t + 1);            // bars up to and including t
    const feats = extractFeatures(window);
    const now = candles[t].close;
    if (!now) continue;

    let label;
    if (labelMode === "triple") {
      const a = atr(window, 14);
      if (!a) continue;
      label = tripleBarrierLabel(candles, t, horizon, a);
    } else {
      const future = candles[t + horizon].close;
      if (!future) continue;
      label = ((future - now) / now) * 100;             // plain forward return in %
    }
    if (!Number.isFinite(label)) continue;
    rows.push([...feats, label]);
  }
  return rows;
}

async function main() {
  console.log(`Building dataset: ${symbols.join(", ")} · ${interval} · horizon ${horizon} bars · label=${labelMode}${labelMode === "triple" ? ` (pt ${ptMult}×ATR / sl ${slMult}×ATR)` : ""}`);
  const allRows = [];
  for (const sym of symbols) {
    try {
      const rows = await buildRows(sym);
      console.log(`  ${sym}: ${rows.length} samples`);
      allRows.push(...rows);
    } catch (e) {
      console.warn(`  ${sym}: skipped — ${e.message}`);
    }
  }
  if (allRows.length === 0) {
    console.error("No samples produced. Check ALPACA_API_KEY / symbols.");
    process.exit(1);
  }
  const header = [...FEATURE_NAMES, "fwd_return"].join(",");
  const body = allRows.map(r => r.map(x => (Number.isFinite(x) ? x.toFixed(6) : "0")).join(",")).join("\n");
  writeFileSync(outPath, header + "\n" + body + "\n");
  console.log(`Wrote ${allRows.length} rows → ${outPath}`);
  console.log(`Now train:  python ml/train.py --data ${outPath} --horizon ${horizon} --interval ${interval}`);
}

main().catch(e => { console.error(e); process.exit(1); });
