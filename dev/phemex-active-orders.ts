#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-active-orders.ts  —  List active (open) orders across all Phemex accounts.
 *
 * Endpoints:
 *   GET /orders/activeList        (Coin-M  inverse perpetual)
 *   GET /g-orders/activeList      (USDT-M  linear perpetual)
 *   GET /spot/orders              (Spot)
 *
 * Usage:
 *   npx tsx phemex-active-orders.ts                  # --symbol BTCUSD (default)
 *   npx tsx phemex-active-orders.ts --all             # scan all accounts
 *   npx tsx phemex-active-orders.ts --symbol ETHUSD
 *   npx tsx phemex-active-orders.ts --symbol BTCUSDT
 */

import https from "node:https";
import { request, base64UrlDecode } from "../src/http-client.js";
import { getArg, hasFlag } from "../src/cli-utils.js";
import { Credentials, loadCredentials } from "../src/credentials.js";

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

interface ActiveOrder {
  orderID: string;
  clOrdID: string;
  symbol: string;
  side: "Buy" | "Sell";
  ordType: string;
  ordStatus: string;
  timeInForce: string;
  priceEp: number;
  price: number;
  stopPxEp: number;
  stopPx: number;
  orderQty: number;
  displayQty: number;
  cumQty: number;
  cumValueEv: number;
  cumValue: number;
  leavesQty: number;
  leavesValueEv: number;
  leavesValue: number;
  avgPxEp?: number;
  avgPx?: number;
  reduceOnly: boolean;
  closeOnTrigger: boolean;
  takeProfitEp: number;
  stopLossEp: number;
  triggerType: string;
  actionTimeNs: string;
  bizError: number;
  [key: string]: unknown;
}

