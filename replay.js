/**
 * Full replay backtest — runs the LIVE router over historical bars.
 *
 * Every symbol's bars are merged into one time-ordered stream and fed through
 * the same code the live bot runs (signals.js): multi-timeframe bars, each
 * strategy's entry check on its native bars, the router's gates and choice,
 * the predictor veto + confidence sizing, trailing stops, near-target and EOD
 * exits, max concurrent positions and the daily loss limit. So the result is
 * what the combined system would have done, not one strategy in isolation.
 *
 *   node replay.js                       # past year of 1-minute bars, settings from .env / bot-config.json
 *   node replay.js --compare-gate        # same run with the predictor gate on AND off
 *   node replay.js --base=5m             # coarser and faster: 5-minute bars
 *   node replay.js --mode=options        # price trades as options (Black-Scholes)
 *
 * Entries and exits run on 1-minute bars, like the live bot: a strategy
 * decides when its native (5/15/60m) bar closes, the order fills at the NEXT
 * 1-minute bar's open, and stops/targets are checked on every 1-minute bar.
 *
 * Honest by construction:
 *  - Router win-rate stats are walk-forward: at each moment the router only
 *    knows standalone-backtest trades that had already closed (the live bot's
 *    stats come from the same kind of backtests, via "Bootstrap from Backtest").
 *  - With a trained model, trading starts at its test_start (data it never saw).
 *  - The first WARMUP_DAYS only fill indicator buffers; no trades.
 *
 * Not simulated: the LLM agent debate (AGENT_DEBATE), the LLM options planner
 * (options use ATM-ish Black-Scholes pricing, no bid/ask spread), TradingView
 * alerts, crypto, and slippage/commissions.
 */

import "dotenv/config";
import { fileURLToPath } from "url";
import { resolve } from "path";
import { cachedCandles, runBacktest, optionPremium } from "./backtest.js";
import { varianceDays } from "./et.js";
import { SymbolSeries, decideEntry, updatePosition, etInfo, sessionOpenMs, STRATEGY_TF, SUPPORTED_STRATEGIES, EOD_CLOSE, MARKET_OPEN, MARKET_CLOSE } from "./signals.js";
import { loadRuntimeConfig } from "./runtime-config.js";
import { predict, modelInfo } from "./ml/predictor.js";
import { loadLearnedParams, getEarlyExitConfig } from "./learner.js";
import { loadSymbols } from "./symbols.js";

const DAY_MS = 86_400_000;

// ── Data ──────────────────────────────────────────────────────────────────────

/**
 * Fetch bars for every symbol plus the standalone-backtest trades that feed
 * the router's walk-forward stats. Separate from simulate() so --compare-gate
 * runs both variants on identical data.
 */
export async function loadReplayData({ symbols = loadSymbols(), base = "1m", days = 365, strategies, strategyParams = {}, withStats = true, log = console.log } = {}) {
  const bars = {};
  for (const sym of symbols) {
    bars[sym] = (await cachedCandles(sym, base, { days, cap: 5_000_000 })).map(b => ({ ...b, symbol: sym }));
    log(`  ${sym}: ${bars[sym].length} ${base} bars`);
  }
  const statTrades = [];
  if (withStats) {
    for (const strategy of strategies) {
      for (const sym of symbols) {
        try {
          const r = await runBacktest(strategy, sym, { yearWindow: true, mode: "stock", params: strategyParams[strategy] });
          for (const t of r.trades || []) {
            if (t.exitTime) statTrades.push({ strategy, regime: t.regime || "unknown", exitTime: t.exitTime, win: (t.pnlPct || 0) > 0, pnlPct: t.pnlPct || 0 });
          }
        } catch (e) { log(`  stats ${strategy}/${sym} skipped: ${e.message}`); }
      }
    }
    statTrades.sort((a, b) => a.exitTime - b.exitTime);
    log(`  router stats: ${statTrades.length} standalone-backtest trades (used walk-forward)`);
  }
  return { symbols, base, baseMinutes: base === "1m" ? 1 : 5, bars, statTrades };
}

// ── Simulation ────────────────────────────────────────────────────────────────

