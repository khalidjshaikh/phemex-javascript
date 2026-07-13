#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-usdt-positions.ts  —  Retrieve USDT-M (linear perpetual) open positions
 * from Phemex.  Credentials are read from .phemex-credentials.json.
 *
 * Endpoint:  GET /g-accounts/accountPositions?currency=<currency>
 *
 * Usage:  npx tsx phemex-usdt-positions.ts
 */

import { httpGet, base64UrlDecode } from "./src/http-client.js";
import { loadCredentials } from "./src/credentials.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Position {
  symbol: string;
  currency: string;
  side: "Long" | "Short" | "None";
  positionStatus: string;
  crossMargin: boolean;
  size: number;           // number of contracts
  value: number;           // position value in settlement currency
  avgEntryPrice: number;   // entry price
  leverage: number;        // effective leverage
  posCost: number;         // position cost
  liquidationPrice: number;
  initMarginReq: number;
  maintMarginReq: number;
  riskLimit: number;
  unrealisedPnl?: number;
  // Also keep the raw scaled fields for PnL calculation if needed
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
  /* -- Read credentials ------------------------------------------- */
  const creds = loadCredentials(import.meta.dirname);
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

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
      const open = positions.filter((p) => p.side !== "None" || p.size !== 0);
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
    const pnl = p.unrealisedPnl ?? 0;
    const sideFmt = p.side.padEnd(7);
    const sizeFmt = Number(p.size).toFixed(4).padStart(10);
    const entryFmt = p.avgEntryPrice.toFixed(2).padStart(14);
    // Mark price isn't returned by accountPositions — show "—"
    const markFmt = "—".padStart(14);
    const valueFmt = p.value.toFixed(2).padStart(14);
    const pnlFmt = (pnl >= 0 ? "+" : "") + pnl.toFixed(2).padStart(11);
    const levFmt = (p.leverage === 0 ? "∞" : p.leverage.toFixed(1)).padStart(9);
    const liqFmt = (p.liquidationPrice || 0).toFixed(2).padStart(14);
    const marginFmt = p.posCost.toFixed(4).padStart(12);

    console.log(
      `${p.symbol.padEnd(12)} ${sideFmt} ${sizeFmt} ${entryFmt} ${markFmt} ${valueFmt} ` +
      `${pnlFmt} ${levFmt} ${liqFmt} ${marginFmt}`
    );
  }
  console.log("─".repeat(136));
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});