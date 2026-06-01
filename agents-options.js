/**
 * Options Strategist — 4th agent in the debate layer
 *
 * Once Bull/Bear/Risk approve a stock-direction trade, the Options Strategist
 * decides:
 *   - Which contract to buy (strike / expiry / DTE / type)
 *   - When to sell it (profit target %, max loss %, time exit, IV-crush stop)
 *
 * This is the ONLY path through which options trades are placed. The agent
 * runs even if the underlying signal looks great — sometimes the best stock
 * signal is the worst options trade (wide spreads, IV crush risk, low OI).
 *
 * Two implementations:
 *   1. Claude Haiku call when ANTHROPIC_API_KEY is set — reads the chain,
 *      reasons about IV/liquidity/expected move, returns a structured pick.
 *   2. Rule-based fallback — deterministic logic on the chain snapshot.
 *
 * Public API:
 *   pickContract(signal, stockPrice, chainContext, opts) →
 *     { contract: { symbol, type, strike, expiry, dte, premium, bid, ask, mid, iv, delta },
 *       exitTriggers: { profitTargetPct, maxLossPct, timeExitMinutes, ivCrushPct },
 *       reasoning, confidence, source }
 *
 *   shouldExitOption(position, currentPrice, currentOption) →
 *     { exit: boolean, reason: string }
 */

import { fetchChain, fetchSnapshots } from "./options.js";

// ── Claude call ────────────────────────────────────────────────────────────────

async function callClaudeOptionsAgent(prompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-haiku-4-5-20251001",
        max_tokens: 600,
        messages:   [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data.content?.[0]?.text || "";
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]);
  } catch (e) {
    console.warn("[OptionsAgent] Claude call failed:", e.message);
    return null;
  }
}

