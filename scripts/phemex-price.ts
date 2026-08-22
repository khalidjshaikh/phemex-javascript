#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-price.ts — Fetch the current price of a symbol on Phemex.
 *
 * Public endpoint, no credentials needed.
 *
 * Usage:
 *   npx tsx scripts/phemex-price.ts --symbol BTCUSDT
 *   npx tsx scripts/phemex-price.ts --symbol ETHUSDT
 *   npx tsx scripts/phemex-price.ts --symbol SOLUSDT --json
 *   npx tsx scripts/phemex-price.ts --help
 */

import { publicGet } from "../src/http-client.js";
import { getArg, hasFlag } from "../src/cli-utils.js";

const DEFAULT_SYMBOL = "BTCUSDT";

function usage(): never {
  console.log(`
Usage: npx tsx scripts/phemex-price.ts [options]

Fetch the current price of a Phemex symbol.

Options:
  --symbol <pair>   Trading pair (default: ${DEFAULT_SYMBOL})
  --min             Print min trade size for the symbol
  --json            Output raw JSON instead of formatted text
  --help, -h        Show this help message

Examples:
  npx tsx scripts/phemex-price.ts --symbol BTCUSDT
  npx tsx scripts/phemex-price.ts --symbol ETHUSDT --json
`);
  process.exit(0);
}

interface TickerResult {
  symbol?: string;
  closeRp?: string;
  markPriceRp?: string;
  indexPriceRp?: string;
  openRp?: string;
  highRp?: string;
  lowRp?: string;
  volumeRq?: string;
  fundingRateRr?: string;
  openInterestRv?: string;
  turnoverRv?: string;
  [key: string]: unknown;
}

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) usage();

  const symbol = getArg("--symbol") ?? DEFAULT_SYMBOL;
  const minMode = hasFlag("--min");
  const jsonMode = hasFlag("--json");
  const leverageMode = hasFlag("--leverage");

  if (minMode || leverageMode) {
    const prodResp = (await publicGet("/public/products", null)) as unknown as {
      code?: number;
      data?: {
        products?: Record<string, unknown>[];
        perpProductsV2?: Record<string, unknown>[];
      };
    };

    const products = [
      ...(prodResp.data?.products ?? []),
      ...(prodResp.data?.perpProductsV2 ?? []),
    ];
    const product = products.find((p) => String(p.symbol) === symbol);

    if (!product) {
      console.error(`No product info found for "${symbol}"`);
      process.exit(1);
    }

    if (leverageMode) {
      const maxLev = product.maxLeverage ?? product.defaultLeverage;
      console.log(`${symbol} max leverage: ${maxLev ?? "N/A"}×`);
      return;
    }

    console.log(`${symbol} min trade size:`);

    const step = product.qtyStepSize ?? product.baseTickSize;
    if (step != null) console.log(`  qtyStepSize:     ${step}`);

    const prec = product.qtyPrecision ?? product.baseQtyPrecision;
    if (prec != null) console.log(`  qtyPrecision:    ${prec}`);

    const minVal = product.minOrderValueRv ?? product.minOrderValue;
    if (minVal != null) console.log(`  minOrderValue:   ${minVal}`);

    const maxQty = product.maxOrderQtyRq ?? product.maxBaseOrderSize;
    if (maxQty != null) console.log(`  maxOrderQty:     ${maxQty}`);

    const minPrice = product.minPriceRp;
    if (minPrice != null) console.log(`  minPrice:        ${minPrice}`);

    const maxPrice = product.maxPriceRp;
    if (maxPrice != null) console.log(`  maxPrice:        ${maxPrice}`);

    return;
  }

  const resp = (await publicGet(
    "/md/v2/ticker/24hr",
    `symbol=${symbol}`,
  )) as unknown as {
    error?: { code?: number; message?: string } | null;
    result?: TickerResult;
  };

  if (resp.error) {
    const msg = resp.error.message ?? String(resp.error.code ?? "unknown error");
    console.error(`API error: ${msg}`);
    process.exit(1);
  }

  const data = resp.result;
  if (!data || Object.keys(data).length === 0) {
    console.error(`No data returned for symbol "${symbol}"`);
    process.exit(1);
  }

  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const last = parseFloat(data.closeRp ?? "0");
  const mark = parseFloat(data.markPriceRp ?? "0");
  const index = parseFloat(data.indexPriceRp ?? "0");
  const open = parseFloat(data.openRp ?? "0");
  const high = parseFloat(data.highRp ?? "0");
  const low = parseFloat(data.lowRp ?? "0");
  const volume = parseFloat(data.volumeRq ?? "0");
  const funding = parseFloat(data.fundingRateRr ?? "0");
  const oi = parseFloat(data.openInterestRv ?? "0");
  const turnover = parseFloat(data.turnoverRv ?? "0");

  const changePct = open > 0 ? ((last - open) / open) * 100 : 0;
  const sign = changePct >= 0 ? "+" : "";

  console.log(`${data.symbol ?? symbol}`);
  console.log(`  Last:      $${last.toFixed(2)}`);
  console.log(`  Mark:      $${mark.toFixed(2)}`);
  console.log(`  Index:     $${index.toFixed(2)}`);
  console.log(`  I-L:       ${(index - last).toFixed(2)}`);
  console.log(`  24h H/L:   $${high.toFixed(2)} / $${low.toFixed(2)}  (${sign}${changePct.toFixed(2)}%)`);
  console.log(`  Volume:    ${volume.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
  console.log(`  Funding:   ${(funding * 100).toFixed(4)}%`);
  console.log(`  OI:        ${oi.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
  console.log(`  Turnover:  $${turnover.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
