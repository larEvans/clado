/**
 * Shared indicator math — single source of truth for the scalar helpers
 * that were previously copy-pasted into regime.js, strategies/smc.js and
 * backtest.js. Pure functions, no I/O.
 *
 * Conventions:
 *   - `values` is an array of numbers (usually closes), oldest → newest
 *   - `bars` is an array of { open, high, low, close }, oldest → newest
 *   - All helpers return null when there isn't enough data
 */

/** Exponential moving average of the full series (returns the last value). */
export function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

/** Average True Range over the trailing `period` bars (simple average of TRs). */
export function atr(bars, period = 14) {
  if (bars.length < period + 1) return null;
  const trs = [];
  for (let i = bars.length - period; i < bars.length; i++) {
    if (i === 0) continue;
    const h = bars[i].high, l = bars[i].low, pc = bars[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  if (trs.length === 0) return null;
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}
