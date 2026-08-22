#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-min-fee.ts — Show trading fee for minimum quantity per symbol.
 *
 * Public endpoint for prices, fee rates are standard Phemex perpetual rates.
 *
 * Usage:
 *   npx tsx scripts/phemex-min-fee.ts                    # all USDT-M perps
 *   npx tsx scripts/phemex-min-fee.ts --symbol BTC       # filter by substring
 *   npx tsx scripts/phemex-min-fee.ts --type perp        # perpetual only (default)
 *   npx tsx scripts/phemex-min-fee.ts --type spot        # spot only
 *   npx tsx scripts/phemex-min-fee.ts --json             # raw JSON output
 *   npx tsx scripts/phemex-min-fee.ts --help             # show help
 */

import { publicGet } from "../src/http-client.js";
import { getArg, hasFlag } from "../src/cli-utils.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Product {
  symbol: string;
  type: string;
  status: string;
  settleCurrency?: string;
  qtyStepSize?: string;
  baseTickSize?: string;
  qtyPrecision?: number;
  minOrderValueRv?: string;
  maxOrderQtyRq?: string;
  [key: string]: unknown;
}

interface TickerResult {
  closeRp?: string;
  markPriceRp?: string;
  indexPriceRp?: string;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/*  Fee constants (standard Phemex perpetual rates)                    */
/* ------------------------------------------------------------------ */

// Standard perpetual contract fees
const MAKER_FEE_RATE = 0.0001; // 0.01%
const TAKER_FEE_RATE = 0.0006; // 0.06%

// Spot fees (typically lower)
const SPOT_MAKER_FEE_RATE = 0.001; // 0.10%
const SPOT_TAKER_FEE_RATE = 0.001; // 0.10%

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function usage(): never {
  console.log(`
Usage: npx tsx scripts/phemex-min-fee.ts [options]

Show trading fee for minimum quantity per symbol.

Options:
  --symbol <kw>    Filter by symbol substring
  --type <type>    Product type: perp (default) or spot
  --maker-rate <r> Override maker fee rate (e.g. 0.0001 for 0.01%)
  --taker-rate <r> Override taker fee rate (e.g. 0.0006 for 0.06%)
  --fees           Show default fee rates and exit
  --json           Output raw JSON
  --help           Show this help
`);
  process.exit(0);
}

function printFeeRates(): never {
  console.log(`
┌─────────────────────────────────────────────────────┐
│              PHEMEX DEFAULT FEE RATES               │
├─────────────────────────────────────────────────────┤
│  PERPETUAL CONTRACTS                                │
├─────────────────────────────────────────────────────┤
│  Maker Fee:   0.0100%  (0.0001)                    │
│  Taker Fee:   0.0600%  (0.0006)                    │
├─────────────────────────────────────────────────────┤
│  SPOT TRADING                                       │
├─────────────────────────────────────────────────────┤
│  Maker Fee:   0.1000%  (0.001)                     │
│  Taker Fee:   0.1000%  (0.001)                     │
├─────────────────────────────────────────────────────┤
│  NOTE: VIP tiers receive discounted rates.          │
│        Fees shown are for standard accounts.        │
└─────────────────────────────────────────────────────┘
`);
  process.exit(0);
}

function fmtNum(v: unknown, decimals = 2): string {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(decimals) : "—";
}

function fmtUsd(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  if (n < 0.01) return `$${n.toFixed(6)}`;
  if (n < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function parseStepSize(step: string | undefined): number {
  if (!step) return NaN;
  return parseFloat(step);
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  if (hasFlag("--help")) usage();
  if (hasFlag("--fees")) printFeeRates();

  const filterSymbol = getArg("--symbol");
  const productType = getArg("--type") ?? "perp";
  const asJson = hasFlag("--json");

  // Allow overriding fee rates
  const makerOverride = getArg("--maker-rate");
  const takerOverride = getArg("--taker-rate");
  const makerRate = makerOverride ? parseFloat(makerOverride) : (productType === "spot" ? SPOT_MAKER_FEE_RATE : MAKER_FEE_RATE);
  const takerRate = takerOverride ? parseFloat(takerOverride) : (productType === "spot" ? SPOT_TAKER_FEE_RATE : TAKER_FEE_RATE);

  if (isNaN(makerRate) || isNaN(takerRate)) {
    console.error("Invalid fee rate provided.");
    process.exit(1);
  }

  console.error(`⟐  Fetching ${productType} products...`);

  const prodResp = (await publicGet("/public/products", null)) as unknown as {
    code?: number;
    data?: {
      products?: Product[];
      perpProductsV2?: Product[];
    };
  };

  let products: Product[];

  if (productType === "spot") {
    products = (prodResp.data?.products ?? []).filter(
      (p) => p.type === "Spot" && p.status === "Listed",
    );
  } else {
    products = (prodResp.data?.perpProductsV2 ?? []).filter(
      (p) => p.status === "Listed" && (p.settleCurrency as string) === "USDT",
    );
  }

  if (filterSymbol) {
    const kw = filterSymbol.toLowerCase();
    products = products.filter((p) => p.symbol.toLowerCase().includes(kw));
  }

  products.sort((a, b) => a.symbol.localeCompare(b.symbol));

  if (products.length === 0) {
    console.log(`No ${productType} products found.`);
    return;
  }

  console.error(`⟐  Fetching prices for ${products.length} symbol(s)...`);

  const rows: Array<{
    symbol: string;
    price: number;
    minQty: number;
    minOrderValue: number;
    makerFee: number;
    takerFee: number;
  }> = [];

  for (const p of products) {
    const tickerResp = (await publicGet(
      "/md/v2/ticker/24hr",
      `symbol=${p.symbol}`,
    )) as unknown as {
      error?: unknown;
      result?: TickerResult;
    };

    const t = tickerResp.result;
    const price = parseFloat(t?.closeRp ?? "0");

    // Get minimum quantity from qtyStepSize or baseTickSize
    const stepSize = parseStepSize(p.qtyStepSize) || parseStepSize(p.baseTickSize);
    const minQty = stepSize || 1;

    // Calculate notional value at minimum quantity
    const minOrderValue = price * minQty;

    // Calculate fees
    const makerFee = minOrderValue * makerRate;
    const takerFee = minOrderValue * takerRate;

    rows.push({
      symbol: p.symbol,
      price,
      minQty,
      minOrderValue,
      makerFee,
      takerFee,
    });
  }

  if (asJson) {
    console.log(JSON.stringify({
      feeRates: {
        maker: makerRate,
        taker: takerRate,
        makerPercent: (makerRate * 100).toFixed(4) + "%",
        takerPercent: (takerRate * 100).toFixed(4) + "%",
      },
      symbols: rows,
    }, null, 2));
    return;
  }

  // Table output
  const wSym = Math.max(7, ...rows.map((r) => r.symbol.length));
  const wPrice = Math.max(7, ...rows.map((r) => fmtUsd(r.price).length));
  const wMinQ = Math.max(8, ...rows.map((r) => fmtNum(r.minQty, 6).length));
  const wNotional = Math.max(10, ...rows.map((r) => fmtUsd(r.minOrderValue).length));
  const wMaker = Math.max(10, ...rows.map((r) => fmtUsd(r.makerFee).length));
  const wTaker = Math.max(10, ...rows.map((r) => fmtUsd(r.takerFee).length));

  const sep = "─".repeat(wSym + wPrice + wMinQ + wNotional + wMaker + wTaker + 16);

  console.log(`\n  Trading Fees at Minimum Quantity (${productType.toUpperCase()})`);
  console.log(`  Maker Rate: ${(makerRate * 100).toFixed(4)}% | Taker Rate: ${(takerRate * 100).toFixed(4)}%\n`);
  console.log(
    `  ${"Symbol".padEnd(wSym)}  ` +
    `${"Price".padStart(wPrice)}  ` +
    `${"Min Qty".padEnd(wMinQ)}  ` +
    `${"Notional".padStart(wNotional)}  ` +
    `${"Maker Fee".padStart(wMaker)}  ` +
    `${"Taker Fee".padStart(wTaker)}`,
  );
  console.log(`  ${sep}`);

  for (const r of rows) {
    console.log(
      `  ${r.symbol.padEnd(wSym)}  ` +
      `${fmtUsd(r.price).padStart(wPrice)}  ` +
      `${fmtNum(r.minQty, 6).padEnd(wMinQ)}  ` +
      `${fmtUsd(r.minOrderValue).padStart(wNotional)}  ` +
      `${fmtUsd(r.makerFee).padStart(wMaker)}  ` +
      `${fmtUsd(r.takerFee).padStart(wTaker)}`,
    );
  }

  console.log(`\n  ${rows.length} symbol(s)`);
  console.log(`\n  Note: Fees shown are for standard accounts. VIP tiers have lower rates.`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
