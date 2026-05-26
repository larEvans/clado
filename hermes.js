/**
 * Hermes — AI-powered trade analyst
 *
 * Reads closed trade history, identifies failure patterns, and returns
 * actionable recommendations in natural language + structured JSON.
 *
 * Priority chain:
 *   1. Ollama (local Hermes model) if OLLAMA_HOST is set
 *   2. Anthropic Claude API if ANTHROPIC_API_KEY is set
 *   3. Rule-based fallback (always works, no API needed)
 *
 * Usage:
 *   import { runHermesAnalysis, loadAllInsights } from "./hermes.js"
 *   const insights = await runHermesAnalysis("orb")
 *
 * .env variables:
 *   OLLAMA_HOST=http://localhost:11434
 *   HERMES_MODEL=nous-hermes-2-mistral-7b-dpo:latest
 *   ANTHROPIC_API_KEY=sk-ant-...
 */

import { readFileSync, writeFileSync, existsSync } from "fs";

const HISTORY_FILE  = "trade-history.json";
const INSIGHTS_FILE = "hermes-insights.json";

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildPrompt(trades, strategy) {
  const winners = trades.filter(t => t.win);
  const losers  = trades.filter(t => !t.win);

  const loserRows = losers.map(t => ({
    date:     (t.recordedAt || t.exitTime || "").slice(0, 10),
    side:     t.side,
    entry:    t.entryPrice?.toFixed(2),
    exit:     t.exitPrice?.toFixed(2),
    pnl:      (t.pnlPct >= 0 ? "+" : "") + t.pnlPct?.toFixed(2) + "%",
    reason:   t.exitReason,
  }));

  const winnerExitReasons = [...new Set(winners.map(t => t.exitReason))].join(", ");
  const avgWinPct  = winners.length ? (winners.reduce((s, t) => s + t.pnlPct, 0) / winners.length).toFixed(2) : "N/A";
  const avgLossPct = losers.length  ? (losers.reduce((s, t)  => s + t.pnlPct, 0) / losers.length).toFixed(2)  : "N/A";

  return `You are a quantitative trading analyst reviewing an automated ${strategy.toUpperCase()} intraday strategy.

PERFORMANCE SUMMARY (last ${trades.length} trades):
- Win rate : ${(winners.length / trades.length * 100).toFixed(0)}% (${winners.length}W / ${losers.length}L)
- Avg win  : ${avgWinPct}%
- Avg loss : ${avgLossPct}%
- Common win exits: ${winnerExitReasons || "—"}

LOSING TRADES:
${JSON.stringify(loserRows, null, 2)}

TASK: Identify the 2-3 root causes of these losses and suggest specific fixes.
Focus on: entry timing, stop placement, volume confirmation, trend alignment, or market conditions.

Respond ONLY with valid JSON (no markdown):
{
  "summary": "One sentence describing the single biggest problem causing losses.",
  "patterns": [
    "Specific pattern observed in losing trades (e.g. '70% of stops hit within first 2 bars — premature entry')"
  ],
  "adjustments": [
    { "param": "parameterName", "current": "currentValue", "recommended": "newValue", "reason": "why this helps" }
  ],
  "avoidConditions": [
    "Market condition or time-of-day to skip (e.g. 'Avoid entries after 11 AM ET — low follow-through')"
  ],
  "confidence": "low | medium | high"
}`;
}

// ── API callers ───────────────────────────────────────────────────────────────

async function callOllama(prompt) {
  const host  = process.env.OLLAMA_HOST;
  const model = process.env.HERMES_MODEL || "nous-hermes-2-mistral-7b-dpo:latest";
  if (!host) return null;

  const res = await fetch(`${host}/api/generate`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ model, prompt, stream: false, format: "json" }),
    signal:  AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const data = await res.json();
  return JSON.parse(data.response);
}

async function callClaude(prompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type":    "application/json",
      "x-api-key":       key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model:      "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages:   [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}`);
  const data = await res.json();
  const text = data.content?.[0]?.text || "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON in Claude response");
  return JSON.parse(match[0]);
}

// ── Rule-based fallback ───────────────────────────────────────────────────────

