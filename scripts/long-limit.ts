#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * long-limit.ts  —  Place a Long (Buy) limit order on XTIUSDT at the current
 * mark price with stop-loss.  Fetches the live mark price from Phemex.
 *
 * Thin CLI wrapper around the shared spread-limit-order library.
 *
 * Usage:  ./long-limit.ts [--symbol <symbol>] [--qty <quantity>] [--spread <value>] [--dispersion <value>] [--gap <number>] [--cancel]
 *
 * Options:
 *   --symbol <symbol>    Contract symbol (default: XTIUSDT)
 *   --price <mark|last>  Price source: mark price or last traded price (default: mark)
 *   --qty <quantity>  Contract quantity (default: 0.01)
 *   --spread <value>  Spread count: +N one-sided above, -N one-sided below, N symmetric
 *   --dispersion <value>  Tick spacing multiplier (default: 1.0)
 *   --gap <number>    Add this value to the entry price before applying spread and dispersion
 *   --takeProfit <price|last>  Take-profit trigger price, or 'last' to use the current last traded price
 *   --cancel          Cancel the order immediately after placing (test flow)
 *   --sleep <seconds> Seconds to wait between placing and cancelling (requires --cancel)
 *   --help, -h        Show this help message
 */

import { fetchMarkPrice, fetchLastPrice } from "../src/mark-price.js";
import { getArgValue, resolveCredentials, placeSpreadLimitOrders } from "../src/spread-limit-order.js";

const SYMBOL = "XTIUSDT";
const LEVERAGE = 100;
const PID_FILE = ".long-limit.pid";

function usage(): never {
  console.log(`
Usage: ./long-limit.ts [--symbol <symbol>] [--price <mark|last>] [--qty <quantity>] [--spread <value>] [--dispersion <value>] [--gap <number>] [--cancel] [--sleep <seconds>]

Place a Long (Buy) limit order on ${SYMBOL} at the current mark or last price with stop-loss.
Fetches the live price from Phemex.

Options:
  --symbol <symbol>    Contract symbol (default: ${SYMBOL})
  --price <mark|last>  Price source: mark price or last traded price (default: mark)
  --qty <quantity>      Contract quantity (default: 0.01)
  --spread <value>      Spread count: +N one-sided above, -N one-sided below, N symmetric
  --dispersion <value>  Tick spacing multiplier (default: 1.0)
  --gap <number>        Add this value to the entry price before applying spread and dispersion
  --takeProfit <price|last>  Take-profit trigger price, or 'last' to use the current last traded price
  --cancel              Cancel the order immediately after placing (test flow)
  --sleep <seconds>     Seconds to wait between placing and cancelling (requires --cancel)
  --help, -h            Show this help message

Examples:
  ./long-limit.ts
  ./long-limit.ts --symbol BTCUSDT
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
  ./long-limit.ts --symbol XBRUSDT --spread -16 --dispersion 1 --qty 0.01 --gap -0.0 --cancel --sleep 30
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

  // --takeProfit last resolves to the current last traded price.
  let takeProfit: number | undefined;
  if (takeProfitRaw !== undefined) {
    takeProfit =
      takeProfitRaw.toLowerCase() === "last"
        ? priceSource === "last"
          ? referencePrice
          : await fetchLastPrice(symbol)
        : parseFloat(takeProfitRaw);
    if (takeProfitRaw.toLowerCase() === "last") {
      console.log(`   ⚡  Take-profit set to last price: ${takeProfit}`);
    }
  }

  const result = await placeSpreadLimitOrders({
    symbol,
    side: "Buy",
    posSide: "Long",
    qty: qty !== undefined ? parseFloat(qty) : 0.01,
    spread: spreadRaw,
    dispersion: dispersionRaw !== undefined ? parseFloat(dispersionRaw) : 1.0,
    gap: gapRaw !== undefined ? parseFloat(gapRaw) : 0.0,
    takeProfit,
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
