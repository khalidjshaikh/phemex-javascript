#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-auth.ts  —  Phemex API User Authentication verification.
 *
 * Validates and tests API credentials by calling authenticated endpoints.
 * Reports account details, permissions, and credential health.
 *
 * Usage:
 *   npx tsx phemex-auth.ts                        # verify credentials (default)
 *   npx tsx phemex-auth.ts --verbose              # show full account details
 *   npx tsx phemex-auth.ts --json                 # raw JSON output
 *   npx tsx phemex-auth.ts --help                 # show help
 *
 * Exit codes:
 *   0   Authentication successful
 *   1   Credential file missing or invalid
 *   2   API authentication failed (invalid key/secret)
 *   3   Network or unexpected error
 */

import { httpGet, base64UrlDecode } from "./src/http-client.js";
import { loadCredentials } from "./src/credentials.js";
import { hasFlag } from "./src/cli-utils.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface ApiResponse {
  code: number;
  msg?: string;
  data?: unknown;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function usage(): never {
  console.log(`
Usage: npx tsx phemex-auth.ts [options]

Verify Phemex API credentials and display account information.
Credentials are read from .phemex-credentials.json.

Options:
  --verbose           Show full account details
  --json              Output raw JSON instead of formatted display
  --help, -h          Show this help message
`);
  process.exit(0);
}

/** Format a key-value pair for display */
function kv(key: string, value: string, width: number = 22): string {
  return `  ${key.padEnd(width)} ${value}`;
}

/** Truncate and mask a string for safe display */
function maskKey(key: string, visible: number = 8): string {
  if (key.length <= visible + 4) return key;
  return key.slice(0, visible) + "…" + key.slice(-4);
}

/* ------------------------------------------------------------------ */
/*  Credential Validation                                              */
/* ------------------------------------------------------------------ */

/** Validate the format of the API key (UUID v4 format) */
function validateApiKey(key: string): string | null {
  const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!key || key.length === 0) return "API key is empty";
  if (!uuidV4.test(key)) return "API key does not match UUID v4 format";
  return null;
}

/** Validate the API secret (base64url-encoded, reasonable length) */
function validateApiSecret(secret: string): string | null {
  if (!secret || secret.length === 0) return "API secret is empty";
  if (secret.length < 16) return "API secret is too short (< 16 chars)";
  try {
    const decoded = base64UrlDecode(secret);
    if (decoded.length === 0) return "API secret decodes to an empty buffer";
  } catch {
    return "API secret is not valid base64url-encoded";
  }
  return null;
}

/** Validate credentials and return a list of issues */
function validateCredentials(
  apiKey: string,
  apiSecret: string,
): { valid: boolean; issues: string[] } {
  const issues: string[] = [];

  const keyIssue = validateApiKey(apiKey);
  if (keyIssue) issues.push(`API key: ${keyIssue}`);

  const secretIssue = validateApiSecret(apiSecret);
  if (secretIssue) issues.push(`API secret: ${secretIssue}`);

  return { valid: issues.length === 0, issues };
}

/* ------------------------------------------------------------------ */
/*  API Calls                                                          */
/* ------------------------------------------------------------------ */

/**
 * Fetch USDT-M account summary — confirms authentication and returns
 * account-level data (margin mode, leverage, balances).
 */
async function fetchUsdtAccount(
  apiKey: string,
  secretRaw: Buffer,
): Promise<ApiResponse> {
  return httpGet(
    "/g-accounts/accountPositions",
    "currency=USDT",
    apiKey,
    secretRaw,
  ) as unknown as Promise<ApiResponse>;
}

/**
 * Fetch spot wallets — a second authenticated endpoint to verify
 * broader API access (spot trading permissions).
 */
async function fetchSpotWallets(
  apiKey: string,
  secretRaw: Buffer,
): Promise<ApiResponse> {
  return httpGet("/spot/wallets", null, apiKey, secretRaw) as unknown as Promise<ApiResponse>;
}

/* ------------------------------------------------------------------ */
/*  Display                                                            */
/* ------------------------------------------------------------------ */

