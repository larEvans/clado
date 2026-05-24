// Opening Range Breakout strategy — pure functions, no I/O

export const meta = {
  id: "orb",
  name: "Opening Range Breakout",
  description: "First 15-min high/low breakout with VWAP + volume confirmation. Long above ORB high, short below ORB low. 2:1 R:R.",
  timeframe: "5m",
  watchlist: ["SPY", "QQQ"],
  pineFile: "pinescript/orb.pine",
  params: {
    orbMinutes: 15,
    rrRatio: 2.0,
    tradeWindowMins: 90,
    volumeMultiplier: 2.0,
    volMaPeriod: 20,
    maxRangePct: 1.0,
  },
};

export function calcRange(orbCandles) {
  if (!orbCandles || orbCandles.length === 0) return null;
  const orbHigh = Math.max(...orbCandles.map(c => c.high));
  const orbLow  = Math.min(...orbCandles.map(c => c.low));
  return { orbHigh, orbLow, orbRange: orbHigh - orbLow };
}

// Check entry signal for a single bar.
// candlesBefore: all candles before this bar (for volume MA calculation)
// Returns { side, stop, target } or null
export function checkSignal(bar, orb, vwap, candlesBefore, params = meta.params) {
  if (!orb || !vwap) return null;
  const { orbHigh, orbLow, orbRange } = orb;
  const price = bar.close;

  const recent = candlesBefore.slice(-(params.volMaPeriod + 1)).slice(0, params.volMaPeriod);
  const volMA = recent.length > 0 ? recent.reduce((s, c) => s + c.volume, 0) / recent.length : 0;
  const highVol = volMA > 0 && bar.volume >= volMA * params.volumeMultiplier;

  if (price > orbHigh && price > vwap && highVol) {
    return { side: "buy", stop: orbLow, target: orbHigh + orbRange * params.rrRatio };
  }
  if (price < orbLow && price < vwap && highVol) {
    return { side: "sell", stop: orbHigh, target: orbLow - orbRange * params.rrRatio };
  }
  return null;
}
