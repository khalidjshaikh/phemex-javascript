#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-cancel-untriggered-by-price.ts  —  Cancel untriggered orders
 * with a limit/trigger price above a given threshold.
 *
 * Usage:
 *   npx tsx phemex-cancel-untriggered-by-price.ts --symbol XTIUSDT --min-price 70
 *   npx tsx phemex-cancel-untriggered-by-price.ts --symbol XTIUSDT --min-price 70 --dry-run
 */

import { request, base64UrlDecode } from "./src/http-client.js";
import { getArg, hasFlag } from "./src/cli-utils.js";
import { loadCredentialsLocal } from "./src/credentials.js";
import { cancelOrder } from "./src/place-limit-order.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function usage(): never {
  console.log(`
Usage: ./phemex-cancel-untriggered-by-price.ts --symbol <symbol> --min-price <num> [--max-price <num>] [--dry-run]

Cancel untriggered orders where the limit price > min-price threshold.

Options:
  --symbol <symbol>   Trading pair (e.g. BTCUSDT, XTIUSDT)
  --min-price <num>   Cancel orders with limit price above this value
  --max-price <num>   Optional upper bound (cancel orders with limit price <= max-price)
  --dry-run           Show what would be cancelled without executing
  --help, -h          Show this help message

Examples:
  ./phemex-cancel-untriggered-by-price.ts --symbol XTIUSDT --min-price 70
  ./phemex-cancel-untriggered-by-price.ts --symbol XTIUSDT --min-price 70 --dry-run
  ./phemex-cancel-untriggered-by-price.ts --symbol BTCUSD --min-price 50000 --max-price 60000
`);
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) usage();

  const symbol = getArg("--symbol");
  const minPriceStr = getArg("--min-price");
  const maxPriceStr = getArg("--max-price");
  if (!symbol || !minPriceStr) usage();

  const minPrice = parseFloat(minPriceStr);
  const maxPrice = maxPriceStr ? parseFloat(maxPriceStr) : Infinity;
  if (isNaN(minPrice)) { console.error("✗  --min-price must be a number"); process.exit(1); }

  const dryRun = hasFlag("--dry-run");

  const isUsdtM = symbol.toUpperCase().endsWith("USDT");
  const endpoint = isUsdtM ? "/g-orders/activeList" : "/orders/activeList";
  const query = `ordStatus=Untriggered&symbol=${symbol}`;

  const creds = loadCredentialsLocal();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  console.log(`⟐  Fetching untriggered orders for ${symbol} …`);

  const resp = await request("GET", endpoint, query, creds.PHEMEX_API_KEY, secretRaw, "");

  if (resp.code !== 0) {
    console.error(`  ✗  API error: ${String(resp.msg ?? resp.code)}`);
    process.exit(1);
  }

  const data = resp.data as Record<string, unknown> | undefined;
  const rows = (data?.rows as Record<string, unknown>[] | undefined) ?? [];

  if (rows.length === 0) {
    console.log("  ℹ  No untriggered orders found.");
    return;
  }

  // Filter orders with limit/trigger price > minPrice (and <= maxPrice if set)
  // USDT-M uses priceRp   Coin-M uses price
  const targets = rows.filter((o) => {
    const priceStr = String(o.priceRp ?? o.price ?? "");
    const price = parseFloat(priceStr);
    return !isNaN(price) && price > minPrice && price <= maxPrice;
  });

  if (targets.length === 0) {
    console.log(`  ℹ  No untriggered orders with price > ${minPrice}${maxPrice < Infinity ? ` and <= ${maxPrice}` : ""} found.`);
    return;
  }

  // Determine position side: Buy → Long, Sell → Short
  function posSideFor(side: string): string {
    return side.toLowerCase() === "buy" ? "Long" : "Short";
  }

  if (dryRun) {
    console.log(`\n  DRY RUN — Would cancel ${targets.length} order(s):\n`);
    for (const o of targets) {
      const oid = String(o.orderID ?? "?");
      const side = String(o.side ?? "?");
      const price = String(o.priceRp ?? o.price ?? "?");
      console.log(`  ${oid}  ${side}  limit @ ${price}  (posSide: ${posSideFor(side)})`);
    }
    console.log();
    return;
  }

  console.log(`  ✓  Found ${targets.length} untriggered order(s) with price > ${minPrice}. Cancelling …\n`);

  const cancelPromises = targets.map(async (o) => {
    const orderId = String(o.orderID ?? "");
    const side = String(o.side ?? "Buy");
    const price = String(o.priceRp ?? o.price ?? "?");
    const posSide = posSideFor(side);

    process.stdout.write(`  ${orderId}  ${side} @ ${price}  …  `);

    try {
      const r = await cancelOrder({ symbol, orderId, posSide }, creds.PHEMEX_API_KEY, secretRaw);
      if (r.code === 0) {
        console.log("✓");
        return { ok: 1, fail: 0 };
      } else {
        console.log(`✗  ${String(r.msg ?? r.code)}`);
        return { ok: 0, fail: 1 };
      }
    } catch (err: unknown) {
      console.log(`✗  ${err instanceof Error ? err.message : String(err)}`);
      return { ok: 0, fail: 1 };
    }
  });

  const results = await Promise.all(cancelPromises);
  const ok = results.reduce((s, r) => s + r.ok, 0);
  const fail = results.reduce((s, r) => s + r.fail, 0);

  console.log(`\n  Done — ${ok} cancelled, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
