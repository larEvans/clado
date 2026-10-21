/**
 * US Eastern-time helpers for UTC-ms bar timestamps. Dependency-free so both
 * the router (signals.js) and the model's features (ml/features.js, ict.js)
 * can use them.
 */

function isEDT(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
  if (m < 3 || m > 11) return false;
  if (m > 3 && m < 11) return true;
  const mar1 = new Date(Date.UTC(y, 2, 1));
  const ss   = new Date(mar1.getTime() + ((mar1.getUTCDay() === 0 ? 0 : 7 - mar1.getUTCDay()) + 7) * 86400000);
  ss.setUTCHours(7, 0, 0, 0);
  const nov1 = new Date(Date.UTC(y, 10, 1));
  const fs   = new Date(nov1.getTime() + (nov1.getUTCDay() === 0 ? 0 : 7 - nov1.getUTCDay()) * 86400000);
  fs.setUTCHours(6, 0, 0, 0);
  if (m === 3) return ms >= ss.getTime();
  return ms < fs.getTime();
}

/** { day: "YYYY-MM-DD", mins: minutes since ET midnight } for a UTC ms time. */
export function etInfo(ms) {
  const et = new Date(ms - (isEDT(ms) ? 4 : 5) * 3600000);
  return { day: et.toISOString().slice(0, 10), mins: et.getUTCHours() * 60 + et.getUTCMinutes() };
}

/** UTC ms of 9:30 ET on the ET trading day containing `ms`. */
export function sessionOpenMs(ms) {
  const { day } = etInfo(ms);
  const [y, m, d] = day.split("-").map(Number);
  const noonUtc = Date.UTC(y, m - 1, d, 12);
  return Date.UTC(y, m - 1, d, isEDT(noonUtc) ? 13 : 14, 30);
}

/**
 * Option time-to-expiry in "trading days" of variance between two UTC ms
 * times: each regular session contributes 0.8 × (its minutes / 390) and each
 * overnight/weekend gap 0.2 (≈ how a stock's daily variance splits between
 * the session and the close-to-open gap). Divide by 252 for years, to pair
 * with volatilities annualized over trading days. Holidays aren't modeled.
 */
export function varianceDays(fromMs, toMs) {
  if (!(toMs > fromMs)) return 0;
  let days = 0, t = fromMs;
  for (let guard = 0; guard < 400 && t < toMs; guard++) {
    const open = sessionOpenMs(t), close = open + 390 * 60_000;
    const dow = new Date(open).getUTCDay();
    const weekday = dow >= 1 && dow <= 5;
    if (weekday && t < close) {
      const a = Math.max(t, open), b = Math.min(toMs, close);
      if (b > a) days += 0.8 * (b - a) / (390 * 60_000);
    }
    const nextOpen = sessionOpenMs(open + 24 * 3600_000);
    if (toMs > close && weekday) days += 0.2 * Math.min(1, (Math.min(toMs, nextOpen) - close) / (nextOpen - close));
    t = nextOpen;
  }
  return days;
}

export const MARKET_OPEN  = 9 * 60 + 30;
export const ENTRY_READY  = 9 * 60 + 45;   // after the 15-minute opening range
export const EOD_CLOSE    = 15 * 60 + 45;
export const MARKET_CLOSE = 16 * 60;
