#!/usr/bin/env -S npx tsx

/**
 * Phemex Transfer — transfer USDT between spot and perpetual futures (USDT-M).
 *
 * Direction:
 *   --direction in   (default) spot → perp: tops up perp to the target
 *   --direction out            perp → spot: drains excess above target back to spot
 *
 * Usage:
 *   npx tsx phemex-transfer.ts --credentials gmail,meta,A02,67b
 *   npx tsx phemex-transfer.ts --credentials gmail,meta,A02,67b --direction out
 *   npx tsx phemex-transfer.ts --credentials gmail,meta,A02,67b --target 0.10 --dry-run
 *
 * The script:
 *   1. Loads credentials from .credentials.json for each profile
 *   2. Checks spot USDT and perp USDT balances
 *   3. Transfers only the delta needed to reach the target (in) or drains excess (out)
 *   4. Skips accounts already at the right balance
 *   5. Reports the transfer result for each account
 */

import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { request, base64UrlDecode } from "../src/http-client.js";
import { loadCredentials } from "../src/credentials.js";
import { getArg, hasFlag } from "../src/cli-utils.js";

const USDT_SCALE = 10 ** 8; // Phemex USDT value scale factor = 8
const TARGET_BALANCE = 0.10; // 10 cents target for perp futures

// ── Helpers ────────────────────────────────────────────────

function loadCredentialProfile(name: string): { PHEMEX_API_KEY: string; PHEMEX_API_SECRET: string } {
  const credsPath = path.resolve(process.cwd(), ".credentials.json");
  if (!fs.existsSync(credsPath)) {
    console.error(`✗  Missing ${credsPath}`);
    process.exit(1);
  }
  const all = JSON5.parse(fs.readFileSync(credsPath, "utf8")) as Record<string, { PHEMEX_API_KEY: string; PHEMEX_API_SECRET: string }>;
  if (!all[name]) {
    console.error(`✗  Credential profile "${name}" not found in .credentials.json (available: ${Object.keys(all).join(", ")})`);
    process.exit(1);
  }
  return all[name];
}

function toHuman(val: unknown, scale: number): number {
  if (val == null) return 0;
  return Number(val) / scale;
}

// ── Main ───────────────────────────────────────────────────

