/**
 * Adaptive learning system — reads closed-trade history, adjusts
 * strategy entry parameters to improve win rate over time.
 *
 * Files:
 *   trade-history.json  — array of every closed trade with P&L
 *   learned-params.json — current best params per strategy
 */

import { readFileSync, writeFileSync, existsSync } from "fs";

const HISTORY_FILE = "trade-history.json";
const PARAMS_FILE  = "learned-params.json";

// ── Default starting parameters ───────────────────────────────────────────────

const DEFAULTS = {
  orb: {
    orbMinutes:    15,
    rrRatio:       2.0,
    volMultiplier: 1.5,
    maxRangePct:   1.0,
  },
  vwap: {
    rsiPeriod:    3,
    rsiOversold:  30,
    rsiOverbought:70,
    emaPeriod:    8,
    maxDistVWAP:  1.5,
  },
  trend: {
    fastEMA:       9,
    slowEMA:      21,
    volMultiplier: 1.1,
    atrMult:       1.5,
    rrRatio:       2.0,
  },
  meanrev: {
    bbPeriod:     20,
    bbMult:        2.0,
    rsiOversold:  35,
    rsiOverbought:65,
    maxHoldBars:  15,
  },
  momentum: {
    macdFast: 12,
    macdSlow: 26,
    macdSig:   9,
    rsiPeriod:14,
    atrMult:   2.0,
    rrRatio:   2.0,
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

export function getDefaultParams(strategy) {
  return { ...(DEFAULTS[strategy] || {}) };
}

export function loadLearnedParams(strategy) {
  if (!existsSync(PARAMS_FILE)) return null;
  try {
    const all = JSON.parse(readFileSync(PARAMS_FILE, "utf8"));
    return all[strategy]?.params || null;
  } catch { return null; }
}

export function loadAllLearning() {
  if (!existsSync(PARAMS_FILE)) return {};
  try { return JSON.parse(readFileSync(PARAMS_FILE, "utf8")); } catch { return {}; }
}

// ── Record a closed trade ─────────────────────────────────────────────────────

export function recordTradeClosed({
  symbol, strategy, side,
  entryPrice, exitPrice,
  entryTime, exitTime, exitReason,
}) {
  let history = [];
  if (existsSync(HISTORY_FILE)) {
    try { history = JSON.parse(readFileSync(HISTORY_FILE, "utf8")); } catch {}
  }

  const pnlPct = side === "buy"
    ? (exitPrice - entryPrice) / entryPrice * 100
    : (entryPrice - exitPrice) / entryPrice * 100;

  const win = pnlPct > 0;

  history.push({
    symbol, strategy, side,
    entryPrice, exitPrice,
    pnlPct:    +pnlPct.toFixed(4),
    win,
    entryTime, exitTime, exitReason,
    recordedAt: new Date().toISOString(),
  });

  if (history.length > 500) history = history.slice(-500);
  writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));

  console.log(`[Learner] Trade recorded: ${win ? "WIN" : "LOSS"} ${pnlPct.toFixed(2)}% via ${exitReason}`);
  return { pnlPct, win };
}

// ── Run learning algorithm ────────────────────────────────────────────────────

export function runLearner(strategy) {
  let history = [];
  if (existsSync(HISTORY_FILE)) {
    try { history = JSON.parse(readFileSync(HISTORY_FILE, "utf8")); } catch {}
  }

  const trades = history.filter(t => t.strategy === strategy).slice(-30);
  if (trades.length < 5) {
    console.log(`[Learner] ${strategy}: need ≥5 trades (have ${trades.length}) — using defaults`);
    return getDefaultParams(strategy);
  }

  const wins    = trades.filter(t => t.win).length;
  const winRate = wins / trades.length;
  const avgPnl  = trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length;

  console.log(
    `[Learner] ${strategy}: ${(winRate * 100).toFixed(0)}% win rate, ` +
    `${avgPnl.toFixed(2)}% avg P&L over ${trades.length} trades`
  );

  // Load current params (learned or default)
  const current = loadLearnedParams(strategy) || getDefaultParams(strategy);
  const params  = { ...current };
  let changed   = false;

  if (winRate < 0.40) {
    // Too many losses — tighten entry criteria (require stronger signals)
    if (params.volMultiplier !== undefined) {
      params.volMultiplier = +(Math.min(3.0, params.volMultiplier + 0.15)).toFixed(2);
      changed = true;
    }
    if (params.rrRatio !== undefined) {
      params.rrRatio = +(Math.min(4.0, params.rrRatio + 0.25)).toFixed(2);
      changed = true;
    }
    if (params.rsiOversold !== undefined) {
      params.rsiOversold = Math.max(15, params.rsiOversold - 3);
      changed = true;
    }
    if (params.maxRangePct !== undefined) {
      params.maxRangePct = +(Math.max(0.3, params.maxRangePct - 0.1)).toFixed(2);
      changed = true;
    }
    if (params.atrMult !== undefined) {
      params.atrMult = +(Math.min(3.5, params.atrMult + 0.25)).toFixed(2);
      changed = true;
    }
    if (changed) console.log(`[Learner] Tightened ${strategy} params (win rate low):`, params);

  } else if (winRate > 0.65 && avgPnl > 0.3) {
    // Strong results — relax slightly to catch more opportunities
    if (params.volMultiplier !== undefined) {
      params.volMultiplier = +(Math.max(1.0, params.volMultiplier - 0.1)).toFixed(2);
      changed = true;
    }
    if (params.rsiOversold !== undefined) {
      params.rsiOversold = Math.min(40, params.rsiOversold + 2);
      changed = true;
    }
    if (params.maxRangePct !== undefined) {
      params.maxRangePct = +(Math.min(1.5, params.maxRangePct + 0.1)).toFixed(2);
      changed = true;
    }
    if (changed) console.log(`[Learner] Relaxed ${strategy} params (win rate strong):`, params);
  }

  // Persist learning data
  const all = loadAllLearning();
  all[strategy] = {
    params,
    winRate:    +winRate.toFixed(4),
    avgPnl:     +avgPnl.toFixed(4),
    sampleSize: trades.length,
    updatedAt:  new Date().toISOString(),
    history:    trades.slice(-5).map(t => ({ win: t.win, pnlPct: t.pnlPct, exitReason: t.exitReason })),
  };
  writeFileSync(PARAMS_FILE, JSON.stringify(all, null, 2));
  return params;
}
