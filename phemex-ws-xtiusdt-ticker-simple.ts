#!/usr/bin/env npx tsx

import process from "process";

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
const HEARTBEAT_INTERVAL = 20_000; // 20s

/* ------------------------------------------------------------------ */
/*  Columnar data helpers                                              */
/* ------------------------------------------------------------------ */

/**
 * Parse the USDT-M columnar ticker format.
 * The message looks like:
 *   {
 *     data: [ [symbol, openRp, highRp, lowRp, lastRp, volumeRq, ...] ],
 *     fields: ["symbol", "openRp", "highRp", "lowRp", "lastRp", "volumeRq", ...],
 *     method: "perp_market24h_pack_p.update",
 *     timestamp: 1666862556850547000,
 *     type: "snapshot"
 *   }
 */
function findSymbolRow(data: unknown[][], fields: string[], target: string): Record<string, unknown> | null {
  for (const row of data) {
    if (row.length < 1) continue;
    if (String(row[0]) === target) {
      const obj: Record<string, unknown> = {};
      for (let i = 0; i < fields.length && i < row.length; i++) {
        obj[fields[i]] = row[i];
      }
      return obj;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Reconnecting WebSocket wrapper                                     */
/* ------------------------------------------------------------------ */

let ws: WebSocket;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let reconnectDelay = 1_000; // start at 1s
const MAX_RECONNECT_DELAY = 30_000;

// Cache the last known ticker values so we can do incremental updates
let lastPrint = "";
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

  if (last !== lastPrice) {
    // process.stdout.write(`\r\x1b[K`);
    process.stdout.write(line);
    console.log() ;
    lastPrice = last;
  }
}

function connect(): void {
  ws = new WebSocket(WS_URL);

  ws.addEventListener("open", () => {
    reconnectDelay = 1_000; // reset backoff on successful connection

    // Subscribe to all USDT-M 24h tickers (columnar format)
    ws.send(JSON.stringify({ method: "perp_market24h_pack_p.subscribe", params: [], id: 1 }));

    // Also subscribe to real-time trades for XTIUSDT
    ws.send(JSON.stringify({ method: "trade_p.subscribe", params: [SYMBOL], id: 2 }));

    // Start heartbeat
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      ws.send(JSON.stringify({ method: "server.ping", params: [], id: Date.now() }));
    }, HEARTBEAT_INTERVAL);
  });

  ws.addEventListener("message", (event: MessageEvent) => {
    const msg = JSON.parse(event.data as string);

    // Pong — heartbeat response
    if (msg.result === "pong") {
      return;
    }

    if (msg.error != null) {
      console.error("Subscription error:", msg.error);
      return;
    }

    // Ignore subscription ack
    if (msg.result?.status === "success") return;

    // ---------------------------------------------------------------
    // USDT-M 24h ticker (columnar format)
    // ---------------------------------------------------------------
    if (msg.method === "perp_market24h_pack_p.update" && Array.isArray(msg.fields) && Array.isArray(msg.data)) {
      // console.log("perp_market24h_pack_p");
      const ticker = findSymbolRow(msg.data, msg.fields, SYMBOL);
      if (ticker) {
        printTicker(SYMBOL, ticker);
      }
      return;
    }

    // ---------------------------------------------------------------
    // USDT-M trade channel — real-time trade price
    // ---------------------------------------------------------------
    if (msg.trades_p && msg.symbol === SYMBOL) {
      // console.log("trade_p");
      // trades_p is an array of [timestampNs, side, priceRp, qtyRq]
      const trades = msg.trades_p as unknown[][];
      if (trades.length > 0 && trades[0].length >= 3) {
        const last = Number(trades[0][2]);
        const now = new Date().toLocaleString();
        const line = `${now}  ${SYMBOL}  $${last.toFixed(2)}`;
        if (last !== lastPrice) {
          // process.stdout.write(`\r\x1b[K`);
          process.stdout.write(line);
          console.log();
          lastPrice = last;
        }
      }
    }
  });

  ws.addEventListener("close", () => {
    stopHeartbeat();
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    /* error event is always followed by close, so reconnect handles it */
  });
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
}

function scheduleReconnect(): void {
  if (reconnectTimer) return; // already scheduled
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    // Print a newline so the reconnect message doesn't merge with the ticker line
    process.stdout.write("\n");
    console.log(`⟐  Reconnecting in ${reconnectDelay / 1000}s …`);
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

/*  Graceful shutdown on Ctrl+C                                        */

process.on("SIGINT", () => {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  stopHeartbeat();
  ws?.close();
  process.stdout.write("\n");
  process.exit(0);
});

/*  Start                                                              */

console.log(`⟐  Connecting to ${WS_URL} (USDT-M) …`);
connect();