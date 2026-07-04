#!/usr/bin/env npx tsx

/**
 * Phemex WebSocket Price — subscribes to the BTCUSD 24h ticker and tick
 * channels, printing the last price to stdout on each update.
 *
 * The 24h ticker pushes every 1s (always has data). The tick channel
 * pushes on each trade (real-time but possibly infrequent on weekends).
 *
 * Usage:  npx tsx phemex-ws-price.ts
 */

const WS_URL = "wss://ws.phemex.com";
const SYMBOL = "BTCUSD";

/** Price scale for BTCUSD (from /public/products). */
const PRICE_SCALE = 10_000;

function main(): void {
  const ws = new WebSocket(WS_URL);

  ws.addEventListener("open", () => {
    // Subscribe to both channels
    ws.send(
      JSON.stringify({ method: "tick.subscribe", params: [SYMBOL], id: 1 })
    );
    ws.send(
      JSON.stringify({ method: "market24h.subscribe", params: [], id: 2 })
    );
  });

  ws.addEventListener("message", (event: MessageEvent) => {
    const msg = JSON.parse(event.data as string);

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
      const now = new Date().toLocaleString();
      console.log(`${now}  ${price.toFixed(2)}`);
      return;
    }

    // 24h ticker channel — updates every 1s
    if (msg.market24h?.symbol === SYMBOL) {
      const { close: lastEp } = msg.market24h;
      const price = lastEp / PRICE_SCALE;
      const now = new Date().toLocaleString();
      console.log(`${now}  ${price.toFixed(2)}`);
    }
  });

  ws.addEventListener("error", () => {
    /* keep alive — connection logs on stderr not needed */
  });
}

main();
