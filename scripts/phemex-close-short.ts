#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-close-short.ts — Close every open short position, repeating at a
 * fixed interval. Each cycle fetches all open USDT-M positions and market-
 * closes every short (side "Sell"); optionally restricted to one symbol.
 *
 * Runs forever until Ctrl+C.
 *
 * Usage:
 *   npx tsx phemex-close-short.ts                  # every 60s
 *   npx tsx phemex-close-short.ts --interval 30    # every 30s
 *   npx tsx phemex-close-short.ts --symbol XBRUSDT # shorts on XBRUSDT only
 *   npx tsx phemex-close-short.ts --dry-run        # log only, no orders
 *
 * Options:
 *   --interval <seconds>  Seconds between close cycles (default: 60)
 *   --symbol <symbol>     Only close shorts for this symbol (default: all)
 *   --dry-run             Print what would be closed without placing orders
 *   --help, -h            Show this help message
 */

import { base64UrlDecode } from "../src/http-client.js";
import { loadCredentialsPath } from "../src/credentials.js";
import { getArg } from "../src/cli-utils.js";
import { closePosition, fetchPositions, type Position } from "../src/positions.js";

const CREDS_FILE = ".phemex-credentials.json";

const rawInterval = Number(getArg("--interval") ?? 60);
const INTERVAL_S = Number.isFinite(rawInterval) && rawInterval > 0 ? rawInterval : 60;
const INTERVAL_MS = INTERVAL_S * 1000;
const SYMBOL = getArg("--symbol"); // undefined = close shorts on all symbols
const DRY_RUN = process.argv.includes("--dry-run");

function fmtTime(): string {
  return new Date().toLocaleString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Market-close every open short, filtered by --symbol when given. */
async function closeShorts(
  positions: Position[],
  apiKey: string,
  secretRaw: Buffer,
): Promise<void> {
  const shorts = positions.filter(
    (p) => p.side === "Sell" && (!SYMBOL || p.symbol === SYMBOL),
  );
  if (shorts.length === 0) {
    console.log(`[${fmtTime()}]   –  No open short${SYMBOL ? ` for ${SYMBOL}` : ""} — nothing to close`);
    return;
  }
  for (const pos of shorts) {
    if (DRY_RUN) {
      console.log(`[${fmtTime()}]   ·  DRY-RUN: would close ${pos.symbol} short  qty: ${pos.size}`);
      continue;
    }
    await closePosition(pos, apiKey, secretRaw);
  }
}

function usage(): never {
  console.log(`
Usage: scripts/phemex-close-short.ts [options]

Close every open short position, repeating at a fixed interval. Each cycle
fetches all open USDT-M positions and market-closes every short
(side "Sell"); optionally restricted to one symbol. Runs until Ctrl+C.

Options:
  --interval <seconds>  Seconds between close cycles (default: ${INTERVAL_S})
  --symbol <symbol>     Only close shorts for this symbol (default: all)
  --dry-run             Print what would be closed without placing orders
  --help, -h            Show this help message

Examples:
  scripts/phemex-close-short.ts
  scripts/phemex-close-short.ts --interval 30
  scripts/phemex-close-short.ts --symbol XBRUSDT --dry-run
`);
  process.exit(0);
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) usage();

  const creds = loadCredentialsPath(CREDS_FILE);
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  console.log(`[${fmtTime()}] ═ Short Closer ════════════════════════════════`);
  console.log(`[${fmtTime()}]   Interval: every ${INTERVAL_S}s   target: ${SYMBOL ?? "all shorts"}   mode: ${DRY_RUN ? "DRY-RUN" : "LIVE"}`);
  console.log(`[${fmtTime()}] ═══════════════════════════════════════════════`);

  process.on("SIGINT", () => {
    console.log(`\n[${fmtTime()}] ⏹  Stopped.`);
    process.exit(0);
  });

  while (true) {
    try {
      const positions = await fetchPositions(creds.PHEMEX_API_KEY, secretRaw);
      await closeShorts(positions, creds.PHEMEX_API_KEY, secretRaw);
    } catch (err: unknown) {
      console.error(`[${fmtTime()}] ✗  Cycle failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(INTERVAL_MS);
  }
}

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
