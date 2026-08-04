#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-create-tp-sl-ladder.ts — Create a take-profit ladder and a
 * stop-loss ladder of conditional (trigger) orders for one USDT-M position.
 *
 * For the default 1.0 XBRUSDT long position this places:
 *
 *   Take-profit (Sell LimitIfTouched): 50 orders, 1 cent apart,
 *     entry + 0.01 … entry + 0.50, 0.01 qty each  →  0.50 total
 *   Stop-loss   (Buy Stop):             50 orders, 1 cent apart,
 *     entry − 0.01 … entry − 0.50, 0.01 qty each  →  0.50 total
 *
 *   = 100 conditional orders covering the full 1.0 position.
 *
 * For a short position the ladders mirror: TP below entry, SL above entry.
 * The live position's entry price and side are read from the API (unless
 * overridden with --entry / --pos-side). These are reduce-only orders that
 * close the position when the trigger price is hit.
 *
 * Endpoint:  PUT /g-orders/create   (ordType=Stop for SL, LimitIfTouched for TP)
 *
 * Usage:
 *   ./phemex-create-tp-sl-ladder.ts
 *   ./phemex-create-tp-sl-ladder.ts --symbol XBRUSDT --entry 69.23
 *   ./phemex-create-tp-sl-ladder.ts --symbol XBRUSDT --dry-run
 *   ./phemex-create-tp-sl-ladder.ts --symbol XBRUSDT --tp-cents 25 --sl-cents 25
 *
 * Options:
 *   --symbol <symbol>    Trading pair (default: XBRUSDT)
 *   --entry <price>      Entry price override (default: live position entry)
 *   --pos-side <Side>    Long or Short (default: live position side)
 *   --tp-cents <n>       TP ladder length in cents above entry (default: 50)
 *   --sl-cents <n>       SL ladder length in cents below entry (default: 50)
 *   --step <cents>       Cent step between ladder rungs (default: 1)
 *   --qty <size>         Quantity per conditional order (default: 0.01)
 *   --trigger-type <t>   ByMarkPrice (default) or ByLastPrice
 *   --dry-run            Log every order that would be placed, send nothing
 *   --help, -h           Show this help message
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
const DEFAULT_TP_CENTS = 50;
const DEFAULT_SL_CENTS = 50;
const DEFAULT_STEP_CENTS = 1;
const DEFAULT_QTY = 0.01;
const DEFAULT_TRIGGER = "ByMarkPrice";

