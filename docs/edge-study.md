# Edge study — holding period, option expiry, and research-backed edges

Sept 30, 2026. Data: 5-minute IEX bars Jul 2020 – Sep 2026. Costs: 0.02%
round trip for shares; options priced with Black-Scholes at 20-day realized
volatility × 1.15 (buyers pay a volatility premium, as the research finds),
minus an assumed round-trip spread of 6% of premium (0DTE) down to 2% (30–45
DTE), with time to expiry measured in trading time (et.js varianceDays).

## 1. Same entries, different holding periods (shares, % per trade after costs)

| Strategy | Intraday | 1 day | 2 days | 5 days | 10 days |
|---|---|---|---|---|---|
| hybrid10 (7,500 trades) | +0.007 | −0.019 | −0.008 | +0.025 | +0.051 |
| … random direction, same times | −0.008 | −0.029 | −0.024 | −0.031 | −0.050 |
| ict-2024 (315) | +0.025 | +0.077 | +0.181 (t 1.9) | −0.103 | −0.207 |
| … random | −0.022 | −0.168 | −0.164 | −0.124 | +0.015 |
| sd-mtf (4,900) | −0.008 | −0.024 | −0.016 | −0.004 | +0.160 (t 1.9) |
| … random | +0.001 | −0.006 | −0.006 | +0.019 | +0.034 |

No holding period makes any of these significant after the number of tests run.

## 2. Option expiry (ATM, % of premium per trade after spread)

| hybrid10, intraday hold | 0DTE | 1DTE | 3DTE | 7DTE | 14DTE | 30DTE | 45DTE |
|---|---|---|---|---|---|---|---|
| signal | −30.6 | −10.8 | −6.7 | −4.0 | −2.8 | −2.0 | −1.9 |
| random direction | −31.8 | −11.6 | −7.5 | −4.5 | −3.1 | −2.2 | −2.1 |

Every strategy loses buying options at every expiry and holding period; for a
given hold, the longest expiry loses least. The only signal clearly better than
random was ict-2024 held 1–2 days (30–45 DTE: −0.3% vs about −5% random) —
still a loss. **Earlier 0DTE replay results were inflated** by pricing
same-day options in calendar time (fixed in replay.js).

## 3. Research-backed multi-day edges (rules fixed before testing; SPY QQQ IWM DIA; holdout 2025–26)

> **Correction (live-code check):** the standalone test below stopped scanning
> IWM after Nov 2024 (a 7-day exit falling on a half-day session had no 3:55 bar,
> and the loop ended). Run through the live strategy code (strategies/dip-buy.js
> via replay.js), the same rules give **2021–24: 117 trades, 67% win, +0.199%/trade;
> 2025–Sep 2026: 72 trades, 76% win, +0.745%/trade**. Live since Sept 30, 2026
> (paper account, shares).

**A. Index dip-buy** — close > 200-day SMA and RSI(2) < 10 at 15:50 → buy at
15:55; exit at 15:55 when RSI(2) > 70, close > prior day's high, or after 7
sessions. No stop.

| | Trades | Win | % per trade | Pooled by day |
|---|---|---|---|---|
| 2021–2024 | 116 | 67% | +0.226 | +0.15%, t 0.74 |
| **2025–Sep 2026 (holdout)** | **53** | **77%** | **+0.646** | **+0.76%, t 4.21** |
| same, filled next morning | 53 | 68% | +0.294 | +0.37%, t 2.07 |

By year: 2021 +0.05, 2022 −1.30 (8 trades), 2023 +0.02, 2024 +0.74, 2025 +0.55,
2026 +0.74. Average hold 3.4 sessions; buy-and-hold over the same exposure
≈ +0.16% (2021–24). Strong recently and consistent with the literature, but in
2021–24 it did no better than holding.

**B. Turn of month** — buy 2nd-to-last session's close, sell session 3's close.
2021–24: +0.159% per trade (≈ buy-and-hold for 4 sessions, no edge); holdout
+0.637% (20 days pooled, t 1.54). Not an edge on this evidence.

## Research summary (agent report)
Ranked by evidence: short-term reversal in index ETFs (dip-buying in an
uptrend); turn of month (smaller, shifted earlier since ETFs); trend/200-day
filters (reduce drawdowns more than add return); most of the equity premium
arrives overnight, so don't force flat-by-close; volatility risk premium
favors SELLING options (defined risk, 30-day tenors); buying 0DTE is negative
expected value in every study (Beckmeyer et al.; Vilkov: no 0DTE strategy
has positive net Sharpe after costs); buying longer-dated options loses about
1% a month on average and more when implied vol is high (after selloffs);
post-earnings drift in large caps is gone. For a gross edge under ~0.5% of
the underlying per trade, shares beat long options.
