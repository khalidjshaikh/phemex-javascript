#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-list-untriggered-orders.ts  —  List untriggered trigger orders
 * for a given symbol via the Phemex API.
 *
 * Endpoint:  GET /orders/activeList?ordStatus=Untriggered&symbol=<symbol>
 *
 * Usage:
 *   npx tsx phemex-list-untriggered-orders.ts --symbol BTCUSD
 *   npx tsx phemex-list-untriggered-orders.ts --symbol ETHUSD  --dry-run
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
Usage: ./phemex-list-untriggered-orders.ts --symbol <symbol> [--dry-run]

List untriggered trigger orders for a symbol via GET /orders/activeList.

Options:
  --symbol <symbol>   Trading pair (e.g. BTCUSD, ETHUSD, BTCUSDT)
  --dry-run           Show what would be sent without executing
  --help, -h          Show this help message

Examples:
  ./phemex-list-untriggered-orders.ts --symbol BTCUSD
  ./phemex-list-untriggered-orders.ts --symbol ETHUSD  --dry-run
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
  const query = `ordStatus=Untriggered&symbol=${symbol}`;

  if (dryRun) {
    console.log(`\n  DRY RUN — Would send:\n`);
    console.log(`  GET /orders/activeList?${query}`);
    console.log();
    process.exit(0);
  }

  const creds = loadCredentials();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  console.log(`⟐  Fetching untriggered orders for ${symbol} …`);

  const resp = await request("GET", "/orders/activeList", query, creds.PHEMEX_API_KEY, secretRaw, "");

  if (resp.code === 0) {
    const data = resp.data as Record<string, unknown> | undefined;
    const rows = (data?.rows as Record<string, unknown>[] | undefined) ?? [];

    // console.log(data)

    if (rows.length === 0) {
      console.log("  ℹ  No untriggered orders found.");
    } else {
      console.log(`  ✓  Found ${rows.length} untriggered order(s):\n`);
      for (const o of rows) {
        const orderID = String(o.orderID ?? "?");
        const side = String(o.side ?? "?");
        const qty = String(o.orderQty ?? "?");
        const stopPx = String(o.stopPx ?? "?");
        const price = String(o.price ?? "?");
        // const triggerType = String(o.triggerType ?? "?");
        // console.log(`     ${orderID}  ${side}  qty ${qty}  trigger @ ${stopPx}  limit @ ${price}  type=${triggerType}`);
        console.log(`${orderID} ${side} qty ${qty} limit @ ${price}`);
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
