#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-ask-bid-monitor.ts — watch ask.txt and bid.txt (written once per
 * second by phemex-ticker-24hr.ts) and print the local time, ask, and bid
 * each time either value changes.
 *
 * The files live at the project root (like last.txt / mark.txt), so the
 * monitor works no matter which directory either script is launched from.
 *
 * Usage:
 *   npx tsx phemex-ask-bid-monitor.ts                 # poll every 200ms
 *   npx tsx phemex-ask-bid-monitor.ts --interval 100  # poll every 100ms
 */

import fs from "node:fs";
import { resolve } from "node:path";
import { getArg } from "../src/cli-utils.js";

const POLL_MS = Number(getArg("--interval") ?? 200);

// Value files live at the project root (written by phemex-ticker-24hr.ts).
const ROOT = resolve(__dirname, "..");
const ASK_FILE = resolve(ROOT, "ask.txt");
const BID_FILE = resolve(ROOT, "bid.txt");

/** Read a value file; return null when absent or empty (e.g. mid-write). */
function readValue(file: string): string | null {
  try {
    const v = fs.readFileSync(file, "utf8").trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Local wall-clock time with milliseconds, e.g. 19:17:05.432. */
function tsLocal(): string {
  const d = new Date();
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(
    d.getMilliseconds(),
  ).padStart(3, "0")}`;
}

console.log(
  `⟐  Watching ${ASK_FILE} and ${BID_FILE} (poll ${POLL_MS}ms) — Ctrl-C to stop`,
);

/** Format a value with exactly 2 decimals when numeric, else pass through. */
function fmt2(v: string | null): string {
  if (v == null) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return n.toFixed(2);
}

let lastAsk: string | null = null;
let lastBid: string | null = null;

setInterval(() => {
  const ask = readValue(ASK_FILE);
  const bid = readValue(BID_FILE);

  if (ask === lastAsk && bid === lastBid) return;

  lastAsk = ask;
  lastBid = bid;
  console.log(`[${tsLocal()}] ask=${fmt2(ask)}  bid=${fmt2(bid)}`);
}, POLL_MS);
