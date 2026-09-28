# Trading TradingView alerts

TradingView has **no public market-data API**, so the bot keeps streaming prices
from Alpaca (the same exchange prices you see on your charts). What TradingView
adds is **signals**: any alert you create — on a Pine strategy, an indicator, or a
drawing — can POST to the bot, which trades it through the same router, risk
limits, predictor gate and options planner as its built-in strategies.

Alerts run on TradingView's servers, so they keep firing when your PC and the
desktop app are closed.

## Requirements

- A **paid TradingView plan** — webhook alerts aren't available on the free plan.
- **Two-factor authentication** turned on in your TradingView account (TradingView
  requires it for webhooks).
- The symbol must be on your **Alpaca watchlist** — the bot only trades symbols it
  streams.

## 1. Turn it on (Railway)

Add a variable to your service and redeploy:

```
TV_WEBHOOK_SECRET=<a long random string>
```

The bot log should show `[TradingView] alerts ENABLED`. The dashboard's Screener
tab shows your webhook URL and a ready-to-copy message under **📡 TradingView
Alerts**.

## 2. Create the alert (desktop app or web)

1. Open the chart, click **Alert** (clock icon) → pick the condition — for a Pine
   strategy choose the strategy and "Order fills only".
2. **Notifications** tab → tick **Webhook URL** and enter:
   `https://<your-railway-domain>/webhook/tradingview`
3. **Message** — for a Pine *strategy*:

   ```json
   {"secret":"<TV_WEBHOOK_SECRET>","symbol":"{{ticker}}","action":"{{strategy.order.action}}","position":"{{strategy.market_position}}","price":{{close}}}
   ```

   For an *indicator/price* alert, hard-code the action (one alert per action):

   ```json
   {"secret":"<TV_WEBHOOK_SECRET>","symbol":"{{ticker}}","action":"buy","price":{{close}}}
   ```

   `action` is `buy`, `sell`, or `exit`. Optional: `"stop"` and `"target"` prices,
   and `"strategy":"a label"` that shows in the logs and dashboard.

## How the bot uses an alert

- **Entry:** on the next 1-minute bar for that symbol, a fresh `buy`/`sell` alert
  becomes a candidate from the `tradingview` strategy. Entry is the live price;
  stop/target come from the alert if given, else stop = ATR×`TV_STOP_ATR_MULT`
  and target = `TV_RR`× the risk. Each alert trades at most once.
- **Exit:** a position the `tradingview` strategy opened is closed by an `exit`
  alert (or `position: flat`) or by an opposite-direction alert, which then opens
  the reverse side on the next bar. Normal stop/target exits still apply.
- **Expiry:** alerts older than `TV_SIGNAL_MAX_AGE_SEC` (default 300 s) are ignored.
- **Gates that still apply:** market hours (stocks after 9:45 ET), one position per
  symbol, max concurrent positions, the daily loss limit, `CONSENSUS_MIN`,
  `STRICT_ROUTER` (which blocks strategies with no trade history — leave it off
  for new alert strategies), the predictor veto if `PREDICTOR_ENABLED=true`, and
  `OPTIONS_MODE` (the alert trades options when it's on).
- Unlike built-in strategies, TradingView alerts are **not** limited to one trade
  per symbol per day — your TradingView strategy decides.

## Security

The webhook authenticates with `TV_WEBHOOK_SECRET` in the message body (TradingView
can't send custom headers), so it works whether or not `DASHBOARD_TOKEN` is set.
Anyone with the secret can place trades — keep it private, and rotate it if an
alert message is ever shared.
