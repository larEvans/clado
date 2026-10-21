/**
 * Strategy-fit screener — which symbols suit hybrid10 / vwap-reclaim?
 *
 * For every symbol in the universe, backtest each strategy (the same
 * backtest.js runners the router's stats come from) on ~2 years of 5m bars
 * and split the trades by time:
 *   selection half   the OLDER year — what a symbol is picked on
 *   test half        the NEWER year — how picks actually did afterwards
 * A symbol "fits" a strategy only if it is profitable in BOTH halves, after
 * an assumed round-trip cost, with enough trades. Ranking by one period alone
 * mostly finds luck; the second half shows whether that luck repeated.
 *
 * Also checks 0DTE tradability (both strategies trade 0DTE options live):
 * expiries per week and the current near-the-money option spread. Alpaca's
 * free options feed is indicative, so spreads are estimates.
 *
 *   node strategy-screener.js                          # core universe
 *   node strategy-screener.js --most-actives=30        # + today's most-active names
 *   node strategy-screener.js --symbols=AAPL,NVDA,AMD  # just these
 *
 * Writes DATA_DIR/strategy-screener.json (the dashboard reads it).
 */

import "dotenv/config";
import { writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { resolve } from "path";
import { cachedCandles, runBacktest } from "./backtest.js";
import { fetchContracts, fetchSnapshots } from "./options.js";
import { dataPath } from "./state.js";

export const SCREENER_FILE = dataPath("strategy-screener.json");

// Liquid, optionable US stocks and ETFs.
export const CORE_UNIVERSE = [
  "SPY", "QQQ", "IWM", "DIA", "SMH", "XLF", "XLK", "XLE", "XLV", "XLI", "XLY", "TLT", "GLD", "SLV",
  "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AMD", "AVGO", "NFLX", "CRM", "ORCL", "ADBE",
  "INTC", "MU", "QCOM", "COIN", "MSTR", "PLTR", "UBER", "SHOP", "BA", "JPM", "BAC", "WFC", "GS",
  "XOM", "CVX", "UNH", "LLY", "JNJ", "PFE", "WMT", "COST", "HD", "NKE", "DIS",
];

const STRATEGIES = ["hybrid10", "vwap-reclaim"];
const DEFAULTS = { days: 730, costPct: 0.02, minTradesPerHalf: 20 };

const H = () => ({ "APCA-API-KEY-ID": process.env.ALPACA_API_KEY, "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY });

/** Today's most-active names priced ≥ minPrice (drops penny stocks). */
export async function mostActives(top = 30, minPrice = 10) {
  const res = await fetch(`https://data.alpaca.markets/v1beta1/screener/stocks/most-actives?by=volume&top=${Math.min(100, top * 3)}`, { headers: H() });
  if (!res.ok) return [];
  const syms = ((await res.json()).most_actives || []).map(x => x.symbol).filter(s => /^[A-Z]{1,5}$/.test(s));
  const q = await fetch(`https://data.alpaca.markets/v2/stocks/snapshots?symbols=${syms.join(",")}&feed=iex`, { headers: H() });
  const snaps = q.ok ? await q.json() : {};
  return syms.filter(s => (snaps[s]?.latestTrade?.p ?? snaps[s]?.dailyBar?.c ?? 0) >= minPrice).slice(0, top);
}

/** Expiries in the next 7 calendar days and a near-the-money spread estimate. */
async function optionsFit(symbol, price) {
  const today = new Date().toISOString().slice(0, 10);
  const week = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  let contracts = [];
  try { contracts = await fetchContracts({ underlying: symbol, expDateGte: today, expDateLte: week, strikeGte: price * 0.98, strikeLte: price * 1.02, limit: 1000 }); } catch {}
  const expiries = [...new Set(contracts.map(c => c.expiration_date))].sort();
  let spreadPct = null;
  if (expiries.length) {
    const snaps = await fetchSnapshots(symbol, { expDate: expiries[0], strikeGte: price * 0.99, strikeLte: price * 1.01 });
    const spreads = Object.values(snaps).map(s => s.latestQuote).filter(q => q?.ap > 0 && q?.bp > 0)
      .map(q => (q.ap - q.bp) / ((q.ap + q.bp) / 2) * 100);
    if (spreads.length) spreadPct = +(spreads.sort((a, b) => a - b)[Math.floor(spreads.length / 2)]).toFixed(1);
  }
  return { expiriesPerWeek: expiries.length, nearestExpiry: expiries[0] || null, atmSpreadPct: spreadPct };
}

function halfStats(trades, costPct) {
  if (!trades.length) return { trades: 0, winRate: null, expectancyR: null, netR: null };
  // Cost in R per trade = round-trip cost ÷ that trade's stop distance.
  const net = trades.map(t => t.pnlR - costPct / Math.max(1e-6, Math.abs(t.entry - t.stop) / t.entry * 100));
  return {
    trades: trades.length,
    winRate: +(trades.filter(t => t.pnlR > 0).length / trades.length * 100).toFixed(1),
    expectancyR: +(trades.reduce((a, t) => a + t.pnlR, 0) / trades.length).toFixed(3),
    netR: +(net.reduce((a, b) => a + b, 0) / net.length).toFixed(3),
  };
}

/** Screen one symbol for both strategies. */
async function screenSymbol(symbol, o) {
  const candles = await cachedCandles(symbol, "5m", { days: o.days, cap: 5_000_000 });
  if (candles.length < 5000) throw new Error(`only ${candles.length} bars`);
  const split = candles[Math.floor(candles.length / 2)].time;       // older half | newer half
  const price = candles[candles.length - 1].close;
  const rth = candles.filter(c => { const d = new Date(c.time); const m = d.getUTCHours() * 60 + d.getUTCMinutes(); return m >= 13 * 60 + 30 && m < 21 * 60; });
  const days = new Set(rth.map(c => new Date(c.time).toISOString().slice(0, 10))).size || 1;
  const dollarVol = rth.reduce((a, c) => a + c.close * c.volume, 0) / days;
  const out = { symbol, price: +price.toFixed(2), iexDollarVolume: Math.round(dollarVol), strategies: {} };
  for (const strategy of STRATEGIES) {
    const { trades = [] } = await runBacktest(strategy, symbol, { _candles: candles, mode: "stock" });
    const sel = halfStats(trades.filter(t => t.entryTime < split), o.costPct);
    const test = halfStats(trades.filter(t => t.entryTime >= split), o.costPct);
    const fits = sel.trades >= o.minTradesPerHalf && test.trades >= o.minTradesPerHalf && sel.netR > 0 && test.netR > 0;
    out.strategies[strategy] = { selection: sel, test, fits };
  }
  out.options = await optionsFit(symbol, price);
  return out;
}

/**
 * Screen a universe. Returns { generatedAt, params, rows, validation }.
 * `validation` answers "does picking on the older year work?": the newer-year
 * result of symbols that looked good in the older year vs those that didn't.
 */
export async function screenStrategyFit({ symbols = CORE_UNIVERSE, days = DEFAULTS.days, costPct = DEFAULTS.costPct, minTradesPerHalf = DEFAULTS.minTradesPerHalf, log = console.log } = {}) {
  const o = { days, costPct, minTradesPerHalf };
  const rows = [];
  for (const symbol of symbols) {
    try {
      const r = await screenSymbol(symbol, o);
      rows.push(r);
      log(`  ${symbol.padEnd(5)} ${STRATEGIES.map(s => `${s} ${r.strategies[s].selection.netR ?? "—"} → ${r.strategies[s].test.netR ?? "—"}R${r.strategies[s].fits ? " ✓" : ""}`).join("  |  ")}  · 0DTE ${r.options.expiriesPerWeek}/wk`);
    } catch (e) { log(`  ${symbol}: skipped — ${e.message}`); }
  }
  const validation = {};
  for (const s of STRATEGIES) {
    const ok = rows.map(r => r.strategies[s]).filter(x => x.selection.trades >= minTradesPerHalf && x.test.trades >= minTradesPerHalf);
    const avg = xs => xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3) : null;
    const picked = ok.filter(x => x.selection.netR > 0), rest = ok.filter(x => !(x.selection.netR > 0));
    validation[s] = {
      pickedOnOlderYear: picked.length, newerYearNetR_picked: avg(picked.map(x => x.test.netR)),
      notPicked: rest.length, newerYearNetR_notPicked: avg(rest.map(x => x.test.netR)),
    };
  }
  const result = { generatedAt: new Date().toISOString(), params: { ...o, strategies: STRATEGIES }, rows, validation };
  writeFileSync(SCREENER_FILE, JSON.stringify(result, null, 2));
  return result;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const arg = (n, d) => process.argv.find(a => a.startsWith(`--${n}=`))?.split("=")[1] ?? d;
  let symbols = arg("symbols") ? arg("symbols").split(",").map(s => s.trim().toUpperCase()) : [...CORE_UNIVERSE];
  const extra = parseInt(arg("most-actives", "0"));
  if (extra > 0) symbols = [...new Set([...symbols, ...(await mostActives(extra))])];
  console.log(`Screening ${symbols.length} symbols · ${arg("days", DEFAULTS.days)} days of 5m bars · cost ${arg("cost", DEFAULTS.costPct)}% round trip`);
  const r = await screenStrategyFit({ symbols, days: parseInt(arg("days", DEFAULTS.days)), costPct: parseFloat(arg("cost", DEFAULTS.costPct)) });
  for (const s of STRATEGIES) {
    const fits = r.rows.filter(x => x.strategies[s].fits).sort((a, b) => b.strategies[s].test.netR - a.strategies[s].test.netR);
    console.log(`\n== ${s}: ${fits.length} fit (profitable after costs in BOTH years, ≥${r.params.minTradesPerHalf} trades each)`);
    for (const x of fits) {
      const st = x.strategies[s];
      console.log(`  ${x.symbol.padEnd(5)} older ${String(st.selection.netR).padStart(7)}R (${st.selection.trades})  newer ${String(st.test.netR).padStart(7)}R (${st.test.trades})  win ${st.test.winRate}%  · 0DTE ${x.options.expiriesPerWeek}/wk, spread ${x.options.atmSpreadPct ?? "?"}%`);
    }
    const v = r.validation[s];
    console.log(`  check: symbols positive in the older year → newer year ${v.newerYearNetR_picked}R avg (${v.pickedOnOlderYear}); the rest → ${v.newerYearNetR_notPicked}R (${v.notPicked})`);
  }
  console.log(`\nWrote ${SCREENER_FILE}`);
}
