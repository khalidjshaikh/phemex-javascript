#!/usr/bin/env npx tsx
/**
 * Tests for the PnL calculator.
 *
 * Run with: npx tsx src/pnl-calculator.test.ts
 */

import assert from "node:assert/strict";
import { calculatePnL } from "./pnl-calculator.js";

/* ------------------------------------------------------------------ */
/*  Test 1: Short XTIUSDT (Sell)                                       */
/*  From: npx tsx phemex-create-limit-order.ts \                       */
/*          --account usdt-m --symbol XTIUSDT --side Sell              */
/*          --price 75.00 --qty 0.01 --takeProfit 69.00               */
/*          --stopLoss 76.00 --posSide Short                           */
/* ------------------------------------------------------------------ */
{
  const result = calculatePnL({
    side: "Sell",
    price: 75.0,
    qty: 0.01,
    takeProfit: 69.0,
    stopLoss: 76.0,
  });

  assert.equal(result.side, "Sell");
  assert.equal(result.positionType, "Short");
  assert.equal(result.entryPrice, 75.0);
  assert.equal(result.qty, 0.01);
  assert.equal(result.takeProfitPrice, 69.0);
  assert.equal(result.stopLossPrice, 76.0);

  // Short: TP PnL = qty * (entry - TP) = 0.01 * (75 - 69) = +0.06
  const expectedTpPnl = 0.01 * (75.0 - 69.0);
  assert.equal(
    result.takeProfitPnl,
    expectedTpPnl,
    `Short TP PnL should be ${expectedTpPnl}`
  );

  // Short: SL PnL = qty * (entry - SL) = 0.01 * (75 - 76) = -0.01
  const expectedSlPnl = 0.01 * (75.0 - 76.0);
  assert.equal(
    result.stopLossPnl,
    expectedSlPnl,
    `Short SL PnL should be ${expectedSlPnl}`
  );

  console.log("✓  Test 1 — Short XTIUSDT: PASSED");
}

/* ------------------------------------------------------------------ */
/*  Test 2: Long XTIUSDT (Buy)                                         */
/*  From: npx tsx phemex-create-limit-order.ts \                       */
/*          --account usdt-m --symbol XTIUSDT --side Buy               */
/*          --price 73.50 --qty 0.01 --takeProfit 80.00               */
/*          --stopLoss 73.00 --posSide Long                            */
/* ------------------------------------------------------------------ */
{
  const result = calculatePnL({
    side: "Buy",
    price: 73.5,
    qty: 0.01,
    takeProfit: 80.0,
    stopLoss: 73.0,
  });

  assert.equal(result.side, "Buy");
  assert.equal(result.positionType, "Long");
  assert.equal(result.entryPrice, 73.5);
  assert.equal(result.qty, 0.01);
  assert.equal(result.takeProfitPrice, 80.0);
  assert.equal(result.stopLossPrice, 73.0);

  // Long: TP PnL = qty * (TP - entry) = 0.01 * (80 - 73.5) = +0.065
  const expectedTpPnl = 0.01 * (80.0 - 73.5);
  assert.equal(
    result.takeProfitPnl,
    expectedTpPnl,
    `Long TP PnL should be ${expectedTpPnl}`
  );

  // Long: SL PnL = qty * (SL - entry) = 0.01 * (73 - 73.5) = -0.005
  const expectedSlPnl = 0.01 * (73.0 - 73.5);
  assert.equal(
    result.stopLossPnl,
    expectedSlPnl,
    `Long SL PnL should be ${expectedSlPnl}`
  );

  console.log("✓  Test 2 — Long XTIUSDT: PASSED");
}

/* ------------------------------------------------------------------ */
/*  Summary                                                             */
/* ------------------------------------------------------------------ */
console.log("\n🎉  All tests passed!");
