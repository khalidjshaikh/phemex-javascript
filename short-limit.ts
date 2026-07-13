#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * short-limit.ts  —  Place a Short (Sell) limit order on XTIUSDT at the last
 * known price with stop-loss.  Reads latest price from xtiusdt-last-price.txt.
 *
 * Usage:  ./short-limit.ts [qty]
 *         (default qty: 0.01)
 */

import fs from "node:fs";
import { base64UrlDecode } from "./src/http-client.js";
import { loadCredentialsLocal } from "./src/credentials.js";
import { placeLimitOrder, cancelOrder, setLeverageUsdtM } from "./src/place-limit-order.js";

const SYMBOL = "XTIUSDT";
const PRICE_FILE = "xtiusdt-last-price.txt";
const QTY = parseFloat(process.argv[2] ?? "0.01");
const LEVERAGE = 100;
const CANCEL_FLAG = process.argv.includes("--cancel");

async function main(): Promise<void> {
  const priceRaw = fs.readFileSync(PRICE_FILE, "utf8").trim();
  const lastPrice = parseFloat(priceRaw);
  if (isNaN(lastPrice)) {
    console.error(`✗  Invalid price in ${PRICE_FILE}: "${priceRaw}"`);
    process.exit(1);
  }

  const creds = loadCredentialsLocal();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  const limitPrice = lastPrice;
  const stopLoss = +(lastPrice + 0.03).toFixed(2);

  console.log(`⟐  Limit Short ${SYMBOL}  qty: ${QTY}  @ ${limitPrice}  SL: ${stopLoss}  100x`);

  await setLeverageUsdtM(SYMBOL, LEVERAGE, "Short", creds.PHEMEX_API_KEY, secretRaw);

  const result = await placeLimitOrder(
    { account: "usdt-m", symbol: SYMBOL, side: "Sell", price: limitPrice, qty: QTY,
      posSide: "Short", stopLoss },
    creds.PHEMEX_API_KEY,
    secretRaw,
  );

  console.log(`   ✓  Order placed — ID: ${result.orderID ?? result.clOrdID ?? "—"}  Status: ${result.ordStatus ?? "—"}`);

  if (CANCEL_FLAG && result.orderID) {
    console.log(`   Cancelling order ${result.orderID} …`);
    await cancelOrder({ symbol: SYMBOL, orderId: result.orderID, posSide: "Short" }, creds.PHEMEX_API_KEY, secretRaw);
    console.log(`   ✓  Order cancelled`);
  }
}

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : String(err));
  process.exit(1);
});