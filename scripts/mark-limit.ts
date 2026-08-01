#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * mark-limit.ts — Place paired Long (+gap) and Short (−gap) spread limit
 * orders on every WebSocket mark-price update, then cancel them after a short
 * sleep (test flow). The ladder is anchored on the live mark price.
 *
 * Usage:
 *   ./mark-limit.ts                          # XBRUSDT, qty 0.1
 *   ./mark-limit.ts --symbol BTCUSDT --qty 0.05
 */

import { watchMarkPrice } from "../src/mark-price.js";
import {
  getArgValue,
  resolveCredentials,
  placeSpreadLimitOrders,
} from "../src/spread-limit-order.js";

const SYMBOL = getArgValue("--symbol") ?? "XBRUSDT";
const QTY = getArgValue("--qty") !== undefined ? parseFloat(getArgValue("--qty")!) : 0.01;
const SHORT_GAP = +0.1; // short entry = mark − 0.1
const LONG_GAP = -0.1;   // long entry = mark + 0.1
const SLEEP_SECONDS = 1;

/**
 * Place both ladders concurrently from the live mark price, then cancel them
 * after SLEEP_SECONDS.
 */
async function placePair(markPrice: number): Promise<void> {
  const common = {
    symbol: SYMBOL,
    qty: QTY,
    spread: "0",
    dispersion: 1.0,
    leverage: 100,
    referencePrice: markPrice,
    cancel: true,
    sleepSeconds: SLEEP_SECONDS,
    ignoreFlagErrors: true,
  };
  const { apiKey, secretRaw } = resolveCredentials();

  await Promise.all([
    placeSpreadLimitOrders({
      ...common,
      side: "Buy",
      posSide: "Long",
      gap: LONG_GAP,
      apiKey,
      secretRaw,
      spread: "+2"
    }),
    placeSpreadLimitOrders({
      ...common,
      side: "Sell",
      posSide: "Short",
      gap: SHORT_GAP,
      apiKey,
      secretRaw,
      spread: "-2"
    }),
  ]);
}

let busy = false;

watchMarkPrice(
  SYMBOL,
  async ({ markPrice, lastPrice }) => {
    console.log(`⟐  mark $${markPrice.toFixed(2)}  last $${lastPrice.toFixed(2)}`);
    if (busy) {
      console.error(`⟐  Skipping update at $${markPrice.toFixed(2)} — previous cycle still running`);
      return;
    }
    busy = true;
    try {
      // console.log(`⟐  Placing paired orders at mark $${markPrice.toFixed(2)} …`);
      // await placePair(markPrice);
    } catch (err) {
      console.error("✗", err instanceof Error ? err.message : String(err));
    } finally {
      busy = false;
    }
  },
  { onStatus: (msg) => console.error(`⟐  ${msg}`) },
);
