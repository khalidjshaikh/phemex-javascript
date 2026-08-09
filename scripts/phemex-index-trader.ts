#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-index-trader.ts — XBRUSDT index-signal trader on USDT-M.
 *
 * Loops forever:
 *   1. Read the open XBRUSDT position size and direction.
 *   2. If size >= qty: pause 1 second, do not trade, loop again.
 *   3. Otherwise read the market snapshot (indexLast.txt, index.txt, bid.txt,
 *      ask.txt, last.txt) and trade (level via --threshold, default 0.2),
 *      sizing the order so the TOTAL position ends up at qty:
 *        value > 0.2  → Long  (qty − size) @ 100x (no stop loss, no take profit)
 *        value < 0.2  → Short (qty − size) @ 100x (no stop loss, no take profit)
 *        value == 0.2 → no trade
 *
 *   No trade is placed while the index price (index.txt) sits inside the
 *   bid–ask spread (bid.txt / ask.txt).
 *
 * A position in the opposite direction of the signal is left as-is (skipped
 * with a warning) — the bot never flips a position automatically.
 *
 * Quantity is adjustable via --size (default 0.01).
 *
 * Usage:
 *   ./phemex-index-trader.ts               # run the loop (trades for real)
 *   ./phemex-index-trader.ts --dry-run     # log actions without sending orders
 *   ./phemex-index-trader.ts --threshold 0.15
 *   ./phemex-index-trader.ts --size 0.05
 *   ./phemex-index-trader.ts --help, -h
 */

import fs from "node:fs";
import path from "node:path";
import { base64UrlDecode } from "../src/http-client.js";
import { getArg, hasFlag } from "../src/cli-utils.js";
import { loadCredentials } from "../src/credentials.js";
import { placeMarketOrder, setLeverageUsdtM } from "../src/place-limit-order.js";
import { fetchPositions } from "../src/positions.js";

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

const SYMBOL = "XBRUSDT";
const QTY = 0.01;             // contract quantity per order
const LEVERAGE = 100;         // 100x as requested
const DEFAULT_THRESHOLD = 0.2; // indexLast.txt trigger level (default; --threshold overrides)
const PAUSE_MS = 1_000;       // 1s pause while a position is already open
const INDEX_FILE = path.resolve(__dirname, "..", "indexLast.txt");      // signal: index − last
const INDEX_PRICE_FILE = path.resolve(__dirname, "..", "index.txt");    // index price
const ASK_FILE = path.resolve(__dirname, "..", "ask.txt");              // ask price (phemex-ticker-24hr.ts)
const BID_FILE = path.resolve(__dirname, "..", "bid.txt");              // bid price (phemex-ticker-24hr.ts)
const LAST_FILE = path.resolve(__dirname, "..", "last.txt");            // last trade price (phemex-mark-price2.ts)

