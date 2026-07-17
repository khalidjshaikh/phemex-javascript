#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-public-products.ts  —  Fetch and display all Phemex trading products.
 *
 * Public endpoint, no credentials needed.
 *
 * Usage:
 *   npx tsx phemex-public-products.ts                  # all products
 *   npx tsx phemex-public-products.ts --perp           # perpetuals only
 *   npx tsx phemex-public-products.ts --spot           # spot only
 *   npx tsx phemex-public-products.ts --status Listed  # listed products only
 *   npx tsx phemex-public-products.ts --symbol BTC     # search by symbol
 *   npx tsx phemex-public-products.ts --json           # raw JSON output
 *   npx tsx phemex-public-products.ts --help           # show help
 */

import { publicGet } from "./src/http-client.js";
import { getArg, hasFlag } from "./src/cli-utils.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Product {
  symbol: string;
  type: string;          // "Perpetual" | "Spot"
  status: string;        // "Listed" etc.
  settleCurrency: string;
  priceScale: number;
  valueScale: number;
  contractSize?: number;
  baseCurrency?: string;
  quoteCurrency?: string;
  [key: string]: unknown;
}

interface ProductsResponse {
  code: number;
  msg?: string;
  data?: {
    products?: Product[];
  };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function usage(): never {
  console.log(`
Usage: npx tsx phemex-public-products.ts [options]

Options:
  --perp              Show only perpetual products
  --spot              Show only spot products
  --status <status>   Filter by status (e.g. Listed, Suspended)
  --symbol <keyword>  Filter by symbol (case-insensitive substring match)
  --json              Output raw JSON instead of formatted table
  --help              Show this help
`);
  process.exit(0);
}

function fmt(num: number | undefined | null): string {
  if (num == null) return "—";
  return String(num);
}

function padRight(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const filterPerp  = hasFlag("--perp");
  const filterSpot  = hasFlag("--spot");
  const filterStatus = getArg("--status");
  const filterSymbol = getArg("--symbol");
  const asJson      = hasFlag("--json");

  if (hasFlag("--help")) usage();

  if (filterPerp && filterSpot) {
    console.error("✗  Cannot use both --perp and --spot at the same time.");
    process.exit(1);
  }

  console.error("⟐  Fetching product list …");
  const resp = (await publicGet("/public/products", null)) as unknown as ProductsResponse;

  if (resp.code !== 0) {
    console.error(`✗  API error: ${resp.msg ?? resp.code}`);
    process.exit(1);
  }

  let products = resp.data?.products ?? [];
  const total = products.length;

  // ── Apply filters ──────────────────────────────────────────
  if (filterPerp) {
    products = products.filter((p) => p.type === "Perpetual");
  }
  if (filterSpot) {
    products = products.filter((p) => p.type === "Spot");
  }
  if (filterStatus) {
    const f = filterStatus.toLowerCase();
    products = products.filter((p) => p.status.toLowerCase() === f);
  }
  if (filterSymbol) {
    const f = filterSymbol.toLowerCase();
    products = products.filter((p) => p.symbol.toLowerCase().includes(f));
  }

  // ── Output ─────────────────────────────────────────────────
  if (asJson) {
    console.log(JSON.stringify({ total, filtered: products.length, products }, null, 2));
    return;
  }

  // Determine column widths
  const rows = products.map((p) => ({
    symbol: p.symbol,
    type: p.type,
    status: p.status,
    settle: p.settleCurrency ?? "—",
    priceScale: fmt(p.priceScale),
    valScale: fmt(p.valueScale),
    cSize: p.contractSize != null && p.contractSize !== 1 ? String(p.contractSize) : "—",
    base: p.baseCurrency ?? "—",
    quote: p.quoteCurrency ?? "—",
  }));

  if (rows.length === 0) {
    console.log(`\nNo products match the given filters (${total} total available).`);
    return;
  }

  // Dynamic column widths
  const wSym    = Math.max(8, ...rows.map((r) => r.symbol.length));
  const wType   = Math.max(4, ...rows.map((r) => r.type.length));
  const wStatus = Math.max(6, ...rows.map((r) => r.status.length));
  const wSettle = Math.max(6, ...rows.map((r) => r.settle.length));
  const wPScale = 10;
  const wVScale = 10;
  const wCSize  = 12;
  const wBase   = Math.max(4, ...rows.map((r) => r.base.length));
  const wQuote  = Math.max(5, ...rows.map((r) => r.quote.length));

  // Header
  const sep = "─".repeat(wSym + wType + wStatus + wSettle + wPScale + wVScale + wCSize + wBase + wQuote + 16);

  console.log(`\n  ${padRight("Symbol", wSym)}  ${padRight("Type", wType)}  ${padRight("Status", wStatus)}  ${padRight("Settle", wSettle)}  ${padRight("PriceScale", wPScale)}  ${padRight("ValScale", wVScale)}  ${padRight("ContractSize", wCSize)}  ${padRight("Base", wBase)}  ${padRight("Quote", wQuote)}`);
  console.log(`  ${sep}`);

  for (const r of rows) {
    console.log(
      `  ${padRight(r.symbol, wSym)}  ` +
      `${padRight(r.type, wType)}  ` +
      `${padRight(r.status, wStatus)}  ` +
      `${padRight(r.settle, wSettle)}  ` +
      `${padRight(r.priceScale, wPScale)}  ` +
      `${padRight(r.valScale, wVScale)}  ` +
      `${padRight(r.cSize, wCSize)}  ` +
      `${padRight(r.base, wBase)}  ` +
      `${padRight(r.quote, wQuote)}`,
    );
  }

  console.log(`\n  ${rows.length} product(s) shown (of ${total} total)`);
}

main().catch((e) => {
  console.error("Fatal:", (e as Error).message);
  process.exit(1);
});