// SPDX-License-Identifier: MIT
/**
 * mark-price.ts — WebSocket library that streams the Phemex mark price for a
 * perpetual symbol in real time.
 *
 * The mark price is parsed from each ticker update message pushed over the
 * WebSocket (channel market24h_p), so the delivered price always reflects the
 * latest message.
 *
 * Usage:
 *   import { watchMarkPrice } from "./src/mark-price.js";
 *
 *   watchMarkPrice("BTCUSDT", ({ markPrice, symbol }) => {
 *     console.log(`${symbol} mark price: $${markPrice.toFixed(2)}`);
 *   });
 */

import { ReconnectingWs } from "./ws-client.js";
import { publicGet } from "./http-client.js";

const WS_URL = "wss://ws.phemex.com";

/** A single mark-price update delivered from a WebSocket message. */
export interface MarkPriceUpdate {
  symbol: string;
  markPrice: number;
  /** Last traded price (closeRp) from the same ticker message. */
  lastPrice: number;
  /** Unix timestamp in ms when the update was received. */
  timestamp: number;
}

export interface MarkPriceOptions {
  /** Called with status messages (e.g. reconnecting). */
  onStatus?: (message: string) => void;
}

/** Handle returned by watchMarkPrice — call close() to stop the stream. */
export interface MarkPriceHandle {
  close(): void;
}

/**
 * Connect to Phemex WebSocket and stream mark-price updates for `symbol`.
 * `onUpdate` is called for every ticker message that carries a mark price.
 */
export function watchMarkPrice(
  symbol: string,
  onUpdate: (update: MarkPriceUpdate) => void,
  options: MarkPriceOptions = {},
): MarkPriceHandle {
  const ws = new ReconnectingWs(WS_URL, {
    onOpen: () => {
      // Subscribe to the USDT-M perpetual 24h ticker channel.
      ws.send({ method: "market24h_p.subscribe", params: [symbol], id: 1 });
    },
    onMessage: (msg) => {
      const prices = extractPrices(msg, symbol);
      if (prices) {
        onUpdate({ symbol, ...prices, timestamp: Date.now() });
      }
    },
    onReconnect: (delayMs) => {
      options.onStatus?.(`reconnecting in ${delayMs / 1000}s …`);
    },
  });

  ws.connect();

  return { close: () => ws.close() };
}

/* ------------------------------------------------------------------ */
/*  One-shot REST fetch                                                */
/* ------------------------------------------------------------------ */

/**
 * Fetch the current mark price for a symbol via REST
 * (GET /md/v2/ticker/24hr). Returns the latest mark price as a number.
 */
export async function fetchMarkPrice(symbol: string): Promise<number> {
  const resp = (await publicGet(
    "/md/v2/ticker/24hr",
    `symbol=${symbol}`,
  )) as unknown as {
    error?: { message?: string; code?: number } | null;
    result?: Record<string, unknown>;
  };

  if (resp.error) {
    throw new Error(resp.error.message ?? String(resp.error.code ?? "unknown error"));
  }

  const markPrice = parseRp(resp.result?.markPriceRp);
  if (markPrice === null) {
    throw new Error(`No mark price returned for symbol "${symbol}"`);
  }
  return markPrice;
}

/* ------------------------------------------------------------------ */
/*  Internal                                                            */
/* ------------------------------------------------------------------ */

/**
 * Extract the mark price (markPriceRp) and last price (closeRp) from a ticker
 * message, or null if the message carries no mark price for the target symbol.
 *
 * Handles both Phemex ticker formats:
 *   - Single-symbol object: msg.market24h_p (from market24h_p.update)
 *   - Columnar pack: msg.fields + msg.data (from perp_market24h_pack_p.update)
 */
function extractPrices(
  msg: Record<string, unknown>,
  symbol: string,
): { markPrice: number; lastPrice: number } | null {
  // Single-symbol format
  const ticker = msg.market24h_p as Record<string, unknown> | undefined;
  if (ticker && String(ticker.symbol) === symbol) {
    return pickPrices(ticker, "markPriceRp", "closeRp");
  }

  // Columnar pack format
  if (msg.method === "perp_market24h_pack_p.update" &&
      Array.isArray(msg.fields) &&
      Array.isArray(msg.data)) {
    const fields = msg.fields as string[];
    const markIdx = fields.indexOf("markPriceRp");
    const lastIdx = fields.indexOf("closeRp");
    if (markIdx < 0) return null;
    for (const row of msg.data as unknown[][]) {
      if (row.length > 0 && String(row[0]) === symbol) {
        return {
          markPrice: parseRp(row[markIdx]),
          lastPrice: lastIdx >= 0 ? parseRp(row[lastIdx]) : 0,
        };
      }
    }
  }

  return null;
}

/** Read mark/last fields from a single-symbol ticker object. */
function pickPrices(
  ticker: Record<string, unknown>,
  markField: string,
  lastField: string,
): { markPrice: number; lastPrice: number } | null {
  const markPrice = parseRp(ticker[markField]);
  if (markPrice === null) return null;
  return { markPrice, lastPrice: parseRp(ticker[lastField]) ?? 0 };
}

/** Parse a scaled markPriceRp value (string or number) to a real number. */
function parseRp(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) && value !== null && value !== "" ? n : null;
}
