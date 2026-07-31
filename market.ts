#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * market.ts  —  Place a Long or Short market order with leverage on Phemex.
 *
 * Usage:
 *   ./market.ts long   [--qty 0.01] [--leverage 100] [--symbol XBRUSDT]
 *   ./market.ts short  [--qty 0.01] [--leverage 100] [--symbol XBRUSDT]
 *
 * Options:
 *   --qty <num>       Contract quantity (default: 0.01)
 *   --leverage <num>  Leverage (default: 100)
 *   --symbol <pair>   Trading pair (default: XBRUSDT)
 *   --dry-run         Show what would be sent without executing
 *   --help, -h        Show this help message
 */

import { base64UrlDecode } from "./src/http-client.js";
import { getArg, hasFlag } from "./src/cli-utils.js";
import { loadCredentialsLocal } from "./src/credentials.js";
import { placeMarketOrder, setLeverageUsdtM } from "./src/place-limit-order.js";

const DEFAULT_SYMBOL = "XBRUSDT";
const DEFAULT_QTY = 0.01;
const DEFAULT_LEVERAGE = 100;

function usage(): never {
  console.log(`
Usage: ./market.ts <long|short> [options]

Place a Long or Short market order with leverage on Phemex (USDT-M).

Positional:
  long|short          Trade direction (required)

Options:
  --qty <num>        Contract quantity (default: ${DEFAULT_QTY})
  --leverage <num>   Leverage (default: ${DEFAULT_LEVERAGE})
  --symbol <pair>    Trading pair (default: ${DEFAULT_SYMBOL})
  --dry-run          Show what would be sent without executing
  --help, -h         Show this help message

Examples:
  ./market.ts long   --qty 0.01 --leverage 100 --symbol XBRUSDT
  ./market.ts short  --qty 0.01 --leverage 100 --symbol XBRUSDT
  ./market.ts short  --symbol XRPUSDT --dry-run
`);
  process.exit(0);
}

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) usage();

  // Parse positional argument: long or short
  const direction = process.argv[2];
  if (direction !== "long" && direction !== "short") {
    console.error("✗  Specify long or short as the first argument");
    usage();
  }

  const symbol = getArg("--symbol") ?? DEFAULT_SYMBOL;
  const qtyRaw = getArg("--qty");
  const leverageRaw = getArg("--leverage");
  const dryRun = hasFlag("--dry-run");

  const qty = qtyRaw ? parseFloat(qtyRaw) : DEFAULT_QTY;
  const leverage = leverageRaw ? parseInt(leverageRaw, 10) : DEFAULT_LEVERAGE;

  if (isNaN(qty) || qty <= 0) {
    console.error("✗  --qty must be a positive number");
    process.exit(1);
  }

  const side = direction === "long" ? "Buy" : "Sell";
  const posSide = direction === "long" ? "Long" : "Short";

  console.log(`⟐  Market ${direction} ${symbol}  qty: ${qty}  leverage: ${leverage}x`);

  if (dryRun) {
    const params = [
      `symbol=${symbol}`,
      `side=${side}`,
      `posSide=${posSide}`,
      `ordType=Market`,
      `orderQtyRq=${qty}`,
    ];
    console.log(`\n  DRY RUN — Would send:\n`);
    console.log(`  PUT /g-orders/create`);
    console.log(`  ${params.join("&")}`);
    console.log();
    process.exit(0);
  }

  const creds = loadCredentialsLocal();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  // Set leverage
  await setLeverageUsdtM(symbol, leverage, posSide, creds.PHEMEX_API_KEY, secretRaw);

  // Place market order
  const result = await placeMarketOrder(
    { account: "usdt-m", symbol, side, price: 0, qty, posSide },
    creds.PHEMEX_API_KEY,
    secretRaw,
  );

  const orderID = result.orderID ?? result.clOrdID ?? "—";
  const ordStatus = result.ordStatus ?? "—";
  const execQty = result.cumQty ?? result.qty ?? qty;
  const avgPrice = result.avgPx ?? result.price ?? "—";

  console.log(`   ✓  Order placed`);
  console.log(`      OrderID:  ${String(orderID)}`);
  console.log(`      Direction: ${direction}`);
  console.log(`      Symbol:   ${symbol}`);
  console.log(`      Filled:   ${String(execQty)}`);
  console.log(`      AvgPrice: ${String(avgPrice)}`);
  console.log(`      Status:   ${String(ordStatus)}`);
}

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
