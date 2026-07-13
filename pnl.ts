#!/usr/bin/env npx tsx
import { calculatePnL } from "./src/pnl-calculator.js";                                                                                              

calculatePnL({
  side: "Sell",
  price: 75.0,
  qty: 0.01,
  takeProfit: 69.0,
  stopLoss: 76.0,
});
calculatePnL({
  side: "Buy",
  price: 73.5,
  qty: 0.01,
  takeProfit: 80.0,
  stopLoss: 73.0,
});
calculatePnL({
  side: "Buy",
  price: 73.95,
  qty: 0.01,
  takeProfit: 120.0,
  stopLoss: 73.0,
});
calculatePnL({
  side: "Buy",
  price: 73.95,
  qty: 27.0,
  takeProfit: 120.0,
  stopLoss: 73.0,
});
calculatePnL({
  side: "Sell",
  price: 75.0,
  qty: 0.01,
  takeProfit: 69.0,
  stopLoss: 76.0,
});
calculatePnL({
  side: "Sell",
  price: 73.96,
  qty: 0.01,
  takeProfit: 73.0,
  stopLoss: 74.0,
});
calculatePnL({
  side: "Sell",
  price: 73.94,
  qty: 0.01,
  takeProfit: 73.92,
  stopLoss: 73.96,
});
calculatePnL({
  side: "Buy",
  price: 73.00,
  qty: 273,
  takeProfit: 110,
});