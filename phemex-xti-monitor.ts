#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-xti-monitor.ts — Monitor XTIUSDT position in an infinite loop.
 *
 * - Polls USDT-M positions every ~2 s.
 * - When unrealized PnL drops below -100% of margin (or no position exists),
 *   closes the current position via market order, then opens a new long
 *   XTIUSDT position at 0.01 contracts.
 * - Loops indefinitely.  Ctrl+C (SIGINT) to stop.
 *
 * Usage:
 *   npx tsx phemex-xti-monitor.ts
 */

import { base64UrlDecode } from "./src/http-client.js";
import { loadCredentials } from "./src/credentials.js";
import { placeMarketOrder, setLeverageUsdtM } from "./src/place-limit-order.js";

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

const SYMBOL = "XTIUSDT";
const POSITION_QTY = 0.01;       // contracts to open on each new long
const PNL_THRESHOLD_PCT = -100;   // close when PnL < this % of margin
const LEVERAGE = 100;             // leverage to set
const POLL_INTERVAL_MS = 2_000;  // ms between position polls

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Position {
  symbol: string;
  side: "Buy" | "Sell" | "None";
  size: string;
  avgEntryPrice: string;
  avgEntryPriceRp: string;
  markPriceRp: string;
  posCostRv: string;
  leverageRr: string;
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

function fmtTime(): string {
  return new Date().toLocaleString();
}

function fmtNum(n: number, d: number = 2): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

/* ------------------------------------------------------------------ */
/*  API — one signed GET                                              */
/* ------------------------------------------------------------------ */

import { httpGet } from "./src/http-client.js";

async function fetchPositions(
  apiKey: string,
  secretRaw: Buffer,
): Promise<Position[]> {
  const resp = (await httpGet(
    "/g-accounts/accountPositions",
    "currency=USDT",
    apiKey,
    secretRaw,
  )) as unknown as ApiResponse;

  if (resp.code !== 0) {
    console.error(`[${fmtTime()}]  ✗  API error: ${resp.msg ?? resp.code}`);
    return [];
  }
  const positions = resp.data?.positions ?? [];
  // Return only open positions (side !== "None")
  return positions.filter((p) => p.side !== "None" && p.size !== "0");
}

/* ------------------------------------------------------------------ */
/*  Core logic                                                         */
/* ------------------------------------------------------------------ */

/**
 * Calculate the unrealized PnL as a percentage of the position margin.
 *
 * The Phemex API returns Rv (valueRt) fields already in USDT (human-readable).
 * No scaling by 10000 is needed.
 *
 * margin  = posCostRv         (USDT)
 * pnl     = (markPriceRp - avgEntryPriceRp) * size
 * pnlPct  = pnl / margin * 100
 */
function calcPnlPct(pos: Position): number {
  const size = parseFloat(pos.size || "0");
  const entry = parseFloat(pos.avgEntryPriceRp || "0");
  const mark = parseFloat(pos.markPriceRp || "0");
  const margin = parseFloat(pos.posCostRv || "0");

  if (margin <= 0) return 0;

  // Unrealized PnL: (mark - entry) * size for longs; (entry - mark) * size for shorts
  const pnl = pos.side === "Buy"
    ? (mark - entry) * size
    : (entry - mark) * size;

  return (pnl / margin) * 100;
}

async function closePosition(
  pos: Position,
  apiKey: string,
  secretRaw: Buffer,
): Promise<void> {
  const closeSide = pos.side === "Buy" ? "Sell" : "Buy";
  const closePosSide = pos.side === "Buy" ? "Long" : "Short";
  const size = parseFloat(pos.size || "0");

  console.log(`[${fmtTime()}]  ⟐  Closing ${pos.symbol} (${pos.side} → ${closeSide})  qty: ${size} …`);
  await placeMarketOrder(
    {
      account: "usdt-m",
      symbol: pos.symbol,
      side: closeSide,
      qty: size,
      posSide: closePosSide,
      price: 0,
    },
    apiKey,
    secretRaw,
  );
  console.log(`[${fmtTime()}]  ✓  Position closed`);
}

async function openLong(
  apiKey: string,
  secretRaw: Buffer,
): Promise<void> {
  console.log(`[${fmtTime()}]  ⟐  Opening long ${SYMBOL}  qty: ${POSITION_QTY} …`);

  // Set leverage first
  await setLeverageUsdtM(SYMBOL, LEVERAGE, "Long", apiKey, secretRaw);

  // Place market order
  await placeMarketOrder(
    {
      account: "usdt-m",
      symbol: SYMBOL,
      side: "Buy",
      qty: POSITION_QTY,
      posSide: "Long",
      price: 0,
    },
    apiKey,
    secretRaw,
  );
  console.log(`[${fmtTime()}]  ✓  Long position opened`);
}

/* ------------------------------------------------------------------ */
/*  Main loop                                                          */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const creds = loadCredentials(import.meta.dirname);
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  console.log(`[${fmtTime()}]  ⚡  Starting XTIUSDT position monitor`);
  console.log(`     Symbol:       ${SYMBOL}`);
  console.log(`     Qty per open: ${POSITION_QTY}`);
  console.log(`     PnL trigger:  < ${PNL_THRESHOLD_PCT}%`);
  console.log(`     Leverage:     ${LEVERAGE}x`);
  console.log(`     Poll every:   ${POLL_INTERVAL_MS / 1000}s`);
  console.log("");

  // Register Ctrl+C handler
  let running = true;
  process.on("SIGINT", () => {
    console.log(`\n[${fmtTime()}]  ⏹  Shutting down …`);
    running = false;
  });

  while (running) {
    try {
      const positions = await fetchPositions(creds.PHEMEX_API_KEY, secretRaw);
      const xtiPos = positions.find((p) => p.symbol === SYMBOL);

      if (!xtiPos) {
        // No position — open a new long
        console.log(`[${fmtTime()}]  ℹ  No ${SYMBOL} position found — opening new long …`);
        await openLong(creds.PHEMEX_API_KEY, secretRaw);
      } else {
        const pnlPct = calcPnlPct(xtiPos);
        const entry = parseFloat(xtiPos.avgEntryPriceRp || "0");
        const mark = parseFloat(xtiPos.markPriceRp || "0");
        const size = parseFloat(xtiPos.size || "0");
        const margin = parseFloat(xtiPos.posCostRv || "0");

        console.log(
          `[${fmtTime()}]  ${SYMBOL}  ${xtiPos.side.padEnd(4)}  ` +
          `size: ${fmtNum(size, 4)}  entry: ${fmtNum(entry)}  mark: ${fmtNum(mark)}  ` +
          `PnL: ${pnlPct >= 0 ? "+" : ""}${fmtNum(pnlPct, 2)}%  ` +
          `margin: $${fmtNum(margin, 4)}`
        );

        if (pnlPct < PNL_THRESHOLD_PCT) {
          console.log(
            `[${fmtTime()}]  ⚠  PnL ${fmtNum(pnlPct, 2)}% is below threshold ` +
            `(${PNL_THRESHOLD_PCT}%) — closing and reopening …`
          );

          // Close current position
          await closePosition(xtiPos, creds.PHEMEX_API_KEY, secretRaw);

          // Small delay to let the close settle
          await new Promise((r) => setTimeout(r, 1_000));

          // Open new long
          await openLong(creds.PHEMEX_API_KEY, secretRaw);
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${fmtTime()}]  ✗  Error: ${msg}`);
    }

    // Wait for next poll interval
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  console.log(`[${fmtTime()}]  ✅  Monitor stopped`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