/** Router stats that only include trades closed before the replay clock. */
class WalkForwardStats {
  constructor(trades) { this.trades = trades; this.i = 0; this.cells = new Map(); }
  advance(t) {
    while (this.i < this.trades.length && this.trades[this.i].exitTime < t) {
      const x = this.trades[this.i++];
      const k = `${x.strategy}|${x.regime}`;
      const c = this.cells.get(k) || { wins: 0, total: 0, sumPnl: 0 };
      c.total++; c.sumPnl += x.pnlPct; if (x.win) c.wins++;
      this.cells.set(k, c);
    }
  }
  // Same shape and semantics as learner.getRegimeStats (regime null → no stats).
  lookup = (strategy, regime) => {
    const c = this.cells.get(`${strategy}|${regime}`);
    return c ? { winRate: c.wins / c.total, sampleSize: c.total, avgPnl: c.sumPnl / c.total } : null;
  };
}

/** The rule-based options exit triggers agents-options.js uses (by DTE). */
function optionTriggers(dte) {
  const d = Math.max(1, dte);
  return { profitTargetPct: d <= 1 ? 35 : d <= 3 ? 50 : 60, maxLossPct: d <= 1 ? 40 : 50, timeExitMinutes: d <= 1 ? 60 : d <= 3 ? 180 : 300 };
}

// Expiry calendars as currently listed on Alpaca: index ETFs expire every
// weekday; single stocks (TSLA, MSFT, META, ...) Mon/Wed/Fri. Assumed for the
// whole replay window; holidays are ignored.
const DAILY_EXPIRY = new Set(["SPY", "QQQ", "IWM"]);

/** 4:00 PM ET on the first listed expiry ≥ `dte` calendar days after entry —
 *  what the live planner buys (dte 0 = same day, else the next listed date). */
function expiryMs(sym, entryMs, dte) {
  let t = sessionOpenMs(entryMs) + 6.5 * 3600_000 + dte * DAY_MS;
  for (let k = 0; k < 10; k++, t += DAY_MS) {
    const dow = new Date(sessionOpenMs(t)).getUTCDay();
    if (dow >= 1 && dow <= 5 && (DAILY_EXPIRY.has(sym) || dow % 2 === 1)) return sessionOpenMs(t) + 6.5 * 3600_000;
  }
  return t;
}

// Time to expiry for optionPremium (which takes calendar days / 365), measured
// in trading variance so it matches volatilities annualized over 252 trading
// days — plain calendar time made same-day options far too cheap.
const yearsLeft = (expiry, ms) => Math.max(varianceDays(ms, expiry) * 365 / 252, 1 / 1440);

/**
 * Run the router over loaded data.
 * @param data  loadReplayData() result
 * @param o.cfg        runtime config overrides (e.g. { predictorEnabled: false })
 * @param o.mode       "stock" | "options"
 * @param o.iv         implied vol for option pricing (annualized, e.g. 0.3)
 * @param o.tradeUSD   MAX_TRADE_SIZE_USD
 * @param o.includeInSample  trade a trained model's training period too
 */
