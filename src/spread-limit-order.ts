// SPDX-License-Identifier: MIT
/**
 * spread-limit-order.ts — Shared library for placing limit-order ladders
 * with spread and dispersion, driven by a JSON key/value config.
 *
 * Consolidates the logic previously duplicated in long-limit.ts and
 * short-limit.ts: CLI arg parsing, spread parsing, spread-price ladder
 * building, cancellable sleep, PID-file bookkeeping, purchase-flag gating,
 * leverage setup, parallel order placement, and the optional
 * place-then-cancel test flow.
 *
 * Usage:
 *   import { placeSpreadLimitOrders, getArgValue } from "./src/spread-limit-order.js";
 */

import fs from "node:fs";
import { base64UrlDecode } from "./http-client.js";
import { loadCredentialsLocal } from "./credentials.js";
import { placeLimitOrder, cancelOrder, setLeverageUsdtM } from "./place-limit-order.js";
import { getFlag } from "./dynamodb-flag.js";
import { fetchMarkPrice, fetchLastPrice } from "./mark-price.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface SpreadLimitOrderConfig {
  /** Trading pair (e.g. XTIUSDT, XBRUSDT) */
  symbol: string;
  /** Order direction */
  side: "Buy" | "Sell";
  /** Position side (Long for buys, Short for sells) */
  posSide: "Long" | "Short";
  /** Contract quantity */
  qty: number;
  /** Raw spread value: integer rung count or decimal price distance */
  spread: string;
  /** Tick spacing multiplier (default: 1.0) */
  dispersion?: number;
  /** Added to the entry price before applying spread and dispersion (default: 0) */
  gap?: number;
  /** Optional take-profit trigger price */
  takeProfit?: number;
  /** Stop-loss distance from each ladder price (below for Buy, above for Sell). Only applied when provided. */
  stopLossOffset?: number;
  /** Reference price to build the ladder from. */
  referencePrice: number;
  /** Leverage (default: 100) */
  leverage?: number;
  /** Optional PID file to register while running (removed on exit) */
  pidFile?: string;
  /** Cancel all placed orders after sleepSeconds (test flow) */
  cancel?: boolean;
  /** Seconds to wait between placing and cancelling (requires cancel) */
  sleepSeconds?: number;
  /** When true, proceed if the purchase flag cannot be checked (DynamoDB down) */
  ignoreFlagErrors?: boolean;
  apiKey: string;
  secretRaw: Buffer;
}

export interface PlacedOrder {
  orderPrice: number;
  orderId?: string;
  error?: Error;
}

export interface SpreadLimitOrderResult {
  referencePrice: number;
  orderPrices: number[];
  placedOrders: PlacedOrder[];
  hasFailures: boolean;
  cancelFailed: boolean;
}

/* ------------------------------------------------------------------ */
/*  CLI helpers                                                        */
/* ------------------------------------------------------------------ */

/**
 * Get the value of a CLI argument: `--name value` or `--name=value`.
 */
export function getArgValue(argName: string): string | undefined {
  const explicitIndex = process.argv.indexOf(argName);
  if (explicitIndex !== -1 && explicitIndex + 1 < process.argv.length) {
    return process.argv[explicitIndex + 1];
  }
  const assignment = process.argv.find((value) => value.startsWith(`${argName}=`));
  return assignment ? assignment.slice(argName.length + 1) : undefined;
}

/**
 * Resolve a --takeProfit value into an absolute trigger price.
 * Accepts:
 *   "123.45"     — a fixed price
 *   "last"       — the current last traded price
 *   "last+0.10"  — last traded price plus an offset
 *   "last-0.10"  — last traded price minus an offset
 * Returns undefined when no take-profit was requested.
 */
