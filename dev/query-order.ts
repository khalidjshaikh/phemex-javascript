#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * Query a specific order by orderID via /g-orders/active.
 */
import https from "node:https";
import crypto from "node:crypto";
import { base64UrlDecode } from "../src/http-client.js";
import { loadCredentialsLocal } from "../src/credentials.js";

const HOST = "api.phemex.com";
const creds = loadCredentialsLocal();
const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

const ORDER_ID = "5c251c17-9989-4d0d-af1e-8c2c238faeb5";
const SYMBOL = "XTIUSDT";

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
            reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 1000)}`));
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
  // Try /g-orders/active?symbol=XTIUSDT&posSide=Long&orderID=...
  const query = `symbol=${SYMBOL}&posSide=Long&orderID=${ORDER_ID}`;
  console.log(`⟐  GET /g-orders/active?${query}`);
  try {
    const raw = await signedGet("/g-orders/active", query);
    console.log(JSON.stringify(JSON.parse(raw), null, 2));
  } catch (e) {
    console.error(String(e));
  }
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
