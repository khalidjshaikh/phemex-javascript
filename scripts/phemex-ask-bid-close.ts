#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-ask-bid-close.ts — Every second, fetch open USDT-M positions and
 * close them based on the ask.txt / bid.txt values (written once per second
 * by phemex-ticker-24hr.ts):
 *
 *   bid >= entryPrice + profit  → close long   (side "Buy")
 *   ask <= entryPrice - profit  → close short  (side "Sell")
 *
 * profit is the minimum profit per unit before a position is closed
 * (default: 0.10 USDT, configurable with --profit). The ask/bid files live
 * at the project root (like last.txt / mark.txt), so
 * the script works no matter which directory it is launched from.
 *
 * Usage:
 *   npx tsx phemex-ask-bid-close.ts                      # every 1s
 *   npx tsx phemex-ask-bid-close.ts --interval 500       # every 500ms
 *   npx tsx phemex-ask-bid-close.ts --symbol XBRUSDT     # only this symbol
 *   npx tsx phemex-ask-bid-close.ts --profit 0.25        # require 25c profit
 *   npx tsx phemex-ask-bid-close.ts --dry-run            # log only, no orders
 *
 * Options:
 *   --interval <ms>   Polling interval in ms (default: 1000)
 *   --symbol <symbol> Only close positions for this symbol (default: all)
 *   --profit <amt>    Min profit per unit before closing (default: 0.10)
 *   --dry-run         Print what would be closed without placing orders
 *   --help, -h        Show this help message
 */

import fs from "node:fs";
import { resolve } from "node:path";
import { getArg, hasFlag } from "../src/cli-utils.js";
import { base64UrlDecode } from "../src/http-client.js";
import { loadCredentials } from "../src/credentials.js";
import { closePosition, fetchPositions, type Position } from "../src/positions.js";

const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_PROFIT = 0.0; // min profit per unit (USDT) before closing

const rawInterval = Number(getArg("--interval") ?? DEFAULT_INTERVAL_MS);
const INTERVAL_MS = Number.isFinite(rawInterval) && rawInterval > 0 ? rawInterval : DEFAULT_INTERVAL_MS;
const SYMBOL = getArg("--symbol"); // undefined = all symbols
const DRY_RUN = hasFlag("--dry-run");

const rawProfit = Number(getArg("--profit") ?? DEFAULT_PROFIT);
const PROFIT = Number.isFinite(rawProfit) && rawProfit >= 0 ? rawProfit : DEFAULT_PROFIT;

// Value files live at the project root (written by phemex-ticker-24hr.ts).
const ROOT = resolve(__dirname, "..");
const ASK_FILE = resolve(ROOT, "ask.txt");
const BID_FILE = resolve(ROOT, "bid.txt");

