#!/usr/bin/env npx tsx

/**
 * Phemex Ticker Recorder — subscribes to the BTCUSD tick channel and appends
 * every tick to a CSV file in the same format as btc-usd-max-trimmed.csv:
 *
 *   event_date,close_price_usd
 *
 * Usage:  ./phemex-record-ticker.ts [output.csv]
 *
 * If no filename is given, defaults to btc-usd-max-trimmed.csv.
 * Aborting (Ctrl+C / SIGINT) cannot lose data because every write is a
 * synchronous appendFileSync call — the signal handler won't fire until the
 * current write completes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { ReconnectingWs } from "./src/ws-client.js";

const WS_URL = "wss://ws.phemex.com";
const SYMBOL = "BTCUSD";
const PRICE_SCALE = 10_000;

/* ------------------------------------------------------------------ */
/*  Output file                                                        */
/* ------------------------------------------------------------------ */

const outFile = path.resolve(process.argv[2] ?? "btc-usd-max-trimmed.csv");

// Create file with header row if it doesn't exist yet
if (!fs.existsSync(outFile)) {
  fs.writeFileSync(outFile, "event_date,close_price_usd\n");
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Convert a Phemex tick timestamp (nanoseconds since epoch) to the CSV date
 * format used in btc-usd-max-trimmed.csv, e.g. "2026-07-04 23:59:59 UTC".
 */
function tickTsToCsvDate(tsNs: number): string {
  const ms = Math.floor(tsNs / 1_000_000);
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const s = String(d.getUTCSeconds()).padStart(2, "0");
  return `${y}-${mo}-${day} ${h}:${mi}:${s} UTC`;
}

/** Write one CSV row synchronously — safe against signal interruption. */
function appendRow(dateStr: string, priceUsd: number): void {
  const line = `${dateStr},${priceUsd.toFixed(2)}\n`;
  fs.appendFileSync(outFile, line, "utf-8");
}

/* ------------------------------------------------------------------ */
/*  Main                                                              */
/* ------------------------------------------------------------------ */

let lastWrittenPrice: number | undefined;

const ws = new ReconnectingWs(WS_URL, {
  onOpen: () => {
    // Subscribe to the real-time tick channel
    ws.send({ method: "tick.subscribe", params: [SYMBOL], id: 1 });

    // Also subscribe to the 24h ticker as a backup source of last price
    ws.send({ method: "market24h.subscribe", params: [], id: 2 });
  },
  onMessage: (msg) => {
    const m = msg as Record<string, unknown>;

    // Pong — heartbeat response
    if (m.result === "pong") {
      process.stdout.write("♥");
      return;
    }

    if (m.error != null) {
      console.error("Subscription error:", m.error);
      return;
    }

    // ---------------------------------------------------------------
    // Tick channel — real-time trade price (fires on every trade)
    // ---------------------------------------------------------------
    if (m.tick) {
      const tick = m.tick as Record<string, unknown>;
      const lastEp = Number(tick.last);
      const tsNs = Number(tick.timestamp);
      const price = lastEp / PRICE_SCALE;
      if (price !== lastWrittenPrice) {
        const dateStr = tickTsToCsvDate(tsNs);
        appendRow(dateStr, price);
        lastWrittenPrice = price;
        process.stdout.write(".");
      }
      return;
    }

    // ---------------------------------------------------------------
    // 24h ticker channel — fallback; updates every ~1s
    // ---------------------------------------------------------------
    const ticker = m.market24h as Record<string, unknown> | undefined;
    if (ticker?.symbol === SYMBOL) {
      const lastEp = Number(ticker.close);
      const price = lastEp / PRICE_SCALE;
      if (price !== lastWrittenPrice) {
        const dateStr = new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z/, " UTC");
        appendRow(dateStr, price);
        lastWrittenPrice = price;
        process.stdout.write(",");
      }
    }
  },
});

console.log(`Recording ticker data → ${outFile}`);
ws.connect();
