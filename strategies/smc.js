/**
 * Smart Money Concepts (SMC) strategy
 *
 * Logic:
 *   1. HTF bias — 48-bar EMA on 15m (~12H MA) determines trade direction
 *   2. Swing pivots — confirmed N-bar highs/lows define market structure
 *   3. BOS / ChoCH — close through last swing level = structural shift
 *   4. Liquidity sweep — wick beyond a swing level, close back inside
 *   5. Entry — BOS in sweep direction within 10 bars of the sweep
 *   6. Stop — behind the sweep wick (where smart money grabbed stops)
 *   7. Target — R:R multiple of risk
 */

export const meta = {
  id:          "smc",
  name:        "Smart Money Concepts",
  description: "Liquidity sweep + Break of Structure entries with multi-timeframe bias. Identifies buy-side/sell-side liquidity grabs, then enters on the displacement move. Order blocks and FVGs shown on chart.",
  timeframe:   "15m",
  watchlist:   ["SPY", "QQQ", "AAPL", "NVDA", "MSFT"],
  pineFile:    "pinescript/smc.pine",
  params: {
    swingLookback: 5,
    rrRatio:       2.5,
    htfEmaPeriod:  48,
    maxRiskPct:    0.015,
  },
};


function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function swingHigh(bars, i, lookback) {
  const h = bars[i]?.high;
  if (h == null) return false;
  for (let j = i - lookback; j <= i + lookback; j++) {
    if (j === i || j < 0 || j >= bars.length) continue;
    if (bars[j].high >= h) return false;
  }
  return true;
}

function swingLow(bars, i, lookback) {
  const l = bars[i]?.low;
  if (l == null) return false;
  for (let j = i - lookback; j <= i + lookback; j++) {
    if (j === i || j < 0 || j >= bars.length) continue;
    if (bars[j].low <= l) return false;
  }
  return true;
}

export function analyzeStructure(bars, params = meta.params) {
  const lookback = params.swingLookback || 5;
  if (!bars || bars.length < Math.max(lookback * 4, params.htfEmaPeriod || 48)) return null;
  const closes = bars.map(b => b.close);
  const htfEma = ema(closes, params.htfEmaPeriod || 48);
  const cur = bars[bars.length - 1];
  const bias = htfEma == null ? "neutral" : cur.close >= htfEma ? "bullish" : "bearish";

  const pivots = [];
  for (let i = lookback; i < bars.length - lookback; i++) {
    if (swingHigh(bars, i, lookback)) pivots.push({ type: "high", price: bars[i].high, time: bars[i].time, index: i });
    if (swingLow(bars, i, lookback)) pivots.push({ type: "low", price: bars[i].low, time: bars[i].time, index: i });
  }
  const lastHigh = [...pivots].reverse().find(p => p.type === "high");
  const lastLow  = [...pivots].reverse().find(p => p.type === "low");
  if (!lastHigh || !lastLow) return { bias, htfEma, pivots, lastHigh, lastLow };

  const recent = bars.slice(-10);
  const sellSweep = [...recent].reverse().find(b => b.low < lastLow.price && b.close > lastLow.price);
  const buySweep  = [...recent].reverse().find(b => b.high > lastHigh.price && b.close < lastHigh.price);
  const bullishBos = cur.close > lastHigh.price;
  const bearishBos = cur.close < lastLow.price;

  let orderBlock = null;
  if (sellSweep && bullishBos) {
    const ob = [...bars.slice(-20)].reverse().find(b => b.close < b.open);
    if (ob) orderBlock = { side: "bullish", high: ob.high, low: ob.low, time: ob.time };
  } else if (buySweep && bearishBos) {
    const ob = [...bars.slice(-20)].reverse().find(b => b.close > b.open);
    if (ob) orderBlock = { side: "bearish", high: ob.high, low: ob.low, time: ob.time };
  }

  return { bias, htfEma, pivots, lastHigh, lastLow, sellSweep, buySweep, bullishBos, bearishBos, orderBlock };
}

export function checkSignal(bars, params = meta.params) {
  const s = analyzeStructure(bars, params);
  if (!s?.lastHigh || !s?.lastLow) return null;
  const cur = bars[bars.length - 1];
  const rr = params.rrRatio || 2.5;

  if (s.sellSweep && s.bullishBos && s.bias !== "bearish") {
    const stop = Math.min(s.sellSweep.low, s.orderBlock?.low ?? s.sellSweep.low);
    const risk = cur.close - stop;
    if (risk <= 0 || risk / cur.close > (params.maxRiskPct || 0.015)) return null;
    return {
      side: "buy", entry: cur.close, stop, target: cur.close + risk * rr,
      entrySignal: "sell-side-liquidity-sweep+bullish-bos",
      liquidity: { side: "sell-side", level: s.lastLow.price, sweep: s.sellSweep.low },
      orderBlock: s.orderBlock,
      supplyDemand: s.orderBlock ? { demand: { low: s.orderBlock.low, high: s.orderBlock.high } } : null,
    };
  }

  if (s.buySweep && s.bearishBos && s.bias !== "bullish") {
    const stop = Math.max(s.buySweep.high, s.orderBlock?.high ?? s.buySweep.high);
    const risk = stop - cur.close;
    if (risk <= 0 || risk / cur.close > (params.maxRiskPct || 0.015)) return null;
    return {
      side: "sell", entry: cur.close, stop, target: cur.close - risk * rr,
      entrySignal: "buy-side-liquidity-sweep+bearish-bos",
      liquidity: { side: "buy-side", level: s.lastHigh.price, sweep: s.buySweep.high },
      orderBlock: s.orderBlock,
      supplyDemand: s.orderBlock ? { supply: { low: s.orderBlock.low, high: s.orderBlock.high } } : null,
    };
  }

  return null;
}
