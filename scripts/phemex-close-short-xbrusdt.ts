#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-close-short-xbrusdt.ts - Close a 0.01 XBRUSDT short with a
 * reduce-only Buy limit order at 84.00 (defaults), overrideable via flags.
 *
 * The order rests until filled (GoodTillCancel) and is reduce-only, so it
 * can only close an existing short; never open one.
 *
 * Endpoint:  PUT /g-orders/create   (ordType=Limit, reduceOnly=true)
 *
 * Usage:
 *   ./phemex-close-short-xbrusdt.ts               # close 0.01 @ 84.00 (defaults)
 *   ./phemex-close-short-xbrusdt.ts --dry-run     # show what would be sent
 *   ./phemex-close-short-xbrusdt.ts --qty 0.02 --price 83.50
 *
 * Options:
 *   --qty <size>      Size to close (default: 0.01)
 *   --price <price>   Limit price (default: 84.00)
 *   --dry-run         Log what would be sent without executing
 *   --help, -h        Show this help message
 */

import { base64UrlDecode, request } from "../src/http-client.js";
import { getArg, hasFlag } from "../src/cli-utils.js";
import { loadCredentials } from "../src/credentials.js";
import { fetchPositions } from "../src/positions.js";
import { uuid } from "../src/uuid.js";

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

const SYMBOL = "XBRUSDT";
const DEFAULT_QTY = 0.01;
const DEFAULT_PRICE = 84.0;

function usage(): never {
  console.log(`
Usage: ./phemex-close-short-xbrusdt.ts [options]

Close 0.01 XBRUSDT short with a reduce-only Buy limit at 84.00.
The order rests until filled (GoodTillCancel); it can only reduce an
existing short position, never open one.

Options:
  --qty <size>      Size to close (default: 0.01)
  --price <price>   Limit price (default: 84.00)
  --dry-run         Log what would be sent without executing
  --help, -h        Show this help message

Examples:
  ./phemex-close-short-xbrusdt.ts
  ./phemex-close-short-xbrusdt.ts --dry-run
  ./phemex-close-short-xbrusdt.ts --qty 0.02 --price 83.50
`);
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function fmtTime(): string {
  return new Date().toLocaleTimeString();
}

function parsePositiveNumber(name: string, fallback: number): number {
  const raw = getArg(name);
  if (raw === undefined) return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`${name} must be a positive number`);
    process.exit(1);
  }
  return value;
}

function buildCloseShortQuery(qty: number, price: number): string {
  const params = new URLSearchParams({
    symbol: SYMBOL,
    side: "Buy",
    posSide: "Short",
    ordType: "Limit",
    timeInForce: "GoodTillCancel",
    priceRp: String(price),
    orderQtyRq: String(qty),
    clOrdID: uuid(),
    reduceOnly: "true",
  });
  return params.toString();
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) usage();

  const qty = parsePositiveNumber("--qty", DEFAULT_QTY);
  const price = parsePositiveNumber("--price", DEFAULT_PRICE);
  const dryRun = hasFlag("--dry-run");
  const query = buildCloseShortQuery(qty, price);

  console.log(`[${fmtTime()}] Close ${qty} ${SYMBOL} short @ ${price.toFixed(2)}${dryRun ? "  DRY RUN" : ""}`);
  console.log(`[${fmtTime()}] Buy ${qty} ${SYMBOL} (posSide Short) limit ${price.toFixed(2)}, reduceOnly, GoodTillCancel`);
  if (dryRun) {
    console.log(`[${fmtTime()}] [DRY-RUN] PUT /g-orders/create?${query}`);
    console.log(`[${fmtTime()}] DRY RUN: nothing sent.`);
    return;
  }

  const creds = loadCredentials();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);
  /* -- Pre-flight: warn if no XBRUSDT short is open ----------------- */
  let liveSize = 0;
  try {
    const positions = await fetchPositions(creds.PHEMEX_API_KEY, secretRaw);
    const pos = positions.find((p) => p.symbol === SYMBOL);
    liveSize = pos && pos.side === "Sell" ? parseFloat(pos.size || "0") : 0;
  } catch (err: unknown) {
    console.error(`[${fmtTime()}] Could not check position: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (liveSize <= 0) {
    console.warn(`[${fmtTime()}] No open ${SYMBOL} short detected; a reduce-only Buy may be rejected (TE_REDUCE_ONLY_ABORT)`);
  } else if (liveSize < qty) {
    console.warn(`[${fmtTime()}] Open ${SYMBOL} short is only ${liveSize} < requested close ${qty}`);
  } else {
    console.log(`[${fmtTime()}] Live ${SYMBOL} short size: ${liveSize}`);
  }

  const resp = (await request("PUT", "/g-orders/create", query, creds.PHEMEX_API_KEY, secretRaw, "")) as Record<string, unknown>;
  if (resp.code === 0) {
    const data = resp.data as Record<string, unknown> | undefined;
    console.log(`[${fmtTime()}] Order placed: orderID=${data?.orderID ?? "?"}  status=${data?.ordStatus ?? "?"}`);
  } else {
    console.error(`[${fmtTime()}] API error: ${String(resp.msg ?? resp.code)}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
