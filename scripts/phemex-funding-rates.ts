#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-funding-rates.ts — Display funding rates for all USDT perpetual
 * symbols with APR estimates and countdown to next funding.
 *
 * Public endpoint, no credentials needed.
 *
 * Usage:
 *   npx tsx phemex-funding-rates.ts
 *   npx tsx phemex-funding-rates.ts --interval 5000   # refresh every 5s
 *   npx tsx phemex-funding-rates.ts --sort apr         # sort by APR
 *   npx tsx phemex-funding-rates.ts --min-apr 5        # only show >= 5% APR
 */

import { publicGet } from "../src/http-client.js";
import { getArg, hasFlag } from "../src/cli-utils.js";

const USAGE = `Usage: npx tsx phemex-funding-rates.ts [options]

Display funding rates for USDT perpetual symbols.

Options:
  --interval <MS>   Refresh interval in ms (default: 10000)
  --sort <field>    Sort by: symbol, rate, apr (default: apr)
  --min-apr <n>     Only show symbols with APR >= n
  --limit <n>       Max symbols to show (default: 50)
  --all             Show all symbols (slow)
  --help            Show this help and exit
`;

if (hasFlag("--help")) {
  console.log(USAGE);
  process.exit(0);
}

const INTERVAL_MS = Number(getArg("--interval") ?? 10000);
const SORT_BY = getArg("--sort") ?? "apr";
const MIN_APR = Number(getArg("--min-apr") ?? 0);
const LIMIT = hasFlag("--all") ? Infinity : Number(getArg("--limit") ?? 50);

interface FundingInfo {
  symbol: string;
  fundingRate: number;
  predictedRate: number;
  markPrice: number;
  lastPrice: number;
  apr: number;
  predictedApr: number;
}

/** Fetch all USDT perpetual symbols from exchange info */
async function fetchSymbols(): Promise<string[]> {
  const resp = (await publicGet(
    "/public/products",
    null,
  )) as Record<string, unknown>;

  if (resp.error) {
    throw new Error(`API error: ${JSON.stringify(resp.error)}`);
  }

  const data = resp.data as Record<string, unknown>;
  // USDT-M perpetuals are in perpProductsV2, not products
  const perpV2 = (data?.perpProductsV2 as any[]) ?? [];
  
  return perpV2
    .filter((p: any) => p.symbol?.endsWith("USDT"))
    .map((p: any) => p.symbol as string)
    .sort();
}

/** Fetch funding rate and ticker data for a symbol */
async function fetchFundingInfo(symbol: string): Promise<FundingInfo | null> {
  try {
    const resp = (await publicGet(
      "/md/v2/ticker/24hr",
      `symbol=${symbol}`,
    )) as Record<string, unknown>;

    if (resp.error) return null;

    const data = resp.result as Record<string, unknown>;
    const fundingRate = Number(data.fundingRateRr ?? 0);
    const predictedRate = Number(data.predFundingRateRr ?? 0);
    const markPrice = Number(data.markPriceRp ?? 0);
    const lastPrice = Number(data.closeRp ?? 0);

    // APR = funding rate * 3 * 365 * 100 (funding every 8 hours)
    const apr = fundingRate * 3 * 365 * 100;
    const predictedApr = predictedRate * 3 * 365 * 100;

    return {
      symbol,
      fundingRate,
      predictedRate,
      markPrice,
      lastPrice,
      apr,
      predictedApr,
    };
  } catch {
    return null;
  }
}

/** Format number with sign and percentage */
function fmtPct(v: number, decimals = 4): string {
  const s = Math.abs(v).toFixed(decimals);
  return v > 0 ? `+${s}%` : v < 0 ? `-${s}%` : ` ${s}%`;
}

/** Format APR with color hint */
function fmtApr(v: number): string {
  const s = Math.abs(v).toFixed(1);
  return v > 0 ? `+${s}%` : v < 0 ? `-${s}%` : ` ${s}%`;
}

