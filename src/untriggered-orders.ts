// SPDX-License-Identifier: MIT
/**
 * untriggered-orders.ts — Phemex API helpers for listing untriggered
 * trigger orders (orders placed with a trigger price that have not yet
 * been triggered into the market).
 *
 * Endpoint:  GET /orders/activeList?ordStatus=Untriggered&symbol=<symbol>
 *            GET /g-orders/activeList?ordStatus=Untriggered&symbol=<symbol>  (USDT-M)
 *
 * Usage:
 *   import { fetchUntriggeredOrders, ApiError } from "./untriggered-orders.js";
 *
 *   const orders = await fetchUntriggeredOrders(symbol, apiKey, secretRaw);
 */

import { request, type HttpRequest } from "./http-client.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** Error returned by the Phemex API for a non-successful response code. */
export class ApiError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

/** A single untriggered order row, normalized across USDT-M and Coin-M fields. */
export interface UntriggeredOrder {
  /** Phemex order ID (orderID) */
  orderID: string;
  /** "Buy" | "Sell" */
  side: string;
  /** Contract quantity (orderQtyRq for USDT-M, orderQty for Coin-M) */
  qty: string;
  /** Trigger/stop price (stopPxRp for USDT-M, stopPx for Coin-M) */
  stopPx: string;
  /** Limit price (priceRp for USDT-M, price for Coin-M) */
  price: string;
  /** Order type name ("Stop", "Limit", …); normalized from the API's numeric
   *  ordType code (USDT-M) or string (Coin-M) */
  ordType: string;
  /** The raw API row, in case callers need additional fields */
  raw: Record<string, unknown>;
}

/** Map USDT-M numeric ordType codes to the string names (same codes as
 *  /exchange/order/v2/orderList). String values pass through unchanged. */
const ORD_TYPE_NAMES: Record<number, string> = {
  1: "Market",
  2: "Limit",
  3: "Stop",
  4: "StopLimit",
  5: "MarketIfTouched",
  6: "LimitIfTouched",
};

/** Normalize an ordType value (numeric code or string) to its name. */
export function normalizeOrdType(value: unknown): string {
  if (typeof value === "number") return ORD_TYPE_NAMES[value] ?? String(value);
  if (typeof value === "string" && value !== "" && !/^\d+$/.test(value)) return value;
  const n = typeof value === "string" ? Number(value) : NaN;
  return Number.isInteger(n) && n in ORD_TYPE_NAMES ? ORD_TYPE_NAMES[n] : String(value ?? "");
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * Active-list endpoint for a symbol: USDT-M symbols use /g-orders,
 * everything else (Coin-M) uses /orders.
 */
export function untriggeredEndpoint(symbol: string): string {
  return symbol.toUpperCase().endsWith("USDT") ? "/g-orders/activeList" : "/orders/activeList";
}

/** Query string for listing untriggered trigger orders of a symbol. */
export function untriggeredQuery(symbol: string): string {
  return `ordStatus=Untriggered&symbol=${symbol}`;
}

/* ------------------------------------------------------------------ */
/*  API                                                                */
/* ------------------------------------------------------------------ */

/**
 * List untriggered trigger orders for a symbol.
 *
 * Throws {@link ApiError} when the API reports a non-successful code
 * (other than 10002 / "OM_ORDER_NOT_FOUND", which means no orders exist
 * and is treated as an empty result).
 *
 * @param symbol      Trading pair (e.g. XBRUSDT, BTCUSD, XTIUSDT)
 * @param apiKey      Phemex API key
 * @param secretRaw   Decoded Phemex API secret (Buffer)
 * @param httpRequest Injectable transport, for tests (defaults to `request`)
 */
export async function fetchUntriggeredOrders(
  symbol: string,
  apiKey: string,
  secretRaw: Buffer,
  httpRequest?: HttpRequest,
): Promise<UntriggeredOrder[]> {
  const _request = httpRequest ?? request;
  const resp = await _request("GET", untriggeredEndpoint(symbol), untriggeredQuery(symbol), apiKey, secretRaw, "");
  // console.dir(resp, { depth: null, colors: true }); 

  // code 10002 / "OM_ORDER_NOT_FOUND" means no orders — not an error
  if (resp.code !== 0 && resp.code !== 10002) {
    throw new ApiError(Number(resp.code ?? -1), String(resp.msg ?? resp.code ?? "unknown error"));
  }

  const data = resp.data as Record<string, unknown> | undefined;
  const rows = (data?.rows as Record<string, unknown>[] | undefined) ?? [];

  return rows.map((o) => ({
    orderID: String(o.orderID ?? ""),
    side: String(o.side ?? ""),
    // USDT-M uses orderQtyRq/priceRp/stopPxRp, Coin-M uses orderQty/price/stopPx
    qty: String(o.orderQtyRq ?? o.orderQty ?? ""),
    stopPx: String(o.stopPxRp ?? o.stopPx ?? ""),
    price: String(o.priceRp ?? o.price ?? ""),
    // USDT-M activeList rows carry the type as the string `orderType`
    // (e.g. "Stop"); Coin-M carries the numeric code `ordType`.
    ordType: normalizeOrdType(o.ordType ?? o.orderType),
    raw: o,
  }));
}
