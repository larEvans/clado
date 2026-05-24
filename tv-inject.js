/**
 * TradingView Pine Script Injector via Chrome DevTools Protocol (CDP)
 * Requires Node.js 21+ (built-in WebSocket) and TradingView running with
 * --remote-debugging-port=9222
 *
 * CLI:    node tv-inject.js orb
 *         node tv-inject.js vwap
 * Module: import { injectPineScript } from './tv-inject.js'
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import http from "http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CDP_PORT  = 9222;

const PINE_FILES = {
  orb:              join(__dirname, "pinescript", "orb.pine"),
  vwap:             join(__dirname, "pinescript", "vwap.pine"),
  trend:            join(__dirname, "pinescript", "trend.pine"),
  meanrev:          join(__dirname, "pinescript", "meanrev.pine"),
  momentum:         join(__dirname, "pinescript", "momentum.pine"),
  hybrid:           join(__dirname, "pinescript", "hybrid.pine"),
  "options-overlay": join(__dirname, "pinescript", "options-overlay.pine"),
};

// ─── CDP helpers ─────────────────────────────────────────────────────────────

function cdpGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "localhost", port: CDP_PORT, path }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch { reject(new Error("Bad JSON from CDP")); } });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error("CDP connection timeout — is TradingView running?")); });
  });
}

// Uses Node.js 21+ built-in WebSocket
function cdpEval(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = 1;
    let done = false;

    ws.addEventListener("error", e => { if (!done) { done = true; reject(new Error("CDP WebSocket error: " + (e.message || "connection refused"))); } });
    ws.addEventListener("close", () => { if (!done) { done = true; reject(new Error("CDP WebSocket closed unexpectedly")); } });

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
    });

    ws.addEventListener("message", event => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.id === id) {
          done = true;
          ws.close();
          if (msg.error) { reject(new Error(msg.error.message)); return; }
          resolve(msg.result?.result?.value);
        }
      } catch (e) { /* ignore other events */ }
    });

    setTimeout(() => { if (!done) { done = true; ws.close(); reject(new Error("CDP eval timeout")); } }, 10000);
  });
}

// ─── Main injection ───────────────────────────────────────────────────────────

export async function injectPineScript(strategyId) {
  const pineFile = PINE_FILES[strategyId];
  if (!pineFile || !existsSync(pineFile)) {
    throw new Error(`Pine Script not found for strategy: ${strategyId}`);
  }
  const script = readFileSync(pineFile, "utf8");

  let targets;
  try {
    targets = await cdpGet("/json");
  } catch (e) {
    return { ok: false, error: `Cannot reach TradingView on port ${CDP_PORT}. Launch it via launch.ps1 or with --remote-debugging-port=${CDP_PORT}` };
  }

  const tvTarget = (Array.isArray(targets) ? targets : []).find(t =>
    t.type === "page" &&
    (t.url?.includes("tradingview") || t.title?.toLowerCase().includes("tradingview"))
  );

  if (!tvTarget?.webSocketDebuggerUrl) {
    const pages = (targets||[]).filter(t => t.type === "page").map(t => t.title || t.url).join(", ");
    return { ok: false, error: `No TradingView page found via CDP. Open pages: [${pages||"none"}]` };
  }

  const injectJS = `
(function() {
  var script = ${JSON.stringify(script)};
  if (typeof monaco !== 'undefined') {
    var models = monaco.editor.getModels();
    if (models.length > 0) {
      var m = models.find(function(x){ var l=x.getLanguageId(); return l==='pine'||l==='pine-script'; }) || models[0];
      m.setValue(script);
      return JSON.stringify({ ok: true, message: 'Pine Script injected into editor!' });
    }
  }
  var el = document.querySelector('.monaco-editor');
  if (!el) return JSON.stringify({ ok: false, error: 'Pine Script editor not open. Click the </> icon in TradingView first, then inject again.' });
  return JSON.stringify({ ok: false, error: 'Monaco editor found but could not access instance. Try copying and pasting manually.' });
})()
`;

  try {
    const raw = await cdpEval(tvTarget.webSocketDebuggerUrl, injectJS);
    if (raw) return JSON.parse(raw);
    return { ok: false, error: "No response from TradingView page" };
  } catch (e) {
    return { ok: false, error: "CDP error: " + e.message };
  }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const arg = process.argv[2];
if (arg && PINE_FILES[arg]) {
  injectPineScript(arg).then(r => {
    console.log(r.ok ? `✅ ${r.message}` : `❌ ${r.error}`);
    if (!r.ok) console.log(`\n→ Manual: copy pinescript/${arg}.pine into TradingView's Pine Script editor.`);
  }).catch(e => console.error("Error:", e.message));
} else if (arg) {
  console.log(`Unknown strategy: ${arg}. Available: ${Object.keys(PINE_FILES).join(", ")}`);
}