/** Pad string to width */
function pad(s: string, w: number, right = false): string {
  if (s.length >= w) return s.slice(0, w);
  return right ? s + " ".repeat(w - s.length) : " ".repeat(w - s.length) + s;
}

/** Get countdown string from hours (approximate) */
function countdownStr(): string {
  const now = new Date();
  const hours = now.getUTCHours();
  const minutes = now.getUTCMinutes();

  // Funding at 00:00, 08:00, 16:00 UTC
  const fundingHours = [0, 8, 16];
  let nextFunding = fundingHours.find(h => h > hours) ?? fundingHours[0] + 24;
  const minsUntil = (nextFunding - hours - 1) * 60 + (60 - minutes);
  const h = Math.floor(minsUntil / 60);
  const m = minsUntil % 60;
  return `${h}h ${m}m`;
}

async function main(): Promise<void> {
  console.log("Fetching USDT perpetual symbols...");
  const symbols = await fetchSymbols();
  console.log(`Found ${symbols.length} symbols\n`);

  for (;;) {
    const started = Date.now();

    // Fetch funding info for all symbols
    const results: FundingInfo[] = [];
    const batchSize = 20;

    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      const batchResults = await Promise.all(batch.map(fetchFundingInfo));
      for (const r of batchResults) {
        if (r) results.push(r);
      }
    }

    // Sort
    results.sort((a, b) => {
      switch (SORT_BY) {
        case "symbol": return a.symbol.localeCompare(b.symbol);
        case "rate": return Math.abs(b.fundingRate) - Math.abs(a.fundingRate);
        case "apr":
        default: return Math.abs(b.apr) - Math.abs(a.apr);
      }
    });

    // Filter and limit
    let filtered = MIN_APR > 0
      ? results.filter(r => Math.abs(r.apr) >= MIN_APR)
      : results;
    if (LIMIT < Infinity) {
      filtered = filtered.slice(0, LIMIT);
    }

    // Clear screen
    process.stdout.write("\x1B[2J\x1B[0;0H");

    // Header
    const countdown = countdownStr();
    console.log("═══════════════════════════════════════════════════════════════════════════════════════════════");
    console.log("  PHMEX FUNDING RATES — USDT Perpetuals                                Next funding: " + countdown);
    console.log("═══════════════════════════════════════════════════════════════════════════════════════════════");
    console.log("");

    // Table header
    const hSym = pad("Symbol", 14);
    const hRate = pad("Rate", 12, true);
    const hApr = pad("APR", 10, true);
    const hPred = pad("Pred Rate", 12, true);
    const hPredApr = pad("Pred APR", 10, true);
    const hMark = pad("Mark", 12, true);

    console.log(`  ${hSym}  ${hRate}  ${hApr}  ${hPred}  ${hPredApr}  ${hMark}`);
    console.log("  " + "─".repeat(80));

    // Rows
    for (const r of filtered) {
      const sym = pad(r.symbol, 14);
      const rate = pad(fmtPct(r.fundingRate * 100), 12, true);
      const apr = pad(fmtApr(r.apr), 10, true);
      const pred = pad(fmtPct(r.predictedRate * 100), 12, true);
      const predApr = pad(fmtApr(r.predictedApr), 10, true);
      const mark = pad(`$${r.markPrice.toFixed(2)}`, 12, true);

      console.log(`  ${sym}  ${rate}  ${apr}  ${pred}  ${predApr}  ${mark}`);
    }

    console.log("");
    console.log(`  Total: ${filtered.length} symbols | Refreshing every ${INTERVAL_MS / 1000}s | Ctrl+C to exit`);

    // Sleep
    const elapsed = Date.now() - started;
    await new Promise(r => setTimeout(r, Math.max(0, INTERVAL_MS - elapsed)));
  }
}

main().catch((e) => {
  console.error(`Fatal: ${(e as Error).message}`);
  process.exit(1);
});
