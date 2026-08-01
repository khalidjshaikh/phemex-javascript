#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * mark-app.ts — prints the live Phemex mark & last price for a perpetual symbol.
 * Uses the watchMarkPrice WebSocket library from ./src/mark-price.js.
 *
 * Usage:
 *   npx tsx mark-app.ts              # default XBRUSDT
 *   npx tsx mark-app.ts BTCUSDT      # custom symbol
 */

import { watchMarkPrice } from "./src/mark-price.js";

const symbol = process.argv[2] ?? "XBRUSDT";

watchMarkPrice(
  symbol,
  ({ markPrice, lastPrice, timestamp }) => {
    const now = new Date(timestamp).toLocaleString();
    console.log(`${now}  ${symbol}  Mark: $${markPrice.toFixed(2)}  Last: $${lastPrice.toFixed(2)}`);
  },
  { onStatus: (msg) => console.error(`⟐  ${msg}`) },
);
