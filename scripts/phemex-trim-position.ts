#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-trim-position.ts — Monitor an open position every 60 seconds and,
 * if its size exceeds 0.01 contracts, reduce it back to 0.01 by placing a
 * market order for the excess (long → sell excess, short → buy excess).
 *
 * Trimming is gated on the sign of markLast.txt (project root): Longs are
 * trimmed only while it is negative, Shorts only while it is positive.
 * While the sign does not match (or the file is unreadable) the trim is skipped.
 * All open sides are checked every cycle, so in Phemex hedge mode a Long and
 * a Short on the same symbol are both trimmed independently.
 *
 * Runs forever until Ctrl+C.
 *
 * Usage:
 *   ./phemex-trim-position.ts
 *   ./phemex-trim-position.ts --symbol XBRUSDT
 *   ./phemex-trim-position.ts --dry-run
 *
 * Options:
 *   --symbol <symbol>   Symbol to monitor (default: XBRUSDT)
 *   --dry-run           Log what would be trimmed without placing orders
 *   --help, -h          Show this help message
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { base64UrlDecode } from "../src/http-client.js";
import { loadCredentialsPath } from "../src/credentials.js";
import { placeMarketOrder } from "../src/place-limit-order.js";
import { fetchPositions, type Position } from "../src/positions.js";

const CREDS_FILE = ".phemex-credentials.json";

// markLast.txt lives at the project root (written by phemex-mark-price2.ts)
const MARK_FILE = resolve(__dirname, "..", "markLast.txt");

// Constants
const SYMBOL = "XBRUSDT";
const TARGET_SIZE = 0.01; // keep the position at this size
const POLL_MS = 60_000;   // check every 60 seconds

function usage(): never {
  console.log(`
Usage: ./phemex-trim-position.ts [options]

Monitor an open position every ${POLL_MS / 1000} seconds. If its size exceeds
${TARGET_SIZE} contracts, place a market order to trim it back to ${TARGET_SIZE}
(long → sell the excess, short → buy the excess). Trimming is gated on the
sign of markLast.txt (project root): Longs only while it is negative, Shorts
only while it is positive; otherwise the trim is skipped. All open sides are
handled each cycle (hedge mode Long + Short). Runs until Ctrl+C.

Options:
  --symbol <symbol>   Symbol to monitor (default: ${SYMBOL})
  --dry-run           Log what would be trimmed without placing orders
  --help, -h          Show this help message

Examples:
  ./phemex-trim-position.ts
  ./phemex-trim-position.ts --symbol XBRUSDT --dry-run
`);
  process.exit(0);
}

function fmtTime(): string {
  return new Date().toLocaleString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read markLast.txt from the project root; NaN if missing/unreadable. */
function readMarkLast(): number {
  try {
    return parseFloat(readFileSync(MARK_FILE, "utf8"));
  } catch {
    return NaN;
  }
}

/**
 * Trim a single open position back to TARGET_SIZE if it is larger.
 * Longs trim only while markLast < 0; Shorts only while markLast > 0.
 */
async function trimPosition(
  pos: Position,
  markLast: number,
  symbol: string,
  dryRun: boolean,
  apiKey: string,
  secretRaw: Buffer,
): Promise<void> {
  const size = parseFloat(pos.size || "0");
  const side = pos.side === "Buy" ? "Long" : "Short";
  const trimAllowed = pos.side === "Buy" ? markLast < 0 : markLast > 0;

  if (!(size > TARGET_SIZE)) {
    console.log(`[${fmtTime()}]   –  ${symbol} ${side} size ${size} ≤ ${TARGET_SIZE} — no action`);
    return;
  }
  if (!trimAllowed) {
    const cur = Number.isNaN(markLast) ? "n/a" : String(markLast);
    const need = pos.side === "Buy" ? "negative" : "positive";
    console.log(`[${fmtTime()}]   –  ${symbol} ${side} size ${size} > ${TARGET_SIZE} — skipping trim: markLast=${cur} not ${need}`);
    return;
  }

  const excess = Math.round((size - TARGET_SIZE) * 10_000) / 10_000;
  const closeSide = pos.side === "Buy" ? "Sell" : "Buy";
  const closePosSide = pos.side === "Buy" ? "Long" : "Short";
  console.log(`[${fmtTime()}] ⟐  ${symbol} ${side} size ${size} > ${TARGET_SIZE} — trimming ${excess} (${closeSide})`);
  if (dryRun) {
    console.log(`[${fmtTime()}]   ·  DRY-RUN: would place market ${closeSide} ${excess} ${symbol} (posSide ${closePosSide})`);
    return;
  }
  const result = await placeMarketOrder(
    { account: "usdt-m", symbol, side: closeSide, price: 0, qty: excess, posSide: closePosSide },
    apiKey,
    secretRaw,
  );
  console.log(
    `[${fmtTime()}]   ✓  Trim order placed — orderID: ${result.orderID ?? result.clOrdID ?? "—"}  status: ${result.ordStatus ?? "—"}`,
  );
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) usage();
  const dryRun = process.argv.includes("--dry-run");

  const symbolArg = process.argv.indexOf("--symbol");
  const symbol = symbolArg >= 0 ? process.argv[symbolArg + 1] : SYMBOL;

  const creds = loadCredentialsPath(CREDS_FILE);
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  console.log(`[${fmtTime()}] ═ ${symbol} Position Trimmer ═════════════════════════`);
  console.log(`[${fmtTime()}]   Target size: ${TARGET_SIZE}   poll: every ${POLL_MS / 1000}s   mode: ${dryRun ? "DRY-RUN" : "LIVE"}`);
  console.log(`[${fmtTime()}] ═════════════════════════════════════════════════════`);

  process.on("SIGINT", () => {
    console.log(`\n[${fmtTime()}] ⏹  Stopped.`);
    process.exit(0);
  });

  while (true) {
    try {
      const positions = await fetchPositions(creds.PHEMEX_API_KEY, secretRaw);
      const open = positions.filter((p) => p.symbol === symbol);
      const markLast = readMarkLast();

      if (open.length === 0) {
        console.log(`[${fmtTime()}]   –  No open ${symbol} position — nothing to trim`);
      } else {
        for (const pos of open) {
          await trimPosition(pos, markLast, symbol, dryRun, creds.PHEMEX_API_KEY, secretRaw);
        }
      }
    } catch (err: unknown) {
      console.error(`[${fmtTime()}] ✗  Check failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    await sleep(POLL_MS);
  }
}

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
