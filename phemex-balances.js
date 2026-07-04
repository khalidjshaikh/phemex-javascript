#!/usr/bin/env node

/**
 * Phemex Balance Checker — retrieves balances across all account types.
 * Reads credentials from phemex-credentials.json.
 *
 * Account types queried:
 *   1. Spot Wallet        GET /spot/wallets
 *   2. USDT-M Perpetual   GET /g-accounts/accountPositions?currency=USDT
 *   3. Coin-M Perpetual   GET /accounts/accountPositions?currency=BTC
 *
 * Usage:  node phemex-balances.js
 */

const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const BASE = "api.phemex.com";

// ── Helpers ────────────────────────────────────────────────

/** Base64-url decode (RFC 4648 §5) */
function base64UrlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

/** Sign a GET request per Phemex spec: HMacSha256(path + qs + expiry) */
function sign(method, path, query, expiry, secretRaw) {
  const qs = query ? "?" + query : "";
  // Phemex signature string: URL Path + QueryString (without '?') + Expiry + body
  const queryStr = query || "";
  const body = "";
  const payload = path + queryStr + expiry + body;
  return crypto.createHmac("sha256", secretRaw).update(payload).digest("hex");
}

/** Perform one signed GET request */
function get(path, query, apiKey, secretRaw) {
  return new Promise((resolve, reject) => {
    const expiry = Math.floor(Date.now() / 1000) + 60;
    const sig = sign("GET", path, query, expiry, secretRaw);
    const qs = query ? "?" + query : "";

    const options = {
      hostname: BASE,
      path: path + qs,
      method: "GET",
      headers: {
        "x-phemex-access-token": apiKey,
        "x-phemex-request-expiry": String(expiry),
        "x-phemex-request-signature": sig,
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (_) {
          reject(new Error(`Bad JSON: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/** Convert scaled Phemex values (Ev) to human-readable amounts */
function toHuman(val, scale) {
  if (val == null) return 0;
  return Number(val) / scale;
}

// ── Main ───────────────────────────────────────────────────

async function main() {
  // Read credentials
  const credsPath = path.join(__dirname, "phemex-credentials.json");
  if (!fs.existsSync(credsPath)) {
    console.error("Missing phemex-credentials.json");
    process.exit(1);
  }
  const { PHEMEX_API_KEY, PHEMEX_API_SECRET } = JSON.parse(
    fs.readFileSync(credsPath, "utf8")
  );
  const secretRaw = base64UrlDecode(PHEMEX_API_SECRET);

  const results = [];

  // ── 1. Spot Wallet ──────────────────────────────────────
  console.log("⟐ Spot Wallet ...");
  try {
    const spot = await get("/spot/wallets", null, PHEMEX_API_KEY, secretRaw);
    if (spot.code === 0 && Array.isArray(spot.data)) {
      for (const w of spot.data) {
        const currency = w.currency;
        const totalEv = Number(w.totalEv || w.balanceEv || 0);
        const lockedEv = Number(w.lockedEv || 0);
        const scale = 10 ** (w.scale || 8);
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
    console.error("  ✗ Spot error:", e.message);
  }

  // ── 2. USDT-M Perpetual (g-accounts) ────────────────────
  console.log("⟐ USDT-M Perpetual ...");
  for (const cur of ["USDT", "USD"]) {
    try {
      const resp = await get(
        "/g-accounts/accountPositions",
        `currency=${cur}`,
        PHEMEX_API_KEY,
        secretRaw
      );
      if (resp.code === 0 && resp.data?.account) {
        const a = resp.data.account;
        const valScale = 10 ** (a.valueScale ?? 4);
        results.push({
          account: `USDT-M (${cur})`,
          currency: cur,
          total: toHuman(a.accountBalanceRv || 0, valScale),
          locked: toHuman(a.totalUsedBalanceRv || 0, valScale),
          available: toHuman(
            (a.accountBalanceRv || 0) - (a.totalUsedBalanceRv || 0),
            valScale
          ),
          bonus: toHuman(a.bonusBalanceRv || 0, valScale),
        });
      }
    } catch (e) {
      console.error(`  ✗ USDT-M (${cur}) error:`, e.message);
    }
  }

  // ── 3. Coin-M Perpetual ─────────────────────────────────
  console.log("⟐ Coin-M Perpetual ...");
  for (const cur of ["BTC", "ETH", "USD"]) {
    try {
      const resp = await get(
        "/accounts/accountPositions",
        `currency=${cur}`,
        PHEMEX_API_KEY,
        secretRaw
      );
      if (resp.code === 0 && resp.data?.account) {
        const a = resp.data.account;
        // Coin-M accountBalanceRv may be scaled by valueScale
        const valScale = 10 ** (a.valueScale ?? 8);
        results.push({
          account: `Coin-M (${cur})`,
          currency: cur,
          total: toHuman(a.accountBalanceRv || 0, valScale),
          locked: toHuman(a.totalUsedBalanceRv || 0, valScale),
          available: toHuman(
            (a.accountBalanceRv || 0) - (a.totalUsedBalanceRv || 0),
            valScale
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
        "Locked"
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
          bonus
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
          `${grand.locked.toFixed(2).padStart(12)}`
      );
    }
  }
  console.log("═══════════════════════════════════════\n");
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
