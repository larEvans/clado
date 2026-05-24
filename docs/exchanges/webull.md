# Webull Setup Guide

Webull doesn't have an official API key system like crypto exchanges. Instead the bot
authenticates using your regular Webull account credentials via a one-time interactive
login that saves a session token locally.

---

## What you need

- A Webull account (regular account — no developer program needed)
- Your Webull **email**, **password**, and **trading PIN**
- The trading PIN is the 6-digit PIN you set in the Webull app for placing orders

---

## Setup steps

### 1. Add your credentials to `.env`

```
EXCHANGE=webull
WEBULL_EMAIL=your@email.com
WEBULL_PASSWORD=yourpassword
WEBULL_TRADING_PIN=123456
SYMBOL=SPY
TIMEFRAME=1H
PAPER_TRADING=true
```

### 2. Set your symbol

Webull uses standard US equity tickers:

| What you want to trade | Symbol |
|------------------------|--------|
| S&P 500 ETF            | SPY    |
| Nasdaq 100 ETF         | QQQ    |
| Apple                  | AAPL   |
| Tesla                  | TSLA   |
| E-mini S&P 500 futures | /ES    |
| E-mini Nasdaq futures  | /NQ    |

### 3. Run the one-time login

```
node bot.js --webull-login
```

This will:
1. Send a verification code to your Webull email
2. Ask you to enter the code
3. Save a session token to `.webull-token.json`

You only need to do this once. The token lasts ~7 days and the bot uses it automatically.
When it expires, run `--webull-login` again.

### 4. Run the bot

```
node bot.js
```

---

## Notes

- **Market data** comes from Yahoo Finance (free, no auth) — not from Webull
- **VWAP** resets at NYSE open (9:30 AM ET) instead of midnight UTC
- **4H timeframe** is not directly available from Yahoo Finance for stocks — the bot
  fetches 1H candles and aggregates them to 4H automatically
- **Paper trading** is on by default — flip `PAPER_TRADING=false` after validating
- **After-hours trading** is off by default (`outsideRegularTradingHour: false`)

---

## Troubleshooting

**Login fails with "Webull login failed"**
- Double-check email and password
- Make sure you're using your login password, not your trading PIN
- Try logging in on Webull's website to confirm credentials work

**"Ticker ID not found for SPY"**
- Confirm the symbol is exactly right (all caps, no slashes for ETFs)
- For futures: try the Webull symbol format (e.g. `ESM2025` for the June 2025 contract)

**"Could not get Webull trade token"**
- Double-check your WEBULL_TRADING_PIN — it's the 6-digit trading PIN, not your login password
- If you've never set a trading PIN, set one in the Webull app: Me → Security → Trading PIN

**Token expired after a few days**
- Run `node bot.js --webull-login` again — takes 30 seconds
