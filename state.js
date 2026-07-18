/**
 * State-file locations — single place that decides where runtime state
 * (trade history, learned params, bot config/state, logs, trades.csv) lives.
 *
 * Default: the repo directory, same as before. Set DATA_DIR to move state
 * onto persistent storage — e.g. a Railway volume mount — so learning and
 * trade history survive redeploys:
 *
 *   DATA_DIR=/data
 */

import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : __dirname;

try { mkdirSync(DATA_DIR, { recursive: true }); } catch {}

/** Absolute path for a named state file inside DATA_DIR. */
export function dataPath(name) {
  return join(DATA_DIR, name);
}
