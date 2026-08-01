#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * short-limit.ts  —  Place a Short (Sell) limit order on XTIUSDT at the
 * current mark price with stop-loss.  Fetches the live mark price from Phemex.
 *
 * Thin CLI wrapper around the shared spread-limit-order library.
 *
 * Usage:  ./short-limit.ts [--symbol <symbol>] [--qty <quantity>] [--spread <value>] [--dispersion <value>] [--gap <number>] [--cancel]
 *
 * Options:
 *   --symbol <symbol>    Contract symbol (default: XTIUSDT)
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

const SYMBOL = "XTIUSDT";
const LEVERAGE = 100;
const PID_FILE = ".short-limit.pid";

function usage(): never {
  console.log(`
Usage: ./short-limit.ts [--symbol <symbol>] [--price <mark|last>] [--qty <quantity>] [--spread <value>] [--dispersion <value>] [--gap <number>] [--cancel] [--sleep <seconds>]

Place a Short (Sell) limit order on ${SYMBOL} at the current mark or last price with stop-loss.
Fetches the live price from Phemex.

Options:
  --symbol <symbol>    Contract symbol (default: ${SYMBOL})
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
  ./short-limit.ts
  ./short-limit.ts --symbol BTCUSDT
  ./short-limit.ts --price last
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
  const takeProfitRaw = getArgValue("--takeProfit");
  const priceRaw = getArgValue("--price");
  if (priceRaw !== undefined && priceRaw !== "mark" && priceRaw !== "last") {
    console.error(`✗ Invalid --price "${priceRaw}" (expected "mark" or "last")`);
    usage();
  }
  const priceSource = priceRaw ?? "mark";

  const symbolRaw = getArgValue("--symbol");
  if (symbolRaw !== undefined && !/^[A-Z0-9]{2,}$/.test(symbolRaw)) {
    console.error(`✗ Invalid --symbol "${symbolRaw}" (expected an uppercase symbol like ${SYMBOL})`);
    usage();
  }
  const symbol = symbolRaw ?? SYMBOL;

  const { apiKey, secretRaw } = resolveCredentials();
  const referencePrice =
    priceSource === "last" ? await fetchLastPrice(symbol) : await fetchMarkPrice(symbol);
  const result = await placeSpreadLimitOrders({
    symbol,
    side: "Sell",
    posSide: "Short",
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