async function main() {
  const credArg = getArg("--credential") ?? getArg("--credentials");
  if (!credArg) {
    console.error("Usage: npx tsx phemex-transfer.ts --credentials <name1,name2,...> [--direction in|out] [--target 0.10] [--dry-run]");
    console.error("  Available profiles: gmail, meta, high, low, A02, 67b");
    process.exit(1);
  }

  const credNames = credArg.split(",").map((s) => s.trim());
  const target = parseFloat(getArg("--target") ?? String(TARGET_BALANCE));
  const dryRun = hasFlag("--dry-run");
  const direction = (getArg("--direction") ?? "in") as "in" | "out";

  if (direction !== "in" && direction !== "out") {
    console.error(`✗  Invalid direction: ${direction} (use "in" or "out")`);
    process.exit(1);
  }

  if (isNaN(target) || target <= 0) {
    console.error(`✗  Invalid target: ${target}`);
    process.exit(1);
  }

  const dirLabel = direction === "in" ? "Spot → Perpetual Futures" : "Perpetual Futures → Spot";

  console.log("═══════════════════════════════════════");
  console.log(`  Phemex ${dirLabel} Transfer`);
  console.log("═══════════════════════════════════════");
  console.log(`  Target:  ${target} USDT per account`);
  console.log(`  Direction: ${direction === "in" ? "spot → perp" : "perp → spot"}`);
  console.log(`  Accounts: ${credNames.join(", ")}`);
  if (dryRun) console.log("  *** DRY RUN — no transfers will be executed ***");
  console.log("═══════════════════════════════════════\n");

  const results: Array<{ profile: string; ok: boolean; transferred?: number; error?: string }> = [];

  for (const name of credNames) {
    console.log(`── Profile: ${name} ──`);
    const creds = loadCredentialProfile(name);
    const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

    // 1. Check spot USDT balance
    let spotUsdt = 0;
    try {
      const spot = await request("GET", "/spot/wallets", "currency=USDT", creds.PHEMEX_API_KEY, secretRaw, "");
      if (spot.code === 0 && Array.isArray(spot.data)) {
        for (const w of spot.data as Record<string, unknown>[]) {
          if (String(w.currency) === "USDT") {
            const totalEv = Number(w.totalEv || w.balanceEv || 0);
            const lockedEv = Number(w.lockedEv || 0);
            spotUsdt = toHuman(totalEv - lockedEv, USDT_SCALE);
            break;
          }
        }
      }
    } catch (e) {
      const msg = (e as Error).message;
      console.error(`  ✗ Spot balance check failed: ${msg}`);
      results.push({ profile: name, ok: false, error: msg });
      continue;
    }

    // 2. Check perp futures USDT balance
    let perpUsdt = 0;
    try {
      const resp = await request("GET", "/g-accounts/accountPositions", "currency=USDT", creds.PHEMEX_API_KEY, secretRaw, "");
      const data = resp.data as Record<string, unknown> | undefined;
      if (resp.code === 0 && data?.account) {
        const a = data.account as Record<string, unknown>;
        perpUsdt = Number(a.accountBalanceRv ?? 0);
      }
    } catch (e) {
      const msg = (e as Error).message;
      console.error(`  ✗ Perp balance check failed: ${msg}`);
      results.push({ profile: name, ok: false, error: msg });
      continue;
    }

    console.log(`  Spot USDT:     ${spotUsdt.toFixed(8)}`);
    console.log(`  Perp USDT:     ${perpUsdt.toFixed(8)}`);

    // 3. Calculate transfer amount based on direction
    let transferAmount = 0;
    let moveOp: number;

    if (direction === "in") {
      // spot → perp: top up perp to target
      const delta = target - perpUsdt;
      if (delta <= 0) {
        console.log(`  ✓ Perp already at target (${perpUsdt.toFixed(8)} >= ${target}), skipping`);
        results.push({ profile: name, ok: true, transferred: 0 });
        continue;
      }
      transferAmount = Math.min(delta, spotUsdt);
      moveOp = 2;
    } else {
      // perp → spot: drain excess above target
      const excess = perpUsdt - target;
      if (excess <= 0) {
        console.log(`  ✓ Perp already at or below target (${perpUsdt.toFixed(8)} <= ${target}), skipping`);
        results.push({ profile: name, ok: true, transferred: 0 });
        continue;
      }
      transferAmount = excess;
      moveOp = 1;
    }

    if (transferAmount <= 0) {
      const side = direction === "in" ? "spot" : "perp";
      const msg = `Insufficient ${side} USDT for transfer`;
      console.error(`  ✗ ${msg}`);
      results.push({ profile: name, ok: false, error: msg });
      continue;
    }

    // Round to 8 decimals to avoid floating point issues
    const roundedAmount = Math.floor(transferAmount * USDT_SCALE) / USDT_SCALE;
    const amountEv = Math.round(roundedAmount * USDT_SCALE);

    const arrow = direction === "in" ? "→ perp" : "→ spot";
    console.log(`  Transferring:  ${roundedAmount.toFixed(8)} USDT ${arrow}`);

    if (dryRun) {
      console.log(`  ✓ Would transfer ${roundedAmount.toFixed(8)} USDT`);
      results.push({ profile: name, ok: true, transferred: roundedAmount });
      continue;
    }

    // 4. Execute transfer
    try {
      const body = JSON.stringify({
        currency: "USDT",
        amountEv: String(amountEv),
        moveOp,
      });

      const resp = await request("POST", "/assets/transfer", null, creds.PHEMEX_API_KEY, secretRaw, body);

      if (resp.code === 0) {
        console.log(`  ✓ Transferred ${roundedAmount.toFixed(8)} USDT ${arrow}`);
        results.push({ profile: name, ok: true, transferred: roundedAmount });
      } else {
        const msg = `API error ${resp.code}: ${resp.msg}`;
        console.error(`  ✗ ${msg}`);
        results.push({ profile: name, ok: false, error: msg });
      }
    } catch (e) {
      const msg = (e as Error).message;
      console.error(`  ✗ Transfer failed: ${msg}`);
      results.push({ profile: name, ok: false, error: msg });
    }
  }

  // ── Summary ─────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════");
  console.log("  Summary");
  console.log("═══════════════════════════════════════");
  let totalTransferred = 0;
  for (const r of results) {
    if (r.ok) {
      const amt = r.transferred ?? 0;
      totalTransferred += amt;
      console.log(`  ✓ ${r.profile.padEnd(10)} ${amt.toFixed(8)} USDT`);
    } else {
      console.log(`  ✗ ${r.profile.padEnd(10)} ${r.error}`);
    }
  }
  console.log("───────────────────────────────────────");
  console.log(`  Total transferred: ${totalTransferred.toFixed(8)} USDT`);
  console.log("═══════════════════════════════════════\n");
}

main().catch((e) => {
  console.error("Fatal:", (e as Error).message);
  process.exit(1);
});
