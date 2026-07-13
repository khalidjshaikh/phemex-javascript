#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * long-limit.ts  —  Place a Long (Buy) limit order on XTIUSDT at the last
 * known price with stop-loss.  Reads latest price from xtiusdt-last-price.txt.
 *
 * Usage:  ./long-limit.ts [qty]
 *         (default qty: 0.01)
 */

import fs from "node:fs";
import { base64UrlDecode } from "./src/http-client.js";
import { loadCredentialsLocal } from "./src/credentials.js";
import { placeLimitOrder, setLeverageUsdtM } from "./src/place-limit-order.js";

const SYMBOL = "XTIUSDT";
const PRICE_FILE = "xtiusdt-last-price.txt";
const QTY = parseFloat(process.argv[2] ?? "0.01");
const LEVERAGE = 100;

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
  const stopLoss = +(lastPrice - 0.03).toFixed(2);

  console.log(`⟐  Limit Long ${SYMBOL}  qty: ${QTY}  @ ${limitPrice}  SL: ${stopLoss}  100x`);

  await setLeverageUsdtM(SYMBOL, LEVERAGE, "Long", creds.PHEMEX_API_KEY, secretRaw);

  const result = await placeLimitOrder(
    { account: "usdt-m", symbol: SYMBOL, side: "Buy", price: limitPrice, qty: QTY,
      posSide: "Long", stopLoss },
    creds.PHEMEX_API_KEY,
    secretRaw,
  );

  console.log(`   ✓  OrderID: ${result.orderID ?? result.clOrdID ?? "—"}  Status: ${result.ordStatus ?? "—"}`);
}

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : String(err));
  process.exit(1);
});