import express from "express";
import fetch from "node-fetch";
import { timingSafeEqual } from "crypto";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import "dotenv/config";
import { runBacktest, fetchCandles } from "./backtest.js";
import { runCPCV } from "./cpcv.js";
import { runAgentDebate } from "./agents.js";
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
import { meta as gapFillMeta }         from "./strategies/gap-fill.js";
import { meta as vwapReclaimMeta }     from "./strategies/vwap-reclaim.js";
import { meta as firstHourFadeMeta }   from "./strategies/first-hour-fade.js";
import { meta as smcMeta }             from "./strategies/smc.js";
import { fetchChain, fetchExpiryDates, fetchContracts, getLiveOptionsParams } from "./options.js";
import { AlpacaStream } from "./stream.js";
import { loadAllLearning, getAllRegimeStats, saveRegimeParams, getRegimeStats, getOptionsHistoryStats, suggestEarlyExitPct } from "./learner.js";
import { classifyRegime } from "./regime.js";
import { screenWatchlist } from "./ml/screener.js";
import { modelInfo } from "./ml/predictor.js";
import { checkSignal as smcCheckSignal } from "./strategies/smc.js";
import { runHermesAnalysis, loadAllInsights, suggestParamChanges, explainTrades, deriveWinOnlyFilters } from "./hermes.js";
import { dataPath, DATA_DIR } from "./state.js";

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

// Unauthenticated liveness probe for Railway's healthcheck (must stay above
// the auth middleware — the healthcheck has no token).
app.get("/healthz", (req, res) => res.json({ ok: true }));

// ─── Auth ─────────────────────────────────────────────────────────────────────
//
// Set DASHBOARD_TOKEN in the environment to protect every route — pages,
// static files and /api/*. Open the dashboard once as /?token=YOUR_TOKEN and
// the server sets an HttpOnly cookie so the page's own fetch() calls keep
// working without any frontend changes. API clients can send the token in an
// "x-dashboard-token" header instead. Without DASHBOARD_TOKEN set, the
// dashboard stays open (and warns loudly) so existing setups don't break.

const DASHBOARD_TOKEN = (process.env.DASHBOARD_TOKEN || "").trim();
const TOKEN_COOKIE    = "dashboard_token";

if (!DASHBOARD_TOKEN) {
  console.warn(
    "[Dashboard] WARNING: DASHBOARD_TOKEN is not set — the dashboard (account data, " +
    "config toggles, trade endpoints) is reachable by anyone with the URL. " +
    "Set DASHBOARD_TOKEN in your environment to require a token."
  );
}