export function simulate(data, o = {}) {
  const cfg = {
    ...loadRuntimeConfig(),
    strict:       process.env.STRICT_ROUTER === "true",
    consensusMin: Math.max(1, parseInt(process.env.CONSENSUS_MIN || "1")),
    ...(o.cfg || {}),
  };
  cfg.activeStrategies = cfg.activeStrategies.filter(x => SUPPORTED_STRATEGIES.includes(x));
  const mode      = o.mode || (cfg.optionsMode ? "options" : "stock");
  const iv        = o.iv ?? 0.3;
  const tradeUSD  = o.tradeUSD ?? parseFloat(process.env.MAX_TRADE_SIZE_USD || "200");
  const maxLoss   = Math.max(0, parseFloat(process.env.MAX_DAILY_LOSS_PCT || "0"));
  const warmupMs  = (o.warmupDays ?? parseInt(process.env.WARMUP_DAYS || "21")) * DAY_MS;
  const baseMs    = data.baseMinutes * 60_000;

  // Where trading may start: after warm-up, and after a trained model's
  // training data if the model takes part (gate or signal).
  const stream = Object.values(data.bars).flat().sort((a, b) => a.time - b.time);
  if (!stream.length) throw new Error("no bars to replay");
  let tradeStart = Math.max(stream[0].time + warmupMs, o.tradeStartMs || 0);
  const info = modelInfo();
  const modelUsed = cfg.predictorEnabled || (cfg.predictorSignalEnabled && cfg.activeStrategies.includes("predictor"));
  let modelNote = modelUsed ? (info ? "xgboost" : "heuristic (no trained model)") : "not used";
  if (modelUsed && info?.split?.test_start_ms && !o.includeInSample) {
    tradeStart = Math.max(tradeStart, info.split.test_start_ms);
    modelNote += `, out-of-sample from ${info.split.test_start_iso.slice(0, 10)}`;
  } else if (modelUsed && info && !o.includeInSample) {
    modelNote += " — WARNING: no time-split record, so the gate is scored in-sample";
  }

  const stats = new WalkForwardStats(data.statTrades || []);
  const statsLookup = data.statTrades?.length ? stats.lookup : () => null;
  const states = new Map(data.symbols.map(sym => [sym, { series: new SymbolSeries(data.baseMinutes), position: null, strategiesTradedToday: new Set() }]));
  const day = { date: "", strategiesFiredToday: new Set(), tradesToday: 0 };
  const dayPnl = { date: "", pct: 0, halted: false };
  const trades = [];
  const counts = { vetoed: 0, entries: 0, reasons: {} };
  const learned = {};
  const paramsFor = st => (learned[st] ??= { ...(loadLearnedParams(st) || {}), ...(o.strategyParams?.[st] || {}) });
  const tradingDays = new Set();

  // Fill a pending entry at `bar.open`. Stop/target stay at the signal's
  // levels; a fill already beyond the stop is stopped out at the open.
  const open = (sym, st, dec, bar) => {
    const { strategy, signal } = dec.decision.chosen;
    const fill = bar.open;
    const usd = tradeUSD / Math.min(cfg.maxConcurrentPositions, data.symbols.length) * (dec.sizeMultiplier ?? 1);
    const pos = {
      side: signal.side, entry: fill, stop: signal.stop, target: signal.target,
      initialStop: signal.stop, tf: signal.tf || STRATEGY_TF[strategy],
      ...(signal.trail ? { trail: signal.trail } : {}), ...(signal.biasFlip ? { biasFlip: true } : {}),
      ...(signal.timeExitAt ? { timeExitAt: signal.timeExitAt } : {}),
      ...(signal.bandStop ? { bandStop: signal.bandStop } : {}),
      ...(signal.eodMins ? { eodMins: signal.eodMins } : {}),
      ...(signal.overnight ? { overnight: true, entryDay: signal.entryDay, dipExit: signal.dipExit } : {}),
      strategy, regime: dec.regime, entryTime: bar.time, signalPrice: signal.entry, targetKind: signal.targetKind || null,
      meta: signal.meta || null,
      sizeMultiplier: dec.sizeMultiplier ?? 1, usd, prediction: dec.prediction || null,
    };
    if (mode === "options" && !(cfg.stockOnlyStrategies || []).includes(strategy)) {
      // Strike/expiry the way enterRouterTrade chooses them (the LLM planner
      // then picks a real contract near these; here we price one with BS).
      const pred = dec.prediction;
      const usePred = (cfg.predictorEnabled || cfg.predictorSignalEnabled) && pred && pred.side === signal.side;
      let strikeTarget = signal.target;
      if (usePred) strikeTarget = cfg.strikeMode === "atm" ? fill : cfg.strikeMode === "target" ? pred.priceTarget : (fill + pred.priceTarget) / 2;
      const dte = cfg.optionsDte === 0 ? 0
        : usePred ? Math.max(1, (pred.horizonDays || cfg.optionsDte) + cfg.optionsDteBuffer)
        : cfg.optionsDte;
      const expiry = expiryMs(sym, bar.time, dte);
      const type = signal.side === "buy" ? "call" : "put";
      const strike = Math.round(strikeTarget);
      const entryPremium = optionPremium(fill, strike, yearsLeft(expiry, bar.time), iv, type);
      if (!(entryPremium > 0.01)) return;          // worthless contract: the planner would refuse it
      const contracts = Math.max(1, Math.floor(usd / (entryPremium * 100)));
      const daysOut = Math.round((expiry - sessionOpenMs(bar.time) - 6.5 * 3600_000) / DAY_MS);
      let triggers = optionTriggers(daysOut);
      if (cfg.targetMode === "liquidity") triggers = { ...triggers, profitTargetPct: Infinity, timeExitMinutes: Infinity };   // as live
      pos.option = { type, strike, dte: daysOut, expiry, entryPremium, contracts, triggers };
    }
    st.position = pos;
    const gapped = pos.side === "buy" ? fill <= pos.stop : fill >= pos.stop;
    if (gapped) close(sym, st, fill, "stop", bar);
  };

  const close = (sym, st, exitPrice, exitReason, bar) => {
    const p = st.position;
    const dir = p.side === "buy" ? 1 : -1;
    const pnlPct = dir * (exitPrice - p.entry) / p.entry * 100;
    const risk = Math.abs(p.entry - p.initialStop);
    const t = {
      symbol: sym, strategy: p.strategy, regime: p.regime, side: p.side,
      entryTime: p.entryTime, exitTime: bar.time, entry: p.entry, signalPrice: p.signalPrice, exit: exitPrice,
      stop: p.initialStop, target: p.target, targetKind: p.targetKind, exitReason, meta: p.meta,
      pnlPct, pnlR: risk > 0 ? dir * (exitPrice - p.entry) / risk : 0,
      sizeMultiplier: p.sizeMultiplier, usd: p.usd,
      prediction: p.prediction ? { side: p.prediction.side, confidence: +p.prediction.confidence.toFixed(3) } : null,
    };
    if (p.option) {
      const exitPremium = optionPremium(exitPrice, p.option.strike, yearsLeft(p.option.expiry, bar.time + baseMs), iv, p.option.type);
      t.option = { ...p.option, exitPremium };
      t.pnlUSD = (exitPremium - p.option.entryPremium) * 100 * p.option.contracts;
    } else {
      t.pnlUSD = p.usd * pnlPct / 100;
    }
    trades.push(t);
    dayPnl.pct += pnlPct;                       // live: sum of trade % moves
    if (maxLoss > 0 && !dayPnl.halted && dayPnl.pct <= -maxLoss) dayPnl.halted = true;
    st.position = null;
  };

  for (const bar of stream) {
    const sym = bar.symbol;
    const st = states.get(sym);
    const completed = st.series.push(bar);
    if (!completed.size || bar.time < tradeStart) continue;

    const { mins, day: today } = etInfo(bar.time + baseMs);
    if (mins < MARKET_OPEN || mins > MARKET_CLOSE) continue;   // the bar ending at 4:00 can still exit
    if (day.date !== today) {
      day.date = today; day.strategiesFiredToday = new Set(); day.tradesToday = 0;
      for (const x of states.values()) x.strategiesTradedToday = new Set();
      dayPnl.date = today; dayPnl.pct = 0; dayPnl.halted = false;
      tradingDays.add(today);
    }
    stats.advance(bar.time);

    // An entry decided on the previous bar fills at this bar's open.
    if (st.pending) {
      const pend = st.pending;
      st.pending = null;
      const sg = pend.decision.chosen.signal;
      if (pend.day === today && (sg.overnight ? mins <= MARKET_CLOSE : mins < (sg.eodMins ?? EOD_CLOSE))) open(sym, st, pend, bar);
    }

    if (st.position && !st.position.overnight && mins >= (st.position.eodMins ?? EOD_CLOSE)) { close(sym, st, bar.close, "eod", bar); continue; }

    if (st.position) {
      const p = st.position;
      let ex = updatePosition(p, bar, { series: st.series, completedTfs: completed, nearTargetPct: getEarlyExitConfig(p.strategy, p.regime).nearTargetPct });
      if (!ex && p.option) {                       // options agent's premium / time exits
        const prem = optionPremium(bar.close, p.option.strike, yearsLeft(p.option.expiry, bar.time + baseMs), iv, p.option.type);
        const pnl = (prem - p.option.entryPremium) / p.option.entryPremium * 100;
        const tr = p.option.triggers;
        if (pnl >= tr.profitTargetPct)                                  ex = { exitPrice: bar.close, exitReason: "options-target" };
        else if (pnl <= -tr.maxLossPct)                                 ex = { exitPrice: bar.close, exitReason: "options-stop" };
        else if ((bar.time + baseMs - p.entryTime) / 60_000 >= tr.timeExitMinutes) ex = { exitPrice: bar.close, exitReason: "options-time-exit" };
      }
      if (ex) close(sym, st, ex.exitPrice, ex.exitReason, bar);
      continue;
    }

    const dec = decideEntry({
      state: st, completed, etMins: mins, cfg, day, symbol: sym,
      openCount: [...states.values()].filter(x => x.position || x.pending).length,
      halted: dayPnl.halted,
      statsLookup, paramsFor, predict,
    });
    if (!dec.decision) continue;
    if (!dec.enter) {
      if (dec.vetoed) counts.vetoed++;
      if (dec.decision.chosen) counts.reasons[dec.reason] = (counts.reasons[dec.reason] || 0) + 1;
      continue;
    }

    // Like live: the strategy is used up and the slot taken as soon as the
    // order goes in; it fills at the next bar's open (see `open`).
    const { strategy } = dec.decision.chosen;
    st.pending = { ...dec, day: today };
    st.strategiesTradedToday.add(strategy);
    day.strategiesFiredToday.add(strategy);
    day.tradesToday++;
    counts.entries++;
  }

  // Anything still open at the end of the data closes at the last price.
  for (const [sym, st] of states) {
    if (st.position) { const last = data.bars[sym][data.bars[sym].length - 1]; close(sym, st, last.close, "end-of-data", last); }
  }

  return { summary: summarize(trades, tradingDays, counts, { mode, modelNote, cfg, tradeStart, base: data.base }), trades, tradeStart };
}

