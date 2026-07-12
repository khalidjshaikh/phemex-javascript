#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-cancel-order.ts  —  Cancel a single order by its order ID
 *
 * Endpoint:  DELETE /orders        (COIN-M)
 *            DELETE /g-orders      (USDT-M, requires --pos-side)
 *
 * Usage:
 *   npx tsx phemex-cancel-order.ts --order-id <uuid> --symbol XTIUSDT --pos-side Short
 *   npx tsx phemex-cancel-order.ts --order-id <uuid> --symbol BTCUSD
 */

import { request, base64UrlDecode } from "./src/http-client.js";
import { getArg, hasFlag, apiPath } from "./src/cli-utils.js";
import { loadCredentials } from "./src/credentials.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function loadCredentialsLocal(): ReturnType<typeof loadCredentials> {
  return loadCredentials(import.meta.dirname);
}

function usage(): never {
  console.log(`
Usage: ./phemex-cancel-order.ts --order-id <uuid> --symbol <symbol> [--pos-side <Side>]

Cancel a single order by its order ID on Phemex.

Arguments:
  --order-id <uuid>   Order ID to cancel (required)
  --symbol <symbol>   Trading pair, e.g. XTIUSDT, BTCUSD (required)
  --pos-side <Side>   Position side: Long or Short (required for USDT-M orders)
  --help, -h          Show this help message

Examples:
  ./phemex-cancel-order.ts --order-id 2c43dcca-... --symbol XTIUSDT --pos-side Short
  ./phemex-cancel-order.ts --order-id 2c43dcca-... --symbol BTCUSD
`);
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) usage();

  const orderId = getArg("--order-id");
  const symbol = getArg("--symbol");
  const posSide = getArg("--pos-side");

  if (!orderId || !symbol) usage();

  const isUsdt = symbol.endsWith("USDT");
  if (isUsdt && !posSide) {
    console.error("✗  --pos-side is required for USDT-M symbols (Long or Short)");
    process.exit(1);
  }

  const urlPath = apiPath(symbol);
  const qp = new URLSearchParams();
  qp.set("orderID", orderId);
  qp.set("symbol", symbol);
  if (posSide) qp.set("posSide", posSide);
  const query = qp.toString();

  const creds = loadCredentialsLocal();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  const accountType = isUsdt ? "USDT-M" : "COIN-M";
  console.log(`⟐  [${accountType}] Cancelling order ${orderId} …`);

  const resp = await request("DELETE", urlPath, query, creds.PHEMEX_API_KEY, secretRaw, "");

  if (resp.code === 0) {
    console.log("  ✓  Order cancelled successfully");
  } else {
    console.error(`  ✗  API error: ${String(resp.msg ?? resp.code)}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});