function buildOptionsPrompt(signal, stockPrice, chainContext) {
  const { calls = [], puts = [] } = chainContext.chain || {};
  const wantCalls = signal.side === "buy";
  const list = wantCalls ? calls : puts;
  // Pass only the 8 nearest-to-ATM contracts to keep the prompt small
  const nearAtm = list
    .map(c => ({ ...c, dist: Math.abs(c.strike - stockPrice) }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 8);

  const compact = nearAtm.map(c => ({
    sym:    c.symbol,
    strike: c.strike,
    bid:    c.bid,
    ask:    c.ask,
    mid:    c.mid,
    oi:     c.oi,
    iv:     c.iv,
    delta:  c.greeks?.delta,
    theta:  c.greeks?.theta,
  }));

  return `You are an options trading specialist deciding the best contract for an approved ${signal.side.toUpperCase()} signal.

Underlying: ${chainContext.symbol} @ $${stockPrice.toFixed(2)}
Stock target: $${signal.target?.toFixed(2)} (expected move: ${(((signal.target - signal.entry) / signal.entry) * 100).toFixed(2)}%)
Stock stop:   $${signal.stop?.toFixed(2)}
Strategy:     ${signal.strategy || "unknown"}
Regime:       ${signal.regime || "unknown"}
Expiry pool:  ${chainContext.expiry} (${chainContext.dte} days to expiry)

Available ${wantCalls ? "CALL" : "PUT"} contracts (nearest 8 to ATM):
${JSON.stringify(compact, null, 1)}

TASK: pick the SINGLE best contract. Optimize for:
- Liquid (bid/ask spread < 10% of mid, OI ≥ 100 ideally)
- Delta 0.35-0.65 (gives leverage without excessive gamma risk)
- Premium ≤ 5% of stock price for cost control
- Realistic to reach the stock target before theta erodes the premium

Then set exit triggers tuned to the contract's DTE and the strategy's typical hold time.

Respond ONLY with JSON (no markdown):
{
  "pickedSymbol": "OCC option symbol",
  "reasoning": "one sentence why this contract beat the others",
  "confidence": 0.0-1.0,
  "exitTriggers": {
    "profitTargetPct": 30-100,
    "maxLossPct": 30-60,
    "timeExitMinutes": 60-360,
    "ivCrushPct": 15-30
  }
}`;
}

// ── Rule-based fallback ────────────────────────────────────────────────────────

function ruleBasedPickContract(signal, stockPrice, chainContext) {
  const { calls = [], puts = [] } = chainContext.chain || {};
  const wantCalls = signal.side === "buy";
  const list = wantCalls ? calls : puts;
  if (!list.length) return null;

  // Score contracts: prefer ATM-ish, decent OI, narrow spread, delta 0.35-0.65
  const scored = list.map(c => {
    const mid     = c.mid ?? ((c.bid + c.ask) / 2) ?? 0;
    const spread  = c.ask && c.bid ? Math.abs(c.ask - c.bid) / Math.max(mid, 0.01) : 1;
    const distPct = Math.abs(c.strike - stockPrice) / stockPrice;
    const delta   = Math.abs(c.greeks?.delta ?? (0.5 - distPct * 5));

    let score = 1.0;
    score -= distPct * 2;                                    // prefer ATM
    score -= Math.min(spread, 0.5);                          // penalize wide spreads
    if (c.oi != null) score += Math.min(c.oi / 1000, 1) * 0.3; // bonus for OI
    if (delta < 0.3 || delta > 0.75) score -= 0.4;           // delta band
    if (mid > stockPrice * 0.08) score -= 0.5;               // penalize > 8% of stock price

    return { ...c, mid, delta, score, _spreadPct: spread };
  }).sort((a, b) => b.score - a.score);

  const top = scored[0];
  if (!top || top.score < -0.3) return null;

  // Exit triggers scaled by DTE
  const dte = chainContext.dte || 7;
  const profitTargetPct = dte <= 1 ? 35 : dte <= 3 ? 50 : 60;
  const maxLossPct      = dte <= 1 ? 40 : 50;
  const timeExitMinutes = dte <= 1 ? 60 : dte <= 3 ? 180 : 300;

  return {
    contract: {
      symbol:  top.symbol,
      type:    wantCalls ? "call" : "put",
      strike:  top.strike,
      expiry:  chainContext.expiry,
      dte,
      premium: top.mid,
      bid:     top.bid,
      ask:     top.ask,
      mid:     top.mid,
      iv:      top.iv,
      delta:   top.delta,
      oi:      top.oi,
    },
    exitTriggers: {
      profitTargetPct,
      maxLossPct,
      timeExitMinutes,
      ivCrushPct: 25,
    },
    reasoning: `ATM-ish ${wantCalls ? "call" : "put"} at $${top.strike} with delta ${top.delta?.toFixed(2)}, spread ${(top._spreadPct * 100).toFixed(1)}%, OI ${top.oi || "?"}.`,
    confidence: Math.min(1, Math.max(0.3, top.score + 0.5)),
    source: "rule-based",
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Pick the best options contract for an approved stock signal.
 *
 * @param {object} signal — { side, entry, stop, target, strategy, regime }
 * @param {number} stockPrice
 * @param {object} chainContext — { symbol, expiry, dte, chain: { calls, puts } }
 * @param {object} [opts] — { maxPremiumPct: 5 }
 * @returns Pick object or null when no contract qualifies.
 */
export async function pickContract(signal, stockPrice, chainContext, opts = {}) {
  // Try Claude first when key available
  if (process.env.ANTHROPIC_API_KEY) {
    const prompt   = buildOptionsPrompt(signal, stockPrice, chainContext);
    const claudeAns = await callClaudeOptionsAgent(prompt);
    if (claudeAns?.pickedSymbol) {
      const list = signal.side === "buy" ? chainContext.chain.calls : chainContext.chain.puts;
      const picked = list?.find(c => c.symbol === claudeAns.pickedSymbol);
      if (picked) {
        return {
          contract: {
            symbol:  picked.symbol,
            type:    signal.side === "buy" ? "call" : "put",
            strike:  picked.strike,
            expiry:  chainContext.expiry,
            dte:     chainContext.dte,
            premium: picked.mid,
            bid:     picked.bid,
            ask:     picked.ask,
            mid:     picked.mid,
            iv:      picked.iv,
            delta:   picked.greeks?.delta,
            oi:      picked.oi,
          },
          exitTriggers: {
            profitTargetPct: claudeAns.exitTriggers?.profitTargetPct ?? 50,
            maxLossPct:      claudeAns.exitTriggers?.maxLossPct      ?? 50,
            timeExitMinutes: claudeAns.exitTriggers?.timeExitMinutes ?? 180,
            ivCrushPct:      claudeAns.exitTriggers?.ivCrushPct      ?? 25,
          },
          reasoning:  claudeAns.reasoning  || "Claude pick",
          confidence: claudeAns.confidence || 0.6,
          source:     "claude-haiku",
        };
      }
    }
  }

  // Rule-based fallback
  return ruleBasedPickContract(signal, stockPrice, chainContext);
}

/**
 * Check whether an open options position should be exited now.
 *
 * @param {object} position — { entryPremium, contract, entryTime, exitTriggers }
 * @param {number} currentStockPrice
 * @param {object} [currentOption] — latest { bid, ask, mid, iv } if available
 */
export function shouldExitOption(position, currentStockPrice, currentOption) {
  if (!position?.exitTriggers || !position.entryPremium) return { exit: false };
  const { profitTargetPct, maxLossPct, timeExitMinutes, ivCrushPct } = position.exitTriggers;

  const cur = currentOption?.mid ?? currentOption?.bid ?? null;
  if (cur != null && position.entryPremium > 0) {
    const pnlPct = ((cur - position.entryPremium) / position.entryPremium) * 100;
    if (profitTargetPct != null && pnlPct >= profitTargetPct) return { exit: true, reason: "options-target", premium: cur, pnlPct };
    if (maxLossPct     != null && pnlPct <= -Math.abs(maxLossPct)) return { exit: true, reason: "options-stop", premium: cur, pnlPct };
    if (ivCrushPct     != null && position.entryIv && currentOption.iv && ((position.entryIv - currentOption.iv) / position.entryIv) * 100 >= ivCrushPct)
      return { exit: true, reason: "iv-crush", premium: cur, pnlPct };
  }

  if (timeExitMinutes != null && position.entryTime) {
    const ageMin = (Date.now() - new Date(position.entryTime).getTime()) / 60_000;
    if (ageMin >= timeExitMinutes) return { exit: true, reason: "options-time-exit" };
  }

  return { exit: false };
}

/**
 * High-level helper used by bot-stream: given a stock signal, fetch the chain,
 * pick a contract, and return the full options trade plan. Returns null when
 * no chain is available or no contract qualifies.
 */
export async function planOptionsTrade(signal, stockPrice, opts = {}) {
  const dte = opts.dte ?? 7;
  try {
    // Determine expiry: nearest available ≥ today
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const targetExpiry = new Date(today.getTime() + dte * 86_400_000).toISOString().slice(0, 10);

    const chain = await fetchChain(signal.symbol || opts.underlying, targetExpiry, stockPrice);
    if (!chain || (!chain.calls?.length && !chain.puts?.length)) {
      // Try a different expiry — look at all expiries within ±5 days of target
      return null;
    }
    const actualDte = Math.max(1, Math.round((new Date(targetExpiry).getTime() - Date.now()) / 86_400_000));
    return await pickContract(signal, stockPrice, {
      symbol: signal.symbol || opts.underlying,
      expiry: targetExpiry,
      dte:    actualDte,
      chain,
    }, opts);
  } catch (e) {
    console.warn("[OptionsAgent] planOptionsTrade error:", e.message);
    return null;
  }
}