interface ActiveListResponse {
  code: number;
  msg?: string;
  data?: {
    orders?: ActiveOrder[];
    total?: number;
  };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Public GET (no auth needed) */
async function publicGet(urlPath: string, query: string | null): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const qs = query ? "?" + query : "";
    const req = https.request(
      {
        hostname: "api.phemex.com",
        path: urlPath + qs,
        method: "GET",
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Bad JSON: ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

function loadCredentialsLocal(): Credentials {
  return loadCredentials(import.meta.dirname);
}

function usage(): never {
  console.log(`
Usage: npx tsx phemex-active-orders.ts [options]

Query open (active) orders from Phemex.

Options:
  --symbol <symbol>   Trading pair to query (default: BTCUSD)
                        Coin-M:  BTCUSD, ETHUSD, XRPUSD, …
                        USDT-M:  BTCUSDT, ETHUSDT, …
                        Spot:    BTCUSDT, ETHUSDT, …
  --all [--account <type>]
                      Scan every listed symbol, optionally filtered by
                      account type: Coin-M, USDT-M, or Spot
  --help, -h          Show this help message

Examples:
  npx tsx phemex-active-orders.ts                           # show help
  npx tsx phemex-active-orders.ts --symbol ETHUSD           # Coin-M ETHUSD
  npx tsx phemex-active-orders.ts --all                     # every account
  npx tsx phemex-active-orders.ts --all --account Coin-M    # Coin-M only
  npx tsx phemex-active-orders.ts --all --account USDT-M    # USDT-M only
  npx tsx phemex-active-orders.ts --all --account Spot      # Spot only
`);
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/*  Category helpers                                                   */
/* ------------------------------------------------------------------ */

type AccountCategory = "Coin-M" | "USDT-M" | "Spot";

function categoryOf(product: Product): AccountCategory | null {
  if (product.status !== "Listed") return null;
  const t = product.type;
  if (t === "Perpetual" && product.settleCurrency !== "USDT") return "Coin-M";
  if (t === "Perpetual" && product.settleCurrency === "USDT") return "USDT-M";
  if (t === "Spot") return "Spot";
  return null;
}

function endpointFor(cat: AccountCategory): string {
  if (cat === "Coin-M") return "/orders/activeList";
  if (cat === "USDT-M") return "/g-orders/activeList";
  return "/spot/orders"; // Spot
}

function queryFor(cat: AccountCategory, symbol: string): string {
  if (cat === "Spot") return `symbol=${symbol}`;
  // return `symbol=${symbol}&ordStatus=New&ordStatus=PartiallyFilled&ordStatus=Untriggered`;
  return `symbol=${symbol}`;
}

/** Parse a value from a potential scaled-Ev field, falling back to the pre-scaled field. */
function humanValue(o: ActiveOrder, field: string, scale: number): number {
  const epField = field + "Ep";
  const evField = field + "Ev";
  if (epField in o) return (o[epField] as number) / scale;
  if (evField in o) return (o[evField] as number) / 100_000_000; // fallback
  return 0;
}

/* ------------------------------------------------------------------ */
/*  Display helpers                                                    */
/* ------------------------------------------------------------------ */

function printTable(orders: ActiveOrder[], category: AccountCategory, _symbol?: string): void {
  if (orders.length === 0) return;

  // Determine format from a sample product scale (defaults)
  const isInverse = category === "Coin-M";
  const valDecimals = isInverse ? 8 : 2;

  for (const o of orders) {
    const sideFmt = o.side.padEnd(5);
    const typeFmt = (o.ordType || "Limit").padEnd(10);
    const qtyFmt = String(o.orderQty).padStart(8);
    const cumFmt = String(o.cumQty).padStart(8);
    const leavesFmt = String(o.leavesQty).padStart(8);
    const valueFmt = (o.leavesValue ?? 0).toFixed(valDecimals).padStart(14);
    const statusFmt = o.ordStatus.padEnd(16);
    const shortId = o.orderID ? o.orderID.slice(0, 8) + "…" : "".padEnd(9);

    console.log(
      `${shortId.padEnd(20)} ${o.symbol.padEnd(10)} ${sideFmt} ${typeFmt} ` +
      `${(o.price ?? 0).toFixed(2).padStart(12)} ${qtyFmt} ${cumFmt} ${leavesFmt} ${valueFmt} ${statusFmt}`
    );
  }
}

function printCategoryHeader(cat: AccountCategory, count: number): void {
  const label = cat === "Coin-M" ? "COIN-M (Inverse Perpetual)"
    : cat === "USDT-M" ? "USDⓈ-M (Linear Perpetual)"
    : "Spot";
  const sep = "─".repeat(130);
  console.log(`\n${sep}`);
  console.log(`  ${label}  —  ${count} active order(s)`);
  console.log(`${sep}`);
  if (count > 0) {
    console.log(
      `${"OrderID".padEnd(20)} ${"Symbol".padEnd(10)} ${"Side".padEnd(5)} ${"Type".padEnd(10)} ` +
      `${"Price".padStart(12)} ${"Qty".padStart(8)} ${"Filled".padStart(8)} ${"Leaves".padStart(8)} ` +
      `${"Value".padStart(14)} ${"Status".padEnd(16)}`
    );
  }
}

/* ------------------------------------------------------------------ */
/*  Modes                                                              */
/* ------------------------------------------------------------------ */

/** Query a single symbol */
async function singleSymbol(symbol: string, creds: Credentials, secretRaw: Buffer): Promise<void> {
  // Determine category from symbol pattern
  let cat: AccountCategory;
  let ep: string;
  if (symbol.endsWith("USDT")) {
    cat = "USDT-M";
    ep = "/g-orders/activeList";
  } else if (symbol.endsWith("USD")) {
    cat = "Coin-M";
    ep = "/orders/activeList";
  } else {
    cat = "Spot";
    ep = "/spot/orders";
  }

  const query = cat === "Spot"
    ? `symbol=${symbol}`
    // : `symbol=${symbol}&ordStatus=New&ordStatus=PartiallyFilled&ordStatus=Untriggered`;
    : `symbol=${symbol}`;

  process.stdout.write(`⟐  Fetching active orders for ${symbol} … `);
  const resp = (await request("GET", ep, query, creds.PHEMEX_API_KEY, secretRaw, "")) as unknown as ActiveListResponse;

  if (resp.code !== 0) {
    console.error(`API error: ${resp.msg ?? resp.code}`);
    process.exit(1);
  }

  const orders = (cat === "Spot" ? (resp.data as unknown as ActiveOrder[] | undefined) : resp.data?.orders) ?? [];
  const orderList = Array.isArray(orders) ? orders : [];
  console.log(`${orderList.length} active order(s)\n`);

  if (orderList.length === 0) {
    console.log("No active orders.");
    return;
  }

  printCategoryHeader(cat, orderList.length);
  printTable(orderList, cat, symbol);
  console.log();
}

/** Query all accounts, optionally filtered by category */
async function allAccounts(creds: Credentials, secretRaw: Buffer, filterCat?: AccountCategory): Promise<void> {
  // 1. Fetch products
  process.stdout.write("⟐  Fetching product list … ");
  const prodResp = (await publicGet("/public/products", null)) as unknown as ProductsResponse;
  if (prodResp.code !== 0) {
    console.error(`Failed to fetch products: ${prodResp.msg ?? prodResp.code}`);
    process.exit(1);
  }
  const allProducts = prodResp.data?.products ?? [];
  console.log(`${allProducts.length} products`);
  // console.log("allProducts:", JSON.stringify(allProducts, null, 2));

  // 2. Categorize
  const byCategory: Map<AccountCategory, Product[]> = new Map();
  for (const p of allProducts) {
    const cat = categoryOf(p);
    if (cat) {
      const list = byCategory.get(cat) ?? [];
      list.push(p);
      byCategory.set(cat, list);
    }
  }

  // 3. Query each category with concurrency limit (5 at a time)
  const CONCURRENCY = 5;
  let totalOrders = 0;
  const allResults: { cat: AccountCategory; orders: ActiveOrder[] }[] = [];

  for (const [cat, products] of byCategory) {
    // Apply account filter — skip non-matching categories
    if (filterCat && cat !== filterCat) continue;

    const endpoint = endpointFor(cat);
    const symbols = products.map((p) => p.symbol);
    process.stdout.write(`\n⟐  ${cat} (${symbols.length} symbols) … `);

    const catOrders: ActiveOrder[] = [];
    let successCount = 0;
    let errorCount = 0;

    // Process in batches
    for (let i = 0; i < symbols.length; i += CONCURRENCY) {
      const batch = symbols.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((sym) =>
          request(
            "GET",
            endpoint,
            queryFor(cat, sym),
            creds.PHEMEX_API_KEY,
            secretRaw,
            ""
          ).then((r) => ({ sym, resp: r as unknown as ActiveListResponse }))
        )
      );

      for (const r of results) {
        if (r.status === "fulfilled") {
          const { sym, resp } = r.value;
          if (resp.code === 0) {
            const orders = cat === "Spot"
              ? (resp.data as unknown as ActiveOrder[] | undefined) ?? []
              : resp.data?.orders ?? [];
            for (const o of orders) {
              catOrders.push(o);
            }
            if (orders.length > 0) successCount++;
          }
          // ignore empty responses silently
        } else {
          errorCount++;
        }
      }
    }

    allResults.push({ cat, orders: catOrders });
    totalOrders += catOrders.length;
    console.log(`${catOrders.length} active order(s)`);
  }

  // 4. Display
  console.log("\n" + "═".repeat(130));
  console.log(`  ALL ACCOUNTS  —  ${totalOrders} total active order(s)`);
  console.log("═".repeat(130));

  if (totalOrders === 0) {
    console.log("\n  No active orders across any account.\n");
    return;
  }

  for (const { cat, orders } of allResults) {
    if (orders.length === 0) continue;
    printCategoryHeader(cat, orders.length);
    printTable(orders, cat);
  }
  console.log("\n" + "═".repeat(130) + "\n");
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) usage();

  const hasSymbol = process.argv.includes("--symbol");
  const hasAll = hasFlag("--all");

  // No flags at all → show usage
  if (!hasSymbol && !hasAll) usage();

  const creds = loadCredentialsLocal();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  if (hasAll) {
    const accountRaw = getArg("--account");
    let filterCat: AccountCategory | undefined;
    if (accountRaw) {
      const input = accountRaw.toLowerCase().replace(/[_-]/g, "");
      const map: Record<string, AccountCategory> = {
        "coinm": "Coin-M",
        "coin-m": "Coin-M",
        "usdtm": "USDT-M",
        "usdt-m": "USDT-M",
        "spot": "Spot",
      };
      filterCat = map[input];
      if (!filterCat) {
        console.error(`✗  Invalid account type "${accountRaw}". Use Coin-M, USDT-M, or Spot.`);
        process.exit(1);
      }
    }
    await allAccounts(creds, secretRaw, filterCat);
  } else {
    const symbol = getArg("--symbol") ?? "BTCUSD";
    await singleSymbol(symbol, creds, secretRaw);
  }
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
