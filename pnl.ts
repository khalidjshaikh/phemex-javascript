#!/usr/bin/env npx tsx
import { calculatePnL } from "./src/pnl-calculator.js";                                                                                              

calculatePnL({
  side: "Buy",
  price: 75.0,
  qty: 1,
  takeProfit: 76.0,
  stopLoss: 75.0,
});
calculatePnL({
  side: "Buy",
  price: 75.00,
  qty: 273,
  takeProfit: 110,
  stopLoss: 75
});