function ruleBasedAnalysis(trades) {
  const winners = trades.filter(t => t.win);
  const losers  = trades.filter(t => !t.win);
  const winRate = winners.length / trades.length;

  const stopLosses    = losers.filter(t => t.exitReason === "stop").length;
  const timeoutLosses = losers.filter(t => ["time", "eod", "timeout"].includes(t.exitReason)).length;
  const longLosses    = losers.filter(t => t.side === "buy").length;
  const shortLosses   = losers.filter(t => t.side === "sell").length;

  const patterns = [];
  if (stopLosses > losers.length * 0.6)
    patterns.push(`${stopLosses}/${losers.length} losses hit the stop immediately — entry is too early or range too tight`);
  if (timeoutLosses > losers.length * 0.4)
    patterns.push(`${timeoutLosses}/${losers.length} losses timed out — targets may be unrealistically far`);
  if (longLosses > shortLosses * 2)
    patterns.push(`Long trades underperforming — possible downtrend or weak upside momentum`);
  if (shortLosses > longLosses * 2)
    patterns.push(`Short trades underperforming — possible uptrend or short-squeeze risk`);
  if (patterns.length === 0)
    patterns.push(`Losses spread evenly — no single dominant failure mode detected`);

  const adjustments = [];
  if (winRate < 0.4) {
    adjustments.push({ param: "volMultiplier", current: "1.5", recommended: "2.0", reason: "Higher bar for volume confirmation filters out weak breakouts" });
    adjustments.push({ param: "rrRatio", current: "2.0", recommended: "2.5", reason: "Better R:R compensates for lower signal frequency" });
  }
  if (stopLosses > losers.length * 0.6) {
    adjustments.push({ param: "maxRangePct", current: "1.0", recommended: "0.7", reason: "Tighter ORB range = cleaner breakouts with less noise" });
  }

  return {
    summary: winRate < 0.4
      ? `Win rate ${(winRate*100).toFixed(0)}% is below 40% — entry criteria need tightening`
      : winRate > 0.65
      ? `Win rate ${(winRate*100).toFixed(0)}% is strong — current parameters are performing well`
      : `Win rate ${(winRate*100).toFixed(0)}% is moderate — minor parameter tuning may help`,
    patterns,
    adjustments,
    avoidConditions: winRate < 0.4
      ? ["Skip entries after 11:30 AM ET (reduced follow-through)", "Avoid if VIX > 25 (erratic intraday swings)"]
      : [],
    confidence: trades.length >= 20 ? "high" : trades.length >= 10 ? "medium" : "low",
  };
}

// ── Parameter optimization helpers ───────────────────────────────────────────

function getParamBounds(strategy) {
  const B = {
    orb: {
      orbMinutes:       { min: 5,   max: 30,  step: 5    },
      volumeMultiplier: { min: 1.0, max: 3.5, step: 0.1  },
      maxRangePct:      { min: 0.3, max: 2.5, step: 0.1  },
      rrRatio:          { min: 1.5, max: 5.0, step: 0.25 },
    },
    hybrid: {
      orbMinutes:    { min: 5,   max: 30,  step: 5    },
      volMultiplier: { min: 1.0, max: 3.5, step: 0.1  },
      maxRangePct:   { min: 0.3, max: 2.5, step: 0.1  },
      rrRatio:       { min: 1.5, max: 5.0, step: 0.25 },
      emaPeriod:     { min: 5,   max: 20,  step: 1    },
      emaSlowPeriod: { min: 14,  max: 50,  step: 1    },
    },
    vwap: {
      emaPeriod:     { min: 3,   max: 20,  step: 1    },
      rsiPeriod:     { min: 3,   max: 20,  step: 1    },
      rsiOversold:   { min: 20,  max: 45,  step: 1    },
      rsiOverbought: { min: 55,  max: 80,  step: 1    },
      stopPct:       { min: 0.1, max: 1.5, step: 0.05 },
      rrRatio:       { min: 1.5, max: 5.0, step: 0.25 },
    },
    trend: {
      fastEMA:       { min: 5,   max: 20,  step: 1    },
      slowEMA:       { min: 15,  max: 50,  step: 1    },
      volMultiplier: { min: 1.0, max: 2.5, step: 0.1  },
      atrMult:       { min: 1.0, max: 3.0, step: 0.25 },
      rrRatio:       { min: 1.5, max: 4.0, step: 0.25 },
    },
    meanrev: {
      bbPeriod:      { min: 10,  max: 50,  step: 5    },
      bbMult:        { min: 1.5, max: 3.0, step: 0.25 },
      rsiOversold:   { min: 20,  max: 45,  step: 5    },
      rsiOverbought: { min: 55,  max: 80,  step: 5    },
      maxHoldBars:   { min: 5,   max: 30,  step: 5    },
    },
    momentum: {
      atrMult: { min: 1.0, max: 3.0, step: 0.25 },
      rrRatio: { min: 1.5, max: 4.0, step: 0.25 },
    },
  };
  return B[strategy] || {};
}

