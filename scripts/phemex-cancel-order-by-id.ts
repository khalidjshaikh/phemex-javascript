#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-cancel-order-by-id.ts  —  Cancel a single untriggered order by
 * its exact order ID (UUID).
 *
 * Fetches the untriggered-order list for the symbol (the same GET
 * /orders/activeList?ordStatus=Untriggered call used everywhere in this
 * repo), finds the order whose orderID matches --order-id, derives the
 * position side from its side (Buy → Long, Sell → Short), and cancels it
 * via DELETE /orders?orderID=…&symbol=…&posSide=….
 *
 * Usage:
 *   ./phemex-cancel-order-by-id.ts --symbol XBRUSDT --order-id 8a365b1e-d22f-4025-8ef2-1157c1b62c74
 *   ./phemex-cancel-order-by-id.ts --symbol XBRUSDT --order-id 8a365b1e-d22f-4025-8ef2-1157c1b62c74 --dry-run
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
Usage: ./phemex-cancel-order-by-id.ts --symbol <symbol> --order-id <id> [--dry-run]

Cancel a single untriggered order by its exact order ID.

Options:
  --symbol <symbol>   Trading pair (e.g. XBRUSDT, BTCUSD)
  --order-id <id>     Exact order ID to cancel (e.g. 8a365b1e-d22f-4025-8ef2-1157c1b62c74)
  --dry-run           Show what would be sent without executing
  --help, -h          Show this help message

Examples:
  ./phemex-cancel-order-by-id.ts --symbol XBRUSDT --order-id 8a365b1e-d22f-4025-8ef2-1157c1b62c74
  ./phemex-cancel-order-by-id.ts --symbol XBRUSDT --order-id 8a365b1e-d22f-4025-8ef2-1157c1b62c74 --dry-run
`);
  process.exit(0);
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
  const orderId = getArg("--order-id");
  if (!symbol || !orderId) usage();

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

  const target = rows.find((o) => o.orderID === orderId);
  if (!target) {
    console.log(`  ℹ  No untriggered order with ID ${orderId} found (${rows.length} order(s) fetched).`);
    process.exit(1);
  }

  const side = target.side || "Buy";
  const price = target.price ? Number(target.price).toFixed(2) : "?";
  const posSide = posSideFor(side);
  console.log(
    `  ✓  Found: ${target.orderID}  ${side.padEnd(4)} qty ${(target.qty || "?").padStart(6)} ` +
    `limit @ ${price}  →  cancel posSide=${posSide}`,
  );

  if (dryRun) {
    console.log(`\n  DRY RUN — Would send DELETE /orders?orderID=${orderId}&symbol=${symbol}&posSide=${posSide}`);
    return;
  }

  process.stdout.write(`  Cancelling ${orderId} …  `);

  try {
    const r = await cancelOrder({ symbol, orderId, posSide }, creds.PHEMEX_API_KEY, secretRaw);
    if (r.code === 0) {
      console.log("✓");
    } else {
      console.log(`✗  ${String(r.msg ?? r.code)}`);
      process.exit(1);
    }
  } catch (err: unknown) {
    console.log(`✗  ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
