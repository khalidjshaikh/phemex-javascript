#!/usr/bin/env node

/**
 * Phemex Cancel All Orders — cancels every open order across all account types.
 *
 * Reads credentials from .phemex-credentials.json.
 *
 * Usage:
 *   npx tsx phemex-cancel-all-orders.ts              # cancel on every symbol
 *   npx tsx phemex-cancel-all-orders.ts --account Coin-M   # Coin-M only
 *   npx tsx phemex-cancel-all-orders.ts --account USDT-M   # USDT-M only
 *   npx tsx phemex-cancel-all-orders.ts --account Spot     # Spot only
 *   npx tsx phemex-cancel-all-orders.ts --help             # show help
 */

import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ── Types ─────────────────────────────────────────────────

interface Credentials {
  PHEMEX_API_KEY: string;
  PHEMEX_API_SECRET: string;
}

interface Product {
  symbol: string;
  type: string; // "Perpetual" | "Spot"
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

type AccountCategory = "Coin-M" | "USDT-M" | "Spot";

// ── Helpers ───────────────────────────────────────────────

function base64UrlDecode(s: string): Buffer {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

function sign(
  _method: string,
  path: string,
  query: string | null,
  expiry: number,
  secretRaw: Buffer,
  body: string
): string {
  const queryStr = query ?? "";
  const payload = path + queryStr + expiry + body;
  return crypto.createHmac("sha256", secretRaw).update(payload).digest("hex");
}

/**
 * Generic signed HTTP request (extends the active-orders pattern to support DELETE).
 */
async function request(
  method: "GET" | "POST" | "DELETE",
  urlPath: string,
  query: string | null,
  apiKey: string,
  secretRaw: Buffer,
  body: string
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const expiry = Math.floor(Date.now() / 1000) + 60;
    const sig = sign(method, urlPath, query, expiry, secretRaw, body);
    const qs = query ? "?" + query : "";

    const req = https.request(
      {
        hostname: "api.phemex.com",
        path: urlPath + qs,
        method,
        headers: {
          "x-phemex-access-token": apiKey,
          "x-phemex-request-expiry": String(expiry),
          "x-phemex-request-signature": sig,
          "Content-Type": "application/json",
        },
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
    if (body) req.write(body);
    req.end();
  });
}

/** Unauthenticated GET for public endpoints. */
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

function loadCredentials(): Credentials {
  const credsPath = path.resolve(import.meta.dirname, ".phemex-credentials.json");
  if (!fs.existsSync(credsPath)) {
    console.error("✗  Missing .phemex-credentials.json");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(credsPath, "utf8"));
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return undefined;
}

function usage(): never {
  console.log(`
Usage: npx tsx phemex-cancel-all-orders.ts [options]

Cancel every open order across all Phemex account types.

Options:
  --account <type>   Limit to one account type: Coin-M, USDT-M, or Spot
  --help, -h         Show this help message

Examples:
  npx tsx phemex-cancel-all-orders.ts               # cancel on all accounts
  npx tsx phemex-cancel-all-orders.ts --account Coin-M   # Coin-M only
  npx tsx phemex-cancel-all-orders.ts --account USDT-M   # USDT-M only
  npx tsx phemex-cancel-all-orders.ts --account Spot     # Spot only
`);
  process.exit(0);
}

// ── Category / Endpoint helpers ──────────────────────────

function categoryOf(product: Product): AccountCategory | null {
  if (product.status !== "Listed") return null;
  const t = product.type;
  if (t === "Perpetual" && product.settleCurrency !== "USDT") return "Coin-M";
  if (t === "Perpetual" && product.settleCurrency === "USDT") return "USDT-M";
  if (t === "Spot") return "Spot";
  return null;
}

/** Active-list endpoint for each category. */
function listEndpointFor(cat: AccountCategory): string {
  if (cat === "Coin-M") return "/orders/activeList";
  if (cat === "USDT-M") return "/g-orders/activeList";
  return "/spot/orders"; // Spot
}

/** Cancel-all endpoint for each category. */
function cancelEndpointFor(cat: AccountCategory): string {
  if (cat === "Coin-M") return "/orders/cancelAll";
  if (cat === "USDT-M") return "/g-orders/cancelAll";
  return "/spot/orders/all"; // Spot
}

function queryFor(cat: AccountCategory, symbol: string): string {
  return `symbol=${symbol}`;
}

// ── Core logic ───────────────────────────────────────────

interface CancelResult {
  cat: AccountCategory;
  symbol: string;
  orderID: string;
  status: "cancelled" | "failed";
  error?: string;
}

async function cancelAll(creds: Credentials, secretRaw: Buffer, filterCat?: AccountCategory): Promise<void> {
  // ── 1. Fetch products ─────────────────────────────────
  process.stdout.write("⟐  Fetching product list … ");
  const prodResp = (await publicGet("/public/products", null)) as unknown as ProductsResponse;
  if (prodResp.code !== 0) {
    console.error(`Failed to fetch products: ${prodResp.msg ?? prodResp.code}`);
    process.exit(1);
  }
  const allProducts = prodResp.data?.products ?? [];
  console.log(`${allProducts.length} products`);

  // ── 2. Categorize ─────────────────────────────────────
  const byCategory: Map<AccountCategory, Product[]> = new Map();
  for (const p of allProducts) {
    const cat = categoryOf(p);
    if (cat) {
      const list = byCategory.get(cat) ?? [];
      list.push(p);
      byCategory.set(cat, list);
    }
  }

  const CONCURRENCY = 5;

  // ── 3. Fetch active orders per symbol ─────────────────
  const ordersToCancel: { cat: AccountCategory; symbol: string; orderID: string }[] = [];

  for (const [cat, products] of byCategory) {
    if (filterCat && cat !== filterCat) continue;

    const endpoint = listEndpointFor(cat);
    const symbols = products.map((p) => p.symbol);
    process.stdout.write(`\n⟐  Listing active orders for ${cat} (${symbols.length} symbols) … `);

    let found = 0;

    for (let i = 0; i < symbols.length; i += CONCURRENCY) {
      const batch = symbols.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((sym) =>
          request("GET", endpoint, queryFor(cat, sym), creds.PHEMEX_API_KEY, secretRaw, "")
            .then((r) => ({ sym, resp: r }))
        )
      );

      for (const r of results) {
        if (r.status === "fulfilled") {
          const { sym, resp } = r.value;
          if (resp.code === 0) {
            const orders: { orderID: string }[] =
              cat === "Spot"
                ? (resp.data as unknown as { orderID: string }[] | undefined) ?? []
                : ((resp.data as Record<string, unknown> | undefined)?.orders as { orderID: string }[] | undefined) ?? [];

            for (const o of orders) {
              ordersToCancel.push({ cat, symbol: sym, orderID: o.orderID });
              found++;
            }
          }
        }
      }
    }

    console.log(`${found} active order(s)`);
  }

  if (ordersToCancel.length === 0) {
    console.log("\n✓  No active orders to cancel.\n");
    return;
  }

  console.log(`\n${"═".repeat(80)}`);
  console.log(`  Cancelling ${ordersToCancel.length} order(s) …`);
  console.log(`${"═".repeat(80)}`);

  // ── 4. Cancel all via cancelAll endpoint per symbol ───
  // Deduplicate by (cat, symbol) since cancelAll cancels every order on that symbol
  const targets = new Map<string, { cat: AccountCategory; symbol: string }>();
  for (const o of ordersToCancel) {
    const key = `${o.cat}::${o.symbol}`;
    targets.set(key, { cat: o.cat, symbol: o.symbol });
  }

  const targetList = Array.from(targets.values());
  let cancelled = 0;
  let failed = 0;
  const failedDetails: { cat: AccountCategory; symbol: string; error: string }[] = [];

  for (let i = 0; i < targetList.length; i += CONCURRENCY) {
    const batch = targetList.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((t) => {
        const ep = cancelEndpointFor(t.cat);
        const body = JSON.stringify({ symbol: t.symbol });
        return request("DELETE", ep, null, creds.PHEMEX_API_KEY, secretRaw, body)
          .then((resp) => ({ ...t, resp }));
      })
    );

    for (const r of results) {
      if (r.status === "fulfilled") {
        const { cat, symbol, resp } = r.value;
        if (resp.code === 0) {
          const data = resp.data as Record<string, unknown> | undefined;
          let count = 0;
          // CancelAll returns the list of cancelled orders in the response
          if (Array.isArray(data)) {
            count = data.length;
          } else if (data && Array.isArray(data.orders)) {
            count = data.orders.length;
          } else {
            // Spot returns the cancelled orders directly in data
            count = 1;
          }
          cancelled += count;
          console.log(`  ✓  [${cat}] ${symbol}  —  ${count} order(s) cancelled`);
        } else {
          failed++;
          failedDetails.push({ cat, symbol, error: String(resp.msg ?? resp.code) });
          console.log(`  ✗  [${cat}] ${symbol}  —  ${String(resp.msg ?? resp.code)}`);
        }
      } else {
        failed++;
        console.log(`  ✗  batch request failed: ${r.reason}`);
      }
    }
  }

  // ── 5. Summary ────────────────────────────────────────
  console.log(`\n${"═".repeat(80)}`);
  console.log(`  Done.  ${cancelled} order(s) cancelled  |  ${failed} symbol(s) failed`);
  if (failedDetails.length > 0) {
    console.log();
    for (const d of failedDetails) {
      console.log(`  ✗  [${d.cat}] ${d.symbol}: ${d.error}`);
    }
  }
  console.log(`${"═".repeat(80)}\n`);
}

// ── Main ─────────────────────────────────────────────────

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) usage();

  // No flags → show usage (safeguard against accidental mass cancellation)
  if (!hasFlag("--account")) usage();

  const creds = loadCredentials();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

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

  await cancelAll(creds, secretRaw, filterCat);
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