function clampParam(value, bound) {
  if (!bound) return value;
  const rounded = Math.round(Number(value) / bound.step) * bound.step;
  return parseFloat(Math.min(Math.max(rounded, bound.min), bound.max).toFixed(4));
}

function ruleBasedParamSuggestion(strategy, currentParams, trades, iterNum) {
  const bounds   = getParamBounds(strategy);
  const losers   = trades.filter(t => (t.pnlR != null ? t.pnlR : (t.win ? 1 : -1)) <= 0);
  const winners  = trades.filter(t => (t.pnlR != null ? t.pnlR : (t.win ? 1 : -1)) > 0);
  const winRate  = trades.length > 0 ? winners.length / trades.length : 0;
  const stopLoss = losers.filter(t => t.exitReason === "stop").length;
  const timeouts = losers.filter(t => ["time", "eod", "timeout", "session_end"].includes(t.exitReason)).length;

  const changes = {};
  const reasons = [];
  const phase   = iterNum % 3; // cycle through 3 adjustment strategies

  const volKey = strategy === "orb" ? "volumeMultiplier" : "volMultiplier";

  if (phase === 1 || stopLoss > losers.length * 0.6) {
    if (bounds[volKey] && currentParams[volKey] != null) {
      const v = clampParam(currentParams[volKey] + 0.2, bounds[volKey]);
      if (v !== currentParams[volKey]) { changes[volKey] = v; reasons.push(`${volKey} ↑ to filter weak breakouts (${stopLoss}/${losers.length} hits stop)`); }
    }
    if (bounds.maxRangePct && currentParams.maxRangePct != null) {
      const v = clampParam(currentParams.maxRangePct - 0.1, bounds.maxRangePct);
      if (v !== currentParams.maxRangePct) { changes.maxRangePct = v; reasons.push("maxRangePct ↓ for tighter ORB quality"); }
    }
  }

  if (phase === 2 || timeouts > losers.length * 0.5) {
    if (bounds.rrRatio && currentParams.rrRatio != null) {
      const v = clampParam(currentParams.rrRatio - 0.25, bounds.rrRatio);
      if (v !== currentParams.rrRatio) { changes.rrRatio = v; reasons.push("rrRatio ↓ — targets were unreachable (timeout exits)"); }
    }
  }

  if (phase === 0) {
    if (winRate > 0.5 && bounds.rrRatio && currentParams.rrRatio != null) {
      const v = clampParam(currentParams.rrRatio + 0.25, bounds.rrRatio);
      if (v !== currentParams.rrRatio) { changes.rrRatio = v; reasons.push("rrRatio ↑ — solid win rate supports higher targets"); }
    } else if (winRate <= 0.5 && bounds[volKey] && currentParams[volKey] != null) {
      const v = clampParam(currentParams[volKey] + 0.1, bounds[volKey]);
      if (v !== currentParams[volKey]) { changes[volKey] = v; reasons.push(`${volKey} ↑ — tighten further to reduce false signals`); }
    }
  }

  if (strategy === "vwap" && winRate < 0.4 && bounds.rsiOversold && currentParams.rsiOversold != null) {
    const v = clampParam(currentParams.rsiOversold - 3, bounds.rsiOversold);
    if (v !== currentParams.rsiOversold) { changes.rsiOversold = v; reasons.push("rsiOversold ↓ for stricter oversold condition"); }
  }
  if (strategy === "trend" && winRate < 0.4 && bounds.atrMult && currentParams.atrMult != null) {
    const v = clampParam(currentParams.atrMult + 0.25, bounds.atrMult);
    if (v !== currentParams.atrMult) { changes.atrMult = v; reasons.push("atrMult ↑ for wider stops (reduce premature stop-outs)"); }
  }

  if (Object.keys(changes).length === 0 && bounds.rrRatio && currentParams.rrRatio != null) {
    const delta = winRate > 0.5 ? 0.25 : -0.25;
    const v = clampParam(currentParams.rrRatio + delta, bounds.rrRatio);
    if (v !== currentParams.rrRatio) changes.rrRatio = v;
    reasons.push(`Exploring rrRatio ${delta > 0 ? "↑" : "↓"} (${(winRate*100).toFixed(0)}% win rate)`);
  }

  return {
    changes,
    reasoning: reasons.join("; ") || "No dominant failure mode detected",
    targetImprovement: winRate < 0.4 ? "Reduce stop-loss frequency" : "Extend winning trades",
  };
}

