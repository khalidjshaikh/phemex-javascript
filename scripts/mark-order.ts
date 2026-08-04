#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT

import { watchMarkPrice } from "../src/mark-price.js";
const SYMBOL = "XBRUSDT"

watchMarkPrice(
  SYMBOL,
  async ({ markPrice, lastPrice }) => {
    console.log(`⟐  mark $${markPrice.toFixed(2)}  last $${lastPrice.toFixed(2)}`);
  },
  { onStatus: (msg) => console.error(`⟐  ${msg}`) },
);
