#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-watch-untriggered-orders.ts  —  Watch untriggered trigger orders
 * for a symbol and auto-cancel any that stay open too long.
 *
 * Runs as an infinite loop:
 *
 *   1. Every poll interval, list untriggered orders via
 *      src/untriggered-orders.ts (fetchUntriggeredOrders →
 *      GET /orders/activeList?ordStatus=Untriggered&symbol=<symbol>,
 *      GET /g-orders/activeList for *USDT symbols).
 *   2. Each order number is tracked in a Map<orderID, firstSeenMs>.
 *      New orders are recorded with the current time; orders that are
 *      still present on later polls keep their original first-seen time
 *      (the time the order has been open), and orders that disappeared
 *      (filled / cancelled elsewhere) are dropped from the Map.
 *   3. Any tracked order whose first-seen time is older than --age
 *      seconds is cancelled via DELETE /g-orders or /orders.
 *
 * Usage:
 *   ./phemex-watch-untriggered-orders.ts --symbol XBRUSDT
 *   ./phemex-watch-untriggered-orders.ts --symbol XBRUSDT --interval 2 --age 30
 *   ./phemex-watch-untriggered-orders.ts --symbol XBRUSDT --dry-run --once
 *
 * Options:
 *   --symbol <symbol>   Trading pair (e.g. XBRUSDT, BTCUSD, XTIUSDT)
 *   --interval <sec>    Poll interval in seconds (default: 60)
 *   --age <sec>         Cancel orders open longer than this, in seconds
 *                       (default: 30)
 *   --dry-run           Log what would be cancelled without cancelling
 *   --once              Run a single poll cycle, then exit (for testing)
 *   --help, -h          Show this help message
 */

import { base64UrlDecode } from "../src/http-client.js";
import { getArg, hasFlag } from "../src/cli-utils.js";
import { loadCredentialsLocal } from "../src/credentials.js";
import { cancelOrder } from "../src/place-limit-order.js";
import {
  fetchUntriggeredOrders,
  ApiError,
  type UntriggeredOrder,
} from "../src/untriggered-orders.js";

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

const DEFAULT_INTERVAL_MS = 60_000; // poll every 60s
const DEFAULT_AGE_MS = 30_000;      // cancel orders open > 30s

