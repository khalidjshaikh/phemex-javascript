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

import { httpGet, base64UrlDecode } from "./src/http-client.js";
import { loadCredentials } from "./src/credentials.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

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
  const creds = loadCredentials(import.meta.dirname);
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  /* -- Query Coin-M balances for settlement currencies ------------ */
  const settlementCurrencies = ["BTC", "ETH", "USD"];
  const balances: CoinMBalance[] = [];

  for (const cur of settlementCurrencies) {
    process.stdout.write(`⟐  Coin-M (${cur}) … `);
    try {
      const resp = await httpGet("/accounts/accountPositions", `currency=${cur}`, creds.PHEMEX_API_KEY, secretRaw) as unknown as ApiResponse;
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
