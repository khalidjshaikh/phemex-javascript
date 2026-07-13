#!/usr/bin/env npx tsx

import { execFileSync } from "child_process";
import fs from "node:fs";
import path from "node:path";
import { loadCredentials } from "./src/credentials.js";
import { base64UrlDecode } from "./src/http-client.js";
import { uuid } from "./src/uuid.js";
import { findSymbolRow } from "./src/cli-utils.js";
import { ReconnectingWs } from "./src/ws-client.js";
import { calculatePnL } from "./src/pnl-calculator.js";
import { placeLimitOrder, setLeverageUsdtM } from "./src/place-limit-order.js";

/**
 * Phemex WebSocket XTIUSDT Ticker — subscribes to the XTIUSDT 24h ticker
 * channel on the USDT-M perpetual endpoint and prints a compact ticker line
 * every time the price updates (~1s intervals).
 *
 * Uses the USDT-M-specific WebSocket subscription methods:
 *   - perp_market24h_pack_p.subscribe  (24h ticker for all USDT-M symbols)
 *   - trade_p.subscribe                (real-time trade prices)
 *
 * Prices are in real-value (Rp) format — no EP scaling needed.
 *
 * Output format:
 *   [time]  XTIUSDT  $XX.XX  H: $XX.XX  L: $XX.XX  Chg: ±X.XX%  Vol: XXXX
 *
 * Auto-reconnects on disconnect with exponential backoff (1s → 30s max).
 * Sends a heartbeat (server.ping) every 20s.
 *
 * Usage:  ./phemex-ws-xti-ticker.ts
 */

const WS_URL = "wss://ws.phemex.com";
const SYMBOL = "XTIUSDT";
const ORDER_HISTORY_FILE = path.resolve(process.cwd(), ".phemex-order-history.json");

const creds = loadCredentials(import.meta.dirname);
const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

interface PlaceOrderResult {
  orderID?: string;
  clOrdID?: string;
  ordStatus?: string;
  symbol?: string;
  side?: string;
  price?: unknown;
  qty?: unknown;
  [key: string]: unknown;
}

interface OrderHistoryEntry {
  orderID?: string;
  symbol?: string;
  side?: string;
}

interface TradePlan {
  symbol: string;
  side: "Long" | "Short";
  entryPrice: number;
  qty: number;
  leverage: number;
  change: number;
  takeProfit: number;
  stopLoss: number;
}

interface DeltaOrder {
  price: number;
  takeProfit: number;
  stopLoss: number;
}

let deltaOrder: DeltaOrder = {
  price: 0.75,
  takeProfit: 1.50,
  stopLoss: 0.50
}

let orderHistory: OrderHistoryEntry[] = [];

function loadOrderHistory(): OrderHistoryEntry[] {
  if (!fs.existsSync(ORDER_HISTORY_FILE)) {
    return [];
  }

  try {
    const raw = fs.readFileSync(ORDER_HISTORY_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((entry): entry is OrderHistoryEntry => {
        if (!entry || typeof entry !== "object") return false;
        const candidate = entry as Record<string, unknown>;
        return typeof candidate.orderID === "string" || typeof candidate.symbol === "string" || typeof candidate.side === "string";
      });
    }
  } catch (error) {
    console.warn(`Unable to read order history from disk:`, error instanceof Error ? error.message : String(error));
  }

  return [];
}

function saveOrderHistory(): void {
  fs.writeFileSync(ORDER_HISTORY_FILE, JSON.stringify(orderHistory, null, 2));
}

function appendOrderHistory(por: PlaceOrderResult): void {
  const entry: OrderHistoryEntry = {
    orderID: typeof por.orderID === "string" ? por.orderID : undefined,
    symbol: typeof por.symbol === "string" ? por.symbol : undefined,
    side: typeof por.side === "string" ? por.side : undefined,
  };

  if (!entry.orderID && !entry.symbol && !entry.side) {
    return;
  }

  orderHistory.push(entry);
  saveOrderHistory();
}

