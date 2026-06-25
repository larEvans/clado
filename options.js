/**
 * Alpaca Options — chain fetching, contract selection, order placement
 *
 * Used by:
 *   bot.js          — when TRADE_TYPE=options
 *   dashboard.js    — /api/options-chain, /api/options-expiries
 */

import "dotenv/config";

function normalizeAlpacaBase(raw) {
  if (!raw) return "https://paper-api.alpaca.markets";
  return String(raw)
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/v\d[^/]*$/, "");
}

const TRADE_BASE = normalizeAlpacaBase(process.env.ALPACA_BASE_URL);
const DATA_BASE  = "https://data.alpaca.markets";

const H = () => ({
  "APCA-API-KEY-ID":     process.env.ALPACA_API_KEY,
  "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY,
});

async function apiGet(base, path, timeoutMs = 12000) {
  const res = await fetch(`${base}${path}`, { headers: H(), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`${path} → ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.json();
}

// ─── Contracts (trading API) ──────────────────────────────────────────────────

export async function fetchContracts({ underlying, type, expDateGte, expDateLte, strikeGte, strikeLte, limit = 500 } = {}) {
  const q = new URLSearchParams({ limit: String(limit) });
  if (underlying) q.set("underlying_symbols", underlying);
  if (type)       q.set("type", type);
  if (expDateGte) q.set("expiration_date_gte", expDateGte);
  if (expDateLte) q.set("expiration_date_lte", expDateLte);
  if (strikeGte)  q.set("strike_price_gte",   strikeGte.toFixed(2));
  if (strikeLte)  q.set("strike_price_lte",   strikeLte.toFixed(2));

  const data = await apiGet(TRADE_BASE, `/v2/options/contracts?${q}`);
  return data.option_contracts || [];
}

// ─── Snapshots (data API — bid/ask midpoint, some greeks if subscribed) ───────

export async function fetchSnapshots(underlying, { type, expDate, strikeGte, strikeLte, limit = 500 } = {}) {
  const q = new URLSearchParams({ feed: "indicative", limit: String(limit) });
  if (type)      q.set("type", type);
  if (expDate)   q.set("expiration_date", expDate);
  if (strikeGte) q.set("strike_price_gte", strikeGte.toFixed(2));
  if (strikeLte) q.set("strike_price_lte", strikeLte.toFixed(2));

  try {
    const data = await apiGet(DATA_BASE, `/v1beta1/options/snapshots/${underlying}?${q}`);
    return data.snapshots || {};
  } catch {
    return {}; // snapshots are optional — don't fail if unavailable
  }
}

// ─── Available expiry dates ───────────────────────────────────────────────────

export async function fetchExpiryDates(underlying) {
  const today = new Date().toISOString().slice(0, 10);
  const in60  = new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10);
  const contracts = await fetchContracts({ underlying, expDateGte: today, expDateLte: in60, limit: 500 });
  const dates = [...new Set(contracts.map(c => c.expiration_date))].sort();
  return dates;
}

// ─── Full chain for a specific expiry ────────────────────────────────────────

export async function fetchChain(underlying, expiry, currentPrice) {
  const pad = currentPrice * 0.06; // ±6% of price
  const strikeGte = currentPrice - pad;
  const strikeLte = currentPrice + pad;

  const [calls, puts] = await Promise.all([
    fetchContracts({ underlying, type: "call", expDateGte: expiry, expDateLte: expiry, strikeGte, strikeLte }),
    fetchContracts({ underlying, type: "put",  expDateGte: expiry, expDateLte: expiry, strikeGte, strikeLte }),
  ]);

  // Fetch snapshots for both types
  const [callSnaps, putSnaps] = await Promise.all([
    fetchSnapshots(underlying, { type: "call", expDate: expiry, strikeGte, strikeLte }),
    fetchSnapshots(underlying, { type: "put",  expDate: expiry, strikeGte, strikeLte }),
  ]);

  const enrich = (contracts, snaps) =>
    contracts
      .sort((a, b) => a.strike_price - b.strike_price)
      .map(c => {
        const snap = snaps[c.symbol];
        const bid  = snap?.latestQuote?.bp ?? null;
        const ask  = snap?.latestQuote?.ap ?? null;
        const mid  = bid != null && ask != null ? (bid + ask) / 2 : null;
        const oi   = c.open_interest ?? null;
        return {
          symbol:  c.symbol,
          strike:  c.strike_price,
          expiry:  c.expiration_date,
          bid, ask, mid,
          oi,
          greeks: snap?.greeks || null,
          iv:     snap?.impliedVolatility ?? null,
          atm:    currentPrice ? Math.abs(c.strike_price - currentPrice) < 1.5 : false,
        };
      });

  return { calls: enrich(calls, callSnaps), puts: enrich(puts, putSnaps) };
}

// ─── Contract selection (for bot) ────────────────────────────────────────────

export async function selectContract(underlying, side, currentPrice, params = {}) {
  const dte          = params.dte          ?? parseInt(process.env.OPTIONS_DTE      || "7");
  const maxPremium   = params.maxPremium   ?? parseFloat(process.env.OPTIONS_MAX_PREMIUM || "500");
  const numContracts = params.numContracts ?? parseInt(process.env.OPTIONS_CONTRACTS   || "1");

  const type = side === "buy" ? "call" : "put";

  // Expiry window around target DTE
  const fromDate = fmtDate(addTradingDays(new Date(), Math.max(0, dte - 2)));
  const toDate   = fmtDate(addTradingDays(new Date(), dte + 3));

  // Strike range: ±3% of current price
  const contracts = await fetchContracts({
    underlying, type,
    expDateGte: fromDate, expDateLte: toDate,
    strikeGte: currentPrice * 0.97,
    strikeLte: currentPrice * 1.03,
  });

  if (contracts.length === 0) {
    throw new Error(`No ${type} contracts found for ${underlying} ~$${currentPrice.toFixed(2)} in ${dte} DTE window`);
  }

  // Prefer the nearest DTE, then ATM strike
  contracts.sort((a, b) => {
    const dDte = new Date(a.expiration_date) - new Date(b.expiration_date);
    if (dDte !== 0) return dDte;
    return Math.abs(a.strike_price - currentPrice) - Math.abs(b.strike_price - currentPrice);
  });

  const best = contracts[0];
  const actualDTE = Math.round((new Date(best.expiration_date) - new Date()) / 86400000);

  // Check premium via snapshot
  let premium = null;
  let maxCost  = null;
  try {
    const snaps = await fetchSnapshots(underlying, {
      type, expDate: best.expiration_date,
      strikeGte: best.strike_price - 0.5,
      strikeLte: best.strike_price + 0.5,
    });
    const snap = snaps[best.symbol];
    if (snap?.latestQuote) {
      const bid = snap.latestQuote.bp || 0;
      const ask = snap.latestQuote.ap || 0;
      premium  = (bid + ask) / 2;
      maxCost  = premium * 100 * numContracts; // 1 contract = 100 shares
    }
  } catch { /* optional */ }

  if (maxCost && maxCost > maxPremium) {
    throw new Error(`Premium too high: $${maxCost.toFixed(2)} (max $${maxPremium}). Consider reducing OPTIONS_CONTRACTS or raising OPTIONS_MAX_PREMIUM.`);
  }

  return {
    symbol:   best.symbol,
    type,
    strike:   best.strike_price,
    expiry:   best.expiration_date,
    dte:      actualDTE,
    premium,
    maxCost,
    numContracts,
    underlying,
    side,
  };
}

// ─── Live options environment (for backtests) ─────────────────────────────────
//
// Returns today's representative options environment for `symbol`: nearest
// expiry's DTE and the ATM contract's implied vol. Used to drive Black-Scholes
// in the backtest with values that match the current market instead of static
// defaults. Falls back to sensible defaults if Alpaca data is unavailable.

export async function getLiveOptionsParams(symbol, currentPrice) {
  const fallback = { iv: 0.25, dteDays: 7, source: "fallback", strike: null, expiry: null };
  try {
    const expiries = await fetchExpiryDates(symbol);
    if (!expiries?.length) return fallback;

    // Prefer the nearest expiry ≥ 1 day out (today's expiry has near-zero theta value).
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const target = expiries
      .map(d => ({ d, ms: new Date(d).getTime() }))
      .filter(x => x.ms - today.getTime() >= 86_400_000)
      [0]?.d || expiries[0];

    const dteDays = Math.max(1, Math.round((new Date(target).getTime() - today.getTime()) / 86_400_000));

    // ATM-ish snapshot — try call side first, fall back to put.
    const pad = Math.max(currentPrice * 0.02, 1);
    const snaps = await fetchSnapshots(symbol, {
      type: "call",
      expDate: target,
      strikeGte: currentPrice - pad,
      strikeLte: currentPrice + pad,
    });

    let iv = null;
    let atmStrike = null;
    for (const [sym, snap] of Object.entries(snaps)) {
      const v = snap?.impliedVolatility ?? snap?.greeks?.iv ?? null;
      if (v && v > 0) {
        iv = v;
        // Try to recover the strike from the OCC symbol (last 8 digits = strike × 1000)
        const m = sym.match(/(\d{8})$/);
        if (m) atmStrike = parseInt(m[1]) / 1000;
        break;
      }
    }

    if (!iv) return { ...fallback, dteDays, expiry: target, source: "alpaca-partial" };

    return {
      iv:        parseFloat(iv.toFixed(4)),
      dteDays,
      expiry:    target,
      strike:    atmStrike,
      source:    "alpaca",
    };
  } catch (e) {
    return { ...fallback, error: e.message };
  }
}

// ─── Order placement ──────────────────────────────────────────────────────────

export async function placeOptionsOrder(symbol, side, qty) {
  const res = await fetch(`${TRADE_BASE}/v2/orders`, {
    method: "POST",
    headers: { ...H(), "Content-Type": "application/json" },
    body: JSON.stringify({ symbol, qty: String(qty), side, type: "market", time_in_force: "day" }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Options order failed: ${data.message || JSON.stringify(data)}`);
  return data;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function addTradingDays(date, days) {
  const d = new Date(date);
  let added = 0;
  while (added < days) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) added++;
  }
  return d;
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}
