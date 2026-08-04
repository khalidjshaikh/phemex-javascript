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
 *   ./phemex-list-open-positions.ts --help
 *
 * Options:
 *   --json       Print the raw positions array as JSON (for scripting)
 *   --help, -h   Show this help message
 */

import { base64UrlDecode } from "../src/http-client.js";
import { hasFlag } from "../src/cli-utils.js";
import { loadCredentials } from "../src/credentials.js";
import { fetchPositions, calcPnlPct } from "../src/positions.js";

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

function usage(): never {
  console.log(`
Usage: ./phemex-list-open-positions.ts [options]

List all open USDT-M positions via fetchPositions
(GET /g-accounts/accountPositions?currency=USDT).

Options:
  --json       Print the raw positions array as JSON (for scripting)
  --help, -h   Show this help message

Examples:
  ./phemex-list-open-positions.ts
  ./phemex-list-open-positions.ts --json
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

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) usage();
  const asJson = hasFlag("--json");

  const creds = loadCredentials();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  const positions = await fetchPositions(creds.PHEMEX_API_KEY, secretRaw);

  if (asJson) {
    console.log(JSON.stringify(positions, null, 2));
    return;
  }

  if (positions.length === 0) {
    console.log(`[${fmtTime()}]   No open USDT-M positions.`);
    return;
  }

  console.log(`[${fmtTime()}]   ${positions.length} open position${positions.length === 1 ? "" : "s"}:`);
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

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
