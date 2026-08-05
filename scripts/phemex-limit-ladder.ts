#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-limit-ladder.ts — Place a ladder of resting limit orders on XBRUSDT
 * (USDT-M): one order per rung from $70 up to $83 (inclusive), qty 0.01 each,
 * at 100x leverage. Defaults to a Long (Buy) ladder; pass --side short for a
 * Short (Sell) ladder.
 *
 * Uses placeLinear directly instead of placeLimitOrder because the shared
 * wrapper auto-cancels every limit order after 60s — a resting ladder must
 * stay live until filled.
 *
 * Usage:
 *   ./phemex-limit-ladder.ts
 *   ./phemex-limit-ladder.ts --symbol XBRUSDT --from 70 --to 83 --step 1
 *   ./phemex-limit-ladder.ts --price 79
 *   ./phemex-limit-ladder.ts --price last-0.40
 *   ./phemex-limit-ladder.ts --dry-run
 *
 * Options:
 *   --symbol <symbol>   Contract symbol (default: XBRUSDT)
 *   --price <n|last|mark>  Single-rung ladder (shorthand for --from X --to X);
 *                        also accepts an offset like "last-0.40" / "mark+0.20"
 *                        (last.txt / mark.txt ± delta). Cannot combine with
 *                        --from / --to.
 *   --from <price>      Ladder start price (default: 70)
 *   --to <price>        Ladder end price, inclusive (default: 83)
 *   --step <price>      Price step between rungs (default: 1)
 *   --qty <quantity>    Quantity per order (default: 0.01)
 *   --leverage <n>      Leverage (default: 100)
 *   --side <long|short> Order side (default: long)
 *   --dry-run           Print the ladder without placing any orders
 *   --help, -h          Show this help message
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { base64UrlDecode } from "../src/http-client.js";
import { loadCredentialsPath } from "../src/credentials.js";
import { placeLinear, setLeverageUsdtM } from "../src/place-limit-order.js";

const CREDS_FILE = ".phemex-credentials.json";
const ROOT = resolve(import.meta.dirname, ".."); // project root
const LAST_FILE = resolve(ROOT, "last.txt"); // written by phemex-mark-price2.ts
const MARK_FILE = resolve(ROOT, "mark.txt"); // written by phemex-mark-price2.ts

// Defaults
const SYMBOL = "XBRUSDT";
const FROM = 70;
const TO = 83;
const STEP = 1;
const QTY = 0.01;
const LEVERAGE = 100;
const ORDER_DELAY_MS = 300; // small pause between order placements

function usage(): never {
  console.log(`
Usage: ./phemex-limit-ladder.ts [options]

Place a ladder of resting limit orders on ${SYMBOL} (USDT-M),
one order per rung from \$${FROM} to \$${TO} (inclusive), qty ${QTY} each,
at ${LEVERAGE}x leverage.

Options:
  --symbol <symbol>   Contract symbol (default: ${SYMBOL})
  --price <n|last|mark>  Single-rung ladder (shorthand for --from X --to X);
                        also accepts an offset like "last-0.40" / "mark+0.20"
                        (last.txt / mark.txt ± delta). Cannot combine with
                        --from / --to.
  --from <price>      Ladder start price (default: ${FROM})
  --to <price>        Ladder end price, inclusive (default: ${TO})
  --step <price>      Price step between rungs (default: ${STEP})
  --qty <quantity>    Quantity per order (default: ${QTY})
  --leverage <n>      Leverage (default: ${LEVERAGE})
  --side <long|short> Order side (default: long)
  --dry-run           Print the ladder without placing any orders
  --help, -h          Show this help message

Examples:
  ./phemex-limit-ladder.ts
  ./phemex-limit-ladder.ts --from 70 --to 83 --step 1 --dry-run
  ./phemex-limit-ladder.ts --price 79 --dry-run
  ./phemex-limit-ladder.ts --price last-0.40 --dry-run
  ./phemex-limit-ladder.ts --side short --qty 0.05
  ./phemex-limit-ladder.ts --symbol XBRUSDT --qty 0.05
`);
  process.exit(0);
}

function fmtTime(): string {
  return new Date().toLocaleString();
}

function getArgValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function numArg(name: string, fallback: number): number {
  const raw = getArgValue(name);
  if (raw === undefined) return fallback;
  const v = parseFloat(raw);
  if (!Number.isFinite(v)) {
    console.error(`✗  Invalid value for ${name}: "${raw}"`);
    process.exit(1);
  }
  return v;
}

/** Offset form: "last-0.40" / "mark+0.20" — price file ± delta (US-ASCII +/-). */
const PRICE_EXPR = /^(last|mark)([+-])(\d+(?:\.\d+)?)$/;

/** Read a price file (last.txt / mark.txt, project root). Throws if unavailable. */
function readPriceFile(file: string): number {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8").trim();
  } catch {
    throw new Error(`Cannot read ${file} — run phemex-mark-price2.ts first, or pass --price <n>`);
  }
  const v = parseFloat(raw);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`Invalid price in ${file}: "${raw}"`);
  return v;
}

/**
 * Resolve a --price arg — a number, "last" / "mark" (last.txt / mark.txt),
 * or an offset like "last-0.40" / "mark+0.20" (file ± delta) — to a concrete
 * price and a human-readable source label. Throws on invalid input.
 */
