#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-coinm-positions.ts  —  Retrieve COIN-M (inverse perpetual) open positions
 * from Phemex.  Credentials are read from .phemex-credentials.json.
 *
 * Endpoint:  GET /accounts/accountPositions?currency=<currency>
 *
 * Usage:  npx tsx phemex-coinm-positions.ts
 */

import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Credentials, loadCredentials } from "./src/credentials.js";

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
  unrealisedPnl?: number;  // from the "with PnL" variant
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

/** Base64-url decode (RFC 4648 §5) */
function base64UrlDecode(s: string): Buffer {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

/** Sign a GET request per Phemex spec: HMAC-SHA256(path + queryString + expiry) */
function sign(method: string, path: string, query: string | null, expiry: number, secretRaw: Buffer): string {
  const queryStr = query ?? "";
  const body = ""; // GET requests have no body
  const payload = path + queryStr + expiry + body;
  return crypto.createHmac("sha256", secretRaw).update(payload).digest("hex");
}

/** Perform one signed GET request and parse the JSON response */
async function get(
  path: string,
  query: string | null,
  apiKey: string,
  secretRaw: Buffer
): Promise<ApiResponse> {
  return new Promise((resolve, reject) => {
    const expiry = Math.floor(Date.now() / 1000) + 60;
    const sig = sign("GET", path, query, expiry, secretRaw);
    const qs = query ? "?" + query : "";
    const req = https.request(
      {
        hostname: "api.phemex.com",
        path: path + qs,
        method: "GET",
        headers: {
          "x-phemex-access-token": apiKey,
          "x-phemex-request-expiry": String(expiry),
          "x-phemex-request-signature": sig,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Bad JSON response: ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  /* -- Read credentials ------------------------------------------- */
  const creds: Credentials = loadCredentials(import.meta.dirname);
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  /* -- Query COIN-M positions for each settlement currency -------- */
  const settlementCurrencies = ["BTC", "ETH", "USD"];
  const allPositions: Position[] = [];

  for (const cur of settlementCurrencies) {
    process.stdout.write(`⟐  Coin-M (${cur}) … `);
    try {
      const resp = await get("/accounts/accountPositions", `currency=${cur}`, creds.PHEMEX_API_KEY, secretRaw);
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
    console.log("\nNo open COIN-M positions.");
    process.exit(0);
  }

  console.log(
    `\n${"Symbol".padEnd(12)} ${"Side".padEnd(7)} ${"Size".padStart(8)} ` +
    `${"Entry Price".padStart(14)} ${"Mark Price".padStart(14)} ${"Value".padStart(14)} ` +
    `${"P&L".padStart(12)} ${"Leverage".padStart(9)} ${"Liq. Price".padStart(14)} ${"Margin".padStart(10)}`
  );
  console.log("─".repeat(128));

  for (const p of allPositions) {
    const pnl = p.unrealisedPnl ?? 0;
    const sideFmt = p.side.padEnd(7);
    const sizeFmt = String(p.size).padStart(8);
    const entryFmt = p.avgEntryPrice.toFixed(2).padStart(14);
    // Mark price isn't returned by accountPositions — show "—"
    const markFmt = "—".padStart(14);
    const valueFmt = p.value.toFixed(6).padStart(14);
    const pnlFmt = (pnl >= 0 ? "+" : "") + pnl.toFixed(6).padStart(11);
    const levFmt = (p.leverage === 0 ? "∞" : p.leverage.toFixed(1)).padStart(9);
    const liqFmt = (p.liquidationPrice || 0).toFixed(2).padStart(14);
    const marginFmt = p.posCost.toFixed(6).padStart(10);

    console.log(
      `${p.symbol.padEnd(12)} ${sideFmt} ${sizeFmt} ${entryFmt} ${markFmt} ${valueFmt} ` +
      `${pnlFmt} ${levFmt} ${liqFmt} ${marginFmt}`
    );
  }
  console.log("─".repeat(128));
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
