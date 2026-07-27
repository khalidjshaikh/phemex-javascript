#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-cli.ts  —  Unified CLI for Phemex trading tasks.
 *
 * Usage:
 *   npx tsx phemex-cli.ts list_symbols [--perp] [--spot] [--status Listed] [--symbol BTC] [--json]
 *   npx tsx phemex-cli.ts list_symbols --help
 */

import { publicGet, request, httpGet, base64UrlDecode } from "./src/http-client.js";
import { getArg, hasFlag, apiPath } from "./src/cli-utils.js";
import { loadCredentialsLocal } from "./src/credentials.js";

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
  list_symbols       List all available trading symbols / products
  get_open_orders    List open orders for a symbol
  cancel_order       Cancel a specific order by orderID (and posSide)
  cancel_all_orders  Cancel ALL orders (including untriggered) for a symbol

Options for list_symbols:
  --perp              Show only perpetual products
  --spot              Show only spot products
  --status <status>   Filter by status (e.g. Listed, Suspended)
  --symbol <keyword>  Filter by symbol (case-insensitive substring match)
  --json              Output raw JSON

Options for get_open_orders:
  --symbol  <pair>   (required) Trading pair symbol, e.g. XTIUSDT, BTCUSDT
  --posSide <side>   (optional) Filter by position side: Long or Short (default: both)
  --json             (optional) Output raw JSON

Options for cancel_order:
  --symbol  <pair>   (required) Trading pair symbol, e.g. XTIUSDT, BTCUSDT
  --orderID <id>     (required) Order ID to cancel
  --posSide <side>   (required) Position side: Long or Short
  --dry-run          (optional) Print the request without sending it

Options for cancel_all_orders:
  --symbol  <pair>   (required) Trading pair symbol, e.g. XTIUSDT, BTCUSDT
  --posSide <side>   (optional) Position side: Long or Short (default: both)
  --dry-run          (optional) Print the request without sending it

  --help, -h         Show this help
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
/*  cancel_all_orders                                                  */
/* ------------------------------------------------------------------ */

async function cancelAllOrders(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) usage();

  const symbol = getArg("--symbol");
  if (!symbol) {
    console.error("✗  --symbol is required (e.g. --symbol XTIUSDT)");
    usage();
  }

  const dryRun = hasFlag("--dry-run");
  const posSideRaw = getArg("--posSide");
  const posSide = posSideRaw
    ? posSideRaw.charAt(0).toUpperCase() + posSideRaw.slice(1).toLowerCase()
    : undefined;
  if (posSide && !["Long", "Short"].includes(posSide)) {
    console.error(`✗  Invalid --posSide "${posSideRaw}" — must be Long or Short`);
    process.exit(1);
  }

  const path = apiPath(symbol, "/all");
  const isUsdtM = symbol.endsWith("USDT");
  const untriggeredValues = isUsdtM ? ["false", "true"] : ["false"];

  if (dryRun) {
    console.log(`\n  DRY RUN — Would send:\n`);
    for (const u of untriggeredValues) {
      let q = `symbol=${symbol}&untriggered=${u}`;
      if (posSide) q += `&posSide=${posSide}`;
      console.log(`  DELETE ${path}?${q}`);
    }
    console.log();
    process.exit(0);
  }

  const creds = loadCredentialsLocal();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  const accountType = isUsdtM ? "USDT-M" : "COIN-M";
  console.log(`⟐  [${accountType}] Cancelling ALL orders for ${symbol} (including untriggered) …`);

  let totalClosed = 0;
  let totalUntriggered = 0;

  for (const u of untriggeredValues) {
    let query = `symbol=${symbol}&untriggered=${u}`;
    if (posSide) query += `&posSide=${posSide}`;

    const resp = await request("DELETE", path, query, creds.PHEMEX_API_KEY, secretRaw, "");

    if (resp.code === 0) {
      const data = resp.data as Record<string, unknown> | undefined;
      const closedOrders = (data?.closedOrders as Record<string, unknown>[] | undefined) ?? [];
      const untriggered = (data?.untriggered as Record<string, unknown>[] | undefined) ?? [];
      totalClosed += closedOrders.length;
      totalUntriggered += untriggered.length;
      if (closedOrders.length > 0 || untriggered.length > 0) {
        for (const o of closedOrders) {
          console.log(`  ✓  Cancelled: ${String(o.orderID ?? "?")}  ${String(o.side ?? "?")}  qty ${String(o.qty ?? "?")}`);
        }
        for (const o of untriggered) {
          console.log(`  ✓  Cancelled (conditional): ${String(o.orderID ?? "?")}  ${String(o.side ?? "?")}  qty ${String(o.qty ?? "?")}`);
        }
      }
    } else {
      console.error(`  ✗  API error: ${String(resp.msg ?? resp.code)}`);
    }
  }

  console.log(`  ✓  Done — ${totalClosed} open + ${totalUntriggered} conditional order(s) cancelled`);
}

/* ------------------------------------------------------------------ */
/*  get_open_orders                                                    */
/* ------------------------------------------------------------------ */