function resolvePriceArg(raw: string): { price: number; src: string } {
  const m = PRICE_EXPR.exec(raw);
  if (m) {
    const file = m[1] === "last" ? LAST_FILE : MARK_FILE;
    const base = readPriceFile(file);
    const delta = parseFloat(m[3]);
    const price = m[2] === "+" ? base + delta : base - delta;
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`Invalid price for --price: "${raw}" → $${price}`);
    }
    const rounded = Math.round(price * 10_000) / 10_000;
    return { price: rounded, src: `${raw} → $${rounded.toFixed(4)}` };
  }
  if (raw === "last" || raw === "mark") {
    const file = raw === "last" ? LAST_FILE : MARK_FILE;
    const price = readPriceFile(file);
    return { price, src: `${raw}.txt ($${price.toFixed(4)})` };
  }
  const price = parseFloat(raw);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`Invalid --price: "${raw}" — use a number, "last", "mark", or "last±delta" / "mark±delta"`);
  }
  return { price: Math.round(price * 10_000) / 10_000, src: `--price $${price.toFixed(4)}` };
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) usage();
  // No options at all → show usage instead of silently placing the default
  // long ladder from $70 → $83.
  if (process.argv.length <= 2) usage();
  const dryRun = process.argv.includes("--dry-run");

  const symbol = getArgValue("--symbol") ?? SYMBOL;

  // --price <n|last|mark|last±delta|mark±delta> is shorthand for a single-rung
  // ladder (--from X --to X). It cannot be combined with --from / --to.
  const priceArg = getArgValue("--price");
  const fromArg = getArgValue("--from");
  const toArg = getArgValue("--to");
  let from: number;
  let to: number;
  let priceSrc: string | null = null;
  if (priceArg !== undefined) {
    if (fromArg !== undefined || toArg !== undefined) {
      console.error(`✗  --price cannot be combined with --from / --to`);
      process.exit(1);
    }
    try {
      const r = resolvePriceArg(priceArg);
      from = to = r.price;
      priceSrc = r.src;
    } catch (err: unknown) {
      console.error(`✗  ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  } else {
    from = numArg("--from", FROM);
    to = numArg("--to", TO);
  }
  const step = numArg("--step", STEP);
  const qty = numArg("--qty", QTY);
  const leverage = numArg("--leverage", LEVERAGE);

  const sideArg = (getArgValue("--side") ?? "long").toLowerCase();
  if (sideArg !== "long" && sideArg !== "short") {
    console.error(`✗  Invalid --side "${sideArg}" — expected "long" or "short"`);
    process.exit(1);
  }
  const side: "Buy" | "Sell" = sideArg === "long" ? "Buy" : "Sell";
  const posSide: "Long" | "Short" = sideArg === "long" ? "Long" : "Short";

  if (to < from) {
    console.error(`✗  --to (${to}) must be >= --from (${from})`);
    process.exit(1);
  }
  if (step <= 0) {
    console.error(`✗  --step must be > 0 (got ${step})`);
    process.exit(1);
  }
  if (qty <= 0) {
    console.error(`✗  --qty must be > 0 (got ${qty})`);
    process.exit(1);
  }

  // Build the ladder (rounded to 4 dp so prices are valid Rp values).
  const prices: number[] = [];
  for (let p = from; p <= to + 1e-9; p += step) {
    prices.push(Math.round(p * 10_000) / 10_000);
  }

  console.log(`[${fmtTime()}] ═ ${symbol} ${posSide} Limit Ladder ═══════════════════════`);
  if (priceSrc !== null) {
    console.log(`[${fmtTime()}]   Price:     ${priceSrc}`);
  } else {
    console.log(`[${fmtTime()}]   Range:     $${from} → $${to} (inclusive)`);
  }
  console.log(`[${fmtTime()}]   Step:      $${step}   orders: ${prices.length}`);
  console.log(`[${fmtTime()}]   Qty/order: ${qty}   leverage: ${leverage}x   side: ${side} / ${posSide}`);
  console.log(`[${fmtTime()}]   Mode:      ${dryRun ? "DRY-RUN — no orders will be placed" : "LIVE — placing orders"}`);
  console.log(`[${fmtTime()}] ══════════════════════════════════════════════════════`);

  if (dryRun) {
    for (const price of prices) {
      console.log(`  ·  ${side} ${qty} ${symbol} @ $${price.toFixed(4)}  (dry-run)`);
    }
    console.log(`[${fmtTime()}] ✔  ${prices.length} rung(s) would be placed — nothing sent to the exchange.`);
    return;
  }

  const creds = loadCredentialsPath(CREDS_FILE);
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  await setLeverageUsdtM(symbol, leverage, posSide, creds.PHEMEX_API_KEY, secretRaw);
  console.log(`[${fmtTime()}]   ✓  Leverage set to ${leverage}x on ${symbol} (${posSide})`);

  let placed = 0;
  let failed = 0;
  for (const price of prices) {
    try {
      const result = await placeLinear(
        { account: "usdt-m", symbol, side, price, qty, posSide },
        creds.PHEMEX_API_KEY,
        secretRaw,
      );
      console.log(
        `[${fmtTime()}]   ✓  ${side} ${qty} ${symbol} @ $${price.toFixed(4)} — orderID: ${result.orderID ?? result.clOrdID ?? "—"}  status: ${result.ordStatus ?? "—"}`,
      );
      placed++;
    } catch (err: unknown) {
      console.error(
        `[${fmtTime()}]   ✗  ${side} ${qty} ${symbol} @ $${price.toFixed(4)} — ${err instanceof Error ? err.message : String(err)}`,
      );
      failed++;
    }
    await new Promise((r) => setTimeout(r, ORDER_DELAY_MS));
  }

  console.log(`[${fmtTime()}] ══════════════════════════════════════════════════════`);
  console.log(`[${fmtTime()}] ✔  Done — ${placed} placed, ${failed} failed (of ${prices.length} rungs).`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
