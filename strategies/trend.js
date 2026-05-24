// Trend Following — EMA crossover with volume confirmation
// Based on the IG algorithmic trading guide: Trend Following strategy

export const meta = {
  id:          "trend",
  name:        "EMA Trend Following",
  description: "Fast/slow EMA crossover (9/21) with above-average volume confirmation. Goes long when EMA9 crosses above EMA21 with volume surge; short on cross-below. Exits on reverse cross or stop/target hit.",
  timeframe:   "1D",
  watchlist:   ["SPY","QQQ","AAPL","MSFT","NVDA"],
  pineFile:    "pinescript/trend.pine",
  params: {
    fastEMA:       9,
    slowEMA:       21,
    volMaPeriod:   20,
    volMultiplier: 1.1,
    atrPeriod:     14,
    atrMult:       1.5,
    rrRatio:       2.0,
  },
};
