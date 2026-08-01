#!/usr/bin/env npx tsx
import { calculatePnL } from "../src/pnl-calculator.js";                                                                                              

// $13 worth with 100x leverage
calculatePnL({
  side: "Buy",
  price: 83.57,
  qty: 4,
  takeProfit: 93.0,
});
calculatePnL({
  side: "Buy",
  price: 83.57,
  qty: 10,
  takeProfit: 93.0,
});
// $130
calculatePnL({
  side: "Buy",
  price: 83.57,
  qty: 40,
  takeProfit: 93.0,
});
// $1,300
calculatePnL({
  side: "Buy",
  price: 83.57,
  qty: 400,
  takeProfit: 93.0,
});
// $13,000
calculatePnL({
  side: "Buy",
  price: 83.57,
  qty: 4000,
  takeProfit: 93.0,
});
// $130,000
calculatePnL({
  side: "Buy",
  price: 83.57,
  qty: 40000,
  takeProfit: 93.0,
});
// $1,300,000
calculatePnL({
  side: "Buy",
  price: 83.57,
  qty: 400000,
  takeProfit: 93.0,
});
