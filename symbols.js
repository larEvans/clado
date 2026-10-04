/**
 * Traded stock symbols — the bot's own list, independent of Alpaca watchlists.
 *
 * Alpaca's market-data stream accepts any symbol; nothing requires a watchlist.
 * The list lives in symbols.json in DATA_DIR (edited from the dashboard's
 * Add/Remove stock controls). Until that file exists it is seeded from the
 * SYMBOLS env var, e.g.
 *
 *   SYMBOLS=SPY,TSLA,QQQ,MSFT,META
 *
 * Crypto stays in CRYPTO_SYMBOLS / bot-config.json as before.
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from "fs";
import { dataPath } from "./state.js";

const SYMBOLS_FILE = dataPath("symbols.json");

export function normalizeSymbol(raw) {
  const sym = String(raw ?? "").trim().toUpperCase();
  return /^[A-Z][A-Z0-9.\-]{0,9}$/.test(sym) ? sym : null;
}

function normalizeList(list) {
  return [...new Set((list || []).map(normalizeSymbol).filter(Boolean))];
}

function envSymbols() {
  return normalizeList(String(process.env.SYMBOLS || "").split(","));
}

/** Current stock symbols: symbols.json if present, else the SYMBOLS env var. */
export function loadSymbols() {
  if (existsSync(SYMBOLS_FILE)) {
    try {
      const data = JSON.parse(readFileSync(SYMBOLS_FILE, "utf8"));
      return normalizeList(Array.isArray(data) ? data : data.symbols);
    } catch (e) {
      console.warn(`[Symbols] ${SYMBOLS_FILE} unreadable (${e.message}) — using SYMBOLS env`);
    }
  }
  return envSymbols();
}

export function saveSymbols(list) {
  const symbols = normalizeList(list);
  const tmp = SYMBOLS_FILE + ".tmp";
  writeFileSync(tmp, JSON.stringify({ symbols, updatedAt: new Date().toISOString() }, null, 2));
  renameSync(tmp, SYMBOLS_FILE);
  return symbols;
}

export function addSymbol(raw) {
  const sym = normalizeSymbol(raw);
  if (!sym) throw new Error(`invalid symbol "${raw}"`);
  const current = loadSymbols();
  if (current.includes(sym)) return { symbols: current, added: false };
  return { symbols: saveSymbols([...current, sym]), added: true };
}

export function removeSymbol(raw) {
  const sym = normalizeSymbol(raw);
  const current = loadSymbols();
  if (!sym || !current.includes(sym)) return { symbols: current, removed: false };
  return { symbols: saveSymbols(current.filter(s => s !== sym)), removed: true };
}
