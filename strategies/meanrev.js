// Mean Reversion — Bollinger Bands + RSI
// Based on the IG algorithmic trading guide: Mean Reversion strategy

export const meta = {
  id:          "meanrev",
  name:        "Mean Reversion (BB + RSI)",
  description: "Buys when price closes below the lower Bollinger Band (20,2) with RSI < 35 (oversold). Sells when price closes above the upper band with RSI > 65 (overbought). Target is the middle band (mean). Exits on timeout after 15 bars if target not reached.",
  timeframe:   "1D",
  watchlist:   ["SPY","QQQ","AAPL","MSFT","GLD"],
  pineFile:    "pinescript/meanrev.pine",
  params: {
    bbPeriod:       20,
    bbMult:         2.0,
    rsiPeriod:      14,
    rsiOversold:    35,
    rsiOverbought:  65,
    atrPeriod:      14,
    maxHoldBars:    15,
  },
};