function tokenMatches(candidate) {
  if (!candidate) return false;
  const a = Buffer.from(String(candidate));
  const b = Buffer.from(DASHBOARD_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function cookieToken(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === TOKEN_COOKIE) {
      try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

app.use((req, res, next) => {
  if (!DASHBOARD_TOKEN) return next();
  const queryToken = typeof req.query.token === "string" ? req.query.token : null;
  const supplied   = req.get("x-dashboard-token") || queryToken || cookieToken(req);
  if (!tokenMatches(supplied)) {
    return res.status(401).type("text/plain")
      .send("Unauthorized. Open the dashboard as /?token=YOUR_DASHBOARD_TOKEN, or send an x-dashboard-token header.");
  }
  if (queryToken) {
    // Persist the token as a cookie so subsequent page requests and the
    // dashboard's own API calls authenticate without the query param.
    res.setHeader("Set-Cookie",
      `${TOKEN_COOKIE}=${encodeURIComponent(queryToken)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=2592000`);
  }
  next();
});

app.use(express.static(__dirname));
app.get("/", (req, res) => res.sendFile(join(__dirname, "dashboard.html")));

// ─── Runtime bot config (toggleable from the dashboard) ───────────────────────
//
// bot-config.json overrides env vars for: routerEnabled, activeStrategies,
// cryptoSymbols, consensusMin, maxConcurrentPositions. bot-stream.js polls
// this file every 30s so the toggle flips live; symbol changes require a
// service restart (we surface a "restart required" flag in the response).

const CONFIG_FILE = dataPath("bot-config.json");

function parseEnvBool(value, defaultValue = false) {
  if (value == null || value === "") return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  return defaultValue;
}

function loadBotConfig() {
  const defaults = {
    routerEnabled:          parseEnvBool(process.env.ROUTER_ENABLED, true),
    consensusMin:           parseInt(process.env.CONSENSUS_MIN || "1"),
    maxConcurrentPositions: parseInt(process.env.MAX_CONCURRENT_POSITIONS || "5"),
    activeStrategies:       (process.env.ACTIVE_STRATEGIES || "hybrid10,vwap-reclaim")
                              .split(",").map(s => s.trim().toLowerCase()).filter(Boolean),
    cryptoSymbols:          (process.env.CRYPTO_SYMBOLS || "")
                              .split(",").map(s => s.trim().toUpperCase()).filter(Boolean),
    optionsMode:            parseEnvBool(process.env.OPTIONS_MODE, false),
    optionsDte:             parseInt(process.env.OPTIONS_DTE || "7"),
    updatedAt:              null,
  };
  if (!existsSync(CONFIG_FILE)) return defaults;
  try {
    const fileCfg = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    return { ...defaults, ...fileCfg };
  } catch { return defaults; }
}

function saveBotConfig(patch) {
  const current = loadBotConfig();
  const next    = { ...current, ...patch, updatedAt: new Date().toISOString() };
  writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  return next;
}

app.get("/api/config", (req, res) => {
  res.json({ ...loadBotConfig(), configFile: CONFIG_FILE });
});

app.patch("/api/config", (req, res) => {
  const allowed = ["routerEnabled", "consensusMin", "maxConcurrentPositions", "activeStrategies", "cryptoSymbols", "optionsMode", "optionsDte"];
  const patch = {};
  for (const k of allowed) if (req.body?.[k] !== undefined) patch[k] = req.body[k];
  // Coerce types
  if (patch.routerEnabled !== undefined)          patch.routerEnabled = !!patch.routerEnabled;
  if (patch.consensusMin !== undefined)           patch.consensusMin = Math.max(1, parseInt(patch.consensusMin) || 1);
  if (patch.maxConcurrentPositions !== undefined) patch.maxConcurrentPositions = Math.max(1, parseInt(patch.maxConcurrentPositions) || 5);
  if (patch.optionsMode !== undefined)            patch.optionsMode = !!patch.optionsMode;
  if (patch.optionsDte !== undefined)             patch.optionsDte  = Math.max(0, parseInt(patch.optionsDte) || 7);
  if (Array.isArray(patch.activeStrategies))      patch.activeStrategies = patch.activeStrategies.map(s => String(s).trim().toLowerCase()).filter(Boolean);
  if (Array.isArray(patch.cryptoSymbols))         patch.cryptoSymbols    = patch.cryptoSymbols.map(s => String(s).trim().toUpperCase()).filter(Boolean);

  // Determine if a bot-stream restart is needed (symbol changes require it)
  const before = loadBotConfig();
  const cryptoChanged = patch.cryptoSymbols && JSON.stringify(patch.cryptoSymbols) !== JSON.stringify(before.cryptoSymbols);
  const stratChanged  = patch.activeStrategies && JSON.stringify(patch.activeStrategies) !== JSON.stringify(before.activeStrategies);
  const restartRequired = cryptoChanged || stratChanged;

  const next = saveBotConfig(patch);
  res.json({ ok: true, config: next, restartRequired, changed: Object.keys(patch) });
});

// Add a stock to the user's Alpaca watchlist (first watchlist for now).
// If the account has no watchlist yet via the /v2/watchlists REST resource
// (e.g. a list built in Alpaca's newer web UI doesn't always show up here),
// create one automatically instead of erroring out — the dashboard becomes
// the reliable source of truth rather than depending on Alpaca's UI quirks.
app.post("/api/watchlist/add", async (req, res) => {
  const symbol = String(req.body?.symbol || "").trim().toUpperCase();
  if (!symbol) return res.status(400).json({ error: "symbol required" });
  if (symbol.includes("/")) return res.status(400).json({ error: "Crypto symbols (with /) belong in the Crypto Symbols section, not the stock watchlist" });
  try {
    const lists = await alpaca("/v2/watchlists");
    if (!lists?.length) {
      // No watchlist visible via the Trading API — create one now.
      const r = await fetch(`${ALPACA_BASE}/v2/watchlists`, {
        method: "POST",
        headers: ALPACA_HEADERS,
        body:    JSON.stringify({ name: "Bot Watchlist", symbols: [symbol] }),
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data?.message || JSON.stringify(data) });
      return res.json({ ok: true, symbol, watchlistId: data.id, created: true, restartRequired: true });
    }
    const wlId = lists[0].id;
    const r = await fetch(`${ALPACA_BASE}/v2/watchlists/${wlId}`, {
      method: "POST",
      headers: ALPACA_HEADERS,
      body:    JSON.stringify({ symbol }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data?.message || JSON.stringify(data) });
    res.json({ ok: true, symbol, watchlistId: wlId, restartRequired: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/watchlist/:symbol", async (req, res) => {
  const symbol = String(req.params.symbol || "").trim().toUpperCase();
  try {
    const lists = await alpaca("/v2/watchlists");
    if (!lists?.length) return res.status(404).json({ error: "No Alpaca watchlist exists" });
    const wlId = lists[0].id;
    const r = await fetch(`${ALPACA_BASE}/v2/watchlists/${wlId}/${symbol}`, {
      method: "DELETE",
      headers: ALPACA_HEADERS,
    });
    if (!r.ok && r.status !== 422 && r.status !== 404) {
      const text = await r.text();
      return res.status(r.status).json({ error: text });
    }
    res.json({ ok: true, symbol, restartRequired: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/crypto/add", (req, res) => {
  const symbol = String(req.body?.symbol || "").trim().toUpperCase();
  if (!symbol) return res.status(400).json({ error: "symbol required" });
  // Normalize: if user typed BTCUSD, convert to BTC/USD
  const normalized = symbol.includes("/") ? symbol :
    /^(BTC|ETH|SOL|DOGE|AVAX|LINK|MATIC|DOT|UNI|BCH|LTC|XRP|ADA|XLM|SHIB|AAVE)([A-Z]{3,4})$/.test(symbol)
      ? symbol.replace(/^(\w+)(USD|USDT|USDC|EUR)$/, "$1/$2")
      : null;
  if (!normalized) return res.status(400).json({ error: "Symbol must be in BASE/QUOTE format (e.g. BTC/USD)" });
  const cfg = loadBotConfig();
  if (cfg.cryptoSymbols.includes(normalized)) return res.json({ ok: true, symbol: normalized, alreadyPresent: true, config: cfg });
  const next = saveBotConfig({ cryptoSymbols: [...cfg.cryptoSymbols, normalized] });
  res.json({ ok: true, symbol: normalized, config: next, restartRequired: true });
});

app.delete("/api/crypto/:symbol", (req, res) => {
  // The URL param will have an encoded slash for BTC%2FUSD
  const symbol = decodeURIComponent(String(req.params.symbol || "")).toUpperCase();
  const cfg = loadBotConfig();
  if (!cfg.cryptoSymbols.includes(symbol)) return res.status(404).json({ error: "symbol not in config" });
  const next = saveBotConfig({ cryptoSymbols: cfg.cryptoSymbols.filter(s => s !== symbol) });
  res.json({ ok: true, symbol, config: next, restartRequired: true });
});

// ─── Test trade — fire a tiny paper order to confirm execution path works ──
// POST /api/test-trade  { symbol, side, notional, type?, tif? }
// Defaults: notional=$2, type=market. For crypto symbols (with "/"), tif=gtc.
// Returns the raw Alpaca response so we can see exactly what happened.
app.post("/api/test-trade", async (req, res) => {
  try {
    const body = req.body || {};
    const symbol   = (body.symbol || "BTC/USD").trim();
    const side     = (body.side   || "buy").toLowerCase();
    const notional = parseFloat(body.notional ?? 2);
    const type     = (body.type   || "market").toLowerCase();
    const isCrypto = symbol.includes("/");
    const tif      = (body.tif    || (isCrypto ? "gtc" : "day")).toLowerCase();

    const orderBody = {
      symbol,
      notional:      notional.toFixed(2),
      side,
      type,
      time_in_force: tif,
    };

    const url = `${ALPACA_BASE}/v2/orders`;
    const r = await fetch(url, { method: "POST", headers: ALPACA_HEADERS, body: JSON.stringify(orderBody) });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }

    res.status(r.ok ? 200 : 400).json({
      ok:        r.ok,
      status:    r.status,
      sentTo:    url,
      sentBody:  orderBody,
      response:  data,
      hints: r.ok ? [] : [
        symbol.includes("/")
          ? "Crypto orders require crypto trading enabled on your Alpaca account → https://app.alpaca.markets/paper/dashboard/overview → Settings → Crypto"
          : null,
        r.status === 403 ? "Account permissions issue — check Alpaca dashboard." : null,
        r.status === 422 ? "Symbol or order parameters invalid — check the response." : null,
      ].filter(Boolean),
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

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

  // ── Does this dashboard process share a filesystem with bot-stream.js? ──
  // If Railway runs them as TWO SEPARATE SERVICES instead of one service
  // running `node start.js` (which spawns both as children), each gets its
  // own private ephemeral disk. Config toggles/predictions written here would
  // then never reach the bot process, and vice versa — the #1 cause of "I
  // turned the bot on but the dashboard still shows it off."
  const hbFile     = dataPath("bot-heartbeat.json");
  const cfgFile    = dataPath("bot-config.json");
  let heartbeat = null, heartbeatAgeSec = null;
  try {
    if (existsSync(hbFile)) {
      heartbeat = JSON.parse(readFileSync(hbFile, "utf8"));
      heartbeatAgeSec = Math.round((Date.now() - new Date(heartbeat.at).getTime()) / 1000);
    }
  } catch {}
  diag.sharedFilesystem = {
    DATA_DIR: DATA_DIR,
    heartbeatFile: hbFile,
    heartbeatFound: !!heartbeat,
    heartbeatAgeSec,
    heartbeatAlive: heartbeatAgeSec != null && heartbeatAgeSec < 180,
    configFile: cfgFile,
    configFound: existsSync(cfgFile),
  };
  if (!heartbeat) {
    diag.hints.push(
      "No bot-heartbeat.json found in this process's DATA_DIR. Either bot-stream.js has never run, " +
      "or — very common — Railway is running dashboard.js and bot-stream.js as TWO SEPARATE SERVICES " +
      "(e.g. from an old Procfile with 'web:' and 'bot:' process types). Each service gets its own " +
      "private disk, so they can never see each other's state files or config toggles. Fix: make sure " +
      "Railway has exactly ONE service for this repo, with start command `node start.js` (see railway.json) " +
      "— that single process spawns BOTH bot-stream.js and dashboard.js as children sharing one filesystem. " +
      "If you see two services (e.g. 'web' and 'bot') in the Railway project, delete one and keep only the " +
      "one running start.js, or set DATA_DIR on both to the SAME mounted volume."
    );
  } else if (heartbeatAgeSec >= 180) {
    diag.hints.push(`Last bot heartbeat was ${Math.round(heartbeatAgeSec / 60)} minutes ago — the bot process appears to have stopped. Check the Railway logs for that service.`);
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
  const logPath = dataPath("safety-check-log.json");
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
  const all = [
    hybridMeta, hybridReversalMeta, hybrid10Meta,
    reversalMeta, vwapMeta, vwapReclaimMeta,
    gapFillMeta, firstHourFadeMeta, smcMeta,
    orbMeta, trendMeta, meanrevMeta, momentumMeta,
  ];
  if (req.query?.all === "1") return res.json(all);
  // Hybrid family + Reversal + VWAP family + new ≥50% strategies active by default.
  const whitelist = (process.env.ACTIVE_STRATEGIES ||
    "hybrid,hybrid-reversal,hybrid10,smc,reversal,vwap,vwap-reclaim,gap-fill,first-hour-fade")
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
    isOption:      t.optionType ? true : false,
    optionType:    t.optionType    || null,
    optionStrike:  t.optionStrike  || null,
    optionDte:     t.optionDTE     ?? null,
    optionIv:      t.optionIv      ?? null,
    entryPremium:  t.entryPremium  != null ? +t.entryPremium.toFixed(4)  : null,
    exitPremium:   t.exitPremium   != null ? +t.exitPremium.toFixed(4)   : null,
    optionsPnL:    t.optionsPnL    != null ? +t.optionsPnL.toFixed(2)    : null,
    optionsPnLPct: t.optionsPnLPct != null ? +t.optionsPnLPct.toFixed(4) : null,
    optionsWin:    t.optionsPnL != null ? t.optionsPnL > 0 : null,
    // Buckets so the learner doesn't need to recompute them on read
    dteBucket:     t.optionDTE == null ? null :
                   t.optionDTE <= 1 ? "0-1d" :
                   t.optionDTE <= 4 ? "2-4d" :
                   t.optionDTE <= 9 ? "5-9d" :
                   t.optionDTE <= 21 ? "10-21d" : "22d+",
    strikeDistPct: (t.optionStrike != null && t.entry) ? +(((t.optionStrike - t.entry) / t.entry) * 100).toFixed(3) : null,
    premiumPctOfSpot: (t.entryPremium != null && t.entry) ? +((t.entryPremium / t.entry) * 100).toFixed(3) : null,
    recordedAt: new Date().toISOString(),
  }));
}

function appendToTradeHistory(records) {
  if (!records || records.length === 0) return 0;
  const histFile = dataPath("trade-history.json");
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
    smc:               "pinescript/smc.pine",
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
  const histFile = dataPath("trade-history.json");
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
  const histFile = dataPath("trade-history.json");
  if (!existsSync(histFile)) return res.status(400).json({ error: "No trade history" });
  try {
    const all = JSON.parse(readFileSync(histFile, "utf8"));
    const trades = all.filter(t => t.strategy === strategy);
    const { filters, blockedLosers, totalLosers, estWinRateAfter } = deriveWinOnlyFilters(trades);

    const learnFile = dataPath("learned-params.json");
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
  const stateFile   = dataPath("bot-state.json");
  const historyFile = dataPath("trade-history.json");

  let state   = null;
  let history = [];
  let learning = {};

  try { if (existsSync(stateFile))   state   = JSON.parse(readFileSync(stateFile,   "utf8")); } catch {}
  try { if (existsSync(historyFile)) history = JSON.parse(readFileSync(historyFile, "utf8")); } catch {}
  try { learning = loadAllLearning(); } catch {}

  // Bot process liveness — bot-stream writes bot-heartbeat.json every 60s
  // regardless of market hours. alive = heartbeat fresher than 3 minutes.
  let heartbeat = null;
  try {
    const hbFile = dataPath("bot-heartbeat.json");
    if (existsSync(hbFile)) {
      const hb = JSON.parse(readFileSync(hbFile, "utf8"));
      const ageSec = (Date.now() - new Date(hb.at).getTime()) / 1000;
      heartbeat = { ...hb, ageSec: Math.round(ageSec), alive: ageSec < 180 };
    }
  } catch {}

  const last20   = history.slice(-20);
  const wins     = last20.filter(t => t.win).length;
  const winRate  = last20.length > 0 ? wins / last20.length : null;
  const avgPnl   = last20.length > 0 ? last20.reduce((s, t) => s + t.pnlPct, 0) / last20.length : null;

  res.json({
    state,
    heartbeat,
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

// ─── Year-long options backtest across all strategies × watchlist ────────────
//
// Runs every active strategy across every watchlist symbol on ~1 year of 5m
// data, in options mode, pulling today's IV/DTE from Alpaca per symbol so the
// Black-Scholes math reflects a realistic current environment. Aggregates
// per-strategy and per-symbol results, saves trades to history (so the regime
// router and Hermes can learn from them), and reports total options PnL.

app.post("/api/backtest/year-options", async (req, res) => {
  try {
    const strategies = req.body?.strategies || ACTIVE_FOR_ROUTER();
    let symbols      = req.body?.symbols;
    const contracts  = parseInt(req.body?.contracts) || 1;
    const dteOverride = req.body?.dte != null ? parseInt(req.body.dte) : null;
    const ivOverride  = req.body?.iv  != null ? parseFloat(req.body.iv) / 100 : null;

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

    console.log(`[YearOptions] ${strategies.length} strategies × ${symbols.length} symbols × 1y of 5m bars in options mode`);

    // Pre-fetch live options env once per symbol so we don't hammer the API
    const liveBySymbol = {};
    for (const sym of symbols) {
      try {
        const px   = await lastTradePrice(sym);
        const live = await getLiveOptionsParams(sym, px || 100);
        liveBySymbol[sym] = live;
      } catch (e) {
        liveBySymbol[sym] = { iv: 0.25, dteDays: 7, source: "fallback", error: e.message };
      }
    }

    const results = [];
    for (const strategy of strategies) {
      for (const symbol of symbols) {
        try {
          const live = liveBySymbol[symbol];
          const opts = {
            mode:           "options",
            iv:             ivOverride ?? live.iv ?? 0.25,
            dteDays:        dteOverride ?? live.dteDays ?? 7,
            numContracts:   contracts,
            strikeInterval: 1,
            forceDaily:     strategy === "hybrid" || strategy === "hybrid10",
            yearWindow:     true,
          };
          const r = await runBacktest(strategy, symbol, opts);
          const trades = r.trades || [];
          const wins   = trades.filter(t => (t.pnlPct || 0) > 0).length;
          const total  = trades.length;
          const winRate = total > 0 ? wins / total : 0;
          const optTotal  = r.optionsMetrics?.totalPnL          || "$0.00";
          const optMoved  = r.optionsMetrics?.totalPremiumTraded || "$0.00";

          // Persist to trade-history with the source tag.
          const recs = trades.map(t => ({
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
            optionType:   t.optionType    || null,
            optionStrike: t.optionStrike  || null,
            entryPremium: t.entryPremium  || null,
            exitPremium:  t.exitPremium   || null,
            optionsPnL:   t.optionsPnL    || null,
            optionsPnLPct: t.optionsPnLPct || null,
            source:     "year-options",
            forced:     !!t.forced,
            recordedAt: new Date().toISOString(),
          }));
          appendToTradeHistory(recs);

          results.push({
            strategy, symbol,
            totalTrades: total,
            wins, losses: total - wins,
            winRate:    +(winRate * 100).toFixed(1),
            totalReturnR: r.totalReturnR,
            profitFactor: r.profitFactor,
            maxDrawdown:  r.maxDrawdown,
            optionsTotalPnL: optTotal,
            optionsPremiumMoved: optMoved,
            liveOptionsEnv: live,
            saved: recs.length,
          });
        } catch (e) {
          results.push({ strategy, symbol, error: e.message });
        }
      }
    }

    // Aggregate per strategy
    const byStrategy = {};
    for (const r of results) {
      if (r.error) continue;
      byStrategy[r.strategy] = byStrategy[r.strategy] || { trades: 0, wins: 0, premiumMoved: 0, pnlTotal: 0 };
      const slot = byStrategy[r.strategy];
      slot.trades += r.totalTrades;
      slot.wins   += r.wins;
      slot.premiumMoved += parseFloat((r.optionsPremiumMoved || "0").replace(/[$,]/g, "")) || 0;
      slot.pnlTotal     += parseFloat((r.optionsTotalPnL     || "0").replace(/[$,]/g, "")) || 0;
    }
    const stratSummary = Object.entries(byStrategy).map(([s, v]) => ({
      strategy: s,
      trades:   v.trades,
      winRate:  v.trades > 0 ? +((v.wins / v.trades) * 100).toFixed(1) : 0,
      premiumMoved: "$" + v.premiumMoved.toFixed(2),
      pnlTotal:     "$" + v.pnlTotal.toFixed(2),
    })).sort((a, b) => b.winRate - a.winRate);

    res.json({
      strategies, symbols,
      results,
      summary: stratSummary,
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[YearOptions] error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Agent debate preview ─────────────────────────────────────────────────────
//
// POST a trade candidate; get Bull / Bear / Risk-Manager verdicts back. Lets
// the dashboard show a "What would the agents say?" preview before going live.

app.post("/api/agents/preview", async (req, res) => {
  const trade = req.body?.trade;
  if (!trade || !trade.side) return res.status(400).json({ error: "trade.side required" });
  try {
    const ctx    = req.body?.context || {};
    const result = await runAgentDebate(trade, ctx);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── CPCV (Combinatorial Purged Cross-Validation) ─────────────────────────────
//
// POST body: { strategy, symbol, K=6, N=2, purgeBars=20, metric="winRate" }
// Returns: per-fold metrics, aggregate stats (mean, stddev, CV), PBO estimate,
// and a verdict (ROBUST / OK / UNSTABLE / LIKELY_OVERFIT / INSUFFICIENT_DATA).

app.post("/api/backtest/cpcv", async (req, res) => {
  const { strategy, symbol, K = 6, N = 2, purgeBars = 20, metric = "winRate", mode = "stock", iv, dte, contracts } = req.body || {};
  if (!strategy || !symbol) return res.status(400).json({ error: "strategy and symbol required" });

  const meta = STRATEGY_META[strategy];
  if (!meta) return res.status(400).json({ error: `Unknown strategy: ${strategy}` });

  const tf      = TIMEFRAMES[strategy] || "5m";
  const opts    = {
    mode:           mode || "stock",
    iv:             parseFloat(iv) / 100 || 0.25,
    dteDays:        parseInt(dte)         || 7,
    numContracts:   parseInt(contracts)   || 1,
    forceDaily:     strategy === "hybrid" || strategy === "hybrid10",
  };

  try {
    console.log(`[CPCV] ${strategy} on ${symbol} — K=${K} N=${N} purge=${purgeBars} metric=${metric}`);
    const candles = await fetchCandles(symbol, tf);
    const result  = await runCPCV(strategy, symbol, candles, {
      K, N, purgeBars,
      params: { ...meta.params },
      opts,
      metric,
    });
    res.json(result);
  } catch (e) {
    console.error("[CPCV] error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Options Strategist learning ──────────────────────────────────────────────
//
// What the agent has learned from closed options trades — bucket stats by
// DTE × delta, plus single-dimension breakdowns. The Options Backtest tab
// renders this so you can see which contract profiles actually win.

app.get("/api/options/learning", (req, res) => {
  const strategy = req.query?.strategy || null;
  const symbol   = req.query?.symbol   || null;
  const min      = parseInt(req.query?.minSampleSize || "5");
  res.json(getOptionsHistoryStats({ strategy, symbol, minSampleSize: min }));
});

// ─── Strategy Router ───────────────────────────────────────────────────────────

const ACTIVE_FOR_ROUTER = () => (process.env.ACTIVE_STRATEGIES ||
  "hybrid,hybrid10,hybrid-reversal,reversal,vwap,vwap-reclaim,gap-fill,first-hour-fade")
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
      config: (() => {
        const cfg = loadBotConfig();
        return {
          routerEnabled:        cfg.routerEnabled,
          strictRouter:         process.env.STRICT_ROUTER === "true",
          consensusMin:         cfg.consensusMin,
          maxConcurrentPositions: cfg.maxConcurrentPositions,
          activeStrategies:     cfg.activeStrategies,
          cryptoSymbols:        cfg.cryptoSymbols,
          agentDebate:          process.env.AGENT_DEBATE === "true",
        };
      })(),
      generatedAt: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Advisory screener — run the price-target model across the whole watchlist ─
// Purely advisory (never trades): ranks every watchlist symbol by predicted
// return × confidence and shows which strategy signals are firing alongside.
app.get("/api/screener", async (req, res) => {
  try {
    // Resolve watchlist (same source the router uses)
    let symbols;
    try {
      const lists = await alpaca("/v2/watchlists");
      if (lists?.length) {
        const detail = await alpaca(`/v2/watchlists/${lists[0].id}`);
        symbols = (detail.assets || []).map(a => a.symbol).filter(Boolean);
      }
    } catch {}
    if (!symbols?.length) symbols = [process.env.SYMBOL || "SPY"];

    const interval = req.query.interval || process.env.PREDICTOR_INTERVAL || "5m";
    const rows = await Promise.all(symbols.map(async sym => {
      try {
        const candles = await fetchCandles(sym, interval);
        const bars = candles.slice(-300); // recent window for features/signal
        let signals = [];
        try {
          const smc = smcCheckSignal(bars);
          if (smc) signals.push({ strategy: "smc", signal: smc });
        } catch {}
        return { symbol: sym, bars, signals, regime: classifyRegime(bars).tag };
      } catch (e) {
        return { symbol: sym, bars: [], signals: [], error: e.message };
      }
    }));

    const minConfidence = req.query.minConfidence != null ? Number(req.query.minConfidence) : 0;
    const result = screenWatchlist(rows, { minConfidence, withFeatures: req.query.features === "1" });
    // Attach regime tags back onto the ranked picks for display.
    const regimeBySym = Object.fromEntries(rows.map(r => [r.symbol, r.regime]));
    for (const p of result.picks) p.regime = regimeBySym[p.symbol] || null;

    res.json({
      ...result,
      interval,
      model: modelInfo(), // null when running on the heuristic baseline
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Live predictions view — what the BOT actually saw and did ────────────────
// Three sections: price targets per symbol (from predictions.json, written by
// bot-stream on every evaluation), potential trades (cleared threshold but not
// taken / would fire), and trades taken by the predictor with target-vs-actual.
app.get("/api/predictions", (req, res) => {
  try {
    // 1+2. Live per-symbol snapshots from the bot process
    let live = null;
    const predFile = dataPath("predictions.json");
    if (existsSync(predFile)) {
      try { live = JSON.parse(readFileSync(predFile, "utf8")); } catch {}
    }

    // 3. Predictor-driven closed trades (trade-history.json) + open positions
    //    (bot-router-state.json), newest first.
    let taken = [];
    const histFile = dataPath("trade-history.json");
    if (existsSync(histFile)) {
      try {
        const history = JSON.parse(readFileSync(histFile, "utf8"));
        taken = history
          .filter(t => t.strategy === "predictor" || t.prediction)
          .slice(-100)
          .reverse()
          .map(t => ({
            ...t,
            targetHit: t.prediction && t.exitPrice != null
              ? (t.side === "buy" ? t.exitPrice >= t.prediction.priceTarget : t.exitPrice <= t.prediction.priceTarget)
              : null,
          }));
      } catch {}
    }
    let openPositions = [];
    const routerFile = dataPath("bot-router-state.json");
    if (existsSync(routerFile)) {
      try {
        const rs = JSON.parse(readFileSync(routerFile, "utf8"));
        openPositions = Object.entries(rs.symbols || {})
          .filter(([, s]) => s.position)
          .map(([sym, s]) => ({ symbol: sym, ...s.position }));
      } catch {}
    }

    res.json({
      generatedAt: new Date().toISOString(),
      live,          // { date, tradesToday, minTradesPerDay, perSymbol: [...] } or null if bot hasn't written yet
      openPositions,
      taken,
      model: modelInfo(),
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
          const histPath = dataPath("trade-history.json");
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

const TIMEFRAMES = { orb: "5m", vwap: "1H", trend: "1D", meanrev: "1D", momentum: "1D", hybrid: "5m", reversal: "5m", "hybrid-reversal": "5m", hybrid10: "5m", "gap-fill": "5m", "vwap-reclaim": "5m", "first-hour-fade": "5m", smc: "15m" };
const STRATEGY_META = {
  orb: orbMeta, vwap: vwapMeta, trend: trendMeta, meanrev: meanrevMeta, momentum: momentumMeta,
  hybrid: hybridMeta, reversal: reversalMeta, "hybrid-reversal": hybridReversalMeta, hybrid10: hybrid10Meta,
  "gap-fill": gapFillMeta, "vwap-reclaim": vwapReclaimMeta, "first-hour-fade": firstHourFadeMeta, smc: smcMeta,
};

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
    const bestParamsWithExit = {
      ...iterResults[bestIdx].params,
      nearTargetPct: suggestEarlyExitPct(bestTradesRaw, iterResults[bestIdx].params.nearTargetPct),
    };

    // Auto-deploy best params to learned-params.json so the live bot picks
    // them up on the next signal. Set autoDeploy:false to opt out.
    let autoDeployed = null;
    if (req.body.autoDeploy !== false) {
      const learnFile = dataPath("learned-params.json");
      let learned = {};
      try { if (existsSync(learnFile)) learned = JSON.parse(readFileSync(learnFile, "utf8")); } catch {}
      learned[strategy] = {
        ...(learned[strategy] || {}),
        params:        bestParamsWithExit,
        source:        "hermes-auto-deploy",
        bestReturnPct: iterResults[bestIdx].returnPct,
        targetReturnPct: targetPct,
        targetReached,
        deployedAt:    new Date().toISOString(),
      };
      writeFileSync(learnFile, JSON.stringify(learned, null, 2));
      autoDeployed = {
        strategy,
        params:    bestParamsWithExit,
        returnPct: iterResults[bestIdx].returnPct,
      };
      console.log(`[Optimize] 🚀 Auto-deployed best params for ${strategy} → ${JSON.stringify(bestParamsWithExit)}`);
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

    const histFile = dataPath("backtest-history.json");
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
  const histFile = dataPath("backtest-history.json");
  if (!existsSync(histFile)) return res.json({});
  try { res.json(JSON.parse(readFileSync(histFile, "utf8"))); } catch { res.json({}); }
});

// ─── Deploy optimized params to bot ───────────────────────────────────────────

app.post("/api/deploy", async (req, res) => {
  const { strategy, params } = req.body;
  if (!strategy || !params) return res.status(400).json({ error: "strategy and params required" });

  const learnFile = dataPath("learned-params.json");
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
