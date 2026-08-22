#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-symbols.ts — List all Phemex trading symbols.
 *
 * Public endpoint, no credentials needed.
 *
 * Usage:
 *   npx tsx scripts/phemex-symbols.ts              # all listed symbols
 *   npx tsx scripts/phemex-symbols.ts --perp       # perpetuals only
 *   npx tsx scripts/phemex-symbols.ts --spot       # spot only
 *   npx tsx scripts/phemex-symbols.ts --usdt       # USDT-M perps only
 *   npx tsx scripts/phemex-symbols.ts --coin       # Coin-M perps only
 *   npx tsx scripts/phemex-symbols.ts --symbol BTC # filter by substring
 *   npx tsx scripts/phemex-symbols.ts --json       # raw JSON output
 */

import { publicGet } from "../src/http-client.js";
import { getArg, hasFlag } from "../src/cli-utils.js";

function usage(): never {
  console.log(`
Usage: npx tsx scripts/phemex-symbols.ts [options]

List all Phemex trading symbols.

Options:
  --perp          Perpetuals only (USDT-M + Coin-M)
  --spot          Spot only
  --usdt          USDT-M perpetuals only
  --coin          Coin-M perpetuals only
  --status <s>    Filter by status (default: Listed)
  --symbol <kw>   Filter by symbol substring
  --json          Output raw JSON
  --help          Show this help
`);
  process.exit(0);
}

interface Product {
  symbol: string;
  type: string;
  status: string;
  settleCurrency?: string;
  [key: string]: unknown;
}

async function main(): Promise<void> {
  if (hasFlag("--help")) usage();

  const filterPerp = hasFlag("--perp");
  const filterSpot = hasFlag("--spot");
  const filterUsdt = hasFlag("--usdt");
  const filterCoin = hasFlag("--coin");
  const filterSymbol = getArg("--symbol");
  const filterStatus = getArg("--status") ?? "Listed";
  const asJson = hasFlag("--json");

  const resp = (await publicGet("/public/products", null)) as unknown as {
    code?: number;
    data?: {
      products?: Product[];
      perpProductsV2?: Product[];
      perpProductsV1?: Product[];
    };
  };

  const products: Product[] = [
    ...(resp.data?.products ?? []),
    ...(resp.data?.perpProductsV2 ?? []),
    ...(resp.data?.perpProductsV1 ?? []),
  ];

  let filtered = products.filter((p) => p.status === filterStatus);

  if (filterPerp) {
    filtered = filtered.filter((p) => p.type.startsWith("Perpetual"));
  }
  if (filterSpot) {
    filtered = filtered.filter((p) => p.type === "Spot");
  }
  if (filterUsdt) {
    filtered = filtered.filter((p) => p.type === "PerpetualV2" && p.settleCurrency === "USDT");
  }
  if (filterCoin) {
    filtered = filtered.filter((p) => p.type === "Perpetual" || p.type === "PerpetualV1");
  }
  if (filterSymbol) {
    const kw = filterSymbol.toLowerCase();
    filtered = filtered.filter((p) => p.symbol.toLowerCase().includes(kw));
  }

  filtered.sort((a, b) => a.symbol.localeCompare(b.symbol));

  if (asJson) {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }

  if (filtered.length === 0) {
    console.log(`No symbols match the given filters (${products.length} total).`);
    return;
  }

  const wSym = Math.max(6, ...filtered.map((p) => p.symbol.length));
  const wType = Math.max(4, ...filtered.map((p) => p.type.length));
  const wSettle = Math.max(6, ...filtered.map((p) => (p.settleCurrency ?? "—").length));

  const sep = "─".repeat(wSym + wType + wSettle + 6);
  console.log(`  ${"Symbol".padEnd(wSym)}  ${"Type".padEnd(wType)}  ${"Settle".padEnd(wSettle)}`);
  console.log(`  ${sep}`);

  for (const p of filtered) {
    console.log(
      `  ${p.symbol.padEnd(wSym)}  ` +
      `${p.type.padEnd(wType)}  ` +
      `${(p.settleCurrency ?? "—").padEnd(wSettle)}`,
    );
  }

  console.log(`\n  ${filtered.length} symbol(s)`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
