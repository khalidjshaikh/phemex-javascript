#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-market-order.ts  —  Place a market order (Long or Short) on
 * Coin-M BTCUSD with configurable qty and leverage.
 *
 * Usage:
 *   ./phemex-market-order.ts --side Long
 *   ./phemex-market-order.ts --side Short --qty 2 --leverage 50
 *   ./phemex-market-order.ts --side Long --dry-run
 */

import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Credentials, loadCredentials } from "./src/credentials.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Base64-url decode (RFC 4648 §5) */
function base64UrlDecode(s: string): Buffer {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

/**
 * Sign a request per Phemex spec: HMAC-SHA256(path + queryString + expiry + body)
 * Note: the query string does NOT include the leading '?'.
 */
function sign(
  _method: string,
  path: string,
  query: string | null,
  expiry: number,
  secretRaw: Buffer,
  body: string
): string {
  const queryStr = query ?? "";
  const payload = path + queryStr + expiry + body;
  return crypto.createHmac("sha256", secretRaw).update(payload).digest("hex");
}

/** Perform one signed HTTP request */
async function request(
  method: "GET" | "PUT" | "POST",
  urlPath: string,
  query: string | null,
  apiKey: string,
  secretRaw: Buffer,
  body: string
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const expiry = Math.floor(Date.now() / 1000) + 60;
    const sig = sign(method, urlPath, query, expiry, secretRaw, body);
    const qs = query ? "?" + query : "";

    const req = https.request(
      {
        hostname: "api.phemex.com",
        path: urlPath + qs,
        method,
        headers: {
          "x-phemex-access-token": apiKey,
          "x-phemex-request-expiry": String(expiry),
          "x-phemex-request-signature": sig,
          "Content-Type": "application/json",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Bad JSON: ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function uuid(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for older Node versions
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function loadCredentialsLocal(): Credentials {
  return loadCredentials(import.meta.dirname);
}

async function setLeverageCoinM(
  symbol: string,
  leverage: number,
  apiKey: string,
  secretRaw: Buffer,
): Promise<void> {
  // User passes positive value for cross-margin; Phemex API expects negative
  const apiLeverage = leverage > 0 ? -leverage : 0;

  // Fetch product info for ratioScale
  const resp = (await request(
    "GET",
    "/public/products",
    null,
    apiKey,
    secretRaw,
    ""
  )) as Record<string, unknown>;

  let ratioScale = 100_000_000; // default fallback
  if (resp.code === 0) {
    const data = resp.data as Record<string, unknown> | undefined;
    const candidates = [
      ...((data?.products as Record<string, unknown>[]) ?? []),
      ...((data?.perpProductsV2 as Record<string, unknown>[]) ?? []),
      ...((data?.perpProductsV1 as Record<string, unknown>[]) ?? []),
    ];
    const product = candidates.find((p) => String(p.symbol) === symbol);
    if (product) {
      ratioScale = 10 ** Number(product.ratioScale || 8);
    }
  }

  const leverageEr = Math.round(apiLeverage * ratioScale);
  console.log(`   Setting cross-margin leverage for ${symbol}: ${leverage}x`);

  const qs = `symbol=${symbol}&leverageEr=${leverageEr}`;
  const res = await request("PUT", "/positions/leverage", qs, apiKey, secretRaw, "");
  if (res.code !== 0) {
    throw new Error(`Leverage API error: ${res.msg ?? res.code}`);
  }
}

function usage(): never {
  console.log(`
Usage: ./phemex-market-order.ts --side <Long|Short> [options]

Place a market order on Coin-M BTCUSD.

Options:
  --side <Long|Short>   Order direction (required)
  --qty <number>        Contract quantity (default: 1)
  --leverage <number>   Leverage (default: 100)
  --dry-run             Show what would be sent without executing
  --help, -h            Show this help message

Examples:
  ./phemex-market-order.ts --side Long
  ./phemex-market-order.ts --side Short --qty 2 --leverage 50
  ./phemex-market-order.ts --side Long --dry-run
`);
  process.exit(0);
}

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) usage();

  const sideRaw = getArg("--side");
  if (!sideRaw) usage();
  const side = sideRaw.toLowerCase() === "long" ? "Buy" : "Sell";
  const phemexSide = sideRaw.charAt(0).toUpperCase() + sideRaw.slice(1).toLowerCase();

  const qty = parseInt(getArg("--qty") ?? "1", 10);
  const leverage = parseInt(getArg("--leverage") ?? "100", 10);
  const symbol = "BTCUSD";
  const dryRun = hasFlag("--dry-run");

  if (dryRun) {
    console.log(`\n  DRY RUN — Would send:\n`);
    console.log(`  PUT /orders/create`);
    console.log(`  symbol=${symbol}&side=${side}&ordType=Market&orderQty=${qty}&timeInForce=ImmediateOrCancel`);
    console.log(`  Leverage: ${leverage}x`);
    console.log();
    process.exit(0);
  }

  const creds = loadCredentialsLocal();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);
  const clOrdID = uuid();

  // Set leverage first
  console.log(`⟐  Opening ${phemexSide} market position on Coin-M:${symbol}`);
  console.log(`   Qty: ${qty}, Leverage: ${leverage}x`);
  await setLeverageCoinM(symbol, leverage, creds.PHEMEX_API_KEY, secretRaw);

  // Place market order
  const query = [
    `symbol=${symbol}`,
    `side=${side}`,
    `ordType=Market`,
    `orderQty=${qty}`,
    `timeInForce=ImmediateOrCancel`,
    `clOrdID=${clOrdID}`,
  ].join("&");

  console.log(`   Placing market order …`);

  const resp = (await request(
    "PUT",
    "/orders/create",
    query,
    creds.PHEMEX_API_KEY,
    secretRaw,
    ""
  )) as Record<string, unknown>;

  if (resp.code === 0) {
    const data = resp.data as Record<string, unknown> | undefined;
    console.log(`   ✓  Order placed`);
    if (data) {
      console.log(`      OrderID:  ${String(data.orderID ?? "?")}`);
      console.log(`      Side:     ${String(data.side ?? "?")}`);
      console.log(`      orderQty: ${String(data.orderQty ?? "?")}`);
      console.log(`      Price:    ${String(data.price ?? "?")}`);
      console.log(`      Status:   ${String(data.ordStatus ?? "?")}`);
      console.log(`      leavesQty: ${String(data.leavesQty ?? "0")}`);
      // console.log(data);
    }
  } else {
    console.error(`  ✗  API error: ${String(resp.msg ?? resp.code)}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
