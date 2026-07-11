#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-cancel-orders-all.ts  —  Cancel ALL orders (including untriggered)
 * for a given symbol via the Phemex API.
 *
 * Endpoint:  DELETE /orders/all  (COIN-M)  or  DELETE /g-orders/all  (USDT-M)
 *           selected automatically based on symbol suffix (USDT → USDT-M, else COIN-M)
 *
 * Usage:
 *   npx tsx phemex-cancel-orders-all.ts --symbol BTCUSD
 *   npx tsx phemex-cancel-orders-all.ts --symbol ETHUSD  --dry-run
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
  return symbol.endsWith("USDT") ? "/g-orders/all" : "/orders/all";
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
Usage: ./phemex-cancel-orders-all.ts --symbol <symbol> [--dry-run]

Cancel ALL orders (including untriggered trigger orders) for a symbol.

Options:
  --symbol <symbol>   Trading pair (e.g. BTCUSD, ETHUSD, BTCUSDT)
  --dry-run           Show what would be sent without executing
  --help, -h          Show this help message

Examples:
  ./phemex-cancel-orders-all.ts --symbol BTCUSD       # COIN-M
  ./phemex-cancel-orders-all.ts --symbol XTIUSDT      # USDT-M
  ./phemex-cancel-orders-all.ts --symbol ETHUSD  --dry-run
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

  const symbol = getArg("--symbol");
  if (!symbol) usage();

  const dryRun = hasFlag("--dry-run");
  const path = apiPath(symbol);
  const query = `symbol=${symbol}&untriggered=false`;

  if (dryRun) {
    console.log(`\n  DRY RUN — Would send:\n`);
    console.log(`  DELETE ${path}?${query}`);
    console.log();
    process.exit(0);
  }

  const creds = loadCredentials();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  const accountType = symbol.endsWith("USDT") ? "USDT-M" : "COIN-M";
  console.log(`⟐  [${accountType}] Cancelling ALL orders for ${symbol} (including untriggered) …`);

  const resp = await request("DELETE", path, query, creds.PHEMEX_API_KEY, secretRaw, "");

  if (resp.code === 0) {
    const data = resp.data as Record<string, unknown> | undefined;
    const closedOrders = (data?.closedOrders as Record<string, unknown>[] | undefined) ?? [];
    const untriggered = (data?.untriggered as Record<string, unknown>[] | undefined) ?? [];
    console.log(`  ✓  Done — ${closedOrders.length} open + ${untriggered.length} untriggered order(s) cancelled`);
    if (closedOrders.length > 0 || untriggered.length > 0) {
      console.log();
      for (const o of closedOrders) {
        console.log(`     Closed:   ${String(o.orderID ?? "?")}  ${String(o.side ?? "?")}  qty ${String(o.qty ?? "?")}  @ ${String(o.price ?? "?")}`);
      }
      for (const o of untriggered) {
        console.log(`     Untrig'd: ${String(o.orderID ?? "?")}  ${String(o.side ?? "?")}  qty ${String(o.qty ?? "?")}  @ ${String(o.stopPx ?? "?")}`);
      }
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
