#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-cli.ts  —  Unified CLI for Phemex trading tasks.
 *
 * Usage:
 *   npx tsx phemex-cli.ts list_symbols [--perp] [--spot] [--status Listed] [--symbol BTC] [--json]
 *   npx tsx phemex-cli.ts list_symbols --help
 */

import { publicGet } from "./src/http-client.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Product {
  symbol: string;
  type: string;
  status: string;
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
Usage: npx tsx phemex-cli.ts <command> [options]

Commands:
  list_symbols    List all available trading symbols / products

Options for list_symbols:
  --perp              Show only perpetual products
  --spot              Show only spot products
  --status <status>   Filter by status (e.g. Listed, Suspended)
  --symbol <keyword>  Filter by symbol (case-insensitive substring match)
  --json              Output raw JSON
  --help              Show this help
`);
  process.exit(0);
}

function getFlag(name: string): boolean {
  return process.argv.includes(name);
}

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx !== -1 && idx + 1 < process.argv.length
    ? process.argv[idx + 1]
    : undefined;
}

function padRight(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function fmt(num: number | undefined | null): string {
  if (num == null) return "—";
  return String(num);
}

/* ------------------------------------------------------------------ */
/*  list_symbols                                                       */
/* ------------------------------------------------------------------ */

async function listSymbols(): Promise<void> {
  const filterPerp   = getFlag("--perp");
  const filterSpot   = getFlag("--spot");
  const filterStatus = getArg("--status");
  const filterSymbol = getArg("--symbol");
  const asJson       = getFlag("--json");

  if (filterPerp && filterSpot) {
    console.error("✗  Cannot use both --perp and --spot at the same time.");
    process.exit(1);
  }

  const resp = (await publicGet("/public/products", null)) as unknown as ProductsResponse;

  if (resp.code !== 0) {
    console.error(`✗  API error: ${resp.msg ?? resp.code}`);
    process.exit(1);
  }

  let products = resp.data?.products ?? [];
  const total = products.length;

  if (filterPerp) products = products.filter((p) => p.type === "Perpetual");
  if (filterSpot) products = products.filter((p) => p.type === "Spot");
  if (filterStatus) {
    const f = filterStatus.toLowerCase();
    products = products.filter((p) => p.status.toLowerCase() === f);
  }
  if (filterSymbol) {
    const f = filterSymbol.toLowerCase();
    products = products.filter((p) => p.symbol.toLowerCase().includes(f));
  }

  if (asJson) {
    console.log(JSON.stringify({ total, filtered: products.length, products }, null, 2));
    return;
  }

  // Symbol list (compact output)
  if (products.length === 0) {
    console.log(`\nNo products match the given filters (${total} total available).`);
    return;
  }

  console.log(`\n${products.length} product(s) shown (of ${total} total):\n`);

  const wSym    = Math.max(8, ...products.map((p) => p.symbol.length));
  const wType   = Math.max(4, ...products.map((p) => p.type.length));
  const wStatus = Math.max(6, ...products.map((p) => p.status.length));
  const wSettle = Math.max(6, ...products.map((p) => p.settleCurrency?.length ?? 2));
  const wBase   = Math.max(4, ...products.map((p) => (p.baseCurrency ?? "—").length));
  const wQuote  = Math.max(5, ...products.map((p) => (p.quoteCurrency ?? "—").length));

  const sep = "─".repeat(wSym + wType + wStatus + wSettle + wBase + wQuote + 10);

  console.log(`  ${padRight("Symbol", wSym)}  ${padRight("Type", wType)}  ${padRight("Status", wStatus)}  ${padRight("Settle", wSettle)}  ${padRight("Base", wBase)}  ${padRight("Quote", wQuote)}`);
  console.log(`  ${sep}`);

  for (const p of products) {
    console.log(
      `  ${padRight(p.symbol, wSym)}  ` +
      `${padRight(p.type, wType)}  ` +
      `${padRight(p.status, wStatus)}  ` +
      `${padRight(p.settleCurrency ?? "—", wSettle)}  ` +
      `${padRight(p.baseCurrency ?? "—", wBase)}  ` +
      `${padRight(p.quoteCurrency ?? "—", wQuote)}`,
    );
  }
  console.log();
}

/* ------------------------------------------------------------------ */
/*  Main                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const cmd = process.argv[2];

  if (!cmd || cmd === "--help" || cmd === "-h") usage();

  switch (cmd) {
    case "list_symbols":
      await listSymbols();
      break;
    default:
      console.error(`✗  Unknown command: "${cmd}"`);
      usage();
  }
}

main().catch((e) => {
  console.error("Fatal:", (e as Error).message);
  process.exit(1);
});
