#!/usr/bin/env npx tsx

/**
 * Phemex WebSocket Price — subscribes to the BTCUSD 24h ticker and tick
 * channels, printing the last price to stdout on each update.
 *
 * Auto-reconnects on disconnect with exponential backoff (1s → 30s max).
 * Sends a heartbeat (server.ping) every 20s and prints the pong to stdout.
 *
 * Usage:  ./phemex-ws-price.ts
 */

const WS_URL = "wss://ws.phemex.com";
const SYMBOL = "BTCUSD";
const PRICE_SCALE = 10_000;
const HEARTBEAT_INTERVAL = 20_000; // 20s

/* ------------------------------------------------------------------ */
/*  Reconnecting WebSocket wrapper                                     */
/* ------------------------------------------------------------------ */

let ws: WebSocket;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
let reconnectDelay = 1_000; // start at 1s
const MAX_RECONNECT_DELAY = 30_000;
let lastPrintedPrice: number | undefined;

function logPriceIfChanged(price: number): void {
  if (lastPrintedPrice === undefined || price !== lastPrintedPrice) {
    const now = new Date().toLocaleString();
    process.stdout.write(`\n${now}  ${price.toFixed(2)} `);
    lastPrintedPrice = price;
  }
}

function connect(): void {
  ws = new WebSocket(WS_URL);

  ws.addEventListener("open", () => {
    reconnectDelay = 1_000; // reset backoff on successful connection

    // Subscribe to channels
    // ws.send(JSON.stringify({ method: "tick.subscribe", params: [SYMBOL], id: 1 }));
    ws.send(JSON.stringify({ method: "market24h.subscribe", params: [], id: 2 }));

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
      process.stdout.write("♥");
      return;
    }

    if (msg.error != null) {
      console.error("Subscription error:", msg.error);
      return;
    }

    // Ignore subscription ack
    if (msg.result?.status === "success") return;

    // Tick channel — real-time trade price
    if (msg.tick) {
      const { last: lastEp } = msg.tick;
      const price = lastEp / PRICE_SCALE;
      logPriceIfChanged(price);
      return;
    }

    // 24h ticker channel — updates every 1s
    if (msg.market24h?.symbol === SYMBOL) {
      const { close: lastEp } = msg.market24h;
      const price = lastEp / PRICE_SCALE;
      logPriceIfChanged(price);
      // console.log(msg.market24h);
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
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
}

/* ------------------------------------------------------------------ */
/*  Graceful shutdown on Ctrl+C                                        */
/* ------------------------------------------------------------------ */

process.on("SIGINT", () => {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  stopHeartbeat();
  ws?.close();
  process.exit(0);
});

/* ------------------------------------------------------------------ */
/*  Start                                                              */
/* ------------------------------------------------------------------ */

connect();
