#!/usr/bin/env -S npx tsx
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
 *   npx tsx phemex-usdt-positions.ts --loop      — poll positions every 2s
 *   npx tsx phemex-usdt-positions.ts --loop --interval 5000 — poll every 5s
 */

import { httpGet, base64UrlDecode } from "../src/http-client.js";
import { loadCredentials } from "../src/credentials.js";
import { placeMarketOrder } from "../src/place-limit-order.js";

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
  maintMarginReqRr?: string;  // maintenance margin requirement ratio, e.g. "0.005" (0.5%)
  assignedPosBalanceRv?: string; // assigned position balance (USDT)
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
Usage:  ./phemex-usdt-positions.ts [options]

Retrieve USDT-M (linear perpetual) open positions from Phemex.
Credentials are read from .phemex-credentials.json.

Options:
  --close-all            Close all open positions via market orders
  --close-from <size>    Close positions with size > <size> (e.g. --close-from 1)
  --close-long <symbol>  Close long (Buy) positions for a specific symbol only
  --close-short <symbol> Close short (Sell) positions for a specific symbol only
  --loop                 Continuously poll positions every <interval> ms
  --interval <ms>        Polling interval in ms (default 2000, with --loop)
  --once                 With --loop: single poll, then exit
  --help, -h             Show this help message

Examples:
  ./phemex-usdt-positions.ts                               Show open positions
  ./phemex-usdt-positions.ts --close-all                    Show positions then close them all
  ./phemex-usdt-positions.ts --close-from 1                 Close positions where size > 1
  ./phemex-usdt-positions.ts --close-long BTCUSDT           Close long positions for BTCUSDT only
  ./phemex-usdt-positions.ts --loop                         Poll every 2 s
  ./phemex-usdt-positions.ts --loop --interval 5000         Poll every 5 s
  ./phemex-usdt-positions.ts --loop --once                  Single poll (loop mode)
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

/** sleep for a given number of milliseconds */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll all USDT-M positions, print the table and long totals.
 * Returns the list of open positions for downstream close logic.
 */