function usage(): never {
  console.log(`
Usage: ./phemex-watch-untriggered-orders.ts --symbol <symbol> [options]

Watch untriggered trigger orders for a symbol and auto-cancel any that
stay open longer than --age seconds. Runs until interrupted (Ctrl-C).

Options:
  --symbol <symbol>   Trading pair (e.g. XBRUSDT, BTCUSD, XTIUSDT)
  --interval <sec>    Poll interval in seconds (default: 60)
  --age <sec>         Cancel orders open longer than this, in seconds (default: 30)
  --dry-run           Log what would be cancelled without cancelling
  --once              Run a single poll cycle, then exit (for testing)
  --help, -h          Show this help message

Examples:
  ./phemex-watch-untriggered-orders.ts --symbol XBRUSDT
  ./phemex-watch-untriggered-orders.ts --symbol XBRUSDT --interval 2 --age 30
  ./phemex-watch-untriggered-orders.ts --symbol XBRUSDT --dry-run --once
`);
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function fmtTime(): string {
  return new Date().toLocaleTimeString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Position side required by the cancel endpoint: Buy → Long, Sell → Short. */
function posSideFor(side: string): string {
  return side.toLowerCase() === "buy" ? "Long" : "Short";
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) usage();

  const symbol = getArg("--symbol");
  if (!symbol) usage();

  const intervalMs = parseInt(getArg("--interval") ?? "", 10) * 1000 || DEFAULT_INTERVAL_MS;
  const ageMs = parseInt(getArg("--age") ?? "", 10) * 1000 || DEFAULT_AGE_MS;
  const dryRun = hasFlag("--dry-run");
  const once = hasFlag("--once");

  const isUsdtM = symbol.toUpperCase().endsWith("USDT");

  const creds = loadCredentialsLocal();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  // orderID → time (ms) the order was first seen (i.e. how long it has been open)
  const firstSeen = new Map<string, number>();

  console.log(`[${fmtTime()}] ═ Watch untriggered ${symbol} (${isUsdtM ? "USDT-M" : "Coin-M"}) ═${dryRun ? "  DRY RUN" : ""}`);
  console.log(`[${fmtTime()}]   Poll every ${intervalMs / 1000}s · cancel orders open > ${ageMs / 1000}s · ${dryRun ? "no cancels will be sent" : "cancels enabled"}`);
  console.log(`[${fmtTime()}] ═══════════════════════════════════════════════════════════════`);

  let cancelled = 0;
  let polls = 0;

  async function poll(): Promise<void> {
    polls++;
    let orders: UntriggeredOrder[] = [];
    try {
      orders = await fetchUntriggeredOrders(symbol, creds.PHEMEX_API_KEY, secretRaw);
    } catch (err: unknown) {
      // code 10002 / "OM_ORDER_NOT_FOUND" is handled inside the library as an empty result
      if (err instanceof ApiError) {
        console.error(`[${fmtTime()}] ✗  API error: ${err.message} — retrying next cycle`);
      } else {
        console.error(`[${fmtTime()}] ✗  Request failed: ${err instanceof Error ? err.message : String(err)} — retrying next cycle`);
      }
      return;
    }

    const currentIds = new Set<string>();
    for (const o of orders) {
      const orderID = o.orderID;
      if (!orderID) continue;
      currentIds.add(orderID);

      const seenAt = firstSeen.get(orderID);
      if (seenAt === undefined) {
        // New order — record the time we first saw it
        firstSeen.set(orderID, Date.now());
        console.log(`[${fmtTime()}]   ➕  tracked ${orderID}  ${o.side || "?"} qty ${o.qty || "?"} @ ${o.price || "?"}`);
      }
      // Orders already tracked keep their original first-seen time — that is
      // the time they have been open. (A stale refresh would defeat the age check.)
    }

    // Drop orders that are no longer untriggered (filled/cancelled elsewhere)
    for (const orderID of firstSeen.keys()) {
      if (!currentIds.has(orderID)) {
        const ageSec = ((Date.now() - (firstSeen.get(orderID) ?? 0)) / 1000).toFixed(1);
        console.log(`[${fmtTime()}]   🗑  dropped ${orderID} (gone after ${ageSec}s)`);
        firstSeen.delete(orderID);
      }
    }

    // Cancel any tracked order that has been open longer than ageMs
    const now = Date.now();
    for (const o of orders) {
      const orderID = o.orderID;
      const seenAt = firstSeen.get(orderID);
      if (seenAt === undefined) continue;
      const openMs = now - seenAt;
      if (openMs < ageMs) continue;

      const side = o.side || "?";
      const price = o.price || "?";
      const ageSec = (openMs / 1000).toFixed(1);

      if (dryRun) {
        console.log(`[${fmtTime()}]   ✂  DRY RUN — would cancel ${orderID}  ${side} @ ${price}  (open ${ageSec}s > ${ageMs / 1000}s)`);
        continue;
      }

      process.stdout.write(`[${fmtTime()}]   ✂  cancelling ${orderID}  ${side} @ ${price}  (open ${ageSec}s)  …  `);
      try {
        const r = await cancelOrder({ symbol, orderId: orderID, posSide: posSideFor(side) }, creds.PHEMEX_API_KEY, secretRaw);
        if (r.code === 0) {
          console.log("✓");
          cancelled++;
          firstSeen.delete(orderID);
        } else {
          console.log(`✗  ${String(r.msg ?? r.code)}`);
        }
      } catch (err: unknown) {
        console.log(`✗  ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (orders.length === 0) {
      console.log(`[${fmtTime()}]   ℹ  no untriggered orders (${firstSeen.size} tracked)`);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Infinite loop                                                      */
  /* ------------------------------------------------------------------ */

  process.on("SIGINT", () => {
    console.log(`\n[${fmtTime()}] ⏹  Stopped — ${polls} poll(s), ${cancelled} order(s) cancelled.`);
    process.exit(0);
  });

  for (;;) {
    await poll();
    if (once) break;
    await sleep(intervalMs);
  }

  console.log(`[${fmtTime()}]   Done — ${polls} poll(s), ${cancelled} order(s) cancelled.`);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
