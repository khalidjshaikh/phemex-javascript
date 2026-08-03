#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-ensure-stop-loss.ts — Fetch all open USDT-M positions; for every
 * position that has no stop-loss set (no untriggered `Stop` order), place a
 * stop-market order 1 cent away from the position's entry price:
 * long → Sell stop 1 cent below entry, short → Buy stop 1 cent above entry
 * (a Buy stop must trigger above the market price, or the API rejects it
 * with TE_RISING_TRIGGER_DIRECTLY).
 *
 * The last trade price from last.txt (written by phemex-mark-price2.ts) is
 * shown in the log for reference only; the stop is anchored to the entry
 * price, so a missing/stale last.txt never affects stop placement.
 *
 * Runs forever, checking every 30 seconds, until Ctrl+C.
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
import { calcPnlPct, fetchPositions, setStopLoss } from "../src/positions.js";
import { fetchUntriggeredOrders } from "../src/untriggered-orders.js";

const CREDS_FILE = ".phemex-credentials.json";
const LAST_FILE = resolve(import.meta.dirname, "..", "last.txt");

const CENT = 0.01;
const POLL_MS = 30_000;   // check every 30 seconds

function usage(): never {
  console.log(`
Usage: ./phemex-ensure-stop-loss.ts [options]

Fetch all open USDT-M positions. For each position that has no stop-loss
(no untriggered Stop order), place a stop-market order ${CENT} away from the
position's entry price (long → Sell stop ${CENT} below entry, short → Buy
stop ${CENT} above entry).
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

function fmtNum(n: number, d: number = 2): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read the last trade price from last.txt (project root); null if unavailable. */
function readLastPrice(): number | null {
  try {
    const last = parseFloat(readFileSync(LAST_FILE, "utf8").trim());
    return Number.isFinite(last) && last > 0 ? last : null;
  } catch {
    return null;
  }
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
      const positions = await fetchPositions(creds.PHEMEX_API_KEY, secretRaw);
      const last = readLastPrice();
      const lastTxt = last === null ? "n/a" : last.toFixed(2);
      if (positions.length === 0) {
        console.log(`[${fmtTime()}]   last price: ${lastTxt}  –  No open positions`);
      } else {
        // List every open position with entry price, size, and PnL.
        console.log(`[${fmtTime()}]   last price: ${lastTxt}  –  ${positions.length} open position${positions.length === 1 ? "" : "s"}`);
        for (const pos of positions) {
          const size = parseFloat(pos.size || "0");
          const entry = parseFloat(pos.avgEntryPriceRp || "0");
          const mark = parseFloat(pos.markPriceRp || "0");
          const margin = parseFloat(pos.posCostRv || "0");
          const pnlPct = calcPnlPct(pos);
          const posSide = pos.side === "Buy" ? "Long" : "Short";
          console.log(
            `[${fmtTime()}]   ${pos.symbol}  ${posSide}  ` +
            `size: ${fmtNum(size, 4)}  entry: $${fmtNum(entry)}  mark: $${fmtNum(mark)}  ` +
            `PnL: ${pnlPct >= 0 ? "+" : ""}${fmtNum(pnlPct, 2)}%  margin: $${fmtNum(margin, 4)}`,
          );
        }
      }

      for (const pos of positions) {
        const qty = parseFloat(pos.size || "0");
        const entry = parseFloat(pos.avgEntryPriceRp || "0");
        const posSide = pos.side === "Buy" ? "Long" : "Short";
        const side = pos.side === "Buy" ? "Sell" : "Buy";
        // Buy stops must trigger above the market; Sell stops below.
        const stopPrice = Math.round((entry + (side === "Buy" ? CENT : -CENT)) * 100) / 100;

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