function usage(): never {
  console.log(`
Usage: ./phemex-create-tp-sl-ladder.ts [options]

Create a take-profit ladder and a stop-loss ladder of conditional orders
for one USDT-M position (default: 1.0 XBRUSDT, long). By default this is
100 reduce-only orders of 0.01 qty each:

  TP: Sell LimitIfTouched from entry+0.01 up to entry+0.50 (50 orders)
  SL: Buy  Stop         from entry−0.01 down to entry−0.50 (50 orders)

The live position's entry price and side come from the API; credentials
are read from .phemex-credentials.json.

Options:
  --symbol <symbol>    Trading pair (default: XBRUSDT)
  --entry <price>      Entry price override (default: live position entry)
  --pos-side <Side>    Long or Short (default: live position side)
  --tp-cents <n>       TP ladder length in cents above entry (default: 50)
  --sl-cents <n>       SL ladder length in cents below entry (default: 50)
  --step <cents>       Cent step between ladder rungs (default: 1)
  --qty <size>         Quantity per conditional order (default: 0.01)
  --trigger-type <t>   ByMarkPrice (default) or ByLastPrice
  --dry-run            Log every order that would be placed, send nothing
  --help, -h           Show this help message

Examples:
  ./phemex-create-tp-sl-ladder.ts
  ./phemex-create-tp-sl-ladder.ts --symbol XBRUSDT --dry-run
  ./phemex-create-tp-sl-ladder.ts --symbol XBRUSDT --entry 69.23 --tp-cents 25 --sl-cents 25
`);
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function fmtTime(): string {
  return new Date().toLocaleTimeString();
}

/** Round a price to 2 decimals (1-cent granularity) without float noise. */
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Build a price ladder: base ± k*stepCents for k = 1..rungs. */
function ladder(base: number, stepCents: number, rungs: number, direction: 1 | -1): number[] {
  const step = stepCents / 100;
  const out: number[] = [];
  for (let k = 1; k <= rungs; k++) {
    out.push(round2(base + direction * k * step));
  }
  return out;
}

/** Build the PUT /g-orders/create query string for one conditional order. */
function buildOrderQuery(params: {
  symbol: string;
  side: "Buy" | "Sell";
  posSide: string;
  ordType: "Stop" | "LimitIfTouched";
  stopPx: number;
  qty: number;
  price: number | null;
  triggerType: string;
}): string {
  const p: string[] = [
    `symbol=${params.symbol}`,
    `side=${params.side}`,
    `posSide=${params.posSide}`,
    `ordType=${params.ordType}`,
    `stopPxRp=${params.stopPx}`,
    `orderQtyRq=${params.qty}`,
    `clOrdID=${uuid()}`,
    `reduceOnly=true`,
    `closeOnTrigger=true`,
    `timeInForce=GoodTillCancel`,
    `triggerType=${params.triggerType}`,
    `slTrigger=${params.triggerType}`,
    `tpTrigger=${params.triggerType}`,
  ];
  if (params.ordType === "LimitIfTouched" && params.price !== null) {
    p.push(`priceRp=${params.price}`);
  }
  return p.join("&");
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) usage();

  const symbol = (getArg("--symbol") ?? DEFAULT_SYMBOL).toUpperCase();
  const entryArg = parseFloat(getArg("--entry") ?? "");
  const posSideArg = getArg("--pos-side");
  const tpCents = parseInt(getArg("--tp-cents") ?? "", 10) || DEFAULT_TP_CENTS;
  const slCents = parseInt(getArg("--sl-cents") ?? "", 10) || DEFAULT_SL_CENTS;
  const stepCents = parseInt(getArg("--step") ?? "", 10) || DEFAULT_STEP_CENTS;
  const qty = parseFloat(getArg("--qty") ?? "") || DEFAULT_QTY;
  const triggerType = getArg("--trigger-type") ?? DEFAULT_TRIGGER;
  const dryRun = hasFlag("--dry-run");

  if (posSideArg !== undefined && !["Long", "Short"].includes(posSideArg)) {
    console.error(`✗  --pos-side must be 'Long' or 'Short', got "${posSideArg}"`);
    process.exit(1);
  }
  if (!["ByMarkPrice", "ByLastPrice"].includes(triggerType)) {
    console.error(`✗  --trigger-type must be 'ByMarkPrice' or 'ByLastPrice', got "${triggerType}"`);
    process.exit(1);
  }
  if (tpCents <= 0 || slCents <= 0 || stepCents <= 0 || qty <= 0) {
    console.error("✗  --tp-cents, --sl-cents, --step and --qty must all be positive");
    process.exit(1);
  }

  const creds = loadCredentials();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  /* -- Resolve entry price & position side ------------------------- */
  let entry = entryArg;
  let posSide = posSideArg;
  let livePos: Position | null = null;

  if (Number.isFinite(entry) && posSide) {
    // Fully specified on the CLI — no API lookup needed.
  } else {
    const positions = await fetchPositions(creds.PHEMEX_API_KEY, secretRaw);
    livePos = positions.find((p) => p.symbol === symbol) ?? null;
    if (livePos) {
      if (!Number.isFinite(entry)) entry = parseFloat(livePos.avgEntryPriceRp || "0");
      if (!posSide) posSide = livePos.side === "Buy" ? "Long" : "Short";
      console.log(`[${fmtTime()}] ⟐  Live ${symbol} position: side=${posSide} size=${livePos.size} entry=${entry.toFixed(2)}`);
    } else if (!Number.isFinite(entry)) {
      console.error(`✗  No open ${symbol} position found — pass --entry (and --pos-side) to override`);
      process.exit(1);
    }
  }
  // Entry given but no live position: default the side to Long.
  if (!posSide) posSide = "Long";
  if (!Number.isFinite(entry) || entry <= 0) {
    console.error("✗  Could not resolve a valid entry price");
    process.exit(1);
  }

  const side: "Buy" | "Sell" = posSide === "Long" ? "Sell" : "Buy";
  // Long: TP above entry / SL below. Short: mirrored (TP below / SL above).
  const tpPrices = ladder(entry, stepCents, tpCents, posSide === "Long" ? 1 : -1);
  const slPrices = ladder(entry, stepCents, slCents, posSide === "Long" ? -1 : 1);

  const tpTotal = round2(qty * tpPrices.length);
  const slTotal = round2(qty * slPrices.length);
  const grandTotal = round2(tpTotal + slTotal);

  console.log(`[${fmtTime()}] ═ TP/SL ladder for ${symbol} ${posSide} ═${dryRun ? "  DRY RUN" : ""}`);
  console.log(`[${fmtTime()}]   entry ${entry.toFixed(2)} · ${tpPrices.length} TP ${side} @ ${tpPrices[0].toFixed(2)}–${tpPrices[tpPrices.length - 1].toFixed(2)} · ${slPrices.length} SL @ ${slPrices[slPrices.length - 1].toFixed(2)}–${slPrices[0].toFixed(2)}`);
  console.log(`[${fmtTime()}]   qty ${qty} per order → TP ${tpTotal} + SL ${slTotal} = ${grandTotal} total (${tpPrices.length + slPrices.length} orders, trigger: ${triggerType})`);
  if (livePos) {
    const posSize = parseFloat(livePos.size || "0");
    if (grandTotal > posSize) {
      console.warn(`[${fmtTime()}]   ⚠  ladder total ${grandTotal} exceeds position size ${posSize}`);
    }
  }

  let placed = 0;
  let failed = 0;

  async function send(label: string, ordType: "Stop" | "LimitIfTouched", stopPx: number, price: number | null): Promise<void> {
    const query = buildOrderQuery({ symbol, side, posSide: posSide!, ordType, stopPx, qty, price, triggerType });
    console.log(`[${fmtTime()}]   ${label}  ${side} ${qty} @ ${stopPx.toFixed(2)}${ordType === "LimitIfTouched" ? ` (limit ${(price ?? 0).toFixed(2)})` : ""}`);
    if (dryRun) {
      console.log(`[${fmtTime()}]      [DRY-RUN] PUT /g-orders/create?${query}`);
      return;
    }
    try {
      const resp = (await request("PUT", "/g-orders/create", query, creds.PHEMEX_API_KEY, secretRaw, "")) as Record<string, unknown>;
      if (resp.code === 0) {
        placed++;
        console.log(`[${fmtTime()}]      ✓ orderID=${(resp.data as Record<string, unknown> | undefined)?.orderID ?? "?"}`);
      } else {
        failed++;
        console.log(`[${fmtTime()}]      ✗ API error: ${String(resp.msg ?? resp.code)}`);
      }
    } catch (err: unknown) {
      failed++;
      console.log(`[${fmtTime()}]      ✗ ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const px of tpPrices) await send("TP", "LimitIfTouched", px, px);
  for (const px of slPrices) await send("SL", "Stop", px, null);

  if (dryRun) {
    console.log(`[${fmtTime()}]   DRY RUN — ${tpPrices.length + slPrices.length} orders logged, nothing sent.`);
  } else {
    console.log(`[${fmtTime()}]   Done — ${placed} placed, ${failed} failed.`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
