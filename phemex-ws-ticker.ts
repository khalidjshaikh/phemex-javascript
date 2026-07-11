#!/usr/bin/env npx tsx

/**
 * Phemex WebSocket Ticker — subscribes to the BTCUSD 24h ticker channel and
 * prints a compact ticker line every time the price updates (~1s intervals).
 *
 * Output format:
 *   [time]  BTCUSD  $XX,XXX.XX  H: $XX,XXX  L: $XX,XXX  Chg: ±X.XX%  Vol: XXXX
 *
 * Auto-reconnects on disconnect with exponential backoff (1s → 30s max).
 * Sends a heartbeat (server.ping) every 20s.
 *
 * Usage:  ./phemex-ws-ticker.ts
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

function connect(): void {
  ws = new WebSocket(WS_URL);

  ws.addEventListener("open", () => {
    reconnectDelay = 1_000; // reset backoff on successful connection

    // Subscribe to the 24h ticker channel (~1s updates)
    ws.send(JSON.stringify({ method: "market24h.subscribe", params: [], id: 1 }));

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

    // 24h ticker channel — updated every ~1s
    if (msg.market24h?.symbol === SYMBOL) {
      const ticker = msg.market24h;
      const close = ticker.close / PRICE_SCALE;
      const high = ticker.high / PRICE_SCALE;
      const low = ticker.low / PRICE_SCALE;
      const open = ticker.open / PRICE_SCALE;
      const volume = ticker.volume; // in contracts (USD)
      const changePct = open > 0 ? ((close - open) / open) * 100 : 0;

      const now = new Date().toLocaleString();
      const sign = changePct >= 0 ? "+" : "";
      const priceStr = `$${close.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      const highStr = `H: $${high.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
      const lowStr = `L: $${low.toLocaleString(undefined, { minimumFractionDigits: 2 })}`;
      const chgStr = `Chg: ${sign}${changePct.toFixed(2)}%`;
      const volStr = `Vol: ${Number(volume).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

      // Clear line and redraw
      process.stdout.write(`\r\x1b[K`);
      process.stdout.write(`${now}  ${SYMBOL}  ${priceStr}  ${highStr}  ${lowStr}  ${chgStr}  ${volStr}`);
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

console.log(`⟐  Connecting to ${WS_URL} …`);
connect();