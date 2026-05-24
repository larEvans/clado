// Momentum / Market Timing — MACD histogram cross + RSI filter
// Based on the IG algorithmic trading guide: Market Timing strategy

export const meta = {
  id:          "momentum",
  name:        "Momentum (MACD + RSI)",
  description: "Enters long when the MACD histogram crosses above zero (12,26,9) AND RSI(14) > 50 — confirming bullish momentum. Enters short on opposite conditions. Exits on reverse MACD cross or stop/target. Uses ATR-based stops for volatility-adaptive risk control.",
  timeframe:   "1D",
  watchlist:   ["SPY","QQQ","TSLA","NVDA","AMZN"],
  pineFile:    "pinescript/momentum.pine",
  params: {
    macdFast:  12,
    macdSlow:  26,
    macdSig:   9,
    rsiPeriod: 14,
    atrPeriod: 14,
    atrMult:   2.0,
    rrRatio:   2.0,
  },
};
