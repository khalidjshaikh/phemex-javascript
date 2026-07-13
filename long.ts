#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * long.ts  —  Place a Long (Buy) market order on XTIUSDT with stop-loss.
 * Reads the latest price from xtiusdt-last-price.txt.
 *
 * Usage:  ./long.ts [--qty <quantity>] [--cancel]
 *
 * Options:
 *   --qty <quantity>  Contract quantity (default: 0.01)
 *   --cancel          Cancel the order immediately after placing (test flow)
 *   --help, -h        Show this help message
 */

import fs from "node:fs";
import { base64UrlDecode } from "./src/http-client.js";
import { loadCredentialsLocal } from "./src/credentials.js";
import { placeMarketOrder, cancelOrder, setLeverageUsdtM } from "./src/place-limit-order.js";

const SYMBOL = "XTIUSDT";
const PRICE_FILE = "xtiusdt-last-price.txt";
const LEVERAGE = 100;

function usage(): never {
  console.log(`
Usage: ./long.ts [--qty <quantity>] [--cancel]

Place a Long (Buy) market order on ${SYMBOL} with stop-loss.
Reads the latest price from ${PRICE_FILE}.

Options:
  --qty <quantity>  Contract quantity (default: 0.01)
  --cancel          Cancel the order immediately after placing (test flow)
  --help, -h        Show this help message

Examples:
  ./long.ts
  ./long.ts --qty 0.05
  ./long.ts --qty 0.01 --cancel
`);
  process.exit(0);
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) usage();

  const qtyIdx = process.argv.indexOf("--qty");
  const QTY = qtyIdx !== -1 ? parseFloat(process.argv[qtyIdx + 1]) : 0.01;
  const CANCEL_FLAG = process.argv.includes("--cancel");

  if (isNaN(QTY) || QTY <= 0) {
    console.error("✗  --qty must be a positive number");
    process.exit(1);
  }

  const priceRaw = fs.readFileSync(PRICE_FILE, "utf8").trim();
  const lastPrice = parseFloat(priceRaw);
  if (isNaN(lastPrice)) {
    console.error(`✗  Invalid price in ${PRICE_FILE}: "${priceRaw}"`);
    process.exit(1);
  }

  const creds = loadCredentialsLocal();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  const stopLoss = +(lastPrice - 0.03).toFixed(2);

  console.log(`⟐  Long ${SYMBOL}  qty: ${QTY}  @ ~${lastPrice}  SL: ${stopLoss}  100x`);

  await setLeverageUsdtM(SYMBOL, LEVERAGE, "Long", creds.PHEMEX_API_KEY, secretRaw);

  const result = await placeMarketOrder(
    { account: "usdt-m", symbol: SYMBOL, side: "Buy", price: 0, qty: QTY, posSide: "Long", stopLoss },
    creds.PHEMEX_API_KEY,
    secretRaw,
  );

  console.log(`   ✓  Order placed — ID: ${result.orderID ?? result.clOrdID ?? "—"}  Status: ${result.ordStatus ?? "—"}`);

  if (CANCEL_FLAG && result.orderID) {
    console.log(`   Cancelling order ${result.orderID} …`);
    await cancelOrder({ symbol: SYMBOL, orderId: result.orderID, posSide: "Long" }, creds.PHEMEX_API_KEY, secretRaw);
    console.log(`   ✓  Order cancelled`);
  }
}

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : String(err));
  process.exit(1);
});