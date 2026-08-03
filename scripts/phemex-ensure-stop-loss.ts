#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-ensure-stop-loss.ts — Fetch all open USDT-M positions; for every
 * position that has no stop-loss set (no untriggered `Stop` order), place a
 * stop-market order 1 cent below the last trade price stored in last.txt.
 *
 * last.txt is written by phemex-mark-price2.ts at the project root and
 * contains the latest trade price (e.g. "75.52"), so the stop is placed
 * at that price minus 0.01.
 *
 * Runs forever, checking every 60 seconds, until Ctrl+C.
 *
 * Usage:
 *   ./phemex-ensure-stop-loss.ts
 *   ./phemex-ensure-stop-loss.ts --dry-run
 *
 * Options:
 *   --dry-run           Log what would be placed without sending orders
 *   --help, -h          Show this help message
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { base64UrlDecode } from "../src/http-client.js";
import { loadCredentialsPath } from "../src/credentials.js";
import { fetchPositions, setStopLoss } from "../src/positions.js";
import { fetchUntriggeredOrders } from "../src/untriggered-orders.js";

const CREDS_FILE = ".phemex-credentials-gmail.json";
const LAST_FILE = resolve(import.meta.dirname, "..", "last.txt");

const CENT = 0.01;
const POLL_MS = 60_000;   // check every 60 seconds

function usage(): never {
  console.log(`
Usage: ./phemex-ensure-stop-loss.ts [options]

Fetch all open USDT-M positions. For each position that has no stop-loss
(no untriggered Stop order), place a stop-market order ${CENT} below the last
price stored in last.txt (long → Sell stop, short → Buy stop).
Checks every ${POLL_MS / 1000} seconds; runs until Ctrl+C.

Options:
  --dry-run           Log what would be placed without sending orders
  --help, -h          Show this help message

Examples:
  ./phemex-ensure-stop-loss.ts
  ./phemex-ensure-stop-loss.ts --dry-run
`);
  process.exit(0);
}

function fmtTime(): string {
  return new Date().toLocaleString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read the last trade price from last.txt (project root). */
function readLastPrice(): number {
  let last: number;
  try {
    last = parseFloat(readFileSync(LAST_FILE, "utf8").trim());
  } catch {
    throw new Error(`could not read ${LAST_FILE} (run phemex-mark-price2.ts first)`);
  }
  if (!Number.isFinite(last) || last <= 0) {
    throw new Error(`${LAST_FILE} does not contain a valid price`);
  }
  return last;
}

/** True if the symbol already has an untriggered Stop (stop-loss) order. */
async function hasStopLoss(
  symbol: string,
  apiKey: string,
  secretRaw: Buffer,
): Promise<boolean> {
  try {
    const orders = await fetchUntriggeredOrders(symbol, apiKey, secretRaw);
    return orders.some((o) => String(o.raw.ordType) === "Stop");
  } catch (err: unknown) {
    console.error(
      `[${fmtTime()}]   ✗  Could not check untriggered orders for ${symbol}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return true; // be safe: don't place a stop we couldn't verify absence of
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) usage();
  const dryRun = process.argv.includes("--dry-run");

  const creds = loadCredentialsPath(CREDS_FILE);
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  process.on("SIGINT", () => {
    console.log(`\n[${fmtTime()}] ⏹  Stopped.`);
    process.exit(0);
  });

  console.log(`[${fmtTime()}] ═ Stop-Loss Ensurer ════════════════════════════════`);
  console.log(`[${fmtTime()}]   mode: ${dryRun ? "DRY-RUN" : "LIVE"}   poll: every ${POLL_MS / 1000}s`);
  console.log(`[${fmtTime()}] ═════════════════════════════════════════════════════`);

  while (true) {
    try {
      const lastPrice = readLastPrice();
      const stopPrice = Math.round((lastPrice - CENT) * 100) / 100;
      console.log(`[${fmtTime()}]   last price: ${lastPrice.toFixed(2)}   stop at: ${stopPrice.toFixed(2)}`);

      const positions = await fetchPositions(creds.PHEMEX_API_KEY, secretRaw);
      if (positions.length === 0) {
        console.log(`[${fmtTime()}]   –  No open positions`);
      }

      for (const pos of positions) {
        const qty = parseFloat(pos.size || "0");
        const posSide = pos.side === "Buy" ? "Long" : "Short";
        const side = pos.side === "Buy" ? "Sell" : "Buy";

        if (await hasStopLoss(pos.symbol, creds.PHEMEX_API_KEY, secretRaw)) {
          console.log(`[${fmtTime()}]   –  ${pos.symbol} ${posSide} — stop-loss already set, skipping`);
          continue;
        }

        console.log(`[${fmtTime()}] ⟐  ${pos.symbol} ${posSide} size ${qty} — no stop-loss, placing ${side} stop @ ${stopPrice.toFixed(2)}`);
        if (dryRun) {
          console.log(`[${fmtTime()}]   ·  DRY-RUN: would place stop-market ${side} ${qty} ${pos.symbol} (posSide ${posSide}) at ${stopPrice.toFixed(2)}`);
          continue;
        }

        try {
          await setStopLoss(pos.symbol, side, posSide, stopPrice, qty, creds.PHEMEX_API_KEY, secretRaw);
          console.log(`[${fmtTime()}]   ✓  Stop-loss placed for ${pos.symbol} at ${stopPrice.toFixed(2)}`);
        } catch (err: unknown) {
          console.error(`[${fmtTime()}]   ✗  Failed to place stop for ${pos.symbol}: ${err instanceof Error ? err.message : String(err)}`);
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
