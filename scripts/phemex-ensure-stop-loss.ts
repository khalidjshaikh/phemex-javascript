#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-ensure-stop-loss.ts — Fetch all open USDT-M positions; for every
 * position that has no stop-loss set (no untriggered `Stop` order), place a
 * stop-market order at least 1 cent past the safe side of entry/current price:
 * long → Sell stop below entry/current price, short → Buy stop above
 * entry/current price. Phemex rejects already-crossed triggers with errors
 * like TE_FALLING_TRIGGER_DIRECTLY or TE_RISING_TRIGGER_DIRECTLY.
 *
 * The last trade price from last.txt (written by phemex-mark-price2.ts) is
 * shown in the log for reference only. Placement fetches a fresh live last
 * price for the symbol before calculating the trigger.
 *
 * Runs forever, checking every --poll seconds (default 30), until Ctrl+C.
 *
 * Usage:
 *   ./phemex-ensure-stop-loss.ts
 *   ./phemex-ensure-stop-loss.ts --dry-run
 *   ./phemex-ensure-stop-loss.ts --poll 10
 *
 * Options:
 *   --dry-run           Log what would be placed without sending orders
 *   --poll <seconds>    Seconds between checks (default: 30)
 *   --help, -h          Show this help message
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getArg, hasFlag } from "../src/cli-utils.js";
import { base64UrlDecode } from "../src/http-client.js";
import { loadCredentialsPath } from "../src/credentials.js";
import { fetchTickerPrices } from "../src/mark-price.js";
import { calcPnlPct, fetchPositions, setStopLoss } from "../src/positions.js";
import { fetchUntriggeredOrders } from "../src/untriggered-orders.js";

const CREDS_FILE = ".phemex-credentials.json";
const LAST_FILE = resolve(__dirname, "..", "last.txt");

const CENT = 0.01;
const DEFAULT_POLL_MS = 30_000;   // check every 30 seconds (override with --poll)

function usage(): never {
  console.log(`
Usage: ./phemex-ensure-stop-loss.ts [options]

Fetch all open USDT-M positions. For each position that has no stop-loss
(no untriggered Stop order), place a stop-market order at least ${CENT} past
the safe side of entry/current price (long → Sell stop below entry/current
price, short → Buy stop above entry/current price).
Checks every --poll seconds (default ${DEFAULT_POLL_MS / 1000}); runs until Ctrl+C.

Options:
  --dry-run           Log what would be placed without sending orders
  --poll <seconds>    Seconds between checks (default: ${DEFAULT_POLL_MS / 1000})
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

function floorCents(n: number): number {
  return Math.floor((n + Number.EPSILON) * 100) / 100;
}

function ceilCents(n: number): number {
  return Math.ceil((n - Number.EPSILON) * 100) / 100;
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
    return orders.some((o) => o.ordType === "Stop");
  } catch (err: unknown) {
    console.error(
      `[${fmtTime()}]   ✗  Could not check untriggered orders for ${symbol}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return true; // be safe: don't place a stop we couldn't verify absence of
  }
}

async function stopReferencePrices(symbol: string): Promise<{ last: number | null }> {
  try {
    const { lastPrice } = await fetchTickerPrices(symbol);
    return { last: lastPrice };
  } catch (err: unknown) {
    console.error(
      `[${fmtTime()}]   ⚠  Could not fetch live last price for ${symbol}; skipping stop placement: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { last: null };
  }
}

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) usage();
  const dryRun = hasFlag("--dry-run");

  let pollMs = DEFAULT_POLL_MS;
  const pollArg = getArg("--poll");
  if (pollArg !== undefined) {
    const pollSecs = Number(pollArg);
    if (!Number.isFinite(pollSecs) || pollSecs < 1) {
      console.error(`✗  --poll must be a number of seconds ≥ 1, got "${pollArg}"`);
      process.exit(1);
    }
    pollMs = Math.round(pollSecs * 1000);
  }

  const creds = loadCredentialsPath(CREDS_FILE);
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  process.on("SIGINT", () => {
    console.log(`\n[${fmtTime()}] ⏹  Stopped.`);
    process.exit(0);
  });

  console.log(`[${fmtTime()}] ═ Stop-Loss Ensurer ════════════════════════════════`);
  console.log(`[${fmtTime()}]   mode: ${dryRun ? "DRY-RUN" : "LIVE"}   poll: every ${pollMs / 1000}s`);
  console.log(`[${fmtTime()}] ═════════════════════════════════════════════════════`);

  while (true) {
    try {
      const positions = await fetchPositions(creds.PHEMEX_API_KEY, secretRaw);
      // console.dir(positions, { depth: null, colors: true });
      // console.log(positions)
      // console.dir(positions)
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
          const liq = parseFloat(pos.liqPriceRp || "0");
          const margin = parseFloat(pos.posCostRv || "0");
          const pnlPct = calcPnlPct(pos);
          const posSide = pos.side === "Buy" ? "Long" : "Short";
          const liqTxt = liq > 0 ? `liq: $${fmtNum(liq)}  ` : "";
          console.log(
            `[${fmtTime()}]   ${pos.symbol}  ${posSide}  ` +
            `size: ${fmtNum(size, 4)}  entry: $${fmtNum(entry)}  mark: $${fmtNum(mark)}  ` +
            `${liqTxt}PnL: ${pnlPct >= 0 ? "+" : ""}${fmtNum(pnlPct, 2)}%  margin: $${fmtNum(margin, 4)}`,
          );
        }
      }

      for (const pos of positions) {
        const qty = parseFloat(pos.size || "0");
        const entry = parseFloat(pos.avgEntryPriceRp || "0");
        const mark = parseFloat(pos.markPriceRp || "0");
        const posSide = pos.side === "Buy" ? "Long" : "Short";
        const side = pos.side === "Buy" ? "Sell" : "Buy";

        if (await hasStopLoss(pos.symbol, creds.PHEMEX_API_KEY, secretRaw)) {
          console.log(`[${fmtTime()}]   –  ${pos.symbol} ${posSide} — stop-loss already set, skipping`);
          continue;
        }

        const { last: liveLast } = await stopReferencePrices(pos.symbol);
        if (liveLast === null || liveLast <= 0) {
          continue;
        }

        const refs = [entry];
        if (mark > 0) refs.push(mark);
        refs.push(liveLast);

        // ByLastPrice stops are rejected if the trigger is already crossed.
        // Keep Sell stops below every current reference; Buy stops above them.
        const stopPrice = side === "Buy"
          ? ceilCents(Math.max(...refs) + CENT)
          : floorCents(Math.min(...refs) - CENT);
        const liveLastTxt = liveLast === null ? "n/a" : liveLast.toFixed(2);

        console.log(`[${fmtTime()}] ⟐  ${pos.symbol} ${posSide} size ${qty} — no stop-loss, placing ${side} stop @ ${stopPrice.toFixed(2)} (entry ${entry.toFixed(2)}, mark ${mark.toFixed(2)}, live last ${liveLastTxt})`);
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

    await sleep(pollMs);
  }
}

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
