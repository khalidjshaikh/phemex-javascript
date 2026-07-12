#!/usr/bin/env npx tsx
/**
 * PnL Calculator — given trade parameters, compute the P&L at take-profit
 * and stop-loss prices for both long (Buy) and short (Sell) positions.
 *
 * P&L formulas:
 *   Long  (Buy):  TP PnL = qty × (takeProfit − price)
 *                  SL PnL = qty × (stopLoss   − price)
 *   Short (Sell): TP PnL = qty × (price − takeProfit)
 *                  SL PnL = qty × (price − stopLoss)
 */

export interface PnLInput {
  /** Order side: "Buy" (long) or "Sell" (short) */
  side: "Buy" | "Sell";
  /** Entry price in quote currency */
  price: number;
  /** Quantity / contract size */
  qty: number;
  /** Take-profit trigger price */
  takeProfit: number;
  /** Stop-loss trigger price */
  stopLoss: number;
}

export interface PnLResult {
  side: string;
  positionType: "Long" | "Short";
  entryPrice: number;
  qty: number;
  takeProfitPrice: number;
  stopLossPrice: number;
  /** P&L at the take-profit price (positive = profit, negative = loss) */
  takeProfitPnl: number;
  /** P&L at the stop-loss price (positive = profit, negative = loss) */
  stopLossPnl: number;
}

/**
 * Calculate P&L at take-profit and stop-loss for a given trade.
 * Returns a PnLResult and prints a human-readable summary.
 */
export function calculatePnL(input: PnLInput): PnLResult {
  const { side, price, qty, takeProfit, stopLoss } = input;

  const positionType: "Long" | "Short" = side === "Buy" ? "Long" : "Short";

  let takeProfitPnl: number;
  let stopLossPnl: number;

  if (side === "Buy") {
    // Long: profit when price goes up
    takeProfitPnl = qty * (takeProfit - price);
    stopLossPnl = qty * (stopLoss - price);
  } else {
    // Short: profit when price goes down
    takeProfitPnl = qty * (price - takeProfit);
    stopLossPnl = qty * (price - stopLoss);
  }

  const result: PnLResult = {
    side,
    positionType,
    entryPrice: price,
    qty,
    takeProfitPrice: takeProfit,
    stopLossPrice: stopLoss,
    takeProfitPnl,
    stopLossPnl,
  };

  // Human-readable summary
  console.log("─".repeat(50));
  console.log(`  Position : ${positionType} ${qty} @ ${price}`);
  console.log(`  Take-Profit @ ${takeProfit}  →  P&L: ${takeProfitPnl >= 0 ? "+" : ""}${takeProfitPnl.toFixed(4)}`);
  console.log(`  Stop-Loss   @ ${stopLoss}    →  P&L: ${stopLossPnl >= 0 ? "+" : ""}${stopLossPnl.toFixed(4)}`);
  console.log("─".repeat(50));

  return result;
}
