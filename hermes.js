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
