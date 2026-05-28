/**
 * Multi-agent debate layer (Bull / Bear / Risk Manager / Trader)
 *
 * Pattern: instead of letting one signal trigger an entry, run a short
 * adversarial debate. Each agent returns a vote with confidence and
 * reasoning. The Risk Manager weighs both sides and decides whether the
 * trade is approved and at what size multiplier.
 *
 * Each agent has two implementations:
 *   1. Claude Haiku call (when ANTHROPIC_API_KEY is set) — best quality
 *   2. Rule-based fallback — always available, deterministic, free
 *
 * The rule-based versions are deliberately simple but capture the key
 * heuristics so the debate adds value even without an API key.
 *
 * Public API:
 *   runAgentDebate(trade, context) → {
 *     bull:   { vote, confidence, reasoning },
 *     bear:   { vote, confidence, reasoning },
 *     risk:   { approved, sizeMultiplier, reasoning },
 *     verdict: "APPROVE" | "REJECT",
 *     source: "claude" | "rule-based"
 *   }
 *
 * Trade input shape (everything optional except side):
 *   { side, entry, stop, target, strategy, regime, symbol, orderBlock?, forced?,
 *     entrySignal?, recentBars? }
 *
 * Context input shape:
 *   { regimeStats?, recentTrades?, sessionPnl?, openPositions? }
 */

const AGENT_DEBATE_ENABLED = process.env.AGENT_DEBATE === "true";
const AGENT_TIMEOUT_MS     = parseInt(process.env.AGENT_TIMEOUT_MS || "8000");

// ── Claude API caller ────────────────────────────────────────────────────────

