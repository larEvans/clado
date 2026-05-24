import express from "express";
import fetch from "node-fetch";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import "dotenv/config";
import { runBacktest } from "./backtest.js";
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
import { runHermesAnalysis, loadAllInsights } from "./hermes.js";

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

app.post("/api/backtest", async (req, res) => {
  const { strategy, symbol, mode, iv, dte, contracts, strikeInterval } = req.body;
  if (!strategy || !symbol) return res.status(400).json({ error: "strategy and symbol required" });
  try {
    const opts = {
      mode:           mode || "stock",
      iv:             parseFloat(iv) / 100 || 0.25,
      dteDays:        parseInt(dte)         || 7,
      numContracts:   parseInt(contracts)   || 1,
      strikeInterval: parseFloat(strikeInterval) || 1,
    };
    console.log(`Running backtest: ${strategy} on ${symbol} [${opts.mode}]`);
    const results = await runBacktest(strategy, symbol, opts);
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

// Start Alpaca stream if credentials are present
if (process.env.ALPACA_API_KEY && process.env.ALPACA_SECRET_KEY) {
  const symbol     = process.env.SYMBOL || "SPY";
  const liveStream = new AlpacaStream([symbol]);
  liveStream.on("bar",   bar   => broadcastSSE({ type: "bar",   ...bar }));
  liveStream.on("trade", trade => broadcastSSE({ type: "trade", ...trade }));
  liveStream.on("connected",    () => console.log("Live price stream connected"));
  liveStream.on("disconnected", () => console.log("Live price stream disconnected"));
  liveStream.on("error",        err => console.warn("Live stream:", err.message));
  liveStream.connect();
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

// ─── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Dashboard running at http://localhost:${PORT}/dashboard.html`);
});
