#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-usdt-positions.ts  —  Retrieve USDT-M (linear perpetual) open positions
 * from Phemex.  Credentials are read from .phemex-credentials.json.
 *
 * Endpoint:  GET /g-accounts/accountPositions?currency=<currency>
 *
 * Usage:
 *   npx tsx phemex-usdt-positions.ts            — show open positions
 *   npx tsx phemex-usdt-positions.ts --close-all — close all open positions
 */

import { httpGet, base64UrlDecode } from "./src/http-client.js";
import { loadCredentials } from "./src/credentials.js";
import { placeMarketOrder } from "./src/place-limit-order.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Position {
  symbol: string;
  currency: string;
  side: "Buy" | "Sell" | "None";
  positionStatus: string;
  crossMargin: boolean;
  size: string;            // string from API, e.g. "0.01"
  avgEntryPrice: string;   // string from API, e.g. "75.52"
  markPriceRp: string;     // mark price, e.g. "80.06"
  valueRv: string;         // raw value (÷10000 for human)
  posCostRv: string;       // raw position cost (÷10000)
  leverageRr: string;      // e.g. "-100"
  liquidationPriceRp: string; // liquidation price
  unrealisedPnl?: string;
  [key: string]: unknown;
}

interface ApiResponse {
  code: number;
  msg?: string;
  data?: {
    account?: Record<string, unknown>;
    positions?: Position[];
  };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function usage(): never {
  console.log(`
Usage:  ./phemex-usdt-positions.ts [--close-all] [--help]

Retrieve USDT-M (linear perpetual) open positions from Phemex.
Credentials are read from .phemex-credentials.json.

Options:
  --close-all            Close all open positions via market orders
  --close-from <size>    Close positions with size > <size> (e.g. --close-from 1)
  --help, -h             Show this help message

Examples:
  ./phemex-usdt-positions.ts                     Show open positions
  ./phemex-usdt-positions.ts --close-all          Show positions then close them all
  ./phemex-usdt-positions.ts --close-from 1       Close positions where size > 1
`);
  process.exit(0);
}

/** Convert a scaled Phemex value (Rv/Rq) to human-readable using the scale factor */
function toHuman(val: unknown, scale: number): number {
  if (val == null) return 0;
  return Number(val) / scale;
}

/** Perform one signed GET request and parse the JSON response */
async function get(
  path: string,
  query: string | null,
  apiKey: string,
  secretRaw: Buffer,
): Promise<ApiResponse> {
  return httpGet(path, query, apiKey, secretRaw).then(r => r as unknown as ApiResponse);
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) usage();

  /* -- Read credentials ------------------------------------------- */
  const creds = loadCredentials(import.meta.dirname);
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  const CLOSE_ALL = process.argv.includes("--close-all");

  const closeFromIdx = process.argv.indexOf("--close-from");
  const CLOSE_FROM = closeFromIdx !== -1 ? parseFloat(process.argv[closeFromIdx + 1]) : NaN;
  if (closeFromIdx !== -1 && (isNaN(CLOSE_FROM) || CLOSE_FROM <= 0)) {
    console.error("error: --close-from requires a positive number, e.g. --close-from 1");
    process.exit(1);
  }

  /* -- Query USDT-M positions for each settlement currency -------- */
  const settlementCurrencies = ["USDT", "USD"];
  const allPositions: Position[] = [];

  for (const cur of settlementCurrencies) {
    process.stdout.write(`⟐  USDT-M (${cur}) … `);
    try {
      const resp = await get("/g-accounts/accountPositions", `currency=${cur}`, creds.PHEMEX_API_KEY, secretRaw);
      if (resp.code !== 0) {
        console.log(`API error: ${resp.msg ?? resp.code}`);
        continue;
      }
      const positions = resp.data?.positions ?? [];
      // Keep only OPEN positions (side = Long/Short, not "None")
      const open = positions.filter((p) => p.side !== "None" && p.size !== "0");
      allPositions.push(...open);
      console.log(`${open.length} position(s) open`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`error: ${msg}`);
    }
  }

