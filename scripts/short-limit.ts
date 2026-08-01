#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * short-limit.ts  —  Place a Short (Sell) limit order on XTIUSDT at the
 * current mark price with stop-loss.  Fetches the live mark price from Phemex.
 *
 * Thin CLI wrapper around the shared spread-limit-order library.
 *
 * Usage:  ./short-limit.ts [--qty <quantity>] [--spread <value>] [--dispersion <value>] [--gap <number>] [--cancel]
 *
 * Options:
 *   --qty <quantity>  Contract quantity (default: 0.01)
 *   --spread <value>  Spread count: +N one-sided above, -N one-sided below, N symmetric
 *   --dispersion <value>  Tick spacing multiplier (default: 1.0)
 *   --gap <number>    Add this value to the entry price before applying spread and dispersion
 *   --cancel          Cancel the order immediately after placing (test flow)
 *   --sleep <seconds> Seconds to wait between placing and cancelling (requires --cancel)
 *   --help, -h        Show this help message
 */

import { fetchMarkPrice } from "../src/mark-price.js";
import { getArgValue, resolveCredentials, placeSpreadLimitOrders } from "../src/spread-limit-order.js";

const SYMBOL = "XTIUSDT";
const LEVERAGE = 100;
const PID_FILE = ".short-limit.pid";

function usage(): never {
  console.log(`
Usage: ./short-limit.ts [--qty <quantity>] [--spread <value>] [--dispersion <value>] [--gap <number>] [--cancel] [--sleep <seconds>]

Place a Short (Sell) limit order on ${SYMBOL} at the current mark price with stop-loss.
Fetches the live mark price from Phemex.

Options:
  --qty <quantity>      Contract quantity (default: 0.01)
  --spread <value>      Spread count: +N one-sided above, -N one-sided below, N symmetric
  --dispersion <value>  Tick spacing multiplier (default: 1.0)
  --gap <number>        Add this value to the entry price before applying spread and dispersion
  --cancel              Cancel the order immediately after placing (test flow)
  --sleep <seconds>     Seconds to wait between placing and cancelling (requires --cancel)
  --help, -h            Show this help message

Examples:
  ./short-limit.ts
  ./short-limit.ts --qty 0.05
  ./short-limit.ts --spread +5
  ./short-limit.ts --spread -3 --dispersion 2
  ./short-limit.ts --spread 6 --dispersion 2
  ./short-limit.ts --qty 0.01 --spread 2 --cancel
  ./short-limit.ts --qty 0.01 --spread 2 --cancel --sleep 30
  ./short-limit.ts --spread 3 --dispersion 2
  ./short-limit.ts --gap 0.0 --spread 2
  ./short-limit.ts --gap -5 --spread 2
`);
  process.exit(0);
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) usage();

  const qty = getArgValue("--qty");
  const CANCEL_FLAG = process.argv.includes("--cancel");
  const sleepRaw = getArgValue("--sleep");
  const spreadRaw = getArgValue("--spread") ?? "0";
  const dispersionRaw = getArgValue("--dispersion");
  const gapRaw = getArgValue("--gap");

  const { apiKey, secretRaw } = resolveCredentials();
  const referencePrice = await fetchMarkPrice(SYMBOL);
  const result = await placeSpreadLimitOrders({
    symbol: SYMBOL,
    side: "Sell",
    posSide: "Short",
    qty: qty !== undefined ? parseFloat(qty) : 0.01,
    spread: spreadRaw,
    dispersion: dispersionRaw !== undefined ? parseFloat(dispersionRaw) : 1.0,
    gap: gapRaw !== undefined ? parseFloat(gapRaw) : 0.0,
    stopLossOffset: 0.01,
    leverage: LEVERAGE,
    referencePrice,
    pidFile: PID_FILE,
    cancel: CANCEL_FLAG,
    sleepSeconds: sleepRaw !== undefined ? parseFloat(sleepRaw) : 0,
    apiKey,
    secretRaw,
  });

  if (result.hasFailures || result.cancelFailed) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
