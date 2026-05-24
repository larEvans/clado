/**
 * Alpaca WebSocket 1-minute bar stream (IEX free tier)
 * Node 22 built-in WebSocket — no extra dependencies
 * Emits: 'connected', 'disconnected', 'bar', 'trade', 'error'
 */

import { EventEmitter } from "events";

const WS_URL = "wss://stream.data.alpaca.markets/v2/iex";

export class AlpacaStream extends EventEmitter {
  #ws         = null;
  #symbols    = [];
  #authed     = false;
  #closing    = false;
  #retryDelay = 3000;

  constructor(symbols = ["SPY"]) {
    super();
    this.#symbols = [].concat(symbols);
  }

  connect() {
    this.#closing = false;
    this.#open();
  }

  #open() {
    const ws = new WebSocket(WS_URL);
    this.#ws  = ws;

    ws.addEventListener("open", () => {
      this.#retryDelay = 3000;
      ws.send(JSON.stringify({
        action: "auth",
        key:    process.env.ALPACA_API_KEY,
        secret: process.env.ALPACA_SECRET_KEY,
      }));
    });

    ws.addEventListener("message", ({ data }) => {
      let msgs;
      try { msgs = JSON.parse(data); } catch { return; }
      for (const msg of [].concat(msgs)) {
        switch (msg.T) {
          case "success":
            if (msg.msg === "authenticated") {
              this.#authed = true;
              this.#subscribe();
              this.emit("connected");
            }
            break;
          case "subscription":
            // confirmed subscription — no action needed
            break;
          case "error":
            this.emit("error", new Error(`Alpaca stream: ${msg.msg} (code ${msg.code})`));
            break;
          case "b":
            this.emit("bar", {
              symbol: msg.S,
              time:   new Date(msg.t).getTime(),
              open:   msg.o,
              high:   msg.h,
              low:    msg.l,
              close:  msg.c,
              volume: msg.v,
            });
            break;
          case "t":
            this.emit("trade", {
              symbol: msg.S,
              price:  msg.p,
              size:   msg.s,
              time:   new Date(msg.t).getTime(),
            });
            break;
        }
      }
    });

    ws.addEventListener("close", () => {
      this.#authed = false;
      this.emit("disconnected");
      if (!this.#closing) {
        const delay = this.#retryDelay;
        this.#retryDelay = Math.min(this.#retryDelay * 1.5, 30000);
        console.log(`[Stream] Disconnected — reconnecting in ${(delay / 1000).toFixed(0)}s`);
        setTimeout(() => this.#open(), delay);
      }
    });

    ws.addEventListener("error", () => {
      // close event handles reconnect; nothing more needed here
    });
  }

  #subscribe() {
    if (this.#ws && this.#authed && this.#symbols.length > 0) {
      this.#ws.send(JSON.stringify({
        action: "subscribe",
        bars:   this.#symbols,
        trades: this.#symbols,
      }));
    }
  }

  /** Replace the subscription list at runtime */
  updateSymbols(symbols) {
    this.#symbols = [].concat(symbols);
    this.#subscribe();
  }

  close() {
    this.#closing = true;
    if (this.#ws) this.#ws.close();
  }
}
