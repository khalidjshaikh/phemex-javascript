#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-market-order.ts  —  Place a market order on Phemex.
 *
 * Supports all account types (USDT-M, Coin-M) with optional TP/SL for USDT-M.
 *
 * Usage:
 *   ./phemex-market-order.ts --account usdt-m --symbol XTIUSDT --side Short --qty 0.01 --leverage 100 --posSide Short
 *   ./phemex-market-order.ts --account usdt-m --symbol XTIUSDT --side Long  --qty 0.01 --leverage 100 --takeProfit 80 --stopLoss 73
 *   ./phemex-market-order.ts --account coin-m --symbol BTCUSD  --side Long  --qty 1    --leverage 100
 *   ./phemex-market-order.ts --account usdt-m --symbol XTIUSDT --side Long  --qty 0.01 --dry-run
 */

import { base64UrlDecode } from "./src/http-client.js";
import { getArg, hasFlag } from "./src/cli-utils.js";
import { loadCredentialsLocal } from "./src/credentials.js";
import { placeMarketOrder, setLeverageUsdtM, setLeverageCoinM } from "./src/place-limit-order.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function usage(): never {
  console.log(`
Usage: ./phemex-market-order.ts --account <type> --symbol <pair> --side <Long|Short> --qty <num> [options]

Place a market order on Phemex.

Required:
  --account <type>    Account type: usdt-m | coin-m
  --symbol <pair>     Trading pair (e.g. XTIUSDT, BTCUSD)
  --side <Long|Short> Order direction
  --qty <num>         Contract quantity

Optional:
  --leverage <num>    Leverage (default: 100)
  --posSide <Side>    Position side for usdt-m: Merged | Long | Short (default: Short for Sell, Long for Buy)
  --takeProfit <num>  Take-profit trigger price (usdt-m only)
  --stopLoss <num>    Stop-loss trigger price (usdt-m only)
  --dry-run           Show what would be sent without executing
  --help, -h          Show this help message

Examples:
  ./phemex-market-order.ts --account usdt-m --symbol XTIUSDT --side Short --qty 0.01 --leverage 100
  ./phemex-market-order.ts --account usdt-m --symbol XTIUSDT --side Long  --qty 0.01 --leverage 100 --takeProfit 80 --stopLoss 73
  ./phemex-market-order.ts --account coin-m --symbol BTCUSD  --side Long  --qty 1    --leverage 100
`);
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) usage();

  const account = getArg("--account") as "usdt-m" | "coin-m" | undefined;
  const symbol = getArg("--symbol");
  const sideRaw = getArg("--side");
  const qtyRaw = getArg("--qty");
  const leverageRaw = getArg("--leverage");
  const posSideRaw = getArg("--posSide");
  const takeProfitRaw = getArg("--takeProfit");
  const stopLossRaw = getArg("--stopLoss");
  const dryRun = hasFlag("--dry-run");

  if (!account || !symbol || !sideRaw || !qtyRaw) usage();

  const side = sideRaw.toLowerCase() === "long" ? "Buy" : "Sell";
  const phemexSide = sideRaw.charAt(0).toUpperCase() + sideRaw.slice(1).toLowerCase();
  const qty = parseFloat(qtyRaw);
  const leverage = leverageRaw ? parseInt(leverageRaw, 10) : 100;
  const posSide = posSideRaw ?? (side === "Buy" ? "Long" : "Short");
  const takeProfit = takeProfitRaw ? parseFloat(takeProfitRaw) : undefined;
  const stopLoss = stopLossRaw ? parseFloat(stopLossRaw) : undefined;

  if (isNaN(qty) || qty <= 0) {
    console.error("✗  --qty must be a positive number");
    process.exit(1);
  }

  const creds = loadCredentialsLocal();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  console.log(`⟐  Market ${phemexSide} ${symbol} on ${account}  qty: ${qty}  leverage: ${leverage}x`);
  if (takeProfit) console.log(`   Take-profit: ${takeProfit}`);
  if (stopLoss) console.log(`   Stop-loss:   ${stopLoss}`);

  if (dryRun) {
    const params = [
      `symbol=${symbol}`,
      `side=${side}`,
      `posSide=${posSide}`,
      `ordType=Market`,
      `orderQtyRq=${qty}`,
    ];
    if (takeProfit) params.push(`takeProfitRp=${takeProfit}`);
    if (stopLoss) params.push(`stopLossRp=${stopLoss}`);
    console.log(`\n  DRY RUN — Would send:\n`);
    console.log(`  PUT /g-orders/create`);
    console.log(`  ${params.join("&")}`);
    console.log();
    process.exit(0);
  }

  // Set leverage first
  if (account === "usdt-m") {
    await setLeverageUsdtM(symbol, leverage, posSide, creds.PHEMEX_API_KEY, secretRaw);
  } else {
    await setLeverageCoinM(symbol, leverage, creds.PHEMEX_API_KEY, secretRaw);
  }

  // Place market order
  const result = await placeMarketOrder(
    { account, symbol, side, price: 0, qty, posSide, takeProfit, stopLoss },
    creds.PHEMEX_API_KEY,
    secretRaw,
  );

  const ordID = result.orderID ?? result.clOrdID ?? "—";
  const status = result.ordStatus ?? "—";
  const price = result.price ?? "—";
  const leavesQty = result.leavesQty ?? "0";

  console.log(`   ✓  Order placed`);
  console.log(`      OrderID:  ${String(ordID)}`);
  console.log(`      Side:     ${String(result.side ?? side)}`);
  console.log(`      Price:    ${String(price)}`);
  console.log(`      Status:   ${String(status)}`);
  console.log(`      leavesQty: ${String(leavesQty)}`);
}

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : String(err));
  process.exit(1);
});