async function pollPositions(
  apiKey: string,
  secretRaw: Buffer,
): Promise<Position[]> {
  const settlementCurrencies = ["USDT", "USD"];
  const allPositions: Position[] = [];

  for (const cur of settlementCurrencies) {
    process.stdout.write(`⟐  USDT-M (${cur}) … `);
    try {
      const resp = await get("/g-accounts/accountPositions", `currency=${cur}`, apiKey, secretRaw);
      if (resp.code !== 0) {
        console.log(`API error: ${resp.msg ?? resp.code}`);
        continue;
      }
      const positions = resp.data?.positions ?? [];
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
    return allPositions;
  }

  console.log(
    `\n${"Symbol".padEnd(12)} ${"Side".padEnd(7)} ${"Size".padStart(10)} ` +
    `${"Entry Price".padStart(14)} ${"Mark Price".padStart(14)} ${"Value".padStart(14)} ` +
    `${"P&L".padStart(12)} ${"Leverage".padStart(9)} ${"Liq. Price".padStart(14)} ${"Margin".padStart(12)} ${"Mgn Ratio".padStart(10)}`
  );
  console.log("─".repeat(147));

  for (const p of allPositions) {
    const entry = parseFloat(p.avgEntryPrice || "0");
    const mark = parseFloat(p.markPriceRp || "0");
    const size = parseFloat(p.size || "0");
    const value = parseFloat(p.valueRv || "0") / 10000;
    const pnl = (mark - entry) * size;
    const lev = p.leverageRr ? Math.abs(parseFloat(p.leverageRr)) : 0;
    const liq = parseFloat(p.liquidationPriceRp || "0");
    const margin = parseFloat(p.posCostRv || "0") / 10000;
    const maintMargin = parseFloat(p.valueRv || "0") * parseFloat(p.maintMarginReqRr || "0");
    const marginRatio = maintMargin / parseFloat(p.assignedPosBalanceRv || "1");
    const sideFmt = p.side.padEnd(6);
    const sizeFmt = size.toFixed(4).padStart(10);
    const entryFmt = entry.toFixed(2).padStart(14);
    const markFmt = mark.toFixed(2).padStart(14);
    const valueFmt = value.toFixed(2).padStart(14);
    const pnlFmt = (pnl >= 0 ? "+" : "") + pnl.toFixed(2).padStart(11);
    const levFmt = (lev === 0 ? "∞" : lev.toFixed(1)).padStart(9);
    const liqFmt = liq.toFixed(2).padStart(14);
    const marginFmt = margin.toFixed(4).padStart(12);
    const mgnRatioFmt = marginRatio.toFixed(4).padStart(10);

    console.log(
      `${p.symbol.padEnd(12)} ${sideFmt} ${sizeFmt} ${entryFmt} ${markFmt} ${valueFmt} ` +
      `${pnlFmt} ${levFmt} ${liqFmt} ${marginFmt} ${mgnRatioFmt}`
    );
  }
  console.log("─".repeat(147));

  /* -- Long-size totals for tracked symbols ------------------------------ */
  const TRACKED_SYMBOLS = ["XBRUSDT", "XTIUSDT"];
  console.log("\nLong totals:");
  let grandTotal = 0;
  for (const sym of TRACKED_SYMBOLS) {
    const size = allPositions
      .filter((p) => p.symbol === sym && p.side === "Buy")
      .reduce((sum, p) => sum + parseFloat(p.size || "0"), 0);
    grandTotal += size;
    console.log(`  ${sym.padEnd(10)} ${size.toFixed(4).padStart(10)}`);
  }
  console.log(`  ${"TOTAL".padEnd(10)} ${grandTotal.toFixed(4).padStart(10)}`);

  return allPositions;
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) usage();

  /* -- Read credentials ------------------------------------------- */
  const creds = loadCredentials();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  const CLOSE_ALL = process.argv.includes("--close-all");

  const closeFromIdx = process.argv.indexOf("--close-from");
  const CLOSE_FROM = closeFromIdx !== -1 ? parseFloat(process.argv[closeFromIdx + 1]) : NaN;
  if (closeFromIdx !== -1 && (isNaN(CLOSE_FROM) || CLOSE_FROM <= 0)) {
    console.error("error: --close-from requires a positive number, e.g. --close-from 1");
    process.exit(1);
  }

  const closeLongIdx = process.argv.indexOf("--close-long");
  const CLOSE_LONG_SYMBOL = closeLongIdx !== -1 ? process.argv[closeLongIdx + 1] ?? "" : "";
  if (closeLongIdx !== -1 && !CLOSE_LONG_SYMBOL) {
    console.error("error: --close-long requires a symbol, e.g. --close-long BTCUSDT");
    process.exit(1);
  }

  const closeShortIdx = process.argv.indexOf("--close-short");
  const CLOSE_SHORT_SYMBOL = closeShortIdx !== -1 ? process.argv[closeShortIdx + 1] ?? "" : "";
  if (closeShortIdx !== -1 && !CLOSE_SHORT_SYMBOL) {
    console.error("error: --close-short requires a symbol, e.g. --close-short BTCUSDT");
    process.exit(1);
  }

  /* -- Loop mode -------------------------------------------------- */
  const LOOP_MODE = process.argv.includes("--loop");
  const LOOP_ONCE = process.argv.includes("--once");
  const loopIdx = process.argv.indexOf("--interval");
  const LOOP_INTERVAL = loopIdx !== -1 ? Math.max(parseInt(process.argv[loopIdx + 1], 10) || 2000, 200) : 2000;

  const DO_CLOSE = CLOSE_ALL || !isNaN(CLOSE_FROM) || !!CLOSE_LONG_SYMBOL || !!CLOSE_SHORT_SYMBOL;
  if (LOOP_MODE && DO_CLOSE) {
    console.error("error: --loop is not compatible with --close-* flags");
    process.exit(1);
  }

  if (LOOP_MODE) {
    process.stdout.write(`Loop mode — polling every ${LOOP_INTERVAL} ms`);
    if (LOOP_ONCE) process.stdout.write(" (once)");
    process.stdout.write("\n\n");
    while (true) {
      await pollPositions(creds.PHEMEX_API_KEY, secretRaw);
      if (LOOP_ONCE) break;
      await sleep(LOOP_INTERVAL);
      console.clear();
    }
    process.exit(0);
  }

  /* -- Single run: fetch & print ---------------------------------- */
  const allPositions = await pollPositions(creds.PHEMEX_API_KEY, secretRaw);
  if (allPositions.length === 0) process.exit(0);
  // console.dir(allPositions, { depth: null, colors: true });

  /* -- Close positions (--close-all, --close-from, or --close-long) ------ */
  if (DO_CLOSE) {
    let toClose: Position[];
    if (CLOSE_ALL) {
      toClose = allPositions;
    } else if (!isNaN(CLOSE_FROM)) {
      toClose = allPositions.filter((p) => parseFloat(p.size || "0") > CLOSE_FROM);
    } else if (!!CLOSE_LONG_SYMBOL) {
      toClose = allPositions.filter((p) => p.symbol === CLOSE_LONG_SYMBOL && p.side === "Buy");
    } else {
      toClose = allPositions.filter((p) => p.symbol === CLOSE_SHORT_SYMBOL && p.side === "Sell");
    }

    if (toClose.length === 0) {
      if (CLOSE_ALL) {
        console.log("\nNo positions to close.");
      } else if (!isNaN(CLOSE_FROM)) {
        console.log(`\nNo positions with size > ${CLOSE_FROM} to close.`);
      } else if (!!CLOSE_LONG_SYMBOL) {
        console.log(`\nNo long positions for ${CLOSE_LONG_SYMBOL} to close.`);
      } else {
        console.log(`\nNo short positions for ${CLOSE_SHORT_SYMBOL} to close.`);
      }
      process.exit(0);
    }

    console.log(`\n⟐  Closing / trimming ${toClose.length} position(s) via market orders …`);
    const results = await Promise.allSettled(
      toClose.map(async (p) => {
        const posSide = p.side === "Sell" ? "Short" : "Long";
        const closeSide = p.side === "Buy" ? "Sell" : "Buy";
        const size = parseFloat(p.size || "0");

        // XTIUSDT special: only trim excess above CLOSE_FROM (leave 1 unit).
        // Not applicable for --close-all or --close-long.
        const qty = (!isNaN(CLOSE_FROM) && p.symbol === "XTIUSDT")
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