#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-perps.ts — List USDT-M perpetual futures with price, index, and min trade size.
 *
 * Public endpoint, no credentials needed.
 *
 * Usage:
 *   npx tsx scripts/phemex-perps.ts                    # all listed USDT-M perps
 *   npx tsx scripts/phemex-perps.ts --symbol BTC       # filter by substring
 *   npx tsx scripts/phemex-perps.ts --json             # raw JSON output
 *   npx tsx scripts/phemex-perps.ts --help             # show help
 */

import { publicGet } from "../src/http-client.js";
import { getArg, hasFlag } from "../src/cli-utils.js";

function usage(): never {
  console.log(`
Usage: npx tsx scripts/phemex-perps.ts [options]

List USDT-M perpetual futures with price, index, and min trade size.

Options:
  --symbol <kw>   Filter by symbol substring
  --json          Output raw JSON
  --help          Show this help
`);
  process.exit(0);
}

interface Product {
  symbol: string;
  status: string;
  qtyStepSize?: string;
  qtyPrecision?: number;
  minOrderValueRv?: string;
  maxOrderQtyRq?: string;
  [key: string]: unknown;
}

interface TickerResult {
  closeRp?: string;
  indexPriceRp?: string;
  markPriceRp?: string;
  [key: string]: unknown;
}

async function main(): Promise<void> {
  if (hasFlag("--help")) usage();

  const filterSymbol = getArg("--symbol");
  const asJson = hasFlag("--json");

  const prodResp = (await publicGet("/public/products", null)) as unknown as {
    code?: number;
    data?: { perpProductsV2?: Product[] };
  };

  let products = (prodResp.data?.perpProductsV2 ?? []).filter(
    (p) => p.status === "Listed" && (p.settleCurrency as string) === "USDT",
  );

  if (filterSymbol) {
    const kw = filterSymbol.toLowerCase();
    products = products.filter((p) => p.symbol.toLowerCase().includes(kw));
  }

  products.sort((a, b) => a.symbol.localeCompare(b.symbol));

  if (products.length === 0) {
    console.log("No USDT-M perpetuals found.");
    return;
  }

  const rows: Record<string, unknown>[] = [];

  for (const p of products) {
    const tickerResp = (await publicGet(
      "/md/v2/ticker/24hr",
      `symbol=${p.symbol}`,
    )) as unknown as {
      error?: unknown;
      result?: TickerResult;
    };

    const t = tickerResp.result;
    const last = parseFloat(t?.closeRp ?? "0");
    const index = parseFloat(t?.indexPriceRp ?? "0");

    const minQty = parseFloat(p.qtyStepSize ?? "1");
    const notional = last * minQty;
    const takerFee = notional * 0.0006; // 0.06% taker fee

    rows.push({
      symbol: p.symbol,
      last,
      index,
      iMinusL: index - last,
      minQty: p.qtyStepSize ?? "—",
      takerFee,
    });
  }

  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  const wSym = Math.max(7, ...rows.map((r) => String(r.symbol).length));
  const wLast = Math.max(7, ...rows.map((r) => fmtNum(r.last).length));
  const wIdx = Math.max(7, ...rows.map((r) => fmtNum(r.index).length));
  const wIL = Math.max(5, ...rows.map((r) => fmtDelta(r.iMinusL).length));
  const wMinQ = Math.max(8, ...rows.map((r) => String(r.minQty).length));
  const wTaker = Math.max(10, ...rows.map((r) => fmtFee(r.takerFee).length));

  const sep = "─".repeat(wSym + wLast + wIdx + wIL + wMinQ + wTaker + 18);
  console.log(
    `  ${"Symbol".padEnd(wSym)}  ${"Last".padStart(wLast)}  ${"Index".padStart(wIdx)}  ${"I-L".padStart(wIL)}  ${"MinQty".padEnd(wMinQ)}  ${"Taker Fee".padStart(wTaker)}`,
  );
  console.log(`  ${sep}`);

  for (const r of rows) {
    console.log(
      `  ${String(r.symbol).padEnd(wSym)}  ` +
      `${fmtNum(r.last).padStart(wLast)}  ` +
      `${fmtNum(r.index).padStart(wIdx)}  ` +
      `${fmtDelta(r.iMinusL).padStart(wIL)}  ` +
      `${String(r.minQty).padEnd(wMinQ)}  ` +
      `${fmtFee(r.takerFee).padStart(wTaker)}`,
    );
  }

  console.log(`\n  ${rows.length} symbol(s)`);
}

function fmtNum(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : "—";
}

function fmtDelta(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  const s = n.toFixed(2);
  return n > 0 ? `+${s}` : s;
}

function fmtFee(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  if (n < 0.01) return `$${n.toFixed(6)}`;
  return `$${n.toFixed(4)}`;
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
