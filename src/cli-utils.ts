// SPDX-License-Identifier: MIT
/**
 * cli-utils.ts — Shared CLI argument parsing helpers.
 *
 * Usage:
 *   import { getArg, hasFlag } from "./src/cli-utils.js";
 */

/** Get the value of a named CLI argument (e.g. --symbol BTCUSD → "BTCUSD") */
export function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

/** Check whether a flag is present in the CLI args (e.g. --dry-run) */
export function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

/**
 * Parse a row of columnar data into a record using a fields array.
 * Used for the USDT-M columnar ticker format.
 */
export function findSymbolRow(
  data: unknown[][],
  fields: string[],
  target: string,
): Record<string, unknown> | null {
  for (const row of data) {
    if (row.length < 1) continue;
    if (String(row[0]) === target) {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < fields.length && i < row.length; i++) {
        obj[fields[i]] = row[i];
      }
      return obj;
    }
  }
  return null;
}

/** Determine the Phemex API path based on symbol suffix (USDT → USDT-M, else Coin-M) */
export function apiPath(symbol: string, suffix: string = ""): string {
  const base = symbol.endsWith("USDT") ? "/g-orders" : "/orders";
  return base + suffix;
}