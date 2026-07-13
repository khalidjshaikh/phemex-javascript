#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * short-limit.ts  —  Place a Short (Sell) limit order on XTIUSDT at the last
 * known price with stop-loss.  Reads latest price from xtiusdt-last-price.txt.
 *
 * Usage:  ./short-limit.ts [--qty <quantity>] [--spread <value>] [--cancel]
 *
 * Options:
 *   --qty <quantity>  Contract quantity (default: 0.01)
 *   --spread <value>  Spread count: +N one-sided above, -N one-sided below, N symmetric
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
const SIDE = "Sell" as const;
const POS_SIDE = "Short" as const;

function usage(): never {
  console.log(`
Usage: ./short-limit.ts [--qty <quantity>] [--spread <value>] [--cancel]

Place a Short (Sell) limit order on ${SYMBOL} at the last known price with stop-loss.
Reads the latest price from ${PRICE_FILE}.

Options:
  --qty <quantity>   Contract quantity (default: 0.01)
  --spread <value>   Spread count: +N one-sided above, -N one-sided below, N symmetric
  --cancel           Cancel the order immediately after placing (test flow)
  --help, -h         Show this help message

Examples:
  ./short-limit.ts
  ./short-limit.ts --qty 0.05
  ./short-limit.ts --spread +5
  ./short-limit.ts --spread -3
  ./short-limit.ts --spread 6
  ./short-limit.ts --qty 0.01 --spread 2 --cancel
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
  console.log(`⟐  Limit Short ${SYMBOL}  qty: ${QTY}  spread: ${spreadRaw}  100x`);

  await setLeverageUsdtM(SYMBOL, LEVERAGE, POS_SIDE, creds.PHEMEX_API_KEY, secretRaw);

  const placedOrders: Array<{ orderPrice: number; orderId?: string }> = [];
  let hasFailures = false;

  for (const orderPrice of orderPrices) {
    // Short: stop-loss is above entry (price going up = loss for short)
    const stopLoss = +(orderPrice + 0.01).toFixed(2);
    try {
      const result = await placeLimitOrder(
        { account: "usdt-m", symbol: SYMBOL, side: SIDE, price: orderPrice, qty: QTY,
          posSide: POS_SIDE, stopLoss },
        creds.PHEMEX_API_KEY,
        secretRaw,
      );

      const orderId = result.orderID ?? undefined;
      placedOrders.push({ orderPrice, orderId });
      console.log(`   ✓  Order placed — price: ${orderPrice} — ID: ${orderId ?? result.clOrdID ?? "—"}  Status: ${result.ordStatus ?? "—"}`);
    } catch (err) {
      hasFailures = true;
      console.error(`   ✗  Order failed at price ${orderPrice} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (CANCEL_FLAG) {
    for (const placedOrder of placedOrders) {
      if (!placedOrder.orderId) {
        console.warn(`   ⚠  Skipping cancel for order at price ${placedOrder.orderPrice} because no orderID was returned.`);
        continue;
      }
      console.log(`   Cancelling order ${placedOrder.orderId} …`);
      await cancelOrder({ symbol: SYMBOL, orderId: placedOrder.orderId, posSide: POS_SIDE }, creds.PHEMEX_API_KEY, secretRaw);
      console.log(`   ✓  Order cancelled`);
    }
  }

  if (hasFailures) process.exit(1);

}

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
