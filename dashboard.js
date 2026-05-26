import express from "express";
import fetch from "node-fetch";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import "dotenv/config";
import { runBacktest, fetchCandles } from "./backtest.js";
import { injectPineScript } from "./tv-inject.js";
import { meta as orbMeta }      from "./strategies/orb.js";
import { meta as vwapMeta }     from "./strategies/vwap.js";
import { meta as trendMeta }    from "./strategies/trend.js";
import { meta as meanrevMeta }  from "./strategies/meanrev.js";
import { meta as momentumMeta } from "./strategies/momentum.js";
import { meta as hybridMeta }  from "./strategies/hybrid.js";
import { fetchChain, fetchExpiryDates, fetchContracts } from "./options.js";
import { AlpacaStream } from "./stream.js";
import { loadAllLearning } from "./learner.js";
import { runHermesAnalysis, loadAllInsights, suggestParamChanges } from "./hermes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || process.env.DASHBOARD_PORT || 3000;

const ALPACA_BASE = process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets";
const ALPACA_HEADERS = {
  "APCA-API-KEY-ID":     process.env.ALPACA_API_KEY,
  "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY,
  "Content-Type":        "application/json",
};

async function alpaca(path) {
  const res = await fetch(`${ALPACA_BASE}${path}`, { headers: ALPACA_HEADERS });
  if (!res.ok) throw new Error(`Alpaca ${path} → ${res.status}`);
  return res.json();
}

app.use(express.json());
app.use(express.static(__dirname));
app.get("/", (req, res) => res.sendFile(join(__dirname, "dashboard.html")));

// ─── Alpaca proxy ─────────────────────────────────────────────────────────────

