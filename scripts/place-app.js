#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * place-app.js  —  Generic limit-order ladder app driven by a JSON key/value
 * config, built on the shared spread-limit-order library.
 *
 * The config is a JSON object of key/value pairs — spread and dispersion
 * among them. It can be supplied via a config file (--config) and/or
 * overridden with individual CLI flags.
 *
 * Usage:
 *   ./place-app.js --config config.json
 *   ./place-app.js --symbol XTIUSDT --side Sell --posSide Short --qty 0.01 --spread -3 --dispersion 2
 *   ./place-app.js --config config.json --dry-run
 *
 * Config keys (JSON object):
 *   symbol, side (Buy|Sell), posSide (Long|Short), qty, spread, dispersion,
 *   gap, takeProfit, stopLossOffset, leverage, pidFile,
 *   cancel (bool), sleepSeconds
 */

import fs from "node:fs";
import { fetchMarkPrice } from "../src/mark-price.ts";
import {
  getArgValue,
  resolveCredentials,
  parseSpread,
  buildSpreadPrices,
  placeSpreadLimitOrders,
} from "../src/spread-limit-order.ts";

const NUMERIC_KEYS = [
  "qty",
  "dispersion",
  "gap",
  "takeProfit",
  "stopLossOffset",
  "leverage",
  "sleepSeconds",
];

function usage() {
  console.log(`
Usage: ./place-app.js [--config <file.json>] [--dry-run] [flags...]

Place a ladder of limit orders from a JSON key/value config using the
spread-limit-order library. Config comes from --config <file> (JSON object)
and is overridden by individual CLI flags.

Config keys (JSON object):
  symbol           Trading pair (e.g. XTIUSDT, XBRUSDT)
  side             Buy | Sell
  posSide          Long | Short
  qty              Contract quantity
  spread           Integer rung count, or decimal price distance (e.g. -0.16)
  dispersion       Tick spacing multiplier (default: 1.0)
  gap              Added to the entry price before spread (default: 0)
  takeProfit       Optional take-profit trigger price
  stopLossOffset   Stop-loss distance from each price (default: 0.01)
  leverage         Leverage (default: 100)
  pidFile          Optional PID file to register while running
  cancel           Cancel all placed orders after sleepSeconds (test flow)
  sleepSeconds     Seconds to wait between placing and cancelling

Flags:
  --config <file>      JSON config file (key/value pairs)
  --symbol, --side, --posSide, --qty, --spread, --dispersion, --gap,
  --takeProfit, --stopLossOffset, --leverage, --sleep
  --cancel             Same as "cancel": true
  --dry-run            Print the computed price ladder without placing orders
  --help, -h           Show this help message

Examples:
  ./place-app.js --symbol XTIUSDT --side Sell --posSide Short --qty 0.01 --spread -3 --dispersion 2
  ./place-app.js --config config.json
  ./place-app.js --config config.json --dry-run
`);
  process.exit(0);
}

/** Parse a numeric config value from CLI/JSON; NaN values are rejected. */
function toNumber(value, key) {
  const n = Number(value);
  if (isNaN(n)) {
    throw new Error(`Invalid numeric value for "${key}": ${String(value)}`);
  }
  return n;
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) usage();

  const configFile = getArgValue("--config");
  const dryRun = process.argv.includes("--dry-run");

  const config = {};
  if (configFile !== undefined) {
    const raw = fs.readFileSync(configFile, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Config file must contain a JSON object: ${configFile}`);
    }
    Object.assign(config, parsed);
  }

  // CLI flag overrides (key/value pairs).
  const flagKeys = [
    ["--symbol", "symbol"],
    ["--side", "side"],
    ["--posSide", "posSide"],
    ["--qty", "qty"],
    ["--spread", "spread"],
    ["--dispersion", "dispersion"],
    ["--gap", "gap"],
    ["--takeProfit", "takeProfit"],
    ["--stopLossOffset", "stopLossOffset"],
    ["--leverage", "leverage"],
    ["--sleep", "sleepSeconds"],
  ];
  for (const [flag, key] of flagKeys) {
    const value = getArgValue(flag);
    if (value !== undefined) config[key] = value;
  }
  if (process.argv.includes("--cancel")) config.cancel = true;

  // Validate required keys.
  for (const key of ["symbol", "side", "posSide", "qty", "spread"]) {
    if (config[key] === undefined || config[key] === null || config[key] === "") {
      throw new Error(`Missing required config key: ${key}`);
    }
  }

  const symbol = String(config.symbol);
  const side = String(config.side);
  const posSide = String(config.posSide);
  if (side !== "Buy" && side !== "Sell") throw new Error(`side must be "Buy" or "Sell", got: ${side}`);
  if (posSide !== "Long" && posSide !== "Short") throw new Error(`posSide must be "Long" or "Short", got: ${posSide}`);

  const qty = toNumber(config.qty, "qty");
  const spreadRaw = String(config.spread);
  const dispersion = config.dispersion !== undefined ? toNumber(config.dispersion, "dispersion") : 1.0;
  const gap = config.gap !== undefined ? toNumber(config.gap, "gap") : 0.0;
  const takeProfit = config.takeProfit !== undefined ? toNumber(config.takeProfit, "takeProfit") : undefined;
  const stopLossOffset = config.stopLossOffset !== undefined ? toNumber(config.stopLossOffset, "stopLossOffset") : 0.01;
  const leverage = config.leverage !== undefined ? toNumber(config.leverage, "leverage") : 100;
  const pidFile = config.pidFile !== undefined ? String(config.pidFile) : undefined;
  const cancel = config.cancel !== undefined ? Boolean(config.cancel) : false;
  const sleepSeconds = config.sleepSeconds !== undefined ? toNumber(config.sleepSeconds, "sleepSeconds") : 0;

  // Fetch the live mark price, then preview the ladder (pure functions) before placing.
  const { value: spreadValue, explicitSign: spreadExplicitSign } = parseSpread(spreadRaw);
  const lastPrice = await fetchMarkPrice(symbol);
  const orderPrices = buildSpreadPrices(lastPrice + gap, spreadValue, spreadExplicitSign, dispersion);
  console.log(`⟐  ${side} ${symbol}  qty: ${qty}  spread: ${spreadRaw}  dispersion: ${dispersion}  gap: ${gap}  leverage: ${leverage}x`);
  console.log(`   Ladder (${orderPrices.length}): ${orderPrices.join(", ")}`);

  if (dryRun) {
    console.log("   (dry run — no orders placed)");
    return;
  }

  const { apiKey, secretRaw } = resolveCredentials();
  const result = await placeSpreadLimitOrders({
    symbol,
    side,
    posSide,
    qty,
    spread: spreadRaw,
    dispersion,
    gap,
    takeProfit,
    stopLossOffset,
    leverage,
    referencePrice: lastPrice,
    pidFile,
    cancel,
    sleepSeconds,
    apiKey,
    secretRaw,
  });
  if (result.hasFailures || result.cancelFailed) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
