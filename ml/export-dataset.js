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
 * The CSV columns are: <FEATURE_NAMES...>,fwd_return  (fwd_return is the % label)
 */

import { writeFileSync } from "fs";
import "dotenv/config";
import { fetchCandles } from "../backtest.js";
import { extractFeatures, FEATURE_NAMES, MIN_BARS } from "./features.js";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const symbols = (arg("symbols", process.env.PREDICTOR_SYMBOLS || "SPY,QQQ,AAPL,MSFT,NVDA,TSLA,AMD,META"))
  .split(",").map(s => s.trim()).filter(Boolean);
const interval  = arg("interval", process.env.PREDICTOR_INTERVAL || "5m");
const horizon   = Number(arg("horizon", process.env.PREDICTOR_HORIZON_BARS || 12)); // bars ahead to label
const outPath   = arg("out", "ml/dataset.csv");
// Look back at least a full-length window so features are stable before labeling.
const WARMUP = Math.max(MIN_BARS, 30);

async function buildRows(symbol) {
  // yearWindow pulls the longest history Alpaca will give for the timeframe.
  const candles = await fetchCandles(symbol, interval, { yearWindow: true });
  const rows = [];
  for (let t = WARMUP; t + horizon < candles.length; t++) {
    const window = candles.slice(0, t + 1);            // bars up to and including t
    const feats = extractFeatures(window);
    const now = candles[t].close;
    const future = candles[t + horizon].close;
    if (!now || !future) continue;
    const fwdReturn = ((future - now) / now) * 100;     // label: forward return in %
    if (!Number.isFinite(fwdReturn)) continue;
    rows.push([...feats, fwdReturn]);
  }
  return rows;
}

async function main() {
  console.log(`Building dataset: ${symbols.join(", ")} · ${interval} · horizon ${horizon} bars`);
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
