#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * place-limit-order.ts — Place a limit order on Phemex programmatically.
 *
 * Library extracted from phemex-create-limit-order.ts, providing a reusable
 * API for placing limit orders across all account types (spot, USDT-M, Coin-M).
 *
 * Usage:
 *   import { placeLimitOrder } from "./place-limit-order.js";
 *   const result = await placeLimitOrder({ ... }, apiKey, secretRaw);
 *
 * For testing, inject a mock HTTP request function:
 *   const result = await placeLimitOrder({ ... }, apiKey, secretRaw, mockRequest);
 */

import https from "node:https";
import crypto from "node:crypto";
import { Credentials } from "./credentials.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface PlaceLimitOrderParams {
  /** Account type: spot, usdt-m, or coin-m */
  account: "spot" | "usdt-m" | "coin-m";
  /** Trading pair (e.g. BTCUSDT, BTCUSD) */
  symbol: string;
  /** Order direction */
  side: "Buy" | "Sell";
  /** Limit price in quote currency */
  price: number;
  /** Quantity (base currency for spot, contract qty for perpetual) */
  qty: number;
  /** Position side for usdt-m only (default: Merged) */
  posSide?: string;
  /** Time in force (default: GoodTillCancel) */
  timeInForce?: string;
  /** Leverage for perpetual accounts (optional) */
  leverage?: number;
  /** Take-profit trigger price (usdt-m only, optional) */
  takeProfit?: number;
  /** Stop-loss trigger price (usdt-m only, optional) */
  stopLoss?: number;
}

export interface PlaceOrderResult {
  orderID?: string;
  clOrdID?: string;
  ordStatus?: string;
  symbol?: string;
  side?: string;
  price?: unknown;
  qty?: unknown;
  [key: string]: unknown;
}

export interface ProductInfo {
  priceScale: number;
  valueScale: number;
  ratioScale: number;
  settleCurrency: string;
  contractSize: number;
}

