#!/usr/bin/env npx tsx

/**
 * Phemex Balance Checker — retrieves balances across all account types.
 * Reads credentials from .phemex-credentials.json.
 *
 * Account types queried:
 *   1. Spot Wallet        GET /spot/wallets
 *   2. USDT-M Perpetual   GET /g-accounts/accountPositions?currency=USDT
 *   3. Coin-M Perpetual   GET /accounts/accountPositions?currency=BTC
 *
 * Usage:  npx tsx phemex-balances.ts
 */

import { httpGet, base64UrlDecode } from "./src/http-client.js";
import { loadCredentials } from "./src/credentials.js";

const BASE = "api.phemex.com";

// ── Helpers ────────────────────────────────────────────────

/** Convert scaled Phemex values (Ev) to human-readable amounts */
function toHuman(val: unknown, scale: number): number {
  if (val == null) return 0;
  return Number(val) / scale;
}

// ── Main ───────────────────────────────────────────────────

async function main() {
  // Read credentials
  const creds = loadCredentials(import.meta.dirname);
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  const results: Array<{
    account: string;
    currency: string;
    total: number;
    locked: number;
    available: number;
    bonus?: number;
  }> = [];

  // ── 1. Spot Wallet ──────────────────────────────────────
  console.log("⟐ Spot Wallet ...");
  try {
    const spot = await httpGet("/spot/wallets", null, creds.PHEMEX_API_KEY, secretRaw) as Record<string, unknown>;
    if (spot.code === 0 && Array.isArray(spot.data)) {
      for (const w of spot.data as Record<string, unknown>[]) {
        const currency = String(w.currency ?? "");
        const totalEv = Number(w.totalEv || w.balanceEv || 0);
        const lockedEv = Number(w.lockedEv || 0);
        const scale = 10 ** (Number(w.scale) || 8);
        results.push({
          account: "Spot",
          currency,
          total: toHuman(totalEv, scale),
          locked: toHuman(lockedEv, scale),
          available: toHuman(totalEv - lockedEv, scale),
        });
      }
    }
  } catch (e) {
    console.error("  ✗ Spot error:", (e as Error).message);
  }

  // ── 2. USDT-M Perpetual (g-accounts) ────────────────────
  console.log("⟐ USDT-M Perpetual ...");
  for (const cur of ["USDT", "USD"]) {
    try {
      const resp = await httpGet(
        "/g-accounts/accountPositions",
        `currency=${cur}`,
        creds.PHEMEX_API_KEY,
        secretRaw,
      ) as Record<string, unknown>;
      const data = resp.data as Record<string, unknown> | undefined;
      if (resp.code === 0 && data?.account) {
        const a = data.account as Record<string, unknown>;
        const valScale = 10 ** (Number(a.valueScale) || 4);
        results.push({
          account: `USDT-M (${cur})`,
          currency: cur,
          total: toHuman(a.accountBalanceRv || 0, valScale),
          locked: toHuman(a.totalUsedBalanceRv || 0, valScale),
          available: toHuman(
            (Number(a.accountBalanceRv) || 0) - (Number(a.totalUsedBalanceRv) || 0),
            valScale,
          ),
          bonus: toHuman(a.bonusBalanceRv || 0, valScale),
        });
      }
    } catch (e) {
      console.error(`  ✗ USDT-M (${cur}) error:`, (e as Error).message);
    }
  }

  // ── 3. Coin-M Perpetual ─────────────────────────────────
  console.log("⟐ Coin-M Perpetual ...");
  for (const cur of ["BTC", "ETH", "USD"]) {
    try {
      const resp = await httpGet(
        "/accounts/accountPositions",
        `currency=${cur}`,
        creds.PHEMEX_API_KEY,
        secretRaw,
      ) as Record<string, unknown>;
      const data = resp.data as Record<string, unknown> | undefined;
      if (resp.code === 0 && data?.account) {
        const a = data.account as Record<string, unknown>;
        // Coin-M accountBalanceRv may be scaled by valueScale
        const valScale = 10 ** (Number(a.valueScale) || 8);
        results.push({
          account: `Coin-M (${cur})`,
          currency: cur,
          total: toHuman(a.accountBalanceRv || 0, valScale),
          locked: toHuman(a.totalUsedBalanceRv || 0, valScale),
          available: toHuman(
            (Number(a.accountBalanceRv) || 0) - (Number(a.totalUsedBalanceRv) || 0),
            valScale,
          ),
        });
        break; // Found a valid one, stop iterating
      }
    } catch (e) {
      // Expected for currencies that don't exist for this account
    }
  }

  // ── Output ─────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════");
  console.log("  Phemex Account Balances");
  console.log("═══════════════════════════════════════");

  if (results.length === 0) {
    console.log("  No balances found.");
  } else {
    // Table header
    console.log(
      "  Account".padEnd(20) +
        "Currency".padEnd(10) +
        "Total".padEnd(16) +
        "Available".padEnd(16) +
        "Locked",
    );
    console.log("  " + "─".repeat(68));
    for (const r of results) {
      const totalS = r.total.toFixed(r.currency === "BTC" ? 8 : 2);
      const availS = r.available.toFixed(r.currency === "BTC" ? 8 : 2);
      const lockedS = r.locked.toFixed(r.currency === "BTC" ? 8 : 2);
      let bonus = "";
      if (r.bonus != null && r.bonus > 0) {
        bonus = `  (bonus: ${r.bonus.toFixed(2)})`;
      }
      console.log(
        `  ${r.account.padEnd(18)} ` +
          `${r.currency.padEnd(8)} ` +
          `${totalS.padStart(12)} ${availS.padStart(12)} ${lockedS.padStart(12)}` +
          bonus,
      );
    }
    console.log("  " + "─".repeat(68));
    // Grand totals
    const grand = { total: 0, available: 0, locked: 0 };
    for (const r of results) {
      if (r.currency === "USDT") {
        grand.total += r.total;
        grand.available += r.available;
        grand.locked += r.locked;
      }
    }
    if (grand.total > 0) {
      console.log(
        `  ${"TOTAL (USDT)".padEnd(18)} USDT     ` +
          `${grand.total.toFixed(2).padStart(12)} ` +
          `${grand.available.toFixed(2).padStart(12)} ` +
          `${grand.locked.toFixed(2).padStart(12)}`,
      );
    }
  }
  console.log("═══════════════════════════════════════\n");
}

main().catch((e) => {
  console.error("Fatal:", (e as Error).message);
  process.exit(1);
});