export async function resolveTakeProfit(
  raw: string | undefined,
  priceSource: "mark" | "last",
  symbol: string,
  referencePrice: number,
): Promise<number | undefined> {
  if (raw === undefined) return undefined;
  const lower = raw.toLowerCase();
  if (lower === "last") {
    return priceSource === "last" ? referencePrice : await fetchLastPrice(symbol);
  }
  if (lower === "mark") {
    return priceSource === "mark" ? referencePrice : await fetchMarkPrice(symbol);
  }
  const offsetMatch = /^(last|mark)([+-])([\d.]+)$/.exec(lower);
  if (offsetMatch) {
    const base =
      offsetMatch[1] === "last"
        ? priceSource === "last"
          ? referencePrice
          : await fetchLastPrice(symbol)
        : priceSource === "mark"
          ? referencePrice
          : await fetchMarkPrice(symbol);
    const offset = parseFloat(offsetMatch[3]);
    const price = offsetMatch[2] === "+" ? base + offset : base - offset;
    return +price.toFixed(2);
  }
  return parseFloat(raw);
}

/* ------------------------------------------------------------------ */
/*  Credentials                                                        */
/* ------------------------------------------------------------------ */

/**
 * Load local credentials and decode the API secret.
 */
export function resolveCredentials(): { apiKey: string; secretRaw: Buffer } {
  const creds = loadCredentialsLocal();
  return {
    apiKey: creds.PHEMEX_API_KEY,
    secretRaw: base64UrlDecode(creds.PHEMEX_API_SECRET),
  };
}

/* ------------------------------------------------------------------ */
/*  Spread helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Parse a raw spread value.
 * Returns the numeric value and whether the sign was explicit
 * ("+5"/"-3" are one-sided, "5" is symmetric). Integers are rung counts;
 * decimals are absolute price distances converted to rung counts later.
 */
export function parseSpread(raw: string): { value: number; explicitSign: boolean } {
  if (!/^[+-]?(?:\d+|\d*\.\d+)$/.test(raw)) {
    throw new Error(`Invalid --spread value: ${raw}`);
  }
  return {
    value: Number(raw),
    explicitSign: raw.startsWith("+") || raw.startsWith("-"),
  };
}

function spreadStepCount(spread: number, dispersion: number): number {
  if (Number.isInteger(spread)) return Math.abs(spread);

  const tick = 0.01 * dispersion;
  const rawSteps = Math.abs(spread) / tick;
  const roundedSteps = Math.round(rawSteps);

  if (roundedSteps < 1 || Math.abs(rawSteps - roundedSteps) > 1e-9) {
    throw new Error(
      `Decimal --spread value ${spread} must align with tick size ${tick.toFixed(8).replace(/0+$/, "").replace(/\.$/, "")}`,
    );
  }

  return roundedSteps;
}

/**
 * Build the ladder of order prices around a reference price.
 *
 * One-sided integer: +N = N ticks above ref (inclusive), -N = N ticks below ref (inclusive)
 * Symmetric integer: N = N ticks below AND N ticks above ref
 *   e.g. 2 → [ref-0.02, ref-0.01, ref, ref+0.01, ref+0.02] (5 orders)
 * Decimal spreads are price distances: -0.16 at dispersion 1 means 16 one-cent
 * rungs below ref, while -0.16 at dispersion 2 means 8 two-cent rungs below.
 */
export function buildSpreadPrices(
  referencePrice: number,
  spread: number,
  explicitSign: boolean,
  dispersion: number,
): number[] {
  if (spread === 0) return [referencePrice];
  const tick = 0.01 * dispersion;
  const steps = spreadStepCount(spread, dispersion);

  if (explicitSign) {
    const orders = [referencePrice];
    if (spread > 0) {
      for (let i = 1; i <= steps; i++) {
        orders.push(+(referencePrice + i * tick).toFixed(2));
      }
    } else {
      for (let i = 1; i <= steps; i++) {
        orders.unshift(+(referencePrice - i * tick).toFixed(2));
      }
    }
    return orders;
  }

  const orders: number[] = [];
  for (let i = steps; i >= 1; i--) {
    orders.push(+(referencePrice - i * tick).toFixed(2));
  }
  orders.push(referencePrice);
  for (let i = 1; i <= steps; i++) {
    orders.push(+(referencePrice + i * tick).toFixed(2));
  }
  return orders;
}

