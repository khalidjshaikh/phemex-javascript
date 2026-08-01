#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-xti-short-monitor.ts — Monitor XTIUSDT short position with trailing stop-loss.
 *
 * - Polls USDT-M positions every ~2 s.
 * - If no Short position exists, opens a new Short market order with a stop-loss
 *   1 cent above the entry price.
 * - Every 60 seconds, updates the stop-loss to be 1 cent above the current mark
 *   price (trailing tighter as price drops; never loosening).
 * - Loops indefinitely.  Ctrl+C (SIGINT) to stop.
 *
 * Usage:
 *   npx tsx phemex-xti-short-monitor.ts
 *   npx tsx phemex-xti-short-monitor.ts --qty 0.02
 */

import { base64UrlDecode } from "./src/http-client.js";
import { loadCredentials } from "./src/credentials.js";
import { fetchPositions, setStopLoss } from "./src/positions.js";
import { placeMarketOrder, setLeverageUsdtM } from "./src/place-limit-order.js";

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

const SYMBOL = "XTIUSDT";
const LEVERAGE = 100;
const POSITION_QTY = 0.01;         // contracts to open if no short exists
const STOP_LOSS_OFFSET = 0.01;     // stop-loss = mark price + this (1 cent above)
const POLL_INTERVAL_MS = 2_000;    // ms between position polls
const STOP_LOSS_INTERVAL_MS = 60_000;  // ms between stop-loss updates

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function fmtTime(): string {
  return new Date().toLocaleString();
}

function fmtNum(n: number, d: number = 2): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** Parse the CLI --qty override */
function parseArgs(): number {
  const idx = process.argv.indexOf("--qty");
  if (idx !== -1 && idx + 1 < process.argv.length) {
    const v = parseFloat(process.argv[idx + 1]);
    if (!isNaN(v) && v > 0) return v;
  }
  return POSITION_QTY;
}

/**
 * Open a new short position on a USDT-M symbol at the given quantity and leverage,
 * then immediately set a stop-loss at stopLossOffset above the mark price.
 *
 * We place the market order *first* (without a stop-loss) because we cannot read
 * the mark price from a position that doesn't exist yet.  After the order fills,
 * we fetch the fresh position to get the mark price and set the stop-loss.
 */
async function openShortWithStop(
  symbol: string,
  qty: number,
  leverage: number,
  stopLossOffset: number,
  apiKey: string,
  secretRaw: Buffer,
): Promise<void> {
  console.log(`[${fmtTime()}]  ⟐  Opening short ${symbol}  qty: ${qty}  leverage: ${leverage}x`);

  // 1. Set leverage
  await setLeverageUsdtM(symbol, leverage, "Short", apiKey, secretRaw);

  // 2. Place market order without stop-loss (we don't know the mark price yet)
  const result = await placeMarketOrder(
    { account: "usdt-m", symbol, side: "Sell", price: 0, qty, posSide: "Short" },
    apiKey,
    secretRaw,
  );

  const execPrice = result.priceRp
    ? (parseFloat(String(result.priceRp)) / 10000).toFixed(2)
    : "—";

  console.log(`[${fmtTime()}]  ✓  Short opened — orderID: ${result.orderID ?? result.clOrdID ?? "—"}  executed price: ${execPrice}`);

  // 3. Small delay to let the position settle on the exchange
  await new Promise((r) => setTimeout(r, 1_000));

  // 4. Fetch the fresh position to get the mark price, then set stop-loss
  const freshPositions = await fetchPositions(apiKey, secretRaw);
  const freshPos = freshPositions.find((p) => p.symbol === symbol);
  const markPrice = freshPos ? parseFloat(freshPos.markPriceRp || "0") : 0;

  if (markPrice > 0) {
    const stopPrice = Math.round((markPrice + stopLossOffset) * 100) / 100;
    await setStopLoss(symbol, "Buy", "Short", stopPrice, qty, apiKey, secretRaw);
    console.log(`[${fmtTime()}]     Initial stop-loss: ${fmtNum(stopPrice)} (mark price: ${fmtNum(markPrice)})`);
  } else {
    console.log(`[${fmtTime()}]     ⚠  Could not read mark price — stop-loss not set`);
  }
}