function cancelOrdersFromHistory(): void {
  if (orderHistory.length === 0) {
    return;
  }

  console.log(`Cancelling ${orderHistory.length} saved order(s) from history...`);

  for (let i = orderHistory.length - 1; i >= 0; i -= 1) {
    const entry = orderHistory[i];
    if (!entry.orderID || !entry.symbol) {
      orderHistory.splice(i, 1);
      continue;
    }

    const scriptPath = path.resolve(process.cwd(), "phemex-cancel-order.ts");
    const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
    const posSide = entry.side === "Buy" ? "Long" : entry.side === "Sell" ? "Short" : entry.side;
    const args = [
      "tsx",
      scriptPath,
      "--order-id",
      entry.orderID,
      "--symbol",
      entry.symbol,
      "--pos-side",
      posSide ?? "",
    ];

    try {
      const output = execFileSync(npxCommand, args, {
        cwd: process.cwd(),
        encoding: "utf8",
      }).trim();
      if (output) {
        console.log(output);
      }
      orderHistory.splice(i, 1);
      saveOrderHistory();
    } catch (error) {
      console.error(`Failed to cancel ${entry.orderID} for ${entry.symbol}:`, error instanceof Error ? error.message : String(error));
    }
  }
}

function buildTradePlan(
  symbol: string,
  side: "Long" | "Short",
  entryPrice: number,
  qty: number,
  leverage: number,
  marketPrice: number,
): TradePlan {
  let takeProfit = side === "Long" ? Number((entryPrice + deltaOrder.takeProfit).toFixed(2)) : Number((entryPrice - deltaOrder.takeProfit).toFixed(2));
  let stopLoss = side === "Long" ? Number((entryPrice - deltaOrder.stopLoss).toFixed(2)) : Number((entryPrice + deltaOrder.stopLoss).toFixed(2));
  
  if(deltaOrder.takeProfit == 0) takeProfit = 0;
  if(deltaOrder.stopLoss == 0) stopLoss = 0;

  return {
    symbol,
    side,
    entryPrice,
    qty,
    leverage,
    change: Number((entryPrice - marketPrice).toFixed(2)),
    takeProfit,
    stopLoss,
  };
}