// ── Metrics ───────────────────────────────────────────────────────────────────

function group(trades, key) {
  const out = {};
  for (const t of trades) {
    const k = typeof key === "function" ? key(t) : t[key];
    const g = out[k] ??= { trades: 0, wins: 0, pnlUSD: 0, sumR: 0 };
    g.trades++; g.pnlUSD += t.pnlUSD; g.sumR += t.pnlR; if (t.pnlUSD > 0) g.wins++;
  }
  for (const g of Object.values(out)) {
    g.winRate = +(g.wins / g.trades * 100).toFixed(1);
    g.expectancyR = +(g.sumR / g.trades).toFixed(3);
    g.pnlUSD = +g.pnlUSD.toFixed(2);
    delete g.sumR;
  }
  return out;
}

function summarize(trades, tradingDays, counts, meta) {
  const days = tradingDays.size;
  const byDay = new Map([...tradingDays].map(d => [d, 0]));
  for (const t of trades) { const d = etInfo(t.exitTime).day; byDay.set(d, (byDay.get(d) || 0) + t.pnlUSD); }
  const daily = [...byDay.entries()].sort().map(([, v]) => v);
  const mean = daily.reduce((a, b) => a + b, 0) / (daily.length || 1);
  const sd = Math.sqrt(daily.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, daily.length - 1));
  let eq = 0, peak = 0, maxDD = 0;
  for (const v of daily) { eq += v; peak = Math.max(peak, eq); maxDD = Math.max(maxDD, peak - eq); }
  const wins = trades.filter(t => t.pnlUSD > 0), losses = trades.filter(t => t.pnlUSD <= 0);
  const gross = x => x.reduce((a, t) => a + t.pnlUSD, 0);
  return {
    mode: meta.mode, base: meta.base, model: meta.modelNote,
    activeStrategies: meta.cfg.activeStrategies,
    predictorGate: !!meta.cfg.predictorEnabled,
    from: new Date(meta.tradeStart).toISOString().slice(0, 10),
    tradingDays: days,
    trades: trades.length,
    tradesPerDay: +(trades.length / (days || 1)).toFixed(2),
    winRate: +(wins.length / (trades.length || 1) * 100).toFixed(1),
    expectancyR: +(trades.reduce((a, t) => a + t.pnlR, 0) / (trades.length || 1)).toFixed(3),
    totalPnlUSD: +gross(trades).toFixed(2),
    avgPnlUSD: +(gross(trades) / (trades.length || 1)).toFixed(2),
    profitFactor: losses.length && gross(losses) !== 0 ? +(gross(wins) / -gross(losses)).toFixed(2) : null,
    maxDrawdownUSD: +maxDD.toFixed(2),
    sharpe: sd > 0 ? +((mean / sd) * Math.sqrt(252)).toFixed(2) : null,
    vetoedByPredictor: counts.vetoed,
    byStrategy: group(trades, "strategy"),
    bySymbol: group(trades, "symbol"),
    byExit: group(trades, "exitReason"),
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

function printSummary(title, s) {
  console.log(`\n══ ${title} ${"═".repeat(Math.max(0, 60 - title.length))}`);
  const rows = [
    ["period", `${s.from} → (${s.tradingDays} trading days, ${s.base} bars, ${s.mode})`],
    ["strategies", s.activeStrategies.join(", ")],
    ["predictor gate", `${s.predictorGate ? "ON" : "off"} · model: ${s.model}`],
    ["trades", `${s.trades} (${s.tradesPerDay}/day)`],
    ["win rate", `${s.winRate}%`],
    ["expectancy", `${s.expectancyR}R / trade`],
    ["P&L", `$${s.totalPnlUSD} total · $${s.avgPnlUSD}/trade · profit factor ${s.profitFactor ?? "—"}`],
    ["max drawdown", `$${s.maxDrawdownUSD}`],
    ["Sharpe (daily)", `${s.sharpe ?? "—"}`],
    ["vetoed", `${s.vetoedByPredictor} trades blocked by the predictor`],
  ];
  for (const [k, v] of rows) console.log(`  ${k.padEnd(15)} ${v}`);
  for (const [name, g] of [["by strategy", s.byStrategy], ["by symbol", s.bySymbol], ["by exit", s.byExit]]) {
    console.log(`  ── ${name}`);
    for (const [k, v] of Object.entries(g).sort((a, b) => b[1].trades - a[1].trades))
      console.log(`     ${String(k).padEnd(18)} ${String(v.trades).padStart(4)} trades  ${String(v.winRate).padStart(5)}% win  ${String(v.expectancyR).padStart(7)}R  $${v.pnlUSD}`);
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const arg = (n, d) => process.argv.find(a => a.startsWith(`--${n}=`))?.split("=")[1] ?? d;
  const flag = n => process.argv.includes(`--${n}`);
  const base = arg("base", "1m");
  const symbols = arg("symbols") ? arg("symbols").split(",").map(s => s.trim().toUpperCase()) : loadSymbols();
  const cfg = loadRuntimeConfig();
  const strategies = cfg.activeStrategies.filter(x => SUPPORTED_STRATEGIES.includes(x));
  const run = async () => {
    console.log(`Loading ${symbols.join(", ")} (${base})…`);
    const data = await loadReplayData({ symbols, base, days: parseInt(arg("days", "365")), strategies, withStats: !flag("no-stats") });
    const common = { mode: arg("mode"), iv: parseFloat(arg("iv", "30")) / 100, includeInSample: flag("include-in-sample") };
    const results = [];
    if (flag("compare-gate")) {
      // Same window for both: a trained model's gate only runs on its unseen period.
      const on = simulate(data, { ...common, cfg: { predictorEnabled: true } });
      results.push(["Predictor gate ON", on]);
      results.push(["Predictor gate OFF", simulate(data, { ...common, cfg: { predictorEnabled: false }, tradeStartMs: on.tradeStart })]);
    } else {
      results.push(["Replay (live settings)", simulate(data, common)]);
    }
    for (const [title, r] of results) printSummary(title, r.summary);
    const out = arg("json");
    if (out) {
      const { writeFileSync } = await import("fs");
      writeFileSync(out, JSON.stringify(results.map(([title, r]) => ({ title, ...r })), null, 2));
      console.log(`\nWrote ${out}`);
    }
  };
  run().catch(e => { console.error(e); process.exit(1); });
}
