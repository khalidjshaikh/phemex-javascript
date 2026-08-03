#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-mark-price.ts  —  Get the mark price for a symbol on Phemex.
 *
 * Supports two modes:
 *   REST  — one-shot GET /md/v2/ticker/24hr (default)
 *   WS    — continuous WebSocket subscription for real-time updates
 *
 * Usage:
 *   ./phemex-mark-price.ts                          # REST, XBRUSDT
 *   ./phemex-mark-price.ts --symbol BTCUSDT         # REST, BTCUSDT
 *   ./phemex-mark-price.ts --ws                     # WebSocket, XBRUSDT
 *   ./phemex-mark-price.ts --ws --symbol ETHUSDT    # WebSocket, ETHUSDT
 *   ./phemex-mark-price.ts --help                   # Show help
 */

import { readFileSync, writeFileSync } from "node:fs";
import { publicGet } from "../src/http-client.js";
import { ReconnectingWs } from "../src/ws-client.js";
import { getArg, hasFlag } from "../src/cli-utils.js";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const DEFAULT_SYMBOL = "XBRUSDT";
const WS_URL = "wss://ws.phemex.com";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** Response shape for GET /md/v2/ticker/24hr (v2 market data endpoint). */
interface TickerV2Response {
  error?: { code?: number; message?: string } | null;
  id?: number;
  result?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function usage(): never {
  console.log(`
Usage: ./phemex-mark-price.ts [options]

Get the mark price for a perpetual symbol on Phemex.

Options:
  --symbol <pair>   Trading pair (default: ${DEFAULT_SYMBOL})
  --ws              Use WebSocket for continuous real-time updates
  --help, -h        Show this help message

Examples:
  ./phemex-mark-price.ts                         # REST, XBRUSDT
  ./phemex-mark-price.ts --ws                    # WebSocket, XBRUSDT
  ./phemex-mark-price.ts --symbol ETHUSDT        # REST, ETHUSDT
  ./phemex-mark-price.ts --ws --symbol BTCUSDT   # WebSocket, BTCUSDT
`);
  process.exit(0);
}

/** Format a ticker result row and print to stdout as one horizontal line. */
async function printTicker(symbol: string, ticker: Record<string, unknown>): Promise<void> {
  const mark    = parseFloat(String(ticker.markPriceRp ?? 0));
  const index   = parseFloat(String(ticker.indexPriceRp ?? 0));
  const last    = parseFloat(String(ticker.closeRp ?? 0));

  const now = new Date().toLocaleString();
  const markLast = mark - last;
  const mlSign = markLast >= 0 ? "+" : "";
  const indexLast = index - last;
  const ilSign = indexLast >= 0 ? "+" : "";

  writeFileSync("markLast.txt", `${markLast.toFixed(2)}\n`);
  writeFileSync("indexLast.txt", `${indexLast.toFixed(2)}\n`);

  console.log(
    `${now}  ${symbol}  ` +
    `Index: $${index.toFixed(2)}  ` +
    `Mark: $${mark.toFixed(2)}  ` +
    `Last: $${last.toFixed(2)}  ` +
    `Index−Last: ${ilSign}$${indexLast.toFixed(2)}  ` +
    `Mark−Last: ${mlSign}$${markLast.toFixed(2)}`,
  );

  // SMS alert disabled: was firing when mark/index deviate from last by more
  // than 10 cents (see git history to restore).
}

/* ------------------------------------------------------------------ */
/*  REST mode — one-shot GET /md/v2/ticker/24hr                       */
/* ------------------------------------------------------------------ */

async function restMode(symbol: string): Promise<void> {
  console.error(`⟐  Fetching /md/v2/ticker/24hr for ${symbol} …`);

  const resp = (await publicGet(
    "/md/v2/ticker/24hr",
    `symbol=${symbol}`,
  )) as unknown as TickerV2Response;

  if (resp.error) {
    const msg = resp.error.message ?? String(resp.error.code ?? "unknown error");
    console.error(`✗  API error: ${msg}`);
    process.exit(1);
  }

  const data = resp.result;
  if (!data || Object.keys(data).length === 0) {
    console.error(`✗  No data returned for symbol "${symbol}"`);
    process.exit(1);
  }

  await printTicker(symbol, data);
}

/* ------------------------------------------------------------------ */
/*  WS mode — continuous WebSocket subscription                       */
/* ------------------------------------------------------------------ */

function wsMode(symbol: string): void {
  console.error(`⟐  Connecting to ${WS_URL} (${symbol}) …`);

  const ws = new ReconnectingWs(WS_URL, {
    onOpen: () => {
      // Subscribe using the USDT-M perpetual ticker channel
      ws.send({ method: "market24h_p.subscribe", params: [symbol], id: 1 });
    },
    onMessage: (msg) => {
      const m = msg as Record<string, unknown>;

      // Columnar format (perp_market24h_pack_p.update)
      if (m.method === "perp_market24h_pack_p.update" && Array.isArray(m.fields) && Array.isArray(m.data)) {
        const ticker = findSymbolRow(m.data as unknown[][], m.fields as string[], symbol);
        if (ticker) {
          void printTicker(symbol, ticker);
        }
        return;
      }

      // Single-symbol format (market24h_p.update)
      if (m.market24h_p) {
        const ticker = m.market24h_p as Record<string, unknown>;
        if (String(ticker.symbol) === symbol) {
          void printTicker(symbol, ticker);
        }
        return;
      }
    },
    onReconnect: (delayMs) => {
      console.error(`\n⟐  Reconnecting in ${delayMs / 1000}s …`);
    },
  });

  ws.connect();
}

/** Parse a columnar ticker row into a record. */
function findSymbolRow(
  data: unknown[][],
  fields: string[],
  target: string,
): Record<string, unknown> | null {
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
/*  Main                                                              */
/* ------------------------------------------------------------------ */

function main(): void {
  if (hasFlag("--help") || hasFlag("-h")) usage();

  const symbol = getArg("--symbol") ?? DEFAULT_SYMBOL;
  const useWs = hasFlag("--ws");

  if (useWs) {
    wsMode(symbol);
  } else {
    restMode(symbol).catch((err) => {
      console.error("✗", err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
  }
}

main();
