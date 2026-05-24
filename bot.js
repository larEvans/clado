/**
 * Claude + TradingView MCP — Automated Trading Bot
 *
 * Exchanges: BitGet (crypto) or Webull (stocks/ETFs) — set EXCHANGE= in .env
 * Market data: Binance/Kraken (crypto) or Yahoo Finance (stocks)
 *
 * Local mode: node bot.js
 * One-time Webull login: node bot.js --webull-login
 * Cloud mode: deploy to Railway/VPS, set env vars, run on cron schedule
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import crypto from "crypto";
import { execSync } from "child_process";
import { selectContract, placeOptionsOrder } from "./options.js";

const WEBULL_TOKEN_FILE = ".webull-token.json";
const WEBULL_DEVICE_FILE = ".webull-device.json";

// ─── Onboarding ───────────────────────────────────────────────────────────────

function checkOnboarding() {
  const exchange = process.env.EXCHANGE || "bitget";

  if (!existsSync(".env")) {
    console.log("\n⚠️  No .env file found — creating one for you...\n");
    writeFileSync(".env", readFileSync(".env.example", "utf8"));
    console.log("Fill in your credentials in .env then re-run: node bot.js\n");
    process.exit(0);
  }

  if (exchange === "webull") {
    const required = ["WEBULL_EMAIL", "WEBULL_PASSWORD", "WEBULL_TRADING_PIN"];
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length > 0) {
      console.log(`\n⚠️  Missing Webull credentials in .env: ${missing.join(", ")}`);
      console.log("Add them then re-run: node bot.js\n");
      process.exit(0);
    }
    if (!existsSync(WEBULL_TOKEN_FILE)) {
      console.log("\n⚠️  No Webull login token found.");
      console.log("   Run this once to log in: node bot.js --webull-login\n");
      process.exit(0);
    }
  } else if (exchange === "alpaca") {
    const required = ["ALPACA_API_KEY", "ALPACA_SECRET_KEY"];
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length > 0) {
      console.log(`\n⚠️  Missing Alpaca credentials in .env: ${missing.join(", ")}`);
      console.log("Get them at: alpaca.markets → Paper Trading → API Keys\n");
      process.exit(0);
    }
  } else {
    const required = ["BITGET_API_KEY", "BITGET_SECRET_KEY", "BITGET_PASSPHRASE"];
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length > 0) {
      console.log(`\n⚠️  Missing BitGet credentials in .env: ${missing.join(", ")}`);
      console.log("Add them then re-run: node bot.js\n");
      process.exit(0);
    }
  }

  const csvPath = new URL("trades.csv", import.meta.url).pathname;
  console.log(`\n📄 Trade log: ${csvPath}`);
  console.log(
    `   Open in Google Sheets or Excel any time — or tell Claude to move it:\n` +
      `   "Move my trades.csv to ~/Desktop" or "Move it to my Documents folder"\n`,
  );
}

// ─── Config ────────────────────────────────────────────────────────────────

const CONFIG = {
  symbol: process.env.SYMBOL || "BTCUSDT",
  timeframe: process.env.TIMEFRAME || "4H",
  portfolioValue: parseFloat(process.env.PORTFOLIO_VALUE_USD || "1000"),
  maxTradeSizeUSD: parseFloat(process.env.MAX_TRADE_SIZE_USD || "100"),
  maxTradesPerDay: parseInt(process.env.MAX_TRADES_PER_DAY || "3"),
  paperTrading: process.env.PAPER_TRADING !== "false",
  tradeMode: process.env.TRADE_MODE || "spot",
  tradeType: (process.env.TRADE_TYPE || "stock").toLowerCase(),
  optionsDTE:          parseInt(process.env.OPTIONS_DTE           || "7"),
  optionsMaxPremium:   parseFloat(process.env.OPTIONS_MAX_PREMIUM || "500"),
  optionsContracts:    parseInt(process.env.OPTIONS_CONTRACTS      || "1"),
  exchange: (process.env.EXCHANGE || "bitget").toLowerCase(),
  bitget: {
    apiKey: process.env.BITGET_API_KEY,
    secretKey: process.env.BITGET_SECRET_KEY,
    passphrase: process.env.BITGET_PASSPHRASE,
    baseUrl: process.env.BITGET_BASE_URL || "https://api.bitget.com",
  },
  webull: {
    email: process.env.WEBULL_EMAIL,
    password: process.env.WEBULL_PASSWORD,
    tradingPin: process.env.WEBULL_TRADING_PIN,
  },
  alpaca: {
    apiKey: process.env.ALPACA_API_KEY,
    secretKey: process.env.ALPACA_SECRET_KEY,
    baseUrl: process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets",
  },
};

const LOG_FILE = "safety-check-log.json";

// ─── Logging ────────────────────────────────────────────────────────────────

function loadLog() {
  if (!existsSync(LOG_FILE)) return { trades: [] };
  return JSON.parse(readFileSync(LOG_FILE, "utf8"));
}

function saveLog(log) {
  writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function countTodaysTrades(log) {
  const today = new Date().toISOString().slice(0, 10);
  return log.trades.filter(
    (t) => t.timestamp.startsWith(today) && t.orderPlaced,
  ).length;
}

// ─── Market Data (Binance public API — free, no auth) ───────────────────────

async function fetchCandles(symbol, interval, limit = 100) {
  // Binance interval format
  const binanceIntervalMap = {
    "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
    "1H": "1h", "4H": "4h", "1D": "1d", "1W": "1w",
  };
  // Kraken interval format (minutes)
  const krakenIntervalMap = {
    "1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30,
    "1H": 60, "4H": 240, "1D": 1440, "1W": 10080,
  };
  // Kraken pair names (BTCUSDT -> XBTUSD, etc.)
  const krakenPairMap = {
    BTCUSDT: "XBTUSD", ETHUSDT: "ETHUSD", SOLUSDT: "SOLUSD",
    BNBUSDT: "BNBUSD", XRPUSDT: "XRPUSD", DOGEUSDT: "XDGUSD",
  };

  let lastError;

  // Try Binance endpoints first
  for (const base of ["https://api.binance.com/api/v3/klines", "https://api.binance.us/api/v3/klines"]) {
    try {
      const url = `${base}?symbol=${symbol}&interval=${binanceIntervalMap[interval] || "1m"}&limit=${limit}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.status === 451 || res.status === 403) { lastError = new Error(`Binance blocked (${res.status})`); continue; }
      if (!res.ok) throw new Error(`Binance API error: ${res.status}`);
      const data = await res.json();
      return data.map((k) => ({ time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]) }));
    } catch (err) { lastError = err; }
  }

  // Fallback: Kraken public API (no auth, no geo-block)
  try {
    const krakenPair = krakenPairMap[symbol] || symbol.replace("USDT", "USD");
    const krakenInterval = krakenIntervalMap[interval] || 1;
    const url = `https://api.kraken.com/0/public/OHLC?pair=${krakenPair}&interval=${krakenInterval}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`Kraken API error: ${res.status}`);
    const json = await res.json();
    if (json.error && json.error.length) throw new Error(`Kraken: ${json.error[0]}`);
    const candles = Object.values(json.result).find(Array.isArray);
    if (!candles) throw new Error("Kraken returned no candle data");
    console.log(`  (using Kraken for market data — Binance geo-blocked)`);
    return candles.slice(-limit).map((k) => ({
      time: k[0] * 1000, open: parseFloat(k[1]), high: parseFloat(k[2]),
      low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[6]),
    }));
  } catch (err) { lastError = err; }

  throw lastError || new Error("All market data endpoints failed");
}

// ─── Yahoo Finance (stocks / ETFs) ───────────────────────────────────────────

async function fetchStockCandles(symbol, interval, limit = 100) {
  // Yahoo Finance only supports specific intervals — map our format to theirs
  const yahooIntervalMap = {
    "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
    "1H": "60m", "4H": "60m", "1D": "1d", "1W": "1wk",
  };
  const yahooInterval = yahooIntervalMap[interval] || "60m";
  // 1m: max 7 days  |  sub-hourly: max 60 days  |  daily+: up to years
  const rangeMap = { "1m": "7d", "5m": "60d", "15m": "60d", "30m": "60d", "60m": "60d", "1d": "1y", "1wk": "5y" };
  const range = rangeMap[yahooInterval] || "60d";

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${yahooInterval}&range=${range}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Yahoo Finance error ${res.status} for ${symbol}`);

  const json = await res.json();
  const result = json.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo Finance returned no data for ${symbol} — check the ticker symbol`);

  const timestamps = result.timestamp;
  const { open, high, low, close, volume } = result.indicators.quote[0];

  let candles = timestamps
    .map((t, i) => ({
      time: t * 1000,
      open: open[i],
      high: high[i],
      low: low[i],
      close: close[i],
      volume: volume[i] || 0,
    }))
    .filter((c) => c.open != null && c.close != null && !isNaN(c.close));

  // Aggregate 60m candles → 4H when requested
  if (interval === "4H") candles = aggregateTo4H(candles);

  return candles.slice(-limit);
}

function aggregateTo4H(candles) {
  const buckets = {};
  for (const c of candles) {
    const key = Math.floor(c.time / (4 * 3600 * 1000));
    if (!buckets[key]) {
      buckets[key] = { ...c };
    } else {
      buckets[key].high = Math.max(buckets[key].high, c.high);
      buckets[key].low = Math.min(buckets[key].low, c.low);
      buckets[key].close = c.close;
      buckets[key].volume += c.volume;
    }
  }
  return Object.values(buckets).sort((a, b) => a.time - b.time);
}

// ─── Indicator Calculations ──────────────────────────────────────────────────

function calcEMA(closes, period) {
  const multiplier = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0,
    losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// VWAP — crypto session resets at midnight UTC
function calcVWAP(candles) {
  const midnightUTC = new Date();
  midnightUTC.setUTCHours(0, 0, 0, 0);
  const sessionCandles = candles.filter((c) => c.time >= midnightUTC.getTime());
  if (sessionCandles.length === 0) return null;
  const cumTPV = sessionCandles.reduce(
    (sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume,
    0,
  );
  const cumVol = sessionCandles.reduce((sum, c) => sum + c.volume, 0);
  return cumVol === 0 ? null : cumTPV / cumVol;
}

// VWAP — stock session resets at NYSE open (9:30 AM ET = 13:30 UTC EDT / 14:30 UTC EST)
function calcVWAPForStocks(candles) {
  const now = new Date();
  const jan = new Date(now.getFullYear(), 0, 1);
  const jul = new Date(now.getFullYear(), 6, 1);
  const isDST = now.getTimezoneOffset() < Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
  const utcOpenHour = isDST ? 13 : 14;

  // Walk back up to 7 days to find the last session with candles (handles weekends + holidays)
  for (let daysBack = 0; daysBack <= 7; daysBack++) {
    const sessionOpen = new Date();
    sessionOpen.setUTCHours(utcOpenHour, 30, 0, 0);
    sessionOpen.setUTCDate(sessionOpen.getUTCDate() - daysBack);
    // Skip if this candidate open is in the future
    if (sessionOpen.getTime() > Date.now()) continue;

    const sessionCandles = candles.filter((c) => c.time >= sessionOpen.getTime() && c.time < sessionOpen.getTime() + 7 * 3600 * 1000);
    if (sessionCandles.length === 0) continue;

    const cumTPV = sessionCandles.reduce((sum, c) => sum + ((c.high + c.low + c.close) / 3) * c.volume, 0);
    const cumVol = sessionCandles.reduce((sum, c) => sum + c.volume, 0);
    return cumVol === 0 ? null : cumTPV / cumVol;
  }
  return null;
}

// ─── Opening Range Breakout ───────────────────────────────────────────────────

function calcORB(candles, orbMinutes = 15) {
  // NYSE open: 9:30 AM ET = 13:30 UTC (EDT) or 14:30 UTC (EST)
  const now = new Date();
  const jan = new Date(now.getFullYear(), 0, 1);
  const jul = new Date(now.getFullYear(), 6, 1);
  const isDST = now.getTimezoneOffset() < Math.max(jan.getTimezoneOffset(), jul.getTimezoneOffset());
  const utcOpenHour = isDST ? 13 : 14;

  const sessionOpen = new Date();
  sessionOpen.setUTCHours(utcOpenHour, 30, 0, 0);
  // If before today's open, look at the most recent trading day
  if (Date.now() < sessionOpen.getTime()) sessionOpen.setUTCDate(sessionOpen.getUTCDate() - 1);

  const orbEnd = new Date(sessionOpen.getTime() + orbMinutes * 60 * 1000);
  const tradeEnd = new Date(sessionOpen);
  tradeEnd.setUTCHours(sessionOpen.getUTCHours() + 1, 30, 0, 0); // default stop at 11 AM ET

  const orbCandles = candles.filter(c => c.time >= sessionOpen.getTime() && c.time < orbEnd.getTime());
  if (orbCandles.length === 0) return null;

  const orbHigh = Math.max(...orbCandles.map(c => c.high));
  const orbLow  = Math.min(...orbCandles.map(c => c.low));

  return { orbHigh, orbLow, orbRange: orbHigh - orbLow, sessionOpen, orbEnd, tradeEnd };
}

function runORBCheck(price, orb, vwap, candles, rules) {
  const results = [];
  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    console.log(`  ${pass ? "✅" : "🚫"} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── ORB Safety Check ─────────────────────────────────────────\n");
  console.log(`  ORB High: $${orb.orbHigh.toFixed(2)} | ORB Low: $${orb.orbLow.toFixed(2)} | Range: $${orb.orbRange.toFixed(2)}\n`);

  const now = Date.now();
  const afterORB  = now >= orb.orbEnd.getTime();
  const beforeCutoff = now < orb.tradeEnd.getTime();

  check("After ORB window (range established)", "true", String(afterORB), afterORB);
  check("Within trade hours (before 11 AM ET)", "true", String(beforeCutoff), beforeCutoff);

  // Range sanity — if ORB > 1% of price, skip (too wide)
  const rangePct = (orb.orbRange / price) * 100;
  check("ORB range not too wide (< 1% of price)", "< 1%", `${rangePct.toFixed(2)}%`, rangePct < 1);

  const longBreak  = price > orb.orbHigh;
  const shortBreak = price < orb.orbLow;

  if (!longBreak && !shortBreak) {
    console.log("  ⏸  No breakout yet — price inside the opening range.\n");
    results.push({ label: "Price has broken the range", required: "above high or below low", actual: "inside range", pass: false });
  } else if (longBreak) {
    console.log("  Direction: LONG — price broke above ORB high\n");
    check("Price above ORB high", `> ${orb.orbHigh.toFixed(2)}`, price.toFixed(2), true);
    if (vwap) check("Price above VWAP (long with trend)", `> ${vwap.toFixed(2)}`, price.toFixed(2), price > vwap);

    // Volume check on the latest candle
    const volMA = candles.slice(-21, -1).reduce((s, c) => s + c.volume, 0) / 20;
    const lastVol = candles[candles.length - 1].volume;
    check("Volume 2× average on breakout", `> ${Math.round(volMA * 2).toLocaleString()}`, Math.round(lastVol).toLocaleString(), lastVol >= volMA * 2);
  } else {
    console.log("  Direction: SHORT — price broke below ORB low\n");
    check("Price below ORB low", `< ${orb.orbLow.toFixed(2)}`, price.toFixed(2), true);
    if (vwap) check("Price below VWAP (short with trend)", `< ${vwap.toFixed(2)}`, price.toFixed(2), price < vwap);

    const volMA = candles.slice(-21, -1).reduce((s, c) => s + c.volume, 0) / 20;
    const lastVol = candles[candles.length - 1].volume;
    check("Volume 2× average on breakout", `> ${Math.round(volMA * 2).toLocaleString()}`, Math.round(lastVol).toLocaleString(), lastVol >= volMA * 2);
  }

  const side = longBreak ? "buy" : "sell";
  const stop = longBreak ? orb.orbLow : orb.orbHigh;
  const rrRatio = rules.parameters?.rr_ratio || 2;
  const target = longBreak
    ? orb.orbHigh + orb.orbRange * rrRatio
    : orb.orbLow  - orb.orbRange * rrRatio;

  return { results, allPass: results.every(r => r.pass), side, stop, target };
}

// ─── Safety Check ───────────────────────────────────────────────────────────

function runSafetyCheck(price, ema8, vwap, rsi3, rules) {
  const results = [];

  const check = (label, required, actual, pass) => {
    results.push({ label, required, actual, pass });
    const icon = pass ? "✅" : "🚫";
    console.log(`  ${icon} ${label}`);
    console.log(`     Required: ${required} | Actual: ${actual}`);
  };

  console.log("\n── Safety Check ─────────────────────────────────────────\n");

  // Determine bias first
  const bullishBias = price > vwap && price > ema8;
  const bearishBias = price < vwap && price < ema8;

  if (bullishBias) {
    console.log("  Bias: BULLISH — checking long entry conditions\n");

    // 1. Price above VWAP
    check(
      "Price above VWAP (buyers in control)",
      `> ${vwap.toFixed(2)}`,
      price.toFixed(2),
      price > vwap,
    );

    // 2. Price above EMA(8)
    check(
      "Price above EMA(8) (uptrend confirmed)",
      `> ${ema8.toFixed(2)}`,
      price.toFixed(2),
      price > ema8,
    );

    // 3. RSI(3) pullback
    check(
      "RSI(3) below 30 (snap-back setup in uptrend)",
      "< 30",
      rsi3.toFixed(2),
      rsi3 < 30,
    );

    // 4. Not overextended from VWAP
    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check(
      "Price within 1.5% of VWAP (not overextended)",
      "< 1.5%",
      `${distFromVWAP.toFixed(2)}%`,
      distFromVWAP < 1.5,
    );
  } else if (bearishBias) {
    console.log("  Bias: BEARISH — checking short entry conditions\n");

    check(
      "Price below VWAP (sellers in control)",
      `< ${vwap.toFixed(2)}`,
      price.toFixed(2),
      price < vwap,
    );

    check(
      "Price below EMA(8) (downtrend confirmed)",
      `< ${ema8.toFixed(2)}`,
      price.toFixed(2),
      price < ema8,
    );

    check(
      "RSI(3) above 70 (reversal setup in downtrend)",
      "> 70",
      rsi3.toFixed(2),
      rsi3 > 70,
    );

    const distFromVWAP = Math.abs((price - vwap) / vwap) * 100;
    check(
      "Price within 1.5% of VWAP (not overextended)",
      "< 1.5%",
      `${distFromVWAP.toFixed(2)}%`,
      distFromVWAP < 1.5,
    );
  } else {
    console.log("  Bias: NEUTRAL — no clear direction. No trade.\n");
    results.push({
      label: "Market bias",
      required: "Bullish or bearish",
      actual: "Neutral",
      pass: false,
    });
  }

  const allPass = results.every((r) => r.pass);
  return { results, allPass };
}

// ─── Trade Limits ────────────────────────────────────────────────────────────

function checkTradeLimits(log) {
  const todayCount = countTodaysTrades(log);

  console.log("\n── Trade Limits ─────────────────────────────────────────\n");

  if (todayCount >= CONFIG.maxTradesPerDay) {
    console.log(
      `🚫 Max trades per day reached: ${todayCount}/${CONFIG.maxTradesPerDay}`,
    );
    return false;
  }

  console.log(
    `✅ Trades today: ${todayCount}/${CONFIG.maxTradesPerDay} — within limit`,
  );

  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );

  if (tradeSize > CONFIG.maxTradeSizeUSD) {
    console.log(
      `🚫 Trade size $${tradeSize.toFixed(2)} exceeds max $${CONFIG.maxTradeSizeUSD}`,
    );
    return false;
  }

  console.log(
    `✅ Trade size: $${tradeSize.toFixed(2)} — within max $${CONFIG.maxTradeSizeUSD}`,
  );

  return true;
}

// ─── BitGet Execution ────────────────────────────────────────────────────────

function signBitGet(timestamp, method, path, body = "") {
  const message = `${timestamp}${method}${path}${body}`;
  return crypto
    .createHmac("sha256", CONFIG.bitget.secretKey)
    .update(message)
    .digest("base64");
}

async function placeBitGetOrder(symbol, side, sizeUSD, price) {
  const quantity = (sizeUSD / price).toFixed(6);
  const timestamp = Date.now().toString();
  const path =
    CONFIG.tradeMode === "spot"
      ? "/api/v2/spot/trade/placeOrder"
      : "/api/v2/mix/order/placeOrder";

  const body = JSON.stringify({
    symbol,
    side,
    orderType: "market",
    quantity,
    ...(CONFIG.tradeMode === "futures" && {
      productType: "USDT-FUTURES",
      marginMode: "isolated",
      marginCoin: "USDT",
    }),
  });

  const signature = signBitGet(timestamp, "POST", path, body);

  const res = await fetch(`${CONFIG.bitget.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "ACCESS-KEY": CONFIG.bitget.apiKey,
      "ACCESS-SIGN": signature,
      "ACCESS-TIMESTAMP": timestamp,
      "ACCESS-PASSPHRASE": CONFIG.bitget.passphrase,
    },
    body,
  });

  const data = await res.json();
  if (data.code !== "00000") {
    throw new Error(`BitGet order failed: ${data.msg}`);
  }

  return data.data;
}

// ─── Alpaca Execution ────────────────────────────────────────────────────────

async function placeAlpacaOrder(symbol, side, sizeUSD) {
  const res = await fetch(`${CONFIG.alpaca.baseUrl}/v2/orders`, {
    method: "POST",
    headers: {
      "APCA-API-KEY-ID": CONFIG.alpaca.apiKey,
      "APCA-API-SECRET-KEY": CONFIG.alpaca.secretKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      symbol,
      notional: sizeUSD.toFixed(2),   // dollar amount — Alpaca handles fractional shares
      side,
      type: "market",
      time_in_force: "day",
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(`Alpaca order failed: ${data.message || JSON.stringify(data)}`);
  return data;
}

async function getAlpacaAccount() {
  const res = await fetch(`${CONFIG.alpaca.baseUrl}/v2/account`, {
    headers: {
      "APCA-API-KEY-ID": CONFIG.alpaca.apiKey,
      "APCA-API-SECRET-KEY": CONFIG.alpaca.secretKey,
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Alpaca account check failed: ${data.message}`);
  return data;
}

// ─── Webull Auth ─────────────────────────────────────────────────────────────

function getWebullDeviceId() {
  if (existsSync(WEBULL_DEVICE_FILE)) {
    return JSON.parse(readFileSync(WEBULL_DEVICE_FILE, "utf8")).deviceId;
  }
  const deviceId = crypto.randomUUID().replace(/-/g, "");
  writeFileSync(WEBULL_DEVICE_FILE, JSON.stringify({ deviceId }));
  return deviceId;
}

function loadWebullToken() {
  if (!existsSync(WEBULL_TOKEN_FILE)) return null;
  try {
    const data = JSON.parse(readFileSync(WEBULL_TOKEN_FILE, "utf8"));
    if (Date.now() > data.expiresAt - 60_000) return null;
    return data;
  } catch { return null; }
}

function saveWebullToken(accessToken, refreshToken, expiresAt, userId) {
  writeFileSync(WEBULL_TOKEN_FILE, JSON.stringify({ accessToken, refreshToken, expiresAt, userId, savedAt: new Date().toISOString() }));
}

function webullHeaders(deviceId, accessToken = null, tradeToken = null) {
  return {
    "Content-Type": "application/json",
    did: deviceId,
    hl: "en",
    os: "web",
    osv: "Mozilla/5.0",
    ph: "Windows",
    platform: "pc",
    ver: "3.35.7",
    lzone: "dc_core_r001",
    app: "global",
    ...(accessToken && { access_token: accessToken }),
    ...(tradeToken && { trade_token: tradeToken }),
  };
}

async function webullSendMFA(email, deviceId) {
  const res = await fetch("https://userapi.webull.com/api/passport/verifyCode/account", {
    method: "POST",
    headers: webullHeaders(deviceId),
    body: JSON.stringify({ account: email, accountType: "2", codeType: "5" }),
  });
  if (!res.ok) throw new Error(`Webull MFA request failed: ${res.status} — check your email address`);
  return res.json();
}

async function webullLoginWithMFA(email, password, mfaCode, deviceId) {
  const hashedPwd = crypto.createHash("md5").update(password).digest("hex");
  const res = await fetch("https://userapi.webull.com/api/passport/login/v5/account", {
    method: "POST",
    headers: webullHeaders(deviceId),
    body: JSON.stringify({
      account: email,
      accountType: "2",
      pwd: hashedPwd,
      verificationCode: mfaCode,
      regionId: 1,
      loginType: "0",
      clientVersion: "3.35.7",
      osType: "1",
      deviceId,
      deviceName: "Claude Bot",
    }),
  });
  const data = await res.json();
  // Webull returns error details in .code / .msg
  if (data.code) throw new Error(`Webull login failed: ${data.msg || JSON.stringify(data)}`);
  return data;
}

async function webullGetTradeToken(accessToken, tradingPin, deviceId) {
  const hashedPin = crypto.createHash("md5").update(tradingPin).digest("hex");
  const res = await fetch("https://tradeapi.webull.com/api/trading/v1/webull/auth/trade/verification", {
    method: "POST",
    headers: webullHeaders(deviceId, accessToken),
    body: JSON.stringify({ pwd: hashedPin }),
  });
  const data = await res.json();
  if (!data.tradeToken) throw new Error(`Could not get Webull trade token: ${JSON.stringify(data)}`);
  return data.tradeToken;
}

async function webullGetAccountId(accessToken, deviceId) {
  const res = await fetch("https://tradeapi.webull.com/api/trading/v1/webull/account", {
    headers: webullHeaders(deviceId, accessToken),
  });
  const data = await res.json();
  const accountId = Array.isArray(data) ? data[0]?.accountId : data?.accountId;
  if (!accountId) throw new Error(`Could not get Webull account ID: ${JSON.stringify(data)}`);
  return accountId;
}

async function webullGetTickerId(symbol, accessToken, deviceId) {
  const res = await fetch(
    `https://quoteapi.webull.com/api/search/entities?keys=${symbol}&queryType=1&pageIndex=1&pageSize=10`,
    { headers: webullHeaders(deviceId, accessToken) },
  );
  const data = await res.json();
  const ticker = data.data?.find((t) => t.symbol === symbol || t.disSymbol === symbol);
  if (!ticker?.tickerId) throw new Error(`Ticker ID not found for ${symbol} — check the symbol spelling`);
  return ticker.tickerId;
}

// ─── Webull Execution ─────────────────────────────────────────────────────────

async function placeWebullOrder(symbol, side, sizeUSD, price) {
  const tokenData = loadWebullToken();
  if (!tokenData) throw new Error("Webull token expired — run: node bot.js --webull-login");

  const { accessToken } = tokenData;
  const deviceId = getWebullDeviceId();

  const [tradeToken, accountId, tickerId] = await Promise.all([
    webullGetTradeToken(accessToken, CONFIG.webull.tradingPin, deviceId),
    webullGetAccountId(accessToken, deviceId),
    webullGetTickerId(symbol, accessToken, deviceId),
  ]);

  const shares = Math.max(1, Math.floor(sizeUSD / price));

  const res = await fetch("https://tradeapi.webull.com/api/trade/order/stock/place", {
    method: "POST",
    headers: webullHeaders(deviceId, accessToken, tradeToken),
    body: JSON.stringify({
      action: side.toUpperCase(),
      comboType: "NORMAL",
      orderType: "MKT",
      outsideRegularTradingHour: false,
      qty: String(shares),
      serialId: crypto.randomUUID(),
      tickerId,
      timeInForce: "DAY",
      accountId,
    }),
  });

  const data = await res.json();
  if (data.code) throw new Error(`Webull order failed: ${data.msg}`);
  return data;
}

// ─── Webull Interactive Login (run once: node bot.js --webull-login) ──────────

async function interactiveWebullLogin() {
  // Support non-interactive mode: node bot.js --webull-login --mfa=123456
  const mfaArg = process.argv.find((a) => a.startsWith("--mfa="))?.slice(6);

  const email = CONFIG.webull.email;
  const password = CONFIG.webull.password;
  const deviceId = getWebullDeviceId();

  console.log("\n── Webull Login ─────────────────────────────────────────\n");

  if (!mfaArg) {
    // Step 1: just send the MFA code and exit
    console.log(`Sending MFA code to ${email}...`);
    try {
      await webullSendMFA(email, deviceId);
      console.log("✅ Code sent. Check your email.\n");
      console.log("Once you have it, run:");
      console.log(`   node bot.js --webull-login --mfa=<the-code>\n`);
    } catch (err) {
      console.log(`❌ MFA send failed: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  // Step 2: complete login with the provided code
  console.log("Logging in...");
  let loginData;
  try {
    loginData = await webullLoginWithMFA(email, password, mfaArg, deviceId);
  } catch (err) {
    console.log(`❌ Login failed: ${err.message}`);
    process.exit(1);
  }

  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  saveWebullToken(loginData.accessToken, loginData.refreshToken, expiresAt, loginData.userId);

  console.log("✅ Login successful — token saved.");
  console.log("   Run 'node bot.js' to start trading.\n");
}

// ─── Tax CSV Logging ─────────────────────────────────────────────────────────

const CSV_FILE = "trades.csv";

// Always ensure trades.csv exists with headers — open it in Excel/Sheets any time
function initCsv() {
  if (!existsSync(CSV_FILE)) {
    const funnyNote = `,,,,,,,,,,,"NOTE","Hey, if you're at this stage of the video, you must be enjoying it... perhaps you could hit subscribe now? :)"`;
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n" + funnyNote + "\n");
    console.log(
      `📄 Created ${CSV_FILE} — open in Google Sheets or Excel to track trades.`,
    );
  }
}
const CSV_HEADERS = [
  "Date",
  "Time (UTC)",
  "Exchange",
  "Symbol",
  "Side",
  "Quantity",
  "Price",
  "Total USD",
  "Fee (est.)",
  "Net Amount",
  "Order ID",
  "Mode",
  "Notes",
].join(",");

function writeTradeCsv(logEntry) {
  const now = new Date(logEntry.timestamp);
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  let side = "";
  let quantity = "";
  let totalUSD = "";
  let fee = "";
  let netAmount = "";
  let orderId = "";
  let mode = "";
  let notes = "";

  if (!logEntry.allPass) {
    const failed = logEntry.conditions
      .filter((c) => !c.pass)
      .map((c) => c.label)
      .join("; ");
    mode = "BLOCKED";
    orderId = "BLOCKED";
    notes = `Failed: ${failed}`;
  } else if (logEntry.paperTrading) {
    side = "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "PAPER";
    notes = "All conditions met";
  } else {
    side = "BUY";
    quantity = (logEntry.tradeSize / logEntry.price).toFixed(6);
    totalUSD = logEntry.tradeSize.toFixed(2);
    fee = (logEntry.tradeSize * 0.001).toFixed(4);
    netAmount = (logEntry.tradeSize - parseFloat(fee)).toFixed(2);
    orderId = logEntry.orderId || "";
    mode = "LIVE";
    notes = logEntry.error ? `Error: ${logEntry.error}` : "All conditions met";
  }

  const row = [
    date,
    time,
    "BitGet",
    logEntry.symbol,
    side,
    quantity,
    logEntry.price.toFixed(2),
    totalUSD,
    fee,
    netAmount,
    orderId,
    mode,
    `"${notes}"`,
  ].join(",");

  if (!existsSync(CSV_FILE)) {
    writeFileSync(CSV_FILE, CSV_HEADERS + "\n");
  }

  appendFileSync(CSV_FILE, row + "\n");
  console.log(`Tax record saved → ${CSV_FILE}`);
}

// Tax summary command: node bot.js --tax-summary
function generateTaxSummary() {
  if (!existsSync(CSV_FILE)) {
    console.log("No trades.csv found — no trades have been recorded yet.");
    return;
  }

  const lines = readFileSync(CSV_FILE, "utf8").trim().split("\n");
  const rows = lines.slice(1).map((l) => l.split(","));

  const live = rows.filter((r) => r[11] === "LIVE");
  const paper = rows.filter((r) => r[11] === "PAPER");
  const blocked = rows.filter((r) => r[11] === "BLOCKED");

  const totalVolume = live.reduce((sum, r) => sum + parseFloat(r[7] || 0), 0);
  const totalFees = live.reduce((sum, r) => sum + parseFloat(r[8] || 0), 0);

  console.log("\n── Tax Summary ──────────────────────────────────────────\n");
  console.log(`  Total decisions logged : ${rows.length}`);
  console.log(`  Live trades executed   : ${live.length}`);
  console.log(`  Paper trades           : ${paper.length}`);
  console.log(`  Blocked by safety check: ${blocked.length}`);
  console.log(`  Total volume (USD)     : $${totalVolume.toFixed(2)}`);
  console.log(`  Total fees paid (est.) : $${totalFees.toFixed(4)}`);
  console.log(`\n  Full record: ${CSV_FILE}`);
  console.log("─────────────────────────────────────────────────────────\n");
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  checkOnboarding();
  initCsv();
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  Claude Trading Bot");
  console.log(`  ${new Date().toISOString()}`);
  console.log(
    `  Mode: ${CONFIG.paperTrading ? "📋 PAPER TRADING" : "🔴 LIVE TRADING"}`,
  );
  console.log("═══════════════════════════════════════════════════════════");

  // Load strategy — use rules-orb.json if STRATEGY=orb, otherwise rules.json
  const strategyFile = (process.env.STRATEGY || "vwap") === "orb" ? "rules-orb.json" : "rules.json";
  const rules = JSON.parse(readFileSync(strategyFile, "utf8"));
  const isORB = strategyFile === "rules-orb.json";
  console.log(`\nStrategy: ${rules.strategy.name}`);
  console.log(`Symbol: ${CONFIG.symbol} | Timeframe: ${CONFIG.timeframe}`);

  // Load log and check daily limits
  const log = loadLog();
  const withinLimits = checkTradeLimits(log);
  if (!withinLimits) {
    console.log("\nBot stopping — trade limits reached for today.");
    return;
  }

  // Fetch candle data
  const isStock = CONFIG.exchange === "webull" || CONFIG.exchange === "alpaca";
  const dataSource = isStock ? "Yahoo Finance" : "Binance/Kraken";
  console.log(`\n── Fetching market data from ${dataSource} ───────────────────\n`);
  const candles = isStock
    ? await fetchStockCandles(CONFIG.symbol, CONFIG.timeframe, 500)
    : await fetchCandles(CONFIG.symbol, CONFIG.timeframe, 500);
  const closes = candles.map((c) => c.close);
  const price = closes[closes.length - 1];
  console.log(`  Current price: $${price.toFixed(2)}`);

  // Calculate indicators
  const ema8 = calcEMA(closes, 8);
  const vwap = isStock ? calcVWAPForStocks(candles) : calcVWAP(candles);
  const rsi3 = calcRSI(closes, 3);

  console.log(`  EMA(8):  $${ema8.toFixed(2)}`);
  console.log(`  VWAP:    $${vwap ? vwap.toFixed(2) : "N/A"}`);
  console.log(`  RSI(3):  ${rsi3 ? rsi3.toFixed(2) : "N/A"}`);

  if (!vwap || !rsi3) {
    console.log("\n⚠️  Not enough data to calculate indicators. Exiting.");
    return;
  }

  // Run safety check — ORB or VWAP+RSI depending on strategy
  let checkResult;
  if (isORB) {
    const orb = calcORB(candles, rules.parameters?.orb_minutes || 15);
    if (!orb) {
      console.log("\n⚠️  Opening range not available — market may not be open. Exiting.");
      return;
    }
    checkResult = runORBCheck(price, orb, vwap, candles, rules);
  } else {
    const { results, allPass } = runSafetyCheck(price, ema8, vwap, rsi3, rules);
    const bullishBias = price > (vwap || 0) && price > ema8;
    checkResult = { results, allPass, side: bullishBias ? "buy" : "sell" };
  }
  const { results, allPass, side } = checkResult;

  // Calculate position size
  const tradeSize = Math.min(
    CONFIG.portfolioValue * 0.01,
    CONFIG.maxTradeSizeUSD,
  );

  // Decision
  console.log("\n── Decision ─────────────────────────────────────────────\n");

  const logEntry = {
    timestamp: new Date().toISOString(),
    symbol: CONFIG.symbol,
    timeframe: CONFIG.timeframe,
    price,
    indicators: { ema8, vwap, rsi3 },
    conditions: results,
    allPass,
    tradeSize,
    orderPlaced: false,
    orderId: null,
    paperTrading: CONFIG.paperTrading,
    limits: {
      maxTradeSizeUSD: CONFIG.maxTradeSizeUSD,
      maxTradesPerDay: CONFIG.maxTradesPerDay,
      tradesToday: countTodaysTrades(log),
    },
  };

  if (!allPass) {
    const failed = results.filter((r) => !r.pass).map((r) => r.label);
    console.log(`🚫 TRADE BLOCKED`);
    console.log(`   Failed conditions:`);
    failed.forEach((f) => console.log(`   - ${f}`));
  } else {
    console.log(`✅ ALL CONDITIONS MET`);
    const exchangeLabel = CONFIG.exchange === "alpaca" ? "Alpaca" : CONFIG.exchange === "webull" ? "Webull" : "BitGet";

    if (CONFIG.paperTrading) {
      console.log(
        `\n📋 PAPER TRADE — would ${side.toUpperCase()} ${CONFIG.symbol} ~$${tradeSize.toFixed(2)} at market on ${exchangeLabel}`,
      );
      console.log(`   (Set PAPER_TRADING=false in .env to place real orders)`);
      logEntry.orderPlaced = true;
      logEntry.orderId = `PAPER-${Date.now()}`;
    } else {
      console.log(
        `\n🔴 PLACING LIVE ORDER — $${tradeSize.toFixed(2)} ${side.toUpperCase()} ${CONFIG.symbol} on ${exchangeLabel}`,
      );
      try {
        let orderId;
        if (CONFIG.exchange === "alpaca" && CONFIG.tradeType === "options") {
          // Options mode: buy ATM call (long) or put (short) instead of shares
          console.log(`\n📋 Options mode — selecting ATM ${side === "buy" ? "CALL" : "PUT"} for ${CONFIG.symbol}`);
          const contract = await selectContract(CONFIG.symbol, side, price, {
            dte:          CONFIG.optionsDTE,
            maxPremium:   CONFIG.optionsMaxPremium,
            numContracts: CONFIG.optionsContracts,
          });
          console.log(`   Symbol : ${contract.symbol}`);
          console.log(`   Strike : $${contract.strike}  |  Expiry: ${contract.expiry}  |  DTE: ${contract.dte}`);
          if (contract.premium) console.log(`   Premium: $${contract.premium.toFixed(2)}/share  |  Max cost: $${contract.maxCost.toFixed(2)}`);
          const order = await placeOptionsOrder(contract.symbol, "buy", contract.numContracts);
          orderId = order.id;
          logEntry.optionsContract = contract;
        } else if (CONFIG.exchange === "alpaca") {
          const order = await placeAlpacaOrder(CONFIG.symbol, side, tradeSize);
          orderId = order.id;
        } else if (CONFIG.exchange === "webull") {
          const order = await placeWebullOrder(CONFIG.symbol, side, tradeSize, price);
          orderId = order.data?.orderId || order.orderId || JSON.stringify(order.data);
        } else {
          const order = await placeBitGetOrder(CONFIG.symbol, side, tradeSize, price);
          orderId = order.orderId;
        }
        logEntry.orderPlaced = true;
        logEntry.orderId = orderId;
        console.log(`✅ ORDER PLACED — ${orderId}`);
      } catch (err) {
        console.log(`❌ ORDER FAILED — ${err.message}`);
        logEntry.error = err.message;
      }
    }
  }

  // Save decision log
  log.trades.push(logEntry);
  saveLog(log);
  console.log(`\nDecision log saved → ${LOG_FILE}`);

  // Write tax CSV row for every run (executed, paper, or blocked)
  writeTradeCsv(logEntry);

  console.log("═══════════════════════════════════════════════════════════\n");
}

if (process.argv.includes("--tax-summary")) {
  generateTaxSummary();
} else if (process.argv.includes("--webull-login")) {
  interactiveWebullLogin().catch((err) => {
    console.error("Login error:", err);
    process.exit(1);
  });
} else {
  run().catch((err) => {
    console.error("Bot error:", err);
    process.exit(1);
  });
}