async function placeLimitOrderWithTpSl(
  symbol: string,
  side: string,
  price: number,
  qty: number,
  leverage: number,
  takeProfit: number,
  stopLoss: number,
): Promise<PlaceOrderResult | null> {
  try {
    const apiSide = side === "Long" ? "Buy" : side === "Short" ? "Sell" : side;

    await setLeverageUsdtM(symbol, leverage, side, creds.PHEMEX_API_KEY, secretRaw);

    const por = await placeLimitOrder(
      {
        account: "usdt-m",
        symbol,
        side: apiSide as "Buy" | "Sell",
        price,
        qty,
        posSide: side,
        leverage,
        takeProfit,
        stopLoss,
      },
      creds.PHEMEX_API_KEY,
      secretRaw,
    );
    appendOrderHistory(por);
    return por;
  } catch (error) {
    console.error(`Order placement failed for ${symbol} ${side}:`, error instanceof Error ? error.message : String(error));
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Ticker display                                                     */
/* ------------------------------------------------------------------ */

let lastPrice = 0;

function printTicker(symbol: string, ticker: Record<string, unknown>): void {
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

  const line = `${now}  ${symbol}  ${priceStr}  ${highStr}  ${lowStr}  ${chgStr}  ${volStr}`;

  // if (line !== lastPrint) {
  if (last !== lastPrice) {
    // process.stdout.write(`\r\x1b[K`);
    process.stdout.write(line);
    console.log() ;
    // lastPrice = last;
  }
}

/* ------------------------------------------------------------------ */
/*  Main                                                              */
/* ------------------------------------------------------------------ */

const ws = new ReconnectingWs(WS_URL, {
  onOpen: () => {
    // Subscribe to all USDT-M 24h tickers (columnar format)
    ws.send({ method: "perp_market24h_pack_p.subscribe", params: [], id: 1 });

    // Also subscribe to real-time trades for XTIUSDT
    ws.send({ method: "trade_p.subscribe", params: [SYMBOL], id: 2 });
  },
  onMessage: async (msg) => {
    const m = msg as Record<string, unknown>;

    // ---------------------------------------------------------------
    // USDT-M 24h ticker (columnar format)
    // ---------------------------------------------------------------
    if (m.method === "perp_market24h_pack_p.update" && Array.isArray(m.fields) && Array.isArray(m.data)) {
      const ticker = findSymbolRow(m.data as unknown[][], m.fields as string[], SYMBOL);
      if (ticker) {
        printTicker(SYMBOL, ticker);
      }
      return;
    }

    // ---------------------------------------------------------------
    // USDT-M trade channel — real-time trade price
    // ---------------------------------------------------------------
    if (m.trades_p && m.symbol === SYMBOL) {
      const trades = m.trades_p as unknown[][];
      if (trades.length > 0 && trades[0].length >= 3) {
        const last = Number(trades[0][2]);
        const now = new Date().toLocaleString();
        const line = `${now}  ${SYMBOL}  $${last.toFixed(2)}`;
        if (last !== lastPrice) {
          process.stdout.write(line);
          console.log();
          cancelOrdersFromHistory();

          let flag = true
          if(flag) {
            flag = false;
            deltaOrder = {
              price: 2,
              takeProfit: 0.00,
              stopLoss: 0.00
            }
          }

          if(true) {
            const symbol = "XTIUSDT";
            const side = "Long";
            const entryPrice = Number((last - deltaOrder.price).toFixed(2));
            const qty = 0.01;
            const leverage = 100;
            const plan = buildTradePlan(symbol, side, entryPrice, qty, leverage, last);

            calculatePnL({
              side: "Buy",
              price: plan.entryPrice,
              qty: plan.qty,
              takeProfit: plan.takeProfit == 0 ? plan.entryPrice : plan.takeProfit,
              stopLoss: plan.stopLoss == 0 ? plan.entryPrice : plan.stopLoss,
            });

            await placeLimitOrderWithTpSl(
              plan.symbol,
              plan.side,
              plan.entryPrice,
              plan.qty,
              plan.leverage,
              plan.takeProfit,
              plan.stopLoss,
            );

          }

          if(false) {
            const symbol = "XTIUSDT";
            const side = "Short";
            const entryPrice = Number((last + deltaOrder.price).toFixed(2));
            const qty = 0.01;
            const leverage = 100;
            const plan = buildTradePlan(symbol, side, entryPrice, qty, leverage, last);

            calculatePnL({
              side: "Sell",
              price: plan.entryPrice,
              qty: plan.qty,
              takeProfit: plan.takeProfit == 0 ? plan.entryPrice : plan.takeProfit,
              stopLoss: plan.stopLoss == 0 ? plan.entryPrice : plan.stopLoss,
            });

            await placeLimitOrderWithTpSl(
              plan.symbol,
              plan.side,
              plan.entryPrice,
              plan.qty,
              plan.leverage,
              plan.takeProfit,
              plan.stopLoss,
            );
          }

          lastPrice = last;
        }
      }
    }
  },
  onReconnect: (delayMs) => {
    process.stdout.write("\n");
    console.log(`⟐  Reconnecting in ${delayMs / 1000}s …`);
  },
});

/*  Start                                                              */

orderHistory = loadOrderHistory();
console.log(`Loaded ${orderHistory.length} saved order entries from ${path.basename(ORDER_HISTORY_FILE)}`);
cancelOrdersFromHistory();

console.log(`⟐  Connecting to ${WS_URL} (USDT-M) …`);
ws.connect();