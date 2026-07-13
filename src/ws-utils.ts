// SPDX-License-Identifier: MIT
/**
 * ws-utils.ts — Shared WebSocket utilities for Phemex ticker display.
 *
 * Provides:
 *   logPriceIfChanged  — Print a price line only when the price changes
 *   printTickerEp      — Format & print a Coin-M ticker (EP-scaled prices)
 *   printTickerRp      — Format & print a USDT-M ticker (Rp real-value prices)
 *
 * Usage:
 *   import { logPriceIfChanged, printTickerEp, printTickerRp } from "./src/ws-utils.js";
 */

/* ------------------------------------------------------------------ */
/*  Price change logger                                                */
/* ------------------------------------------------------------------ */

let lastPrintedPrice: number | undefined;

/**
 * Print a timestamped price line to stdout only when the price changes.
 * Useful for single-symbol price displays on WebSocket feeds.
 */
export function logPriceIfChanged(price: number): void {
  if (lastPrintedPrice === undefined || price !== lastPrintedPrice) {
    const now = new Date().toLocaleString();
    process.stdout.write(`\n${now}  ${price.toFixed(2)} `);
    lastPrintedPrice = price;
  }
}

/** Reset the cached last price (e.g. on reconnect). */
export function resetLastPrice(): void {
  lastPrintedPrice = undefined;
}

/* ------------------------------------------------------------------ */
/*  Ticker display helpers (Coin-M / EP-scaled)                        */
/* ------------------------------------------------------------------ */

/**
 * Print a formatted ticker line for a Coin-M symbol (EP-scaled fields).
 * Uses a PRICE_SCALE divisor to convert integer EP values to real prices.
 */
export function printTickerEp(
  symbol: string,
  ticker: Record<string, unknown>,
  priceScale: number,
): void {
  const open = Number(ticker.open) / priceScale;
  const high = Number(ticker.high) / priceScale;
  const low = Number(ticker.low) / priceScale;
  const close = Number(ticker.close) / priceScale;
  const volume = ticker.volume;
  const changePct = open > 0 ? ((close - open) / open) * 100 : 0;

  const now = new Date().toLocaleString();
  const sign = changePct >= 0 ? "+" : "";
  const priceStr = `$${close.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const highStr = `H: $${high.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
  const lowStr = `L: $${low.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
  const chgStr = `Chg: ${sign}${changePct.toFixed(2)}%`;
  const volStr = `Vol: ${Number(volume).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

  process.stdout.write(`\r\x1b[K`);
  process.stdout.write(`${now}  ${symbol}  ${priceStr}  ${highStr}  ${lowStr}  ${chgStr}  ${volStr}`);
}

/* ------------------------------------------------------------------ */
/*  Ticker display helpers (USDT-M / Rp real-value)                    */
/* ------------------------------------------------------------------ */

/**
 * Print a formatted ticker line for a USDT-M symbol (Rp real-value fields).
 * Prices are in "real value" format — no scaling needed.
 *
 * Returns the last price so the caller can use it for dedup.
 */
export function printTickerRp(
  symbol: string,
  ticker: Record<string, unknown>,
): number {
  const open = Number(ticker.openRp ?? 0);
  const high = Number(ticker.highRp ?? 0);
  const low = Number(ticker.lowRp ?? 0);
  const last = Number(ticker.lastRp ?? 0);
  const volume = Number(ticker.volumeRq ?? 0);
  const changePct = open > 0 ? ((last - open) / open) * 100 : 0;

  const now = new Date().toLocaleString();
  const sign = changePct >= 0 ? "+" : "";
  const priceStr = `$${last.toFixed(2)}`;
  const highStr = `H: $${high.toFixed(2)}`;
  const lowStr = `L: $${low.toFixed(2)}`;
  const chgStr = `Chg: ${sign}${changePct.toFixed(2)}%`;
  const volStr = `Vol: ${volume.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

  process.stdout.write(`${now}  ${symbol}  ${priceStr}  ${highStr}  ${lowStr}  ${chgStr}  ${volStr}`);
  console.log();

  return last;
}