/** HTTP request function signature — injectable for testing */
export type HttpRequest = (
  method: "GET" | "PUT" | "POST",
  path: string,
  query: string | null,
  apiKey: string,
  secretRaw: Buffer,
  body: string,
) => Promise<Record<string, unknown>>;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Decode a base64url-encoded string to a Buffer. */
export function base64UrlDecode(s: string): Buffer {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

/**
 * Sign per Phemex spec: HMAC-SHA256(path + queryString + expiry + body).
 * Returns the hex-encoded signature.
 */
export function sign(
  _method: string,
  path: string,
  query: string | null,
  expiry: number,
  secretRaw: Buffer,
  body: string,
): string {
  const queryStr = query ?? "";
  const payload = path + queryStr + expiry + body;
  return crypto.createHmac("sha256", secretRaw).update(payload).digest("hex");
}

/** Perform one signed HTTP request (GET, PUT or POST) to the Phemex API. */
export function request(
  method: "GET" | "PUT" | "POST",
  path: string,
  query: string | null,
  apiKey: string,
  secretRaw: Buffer,
  body: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const expiry = Math.floor(Date.now() / 1000) + 60;
    const sig = sign(method, path, query, expiry, secretRaw, body);
    const qs = query ? "?" + query : "";
    const req = https.request(
      {
        hostname: "api.phemex.com",
        path: path + qs,
        method,
        headers: {
          "x-phemex-access-token": apiKey,
          "x-phemex-request-expiry": String(expiry),
          "x-phemex-request-signature": sig,
          "Content-Type": "application/json",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed);
          } catch {
            reject(new Error(`Bad JSON: ${data.slice(0, 200)}`));
          }
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Generate a v4 UUID for clOrdID. */
export function uuid(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/** Fetch product info for an inverse (Coin-M) symbol. */
export async function fetchProductInfo(
  symbol: string,
  apiKey: string,
  secretRaw: Buffer,
  httpRequest?: HttpRequest,
): Promise<ProductInfo | null> {
  const _request = httpRequest ?? request;
  const resp = (await _request(
    "GET",
    "/public/products",
    null,
    apiKey,
    secretRaw,
    "",
  )) as Record<string, unknown>;

  if (resp.code !== 0) return null;
  const data = resp.data as Record<string, unknown> | undefined;

  const products = (data?.products as Record<string, unknown>[]) ?? [];
  const allProducts = products.length > 0 ? products : (Array.isArray(data) ? data : []);
  const perpProducts = (data?.perpProductsV2 as Record<string, unknown>[]) ?? [];

  const candidates = [
    ...allProducts,
    ...perpProducts,
    ...(data?.perpProductsV1 as Record<string, unknown>[] | undefined ?? []),
  ];

  for (const p of candidates) {
    if (String(p.symbol) === symbol) {
      return {
        priceScale: 10 ** Number(p.priceScale || 1),
        valueScale: 10 ** Number(p.valueScale || 1),
        ratioScale: 10 ** Number(p.ratioScale || 1),
        settleCurrency: String(p.settleCurrency ?? ""),
        contractSize: Number(p.contractSize) || 1,
      };
    }
  }

  // Fallback: default BTCUSD values
  if (symbol === "BTCUSD") {
    return { priceScale: 10000, valueScale: 100_000_000, ratioScale: 100_000_000, settleCurrency: "BTC", contractSize: 1 };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Order placement by account type                                    */
/* ------------------------------------------------------------------ */

/**
 * Place a spot limit order.
 * @internal — use placeLimitOrder() instead.
 */
export async function placeSpot(
  params: PlaceLimitOrderParams,
  apiKey: string,
  secretRaw: Buffer,
  httpRequest?: HttpRequest,
): Promise<PlaceOrderResult> {
  const _request = httpRequest ?? request;
  const spotSymbol = "s" + params.symbol;
  const priceEp = Math.round(params.price * 1e8);
  const baseQtyEv = Math.round(params.qty * 1e8);
  const clOrdID = uuid();
  const timeInForce = params.timeInForce ?? "GoodTillCancel";

  const body = JSON.stringify({
    symbol: spotSymbol,
    clOrdID,
    side: params.side,
    ordType: "Limit",
    timeInForce,
    priceEp,
    baseQtyEv,
    qtyType: "ByBase",
  });

  const resp = (await _request(
    "POST",
    "/spot/orders",
    null,
    apiKey,
    secretRaw,
    body,
  )) as Record<string, unknown>;

  if (resp.code !== 0) throw new Error(String(resp.msg ?? `API code ${resp.code}`));
  const data = resp.data as PlaceOrderResult | undefined;
  if (!data) throw new Error("Empty response data");
  return data;
}

/**
 * Place a USDT-M (linear) limit order.
 * @internal — use placeLimitOrder() instead.
 */
export async function placeLinear(
  params: PlaceLimitOrderParams,
  apiKey: string,
  secretRaw: Buffer,
  httpRequest?: HttpRequest,
): Promise<PlaceOrderResult> {
  const _request = httpRequest ?? request;
  const clOrdID = uuid();
  const posSide = params.posSide ?? "Merged";
  const timeInForce = params.timeInForce ?? "GoodTillCancel";

  const paramsList: string[] = [
    `symbol=${params.symbol}`,
    `side=${params.side}`,
    `posSide=${posSide}`,
    `ordType=Limit`,
    `timeInForce=${timeInForce}`,
    `priceRp=${params.price}`,
    `orderQtyRq=${params.qty}`,
    `clOrdID=${clOrdID}`,
  ];
  if (params.takeProfit !== undefined) {
    paramsList.push(`takeProfitRp=${params.takeProfit}`);
  }
  if (params.stopLoss !== undefined) {
    paramsList.push(`stopLossRp=${params.stopLoss}`);
  }
  const query = paramsList.join("&");

  const resp = (await _request(
    "PUT",
    "/g-orders/create",
    query,
    apiKey,
    secretRaw,
    "",
  )) as Record<string, unknown>;

  if (resp.code !== 0) throw new Error(String(resp.msg ?? `API code ${resp.code}`));
  const data = resp.data as PlaceOrderResult | undefined;
  if (!data) throw new Error("Empty response data");
  return data;
}

/**
 * Place a Coin-M (inverse) limit order.
 * @internal — use placeLimitOrder() instead.
 */
export async function placeInverse(
  params: PlaceLimitOrderParams,
  apiKey: string,
  secretRaw: Buffer,
  httpRequest?: HttpRequest,
): Promise<PlaceOrderResult> {
  const _request = httpRequest ?? request;

  // Fetch product info for scaling
  const product = await fetchProductInfo(params.symbol, apiKey, secretRaw, httpRequest);
  if (!product) {
    throw new Error(`Could not fetch product info for ${params.symbol}`);
  }

  const priceEp = Math.round(params.price * product.priceScale);
  const orderQty = Math.round(params.qty);
  const clOrdID = uuid();
  const timeInForce = params.timeInForce ?? "GoodTillCancel";

  const query = [
    `symbol=${params.symbol}`,
    `side=${params.side}`,
    `ordType=Limit`,
    `timeInForce=${timeInForce}`,
    `priceEp=${priceEp}`,
    `orderQty=${orderQty}`,
    `clOrdID=${clOrdID}`,
  ].join("&");

  const resp = (await _request(
    "PUT",
    "/orders/create",
    query,
    apiKey,
    secretRaw,
    "",
  )) as Record<string, unknown>;

  if (resp.code !== 0) throw new Error(String(resp.msg ?? `API code ${resp.code}`));
  const data = resp.data as PlaceOrderResult | undefined;
  if (!data) throw new Error("Empty response data");
  return data;
}

/* ------------------------------------------------------------------ */
/*  Main API                                                           */
/* ------------------------------------------------------------------ */

/**
 * Place a limit order on Phemex.
 *
 * This is the main entry point — it automatically selects the correct
 * placement logic based on the account type.
 *
 * @param params      Order parameters (account, symbol, side, price, qty, …)
 * @param apiKey      Phemex API key
 * @param secretRaw   Phemex API secret (decoded via base64UrlDecode)
 * @param httpRequest Optional injectable HTTP request function (for testing)
 * @returns           The order placement result from the API
 */
export async function placeLimitOrder(
  params: PlaceLimitOrderParams,
  apiKey: string,
  secretRaw: Buffer,
  httpRequest?: HttpRequest,
): Promise<PlaceOrderResult> {
  switch (params.account) {
    case "spot":
      return placeSpot(params, apiKey, secretRaw, httpRequest);
    case "usdt-m":
      return placeLinear(params, apiKey, secretRaw, httpRequest);
    case "coin-m":
      return placeInverse(params, apiKey, secretRaw, httpRequest);
    default:
      throw new Error(`Unknown account type: ${params.account}`);
  }
}