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
 *   npx tsx scripts/phemex-perps.ts --sort 2xtaker     # sort by 2×Taker
 *   npx tsx scripts/phemex-perps.ts --sort 2xtaker --desc  # sort 2×Taker descending
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
  --symbol <kw>     Filter by symbol substring
  --decimals <N>    Price decimal places (default: 2)
  --sort <field>    Sort by: symbol (default) or 2xtaker
  --order <dir>     Sort direction: asc or desc (default: asc)
  --asc             Sort 2×Taker ascending
  --desc            Sort 2×Taker descending
  --sort-2xtaker <dir>  Sort by 2×Taker: asc or desc
  --json            Output raw JSON
  --help            Show this help
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

  // ---- Sort by 2×Taker option parsing (flexible) ----
  const FIELD_ALIASES = /2x|taker|round|trip/i;
  function norm(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]/g, "");
  }
  const ASC_WORDS = new Set(["asc", "ascending", "up", "increasing", "lowtohigh", "smallestfirst", "lowestfirst"]);
  const DESC_WORDS = new Set(["desc", "descending", "down", "decreasing", "hightolow", "largestfirst", "highestfirst", "reverse"]);

  let sort2x = false;
  let sortDir: "asc" | "desc" = "asc";

  function setField(): void { sort2x = true; }
  function setDir(d: "asc" | "desc"): void { sortDir = d; sort2x = true; }

  function parseCombo(v: string): { field: boolean; dir: "asc" | "desc" | null } {
    const n = norm(v);
    let field = FIELD_ALIASES.test(n) || n.includes("2xtaker") || n.includes("roundtrip") || n.includes("twotaker");
    let dir: "asc" | "desc" | null = null;
    if (ASC_WORDS.has(n) || n.endsWith("asc") || n.includes("asc")) dir = "asc";
    if (DESC_WORDS.has(n) || n.endsWith("desc") || n.includes("desc")) dir = "desc";
    if (field && (n.includes("asc") || n.includes("desc"))) {
      // combined
    }
    return { field, dir };
  }

  const rawArgs = process.argv.slice(2);
  for (let i = 0; i < rawArgs.length; i++) {
    let token = rawArgs[i];
    let val: string | undefined;
    if (token.includes("=") && token.startsWith("--")) {
      const eq = token.indexOf("=");
      val = token.slice(eq + 1);
      token = token.slice(0, eq);
    }
    const name = token.replace(/^--/, "");
    const nname = norm(name);
    const next = i + 1 < rawArgs.length && !rawArgs[i + 1].startsWith("--") ? rawArgs[i + 1] : undefined;

    // container sort/order options
    if (nname === "sort" || nname === "sortby" || nname === "orderby" || nname === "sortfield" || nname === "sortkey") {
      const v = val ?? next;
      if (v !== undefined) {
        if (val === undefined) i++;
        const vn = norm(v);
        const c = parseCombo(v);
        if (c.field) setField();
        if (c.dir) setDir(c.dir);
        if (ASC_WORDS.has(vn)) { setField(); setDir("asc"); }
        if (DESC_WORDS.has(vn)) { setField(); setDir("desc"); }
        if (c.field && !c.dir) sort2x = true;
      }
    }

    // order/direction containers
    if (nname === "order" || nname === "direction" || nname === "dir" || nname === "sortorder" || nname === "sortdir" || nname === "orderdir") {
      const v = val ?? next;
      if (v !== undefined) {
        if (val === undefined) i++;
        const vn = norm(v);
        if (ASC_WORDS.has(vn) || vn.includes("asc")) { setField(); setDir("asc"); }
        if (DESC_WORDS.has(vn) || vn.includes("desc")) { setField(); setDir("desc"); }
      }
    }

    // dedicated 2xtaker options
    if (nname.includes("2xtaker") || nname.includes("roundtrip") || nname.includes("twotaker") || nname.includes("2xtakerfee")) {
      if (nname.includes("desc")) { setField(); setDir("desc"); }
      else if (nname.includes("asc")) { setField(); setDir("asc"); }
      else {
        const v = val ?? next;
        if (v !== undefined) {
          if (val === undefined) i++;
          const vn = norm(v);
          if (ASC_WORDS.has(vn) || vn.includes("asc")) { setField(); setDir("asc"); }
          else if (DESC_WORDS.has(vn) || vn.includes("desc")) { setField(); setDir("desc"); }
          else { setField(); }
        } else {
          setField();
        }
      }
    }

    // standalone asc/desc flags
    if (nname === "asc" || nname === "ascending" || nname === "increasing") setDir("asc");
    if (nname === "desc" || nname === "descending" || nname === "decreasing" || nname === "reverse") setDir("desc");
  }

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

  if (sort2x) {
    rows.sort((a, b) => {
      const va = Number(a.roundTrip);
      const vb = Number(b.roundTrip);
      const base = (Number.isFinite(va) ? va : 0) - (Number.isFinite(vb) ? vb : 0);
      const cmp = sortDir === "desc" ? -base : base;
      if (cmp !== 0) return cmp;
      return String(a.symbol).localeCompare(String(b.symbol));
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
