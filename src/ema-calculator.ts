// SPDX-License-Identifier: MIT
/**
 * ema-calculator.ts — EMA (Exponential Moving Average) calculator.
 *
 * Usage:
 *   import { EMACalculator } from "./src/ema-calculator.js";
 *   const ema = new EMACalculator();
 *   ema.addPrice(100);
 *   console.log(ema.getEMA20());
 */

export class EMACalculator {
  private prices: number[] = [];
  private ema20: number | null = null;
  private ema50: number | null = null;
  private ema200: number | null = null;

  addPrice(price: number): void {
    this.prices.push(price);
    this.ema20 = this.computeEMA(20, this.ema20, price);
    this.ema50 = this.computeEMA(50, this.ema50, price);
    this.ema200 = this.computeEMA(200, this.ema200, price);
  }

  /** Replace the price history and recompute all EMAs (used on startup restore). */
  loadPrices(prices: number[]): void {
    this.prices = [];
    this.ema20 = null;
    this.ema50 = null;
    this.ema200 = null;
    for (const p of prices) {
      this.addPrice(p);
    }
  }

  /** Return a copy of the price history for persistence. */
  getPrices(): number[] {
    return [...this.prices];
  }

  private computeEMA(period: number, prevEMA: number | null, price: number): number {
    const len = this.prices.length;
    if (len <= period) {
      // Not enough data for EMA yet — return SMA as the running estimate
      const slice = this.prices.slice(0, len);
      return slice.reduce((a, b) => a + b, 0) / len;
    }
    // prevEMA was set to SMA(prices[0..period-1]) on the (period)th tick,
    // so this is the first real EMA step onward
    const k = 2 / (period + 1);
    return price * k + (prevEMA ?? price) * (1 - k);
  }

  getEMA20(): number | null {
    return this.prices.length >= 20 ? this.ema20 : null;
  }

  getEMA50(): number | null {
    return this.prices.length >= 50 ? this.ema50 : null;
  }

  getEMA200(): number | null {
    return this.prices.length >= 200 ? this.ema200 : null;
  }

  get count(): number {
    return this.prices.length;
  }
}