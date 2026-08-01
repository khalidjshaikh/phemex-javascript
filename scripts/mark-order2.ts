#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * mark-order2.ts — Trigger market orders off the mark/last price spread.
 *
 * Watches XBRUSDT and computes  Δ = mark − last.  A trade flag gates firing:
 *
 *   flag = 0  whenever the last price changes
 *   flag = 1  once a threshold has fired
 *
 * Triggers (only while flag == 0):
 *   Δ >  +$0.10  →  market BUY  (long)  qty 1, 100x leverage
 *   Δ <  −$0.10  →  market SELL (short) qty 1, 100x leverage
 *
 * The flag resets to 0 whenever the last price changes, arming the next trigger.
 */

import { watchMarkPrice } from "../src/mark-price.js";
import { base64UrlDecode } from "../src/http-client.js";
import { loadCredentialsLocal } from "../src/credentials.js";
import { placeMarketOrder, setLeverageUsdtM } from "../src/place-limit-order.js";

const SYMBOL = "XBRUSDT";
const QTY = 0.01;
const LEVERAGE = 100;
/** Trigger when |mark − last| exceeds this (quote currency units). */
const THRESHOLD = 0.10;

/** Trade flag — 0 when the last price changes, 1 after a trigger fires. */
let flag = 0;
/** Last price from the previous update, used to detect last-price changes. */
let prevLast = 0;

const creds = loadCredentialsLocal();
const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

async function place(side: "Buy" | "Sell", posSide: string): Promise<void> {
  console.log(`⟐  PLACING ${side === "Buy" ? "LONG" : "SHORT"} market order  qty ${QTY}  ${LEVERAGE}x`);
  await setLeverageUsdtM(SYMBOL, LEVERAGE, posSide, creds.PHEMEX_API_KEY, secretRaw);
  const result = await placeMarketOrder(
    { account: "usdt-m", symbol: SYMBOL, side: side, qty: QTY, posSide },
    creds.PHEMEX_API_KEY,
    secretRaw,
  );
  console.log(`   ✓  OrderID ${result.orderID ?? result.clOrdID ?? "—"}  status ${result.ordStatus ?? "—"}`);
}

watchMarkPrice(
  SYMBOL,
  async ({ markPrice, lastPrice }) => {
    const delta = markPrice - lastPrice;

    // Last price changed → re-arm the flag.
    if (lastPrice !== prevLast) {
      flag = 0;
    }
    prevLast = lastPrice;

    if (flag === 0) {
      try {
        if (delta >= THRESHOLD) {
          flag = 1;
          await place("Buy", "Long");
        } else if (delta <= -THRESHOLD) {
          flag = 1;
          await place("Sell", "Short");
        }
      } catch (err) {
        console.error("✗", err instanceof Error ? err.message : String(err));
      }
    }

    console.log(
      `⟐  mark $${markPrice.toFixed(2)}  last $${lastPrice.toFixed(2)}` +
        `  Δ ${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}¢  flag ${flag}`,
    );
  },
  { onStatus: (msg) => console.error(`⟐  ${msg}`) },
);
