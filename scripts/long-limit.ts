#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * long-limit.ts  —  Place a Long (Buy) limit order on XBRUSDT at the current
 * mark price with stop-loss.  Fetches the live mark price from Phemex.
 *
 * Thin CLI wrapper around the shared spread-limit-order library.
 *
 * Usage:  ./long-limit.ts [--qty <quantity>] [--spread <value>] [--dispersion <value>] [--gap <number>] [--cancel]
 *
 * Options:
 *   --price <mark|last>  Price source: mark price or last traded price (default: mark)
 *   --qty <quantity>  Contract quantity (default: 0.01)
 *   --spread <value>  Spread count: +N one-sided above, -N one-sided below, N symmetric
 *   --dispersion <value>  Tick spacing multiplier (default: 1.0)
 *   --gap <number>    Add this value to the entry price before applying spread and dispersion
 *   --takeProfit <price>  Optional take-profit trigger price for the order
 *   --cancel          Cancel the order immediately after placing (test flow)
 *   --sleep <seconds> Seconds to wait between placing and cancelling (requires --cancel)
 *   --help, -h        Show this help message
 */

import { fetchMarkPrice, fetchLastPrice } from "../src/mark-price.js";
import { getArgValue, resolveCredentials, placeSpreadLimitOrders } from "../src/spread-limit-order.js";

const SYMBOL = "XBRUSDT";
const LEVERAGE = 100;
const PID_FILE = ".long-limit.pid";

function usage(): never {
  console.log(`
Usage: ./long-limit.ts [--price <mark|last>] [--qty <quantity>] [--spread <value>] [--dispersion <value>] [--gap <number>] [--cancel] [--sleep <seconds>]

Place a Long (Buy) limit order on ${SYMBOL} at the current mark or last price with stop-loss.
Fetches the live price from Phemex.

Options:
  --price <mark|last>  Price source: mark price or last traded price (default: mark)
  --qty <quantity>      Contract quantity (default: 0.01)
  --spread <value>      Spread count: +N one-sided above, -N one-sided below, N symmetric
  --dispersion <value>  Tick spacing multiplier (default: 1.0)
  --gap <number>        Add this value to the entry price before applying spread and dispersion
  --takeProfit <price>  Optional take-profit trigger price for the order
  --cancel              Cancel the order immediately after placing (test flow)
  --sleep <seconds>     Seconds to wait between placing and cancelling (requires --cancel)
  --help, -h            Show this help message

Examples:
  ./long-limit.ts
  ./long-limit.ts --price last
  ./long-limit.ts --qty 0.05
  ./long-limit.ts --spread +5
  ./long-limit.ts --spread -3 --dispersion 2
  ./long-limit.ts --spread 6 --dispersion 2
  ./long-limit.ts --qty 0.01 --spread 2 --cancel
  ./long-limit.ts --qty 0.01 --spread 2 --cancel --sleep 30
  ./long-limit.ts --spread 3 --dispersion 2
  ./long-limit.ts --gap 0.0 --spread 2
  ./long-limit.ts --gap -5 --spread 2
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
  const takeProfitRaw = getArgValue("--takeProfit");
  const priceRaw = getArgValue("--price");
  if (priceRaw !== undefined && priceRaw !== "mark" && priceRaw !== "last") {
    console.error(`✗ Invalid --price "${priceRaw}" (expected "mark" or "last")`);
    usage();
  }
  const priceSource = priceRaw ?? "mark";

  const { apiKey, secretRaw } = resolveCredentials();
  const referencePrice =
    priceSource === "last" ? await fetchLastPrice(SYMBOL) : await fetchMarkPrice(SYMBOL);
  const result = await placeSpreadLimitOrders({
    symbol: SYMBOL,
    side: "Buy",
    posSide: "Long",
    qty: qty !== undefined ? parseFloat(qty) : 0.01,
    spread: spreadRaw,
    dispersion: dispersionRaw !== undefined ? parseFloat(dispersionRaw) : 1.0,
    gap: gapRaw !== undefined ? parseFloat(gapRaw) : 0.0,
    takeProfit: takeProfitRaw !== undefined ? parseFloat(takeProfitRaw) : undefined,
    stopLossOffset: 0.01,
    leverage: LEVERAGE,
    referencePrice,
    pidFile: PID_FILE,
    cancel: CANCEL_FLAG,
    sleepSeconds: sleepRaw !== undefined ? parseFloat(sleepRaw) : 0,
    ignoreFlagErrors: true,
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
