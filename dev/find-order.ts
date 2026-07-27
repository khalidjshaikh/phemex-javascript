#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * Query all open USDT-M orders to find a specific orderID.
 */
import { base64UrlDecode } from "../src/http-client.js";
import { loadCredentialsLocal } from "../src/credentials.js";
import https from "node:https";
import crypto from "node:crypto";

const HOST = "api.phemex.com";
const PATH = "/g-orders/activeList";

const creds = loadCredentialsLocal();
const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

async function signedGet(path: string, query: string | null): Promise<string> {
  return new Promise((resolve, reject) => {
    const qs = query ? "?" + query : "";
    const expiry = Math.floor(Date.now() / 1000) + 60;
    const payload = path + (query ?? "") + expiry + "";
    const sig = crypto.createHmac("sha256", secretRaw).update(payload).digest("hex");

    const req = https.request(
      {
        hostname: HOST,
        path: path + qs,
        method: "GET",
        headers: {
          "x-phemex-access-token": creds.PHEMEX_API_KEY,
          "x-phemex-request-expiry": String(expiry),
          "x-phemex-request-signature": sig,
          "Content-Type": "application/json",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          } else {
            resolve(data);
          }
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function main() {
  const TARGET = "a644b787-8b08-1752-45e4-c628c4e84a61";

  // Try /g-orders/activeList (all open USDT-M orders)
  console.log("⟐  Fetching open USDT-M orders …");
  const raw = await signedGet(PATH, null);
  const resp = JSON.parse(raw);

  if (resp.code === 0 && resp.data?.rows) {
    const rows = resp.data.rows as Record<string, unknown>[];
    console.log(`  ${rows.length} open order(s)`);
    for (const o of rows) {
      const oid = String(o.orderID ?? "");
      console.log(`     ${oid}  ${o.side}  ${o.symbol}  qty ${o.qty}  ${o.posSide ?? ""}`);
      if (oid === TARGET) {
        console.log("    → FOUND TARGET");
        console.log(JSON.stringify(o, null, 4));
      }
    }
  } else {
    console.log("  Response:", JSON.stringify(resp, null, 2));
  }
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