function buildOptimizePrompt(strategy, currentParams, trades, iterNum) {
  const losers  = trades.filter(t => (t.pnlR != null ? t.pnlR : (t.win ? 1 : -1)) <= 0);
  const winners = trades.filter(t => (t.pnlR != null ? t.pnlR : (t.win ? 1 : -1)) > 0);
  const winRate = trades.length > 0 ? (winners.length / trades.length * 100).toFixed(0) : "?";
  const stopLoss = losers.filter(t => t.exitReason === "stop").length;
  const timeouts = losers.filter(t => ["time", "eod", "timeout", "session_end"].includes(t.exitReason)).length;
  const avgLoss  = losers.length > 0 ? (losers.reduce((s, t) => s + (t.pnlPct || 0), 0) / losers.length).toFixed(2) : "0";
  const bounds   = getParamBounds(strategy);

  return `You are a quant strategy optimizer. Suggest parameter changes for a ${strategy.toUpperCase()} strategy.

Current Parameters:
${Object.entries(currentParams).map(([k, v]) => `  ${k}: ${v}`).join("\n")}

Backtest Performance (${trades.length} trades, optimization iteration ${iterNum}):
- Win rate: ${winRate}% (${winners.length}W / ${losers.length}L)
- Stop-loss exits: ${stopLoss}/${Math.max(losers.length, 1)} losses
- Timeout exits: ${timeouts}/${Math.max(losers.length, 1)} losses
- Average loss: ${avgLoss}%

Valid parameter ranges:
${Object.entries(bounds).map(([k, b]) => `  ${k}: ${b.min} to ${b.max} (step ${b.step})`).join("\n")}

Suggest 1-3 parameter changes to improve win rate in iteration ${iterNum + 1}.
Return ONLY valid JSON (no markdown):
{"changes": {"paramName": numericValue}, "reasoning": "one sentence", "targetImprovement": "what this fixes"}`;
}

export async function suggestParamChanges(strategy, currentParams, trades, iterNum = 1) {
  const prompt = buildOptimizePrompt(strategy, currentParams, trades, iterNum);
  const bounds = getParamBounds(strategy);

  function applyBounds(raw) {
    if (!raw?.changes) return null;
    const clamped = Object.fromEntries(
      Object.entries(raw.changes)
        .filter(([k]) => bounds[k] && currentParams[k] != null)
        .map(([k, v]) => [k, clampParam(v, bounds[k])])
    );
    return { changes: clamped, reasoning: raw.reasoning || "", targetImprovement: raw.targetImprovement || "" };
  }

  if (process.env.OLLAMA_HOST) {
    try {
      const result = applyBounds(await callOllama(prompt));
      if (result) { console.log("[Hermes] Param suggestion via Ollama"); return result; }
    } catch (e) { console.warn("[Hermes] Ollama suggest error:", e.message); }
  }

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const result = applyBounds(await callClaude(prompt));
      if (result) { console.log("[Hermes] Param suggestion via Claude"); return result; }
    } catch (e) { console.warn("[Hermes] Claude suggest error:", e.message); }
  }

  console.log("[Hermes] Param suggestion via rule-based fallback");
  return ruleBasedParamSuggestion(strategy, currentParams, trades, iterNum);
}

// ── Per-trade explainer ──────────────────────────────────────────────────────
//
// For every trade in `trades`, return a short verdict explaining why it won
// or lost based on its exit reason, hold time, and how it compared to the
// cohort. Pure rule-based — no API needed — so it always runs.

