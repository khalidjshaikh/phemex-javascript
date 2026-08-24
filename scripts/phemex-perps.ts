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
 *   npx tsx scripts/phemex-perps.ts --decimals 4       # price decimal places (default: 2)
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
  --decimals <N>  Price decimal places (default: 2)
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
  const decimalsArg = getArg("--decimals");
  const decimals = decimalsArg ? Math.max(0, parseInt(decimalsArg, 10) || 2) : 2;
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

  // Fetch all tickers in parallel
  const tickerPromises = products.map((p) =>
    publicGet("/md/v2/ticker/24hr", `symbol=${p.symbol}`) as Promise<{
      error?: unknown;
      result?: TickerResult;
    }>,
  );
  const tickerResults = await Promise.all(tickerPromises);

  const rows: Record<string, unknown>[] = [];

  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    const t = tickerResults[i].result;
    const last = parseFloat(t?.closeRp ?? "0");
    const index = parseFloat(t?.indexPriceRp ?? "0");

    const minQty = parseFloat(p.qtyStepSize ?? "1");
    const notional = last * minQty;
    const takerFee = notional * 0.0006; // 0.06% taker fee
    const maxLev = Number(p.maxLeverage ?? p.defaultLeverage ?? 0);

    rows.push({
      symbol: p.symbol,
      last,
      index,
      iMinusL: index - last,
      maxLev,
      minQty: p.qtyStepSize ?? "—",
      notional,
      takerFee,
      roundTrip: takerFee * 2,
    });
  }

  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  const wSym = Math.max(7, ...rows.map((r) => String(r.symbol).length));
  const wLast = Math.max(7, ...rows.map((r) => fmtNum(r.last, decimals).length));
  const wIdx = Math.max(7, ...rows.map((r) => fmtNum(r.index, decimals).length));
  const wIL = Math.max(5, ...rows.map((r) => fmtDelta(r.iMinusL, decimals).length));
  const wLev = Math.max(8, ...rows.map((r) => fmtLev(r.maxLev).length));
  const wMinQ = Math.max(8, ...rows.map((r) => String(r.minQty).length));
  const wNotional = Math.max(10, ...rows.map((r) => fmtFee(r.notional, decimals).length));
  const wTaker = Math.max(10, ...rows.map((r) => fmtFee(r.takerFee, decimals).length));
  const wRoundTrip = Math.max(10, ...rows.map((r) => fmtFee(r.roundTrip, decimals).length));

  const sep = "─".repeat(wSym + wLast + wIdx + wIL + wLev + wMinQ + wNotional + wTaker + wRoundTrip + 22);
  console.log(
    `  ${"Symbol".padEnd(wSym)}  ${"Last".padStart(wLast)}  ${"Index".padStart(wIdx)}  ${"I-L".padStart(wIL)}  ${"Lev".padStart(wLev)}  ${"MinQty".padEnd(wMinQ)}  ${"Notional".padStart(wNotional)}  ${"Taker".padStart(wTaker)}  ${"2×Taker".padStart(wRoundTrip)}`,
  );

  for (const r of rows) {
    console.log(
      `  ${String(r.symbol).padEnd(wSym)}  ` +
      `${fmtNum(r.last, decimals).padStart(wLast)}  ` +
      `${fmtNum(r.index, decimals).padStart(wIdx)}  ` +
      `${fmtDelta(r.iMinusL, decimals).padStart(wIL)}  ` +
      `${fmtLev(r.maxLev).padStart(wLev)}  ` +
      `${String(r.minQty).padEnd(wMinQ)}  ` +
      `${fmtFee(r.notional, decimals).padStart(wNotional)}  ` +
      `${fmtFee(r.takerFee, decimals).padStart(wTaker)}  ` +
      `${fmtFee(r.roundTrip, decimals).padStart(wRoundTrip)}`,
    );
  }

  console.log(`\n  ${rows.length} symbol(s)`);
}

function fmtNum(v: unknown, dec = 2): string {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(dec) : "—";
}

function fmtLev(v: unknown): string {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? `${n}×` : "—";
}

function fmtDelta(v: unknown, dec = 2): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  const s = n.toFixed(dec);
  return n > 0 ? `+${s}` : s;
}

function fmtFee(v: unknown, dec = 6): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `$${n.toFixed(dec)}`;
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
