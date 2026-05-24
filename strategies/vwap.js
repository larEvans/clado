// VWAP + EMA Momentum strategy — pure functions, no I/O

export const meta = {
  id: "vwap",
  name: "VWAP + EMA Momentum",
  description: "Trade in the direction of VWAP with EMA(8) trend filter and RSI(3) pullback entry. Exits on bias flip.",
  timeframe: "1H",
  watchlist: ["SPY", "QQQ"],
  pineFile: "pinescript/vwap.pine",
  params: {
    emaPeriod: 8,
    rsiPeriod: 3,
    rsiOversold: 30,
    rsiOverbought: 70,
    maxVwapDistPct: 1.5,
    stopPct: 1.5,
    rrRatio: 2.0,
  },
};

export function checkSignal(price, ema8, vwap, rsi3, params = meta.params) {
  if (!vwap || !rsi3) return null;

  const distPct = Math.abs((price - vwap) / vwap) * 100;
  const notOver  = distPct < params.maxVwapDistPct;
  const bullish  = price > vwap && price > ema8;
  const bearish  = price < vwap && price < ema8;
  const stopDist = vwap * (params.stopPct / 100);

  if (bullish && rsi3 < params.rsiOversold && notOver) {
    const stop   = vwap - stopDist;
    const target = price + (price - stop) * params.rrRatio;
    return { side: "buy", stop, target };
  }
  if (bearish && rsi3 > params.rsiOverbought && notOver) {
    const stop   = vwap + stopDist;
    const target = price - (stop - price) * params.rrRatio;
    return { side: "sell", stop, target };
  }
  return null;
}

// Whether the current bar's bias has flipped against the open trade
export function checkBiasFlip(price, ema8, vwap, openSide) {
  if (openSide === "buy")  return price < vwap && price < ema8;
  if (openSide === "sell") return price > vwap && price > ema8;
  return false;
}
