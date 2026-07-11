#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-coinm-balance.ts  —  Retrieve the Coin-M (inverse perpetual)
 * BTC futures account balance (wallet info) from Phemex.
 *
 * Endpoint:  GET /accounts/accountPositions?currency=BTC
 *            (the account wallet object is returned alongside positions)
 *
 * Usage:  npx tsx phemex-coinm-balance.ts
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

interface CoinMBalance {
  currency: string;
  total: number;       // accountBalanceRv scaled
  used: number;        // totalUsedBalanceRv scaled
  available: number;   // total - used
  bonus: number;       // bonusBalanceRv scaled
  bonusUsed: number;   // bonusUsedBalanceRv scaled (if present)
}

interface ApiResponse {
  code: number;
  msg?: string;
  data?: {
    account?: Record<string, unknown>;
    positions?: unknown[];
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

/** Parse the Coin-M account balance from the API response */
function parseBalance(account: Record<string, unknown>, currency: string): CoinMBalance {
  const valueScale = 10 ** (Number(account.valueScale) || 8);

  const total    = Number(account.accountBalanceRv    ?? 0) / valueScale;
  const used     = Number(account.totalUsedBalanceRv  ?? 0) / valueScale;
  const bonus    = Number(account.bonusBalanceRv      ?? 0) / valueScale;
  const bonusUsed = Number(account.bonusUsedBalanceRv ?? 0) / valueScale;

  return {
    currency,
    total,
    used,
    available: total - used,
    bonus,
    bonusUsed,
  };
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  /* -- Read credentials ------------------------------------------- */
  const credsPath = path.resolve(import.meta.dirname, ".phemex-credentials.json");
  if (!fs.existsSync(credsPath)) {
    console.error("✗  Missing .phemex-credentials.json");
    process.exit(1);
  }
  const creds: Credentials = JSON.parse(fs.readFileSync(credsPath, "utf8"));
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  /* -- Query Coin-M balances for settlement currencies ------------ */
  const settlementCurrencies = ["BTC", "ETH", "USD"];
  const balances: CoinMBalance[] = [];

  for (const cur of settlementCurrencies) {
    process.stdout.write(`⟐  Coin-M (${cur}) … `);
    try {
      const resp = await get("/accounts/accountPositions", `currency=${cur}`, creds.PHEMEX_API_KEY, secretRaw);
      if (resp.code !== 0) {
        console.log(`API error: ${resp.msg ?? resp.code}`);
        continue;
      }
      if (!resp.data?.account) {
        console.log("no account data");
        continue;
      }
      const balance = parseBalance(resp.data.account, cur);
      balances.push(balance);
      console.log(`${balance.total.toFixed(8)} ${cur}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`error: ${msg}`);
    }
  }

  /* -- Output ----------------------------------------------------- */
  if (balances.length === 0) {
    console.log("\nNo Coin-M balances found.");
    process.exit(0);
  }

  console.log(
    `\n${"Currency".padEnd(10)} ` +
    `${"Total".padStart(16)} ${"Available".padStart(16)} ` +
    `${"Used/Margin".padStart(16)} ${"Bonus".padStart(16)} ${"Bonus Used".padStart(16)}`
  );
  console.log("─".repeat(90));

  for (const b of balances) {
    const totalS    = b.total.toFixed(8).padStart(16);
    const availS    = b.available.toFixed(8).padStart(16);
    const usedS     = b.used.toFixed(8).padStart(16);
    const bonusS    = b.bonus.toFixed(8).padStart(16);
    const bonusUsedS = b.bonusUsed.toFixed(8).padStart(16);
    console.log(`${b.currency.padEnd(10)} ${totalS} ${availS} ${usedS} ${bonusS} ${bonusUsedS}`);
  }
  console.log("─".repeat(90));
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
