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
import { meta as reversalMeta }        from "./strategies/reversal.js";
import { meta as hybridReversalMeta }  from "./strategies/hybrid-reversal.js";
import { meta as hybrid10Meta }        from "./strategies/hybrid10.js";
import { fetchChain, fetchExpiryDates, fetchContracts, getLiveOptionsParams } from "./options.js";
import { AlpacaStream } from "./stream.js";
import { loadAllLearning, getAllRegimeStats, saveRegimeParams, getRegimeStats } from "./learner.js";
import { classifyRegime } from "./regime.js";
import { runHermesAnalysis, loadAllInsights, suggestParamChanges, explainTrades, deriveWinOnlyFilters } from "./hermes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || process.env.DASHBOARD_PORT || 3000;

// Normalise the configured base URL so trailing slashes and accidental
// "/v2" suffixes don't produce 404s when concatenated with API paths.
function normalizeAlpacaBase(raw) {
  if (!raw) return "https://paper-api.alpaca.markets";
  let b = raw.trim().replace(/\/+$/, ""); // drop trailing slashes
  // If user pasted ".../v2" or ".../v2beta", strip the version segment.
  b = b.replace(/\/v\d[^/]*$/, "");
  return b;
}
const ALPACA_BASE = normalizeAlpacaBase(process.env.ALPACA_BASE_URL);
const ALPACA_HEADERS = {
  "APCA-API-KEY-ID":     process.env.ALPACA_API_KEY,
  "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY,
  "Content-Type":        "application/json",
};

async function alpaca(path) {
  const url = `${ALPACA_BASE}${path}`;
  const res = await fetch(url, { headers: ALPACA_HEADERS });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Alpaca ${path} → ${res.status} ${res.statusText}${body ? ": " + body.slice(0, 200) : ""}`);
  }
  return res.json();
}

app.use(express.json());
app.use(express.static(__dirname));
app.get("/", (req, res) => res.sendFile(join(__dirname, "dashboard.html")));

// ─── Diagnostics — visit /api/diag to see why account data is missing ────────
app.get("/api/diag", async (req, res) => {
  const keyId    = process.env.ALPACA_API_KEY    || "";
  const keySec   = process.env.ALPACA_SECRET_KEY || "";
  const baseRaw  = process.env.ALPACA_BASE_URL   || "";
  const diag = {
    env: {
      ALPACA_API_KEY:    keyId    ? `set (len=${keyId.length}, starts ${keyId.slice(0, 4)}…)`    : "MISSING",
      ALPACA_SECRET_KEY: keySec   ? `set (len=${keySec.length})`                                  : "MISSING",
      ALPACA_BASE_URL:   baseRaw  || "(unset — using default)",
      STRATEGY:          process.env.STRATEGY        || "(unset — defaults to orb)",
      SYMBOL:            process.env.SYMBOL          || "(unset)",
      PAPER_TRADING:     process.env.PAPER_TRADING   || "(unset)",
    },
    normalizedBase: ALPACA_BASE,
    probe: { account: null, clock: null, error: null },
    hints: [],
  };

  if (baseRaw && !/alpaca\.markets$/i.test(baseRaw.trim().replace(/\/+$/, "").replace(/\/v\d[^/]*$/, ""))) {
    diag.hints.push(`ALPACA_BASE_URL value "${baseRaw}" doesn't end at an alpaca.markets host — should be "https://paper-api.alpaca.markets" (paper) or "https://api.alpaca.markets" (live)`);
  }
  if (baseRaw && /data\.alpaca/.test(baseRaw)) {
    diag.hints.push(`ALPACA_BASE_URL points to data.alpaca.markets — this is the data API, not the trading API. Use https://paper-api.alpaca.markets for the dashboard's account/orders proxy.`);
  }
  if (baseRaw && /\/v\d/.test(baseRaw)) {
    diag.hints.push(`ALPACA_BASE_URL ends in "/v2" — the dashboard already appends "/v2/...". Remove the version suffix from the env var.`);
  }
  if (baseRaw && /\/$/.test(baseRaw)) {
    diag.hints.push(`ALPACA_BASE_URL has a trailing slash — strip it.`);
  }
  if (!keyId || !keySec) {
    diag.hints.push("ALPACA_API_KEY or ALPACA_SECRET_KEY is missing on Railway — set both under Variables and redeploy.");
  }

  // Probe — try /v2/account and /v2/clock (clock works without auth scope issues)
  try {
    const acct = await alpaca("/v2/account");
    diag.probe.account = { ok: true, status: acct.status, account_number: acct.account_number, equity: acct.equity };
  } catch (e) {
    diag.probe.error = e.message;
  }
  try {
    const clockUrl = `${ALPACA_BASE}/v2/clock`;
    const r = await fetch(clockUrl, { headers: ALPACA_HEADERS });
    diag.probe.clock = { url: clockUrl, status: r.status, ok: r.ok };
    if (!r.ok && r.status === 404) diag.hints.push(`Even /v2/clock 404s — base URL is wrong. Try ALPACA_BASE_URL=https://paper-api.alpaca.markets`);
    if (r.status === 401 || r.status === 403) diag.hints.push(`Auth failed (${r.status}). Regenerate keys in Alpaca dashboard → Paper Trading → API Keys, then update Railway Variables.`);
  } catch (e) {
    diag.probe.clock = { error: e.message };
  }

  res.json(diag);
});

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

