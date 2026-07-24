#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-add-conditional-orders.ts  —  Create stop-loss and/or take-profit
 * conditional (trigger) orders for an existing USDT-M position.
 *
 * Uses Phemex's `ordType=Stop` (stop-loss) and `ordType=LimitIfTouched`
 * (take-profit) order types.  These are reduce-only orders that close
 * the position when the trigger price is hit.
 *
 * Endpoint:  PUT /g-orders/create
 *
 * The trigger source can be set to mark price or last price via --trigger-type.
 * A separate --sl-trigger / --tp-trigger overrides the trigger source for the
 * stop-loss or take-profit order individually.
 *
 * Usage:
 *   npx tsx phemex-add-conditional-orders.ts --symbol XBRUSDT --pos-side Long \
 *       [--stop-loss 69] [--take-profit 200] [--qty 0.01] \
 *       [--trigger-type ByMarkPrice|ByLastPrice] [--dry-run]
 *
 * At least one of --stop-loss or --take-profit must be specified.
 * If --qty is omitted, the full position size (from the API) is used.
 * With --dry-run, the orders are logged but not sent.
 */

import { base64UrlDecode, request } from "./src/http-client.js";
import { loadCredentials } from "./src/credentials.js";
import { uuid } from "./src/uuid.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Position {
  symbol: string;
  side: "Buy" | "Sell" | "None";
  size: string;
  posSide: string;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function usage(): never {
  console.log(`
Usage:  npx tsx phemex-add-conditional-orders.ts --symbol <symbol> --pos-side <Side> \\
            [--stop-loss <price>] [--take-profit <price>] \\
            [--qty <size>] [--trigger-type ByMarkPrice|ByLastPrice] \\
            [--dry-run] [--help]

Create conditional orders (stop-loss / take-profit) for an existing USDT-M position.

Arguments:
  --symbol <symbol>          Trading pair, e.g. XBRUSDT, XTIUSDT (required)
  --pos-side <Side>          Position side: Long or Short (required)
  --stop-loss <price>        Stop-loss trigger price (optional)
  --take-profit <price>      Take-profit trigger price (optional)
  --qty <size>               Quantity to close (default: full position size from API)
  --trigger-type <type>      Trigger source: ByMarkPrice (default) or ByLastPrice
  --dry-run                  Print what would be sent without executing
  --help, -h                 Show this help message

Examples:
  ./phemex-add-conditional-orders.ts --symbol XBRUSDT --pos-side Long --stop-loss 69 --take-profit 200
  ./phemex-add-conditional-orders.ts --symbol XTIUSDT --pos-side Long --stop-loss 80 --take-profit 105 --trigger-type ByLastPrice --dry-run
`);
  process.exit(0);
}

/** Get the value of a CLI flag (empty string if missing) */
function getArg(flag: string): string {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : "";
}

/** Check if a flag is present */
function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