async function getOpenOrders(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) usage();

  const symbol = getArg("--symbol");
  if (!symbol) {
    console.error("✗  --symbol is required (e.g. --symbol XTIUSDT)");
    usage();
  }

  const asJson = getFlag("--json");
  const posSideRaw = getArg("--posSide");
  const posSide = posSideRaw
    ? posSideRaw.charAt(0).toUpperCase() + posSideRaw.slice(1).toLowerCase()
    : undefined;
  if (posSide && !["Long", "Short"].includes(posSide)) {
    console.error(`✗  Invalid --posSide "${posSideRaw}" — must be Long or Short`);
    process.exit(1);
  }

  const isUsdtM = symbol.endsWith("USDT");
  const path = isUsdtM ? "/g-orders/openList" : "/orders/openList";
  const accountType = isUsdtM ? "USDT-M" : "COIN-M";

  const creds = loadCredentialsLocal();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  let query = `symbol=${symbol}`;
  if (posSide) query += `&posSide=${posSide}`;

  console.log(`⟐  [${accountType}] Fetching open orders for ${symbol} …`);

  const resp = await httpGet(path, query, creds.PHEMEX_API_KEY, secretRaw);

  if (resp.code !== 0) {
    console.error(`✗  API error: ${String(resp.msg ?? resp.code)}`);
    process.exit(1);
  }

  const rows = (resp.data as Record<string, unknown>[] | undefined) ?? [];

  if (asJson) {
    console.log(JSON.stringify({ symbol, orders: rows }, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log(`  No open orders for ${symbol}${posSide ? ` (${posSide})` : ""}.`);
    return;
  }

  console.log(`  ${rows.length} open order(s):\n`);

  const wOrd   = Math.max(7, ...rows.map((r) => String(r.orderID ?? "").length));
  const wSide  = Math.max(4, ...rows.map((r) => String(r.side ?? "").length));
  const wQty   = 14;
  const wPrice = 14;
  const wType  = Math.max(4, ...rows.map((r) => String(r.ordType ?? "").length));
  const wPxDisplay = Math.max(10, ...rows.map((r) => String(r.priceEp ?? "").length));

  console.log(`  ${padRight("orderID", wOrd)}  ${padRight("Side", wSide)}  ${padRight("Qty", wQty)}  ${padRight("Price", wPrice)}  ${padRight("Type", wType)}  ${padRight("DisplayPx", wPxDisplay)}`);
  console.log(`  ${"─".repeat(wOrd + wSide + wQty + wPrice + wType + wPxDisplay + 10)}`);

  for (const r of rows) {
    console.log(
      `  ${padRight(String(r.orderID ?? ""), wOrd)}  ` +
      `${padRight(String(r.side ?? ""), wSide)}  ` +
      `${padRight(String(r.qty ?? ""), wQty)}  ` +
      `${padRight(String(r.priceEp ?? ""), wPrice)}  ` +
      `${padRight(String(r.ordType ?? ""), wType)}  ` +
      `${padRight(String(r.displayPriceEp ?? ""), wPxDisplay)}`,
    );
  }
  console.log();
}

/* ------------------------------------------------------------------ */
/*  cancel_order (single)                                              */
/* ------------------------------------------------------------------ */

async function cancelOrder(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) usage();

  const symbol = getArg("--symbol");
  if (!symbol) {
    console.error("✗  --symbol is required (e.g. --symbol XTIUSDT)");
    usage();
  }

  const orderID = getArg("--orderID");
  if (!orderID) {
    console.error("✗  --orderID is required");
    usage();
  }

  const posSideRaw = getArg("--posSide");
  if (!posSideRaw) {
    console.error("✗  --posSide is required (Long or Short)");
    usage();
  }
  const posSide = posSideRaw.charAt(0).toUpperCase() + posSideRaw.slice(1).toLowerCase();
  if (!["Long", "Short"].includes(posSide)) {
    console.error(`✗  Invalid --posSide "${posSideRaw}" — must be Long or Short`);
    process.exit(1);
  }

  const dryRun = getFlag("--dry-run");
  const isUsdtM = symbol.endsWith("USDT");
  const path = isUsdtM ? "/g-orders/cancel" : "/orders/cancel";
  const accountType = isUsdtM ? "USDT-M" : "COIN-M";

  const query = `symbol=${symbol}&orderID=${orderID}&posSide=${posSide}`;

  if (dryRun) {
    console.log(`\n  DRY RUN — Would send:\n`);
    console.log(`  DELETE ${path}?${query}`);
    console.log();
    process.exit(0);
  }

  const creds = loadCredentialsLocal();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  console.log(`⟐  [${accountType}] Cancelling order ${orderID} for ${symbol} (${posSide}) …`);

  const resp = await request("DELETE", path, query, creds.PHEMEX_API_KEY, secretRaw, "");

  if (resp.code === 0) {
    console.log(`  ✓  Order ${orderID} cancelled successfully`);
  } else {
    console.error(`  ✗  API error: ${String(resp.msg ?? resp.code)}`);
    process.exit(1);
  }
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
    case "get_open_orders":
      await getOpenOrders();
      break;
    case "cancel_order":
      await cancelOrder();
      break;
    case "cancel_all_orders":
      await cancelAllOrders();
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