  /* -- Output ----------------------------------------------------- */
  if (allPositions.length === 0) {
    console.log("\nNo open USDT-M positions.");
    process.exit(0);
  }

  console.log(
    `\n${"Symbol".padEnd(12)} ${"Side".padEnd(7)} ${"Size".padStart(10)} ` +
    `${"Entry Price".padStart(14)} ${"Mark Price".padStart(14)} ${"Value".padStart(14)} ` +
    `${"P&L".padStart(12)} ${"Leverage".padStart(9)} ${"Liq. Price".padStart(14)} ${"Margin".padStart(12)}`
  );
  console.log("─".repeat(136));

  for (const p of allPositions) {
    const entry = parseFloat(p.avgEntryPrice || "0");
    const mark = parseFloat(p.markPriceRp || "0");
    const size = parseFloat(p.size || "0");
    const value = parseFloat(p.valueRv || "0") / 10000;
    const pnl = (mark - entry) * size;
    const lev = p.leverageRr ? Math.abs(parseFloat(p.leverageRr)) : 0;
    const liq = parseFloat(p.liquidationPriceRp || "0");
    const margin = parseFloat(p.posCostRv || "0") / 10000;

    const sideFmt = p.side.padEnd(6);
    const sizeFmt = size.toFixed(4).padStart(10);
    const entryFmt = entry.toFixed(2).padStart(14);
    const markFmt = mark.toFixed(2).padStart(14);
    const valueFmt = value.toFixed(2).padStart(14);
    const pnlFmt = (pnl >= 0 ? "+" : "") + pnl.toFixed(2).padStart(11);
    const levFmt = (lev === 0 ? "∞" : lev.toFixed(1)).padStart(9);
    const liqFmt = liq.toFixed(2).padStart(14);
    const marginFmt = margin.toFixed(4).padStart(12);

    console.log(
      `${p.symbol.padEnd(12)} ${sideFmt} ${sizeFmt} ${entryFmt} ${markFmt} ${valueFmt} ` +
      `${pnlFmt} ${levFmt} ${liqFmt} ${marginFmt}`
    );
  }
  console.log("─".repeat(136));

  /* -- Close positions (--close-all or --close-from) ------------------ */
  const DO_CLOSE = CLOSE_ALL || !isNaN(CLOSE_FROM);
  if (DO_CLOSE) {
    const toClose = CLOSE_ALL
      ? allPositions
      : allPositions.filter((p) => parseFloat(p.size || "0") > CLOSE_FROM);

    if (toClose.length === 0) {
      console.log(`\nNo positions with size > ${CLOSE_FROM} to close.`);
      process.exit(0);
    }

    console.log(`\n⟐  Closing / trimming ${toClose.length} position(s) via market orders …`);
    const results = await Promise.allSettled(
      toClose.map(async (p) => {
        const posSide = p.side === "Sell" ? "Short" : "Long";
        const closeSide = p.side === "Buy" ? "Sell" : "Buy";
        const size = parseFloat(p.size || "0");

        // For XTIUSDT: only sell the excess above CLOSE_FROM (leave 1 unit)
        // For other symbols: sell the full position
        const qty = (!CLOSE_ALL && p.symbol === "XTIUSDT")
          ? parseFloat((size - CLOSE_FROM).toFixed(8))
          : size;

        const label = qty === size ? "closing" : `trimming by ${qty}`;
        console.log(`   ${p.symbol} — ${label} (${posSide} → ${closeSide}) …`);
        await placeMarketOrder(
          { account: "usdt-m", symbol: p.symbol, side: closeSide, qty, posSide, price: 0 },
          creds.PHEMEX_API_KEY,
          secretRaw,
        );
        console.log(`   ✓  ${p.symbol} — done`);
      }),
    );
    for (const r of results) {
      if (r.status === "rejected") {
        console.error(`   ✗  ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
      }
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});