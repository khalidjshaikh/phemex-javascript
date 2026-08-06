#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-list-open-positions.ts — List all open USDT-M positions using the
 * shared fetchPositions helper (src/positions.ts).
 *
 * Endpoint:  GET /g-accounts/accountPositions?currency=USDT
 *
 * Usage:
 *   ./phemex-list-open-positions.ts
 *   ./phemex-list-open-positions.ts --json
 *   ./phemex-list-open-positions.ts --loop
 *   ./phemex-list-open-positions.ts --loop --interval 5000
 *   ./phemex-list-open-positions.ts --help
 *
 * Options:
 *   --json            Print the raw positions array as JSON (for scripting)
 *   --loop            Continuously poll every <interval> ms (prints only on change)
 *   --interval <ms>   Polling interval in ms (default 5000, with --loop)
 *   --once            With --loop: single poll, then exit
 *   --help, -h        Show this help message
 */

import { base64UrlDecode } from "../src/http-client.js";
import { hasFlag } from "../src/cli-utils.js";
import { loadCredentials } from "../src/credentials.js";
import { fetchPositions, calcPnlPct, Position } from "../src/positions.js";

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

function usage(): never {
  console.log(`
Usage: ./phemex-list-open-positions.ts [options]

List all open USDT-M positions via fetchPositions
(GET /g-accounts/accountPositions?currency=USDT).

Options:
  --json            Print the raw positions array as JSON (for scripting)
  --loop            Continuously poll every <interval> ms (prints only on change)
  --interval <ms>   Polling interval in ms (default 5000, with --loop)
  --once            With --loop: single poll, then exit
  --help, -h        Show this help message

Examples:
  ./phemex-list-open-positions.ts
  ./phemex-list-open-positions.ts --json
  ./phemex-list-open-positions.ts --loop
  ./phemex-list-open-positions.ts --loop --interval 2000
`);
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function fmtTime(): string {
  return new Date().toLocaleTimeString();
}

function fmtNum(n: number, d: number = 2): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) usage();
  const asJson = hasFlag("--json");

  const LOOP_MODE = hasFlag("--loop");
  const LOOP_ONCE = hasFlag("--once");
  const loopIdx = process.argv.indexOf("--interval");
  const LOOP_INTERVAL = loopIdx !== -1
    ? Math.max(parseInt(process.argv[loopIdx + 1], 10) || 5000, 1000)
    : 5000;

  const creds = loadCredentials();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  async function fetchOnce(): Promise<Position[]> {
    return fetchPositions(creds.PHEMEX_API_KEY, secretRaw);
  }

  function printPositions(positions: Position[]): void {
    if (asJson) {
      console.log(JSON.stringify(positions, null, 2));
      return;
    }

    if (positions.length === 0) {
      console.log(`[${fmtTime()}]   No open USDT-M positions.`);
      return;
    }

    for (const pos of positions) {
      const size = parseFloat(pos.size || "0");
      const entry = parseFloat(pos.avgEntryPriceRp || "0");
      const mark = parseFloat(pos.markPriceRp || "0");
      const margin = parseFloat(pos.posCostRv || "0");
      const pnlPct = calcPnlPct(pos);
      const posSide = pos.side === "Buy" ? "Long" : "Short";
      const liq = pos.liquidationPriceRp !== undefined ? `  liq: $${fmtNum(parseFloat(String(pos.liquidationPriceRp)))}` : "";
      console.log(
        `[${fmtTime()}]   ${pos.symbol}  ${posSide}  ` +
        `size: ${fmtNum(size, 4)}  entry: $${fmtNum(entry)}  mark: $${fmtNum(mark)}  ` +
        `PnL: ${pnlPct >= 0 ? "+" : ""}${fmtNum(pnlPct, 2)}%  margin: $${fmtNum(margin, 4)}${liq}`,
      );
    }
  }

  if (LOOP_MODE) {
    let lastKey: string | null = null;
    while (true) {
      const positions = await fetchOnce();
      const key = positions.map((p) => `${p.symbol}|${p.side}|${p.size}|${p.avgEntryPriceRp}`).join(",");
      if (key !== lastKey) {
        lastKey = key;
        printPositions(positions);
      }
      if (LOOP_ONCE) break;
      await sleep(LOOP_INTERVAL);
    }
    return;
  }

  printPositions(await fetchOnce());
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
