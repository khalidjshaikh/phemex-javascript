#!/usr/bin/env npx tsx

import { execFileSync } from "child_process";
import fs from "node:fs";
import path from "node:path";
import { loadCredentials } from "./src/credentials.js";
import { base64UrlDecode } from "./src/http-client.js";
import { uuid } from "./src/uuid.js";
import { findSymbolRow } from "./src/cli-utils.js";
import { ReconnectingWs } from "./src/ws-client.js";
import { placeLinear, setLeverageUsdtM } from "./src/place-limit-order.js";

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

async function placeOrderLinear(symbol: string, side: string, price: number, qty: number, leverage: number): Promise<PlaceOrderResult | null> {
  try {
    // Map position-side terminology ("Long"/"Short") to API order side ("Buy"/"Sell")
    const apiSide = side === "Long" ? "Buy" : side === "Short" ? "Sell" : side;

    // Set leverage before placing the order
    await setLeverageUsdtM(symbol, leverage, side, creds.PHEMEX_API_KEY, secretRaw);

    const por = await placeLinear(
      {
        account: "usdt-m",
        symbol,
        side: apiSide as "Buy" | "Sell",
        price,
        qty,
        posSide: side,
        leverage,
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
    // lastPrint = line;
    lastPrice = last;
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

          {
            const symbol = "XTIUSDT";
            const side = "Long";
            const price = Number((last - .75).toFixed(2));
            const qty = 0.01;
            const leverage = 100;
            const result = await placeOrderLinear(symbol, side, price, qty, leverage);
            if (result) {
              // console.log(`Order result (${symbol} ${side}):`, JSON.stringify(result));
            }
          }

          if (false) {
            const symbol = "XTIUSDT";
            const side = "Short";
            const price = Number((last + 5).toFixed(2));
            const qty = 0.01;
            const leverage = 100;
            const result = await placeOrderLinear(symbol, side, price, qty, leverage);
            if (result) {
              // console.log(`Order result (${symbol} ${side}):`, JSON.stringify(result));
            }
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