function displayAuthResult(
  usdtResp: ApiResponse | null,
  spotResp: ApiResponse | null,
  verbose: boolean,
): void {
  const sep = "─".repeat(56);

  console.log(`\n  ╔${sep}╗`);
  console.log(`  ║  Phemex API Authentication                      ║`);
  console.log(`  ╚${sep}╝`);

  if (!usdtResp && !spotResp) {
    console.log(`\n  ✗  Authentication FAILED — no account data returned.\n`);
    return;
  }

  // ── USDT-M Account ──────────────────────────────────────────
  if (usdtResp && usdtResp.code === 0) {
    const data = usdtResp.data as Record<string, unknown> | undefined;
    const acct = data?.account as Record<string, unknown> | undefined;

    if (acct) {
      console.log(`\n  ┌─ USDT-M Perpetual Account ──────────────────────┐`);
      console.log(kv("Account Type", String(acct.accountType ?? "—")));
      if (acct.leverage != null) {
        console.log(kv("Leverage", String(acct.leverage)));
      }
      if (acct.accountBalanceRv != null) {
        console.log(kv("Balance (Rv)", String(acct.accountBalanceRv)));
      }
      if (acct.totalUsedBalanceRv != null) {
        console.log(kv("Used Margin (Rv)", String(acct.totalUsedBalanceRv)));
      }
      if (verbose && acct.currency) {
        console.log(kv("Currency", String(acct.currency)));
      }
    }

    // Show open positions
    const positions = data?.positions as Record<string, unknown>[] | undefined;
    if (positions && positions.length > 0) {
      const open = positions.filter((p) => p.side !== "None" && p.size !== "0");
      if (open.length > 0) {
        console.log(`\n  ┌─ Open Positions (${open.length}) ────────────────────┐`);
        for (const pos of open) {
          console.log(`    ${String(pos.symbol).padEnd(12)} ${String(pos.side).padEnd(6)} ${String(pos.size)}`);
        }
      }
    }
  }

  // ── Spot Wallet ─────────────────────────────────────────────
  if (spotResp && spotResp.code === 0) {
    const wallets = spotResp.data as Record<string, unknown>[] | undefined;
    if (Array.isArray(wallets) && wallets.length > 0) {
      console.log(`\n  ┌─ Spot Wallet (${wallets.length} currencies) ──────────┐`);
      if (verbose) {
        for (const w of wallets) {
          const cur = String(w.currency ?? "?");
          const bal = w.totalEv ?? w.balanceEv ?? "—";
          console.log(`    ${cur.padEnd(8)} ${bal}`);
        }
      } else {
        // Just list the currencies
        const currencies = wallets.map((w) => String(w.currency ?? "?")).join(", ");
        console.log(`    Currencies: ${currencies}`);
      }
    }
  }

  // ── API Key info ──────────────────────────────────────────────
  console.log(`\n  ┌─ API Credentials ───────────────────────────────┐`);
  console.log(kv("Auth Method", "HMAC-SHA256"));
  console.log(kv("Signature Version", "v1"));
  console.log(kv("Base URL", "https://api.phemex.com"));

  if (verbose) {
    console.log(kv("Verified At", new Date().toISOString()));
  }

  console.log(`\n  ✓  Authentication successful.\n`);
}

function displayJson(
  usdtResp: ApiResponse | null,
  spotResp: ApiResponse | null,
): void {
  console.log(JSON.stringify({
    authenticated: usdtResp !== null || spotResp !== null,
    usdtAccount: usdtResp,
    spotWallet: spotResp,
    timestamp: new Date().toISOString(),
  }, null, 2));
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) usage();

  const verbose = hasFlag("--verbose");
  const asJson  = hasFlag("--json");

  // ── Load credentials ──────────────────────────────────────────
  console.error("⟐  Loading credentials …");
  let creds: { PHEMEX_API_KEY: string; PHEMEX_API_SECRET: string };
  try {
    creds = loadCredentials(import.meta.dirname);
  } catch (e) {
    console.error("✗  Failed to load credentials:", (e as Error).message);
    process.exit(1);
  }

  // ── Validate credential format ────────────────────────────────
  console.error("⟐  Validating credential format …");
  const validation = validateCredentials(creds.PHEMEX_API_KEY, creds.PHEMEX_API_SECRET);
  if (!validation.valid) {
    for (const issue of validation.issues) {
      console.error(`  ✗  ${issue}`);
    }
    console.error("\n  Please check your .phemex-credentials.json file.\n");
    process.exit(1);
  }
  console.error("  ✓  Credential format looks valid.");

  // ── Decode secret ─────────────────────────────────────────────
  let secretRaw: Buffer;
  try {
    secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);
  } catch (e) {
    console.error("✗  Failed to decode API secret:", (e as Error).message);
    process.exit(1);
  }

  const apiKey = creds.PHEMEX_API_KEY;

  // ── Test authentication via USDT-M account endpoint ──────────
  console.error(`⟐  Authenticating via USDT-M account …`);
  let usdtResp: ApiResponse | null = null;
  try {
    usdtResp = await fetchUsdtAccount(apiKey, secretRaw);
    if (usdtResp.code === 0) {
      console.error("  ✓  USDT-M authentication succeeded.");
    } else {
      console.error(`  ✗  USDT-M API error: ${usdtResp.msg ?? "code " + usdtResp.code}`);
      if (usdtResp.code === 6001) {
        console.error("\n  Hint: Invalid API key. Check your .phemex-credentials.json.");
      } else if (usdtResp.code === 6002) {
        console.error("\n  Hint: Invalid signature. The API secret may be wrong.");
      } else if (usdtResp.code === 6003) {
        console.error("\n  Hint: Request expired. Check your system clock.");
      }
      process.exit(2);
    }
  } catch (e) {
    console.error("✗  Network error:", (e as Error).message);
    process.exit(3);
  }

  // ── Optionally verify spot wallet access ─────────────────────
  let spotResp: ApiResponse | null = null;
  if (verbose || asJson) {
    console.error("⟐  Verifying spot wallet access …");
    try {
      spotResp = await fetchSpotWallets(apiKey, secretRaw);
      if (spotResp.code === 0) {
        const wallets = spotResp.data as Record<string, unknown>[] | undefined;
        console.error(`  ✓  Spot wallet: ${Array.isArray(wallets) ? wallets.length + " currencies" : "OK"}`);
      } else {
        console.error(`  ⚠  Spot wallet error: ${spotResp.msg ?? "code " + spotResp.code}`);
      }
    } catch {
      console.error("  ⚠  Could not fetch spot wallets.");
    }
  }

  // ── Output ────────────────────────────────────────────────────
  if (asJson) {
    displayJson(usdtResp, spotResp);
  } else {
    displayAuthResult(usdtResp, spotResp, verbose);
  }
}

main().catch((e) => {
  console.error("Fatal:", (e as Error).message);
  process.exit(3);
});