/** Fetch positions from the API and return the matching open position */
async function fetchPosition(
  symbol: string,
  posSide: string,
  apiKey: string,
  secretRaw: Buffer,
): Promise<Position | null> {
  const resp = await request(
    "GET",
    "/g-accounts/accountPositions",
    "currency=USDT",
    apiKey,
    secretRaw,
    "",
  ) as Record<string, unknown>;

  if (resp.code !== 0) throw new Error(`API error: ${String(resp.msg ?? resp.code)}`);

  const data = resp.data as { positions?: Position[] } | undefined;
  const positions = data?.positions ?? [];
  const match = positions.find(
    (p: Position) =>
      p.symbol === symbol &&
      p.posSide === posSide &&
      p.side !== "None" &&
      p.size !== "0",
  );
  return match ?? null;
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) usage();

  const symbol = getArg("--symbol");
  const posSide = getArg("--pos-side");
  const stopLossPrice = parseFloat(getArg("--stop-loss"));
  const takeProfitPrice = parseFloat(getArg("--take-profit"));
  const cliQty = parseFloat(getArg("--qty"));
  const triggerType = getArg("--trigger-type") || "ByMarkPrice";
  const dryRun = hasFlag("--dry-run");

  /* -- Validate args ----------------------------------------------- */
  if (!symbol || !posSide) {
    console.error("✗  --symbol and --pos-side are required");
    usage();
  }
  if (!["Long", "Short"].includes(posSide)) {
    console.error("✗  --pos-side must be 'Long' or 'Short'");
    process.exit(1);
  }
  if (!["ByMarkPrice", "ByLastPrice"].includes(triggerType)) {
    console.error("✗  --trigger-type must be 'ByMarkPrice' or 'ByLastPrice'");
    process.exit(1);
  }
  if (isNaN(stopLossPrice) && isNaN(takeProfitPrice)) {
    console.error("✗  At least one of --stop-loss or --take-profit is required");
    usage();
  }

  /* -- Read credentials -------------------------------------------- */
  const creds = loadCredentials(import.meta.dirname);
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  /* -- Resolve position size from API if not specified on CLI ------ */
  let qty: number;
  if (!isNaN(cliQty) && cliQty > 0) {
    qty = cliQty;
  } else {
    const pos = await fetchPosition(symbol, posSide, creds.PHEMEX_API_KEY, secretRaw);
    if (!pos) {
      console.error(`✗  No open ${posSide} position found for ${symbol}`);
      process.exit(1);
    }
    qty = parseFloat(pos.size || "0");
    console.log(`⟐  Current ${symbol} ${posSide} position: size=${qty}, entry=${pos.avgEntryPrice ?? "?"}`);
  }

  if (qty <= 0) {
    console.error("✗  Position size is zero or negative — nothing to protect");
    process.exit(1);
  }

  /* -- Determine order side (opposite of position direction) ------- */
  const side = posSide === "Long" ? "Sell" : "Buy";

  /* -- Build and send conditional orders --------------------------- */
  const orders: Array<{ label: string; triggerPrice: number; ordType: string; price: number }> = [];

  if (!isNaN(stopLossPrice)) {
    orders.push({
      label: "Stop-Loss",
      triggerPrice: stopLossPrice,
      ordType: "Stop",
      price: 0,
    });
  }
  if (!isNaN(takeProfitPrice)) {
    orders.push({
      label: "Take-Profit",
      triggerPrice: takeProfitPrice,
      ordType: "LimitIfTouched",
      price: takeProfitPrice,
    });
  }

  for (const o of orders) {
    const clOrdID = uuid();
    const paramsList: string[] = [
      `symbol=${symbol}`,
      `side=${side}`,
      `posSide=${posSide}`,
      `ordType=${o.ordType}`,
      `stopPxRp=${o.triggerPrice}`,
      `orderQtyRq=${qty}`,
      `clOrdID=${clOrdID}`,
      `reduceOnly=true`,
      `closeOnTrigger=true`,
      `timeInForce=GoodTillCancel`,
      `triggerType=${triggerType}`,
      `slTrigger=${triggerType}`,
      `tpTrigger=${triggerType}`,
    ];
    if (o.ordType === "LimitIfTouched" && o.price > 0) {
      paramsList.push(`priceRp=${o.price}`);
    }
    const query = paramsList.join("&");

    console.log(`⟐  ${o.label}: sell ${qty} ${symbol} if mark price reaches ${o.triggerPrice}`);

    if (dryRun) {
      console.log(`   [DRY-RUN] Would PUT /g-orders/create?${query}`);
      continue;
    }

    const resp = (await request(
      "PUT",
      "/g-orders/create",
      query,
      creds.PHEMEX_API_KEY,
      secretRaw,
      "",
    )) as Record<string, unknown>;

    if (resp.code === 0) {
      const data = resp.data as Record<string, unknown> | undefined;
      console.log(`   ✓  Created (orderID=${data?.orderID ?? "?"})`);
    } else {
      console.error(`   ✗  API error: ${String(resp.msg ?? resp.code)}`);
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