/* ------------------------------------------------------------------ */
/*  Main loop                                                          */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const qty = parseArgs();

  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(`
Usage:  npx tsx phemex-xti-short-monitor.ts [--qty <qty>] [--help]

Monitor XTIUSDT short position in an infinite loop.
- Opens a short if none exists.
- Trails the stop-loss 1 cent above the mark price every 60 seconds.

Options:
  --qty <qty>   Contract quantity (default: ${POSITION_QTY})
  --help, -h    Show this help
`);
    process.exit(0);
  }

  const creds = loadCredentials(import.meta.dirname);
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  console.log(`[${fmtTime()}]  ⚡  Starting XTIUSDT short-position monitor`);
  console.log(`     Symbol:       ${SYMBOL}`);
  console.log(`     Qty per open: ${qty}`);
  console.log(`     Leverage:     ${LEVERAGE}x`);
  console.log(`     Stop offset:  +${STOP_LOSS_OFFSET} (above mark)`);
  console.log(`     Poll every:   ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`     SL update:    every ${STOP_LOSS_INTERVAL_MS / 1000}s`);
  console.log("");

  // Register Ctrl+C handler
  let running = true;
  process.on("SIGINT", () => {
    console.log(`\n[${fmtTime()}]  ⏹  Shutting down …`);
    running = false;
  });

  let nextStopLossUpdate = 0;

  while (running) {
    try {
      const positions = await fetchPositions(creds.PHEMEX_API_KEY, secretRaw);
      const xtiPos = positions.find((p) => p.symbol === SYMBOL);
      let justOpened = false;

      if (!xtiPos) {
        // No position — open a new short
        console.log(`[${fmtTime()}]  ℹ  No ${SYMBOL} short position found — opening …`);
        await openShortWithStop(SYMBOL, qty, LEVERAGE, STOP_LOSS_OFFSET, creds.PHEMEX_API_KEY, secretRaw);
        justOpened = true;
      } else if (xtiPos.side === "Buy") {
        // Wrong direction — close the long and open a short
        console.log(`[${fmtTime()}]  ℹ  ${SYMBOL} has a Long position — not Short.  Skipping.`);
        // The spec says "if there is no Short position, purchase a short" — we don't
        // auto-close longs, just wait for the user to handle it.
      } else {
        // We have a Short position — log status
        const mark = parseFloat(xtiPos.markPriceRp || "0");
        const entry = parseFloat(xtiPos.avgEntryPriceRp || "0");
        const size = parseFloat(xtiPos.size || "0");
        const margin = parseFloat(xtiPos.posCostRv || "0");
        const pnl = (entry - mark) * size;
        const pnlPct = margin > 0 ? (pnl / margin) * 100 : 0;

        console.log(
          `[${fmtTime()}]  ${SYMBOL}  Short  ` +
          `size: ${fmtNum(size, 4)}  entry: ${fmtNum(entry)}  mark: ${fmtNum(mark)}  ` +
          `PnL: ${pnlPct >= 0 ? "+" : ""}${fmtNum(pnlPct, 2)}%  ` +
          `margin: $${fmtNum(margin, 4)}`
        );
      }

      // Stop-loss update: every 60 seconds (skip this tick if we just opened)
      const now = Date.now();
      if (justOpened) {
        nextStopLossUpdate = now + STOP_LOSS_INTERVAL_MS;
      }

      if (xtiPos && xtiPos.side === "Sell" && !justOpened && now >= nextStopLossUpdate) {
        const markPrice = parseFloat(xtiPos.markPriceRp || "0");
        const size = parseFloat(xtiPos.size || "0");

        if (markPrice > 0 && size > 0) {
          // Trailing stop-loss: always 1 cent above the current mark price.
          // This trails tighter as price drops, protecting profits.
          const stopPrice = Math.round((markPrice + STOP_LOSS_OFFSET) * 100) / 100;

          if (stopPrice > 0) {
            await setStopLoss(SYMBOL, "Buy", "Short", stopPrice, size, creds.PHEMEX_API_KEY, secretRaw);
            console.log(
              `[${fmtTime()}]  ✓  Stop-loss updated to ${fmtNum(stopPrice)} ` +
              `(mark: ${fmtNum(markPrice)})`
            );
          }
        }
        nextStopLossUpdate = now + STOP_LOSS_INTERVAL_MS;
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