export function explainTrades(trades) {
  if (!trades?.length) return [];

  const winners = trades.filter(t => (t.pnlPct ?? t.pnlR ?? 0) > 0);
  const losers  = trades.filter(t => (t.pnlPct ?? t.pnlR ?? 0) <= 0);
  const wRate   = trades.length > 0 ? winners.length / trades.length : 0;

  const avgWinPct  = winners.length ? winners.reduce((s, t) => s + (t.pnlPct || 0), 0) / winners.length : 0;
  const avgLossPct = losers.length  ? losers.reduce((s, t)  => s + (t.pnlPct || 0), 0) / losers.length  : 0;

  // Hold time (minutes), if we have entry/exit timestamps
  const holdMin = (t) => {
    const a = t.entryTime ? new Date(t.entryTime).getTime() : null;
    const b = t.exitTime  ? new Date(t.exitTime).getTime()  : null;
    return a && b ? Math.round((b - a) / 60000) : null;
  };

  return trades.map(t => {
    const pnl   = t.pnlPct ?? (t.pnlR ?? 0);
    const win   = pnl > 0;
    const hold  = holdMin(t);
    const reason = (t.exitReason || "").toLowerCase();
    const reasons = [];
    let verdict;

    if (win) {
      if (reason === "target")    reasons.push(`hit profit target (+${pnl.toFixed(2)}%)`);
      else if (reason === "time") reasons.push(`closed in profit at session end (+${pnl.toFixed(2)}%)`);
      else if (reason.includes("cross") || reason === "bias_flip") reasons.push(`exited on momentum flip (+${pnl.toFixed(2)}%)`);
      else                        reasons.push(`closed in profit via ${reason || "exit"} (+${pnl.toFixed(2)}%)`);

      if (hold != null && hold < 30) reasons.push(`quick win in ${hold}m — entry caught momentum early`);
      else if (hold != null && hold > 180) reasons.push(`long hold (${hold}m) — patience paid off`);
      if (pnl > avgWinPct * 1.5) reasons.push(`top-quartile winner (${pnl.toFixed(2)}% vs cohort avg ${avgWinPct.toFixed(2)}%)`);
      verdict = "GOOD";
    } else {
      if (reason === "stop") reasons.push(`stop hit (${pnl.toFixed(2)}%) — entry was too close to invalidation`);
      else if (reason === "time" || reason === "session_end" || reason === "eod" || reason === "timeout")
        reasons.push(`timed out without reaching target (${pnl.toFixed(2)}%) — target may be unrealistic for the day's range`);
      else if (reason === "bias_flip" || reason.includes("cross"))
        reasons.push(`momentum flipped against us (${pnl.toFixed(2)}%)`);
      else reasons.push(`closed at a loss via ${reason || "exit"} (${pnl.toFixed(2)}%)`);

      if (hold != null && hold < 10) reasons.push(`stopped in ${hold}m — entered into immediate reversal`);
      if (t.forced) reasons.push("entry was forced (no triple-confirmation) — known-lower-probability setup");
      if (pnl < avgLossPct * 1.5) reasons.push(`worse-than-average loser (${pnl.toFixed(2)}% vs cohort avg ${avgLossPct.toFixed(2)}%)`);
      verdict = "BAD";
    }

    return {
      ...t,
      verdict,
      verdictReasons: reasons,
      verdictText:    `${verdict}: ${reasons.join(" · ")}`,
      cohortWinRate:  +(wRate * 100).toFixed(1),
    };
  });
}

// ── Win-only filter learner ──────────────────────────────────────────────────
//
// Examines actual losing trades and proposes parameter floors that would have
// excluded most of them. Returns concrete filters the bot can apply to refuse
// future entries that match the loser profile.