app.get("/api/account",   async (req, res) => { try { res.json(await alpaca("/v2/account")); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get("/api/positions", async (req, res) => { try { res.json(await alpaca("/v2/positions")); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get("/api/orders",    async (req, res) => { try { res.json(await alpaca("/v2/orders?status=all&limit=100&direction=desc")); } catch (e) { res.status(500).json({ error: e.message }); } });
app.get("/api/history",   async (req, res) => { try { res.json(await alpaca("/v2/account/portfolio/history?period=1M&timeframe=1D&extended_hours=false")); } catch (e) { res.status(500).json({ error: e.message }); } });

// ─── Bot log ──────────────────────────────────────────────────────────────────

app.get("/api/bot-log", (req, res) => {
  const logPath = join(__dirname, "safety-check-log.json");
  if (!existsSync(logPath)) return res.json([]);
  try {
    const raw = readFileSync(logPath, "utf8").trim();
    if (!raw) return res.json([]);
    let log;
    try { log = JSON.parse(raw); } catch { return res.json([]); }
    const trades = Array.isArray(log) ? log : (log.trades || []);
    res.json(trades.slice().reverse().slice(0, 50));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Strategies ───────────────────────────────────────────────────────────────

app.get("/api/strategies", (req, res) => {
  res.json([orbMeta, vwapMeta, trendMeta, meanrevMeta, momentumMeta, hybridMeta]);
});

// ─── Backtest ─────────────────────────────────────────────────────────────────

// Convert backtest trades into the live trade-history record shape.
function backtestTradesToHistory(trades, strategy, symbol, { source = "backtest" } = {}) {
  return (trades || []).map(t => ({
    symbol,
    strategy,
    side:        t.side,
    entryPrice:  t.entry,
    exitPrice:   t.exit,
    pnlPct:      +(t.pnlPct || 0).toFixed(4),
    pnlR:        t.pnlR != null ? +t.pnlR.toFixed(3) : null,
    win:         (t.pnlPct || 0) > 0,
    entryTime:   t.entryTime ? new Date(t.entryTime).toISOString() : null,
    exitTime:    t.exitTime  ? new Date(t.exitTime).toISOString()  : null,
    exitReason:  t.exitReason,
    forced:      !!t.forced,
    source,
    // Options fields (present when mode === "options")
    optionType:    t.optionType    || null,
    optionStrike:  t.optionStrike  || null,
    entryPremium:  t.entryPremium  != null ? +t.entryPremium.toFixed(4)  : null,
    exitPremium:   t.exitPremium   != null ? +t.exitPremium.toFixed(4)   : null,
    optionsPnL:    t.optionsPnL    != null ? +t.optionsPnL.toFixed(2)    : null,
    optionsPnLPct: t.optionsPnLPct != null ? +t.optionsPnLPct.toFixed(4) : null,
    recordedAt: new Date().toISOString(),
  }));
}

function appendToTradeHistory(records) {
  if (!records || records.length === 0) return 0;
  const histFile = join(__dirname, "trade-history.json");
  let history = [];
  try { if (existsSync(histFile)) history = JSON.parse(readFileSync(histFile, "utf8")); } catch {}
  history.push(...records);
  if (history.length > 2000) history = history.slice(-2000);
  writeFileSync(histFile, JSON.stringify(history, null, 2));
  return records.length;
}

app.post("/api/backtest", async (req, res) => {
  const { strategy, symbol, mode, iv, dte, contracts, strikeInterval, forceDaily, saveToHistory } = req.body;
  if (!strategy || !symbol) return res.status(400).json({ error: "strategy and symbol required" });
  try {
    const opts = {
      mode:           mode || "stock",
      iv:             parseFloat(iv) / 100 || 0.25,
      dteDays:        parseInt(dte)         || 7,
      numContracts:   parseInt(contracts)   || 1,
      strikeInterval: parseFloat(strikeInterval) || 1,
      forceDaily:     !!forceDaily,
    };
    console.log(`Running backtest: ${strategy} on ${symbol} [${opts.mode}]${opts.forceDaily ? " forceDaily" : ""}`);
    const results = await runBacktest(strategy, symbol, opts);

    // forceDaily implies the user wants every session's trade in order history.
    if (saveToHistory || forceDaily) {
      const recs = backtestTradesToHistory(results.trades, strategy, symbol, { source: forceDaily ? "backtest-forced" : "backtest" });
      const n = appendToTradeHistory(recs);
      results.savedToHistory = n;
      console.log(`[Backtest] Appended ${n} trades to trade-history.json`);
    }

    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Pine Script ──────────────────────────────────────────────────────────────

app.get("/api/pinescript/:id", (req, res) => {
  const files = {
    orb:              "pinescript/orb.pine",
    vwap:             "pinescript/vwap.pine",
    "options-overlay": "pinescript/options-overlay.pine",
  };
  const file  = files[req.params.id];
  if (!file) return res.status(404).json({ error: "Unknown strategy" });
  const fullPath = join(__dirname, file);
  if (!existsSync(fullPath)) return res.status(404).json({ error: "Pine Script file not found" });
  res.type("text/plain").send(readFileSync(fullPath, "utf8"));
});

// ─── Options chain ────────────────────────────────────────────────────────────

app.get("/api/options-expiries/:symbol", async (req, res) => {
  try {
    const dates = await fetchExpiryDates(req.params.symbol);
    res.json(dates);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/options-chain/:symbol", async (req, res) => {
  const { symbol } = req.params;
  const { expiry } = req.query;
  if (!expiry) return res.status(400).json({ error: "expiry query param required" });
  try {
    // Get current price from Yahoo Finance (quick)
    const yRes  = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&range=1d`, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) });
    const yJson = await yRes.json();
    const quotes = yJson.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
    const currentPrice = quotes.filter(Boolean).at(-1) || 500;

    const chain = await fetchChain(symbol, expiry, currentPrice);
    res.json({ ...chain, currentPrice, symbol, expiry });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── TradingView CDP inject ───────────────────────────────────────────────────

app.post("/api/tv-inject/:id", async (req, res) => {
  try {
    const result = await injectPineScript(req.params.id);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── Hermes AI analysis ───────────────────────────────────────────────────────

app.get("/api/hermes", (req, res) => {
  res.json(loadAllInsights());
});

app.post("/api/hermes/analyze", async (req, res) => {
  const strategy = req.body?.strategy || "orb";
  try {
    const result = await runHermesAnalysis(strategy);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Live price SSE ───────────────────────────────────────────────────────────

const liveClients = new Set();

app.get("/api/live", (req, res) => {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.write(`data: {"type":"connected"}\n\n`);
  liveClients.add(res);
  req.on("close", () => liveClients.delete(res));
});

function broadcastSSE(obj) {
  if (liveClients.size === 0) return;
  const payload = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of liveClients) {
    try { res.write(payload); } catch { liveClients.delete(res); }
  }
}

// ─── Watchlist ────────────────────────────────────────────────────────────────

app.get("/api/watchlist", async (req, res) => {
  try {
    const lists = await alpaca("/v2/watchlists");
    if (!lists?.length) return res.json([]);
    const detail = await alpaca(`/v2/watchlists/${lists[0].id}`);
    res.json((detail.assets || []).map(a => a.symbol));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Live price stream (skipped when bot-stream.js owns the connection) ───────

if (!process.env.NO_DASHBOARD_STREAM && process.env.ALPACA_API_KEY && process.env.ALPACA_SECRET_KEY) {
  (async () => {
    let symbols = [process.env.SYMBOL || "SPY"];
    try {
      const lists = await alpaca("/v2/watchlists");
      if (lists?.length) {
        const detail  = await alpaca(`/v2/watchlists/${lists[0].id}`);
        const wl      = (detail.assets || []).map(a => a.symbol).filter(Boolean);
        if (wl.length) { symbols = wl; console.log(`[Stream] Watchlist symbols: ${wl.join(", ")}`); }
      }
    } catch (e) { console.warn("[Stream] Watchlist fetch failed, using", symbols.join(","), "—", e.message); }

    const liveStream = new AlpacaStream(symbols);
    liveStream.on("bar",          bar   => broadcastSSE({ type: "bar",   ...bar }));
    liveStream.on("trade",        trade => broadcastSSE({ type: "trade", ...trade }));
    liveStream.on("connected",    ()    => console.log(`[Stream] Connected: ${symbols.join(", ")}`));
    liveStream.on("disconnected", ()    => console.log("[Stream] Disconnected"));
    liveStream.on("error",        err   => console.warn("[Stream]", err.message));
    liveStream.connect();
  })();
}

// ─── Bot status ────────────────────────────────────────────────────────────────

app.get("/api/bot-status", (req, res) => {
  const stateFile   = join(__dirname, "bot-state.json");
  const historyFile = join(__dirname, "trade-history.json");

  let state   = null;
  let history = [];
  let learning = {};

  try { if (existsSync(stateFile))   state   = JSON.parse(readFileSync(stateFile,   "utf8")); } catch {}
  try { if (existsSync(historyFile)) history = JSON.parse(readFileSync(historyFile, "utf8")); } catch {}
  try { learning = loadAllLearning(); } catch {}

  const last20   = history.slice(-20);
  const wins     = last20.filter(t => t.win).length;
  const winRate  = last20.length > 0 ? wins / last20.length : null;
  const avgPnl   = last20.length > 0 ? last20.reduce((s, t) => s + t.pnlPct, 0) / last20.length : null;

  res.json({
    state,
    winRate,
    avgPnl:       avgPnl !== null ? +avgPnl.toFixed(3) : null,
    totalTrades:  history.length,
    recentTrades: history.slice(-10).reverse(),
    learning,
  });
});

// ─── Backtest optimization loop ───────────────────────────────────────────────

const TIMEFRAMES = { orb: "5m", vwap: "1H", trend: "1D", meanrev: "1D", momentum: "1D", hybrid: "5m" };
const STRATEGY_META = { orb: orbMeta, vwap: vwapMeta, trend: trendMeta, meanrev: meanrevMeta, momentum: momentumMeta, hybrid: hybridMeta };

function findBestIteration(iters) {
  return iters.reduce((bestI, iter, i) => {
    const pf  = v => v === "∞" ? 999 : (parseFloat(v) || 0);
    const ret = v => parseFloat((v || "0").replace("R", "").replace("+", "")) || 0;
    const a = iters[bestI].metrics, b = iter.metrics;
    if (pf(b.profitFactor) > pf(a.profitFactor)) return i;
    if (pf(b.profitFactor) === pf(a.profitFactor) && ret(b.totalReturnR) > ret(a.totalReturnR)) return i;
    return bestI;
  }, 0);
}

// Pull a numeric "total return %" out of a metrics object so we can compare
// against a target (e.g. 70%). Prefers options PnL when in options mode.
function metricsToReturnPct(metrics, mode) {
  if (mode === "options" && metrics?.optionsMetrics) {
    const total = parseFloat((metrics.optionsMetrics.totalPnL || "0").replace(/[$,]/g, ""));
    const cost  = parseFloat((metrics.optionsMetrics.totalEntryPremium || "0").replace(/[$,]/g, ""));
    if (cost > 0) return (total / cost) * 100;
    return total; // fall back to raw dollars if we can't compute cost basis
  }
  // Stock mode: convert "+3.45R" → R-multiple as percent-of-risk
  const raw = (metrics?.totalReturnR || "0").replace("R", "").replace("+", "");
  const r = parseFloat(raw) || 0;
  // Assume each R ≈ 1% of account risk per trade; treat R-multiple as percentage.
  return r;
}

app.post("/api/backtest/optimize", async (req, res) => {
  const {
    strategy, symbol,
    iterations    = 5,
    mode, iv, dte, contracts, strikeInterval,
    forceDaily    = false,
    saveToHistory = false,
    targetReturnPct,        // e.g. 70 → keep iterating until total return reaches 70%
    maxIterations,          // hard cap when targetReturnPct is set (default 25)
  } = req.body;
  if (!strategy || !symbol) return res.status(400).json({ error: "strategy and symbol required" });

  const meta = STRATEGY_META[strategy];
  if (!meta) return res.status(400).json({ error: `Unknown strategy: ${strategy}` });

  const tf = TIMEFRAMES[strategy] || "1H";
  const baseOpts = {
    mode:           mode || "stock",
    iv:             parseFloat(iv) / 100 || 0.25,
    dteDays:        parseInt(dte)         || 7,
    numContracts:   parseInt(contracts)   || 1,
    strikeInterval: parseFloat(strikeInterval) || 1,
    forceDaily:     !!forceDaily,
  };

  const targetPct = targetReturnPct != null ? parseFloat(targetReturnPct) : null;
  const hardCap   = Math.min(Math.max(parseInt(maxIterations) || 25, 2), 50);
  const baseIters = Math.min(Math.max(parseInt(iterations) || 5, 2), 8);
  // When a target is set, we let the loop run up to hardCap; otherwise stick to baseIters.
  const loopCap   = targetPct != null ? hardCap : baseIters;
  console.log(`[Optimize] ${strategy.toUpperCase()} on ${symbol} — up to ${loopCap} iterations${targetPct != null ? `, target ${targetPct}%` : ""}${forceDaily ? ", forceDaily" : ""}`);

  try {
    // Fetch candles once; share across all iterations to avoid rate-limiting
    const candles = await fetchCandles(symbol, tf);
    console.log(`[Optimize] Got ${candles.length} candles for ${symbol}`);

    let currentParams = { ...meta.params };
    const iterResults = [];
    let targetReached = false;

    for (let i = 0; i < loopCap; i++) {
      const result = await runBacktest(strategy, symbol, { ...baseOpts, params: currentParams, _candles: candles });
      const { candles: _c, equityCurve: _e, trades, ...metrics } = result;

      const prevParams = i > 0 ? iterResults[i - 1].params : null;
      const paramChanges = {};
      if (prevParams) {
        for (const [k, v] of Object.entries(currentParams)) {
          if (prevParams[k] !== undefined && prevParams[k] !== v) paramChanges[k] = `${prevParams[k]} → ${v}`;
        }
      }

      const returnPct = metricsToReturnPct(metrics, baseOpts.mode);
      iterResults.push({
        num: i + 1,
        params:         { ...currentParams },
        metrics,
        trades:         trades || [],   // keep so we can save best to history
        tradeCount:     (trades || []).length,
        returnPct:      +returnPct.toFixed(2),
        paramChanges,
        hermesReasoning: "",
      });

      console.log(`[Optimize] Iter ${i + 1}: ${(trades||[]).length} trades, return ${returnPct.toFixed(2)}%`);

      if (targetPct != null && returnPct >= targetPct) {
        console.log(`[Optimize] 🎯 Target ${targetPct}% reached at iter ${i + 1} (got ${returnPct.toFixed(2)}%)`);
        targetReached = true;
        break;
      }

      if (i < loopCap - 1) {
        const suggestion = await suggestParamChanges(strategy, currentParams, trades || [], i + 1);
        iterResults[i].hermesReasoning = suggestion.reasoning;
        currentParams = { ...currentParams, ...suggestion.changes };
        console.log(`[Optimize] Iter ${i + 1} done → ${JSON.stringify(suggestion.changes)}`);
      }
    }

    const bestIdx = findBestIteration(iterResults);

    // Optionally append the best iteration's trades to live order history.
    let savedCount = 0;
    if (saveToHistory || forceDaily) {
      const recs = backtestTradesToHistory(
        iterResults[bestIdx].trades, strategy, symbol,
        { source: forceDaily ? "optimize-forced" : "optimize" }
      );
      savedCount = appendToTradeHistory(recs);
      console.log(`[Optimize] Appended ${savedCount} best-iteration trades to trade-history.json`);
    }

    // Strip the trades array off iterations before returning (keep payload small)
    const output = {
      strategy,
      symbol,
      iterations:    iterResults.map(({ trades: _t, ...rest }) => rest),
      bestIteration: bestIdx + 1,
      bestParams:    iterResults[bestIdx].params,
      bestReturnPct: iterResults[bestIdx].returnPct,
      targetReturnPct: targetPct,
      targetReached,
      savedToHistory:  savedCount,
      optimizedAt:   new Date().toISOString(),
    };

    const histFile = join(__dirname, "backtest-history.json");
    let history = {};
    try { if (existsSync(histFile)) history = JSON.parse(readFileSync(histFile, "utf8")); } catch {}
    history[`${strategy}-${symbol}`] = output;
    writeFileSync(histFile, JSON.stringify(history, null, 2));

    res.json(output);
  } catch (e) {
    console.error("[Optimize] Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/backtest/history", (req, res) => {
  const histFile = join(__dirname, "backtest-history.json");
  if (!existsSync(histFile)) return res.json({});
  try { res.json(JSON.parse(readFileSync(histFile, "utf8"))); } catch { res.json({}); }
});

// ─── Deploy optimized params to bot ───────────────────────────────────────────

app.post("/api/deploy", async (req, res) => {
  const { strategy, params } = req.body;
  if (!strategy || !params) return res.status(400).json({ error: "strategy and params required" });

  const learnFile = join(__dirname, "learned-params.json");
  let learned = {};
  try { if (existsSync(learnFile)) learned = JSON.parse(readFileSync(learnFile, "utf8")); } catch {}

  learned[strategy] = {
    ...(learned[strategy] || {}),
    params,
    source:     "hermes-optimization",
    deployedAt: new Date().toISOString(),
  };
  writeFileSync(learnFile, JSON.stringify(learned, null, 2));

  let alpacaConnected = false, alpacaMsg = "";
  try {
    const acct = await alpaca("/v2/account");
    alpacaConnected = true;
    alpacaMsg = `Connected — account ${acct.account_number} (${acct.status})`;
  } catch (e) {
    alpacaMsg = `Alpaca unreachable: ${e.message} — params saved, bot will use them when it reconnects`;
  }

  console.log(`[Deploy] ${strategy.toUpperCase()} params saved →`, params);
  res.json({ ok: true, strategy, params, alpacaConnected, alpacaMsg, deployedAt: learned[strategy].deployedAt });
});

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}/dashboard.html`);
});
