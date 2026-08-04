#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-close-limit-order.ts — Place a reduce-only limit order to close
 * part of an open USDT-M position at a specified price.
 *
 * Example: close 0.01 XBRUSDT at 84.00 (Buy limit, posSide Short, reduceOnly):
 *   ./phemex-close-limit-order.ts --qty 0.01 --price 84.00
 *
 * The position side is auto-detected from the live account (opposite side
 * of the open position), or can be pinned with --pos-side / --side.
 * The order rests until filled (GoodTillCancel) — it is NOT auto-cancelled.
 *
 * Endpoint:  PUT /g-orders/create   (ordType=Limit, reduceOnly=true)
 *
 * Usage:
 *   ./phemex-close-limit-order.ts --qty <size> --price <price>
 *   ./phemex-close-limit-order.ts --qty 0.01 --price 84.00 --pos-side Short
 *   ./phemex-close-limit-order.ts --qty 0.01 --price 84.00 --dry-run
 *
 * Options:
 *   --symbol <pair>   Trading pair (default: XBRUSDT)
 *   --qty <size>      Quantity to close (required)
 *   --price <price>   Limit price (required)
 *   --pos-side <Side> Long or Short (default: live position side)
 *   --side <Buy|Sell> Order side (default: opposite of pos-side)
 *   --dry-run         Log what would be sent without executing
 *   --help, -h        Show this help message
 */

import { base64UrlDecode, request } from "../src/http-client.js";
import { getArg, hasFlag } from "../src/cli-utils.js";
import { loadCredentials } from "../src/credentials.js";
import { fetchPositions, type Position } from "../src/positions.js";
import { uuid } from "../src/uuid.js";

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

const DEFAULT_SYMBOL = "XBRUSDT";

function usage(): never {
  console.log(`
Usage: ./phemex-close-limit-order.ts --qty <size> --price <price> [options]

Place a reduce-only limit order to close part of an open USDT-M position
at a specified price. The order rests until filled (GoodTillCancel).

Options:
  --symbol <pair>   Trading pair (default: XBRUSDT)
  --qty <size>      Quantity to close (required)
  --price <price>   Limit price (required)
  --pos-side <Side> Long or Short (default: live position side)
  --side <Buy|Sell> Order side (default: opposite of pos-side)
  --dry-run         Log what would be sent without executing
  --help, -h        Show this help message

Examples:
  ./phemex-close-limit-order.ts --qty 0.01 --price 84.00
  ./phemex-close-limit-order.ts --qty 0.01 --price 84.00 --dry-run
`);
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function fmtTime(): string {
  return new Date().toLocaleTimeString();
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) usage();

  const symbol = (getArg("--symbol") ?? DEFAULT_SYMBOL).toUpperCase();
  const qty = parseFloat(getArg("--qty") ?? "");
  const price = parseFloat(getArg("--price") ?? "");
  const posSideArg = getArg("--pos-side");
  const sideArg = getArg("--side");
  const dryRun = hasFlag("--dry-run");

  if (!Number.isFinite(qty) || qty <= 0) {
    console.error("✗  --qty must be a positive number");
    process.exit(1);
  }
  if (!Number.isFinite(price) || price <= 0) {
    console.error("✗  --price must be a positive number");
    process.exit(1);
  }
  if (posSideArg !== undefined && !["Long", "Short"].includes(posSideArg)) {
    console.error(`✗  --pos-side must be 'Long' or 'Short', got "${posSideArg}"`);
    process.exit(1);
  }
  if (sideArg !== undefined && !["Buy", "Sell"].includes(sideArg)) {
    console.error(`✗  --side must be 'Buy' or 'Sell', got "${sideArg}"`);
    process.exit(1);
  }

  const creds = loadCredentials();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  /* -- Resolve position side from the live account if not pinned ---- */
  let posSide = posSideArg;
  let livePos: Position | null = null;
  if (!posSide) {
    const positions = await fetchPositions(creds.PHEMEX_API_KEY, secretRaw);
    livePos = positions.find((p) => p.symbol === symbol) ?? null;
    if (!livePos) {
      console.error(`✗  No open ${symbol} position found — pass --pos-side to override`);
      process.exit(1);
    }
    posSide = livePos.side === "Buy" ? "Long" : "Short";
    console.log(`[${fmtTime()}] ⟐  Live ${symbol} position: side=${posSide} size=${livePos.size} entry=${livePos.avgEntryPriceRp ?? "?"}`);
  }

  const side = (sideArg ?? (posSide === "Long" ? "Sell" : "Buy")) as "Buy" | "Sell";

  const query = [
    `symbol=${symbol}`,
    `side=${side}`,
    `posSide=${posSide}`,
    `ordType=Limit`,
    `timeInForce=GoodTillCancel`,
    `priceRp=${price}`,
    `orderQtyRq=${qty}`,
    `clOrdID=${uuid()}`,
    `reduceOnly=true`,
  ].join("&");

  console.log(`[${fmtTime()}] ═ Close ${qty} ${symbol} @ ${price.toFixed(2)} ═${dryRun ? "  DRY RUN" : ""}`);
  console.log(`[${fmtTime()}]   ${side} ${qty} ${symbol} (posSide ${posSide}) limit ${price.toFixed(2)}, reduceOnly, GoodTillCancel`);
  if (dryRun) {
    console.log(`[${fmtTime()}]      [DRY-RUN] PUT /g-orders/create?${query}`);
    console.log(`[${fmtTime()}]   DRY RUN — nothing sent.`);
    return;
  }

  const resp = (await request("PUT", "/g-orders/create", query, creds.PHEMEX_API_KEY, secretRaw, "")) as Record<string, unknown>;
  if (resp.code === 0) {
    const data = resp.data as Record<string, unknown> | undefined;
    console.log(`[${fmtTime()}]   ✓  Order placed: orderID=${data?.orderID ?? "?"}  status=${data?.ordStatus ?? "?"}`);
  } else {
    console.error(`[${fmtTime()}]   ✗  API error: ${String(resp.msg ?? resp.code)}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