// Hybrid is the only active strategy. Pass ?all=1 to see the full catalog
// (or set ACTIVE_STRATEGIES=orb,vwap,... in the environment to whitelist others).
app.get("/api/strategies", (req, res) => {
  const all = [hybridMeta, hybridReversalMeta, hybrid10Meta, reversalMeta, vwapMeta, orbMeta, trendMeta, meanrevMeta, momentumMeta];
  if (req.query?.all === "1") return res.json(all);
  // Hybrid family + Reversal + VWAP active by default. Override with ACTIVE_STRATEGIES env.
  const whitelist = (process.env.ACTIVE_STRATEGIES || "hybrid,hybrid-reversal,hybrid10,reversal,vwap")
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  const active = all
    .filter(m => whitelist.includes(m.id))
    .map(m => ({ ...m, active: true }));
  res.json(active);
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

// Quote symbol's last trade for picking an ATM strike when fetching live options params.
async function lastTradePrice(symbol) {
  try {
    const j = await (await fetch(`https://data.alpaca.markets/v2/stocks/${symbol}/trades/latest?feed=iex`, { headers: ALPACA_HEADERS, signal: AbortSignal.timeout(8000) })).json();
    return j?.trade?.p || null;
  } catch { return null; }
}

app.post("/api/backtest", async (req, res) => {
  const { strategy, symbol, mode, iv, dte, contracts, strikeInterval, forceDaily, saveToHistory, useLiveOptions } = req.body;
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

    // If running in options mode, pull today's IV + DTE from Alpaca so the
    // Black-Scholes math reflects the actual current options environment.
    // Auto-enabled when caller doesn't pass explicit iv/dte, or when useLiveOptions=true.
    if (opts.mode === "options" && (useLiveOptions || iv == null || dte == null)) {
      const px = await lastTradePrice(symbol);
      const live = await getLiveOptionsParams(symbol, px || 100);
      if (live.iv)      opts.iv      = live.iv;
      if (live.dteDays) opts.dteDays = live.dteDays;
      opts.liveOptions = live;
      console.log(`[Backtest] Live options env for ${symbol}: IV=${(opts.iv*100).toFixed(1)}% DTE=${opts.dteDays}d (${live.source})`);
    }

    console.log(`Running backtest: ${strategy} on ${symbol} [${opts.mode}]${opts.forceDaily ? " forceDaily" : ""}`);
    const results = await runBacktest(strategy, symbol, opts);
    if (opts.liveOptions) results.liveOptionsEnv = opts.liveOptions;

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
    hybrid:           "pinescript/hybrid.pine",
    reversal:         "pinescript/reversal.pine",
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
  const strategy = req.body?.strategy || "hybrid";
  try {
    const result = await runHermesAnalysis(strategy);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Per-trade explainer — returns each recent trade with a one-line verdict
// describing why it won or lost. Reads from trade-history.json.
app.get("/api/hermes/explain-trades", (req, res) => {
  const strategy = req.query?.strategy || "hybrid";
  const limit    = Math.min(parseInt(req.query?.limit) || 50, 500);
  const histFile = join(__dirname, "trade-history.json");
  if (!existsSync(histFile)) return res.json({ trades: [], filters: { filters: [] }, message: "No trade history yet" });
  try {
    const all = JSON.parse(readFileSync(histFile, "utf8"));
    const trades = all.filter(t => !strategy || t.strategy === strategy).slice(-limit);
    const explained = explainTrades(trades);
    const filters   = deriveWinOnlyFilters(trades);
    res.json({
      strategy,
      tradeCount: trades.length,
      summary: {
        wins:   explained.filter(t => t.verdict === "GOOD").length,
        losses: explained.filter(t => t.verdict === "BAD").length,
      },
      trades:  explained.slice().reverse(),
      winOnlyFilters: filters,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Apply the win-only filters as live bot config so future entries skip the loser profile.
app.post("/api/hermes/apply-filters", (req, res) => {
  const strategy = req.body?.strategy || "hybrid";
  const histFile = join(__dirname, "trade-history.json");
  if (!existsSync(histFile)) return res.status(400).json({ error: "No trade history" });
  try {
    const all = JSON.parse(readFileSync(histFile, "utf8"));
    const trades = all.filter(t => t.strategy === strategy);
    const { filters, blockedLosers, totalLosers, estWinRateAfter } = deriveWinOnlyFilters(trades);

    const learnFile = join(__dirname, "learned-params.json");
    let learned = {};
    try { if (existsSync(learnFile)) learned = JSON.parse(readFileSync(learnFile, "utf8")); } catch {}
    learned[strategy] = {
      ...(learned[strategy] || {}),
      winOnlyFilters: filters,
      filtersAppliedAt: new Date().toISOString(),
      blockedLosers,
      totalLosers,
      estWinRateAfter,
    };
    writeFileSync(learnFile, JSON.stringify(learned, null, 2));
    console.log(`[Hermes] Applied ${filters.length} win-only filters for ${strategy}`);
    res.json({ ok: true, strategy, filters, blockedLosers, totalLosers, estWinRateAfter });
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

// ─── Daily Signals ─────────────────────────────────────────────────────────────
//
// Runs the chosen strategy on each watchlist symbol for ONE trading day and
// returns the entry / exit / market-structure narrative for each. Default
// strategy is hybrid (force-daily on so every symbol shows something).

function structureNarrative(trade, ctx) {
  if (!trade) {
    return `${ctx.symbol}: no qualifying setup. ${ctx.reason || "Triple-confirmation conditions never aligned during the session window."}`;
  }
  const { side, entry, stop, target, exit, exitReason, pnlPct, orderBlock, stopSource, entrySignal, forced } = trade;
  const dir = side === "buy" ? "LONG" : "SHORT";

  // Entry framing
  let entryStory;
  if (entrySignal === "reversal-div") {
    entryStory = `${dir} entry on ${ctx.symbol} at $${entry.toFixed(2)} triggered by RSI divergence — price printed a ${side === "buy" ? "lower low while RSI made a higher low" : "higher high while RSI made a lower high"}, then a confirmation candle in our direction.`;
  } else if (forced) {
    entryStory = `${dir} entry on ${ctx.symbol} at $${entry.toFixed(2)} was a forced-daily entry — the strict triple-confirmation never fired so the bot took the first post-ORB bar in the direction of session VWAP (lower probability than a normal setup).`;
  } else {
    entryStory = `${dir} entry on ${ctx.symbol} at $${entry.toFixed(2)} triggered when price ${side === "buy" ? "broke above the opening range high" : "broke below the opening range low"} with all three filters aligned: ${side === "buy" ? "price above session VWAP, EMA(9) > EMA(21), volume ≥ 1.3× avg" : "price below VWAP, EMA(9) < EMA(21), volume ≥ 1.3× avg"}.`;
  }

  // Stop framing
  let stopStory;
  if (stopSource === "order-block" && orderBlock) {
    stopStory = `Stop placed at $${stop.toFixed(2)}, sitting just beyond the most recent ${orderBlock.side} order block (${orderBlock.side === "bullish" ? "the last down-candle before the morning impulse, which broke its high by " : "the last up-candle before the morning impulse, which broke its low by "}${orderBlock.impulsePct.toFixed(2)}%). This is the liquidity zone smart money positioned before pushing price ${side === "buy" ? "up" : "down"} — losing it invalidates the move.`;
  } else if (stopSource === "atr-trail") {
    stopStory = `Stop began at $${trade.stop.toFixed(2)} (ATR-based) and trailed dynamically as price moved in our favor, locking to break-even after 1R of profit.`;
  } else {
    stopStory = `Stop placed at $${stop.toFixed(2)}, on the opposite side of the opening range — a break here would mean the ORB is no longer a valid pivot.`;
  }

  // Exit framing
  let exitStory;
  if (exit == null) {
    exitStory = `Trade is still OPEN. Target at $${target?.toFixed(2)}, stop at $${stop.toFixed(2)}.`;
  } else if (exitReason === "target") {
    exitStory = `EXIT: HIT TARGET at $${exit.toFixed(2)} (+${pnlPct?.toFixed(2)}%). Price extended through the projected 2R move — the breakout had follow-through and momentum players piled in.`;
  } else if (exitReason === "near-target") {
    exitStory = `EXIT: NEAR-TARGET LOCK at $${exit.toFixed(2)} (+${pnlPct?.toFixed(2)}%). Price wicked into the top 95% of the planned move; we closed early to avoid giving back the win.`;
  } else if (exitReason === "stop" || exitReason === "trail-stop" || exitReason === "overnight-stop") {
    const tag = exitReason === "stop" ? "STOPPED OUT" : exitReason === "trail-stop" ? "TRAILING STOP HIT" : "OVERNIGHT STOP HIT";
    exitStory = `EXIT: ${tag} at $${exit.toFixed(2)} (${pnlPct?.toFixed(2)}%). Price ${side === "buy" ? "reclaimed and broke below" : "rejected and pushed above"} the invalidation level — the structure that justified the entry was lost.`;
  } else if (exitReason === "time" || exitReason === "next-session-close") {
    exitStory = `EXIT: ${exitReason.toUpperCase().replace(/_/g, " ")} at $${exit.toFixed(2)} (${pnlPct?.toFixed(2)}%). Target wasn't reached during the session — momentum stalled, often a sign of weak follow-through and a candidate to skip in similar conditions.`;
  } else if (exitReason === "bias_flip") {
    exitStory = `EXIT: BIAS FLIP at $${exit.toFixed(2)} (${pnlPct?.toFixed(2)}%). Price crossed back through VWAP and the EMA against our direction — the bullish/bearish thesis broke.`;
  } else {
    exitStory = `EXIT: ${exitReason} at $${exit.toFixed(2)} (${pnlPct?.toFixed(2)}%).`;
  }

  return `${entryStory} ${stopStory} ${exitStory}`;
}

app.get("/api/daily-signals", async (req, res) => {
  try {
    const date     = req.query?.date || new Date().toISOString().slice(0, 10);
    const strategy = (req.query?.strategy || "hybrid").toLowerCase();
    const meta     = STRATEGY_META[strategy];
    if (!meta) return res.status(400).json({ error: `Unknown strategy: ${strategy}` });

    // Resolve watchlist
    let symbols;
    if (req.query?.symbols) {
      symbols = String(req.query.symbols).split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
    } else {
      try {
        const lists = await alpaca("/v2/watchlists");
        if (lists?.length) {
          const detail = await alpaca(`/v2/watchlists/${lists[0].id}`);
          symbols = (detail.assets || []).map(a => a.symbol).filter(Boolean);
        }
      } catch {}
      if (!symbols?.length) symbols = [process.env.SYMBOL || "SPY"];
    }

    const tf = TIMEFRAMES[strategy] || "5m";
    const baseOpts = {
      mode:       "stock",
      forceDaily: strategy === "hybrid" || strategy === "hybrid10", // ensure a trade per symbol per day
      params:     { ...(meta.params || {}) },
    };

    console.log(`[DailySignals] ${strategy} on ${symbols.length} symbols for ${date}`);

    const results = await Promise.all(symbols.map(async symbol => {
      try {
        const r = await runBacktest(strategy, symbol, { ...baseOpts });
        const trades = (r.trades || []).filter(t => t.date === date || (t.entryTime && new Date(t.entryTime).toISOString().slice(0, 10) === date));
        const trade  = trades[0] || null;
        return {
          symbol,
          date,
          trade,
          narrative: structureNarrative(trade, { symbol, reason: trade ? null : "no setup" }),
        };
      } catch (e) {
        return { symbol, date, trade: null, narrative: `${symbol}: data error — ${e.message}` };
      }
    }));

    const tookTrade = results.filter(r => r.trade).length;
    const winners   = results.filter(r => r.trade && (r.trade.pnlPct ?? 0) > 0).length;

    res.json({
      date, strategy, symbols, count: symbols.length,
      tookTrade, winners,
      results,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[DailySignals] Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Strategy Router ───────────────────────────────────────────────────────────

const ACTIVE_FOR_ROUTER = () => (process.env.ACTIVE_STRATEGIES || "hybrid,hybrid10,hybrid-reversal,reversal,vwap")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

// Current regime per watchlist symbol + per-strategy×regime stats heatmap.
app.get("/api/router/state", async (req, res) => {
  try {
    // Resolve watchlist
    let symbols;
    try {
      const lists = await alpaca("/v2/watchlists");
      if (lists?.length) {
        const detail = await alpaca(`/v2/watchlists/${lists[0].id}`);
        symbols = (detail.assets || []).map(a => a.symbol).filter(Boolean);
      }
    } catch {}
    if (!symbols?.length) symbols = [process.env.SYMBOL || "SPY"];

    // For each symbol, fetch recent 5m bars (~5 days) and classify regime
    const tf = "5m";
    const perSymbol = await Promise.all(symbols.map(async sym => {
      try {
        const candles = await fetchCandles(sym, tf);
        const recent  = candles.slice(-400); // last ~2.5 days of 5m bars
        const r       = classifyRegime(recent);
        return { symbol: sym, regime: r.tag, parts: r.parts };
      } catch (e) {
        return { symbol: sym, regime: "unknown", error: e.message };
      }
    }));

    const regimeStats = getAllRegimeStats();
    const activeStrategies = ACTIVE_FOR_ROUTER();

    res.json({
      symbols,
      activeStrategies,
      perSymbol,
      regimeStats,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Run every active strategy across the watchlist for the historical window
// available from Alpaca (~60 days of 5m bars). Saves trades into history so
// the per-regime stats table populates. Required before going live.
app.post("/api/router/backtest-all", async (req, res) => {
  try {
    const strategies = req.body?.strategies || ACTIVE_FOR_ROUTER();
    let symbols      = req.body?.symbols;
    if (!symbols) {
      try {
        const lists = await alpaca("/v2/watchlists");
        if (lists?.length) {
          const detail = await alpaca(`/v2/watchlists/${lists[0].id}`);
          symbols = (detail.assets || []).map(a => a.symbol).filter(Boolean);
        }
      } catch {}
      if (!symbols?.length) symbols = [process.env.SYMBOL || "SPY"];
    }

    console.log(`[Router] bootstrap: ${strategies.length} strategies × ${symbols.length} symbols`);
    const results = [];
    for (const strategy of strategies) {
      for (const symbol of symbols) {
        try {
          const r = await runBacktest(strategy, symbol, {
            mode:          "stock",
            forceDaily:    strategy === "hybrid" || strategy === "hybrid10",
            saveToHistory: true, // appended via the route's saveToHistory path
          });
          // /api/backtest's helper isn't directly available here, so write inline.
          const recs = (r.trades || []).map(t => ({
            symbol, strategy, side: t.side,
            entryPrice: t.entry, exitPrice: t.exit,
            pnlPct: +(t.pnlPct || 0).toFixed(4),
            pnlR:   t.pnlR != null ? +t.pnlR.toFixed(3) : null,
            win:    (t.pnlPct || 0) > 0,
            entryTime: t.entryTime ? new Date(t.entryTime).toISOString() : null,
            exitTime:  t.exitTime  ? new Date(t.exitTime).toISOString()  : null,
            exitReason: t.exitReason,
            regime:    t.regime || "unknown",
            hourET:    t.hourET ?? null,
            forced:    !!t.forced,
            source:    "router-bootstrap",
            recordedAt: new Date().toISOString(),
          }));
          appendToTradeHistory(recs);
          results.push({ strategy, symbol, trades: recs.length });
        } catch (e) {
          results.push({ strategy, symbol, error: e.message });
        }
      }
    }

    res.json({
      strategies, symbols,
      results,
      regimeStats: getAllRegimeStats(),
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[Router] backtest-all error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// For each strategy × regime with ≥ minSamples historical trades, run the
// Hermes optimizer on that bucket and persist the resulting tuned params.
app.post("/api/router/optimize-by-regime", async (req, res) => {
  try {
    const strategies = req.body?.strategies || ACTIVE_FOR_ROUTER();
    const minSamples = Math.max(parseInt(req.body?.minSamples) || 10, 5);
    const stats      = getAllRegimeStats();
    const tuned      = [];

    for (const strategy of strategies) {
      const regimes = stats[strategy] || {};
      for (const [regime, s] of Object.entries(regimes)) {
        if (s.sampleSize < minSamples) continue;
        // Use Hermes's rule-based param suggester on this bucket.
        // We don't have the subset's actual trades here; suggestParamChanges
        // uses aggregate stats so we pass a synthetic trades array shape it accepts.
        try {
          const seedParams = STRATEGY_META[strategy]?.params || {};
          // Fabricate a minimum-viable trades summary by re-loading history.
          const histPath = join(__dirname, "trade-history.json");
          let history = [];
          try { history = JSON.parse(readFileSync(histPath, "utf8")); } catch {}
          const subset = history.filter(t => t.strategy === strategy && t.regime === regime);
          const suggestion = await suggestParamChanges(strategy, seedParams, subset, 1);
          const newParams  = { ...seedParams, ...(suggestion.changes || {}) };
          saveRegimeParams(strategy, regime, newParams, s);
          tuned.push({ strategy, regime, samples: s.sampleSize, winRate: s.winRate, changes: suggestion.changes, reasoning: suggestion.reasoning });
        } catch (e) {
          tuned.push({ strategy, regime, error: e.message });
        }
      }
    }

    res.json({ tuned, generatedAt: new Date().toISOString() });
  } catch (e) {
    console.error("[Router] optimize-by-regime error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Backtest optimization loop ───────────────────────────────────────────────

const TIMEFRAMES = { orb: "5m", vwap: "1H", trend: "1D", meanrev: "1D", momentum: "1D", hybrid: "5m", reversal: "5m", "hybrid-reversal": "5m", hybrid10: "5m" };
const STRATEGY_META = { orb: orbMeta, vwap: vwapMeta, trend: trendMeta, meanrev: meanrevMeta, momentum: momentumMeta, hybrid: hybridMeta, reversal: reversalMeta, "hybrid-reversal": hybridReversalMeta, hybrid10: hybrid10Meta };

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

  // Pull today's IV/DTE from Alpaca for options-mode optimization runs.
  let liveOptionsEnv = null;
  if (baseOpts.mode === "options" && (req.body.useLiveOptions || iv == null || dte == null)) {
    try {
      const px = await lastTradePrice(symbol);
      liveOptionsEnv = await getLiveOptionsParams(symbol, px || 100);
      if (liveOptionsEnv.iv)      baseOpts.iv      = liveOptionsEnv.iv;
      if (liveOptionsEnv.dteDays) baseOpts.dteDays = liveOptionsEnv.dteDays;
      console.log(`[Optimize] Live options env for ${symbol}: IV=${(baseOpts.iv*100).toFixed(1)}% DTE=${baseOpts.dteDays}d (${liveOptionsEnv.source})`);
    } catch (e) { console.warn("[Optimize] Live options fetch failed:", e.message); }
  }

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

    // Annotate the best iteration's trades with Hermes per-trade verdicts so
    // the dashboard can render an "optimized trade list" with reasons inline.
    const bestTradesRaw = (iterResults[bestIdx].trades || []).map(t => ({
      ...t,
      strategy,
      symbol,
      side: t.side,
      entryPrice: t.entry,
      exitPrice:  t.exit,
      // explainTrades expects pnlPct present on the trade
    }));
    const bestTradesAnnotated = explainTrades(bestTradesRaw).slice(-200);

    // Auto-deploy best params to learned-params.json so the live bot picks
    // them up on the next signal. Set autoDeploy:false to opt out.
    let autoDeployed = null;
    if (req.body.autoDeploy !== false) {
      const learnFile = join(__dirname, "learned-params.json");
      let learned = {};
      try { if (existsSync(learnFile)) learned = JSON.parse(readFileSync(learnFile, "utf8")); } catch {}
      learned[strategy] = {
        ...(learned[strategy] || {}),
        params:        iterResults[bestIdx].params,
        source:        "hermes-auto-deploy",
        bestReturnPct: iterResults[bestIdx].returnPct,
        targetReturnPct: targetPct,
        targetReached,
        deployedAt:    new Date().toISOString(),
      };
      writeFileSync(learnFile, JSON.stringify(learned, null, 2));
      autoDeployed = {
        strategy,
        params:    iterResults[bestIdx].params,
        returnPct: iterResults[bestIdx].returnPct,
      };
      console.log(`[Optimize] 🚀 Auto-deployed best params for ${strategy} → ${JSON.stringify(iterResults[bestIdx].params)}`);
    }

    // Strip the trades array off iterations before returning (keep payload small)
    const output = {
      strategy,
      symbol,
      iterations:    iterResults.map(({ trades: _t, ...rest }) => rest),
      bestIteration: bestIdx + 1,
      bestParams:    iterResults[bestIdx].params,
      bestReturnPct: iterResults[bestIdx].returnPct,
      bestTrades:    bestTradesAnnotated,
      bestMetrics:   iterResults[bestIdx].metrics,
      targetReturnPct: targetPct,
      targetReached,
      savedToHistory:  savedCount,
      autoDeployed,
      liveOptionsEnv,
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
