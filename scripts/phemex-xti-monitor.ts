#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-xti-monitor.ts — Monitor a USDT-M perpetual position in an infinite loop.
 *
 * - Polls USDT-M positions every ~2 s.
 * - When unrealized PnL drops below threshold (or no position exists),
 *   closes the current position via market order, then opens a new long.
 * - Loops indefinitely.  Ctrl+C (SIGINT) to stop.
 *
 * Usage:
 *   npx tsx phemex-xti-monitor.ts
 *   npx tsx phemex-xti-monitor.ts --symbol XBRUSDT
 *   npx tsx phemex-xti-monitor.ts --symbol XBRUSDT --qty 0.02 --leverage 50 --pnl-threshold -200
 */

import { base64UrlDecode } from "../src/http-client.js";
import { loadCredentials } from "../src/credentials.js";
import { fetchPositions, calcPnlPct, closePosition, openLong, setStopLoss, Position } from "../src/positions.js";

/* ------------------------------------------------------------------ */
/*  Config (defaults, overridable via CLI flags)                       */
/* ------------------------------------------------------------------ */

const SYMBOL_DEFAULT = "XTIUSDT";
const POSITION_QTY_DEFAULT = 0.01;
const PNL_THRESHOLD_PCT_DEFAULT = -100;
const LEVERAGE_DEFAULT = 100;
const POLL_INTERVAL_MS = 2_000;
const STOP_LOSS_INTERVAL_MS = 60_000;

/* Parse CLI flags like --symbol XBRUSDT --qty 0.02 --leverage 50 --pnl-threshold -200 */
function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}

const SYMBOL      = parseArg("symbol")        ?? SYMBOL_DEFAULT;
const POSITION_QTY = parseFloat(parseArg("qty") ?? String(POSITION_QTY_DEFAULT));
const PNL_THRESHOLD_PCT = parseInt(parseArg("pnl-threshold") ?? String(PNL_THRESHOLD_PCT_DEFAULT), 10);
const LEVERAGE    = parseInt(parseArg("leverage") ?? String(LEVERAGE_DEFAULT), 10);

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
/*  Main loop                                                          */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const creds = loadCredentials();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  console.log(`[${fmtTime()}]  ⚡  Starting position monitor`);
  console.log(`     Symbol:       ${SYMBOL}`);
  console.log(`     Qty per open: ${POSITION_QTY}`);
  console.log(`     PnL trigger:  < ${PNL_THRESHOLD_PCT}%`);
  console.log(`     Leverage:     ${LEVERAGE}x`);
  console.log(`     Poll every:   ${POLL_INTERVAL_MS / 1000}s`);
  console.log("");

  // Rolling mark-price samples (one per 60 s, kept for 1 hour)
  const markSamples: { price: number; time: number }[] = [];
  const MARK_SAMPLE_WINDOW_MS = 3_600_000;  // 1 hour

  // Set stdin to raw mode so we can detect any keypress
  const stdinRaw = process.stdin.isRaw;
  if (!stdinRaw) process.stdin.setRawMode(true);
  process.stdin.resume();

  function restoreStdin() {
    try { process.stdin.setRawMode(stdinRaw); } catch { /* ignore */ }
    // process.stdin.pause();
  }

  process.stdin.on("data", (buf: Buffer) => {
    // Ctrl+C (byte 0x03) is consumed by raw-mode stdin instead of
    // generating SIGINT — detect it manually.
    if (buf.length === 1 && buf[0] === 3) {
      console.log(`\n[${fmtTime()}]  ⏹  Shutting down …`);
      running = false;
      return;
    }
    // 'r' → manually update stop-loss (same logic as the 60s auto-update)
    if (buf.length === 1 && (buf[0] === 0x72 || buf[0] === 0x52)) {
      (async () => {
        try {
          const positions = await fetchPositions(creds.PHEMEX_API_KEY, secretRaw);
          const pos = positions.find((p) => p.symbol === SYMBOL);
          if (!pos) { console.log(`[${fmtTime()}]  ℹ  No ${SYMBOL} position — skipping stop-loss`); return; }
          await doStopLossUpdate(pos, Date.now());
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[${fmtTime()}]  ✗  Stop-loss key error: ${msg}`);
        }
      })();
    }
  });

  // Register Ctrl+C handler
  let running = true;
  let nextStopLossUpdate = 0;  // set stop loss on the first tick with a position
  let nextOpenLongTime = 0;    // rate-limit: openLong at most every 60 s

  /**
   * Sample the current mark price, prune the rolling 1h window,
   * and set the stop-loss at max(mark samples) − $0.10.
   */
  async function doStopLossUpdate(pos: Position, now: number): Promise<void> {
    return
    
    const markPrice = parseFloat(pos.markPriceRp || "0");
    const size = parseFloat(pos.size || "0");
    if (markPrice <= 0 || size <= 0) return;

    markSamples.push({ price: markPrice, time: now });
    const cutoff = now - MARK_SAMPLE_WINDOW_MS;
    while (markSamples.length > 0 && markSamples[0].time < cutoff) {
      markSamples.shift();
    }

    const maxMark = Math.max(...markSamples.map((s) => s.price));
    const stopPrice = Math.round((maxMark - 0.01) * 100) / 100;

    if (stopPrice > 0) {
      await setStopLoss(SYMBOL, "Sell", "Long", stopPrice, size, creds.PHEMEX_API_KEY, secretRaw);
      console.log(
        `[${fmtTime()}]  ✓  Stop-loss updated to $${fmtNum(stopPrice, 2)} ` +
        `(max mark: $${fmtNum(maxMark, 2)}, samples: ${markSamples.length})`
      );
    }
  }

  process.on("SIGINT", () => {
    console.log(`\n[${fmtTime()}]  ⏹  Shutting down …`);
    restoreStdin();
    running = false;
  });

  while (running) {
    try {
      const positions = await fetchPositions(creds.PHEMEX_API_KEY, secretRaw);
      const xtiPos = positions.find((p) => p.symbol === SYMBOL);
      let reopened = false;

      if (!xtiPos) {
        const now = Date.now();
        if (now < nextOpenLongTime) {
          console.log(`[${fmtTime()}]  ⏳  No ${SYMBOL} position, but rate-limited — skipping openLong`);
          continue;
        }
        // No position — open a new long
        console.log(`[${fmtTime()}]  ℹ  No ${SYMBOL} position found — opening new long …`);
        await openLong(SYMBOL, POSITION_QTY, LEVERAGE, creds.PHEMEX_API_KEY, secretRaw);
        nextOpenLongTime = now + 60_000;
        reopened = true;
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
          const openLongNow = Date.now();
          if (openLongNow >= nextOpenLongTime) {
            await openLong(SYMBOL, POSITION_QTY, LEVERAGE, creds.PHEMEX_API_KEY, secretRaw);
            nextOpenLongTime = openLongNow + 60_000;
          } else {
            console.log(`[${fmtTime()}]  ⏳  PnL below threshold, but openLong rate-limited — skipping reopen`);
          }
          reopened = true;
        }
      }

      // Stop-loss update: every 60 s (skip this tick if we just reopened —
      // the position data is stale; next tick will use fresh data)
      if (reopened) {
        nextStopLossUpdate = 0;  // schedule stop-loss on next tick
      }

      const now = Date.now();
      if (xtiPos && !reopened && now >= nextStopLossUpdate) {
        await doStopLossUpdate(xtiPos, now);
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
