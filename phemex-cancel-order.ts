#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-cancel-order.ts  —  Cancel a single order by its order ID
 *
 * Endpoint:  DELETE /orders        (COIN-M)
 *            DELETE /g-orders      (USDT-M, requires --pos-side)
 *
 * Usage:
 *   npx tsx phemex-cancel-order.ts --order-id <uuid> --symbol XTIUSDT --pos-side Short
 *   npx tsx phemex-cancel-order.ts --order-id <uuid> --symbol BTCUSD
 */

import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Credentials {
  PHEMEX_API_KEY: string;
  PHEMEX_API_SECRET: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Determine the correct API path based on symbol suffix */
function apiPath(symbol: string): string {
  // USDT-M (linear) uses /g-orders/*, COIN-M (inverse) uses /orders/*
  return symbol.endsWith("USDT") ? "/g-orders" : "/orders";
}

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

/** Perform one signed HTTP request and parse the JSON response */
async function request(
  method: "GET" | "POST" | "DELETE",
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

function loadCredentials(): Credentials {
  const credsPath = path.resolve(import.meta.dirname, ".phemex-credentials.json");
  if (!fs.existsSync(credsPath)) {
    console.error("✗  Missing .phemex-credentials.json");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(credsPath, "utf8"));
}

function usage(): never {
  console.log(`
Usage: ./phemex-cancel-order.ts --order-id <uuid> --symbol <symbol> [--pos-side <Side>]

Cancel a single order by its order ID on Phemex.

Arguments:
  --order-id <uuid>   Order ID to cancel (required)
  --symbol <symbol>   Trading pair, e.g. XTIUSDT, BTCUSD (required)
  --pos-side <Side>   Position side: Long or Short (required for USDT-M orders)
  --help, -h          Show this help message

Examples:
  ./phemex-cancel-order.ts --order-id 2c43dcca-... --symbol XTIUSDT --pos-side Short
  ./phemex-cancel-order.ts --order-id 2c43dcca-... --symbol BTCUSD
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

  const orderId = getArg("--order-id");
  const symbol = getArg("--symbol");
  const posSide = getArg("--pos-side");

  if (!orderId || !symbol) usage();

  const isUsdt = symbol.endsWith("USDT");
  if (isUsdt && !posSide) {
    console.error("✗  --pos-side is required for USDT-M symbols (Long or Short)");
    process.exit(1);
  }

  const urlPath = apiPath(symbol);
  const qp = new URLSearchParams();
  qp.set("orderID", orderId);
  qp.set("symbol", symbol);
  if (posSide) qp.set("posSide", posSide);
  const query = qp.toString();

  const creds = loadCredentials();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  const accountType = isUsdt ? "USDT-M" : "COIN-M";
  console.log(`⟐  [${accountType}] Cancelling order ${orderId} …`);

  const resp = await request("DELETE", urlPath, query, creds.PHEMEX_API_KEY, secretRaw, "");

  if (resp.code === 0) {
    console.log("  ✓  Order cancelled successfully");
  } else {
    console.error(`  ✗  API error: ${String(resp.msg ?? resp.code)}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});