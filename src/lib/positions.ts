// SPDX-License-Identifier: MIT

import { base64UrlDecode, httpGet } from "../http-client.js";
import { placeMarketOrder, setLeverageUsdtM } from "../place-limit-order.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface Position {
  symbol: string;
  side: "Buy" | "Sell" | "None";
  size: string;
  avgEntryPrice: string;
  avgEntryPriceRp: string;
  markPriceRp: string;
  posCostRv: string;
  leverageRr: string;
  unrealisedPnl?: string;
  [key: string]: unknown;
}

export interface PositionsResponse {
  code: number;
  msg?: string;
  data?: {
    account?: Record<string, unknown>;
    positions?: Position[];
  };
}

/* ------------------------------------------------------------------ */
/*  API — fetch USDT-M positions                                      */
/* ------------------------------------------------------------------ */

/**
 * Fetch all USDT-M positions, returning only open positions
 * (side !== "None" and size !== "0").
 */
export async function fetchPositions(
  apiKey: string,
  secretRaw: Buffer,
): Promise<Position[]> {
  const resp = (await httpGet(
    "/g-accounts/accountPositions",
    "currency=USDT",
    apiKey,
    secretRaw,
  )) as unknown as PositionsResponse;

  if (resp.code !== 0) {
    console.error(`[${new Date().toLocaleString()}]  ✗  API error: ${resp.msg ?? resp.code}`);
    return [];
  }
  const positions = resp.data?.positions ?? [];
  return positions.filter((p) => p.side !== "None" && p.size !== "0");
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Calculate the unrealized PnL as a percentage of the position margin.
 *
 * The Phemex API returns Rv (valueRt) fields already in USDT (human-readable).
 * No scaling by 10000 is needed.
 *
 * margin  = posCostRv         (USDT)
 * pnl     = (markPriceRp - avgEntryPriceRp) * size
 * pnlPct  = pnl / margin * 100
 */
export function calcPnlPct(pos: Position): number {
  const size = parseFloat(pos.size || "0");
  const entry = parseFloat(pos.avgEntryPriceRp || "0");
  const mark = parseFloat(pos.markPriceRp || "0");
  const margin = parseFloat(pos.posCostRv || "0");

  if (margin <= 0) return 0;

  // Unrealized PnL: (mark - entry) * size for longs; (entry - mark) * size for shorts
  const pnl = pos.side === "Buy"
    ? (mark - entry) * size
    : (entry - mark) * size;

  return (pnl / margin) * 100;
}

/**
 * Close a position via market order.
 */
export async function closePosition(
  pos: Position,
  apiKey: string,
  secretRaw: Buffer,
): Promise<void> {
  const closeSide = pos.side === "Buy" ? "Sell" : "Buy";
  const closePosSide = pos.side === "Buy" ? "Long" : "Short";
  const size = parseFloat(pos.size || "0");

  console.log(`[${new Date().toLocaleString()}]  ⟐  Closing ${pos.symbol} (${pos.side} → ${closeSide})  qty: ${size} …`);
  await placeMarketOrder(
    {
      account: "usdt-m",
      symbol: pos.symbol,
      side: closeSide,
      qty: size,
      posSide: closePosSide,
      price: 0,
    },
    apiKey,
    secretRaw,
  );
  console.log(`[${new Date().toLocaleString()}]  ✓  Position closed`);
}

/**
 * Open a long position on a USDT-M symbol at the given quantity and leverage.
 */
export async function openLong(
  symbol: string,
  qty: number,
  leverage: number,
  apiKey: string,
  secretRaw: Buffer,
): Promise<void> {
  console.log(`[${new Date().toLocaleString()}]  ⟐  Opening long ${symbol}  qty: ${qty} …`);

  // Set leverage first
  await setLeverageUsdtM(symbol, leverage, "Long", apiKey, secretRaw);

  // Place market order
  await placeMarketOrder(
    {
      account: "usdt-m",
      symbol,
      side: "Buy",
      qty,
      posSide: "Long",
      price: 0,
    },
    apiKey,
    secretRaw,
  );
  console.log(`[${new Date().toLocaleString()}]  ✓  Long position opened`);
}