async function callClaude(prompt, systemPrompt) {
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
      max_tokens: 512,
      system:     systemPrompt,
      messages:   [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Claude ${res.status}`);
  const data = await res.json();
  const text = data.content?.[0]?.text || "";
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON in Claude response");
  return JSON.parse(match[0]);
}

// ── Shared trade-context builder ────────────────────────────────────────────

function summarizeTrade(trade, context = {}) {
  const obDesc = trade.orderBlock
    ? `${trade.orderBlock.side} order block low=${trade.orderBlock.low?.toFixed(2)} high=${trade.orderBlock.high?.toFixed(2)} (impulse ${trade.orderBlock.impulsePct?.toFixed(2)}%)`
    : "no order block detected";
  const reg = trade.regime || "unknown";
  const stats = context.regimeStats?.[trade.strategy]?.[reg];
  const statsStr = stats
    ? `win rate ${(stats.winRate * 100).toFixed(0)}% (${stats.sampleSize} samples)`
    : "no regime-specific history yet";
  const dist = trade.entry && trade.stop ? Math.abs(trade.entry - trade.stop).toFixed(2) : "—";
  const distR = trade.entry && trade.target ? Math.abs(trade.target - trade.entry).toFixed(2) : "—";
  return {
    desc: `${trade.symbol} ${trade.side?.toUpperCase()} @ ${trade.entry?.toFixed(2)} via ${trade.strategy} in regime "${reg}".\n` +
          `Stop $${trade.stop?.toFixed(2)} (${dist} from entry, ${obDesc}). Target $${trade.target?.toFixed(2)} (${distR} from entry).\n` +
          `Strategy history: ${statsStr}.` +
          (trade.forced ? " ENTRY IS FORCED — strict triple-confirmation did not fire." : "") +
          (trade.entrySignal ? ` Trigger: ${trade.entrySignal}.` : ""),
    stats,
    regime: reg,
  };
}

// ── Bull agent (rule-based) ─────────────────────────────────────────────────

function ruleBullVote(trade, context) {
  const { stats } = summarizeTrade(trade, context);
  const reasons = [];
  let confidence = 0.5;

  // Strategy historical win rate in this regime
  if (stats?.winRate >= 0.6 && stats.sampleSize >= 10) {
    reasons.push(`strategy wins ${(stats.winRate * 100).toFixed(0)}% in this regime (${stats.sampleSize} samples)`);
    confidence += 0.2;
  } else if (stats?.winRate >= 0.5) {
    reasons.push(`strategy modestly profitable in regime (${(stats.winRate * 100).toFixed(0)}%)`);
    confidence += 0.05;
  }

  // Order-block stop adds structural conviction
  if (trade.orderBlock) {
    reasons.push(`stop sits at a real liquidity zone (${trade.orderBlock.side} OB) — structurally clean`);
    confidence += 0.1;
  }

  // Tight stop = tight risk
  if (trade.entry && trade.stop && trade.target) {
    const r = Math.abs(trade.entry - trade.stop);
    const rr = Math.abs(trade.target - trade.entry) / r;
    if (rr >= 2) {
      reasons.push(`R:R = ${rr.toFixed(1)} (favorable asymmetry)`);
      confidence += 0.05;
    }
  }

  // Non-forced entries get extra credit
  if (!trade.forced) {
    reasons.push("strict triple-confirmation fired (not a forced entry)");
    confidence += 0.1;
  }

  if (reasons.length === 0) reasons.push("no strong bullish thesis — neutral structural setup");

  return {
    vote: confidence >= 0.55 ? "YES" : "NEUTRAL",
    confidence: +Math.min(1, confidence).toFixed(2),
    reasoning: reasons.join("; "),
  };
}

// ── Bear agent (rule-based) ─────────────────────────────────────────────────

function ruleBearVote(trade, context) {
  const { stats } = summarizeTrade(trade, context);
  const reasons = [];
  let confidence = 0.5;

  // Low win rate or thin sample → bear case
  if (stats?.winRate < 0.45 && stats.sampleSize >= 8) {
    reasons.push(`strategy only wins ${(stats.winRate * 100).toFixed(0)}% in this regime — historical loser zone`);
    confidence += 0.25;
  }
  if (!stats || stats.sampleSize < 5) {
    reasons.push(`thin or no regime history (${stats?.sampleSize || 0} samples) — flying blind`);
    confidence += 0.1;
  }

  // Forced entry warning
  if (trade.forced) {
    reasons.push("entry is FORCED — bot is reaching for a trade without proper confirmation");
    confidence += 0.2;
  }

  // No order block, no liquidity reason
  if (!trade.orderBlock) {
    reasons.push("no recent order block — stop placed at ORB opposite, less structural meaning");
    confidence += 0.05;
  }

  // Recent losses on this strategy
  const recentLosses = (context.recentTrades || [])
    .filter(t => t.strategy === trade.strategy)
    .slice(-5)
    .filter(t => (t.pnlPct ?? 0) <= 0).length;
  if (recentLosses >= 3) {
    reasons.push(`${recentLosses}/5 recent trades on ${trade.strategy} lost — momentum against this strategy`);
    confidence += 0.15;
  }

  if (reasons.length === 0) reasons.push("no strong bearish thesis — structure looks acceptable");

  return {
    vote: confidence >= 0.6 ? "YES" : "NEUTRAL",
    confidence: +Math.min(1, confidence).toFixed(2),
    reasoning: reasons.join("; "),
  };
}

// ── Risk Manager (rule-based) ───────────────────────────────────────────────

function ruleRiskVerdict(bullVote, bearVote, trade, context) {
  // Hard rejection rules first
  if (trade.forced && bearVote.confidence > 0.7) {
    return {
      approved: false,
      sizeMultiplier: 0,
      reasoning: `Risk vetoes: forced entry + strong bear case (conf ${bearVote.confidence}). Skip.`,
    };
  }

  // Session loss circuit-breaker
  const sessionPnl = context.sessionPnl ?? 0;
  if (sessionPnl < -3) {
    return {
      approved: false,
      sizeMultiplier: 0,
      reasoning: `Risk vetoes: session P&L ${sessionPnl.toFixed(2)}% — circuit breaker engaged.`,
    };
  }

  // Concurrent-position cap
  const openCount = context.openPositions ?? 0;
  if (openCount >= 5) {
    return {
      approved: false,
      sizeMultiplier: 0,
      reasoning: `Risk vetoes: ${openCount} positions already open (max 5).`,
    };
  }

  // Weighted score: positive bull, negative bear, scaled by confidence
  const bullScore = bullVote.vote === "YES" ? bullVote.confidence : 0;
  const bearScore = bearVote.vote === "YES" ? bearVote.confidence : 0;
  const net = bullScore - bearScore;

  if (net <= 0) {
    return {
      approved: false,
      sizeMultiplier: 0,
      reasoning: `Bull ${bullScore.toFixed(2)} vs Bear ${bearScore.toFixed(2)} → bear wins or tie. Skip.`,
    };
  }

  // Size based on conviction: stronger bull case → full size; thin edge → half size
  let size;
  if (net >= 0.5)       size = 1.0;
  else if (net >= 0.25) size = 0.66;
  else                  size = 0.33;

  return {
    approved: true,
    sizeMultiplier: size,
    reasoning: `Bull ${bullScore.toFixed(2)} > Bear ${bearScore.toFixed(2)} (net ${net.toFixed(2)}) → APPROVE at ${(size * 100).toFixed(0)}% size.`,
  };
}

// ── Claude-backed agent calls ───────────────────────────────────────────────

async function claudeBull(trade, context, summary) {
  const sys = "You are a Bull Researcher on a trading desk. Your only job is to argue WHY this trade should be taken. Respond ONLY with JSON.";
  const prompt = `${summary.desc}\n\nArgue the bull case. Return JSON:\n{"vote":"YES"|"NEUTRAL","confidence":0.0-1.0,"reasoning":"<one or two sentences>"}`;
  return callClaude(prompt, sys);
}

async function claudeBear(trade, context, summary) {
  const sys = "You are a Bear Researcher on a trading desk. Your only job is to argue WHY this trade should NOT be taken. Respond ONLY with JSON.";
  const prompt = `${summary.desc}\n\nArgue the bear case. Return JSON:\n{"vote":"YES"|"NEUTRAL","confidence":0.0-1.0,"reasoning":"<one or two sentences>"}`;
  return callClaude(prompt, sys);
}

async function claudeRisk(bull, bear, trade, context, summary) {
  const sys = "You are a Risk Manager. Weigh the bull and bear arguments and decide whether to APPROVE the trade and at what size (0.0 to 1.0). Respond ONLY with JSON.";
  const prompt = `Trade: ${summary.desc}\n\nBull (${bull.confidence}): ${bull.reasoning}\nBear (${bear.confidence}): ${bear.reasoning}\n\nSession P&L: ${context.sessionPnl ?? 0}%. Open positions: ${context.openPositions ?? 0}.\nReturn JSON: {"approved":true|false,"sizeMultiplier":0.0-1.0,"reasoning":"<one or two sentences>"}`;
  return callClaude(prompt, sys);
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function runAgentDebate(trade, context = {}) {
  const summary = summarizeTrade(trade, context);
  let bull, bear, risk;
  let source = "rule-based";

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      bull = await claudeBull(trade, context, summary);
      bear = await claudeBear(trade, context, summary);
      risk = await claudeRisk(bull, bear, trade, context, summary);
      source = "claude";
    } catch (e) {
      console.warn("[Agents] Claude call failed, falling back to rule-based:", e.message);
      bull = ruleBullVote(trade, context);
      bear = ruleBearVote(trade, context);
      risk = ruleRiskVerdict(bull, bear, trade, context);
    }
  } else {
    bull = ruleBullVote(trade, context);
    bear = ruleBearVote(trade, context);
    risk = ruleRiskVerdict(bull, bear, trade, context);
  }

  return {
    bull, bear, risk,
    verdict: risk.approved ? "APPROVE" : "REJECT",
    source,
    summary: summary.desc,
  };
}

export function debateEnabled() {
  return AGENT_DEBATE_ENABLED;
}
