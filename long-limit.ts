#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * long-limit.ts  —  Place a Long (Buy) limit order on XTIUSDT at the last
 * known price with stop-loss.  Reads latest price from xtiusdt-last-price.txt.
 *
 * Usage:  ./long-limit.ts [--qty <quantity>] [--spread <value>] [--dispersion <value>] [--gap <number>] [--cancel]
 *
 * Options:
 *   --qty <quantity>  Contract quantity (default: 0.01)
 *   --spread <value>  Spread count: +N one-sided above, -N one-sided below, N symmetric
 *   --dispersion <value>  Tick spacing multiplier (default: 1.0)
 *   --gap <number>    Add this value to the entry price before applying spread and dispersion
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
const PID_FILE = ".long-limit.pid";

function usage(): never {
  console.log(`
Usage: ./long-limit.ts [--qty <quantity>] [--spread <value>] [--dispersion <value>] [--gap <number>] [--cancel] [--sleep <seconds>]

Place a Long (Buy) limit order on ${SYMBOL} at the last known price with stop-loss.
Reads the latest price from ${PRICE_FILE}.

Options:
  --qty <quantity>      Contract quantity (default: 0.01)
  --spread <value>      Spread count: +N one-sided above, -N one-sided below, N symmetric
  --dispersion <value>  Tick spacing multiplier (default: 1.0)
  --gap <number>        Add this value to the entry price before applying spread and dispersion
  --cancel              Cancel the order immediately after placing (test flow)
  --sleep <seconds>     Seconds to wait between placing and cancelling (requires --cancel)
  --help, -h            Show this help message

Examples:
  ./long-limit.ts
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

function buildSpreadPrices(referencePrice: number, spread: number, explicitSign: boolean, dispersion: number): number[] {
  if (spread === 0) return [referencePrice];
  const tick = 0.01 * dispersion;

  // One-sided: +N = N ticks above ref (inclusive), -N = N ticks below ref (inclusive)
  if (explicitSign) {
    const orders = [referencePrice];
    if (spread > 0) {
      for (let i = 1; i <= spread; i++) {
        orders.push(+(referencePrice + i * tick).toFixed(2));
      }
    } else {
      for (let i = 1; i <= Math.abs(spread); i++) {
        orders.unshift(+(referencePrice - i * tick).toFixed(2));
      }
    }
    return orders;
  }

  // Symmetric: N = N ticks below AND N ticks above ref
  // e.g. 2 → [ref-0.02, ref-0.01, ref, ref+0.01, ref+0.02] (5 orders)
  const orders: number[] = [];
  const steps = Math.abs(spread);
  for (let i = steps; i >= 1; i--) {
    orders.push(+(referencePrice - i * tick).toFixed(2));
  }
  orders.push(referencePrice);
  for (let i = 1; i <= steps; i++) {
    orders.push(+(referencePrice + i * tick).toFixed(2));
  }
  return orders;
}

function createSleep(seconds: number): { promise: Promise<void>; cancel: () => void } {
  let timeoutId: NodeJS.Timeout;
  let rejectFn: (reason?: unknown) => void = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    rejectFn = reject;
    timeoutId = setTimeout(resolve, seconds * 1000);
  });

  return {
    promise,
    cancel: () => {
      clearTimeout(timeoutId);
      rejectFn(new Error("Sleep cancelled"));
    },
  };
}

function registerPidFile(): void {
  fs.writeFileSync(PID_FILE, String(process.pid), "utf8");
}

function unregisterPidFile(): void {
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    // Ignore if the file was already removed.
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) usage();

  const qty = getArgValue("--qty");
  const QTY = qty !== undefined ? parseFloat(qty) : 0.01;
  const CANCEL_FLAG = process.argv.includes("--cancel");
  const sleepRaw = getArgValue("--sleep");
  const SLEEP_SECONDS = sleepRaw !== undefined ? parseFloat(sleepRaw) : 0;
  const spreadRaw = getArgValue("--spread") ?? "0";
  const dispersionRaw = getArgValue("--dispersion");
  const DISPERSION = dispersionRaw !== undefined ? parseFloat(dispersionRaw) : 1.0;
  const gapRaw = getArgValue("--gap");
  const GAP = gapRaw !== undefined ? parseFloat(gapRaw) : 0.0;

  if (isNaN(QTY) || QTY <= 0) {
    console.error("✗  --qty must be a positive number");
    process.exit(1);
  }

  if (isNaN(DISPERSION) || DISPERSION <= 0) {
    console.error("✗  --dispersion must be a positive number");
    process.exit(1);
  }

  if (isNaN(GAP)) {
    console.error("✗  --gap must be a number");
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

  process.once("exit", unregisterPidFile);
  registerPidFile();

  const adjustedReferencePrice = lastPrice + GAP;
  const orderPrices = buildSpreadPrices(adjustedReferencePrice, spreadValue, spreadExplicitSign, DISPERSION);
  console.log(`⟐  Limit Long ${SYMBOL}  qty: ${QTY}  spread: ${spreadRaw}  dispersion: ${DISPERSION}  gap: ${GAP}  100x`);

  await setLeverageUsdtM(SYMBOL, LEVERAGE, "Long", creds.PHEMEX_API_KEY, secretRaw);

  const placeOrderPromises = orderPrices.map(async (orderPrice) => {
    const stopLoss = +(orderPrice - 0.01).toFixed(2);
    try {
      const result = await placeLimitOrder(
        { account: "usdt-m", symbol: SYMBOL, side: "Buy", price: orderPrice, qty: QTY,
          posSide: "Long", stopLoss },
        creds.PHEMEX_API_KEY,
        secretRaw,
      );

      const orderId = result.orderID ?? undefined;
      console.log(`   ✓  Order placed — price: ${orderPrice} — ID: ${orderId ?? result.clOrdID ?? "—"}  Status: ${result.ordStatus ?? "—"}`);
      return { orderPrice, orderId, error: undefined as Error | undefined };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`   ✗  Order failed at price ${orderPrice} — ${error.message}`);
      return { orderPrice, orderId: undefined, error };
    }
  });

  const placedOrders = await Promise.all(placeOrderPromises);
  const hasFailures = placedOrders.some((order) => order.error !== undefined);
  let hasCancelled = false;

  if (CANCEL_FLAG) {
    const sleep = createSleep(SLEEP_SECONDS || 0.001);
    let phase: "sleep" | "cancel" = "sleep";

    const triggerCancellation = () => {
      if (phase === "sleep") {
        console.log("   ✗  Price update detected, cancelling wait …");
        // hasCancelled = true;
        sleep.cancel();
      } else {
        console.log("   ⏳  Price update detected while cancelling orders, continuing …");
      }
    };
    const onSigint = () => {
      triggerCancellation();
    };
    const onExternalNotify = () => {
      triggerCancellation();
    };
    process.on("SIGINT", onSigint);
    process.on("SIGUSR1", onExternalNotify);

    if (SLEEP_SECONDS > 0) {
      console.log(`   Sleeping ${SLEEP_SECONDS}s before cancelling …`);
    }
    try {
      await sleep.promise;
    } catch (err) {
      if (!(err instanceof Error && err.message === "Sleep cancelled")) {
        process.removeListener("SIGINT", onSigint);
        process.removeListener("SIGUSR1", onExternalNotify);
        throw err;
      }
    }

    phase = "cancel";

    const cancelPromises = placedOrders.map(async (placedOrder) => {
      if (!placedOrder.orderId) {
        console.warn(`   ⚠  Skipping cancel for order at price ${placedOrder.orderPrice} because no orderID was returned.`);
        return;
      }
      console.log(`   Cancelling order ${placedOrder.orderId} …`);
      try {
        await cancelOrder({ symbol: SYMBOL, orderId: placedOrder.orderId, posSide: "Long" }, creds.PHEMEX_API_KEY, secretRaw);
        console.log(`   ✓  Order cancelled`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`   ✗  Cancel failed for order ${placedOrder.orderId} — ${msg}`);
      }
    });

    const cancelResults = await Promise.allSettled(cancelPromises);
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGUSR1", onExternalNotify);
    if (cancelResults.some((result) => result.status === "rejected")) {
      console.error("✗  One or more cancellations failed.");
      process.exit(1);
    }
  }

  if (hasFailures) process.exit(1);
  if (hasCancelled) process.exit(2);
}

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : String(err));
  process.exit(1);
});