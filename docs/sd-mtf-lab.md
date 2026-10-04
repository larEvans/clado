# sd-mtf tuning lab — multi-timeframe supply & demand

Goal set: ≥ 70% win rate. Rules followed: the win rate only counts if the
strategy also makes money after a 0.02% round-trip cost, and all tuning uses
**development data only (Jul 2020 – Dec 2023)**. The final setting was run
**once** on the **holdout (Jan 2024 – Sep 2026)**.

Data: 5-minute IEX bars, SPY QQQ DIA IWM MSFT META TSLA, fills at the next
bar's open, shares (R-multiples), 1h + 15m + 5m timeframes (concepts.js,
strategies/sd-mtf.js).

## Iterations (development data)

| # | Change | Trades | Win | Net R/trade |
|---|---|---|---|---|
| 1 | Baseline: 1h bias, 15m agrees, 5m BOS → first return to order block with FVG, target = nearest liquidity (≥1R) | 2,639 | 35.8% | −0.091 |
| 2 | Fixed target 1R | 3,019 | 49.5% | −0.104 |
| 2 | Fixed target 0.5R | 3,019 | 61.3% | −0.134 |
| 2 | 0.5R, stop ≥ 0.2% of price | 1,787 | 66.8% | −0.035 |
| 3 | Win/loss analysis of #2: every bucket (symbol, side, regime, hour, zone size, break strength, depth) wins 66–68% — the win rate comes from target geometry, not the entry | | | |
| 4 | Features: entry inside a fresh 15m zone (POI) | 442 | 61.3% | −0.130 (t −3.6) |
| 4 | Features: premium/discount "right side" | 184 | 62.5% | −0.120 |
| 4 | Features: liquidity sweep before the break | 326 | 66.6% | +0.003 |
| 4 | Features: Wyckoff spring/upthrust | 55 | 70.9% | +0.043 (too few) |
| 5 | 0.5R, stop ≥ 0.2%, avoid 15m POI | 1,415 | 68.4% | −0.009 |
| 5 | **0.4R, stop ≥ 0.3%, avoid 15m POI (final)** | **952** | **72.3%** | **−0.010** |
| 5 | same + require sweep (0.5R) | 206 | 66.5% | +0.026 (t 0.46) |
| 5 | final without the 15m filter | 1,897 | 67.3% | −0.022 |
| 5 | final without requiring an FVG | 1,895 | 66.6% | −0.044 |

## Holdout (run once)

| | Trades | Win | Net R/trade |
|---|---|---|---|
| Final setting, Jan 2024 – Sep 2026 | 637 | 66.6% | **−0.080** (t −3.15) |
| … range regime | 344 | 69.5% | −0.041 |
| … trend-up | 146 | 67.8% | −0.062 |
| … trend-down | 147 | 58.5% | −0.192 |

**Conclusion.** A 70% win rate is reachable on the tuning data only by
shrinking the target to 0.4R; the entries carry no measurable edge, so on new
data the win rate falls back toward the geometry (≈ 1 / (1 + 0.4) ≈ 71% minus
costs and gaps) and the strategy loses money. Textbook confluence (entering at
higher-timeframe zones, premium/discount) made results worse on these liquid
symbols. sd-mtf is available but not active.