function fmtTime(): string {
  return new Date().toLocaleTimeString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read a numeric value file; return null when absent, empty, or non-numeric. */
function readValue(file: string): number | null {
  try {
    const v = fs.readFileSync(file, "utf8").trim();
    if (v.length === 0) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** The position's entry price in USDT (Rp = raw price, already human-readable). */
function entryPrice(pos: Position): number {
  return parseFloat(pos.avgEntryPriceRp || "0");
}

/**
 * Check the ask/bid levels against every open position and market-close the
 * ones that satisfy the exit condition.
 */
const lastLogged = new Map<string, number>();

async function closeQualifying(
  positions: Position[],
  ask: number | null,
  bid: number | null,
  apiKey: string,
  secretRaw: Buffer,
): Promise<void> {
  for (const pos of positions) {
    if (SYMBOL && pos.symbol !== SYMBOL) continue;
    const entry = entryPrice(pos);

    if (pos.side === "Buy" && bid !== null) {
      if (bid >= entry) {
        if (lastLogged.get(pos.symbol) !== bid) {
          console.log(`[${fmtTime()}] ${pos.symbol} long  bid=${bid.toFixed(2)} >= entryPrice=${entry.toFixed(2)}`);
          lastLogged.set(pos.symbol, bid);
        }
      }
      if (bid >= entry + PROFIT) {
        console.log(`[${fmtTime()}]  ⟐  ${pos.symbol} long  bid=${bid.toFixed(2)} >= target=${(entry + PROFIT).toFixed(2)} → close (profit ${(bid - entry).toFixed(2)})`);
        console.log(`[${fmtTime()}] bid >= entryPrice + profit  → close long   (side "Buy")  bid − entryPrice = ${(bid - entry).toFixed(2)}`);
        console.log(`[${fmtTime()}] ${bid.toFixed(2)} >= ${entry.toFixed(2)} + ${PROFIT.toFixed(2)}  → close long   (side "Buy")`);
        if (DRY_RUN) continue;
        await closePosition(pos, apiKey, secretRaw);
      }
    } else if (pos.side === "Sell" && ask !== null) {
      if (ask <= entry) {
        if (lastLogged.get(pos.symbol) !== ask) {
          console.log(`[${fmtTime()}] ${pos.symbol} short  ask=${ask.toFixed(2)} <= entryPrice=${entry.toFixed(2)}`);
          lastLogged.set(pos.symbol, ask);
        }
      }
      if (ask <= entry - PROFIT) {
        console.log(`[${fmtTime()}]  ⟐  ${pos.symbol} short  ask=${ask.toFixed(2)} <= target=${(entry - PROFIT).toFixed(2)} → close (profit ${(entry - ask).toFixed(2)})`);
        console.log(`[${fmtTime()}] ask <= entryPrice - profit  → close short  (side "Sell")  entryPrice − ask = ${(entry - ask).toFixed(2)}`);
        console.log(`[${fmtTime()}] ${ask.toFixed(2)} <= ${entry.toFixed(2)} - ${PROFIT.toFixed(2)}  → close short  (side "Sell")`);
        if (DRY_RUN) continue;
        await closePosition(pos, apiKey, secretRaw);
      }
    }
  }
}

function usage(): never {
  console.log(`
Usage: scripts/phemex-ask-bid-close.ts [options]

Every ${INTERVAL_MS}ms, fetch open USDT-M positions and close them when the
ask/bid levels (ask.txt / bid.txt at the project root) are at least PROFIT
past the entry price:
  bid >= entryPrice + profit  → close long
  ask <= entryPrice - profit  → close short

Options:
  --interval <ms>   Polling interval in ms (default: ${DEFAULT_INTERVAL_MS})
  --symbol <symbol> Only close positions for this symbol (default: all)
  --profit <amt>    Min profit per unit before closing (default: ${DEFAULT_PROFIT.toFixed(2)})
  --dry-run         Print what would be closed without placing orders
  --help, -h        Show this help message

Examples:
  scripts/phemex-ask-bid-close.ts
  scripts/phemex-ask-bid-close.ts --interval 500
  scripts/phemex-ask-bid-close.ts --symbol XBRUSDT --dry-run
  scripts/phemex-ask-bid-close.ts --profit 0.25
`);
  process.exit(0);
}

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) usage();

  const creds = loadCredentials();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  const modeLabel = DRY_RUN ? "DRY-RUN" : "LIVE";
  const detail = `  Poll: every ${INTERVAL_MS}ms   target: ${SYMBOL ?? "all symbols"}   profit: ${PROFIT.toFixed(2)}   mode: ${modeLabel}`;
  console.log(`[${fmtTime()}] ═ Ask/Bid Close ${"═".repeat(Math.max(0, detail.length - 16))}`);
  console.log(`[${fmtTime()}] ${detail}`);
  console.log(`[${fmtTime()}] ${"═".repeat(detail.length)}`);

  process.on("SIGINT", () => {
    console.log(`\n[${fmtTime()}] ⏹  Stopped.`);
    process.exit(0);
  });

  while (true) {
    try {
      const positions = await fetchPositions(creds.PHEMEX_API_KEY, secretRaw);
      if (positions.length === 0) {
        await sleep(INTERVAL_MS);
        continue;
      }
      const ask = readValue(ASK_FILE);
      const bid = readValue(BID_FILE);
      await closeQualifying(positions, ask, bid, creds.PHEMEX_API_KEY, secretRaw);
    } catch (err: unknown) {
      console.error(`[${fmtTime()}] ✗  Cycle failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(INTERVAL_MS);
  }
}

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
