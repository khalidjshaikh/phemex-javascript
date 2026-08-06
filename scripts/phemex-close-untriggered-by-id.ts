#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-close-untriggered-by-id.ts  —  Close (cancel) untriggered orders
 * whose order ID falls inside a numeric range.
 *
 * Fetches the same untriggered-order list that
 * `phemex-list-untriggered-orders.ts --symbol <symbol>` prints (same API
 * call, GET /orders/activeList?ordStatus=Untriggered), then cancels every
 * order whose numeric order ID is between --from and --to (inclusive).
 *
 * Usage:
 *   ./phemex-close-untriggered-by-id.ts --symbol XBRUSDT --from 79 --to 80
 *   ./phemex-close-untriggered-by-id.ts --symbol XBRUSDT --from 79 --to 80 --dry-run
 *
 * Order IDs are compared as big integers, so 20-digit Phemex order IDs are
 * handled exactly (no float precision loss).
 */

import { base64UrlDecode } from "../src/http-client.js";
import { getArg, hasFlag } from "../src/cli-utils.js";
import { loadCredentialsLocal } from "../src/credentials.js";
import { cancelOrder } from "../src/place-limit-order.js";
import { fetchUntriggeredOrders, ApiError } from "../src/untriggered-orders.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function usage(): never {
  console.log(`
Usage: ./phemex-close-untriggered-by-id.ts --symbol <symbol> --from <id> --to <id> [--dry-run]

Close (cancel) untriggered orders whose numeric order ID is between --from and --to.

Options:
  --symbol <symbol>   Trading pair (e.g. XBRUSDT, BTCUSD)
  --from <id>         Lowest order ID to close (inclusive)
  --to <id>           Highest order ID to close (inclusive)
  --dry-run           Show what would be closed without executing
  --help, -h          Show this help message

Examples:
  ./phemex-close-untriggered-by-id.ts --symbol XBRUSDT --from 79 --to 80
  ./phemex-close-untriggered-by-id.ts --symbol XBRUSDT --from 79 --to 80 --dry-run
`);
  process.exit(0);
}

/** Numeric order ID as BigInt, or null when the ID is not numeric. */
function numericOrderId(orderID: string): bigint | null {
  if (!/^\d+$/.test(orderID)) return null;
  try {
    return BigInt(orderID);
  } catch {
    return null;
  }
}

/** Position side implied by the order side (USDT-M cancels require it). */
function posSideFor(side: string): string {
  return side.toLowerCase() === "buy" ? "Long" : "Short";
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) usage();

  const symbol = getArg("--symbol");
  const fromRaw = getArg("--from");
  const toRaw = getArg("--to");
  if (!symbol || fromRaw === undefined || toRaw === undefined) usage();

  const from = BigInt(fromRaw);
  const to = BigInt(toRaw);
  if (fromRaw === "" || toRaw === "" || !/^\d+$/.test(fromRaw) || !/^\d+$/.test(toRaw)) {
    console.error("✗  --from and --to must be non-negative integers");
    process.exit(1);
  }
  if (from > to) {
    console.error(`✗  --from (${fromRaw}) must be <= --to (${toRaw})`);
    process.exit(1);
  }

  const dryRun = hasFlag("--dry-run");

  const creds = loadCredentialsLocal();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  console.log(`⟐  Fetching untriggered orders for ${symbol} …`);

  let rows;
  try {
    rows = await fetchUntriggeredOrders(symbol, creds.PHEMEX_API_KEY, secretRaw);
  } catch (err: unknown) {
    if (err instanceof ApiError) {
      console.error(`✗  ${err.message}`);
    } else {
      console.error(`✗  ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(1);
  }

  if (rows.length === 0) {
    console.log("  ℹ  No untriggered orders found.");
    return;
  }

  console.log(`  ✓  ${rows.length} untriggered order(s) fetched (order ID range ${from} … ${to}):\n`);

  // Keep the original order (as printed by phemex-list-untriggered-orders.ts
  // it is sorted by price descending); here we only care about the ID filter.
  const targets = rows.filter((o) => {
    const id = numericOrderId(o.orderID);
    return id !== null && id >= from && id <= to;
  });

  if (targets.length === 0) {
    console.log(`  ℹ  No untriggered orders with order ID between ${from} and ${to} found.`);
    return;
  }

  const symbolWidth = Math.max(symbol.length, 6);
  for (const o of targets) {
    const side = o.side || "?";
    const qty = o.qty || "?";
    const price = o.price ? Number(o.price).toFixed(2) : "?";
    console.log(
      `${symbol.padEnd(symbolWidth)}  ${o.orderID.padEnd(36)}  ${side.padEnd(4)} qty ` +
      `${qty.padStart(6)} limit @ ${price.padStart(5)}  →  close ${posSideFor(side).toLowerCase()}`,
    );
  }

  if (dryRun) {
    console.log(`\n  DRY RUN — Would close ${targets.length} order(s). Nothing sent.`);
    return;
  }

  console.log(`\n  ✓  Closing ${targets.length} order(s) …\n`);

  const results = await Promise.all(
    targets.map(async (o) => {
      const orderId = o.orderID;
      const side = o.side || "Buy";
      const price = o.price ? Number(o.price).toFixed(2) : "?";
      const posSide = posSideFor(side);

      process.stdout.write(`  ${orderId}  ${side} @ ${price}  …  `);

      try {
        const r = await cancelOrder({ symbol, orderId, posSide }, creds.PHEMEX_API_KEY, secretRaw);
        if (r.code === 0) {
          console.log("✓");
          return { ok: 1, fail: 0 };
        }
        console.log(`✗  ${String(r.msg ?? r.code)}`);
        return { ok: 0, fail: 1 };
      } catch (err: unknown) {
        console.log(`✗  ${err instanceof Error ? err.message : String(err)}`);
        return { ok: 0, fail: 1 };
      }
    }),
  );

  const ok = results.reduce((s, r) => s + r.ok, 0);
  const fail = results.reduce((s, r) => s + r.fail, 0);

  console.log(`\n  Done — ${ok} closed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
