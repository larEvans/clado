/**
 * Railway launcher — runs bot-stream.js + dashboard.js as child processes.
 * bot-stream.js owns the AlpacaStream (one connection).
 * dashboard.js skips its own stream (NO_DASHBOARD_STREAM=1).
 * Both processes auto-restart on crash.
 */

import { spawn }            from "child_process";
import { dirname, join }    from "path";
import { fileURLToPath }    from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function spawnProc(script, extraEnv = {}) {
  const child = spawn(process.execPath, [join(__dirname, script)], {
    stdio: "inherit",
    env:   { ...process.env, ...extraEnv },
  });
  child.on("exit", (code) => {
    console.log(`[${script}] exited (${code ?? "signal"}) — restarting in 5s`);
    setTimeout(() => spawnProc(script, extraEnv), 5_000);
  });
}

spawnProc("bot-stream.js");                              // owns the Alpaca WebSocket
spawnProc("dashboard.js", { NO_DASHBOARD_STREAM: "1" }); // HTTP only, no duplicate stream
