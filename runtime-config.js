/**
 * Router runtime config — env-var defaults, overridden by bot-config.json in
 * DATA_DIR (which the dashboard edits). Shared by bot-stream.js, which reloads
 * it every 30 s, and replay.js, so a replay runs with the live settings.
 */

import { readFileSync, existsSync } from "fs";
import { dataPath } from "./state.js";

// Runtime config — bot-config.json overrides these env-var defaults and is
// reloaded periodically so the dashboard can toggle the router live.
export const CONFIG_FILE = dataPath("bot-config.json");

export function parseEnvBool(value, defaultValue = false) {
  if (value == null || value === "") return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
  return defaultValue;
}

export function loadRuntimeConfig() {
  const defaults = {
    routerEnabled:          parseEnvBool(process.env.ROUTER_ENABLED, true),
    // How the router ranks candidates: "winrate" or "expectancy" (router.js)
    routerScore:            (process.env.ROUTER_SCORE || "winrate").toLowerCase(),
    // Where targets go: "strategy" (each strategy's own rule) or "liquidity"
    // (ICT: nearest liquidity pool ≥ liquidityMinRR × risk away — ict.js).
    // Liquidity mode also drops the options planner's premium profit-target
    // and time exits so the underlying target can be reached.
    // Strategies that trade shares even when optionsMode is on (e.g. ones
    // whose edge is too thin to survive option spreads).
    stockOnlyStrategies:    (process.env.STOCK_ONLY_STRATEGIES || "")
                              .split(",").map(s => s.trim().toLowerCase()).filter(Boolean),
    // Per-strategy symbol whitelist, { strategy: ["SPY", ...] }. A strategy
    // with no entry trades every symbol. Set in bot-config.json.
    strategySymbols:        {},
    targetMode:             (process.env.TARGET_MODE || "strategy").toLowerCase(),
    liquidityMinRR:         parseFloat(process.env.LIQUIDITY_MIN_RR || "2"),
    consensusMin:           parseInt(process.env.CONSENSUS_MIN || "1"),
    maxConcurrentPositions: parseInt(process.env.MAX_CONCURRENT_POSITIONS || "5"),
    activeStrategies:       (process.env.ACTIVE_STRATEGIES || "hybrid,hybrid10,smc,hybrid-reversal,reversal,vwap,predictor")
                              .split(",").map(s => s.trim().toLowerCase()).filter(Boolean),
    cryptoSymbols:          (process.env.CRYPTO_SYMBOLS || "")
                              .split(",").map(s => s.trim().toUpperCase()).filter(Boolean),
    // When true, every stock signal routes through the Options Strategist
    // agent which picks the contract and exit triggers. Crypto symbols
    // always trade the underlying — Alpaca doesn't offer crypto options.
    optionsMode:            parseEnvBool(process.env.OPTIONS_MODE, false),
    optionsDte:             parseInt(process.env.OPTIONS_DTE || "7"),
    // Price-target model (the 4th brain). When enabled, the XGBoost/heuristic
    // predictor gates and sizes router entries, and feeds its price target +
    // horizon into the Options Strategist for smarter strike/expiry selection.
    predictorEnabled:       parseEnvBool(process.env.PREDICTOR_ENABLED, false),
    predictorMinConfidence: parseFloat(process.env.PREDICTOR_MIN_CONFIDENCE || "0.5"),
    predictorVeto:          parseEnvBool(process.env.PREDICTOR_VETO, true),
    predictorSizeScaling:   parseEnvBool(process.env.PREDICTOR_SIZE_SCALING, true),
    // Predictor as a PRIMARY signal source (strategies/predictor-strat.js):
    // the model itself generates trades, targeting >= minTradesPerDay/day.
    predictorSignalEnabled: parseEnvBool(process.env.PREDICTOR_SIGNAL_ENABLED, false),
    predictorMinEdge:       parseFloat(process.env.PREDICTOR_MIN_EDGE || "0.35"),
    predictorSignalMinConf: parseFloat(process.env.PREDICTOR_SIGNAL_MIN_CONFIDENCE || "0.55"),
    stopAtrMult:            parseFloat(process.env.STOP_ATR_MULT || "1.5"),
    minTradesPerDay:        parseInt(process.env.MIN_TRADES_PER_DAY || "2"),
    floorTimeET:            process.env.FLOOR_TIME_ET || "14:30",
    predictorMinEdgeFloor:  parseFloat(process.env.PREDICTOR_MIN_EDGE_FLOOR || "0.15"),
    predictorMinConfFloor:  parseFloat(process.env.PREDICTOR_MIN_CONFIDENCE_FLOOR || "0.35"),
    // Options-first execution shaping
    strikeMode:             (process.env.STRIKE_MODE || "between").toLowerCase(),
    optionsDteBuffer:       parseInt(process.env.OPTIONS_DTE_BUFFER || "2"),
  };
  if (!existsSync(CONFIG_FILE)) return defaults;
  try {
    const fileCfg = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    return { ...defaults, ...fileCfg };
  } catch { return defaults; }
}