export function deriveWinOnlyFilters(trades) {
  if (!trades?.length) return { filters: [], blockedLosers: 0, totalLosers: 0 };
  const winners = trades.filter(t => (t.pnlPct ?? t.pnlR ?? 0) > 0);
  const losers  = trades.filter(t => (t.pnlPct ?? t.pnlR ?? 0) <= 0);

  const filters = [];

  // 1) Entry-hour filter — if losers cluster in a specific ET hour, block it.
  const hourBuckets = {};
  for (const t of trades) {
    if (!t.entryTime) continue;
    const d = new Date(t.entryTime);
    // Convert to ET (approximate — backtest data is UTC, ET ≈ UTC-4/-5)
    const etH = (d.getUTCHours() - 4 + 24) % 24;
    hourBuckets[etH] = hourBuckets[etH] || { wins: 0, losses: 0 };
    if ((t.pnlPct ?? t.pnlR ?? 0) > 0) hourBuckets[etH].wins++;
    else hourBuckets[etH].losses++;
  }
  const badHours = Object.entries(hourBuckets)
    .filter(([_h, b]) => b.losses >= 3 && b.losses > b.wins * 2)
    .map(([h]) => parseInt(h));
  if (badHours.length) {
    filters.push({
      type: "skip-entry-hours-ET",
      value: badHours,
      reason: `Hours with ≥3 losses AND loss:win ratio > 2:1 — skip new entries`,
    });
  }

  // 2) Side bias — if one side accounts for the majority of losses, demand stricter confirmation for it.
  const longL  = losers.filter(t => t.side === "buy").length;
  const shortL = losers.filter(t => t.side === "sell").length;
  if (longL > shortL * 2 && longL >= 4) {
    filters.push({ type: "require-stronger-long", value: true, reason: `${longL} long losses vs ${shortL} short — demand extra confirmation on longs` });
  } else if (shortL > longL * 2 && shortL >= 4) {
    filters.push({ type: "require-stronger-short", value: true, reason: `${shortL} short losses vs ${longL} long — demand extra confirmation on shorts` });
  }

  // 3) Forced-entry block — if forced entries are net negative, block them outright.
  const forcedAll = trades.filter(t => t.forced);
  const forcedWin = forcedAll.filter(t => (t.pnlPct ?? t.pnlR ?? 0) > 0).length;
  if (forcedAll.length >= 5 && forcedWin / forcedAll.length < 0.4) {
    filters.push({
      type: "disable-force-daily",
      value: true,
      reason: `Forced entries: ${forcedWin}/${forcedAll.length} wins (<40%) — disable forceDaily`,
    });
  }

  // 4) Stop-distance floor — if most stop-outs happened with stops < median, widen the floor.
  const stopOuts = losers.filter(t => t.exitReason === "stop" && t.entryPrice != null);
  if (stopOuts.length >= 4) {
    filters.push({
      type: "raise-stop-distance",
      value: "min 0.4% from entry",
      reason: `${stopOuts.length} stops hit — current stops are too tight`,
    });
  }

  // Estimate how many losers these filters would have blocked
  const blockedLosers = losers.filter(t => {
    if (badHours.length && t.entryTime) {
      const etH = (new Date(t.entryTime).getUTCHours() - 4 + 24) % 24;
      if (badHours.includes(etH)) return true;
    }
    if (t.forced && filters.some(f => f.type === "disable-force-daily")) return true;
    return false;
  }).length;

  return {
    filters,
    blockedLosers,
    totalLosers: losers.length,
    estWinRateAfter: trades.length > 0
      ? `${((winners.length / Math.max(trades.length - blockedLosers, 1)) * 100).toFixed(1)}%`
      : "—",
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function runHermesAnalysis(strategy = "orb") {
  // Load trade history
  if (!existsSync(HISTORY_FILE)) {
    return { error: "No trade history yet — run the bot to generate trades" };
  }

  let history = [];
  try { history = JSON.parse(readFileSync(HISTORY_FILE, "utf8")); } catch {
    return { error: "Could not read trade-history.json" };
  }

  const trades = history.filter(t => t.strategy === strategy).slice(-30);
  if (trades.length < 5) {
    return { error: `Need at least 5 ${strategy} trades for analysis (have ${trades.length})` };
  }

  const prompt = buildPrompt(trades, strategy);
  let insights = null;
  let source   = "rule-based";

  // Try Ollama (Hermes local model) first
  if (process.env.OLLAMA_HOST) {
    try {
      insights = await callOllama(prompt);
      source   = `ollama/${process.env.HERMES_MODEL || "nous-hermes-2"}`;
      console.log(`[Hermes] Analysis via ${source}`);
    } catch (err) {
      console.warn("[Hermes] Ollama error:", err.message);
    }
  }

  // Fallback: Claude API
  if (!insights && process.env.ANTHROPIC_API_KEY) {
    try {
      insights = await callClaude(prompt);
      source   = "claude-haiku";
      console.log("[Hermes] Analysis via Claude API");
    } catch (err) {
      console.warn("[Hermes] Claude API error:", err.message);
    }
  }

  // Fallback: rule-based
  if (!insights) {
    insights = ruleBasedAnalysis(trades);
    source   = "rule-based";
    console.log("[Hermes] Using rule-based analysis (set ANTHROPIC_API_KEY or OLLAMA_HOST for AI analysis)");
  }

  const result = {
    ...insights,
    strategy,
    source,
    tradeCount:  trades.length,
    analyzedAt:  new Date().toISOString(),
  };

  // Persist
  const all = loadAllInsights();
  all[strategy] = result;
  writeFileSync(INSIGHTS_FILE, JSON.stringify(all, null, 2));
  return result;
}

export function loadHermesInsights(strategy) {
  if (!existsSync(INSIGHTS_FILE)) return null;
  try {
    const all = JSON.parse(readFileSync(INSIGHTS_FILE, "utf8"));
    return all[strategy] || null;
  } catch { return null; }
}

export function loadAllInsights() {
  if (!existsSync(INSIGHTS_FILE)) return {};
  try { return JSON.parse(readFileSync(INSIGHTS_FILE, "utf8")); } catch { return {}; }
}
