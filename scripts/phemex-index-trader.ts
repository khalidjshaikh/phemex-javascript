#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-index-trader.ts — XBRUSDT index-signal trader on USDT-M.
 *
 * Loops forever:
 *   1. Read the open XBRUSDT positions (Long and Short sizes).
 *   2. Read the market snapshot (indexLast.txt, index.txt, bid.txt, ask.txt,
 *      last.txt) and trade (level via --threshold, default 0.2, or separate
 *      --long-threshold / --short-threshold), sizing the order so the signaled
 *      side's TOTAL position ends up at qty:
 *        value >= +longThreshold   → Long  (qty − longSize) @ 100x (no stop loss, no take profit)
 *        value <= −shortThreshold  → Short (qty − shortSize) @ 100x (no stop loss, no take profit)
 *        −shortThreshold < value < +longThreshold → no trade (dead band)
 *   3. If the signaled side is already at or above qty: pause 500ms, do not
 *      trade, loop again.
 *
 *   Identical consecutive cycles are logged only when a value changes —
 *   repeats (same sizes, indexLast, index, bid/ask/last) are suppressed.
 *
 *   No trade is placed while the index price (index.txt) sits inside the
 *   bid–ask spread (bid.txt / ask.txt) — unless --allow-inside-spread.
 *
 * By default a position in the opposite direction of the signal is left as-is
 * (skipped with a warning) — the bot never flips a position automatically.
 * With --flip, the opposite side is closed first: a Long signal closes the
 * Short, a Short signal closes the Long, so only the signaled side stays open.
 * With --hedge, Long and Short are managed independently: each side is topped
 * up to the configured size whenever its own signal fires, so a Long and a
 * Short may be open at the same time and never block each other.
 *
 * Quantity is adjustable via --size (default 0.01); with --hedge it applies
 * to EACH side.
 *
 * Usage:
 *   ./phemex-index-trader.ts               # run the loop (trades for real)
 *   ./phemex-index-trader.ts --dry-run     # log actions without sending orders
 *   ./phemex-index-trader.ts --threshold 0.15
 *   ./phemex-index-trader.ts --long-threshold 0.15 --short-threshold 0.3
 *   ./phemex-index-trader.ts --size 0.05
 *   ./phemex-index-trader.ts --symbol ETHUSDT
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

const DEFAULT_SYMBOL = "XBRUSDT";
let SYMBOL = DEFAULT_SYMBOL;
const symbolFile = (name: string) => `${SYMBOL}-${name}`;
const QTY = 0.01;             // contract quantity per order
const LEVERAGE = 100;         // 100x as requested
const DEFAULT_THRESHOLD = 0.2; // indexLast.txt trigger level (default; --threshold overrides)
const PAUSE_MS = 500;        // 500ms pause between cycles
const POSITIONS_TTL_MS = 2_000; // re-fetch open positions at most every 2s (cached between cycles)
let pendingLong = 0;         // local tracker for unconfirmed Long orders
let pendingShort = 0;        // local tracker for unconfirmed Short orders

function symbolPath(name: string): string {
  return path.resolve(__dirname, "..", "data", symbolFile(name));
}