/* ------------------------------------------------------------------ */
/*  Sleep / PID helpers                                                */
/* ------------------------------------------------------------------ */

/**
 * A cancellable sleep. Resolves after `seconds`, or rejects with
 * "Sleep cancelled" when cancel() is called first.
 */
export function createSleep(seconds: number): { promise: Promise<void>; cancel: () => void } {
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

export function registerPidFile(pidFile: string): void {
  fs.writeFileSync(pidFile, String(process.pid), "utf8");
}

export function unregisterPidFile(pidFile: string): void {
  try {
    fs.unlinkSync(pidFile);
  } catch {
    // Ignore if the file was already removed.
  }
}

/* ------------------------------------------------------------------ */
/*  Main placement flow                                                */
/* ------------------------------------------------------------------ */

/**
 * Place a ladder of limit orders built from a reference price, spread and
 * dispersion.
 * Optionally waits `sleepSeconds` and cancels all placed orders (test flow).
 *
 * Returns per-order results plus aggregate failure flags; the caller decides
 * the process exit code.
 */
export async function placeSpreadLimitOrders(
  config: SpreadLimitOrderConfig,
): Promise<SpreadLimitOrderResult> {
  const {
    symbol,
    side,
    posSide,
    qty,
    spread: spreadRaw,
    dispersion = 1.0,
    gap = 0.0,
    takeProfit,
    stopLossOffset,
    referencePrice,
    leverage = 100,
    pidFile,
    cancel = false,
    sleepSeconds = 0,
    ignoreFlagErrors = false,
    apiKey,
    secretRaw,
  } = config;

  if (isNaN(qty) || qty <= 0) {
    throw new Error("--qty must be a positive number");
  }
  if (isNaN(dispersion) || dispersion <= 0) {
    throw new Error("--dispersion must be a positive number");
  }
  if (isNaN(gap)) {
    throw new Error("--gap must be a number");
  }
  if (takeProfit !== undefined && (isNaN(takeProfit) || takeProfit <= 0)) {
    throw new Error("--takeProfit must be a positive number");
  }

  const { value: spreadValue, explicitSign: spreadExplicitSign } = parseSpread(spreadRaw);

  const lastPrice = referencePrice;
  if (isNaN(lastPrice)) {
    throw new Error(`referencePrice must be a number, got: ${referencePrice}`);
  }

  if (pidFile) {
    process.once("exit", () => unregisterPidFile(pidFile));
    registerPidFile(pidFile);
  }

  const adjustedReferencePrice = lastPrice + gap;
  const orderPrices = buildSpreadPrices(adjustedReferencePrice, spreadValue, spreadExplicitSign, dispersion);
  console.log(`⟐  Limit ${posSide} ${symbol}  side: ${side}  account: usdt-m  qty: ${qty}  spread: ${spreadRaw}  dispersion: ${dispersion}  gap: ${gap}  leverage: ${leverage}x  takeProfit: ${takeProfit ?? "—"}`);

  await setLeverageUsdtM(symbol, leverage, posSide, apiKey, secretRaw);

  // Purchase gate: default to enabled, but honor a false flag from DynamoDB.
  // let purchaseEnabled: boolean | null = true;
  // try {
  //   purchaseEnabled = await getFlag("purchase");
  // } catch (flagErr) {
  //   if (ignoreFlagErrors) {
  //     console.warn(`   ⚠  Could not check purchase flag (DynamoDB unavailable) — proceeding with order`);
  //   } else {
  //     throw flagErr;
  //   }
  // }
  // if (!purchaseEnabled) throw new Error("purchase flag is false");

  // Stop-loss sits below the entry for Buys and above it for Sells.
  const stopLossSign = side === "Buy" ? -1 : 1;

  const placeOrderPromises = orderPrices.map(async (orderPrice) => {
    const stopLoss = stopLossOffset !== undefined
      ? +(orderPrice + stopLossSign * stopLossOffset).toFixed(2)
      : undefined;
    try {
      const result = await placeLimitOrder(
        { account: "usdt-m", symbol, side, price: orderPrice, qty, posSide, stopLoss, takeProfit },
        apiKey,
        secretRaw,
      );

      const orderId = result.orderID ?? undefined;
      console.log(`   ✓  placeLimitOrder({ account: "usdt-m", symbol: ${symbol}, side: ${side}, price: ${orderPrice}, qty: ${qty}, posSide: ${posSide}, stopLoss: ${stopLoss ?? "—"}, takeProfit: ${takeProfit ?? "—"} })  →  ID: ${orderId ?? result.clOrdID ?? "—"}  Status: ${result.ordStatus ?? "—"}`);
      return { orderPrice, orderId, error: undefined as Error | undefined };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`   ✗  Order failed at price ${orderPrice} — ${error.message}`);
      return { orderPrice, orderId: undefined, error };
    }
  });

  const placedOrders = await Promise.all(placeOrderPromises);
  const hasFailures = placedOrders.some((order) => order.error !== undefined);
  let cancelFailed = false;

  if (cancel) {
    const sleep = createSleep(sleepSeconds || 0.001);
    let phase: "sleep" | "cancel" = "sleep";
    let hasCancelled = false;

    const triggerCancellation = () => {
      if (hasCancelled) return;
      hasCancelled = true;
      if (phase === "sleep") {
        console.log("   ✗  Price update detected, cancelling wait …");
        sleep.cancel();
      } else {
        console.log("   ⏳  Price update detected while cancelling orders, continuing …");
      }
    };
    const onSigint = () => {
      triggerCancellation();
      if (hasCancelled) {
        process.exitCode = 2;
      }
    };
    const onExternalNotify = () => {
      triggerCancellation();
    };
    process.on("SIGINT", onSigint);
    process.on("SIGUSR1", onExternalNotify);

    // In-place countdown on a single line while waiting to cancel.
    let countdownTimer: NodeJS.Timeout | undefined;
    let sleepCancelled = false;
    if (sleepSeconds > 0) {
      const endTime = Date.now() + sleepSeconds * 1000;
      const writeCountdown = () => {
        const remaining = Math.max(0, Math.ceil((endTime - Date.now()) / 1000));
        process.stdout.write(`\r\x1b[2K   Sleeping ${remaining}s before cancelling …`);
      };
      writeCountdown();
      countdownTimer = setInterval(writeCountdown, 200);
    }
    try {
      await sleep.promise;
    } catch (err) {
      if (!(err instanceof Error && err.message === "Sleep cancelled")) {
        if (countdownTimer) clearInterval(countdownTimer);
        process.removeListener("SIGINT", onSigint);
        process.removeListener("SIGUSR1", onExternalNotify);
        throw err;
      }
      sleepCancelled = true;
    }
    if (countdownTimer) {
      clearInterval(countdownTimer);
      if (!sleepCancelled) process.stdout.write("\n");
    }

    phase = "cancel";

    const cancelPromises = placedOrders.map(async (placedOrder) => {
      if (!placedOrder.orderId) {
        console.warn(`   ⚠  Skipping cancel for order at price ${placedOrder.orderPrice} because no orderID was returned.`);
        return;
      }
      console.log(`   Cancelling order ${placedOrder.orderId} …`);
      try {
        await cancelOrder({ symbol, orderId: placedOrder.orderId, posSide }, apiKey, secretRaw);
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
      cancelFailed = true;
    }
  }

  return { referencePrice: lastPrice, orderPrices, placedOrders, hasFailures, cancelFailed };
}