function usage(): never {
  console.log(`
Usage: ./phemex-index-trader.ts [options]

Loop on XBRUSDT: skip trading while the position is already >= the configured
size (--size, default ${QTY}); otherwise read indexLast.txt (signal) plus
index.txt / bid.txt / ask.txt / last.txt and top up so the TOTAL position
reaches exactly the configured size:

  index > ${DEFAULT_THRESHOLD}  → Long,  add (size − current) @ ${LEVERAGE}x (no TP/SL)
  index < ${DEFAULT_THRESHOLD}  → Short, add (size − current) @ ${LEVERAGE}x (no TP/SL)
  index = ${DEFAULT_THRESHOLD}  → no trade

No trade while the index price (index.txt) sits inside the bid–ask spread
(bid.txt / ask.txt).

A position in the opposite direction of the signal is never flipped — it is
left as-is and a warning is logged.

Options:
  --threshold <num>   Trigger level for indexLast.txt (default: ${DEFAULT_THRESHOLD})
  --size <num>        Contract quantity per order (default: ${QTY})
  --dry-run           Log every decision but never send an order
  --help, -h          Show this help message

Examples:
  ./phemex-index-trader.ts --dry-run
  ./phemex-index-trader.ts --threshold 0.15
`);
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function fmtTime(): string {
  return new Date().toLocaleString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Format a number with exactly 2 decimals for log output. */
function fmt2(n: number): string {
  return n.toFixed(2);
}

/** Market snapshot read from the project-root value files. */
interface Snapshot {
  signal: number; // indexLast.txt — index − last (the trade signal)
  index: number;  // index.txt — index price
  ask: number;    // ask.txt
  bid: number;    // bid.txt
  last: number;   // last.txt — last trade price
}

/** Read all five value files; null when any is missing or unreadable. */
function readSnapshot(): Snapshot | null {
  const read = (file: string): number | null => {
    try {
      const value = parseFloat(fs.readFileSync(file, "utf8").trim());
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  };

  const signal = read(INDEX_FILE);
  const index = read(INDEX_PRICE_FILE);
  const ask = read(ASK_FILE);
  const bid = read(BID_FILE);
  const last = read(LAST_FILE);
  if (signal === null || index === null || ask === null || bid === null || last === null) {
    return null;
  }
  return { signal, index, ask, bid, last };
}

/** Open XBRUSDT position { size, side } — { size: 0, side: null } when flat. */
async function xbrPosition(
  apiKey: string,
  secretRaw: Buffer,
): Promise<{ size: number; side: "Buy" | "Sell" | null }> {
  const positions = await fetchPositions(apiKey, secretRaw);
  const pos = positions.find((p) => p.symbol === SYMBOL);
  if (!pos) return { size: 0, side: null };
  return { size: parseFloat(pos.size || "0"), side: pos.side === "None" ? null : pos.side };
}

/** Open a market Long/Short, qty @ 100x, no stop loss / take profit. */
async function openPosition(
  side: "Buy" | "Sell",
  posSide: "Long" | "Short",
  qty: number,
  apiKey: string,
  secretRaw: Buffer,
  dryRun: boolean,
): Promise<void> {
  if (dryRun) {
    console.log(`[${fmtTime()}]   [DRY-RUN] would set ${LEVERAGE}x leverage and market-${side} ${qty} ${SYMBOL} (posSide ${posSide}), no TP/SL`);
    return;
  }

  await setLeverageUsdtM(SYMBOL, LEVERAGE, posSide, apiKey, secretRaw);
  const result = await placeMarketOrder(
    { account: "usdt-m", symbol: SYMBOL, side, price: 0, qty, posSide },
    apiKey,
    secretRaw,
  );
  console.log(
    `[${fmtTime()}]   ✓  ${posSide} opened — orderID: ${result.orderID ?? result.clOrdID ?? "—"}  status: ${result.ordStatus ?? "—"}`,
  );
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) usage();
  const dryRun = hasFlag("--dry-run");

  const thresholdArg = getArg("--threshold");
  const threshold = thresholdArg !== undefined ? Number(thresholdArg) : DEFAULT_THRESHOLD;
  if (!Number.isFinite(threshold)) {
    console.error(`✗  --threshold must be a number, got "${thresholdArg}"`);
    process.exit(1);
  }

  const sizeArg = getArg("--size");
  const qty = sizeArg !== undefined ? Number(sizeArg) : QTY;
  if (!Number.isFinite(qty) || qty <= 0) {
    console.error(`✗  --size must be a positive number, got "${sizeArg}"`);
    process.exit(1);
  }

  const creds = loadCredentials();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  console.log(`[${fmtTime()}] ═ ${SYMBOL} Index Trader ${dryRun ? "(DRY RUN)" : ""} ═══════════════════════`);
  console.log(`[${fmtTime()}]   Threshold: index ${threshold}   qty: ${qty}   leverage: ${LEVERAGE}x   TP/SL: none`);
  console.log(`[${fmtTime()}]   Watching indexLast.txt + bid/ask spread — Ctrl-C to stop`);
  console.log(`[${fmtTime()}] ═══════════════════════════════════════════════════════════════`);

  process.on("SIGINT", () => {
    console.log(`\n[${fmtTime()}] ⏹  Stopped. Position left as-is.`);
    process.exit(0);
  });

  let lastPause: string | null = null; // last logged paused-state; suppress identical repeats
  while (true) {
    try {
      // 1. Read the open XBRUSDT position (size + direction).
      const { size, side } = await xbrPosition(creds.PHEMEX_API_KEY, secretRaw);

      // 2. Already at or above the target size — pause, do not trade.
      if (size >= qty) {
        const state = `${side ?? "?"} ${fmt2(size)}`;
        if (lastPause !== state) {
          console.log(`[${fmtTime()}]   ⏸  ${SYMBOL} position ${state} >= ${qty} — waiting 1s, no trade`);
          lastPause = state;
        }
        await sleep(PAUSE_MS);
        continue;
      }
      lastPause = null; // leaving the paused state — next pause logs again

      // 3. Read the index signal and the bid/ask/index/last snapshot.
      const snap = readSnapshot();
      if (snap === null) {
        console.warn(`[${fmtTime()}]   ⚠  indexLast.txt / index.txt / bid.txt / ask.txt / last.txt unreadable — skipping this cycle`);
        await sleep(PAUSE_MS);
        continue;
      }
      const { signal: index, index: indexPrice, ask, bid, last } = snap;

      // 3b. Index price inside the bid–ask spread — no trade.
      const spreadLo = Math.min(ask, bid);
      const spreadHi = Math.max(ask, bid);
      if (indexPrice > spreadLo && indexPrice < spreadHi) {
        console.log(`[${fmtTime()}]   –  index ${fmt2(indexPrice)} inside spread (bid ${fmt2(bid)} / ask ${fmt2(ask)}) — no trade`);
        await sleep(PAUSE_MS);
        continue;
      }

      console.log(`[${fmtTime()}]   size: ${fmt2(size)} (${side ?? "flat"})   indexLast: ${fmt2(index)}   index: ${fmt2(indexPrice)}   bid: ${fmt2(bid)}   ask: ${fmt2(ask)}   last: ${fmt2(last)}`);

      if (index > threshold) {
        // Target: Long totalling qty. Never flip an existing Short.
        if (side === "Sell") {
          console.log(`[${fmtTime()}]   ⚠  Short ${fmt2(size)} open but signal is Long — leaving position as-is (no auto-flip)`);
          await sleep(PAUSE_MS);
          continue;
        }
        const orderQty = Math.round((qty - size) * 10000) / 10000; // top up to exactly qty
        console.log(`[${fmtTime()}] ⟐  index ${fmt2(index)} > ${threshold} — Long to ${qty} total (adding ${orderQty}) @ ${LEVERAGE}x`);
        await openPosition("Buy", "Long", orderQty, creds.PHEMEX_API_KEY, secretRaw, dryRun);
        await sleep(PAUSE_MS * 2); // let the fill register before re-checking
      } else if (index < threshold) {
        // Target: Short totalling qty. Never flip an existing Long.
        if (side === "Buy") {
          console.log(`[${fmtTime()}]   ⚠  Long ${fmt2(size)} open but signal is Short — leaving position as-is (no auto-flip)`);
          await sleep(PAUSE_MS);
          continue;
        }
        const orderQty = Math.round((qty - size) * 10000) / 10000; // top up to exactly qty
        console.log(`[${fmtTime()}] ⟐  index ${fmt2(index)} < ${threshold} — Short to ${qty} total (adding ${orderQty}) @ ${LEVERAGE}x`);
        await openPosition("Sell", "Short", orderQty, creds.PHEMEX_API_KEY, secretRaw, dryRun);
        await sleep(PAUSE_MS * 2); // let the fill register before re-checking
      } else {
        console.log(`[${fmtTime()}]   –  index == ${threshold} — no trade`);
        await sleep(PAUSE_MS);
      }
    } catch (err: unknown) {
      console.error(`[${fmtTime()}] ✗  Cycle error: ${err instanceof Error ? err.message : String(err)} — retrying in ${PAUSE_MS / 1000}s`);
      await sleep(PAUSE_MS);
    }
  }
}

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