function usage(): never {
  console.log(`
Usage: ./phemex-index-trader.ts [options]

Loop on XBRUSDT: skip trading while the position is already >= the configured
size (--size, default ${QTY}); otherwise read indexLast.txt (signal) plus
index.txt / bid.txt / ask.txt / last.txt and top up so the TOTAL position
reaches exactly the configured size:

  index >= +longThreshold   → Long,  add (size − current) @ ${LEVERAGE}x (no TP/SL)
  index <= −shortThreshold  → Short, add (size − current) @ ${LEVERAGE}x (no TP/SL)
  −shortThreshold < index < +longThreshold → no trade (dead band)

No trade while the index price (index.txt) sits inside the bid–ask spread
(bid.txt / ask.txt) — unless --allow-inside-spread.

By default a position in the opposite direction of the signal is never
flipped — it is left as-is and a warning is logged. With --flip, the opposite
side is closed first: a Long signal closes the Short, a Short signal closes
the Long. With --hedge, Long and Short are managed independently: each side
is topped up to the configured size (--size) whenever its own signal fires,
and both may be open at once.

Identical consecutive cycles (same sizes, indexLast, index, bid/ask/last) are
logged only when a value changes; trade actions are always logged.

Options:
  --threshold <num>          Shared Long/Short trigger level for indexLast.txt (default: ${DEFAULT_THRESHOLD})
  --long-threshold <num>     Long trigger level — defaults to --threshold value
  --short-threshold <num>    Short trigger level — defaults to --threshold value
  --size <num>        Contract quantity per order — per side with --hedge (default: ${QTY})
  --symbol <symbol>   Trading symbol (default: ${DEFAULT_SYMBOL})
  --hedge             Manage Long and Short independently (both may be open at once)
  --flip              Close the opposite side before entering: Long signal closes the Short, Short signal closes the Long
  --allow-inside-spread  Trade even when the index price is inside the bid–ask spread
  --dry-run           Log every decision but never send an order
  --help, -h          Show this help message

Examples:
  ./phemex-index-trader.ts --dry-run
  ./phemex-index-trader.ts --threshold 0.15
  ./phemex-index-trader.ts --hedge --size 0.01
  ./phemex-index-trader.ts --flip
  ./phemex-index-trader.ts --symbol ETHUSDT
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
function readSnapshot(files: { index: string; indexPrice: string; ask: string; bid: string; last: string }): Snapshot | null {
  const read = (file: string): number | null => {
    try {
      const value = parseFloat(fs.readFileSync(file, "utf8").trim());
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  };

  const signal = read(files.index);
  const index = read(files.indexPrice);
  const ask = read(files.ask);
  const bid = read(files.bid);
  const last = read(files.last);
  if (signal === null || index === null || ask === null || bid === null || last === null) {
    return null;
  }
  return { signal, index, ask, bid, last };
}

/** Open XBRUSDT Long and Short sizes — both 0 when flat. */
async function xbrPositions(
  apiKey: string,
  secretRaw: Buffer,
): Promise<{ longSize: number; shortSize: number }> {
  const positions = await fetchPositions(apiKey, secretRaw);
  let longSize = 0;
  let shortSize = 0;
  for (const p of positions) {
    if (p.symbol !== SYMBOL) continue;
    const size = parseFloat(p.size || "0");
    if (p.side === "Buy") longSize += size;
    else if (p.side === "Sell") shortSize += size;
  }
  return { longSize, shortSize };
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

/** Close an open position: opposite-side market order on the same posSide. */
async function closePosition(
  posSide: "Long" | "Short",
  qty: number,
  apiKey: string,
  secretRaw: Buffer,
  dryRun: boolean,
): Promise<void> {
  const side = posSide === "Long" ? "Sell" : "Buy"; // close Long = Sell, close Short = Buy
  const closeQty = Math.round(qty * 10000) / 10000;
  if (dryRun) {
    console.log(`[${fmtTime()}]   [DRY-RUN] would market-${side} ${closeQty} ${SYMBOL} to CLOSE ${posSide}`);
    return;
  }

  const result = await placeMarketOrder(
    { account: "usdt-m", symbol: SYMBOL, side, price: 0, qty: closeQty, posSide },
    apiKey,
    secretRaw,
  );
  console.log(
    `[${fmtTime()}]   ✓  ${posSide} closed — orderID: ${result.orderID ?? result.clOrdID ?? "—"}  status: ${result.ordStatus ?? "—"}`,
  );
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) usage();
  const dryRun = hasFlag("--dry-run");
  const allowInsideSpread = hasFlag("--allow-inside-spread");
  const hedge = hasFlag("--hedge");
  const flip = hasFlag("--flip");

  const thresholdArg = getArg("--threshold");
  const threshold = thresholdArg !== undefined ? Number(thresholdArg) : DEFAULT_THRESHOLD;
  if (!Number.isFinite(threshold)) {
    console.error(`✗  --threshold must be a number, got "${thresholdArg}"`);
    process.exit(1);
  }

  const longArg = getArg("--long-threshold");
  const longThreshold = longArg !== undefined ? Number(longArg) : threshold;
  if (!Number.isFinite(longThreshold)) {
    console.error(`✗  --long-threshold must be a number, got "${longArg}"`);
    process.exit(1);
  }

  const shortArg = getArg("--short-threshold");
  const shortThreshold = shortArg !== undefined ? Number(shortArg) : threshold;
  if (!Number.isFinite(shortThreshold)) {
    console.error(`✗  --short-threshold must be a number, got "${shortArg}"`);
    process.exit(1);
  }

  const sizeArg = getArg("--size");
  const qty = sizeArg !== undefined ? Number(sizeArg) : QTY;
  if (!Number.isFinite(qty) || qty <= 0) {
    console.error(`✗  --size must be a positive number, got "${sizeArg}"`);
    process.exit(1);
  }

  SYMBOL = getArg("--symbol") ?? DEFAULT_SYMBOL;

  const snapFiles = {
    index: symbolPath("indexLast.txt"),
    indexPrice: symbolPath("index.txt"),
    ask: symbolPath("ask.txt"),
    bid: symbolPath("bid.txt"),
    last: symbolPath("last.txt"),
  };

  const creds = loadCredentials();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  console.log(`[${fmtTime()}] ═ ${SYMBOL} Index Trader ${dryRun ? "(DRY RUN)" : ""} ═══════════════════════`);
  console.log(`[${fmtTime()}]   Threshold: index >= ${longThreshold} (Long) / <= -${shortThreshold} (Short)   qty: ${qty}   leverage: ${LEVERAGE}x   TP/SL: none   inside spread: ${allowInsideSpread ? "allowed" : "blocked"}`);
  if (hedge) {
    console.log(`[${fmtTime()}]   Mode: HEDGE — Long and Short independent, each up to ${qty}`);
  }
  if (flip) {
    console.log(`[${fmtTime()}]   Mode: FLIP — closing the opposite side before each entry`);
  }
  console.log(`[${fmtTime()}]   Watching indexLast.txt + bid/ask spread — Ctrl-C to stop`);
  console.log(`[${fmtTime()}] ═══════════════════════════════════════════════════════════════`);

  process.on("SIGINT", () => {
    console.log(`\n[${fmtTime()}] ⏹  Stopped. Position left as-is.`);
    process.exit(0);
  });

  let lastState: string | null = null; // last logged market state; suppress identical repeats
  let lastInDeadBand = false;          // track dead-band transitions to suppress repeated messages
  let lastDeadBandLines = 0;           // how many stdout lines are currently showing (for in-place overwrite)
  let posCache: { longSize: number; shortSize: number } | null = null;
  let posCacheAt = 0;
  while (true) {
    try {
      // 1. Read the open XBRUSDT positions (Long and Short sizes) — refetched
      //    at most every POSITIONS_TTL_MS; cached value reused in between.
      let positions = posCache;
      if (positions === null || Date.now() - posCacheAt >= POSITIONS_TTL_MS) {
        positions = await xbrPositions(creds.PHEMEX_API_KEY, secretRaw);
        posCache = positions;
        posCacheAt = Date.now();
      }
      const { longSize, shortSize } = positions;

      // Reset pending trackers when confirmed position >= pending (order filled).
      if (longSize >= pendingLong) pendingLong = 0;
      if (shortSize >= pendingShort) pendingShort = 0;

      // 2. Read the index signal and the bid/ask/index/last snapshot.
      const snap = readSnapshot(snapFiles);
      if (snap === null) {
        console.warn(`[${fmtTime()}]   ⚠  indexLast.txt / index.txt / bid.txt / ask.txt / last.txt unreadable — skipping this cycle`);
        await sleep(PAUSE_MS);
        continue;
      }
      const { signal: index, index: indexPrice, ask, bid, last } = snap;

      // Log each cycle's numbers only when they change (2-decimal precision,
      // matching the value files) — identical repeats are suppressed.
      const stateKey = `${fmt2(longSize)}|${fmt2(shortSize)}|${fmt2(pendingLong)}|${fmt2(pendingShort)}|${fmt2(index)}|${fmt2(indexPrice)}|${fmt2(bid)}|${fmt2(ask)}|${fmt2(last)}`;
      const changed = stateKey !== lastState;
      lastState = stateKey;

      // 3b. Index price inside the bid–ask spread — no trade (unless flagged).
      const spreadLo = Math.min(ask, bid);
      const spreadHi = Math.max(ask, bid);
      const insideSpread = indexPrice > spreadLo && indexPrice < spreadHi;
      if (insideSpread && !allowInsideSpread) {
        if (changed) {
          console.log(`[${fmtTime()}]   –  index ${fmt2(indexPrice)} inside spread (bid ${fmt2(bid)} / ask ${fmt2(ask)}) — indexLast ${fmt2(index)} — no trade`);
        }
        await sleep(PAUSE_MS);
        continue;
      }

      const inDeadBand = index > -shortThreshold && index < longThreshold;

      // Exiting dead band: clear the two in-place lines before printing new state
      if (!inDeadBand && lastDeadBandLines > 0) {
        for (let i = 0; i < lastDeadBandLines; i++) {
          process.stdout.write(`\r\x1B[K\x1B[1A`);
        }
        process.stdout.write(`\r\x1B[K`);
        lastDeadBandLines = 0;
      }

      // Entering dead band: suppress the normal state line (we'll print it below via in-place overwrite)
      if (inDeadBand && !lastInDeadBand) {
        // will print below via dead-band branch
      } else if (changed && !inDeadBand) {
        if (insideSpread) {
          console.log(`[${fmtTime()}]   ⚠  index ${fmt2(indexPrice)} inside spread (bid ${fmt2(bid)} / ask ${fmt2(ask)}) — trading anyway (--allow-inside-spread)`);
        }
        console.log(`[${fmtTime()}]   Long: ${fmt2(longSize)} (+${fmt2(pendingLong)} pending)   Short: ${fmt2(shortSize)} (+${fmt2(pendingShort)} pending)   indexLast: ${fmt2(index)}   index: ${fmt2(indexPrice)}   bid: ${fmt2(bid)}   ask: ${fmt2(ask)}   last: ${fmt2(last)}`);
      }

      if (index >= longThreshold) {
        lastInDeadBand = false;
        // Target: Long totalling qty. Default mode never flips an existing Short;
        // --flip closes the Short first.
        if (flip && shortSize > 0) {
          console.log(`[${fmtTime()}] ⟲  index ${fmt2(index)} >= ${longThreshold} — closing Short ${fmt2(shortSize)} before opening Long`);
          await closePosition("Short", shortSize, creds.PHEMEX_API_KEY, secretRaw, dryRun);
          pendingShort = 0;
          await sleep(PAUSE_MS); // let the close fill register before re-checking
        }
        if (!hedge && shortSize > 0 && !flip) {
          if (changed) {
            console.log(`[${fmtTime()}]   ⚠  Short ${fmt2(shortSize)} open but signal is Long — leaving position as-is (no auto-flip)`);
          }
          await sleep(PAUSE_MS);
          continue;
        }
        if (longSize + pendingLong >= qty) {
          if (changed) {
            console.log(`[${fmtTime()}]   ⏸  ${SYMBOL} Long position ${fmt2(longSize)} + pending ${fmt2(pendingLong)} >= ${qty} — waiting 500ms, no trade`);
          }
          await sleep(PAUSE_MS);
          continue;
        }
        const orderQty = Math.round((qty - longSize - pendingLong) * 10000) / 10000; // top up to exactly qty
        console.log(`[${fmtTime()}] ⟐  index ${fmt2(index)} >= ${longThreshold} — Long to ${qty} total (adding ${orderQty}) @ ${LEVERAGE}x`);
        await openPosition("Buy", "Long", orderQty, creds.PHEMEX_API_KEY, secretRaw, dryRun);
        pendingLong += orderQty;
        await sleep(PAUSE_MS); // let the fill register before re-checking
      } else if (index <= -shortThreshold) {
        lastInDeadBand = false;
        // Target: Short totalling qty. Default mode never flips an existing Long;
        // --flip closes the Long first.
        if (flip && longSize > 0) {
          console.log(`[${fmtTime()}] ⟲  index ${fmt2(index)} <= -${shortThreshold} — closing Long ${fmt2(longSize)} before opening Short`);
          await closePosition("Long", longSize, creds.PHEMEX_API_KEY, secretRaw, dryRun);
          pendingLong = 0;
          await sleep(PAUSE_MS); // let the close fill register before re-checking
        }
        if (!hedge && longSize > 0 && !flip) {
          if (changed) {
            console.log(`[${fmtTime()}]   ⚠  Long ${fmt2(longSize)} open but signal is Short — leaving position as-is (no auto-flip)`);
          }
          await sleep(PAUSE_MS);
          continue;
        }
        if (shortSize + pendingShort >= qty) {
          if (changed) {
            console.log(`[${fmtTime()}]   ⏸  ${SYMBOL} Short position ${fmt2(shortSize)} + pending ${fmt2(pendingShort)} >= ${qty} — waiting 500ms, no trade`);
          }
          await sleep(PAUSE_MS);
          continue;
        }
        const orderQty = Math.round((qty - shortSize - pendingShort) * 10000) / 10000; // top up to exactly qty
        console.log(`[${fmtTime()}] ⟐  index ${fmt2(index)} <= -${shortThreshold} — Short to ${qty} total (adding ${orderQty}) @ ${LEVERAGE}x`);
        await openPosition("Sell", "Short", orderQty, creds.PHEMEX_API_KEY, secretRaw, dryRun);
        pendingShort += orderQty;
        await sleep(PAUSE_MS); // let the fill register before re-checking
      } else {
        // Dead band — update two lines in place
        const stateLine = `[${fmtTime()}]   Long: ${fmt2(longSize)} (+${fmt2(pendingLong)} pending)   Short: ${fmt2(shortSize)} (+${fmt2(pendingShort)} pending)   indexLast: ${fmt2(index)}   index: ${fmt2(indexPrice)}   bid: ${fmt2(bid)}   ask: ${fmt2(ask)}   last: ${fmt2(last)}`;
        const deadBandLine = `[${fmtTime()}]   –  -${shortThreshold} < index ${fmt2(index)} < ${longThreshold} — no trade (dead band)`;

        if (lastDeadBandLines > 0) {
          // Overwrite previous lines in place
          for (let i = 0; i < lastDeadBandLines; i++) {
            process.stdout.write(`\r\x1B[K\x1B[1A`);
          }
          process.stdout.write(`\r\x1B[K`);
        }

        process.stdout.write(stateLine + "\n");
        process.stdout.write(deadBandLine + "\n");
        lastDeadBandLines = 2;
        lastInDeadBand = true;
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
