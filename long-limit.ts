#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * long-limit.ts  —  Place a Long (Buy) limit order on XTIUSDT at the last
 * known price with stop-loss.  Reads latest price from xtiusdt-last-price.txt.
 *
 * Usage:  ./long-limit.ts [--qty <quantity>] [--cancel]
 *
 * Options:
 *   --qty <quantity>  Contract quantity (default: 0.01)
 *   --cancel          Cancel the order immediately after placing (test flow)
 *   --help, -h        Show this help message
 */

import fs from "node:fs";
import { base64UrlDecode } from "./src/http-client.js";
import { loadCredentialsLocal } from "./src/credentials.js";
import { placeLimitOrder, cancelOrder, setLeverageUsdtM } from "./src/place-limit-order.js";

const SYMBOL = "XTIUSDT";
const PRICE_FILE = "xtiusdt-last-price.txt";
const LEVERAGE = 100;

function usage(): never {
  console.log(`
Usage: ./long-limit.ts [--qty <quantity>] [--spread <value>] [--cancel]

Place a Long (Buy) limit order on ${SYMBOL} at the last known price with stop-loss.
Reads the latest price from ${PRICE_FILE}.

Options:
  --qty <quantity>   Contract quantity (default: 0.01)
  --spread <value>   Spread count: +N one-sided above, -N one-sided below, N symmetric
  --cancel           Cancel the order immediately after placing (test flow)
  --help, -h         Show this help message

Examples:
  ./long-limit.ts
  ./long-limit.ts --qty 0.05
  ./long-limit.ts --spread +5
  ./long-limit.ts --spread -3
  ./long-limit.ts --spread 6
  ./long-limit.ts --qty 0.01 --spread 2 --cancel
`);
  process.exit(0);
}

function getArgValue(argName: string): string | undefined {
  const explicitIndex = process.argv.indexOf(argName);
  if (explicitIndex !== -1 && explicitIndex + 1 < process.argv.length) {
    return process.argv[explicitIndex + 1];
  }
  const assignment = process.argv.find((value) => value.startsWith(`${argName}=`));
  return assignment ? assignment.slice(argName.length + 1) : undefined;
}

function parseSpread(raw: string): { value: number; explicitSign: boolean } {
  if (!/^[+-]?\d+$/.test(raw)) {
    throw new Error(`Invalid --spread value: ${raw}`);
  }
  return {
    value: Number(raw),
    explicitSign: raw.startsWith("+") || raw.startsWith("-"),
  };
}

function buildSpreadPrices(referencePrice: number, spread: number, explicitSign: boolean): number[] {
  if (spread === 0) return [referencePrice];

  // One-sided: +N = N ticks above ref (inclusive), -N = N ticks below ref (inclusive)
  if (explicitSign) {
    const orders = [referencePrice];
    if (spread > 0) {
      for (let i = 1; i <= spread; i++) {
        orders.push(+(referencePrice + i * 0.01).toFixed(2));
      }
    } else {
      for (let i = 1; i <= Math.abs(spread); i++) {
        orders.unshift(+(referencePrice - i * 0.01).toFixed(2));
      }
    }
    return orders;
  }

  // Symmetric: N = N ticks below AND N ticks above ref
  // e.g. 2 → [ref-0.02, ref-0.01, ref, ref+0.01, ref+0.02] (5 orders)
  const orders: number[] = [];
  const steps = Math.abs(spread);
  for (let i = steps; i >= 1; i--) {
    orders.push(+(referencePrice - i * 0.01).toFixed(2));
  }
  orders.push(referencePrice);
  for (let i = 1; i <= steps; i++) {
    orders.push(+(referencePrice + i * 0.01).toFixed(2));
  }
  return orders;
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) usage();

  const qty = getArgValue("--qty");
  const QTY = qty !== undefined ? parseFloat(qty) : 0.01;
  const CANCEL_FLAG = process.argv.includes("--cancel");
  const spreadRaw = getArgValue("--spread") ?? "0";

  if (isNaN(QTY) || QTY <= 0) {
    console.error("✗  --qty must be a positive number");
    process.exit(1);
  }

  let spreadValue: number;
  let spreadExplicitSign: boolean;
  try {
    const parsed = parseSpread(spreadRaw);
    spreadValue = parsed.value;
    spreadExplicitSign = parsed.explicitSign;
  } catch (err) {
    console.error(`✗  ${err instanceof Error ? err.message : String(err)}`);
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

  const orderPrices = buildSpreadPrices(lastPrice, spreadValue, spreadExplicitSign);
  console.log(`⟐  Limit Long ${SYMBOL}  qty: ${QTY}  spread: ${spreadRaw}  100x`);

  await setLeverageUsdtM(SYMBOL, LEVERAGE, "Long", creds.PHEMEX_API_KEY, secretRaw);

  for (const orderPrice of orderPrices) {
    const stopLoss = +(orderPrice - 0.01).toFixed(2);
    const result = await placeLimitOrder(
      { account: "usdt-m", symbol: SYMBOL, side: "Buy", price: orderPrice, qty: QTY,
        posSide: "Long", stopLoss },
      creds.PHEMEX_API_KEY,
      secretRaw,
    );

    console.log(`   ✓  Order placed — price: ${orderPrice} — ID: ${result.orderID ?? result.clOrdID ?? "—"}  Status: ${result.ordStatus ?? "—"}`);

    if (CANCEL_FLAG && result.orderID) {
      console.log(`   Cancelling order ${result.orderID} …`);
      await cancelOrder({ symbol: SYMBOL, orderId: result.orderID, posSide: "Long" }, creds.PHEMEX_API_KEY, secretRaw);
      console.log(`   ✓  Order cancelled`);
    }
  }

}

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : String(err));
  process.exit(1);
});