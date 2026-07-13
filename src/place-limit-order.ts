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

import { Credentials } from "./credentials.js";
import { request, sign, base64UrlDecode, HttpRequest, HttpMethod } from "./http-client.js";
import { uuid } from "./uuid.js";

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
  /** Limit price in quote currency (ignored for market orders) */
  price: number;
  /** Quantity (base currency for spot, contract qty for perpetual) */
  qty: number;
  /** Position side for usdt-m only (default: Merged) */
  posSide?: string;
  /** Time in force (default: GoodTillCancel for limit, ImmediateOrCancel for market) */
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

export interface CancelOrderParams {
  symbol: string;
  orderId: string;
  posSide?: string;
}

export interface CancelOrdersParams {
  symbol: string;
  /** Also cancel untriggered trigger orders (default: true) */
  untriggered?: boolean;
}

export interface ProductInfo {
  priceScale: number;
  valueScale: number;
  ratioScale: number;
  settleCurrency: string;
  contractSize: number;
}

/** HTTP request function signature — injectable for testing */
export type { HttpRequest };

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Re-exported from http-client for backward compatibility */
export { base64UrlDecode, sign, request };

/** Re-exported from uuid for backward compatibility */
export { uuid };

/** Fetch product info for an inverse (Coin-M) symbol. */
export async function cancelOrder(
  params: CancelOrderParams,
  apiKey: string,
  secretRaw: Buffer,
  httpRequest?: HttpRequest,
): Promise<Record<string, unknown>> {
  const _request = httpRequest ?? request;
  const qp = new URLSearchParams();
  qp.set("orderID", params.orderId);
  qp.set("symbol", params.symbol);
  if (params.posSide) qp.set("posSide", params.posSide);
  const query = qp.toString();
  const urlPath = params.symbol.endsWith("USDT") ? "/g-orders" : "/orders";

  return _request("DELETE", urlPath, query, apiKey, secretRaw, "") as Promise<Record<string, unknown>>;
}

/** Cancel ALL open orders (including untriggered) for a given symbol. */
export async function cancelOrders(
  params: CancelOrdersParams,
  apiKey: string,
  secretRaw: Buffer,
): Promise<Record<string, unknown>> {
  const urlPath = params.symbol.endsWith("USDT") ? "/g-orders/all" : "/orders/all";
  const untriggered = params.untriggered ?? true;
  const query = `symbol=${params.symbol}&untriggered=${untriggered}`;
  return request("DELETE", urlPath, query, apiKey, secretRaw, "");
}

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
  if ((params.takeProfit !== undefined) && (params.takeProfit > 0)) {
    paramsList.push(`takeProfitRp=${params.takeProfit}`);
  }
  if ((params.stopLoss !== undefined) && (params.stopLoss > 0)) {
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
/*  Leverage                                                            */
/* ------------------------------------------------------------------ */

/**
 * Set cross-margin leverage for a USDT-M perpetual symbol.
 *
 * The Phemex API expects negative values for cross-margin.
 * For the "Merged" (one-way) position mode, only leverageRr is sent.
 * For "Long"/"Short" (hedge) mode, both longLeverageRr and shortLeverageRr are sent.
 *
 * @param symbol    Trading pair (e.g. XTIUSDT)
 * @param leverage  Leverage (positive value; negated internally for API)
 * @param posSide   Position side: "Merged", "Long", or "Short"
 * @param apiKey    Phemex API key
 * @param secretRaw Decoded API secret
 */
export async function setLeverageUsdtM(
  symbol: string,
  leverage: number,
  posSide: string,
  apiKey: string,
  secretRaw: Buffer,
): Promise<void> {
  const apiLeverage = leverage > 0 ? -leverage : 0;

  let qs: string;
  if (posSide === "Merged") {
    qs = `symbol=${symbol}&leverageRr=${apiLeverage}`;
  } else {
    qs = `symbol=${symbol}&longLeverageRr=${apiLeverage}&shortLeverageRr=${apiLeverage}`;
  }

  const res = await request("PUT", "/g-positions/leverage", qs, apiKey, secretRaw, "");
  if (res.code !== 0) {
    const msg = String(res.msg ?? res.code);
    if (msg.includes("INCONSISTENT_POS_MODE")) {
      throw new Error(
        `Leverage API error: ${msg} — the account position mode may not support this endpoint. ` +
        `Try setting leverage via the Phemex web UI for this account.`,
      );
    }
    throw new Error(`Leverage API error: ${msg}`);
  }
}

/**
 * Set cross-margin leverage for a Coin-M (inverse) perpetual symbol.
 *
 * The Phemex API expects negative values for cross-margin.
 * Fetches product info to determine the correct ratioScale.
 *
 * @param symbol    Trading pair (e.g. BTCUSD)
 * @param leverage  Leverage (positive value; negated internally for API)
 * @param apiKey    Phemex API key
 * @param secretRaw Decoded API secret
 */
export async function setLeverageCoinM(
  symbol: string,
  leverage: number,
  apiKey: string,
  secretRaw: Buffer,
): Promise<void> {
  const apiLeverage = leverage > 0 ? -leverage : 0;

  // Fetch product info for ratioScale
  const resp = (await request(
    "GET",
    "/public/products",
    null,
    apiKey,
    secretRaw,
    "",
  )) as Record<string, unknown>;

  let ratioScale = 100_000_000; // default fallback
  if (resp.code === 0) {
    const data = resp.data as Record<string, unknown> | undefined;
    const candidates = [
      ...((data?.products as Record<string, unknown>[]) ?? []),
      ...((data?.perpProductsV2 as Record<string, unknown>[]) ?? []),
      ...((data?.perpProductsV1 as Record<string, unknown>[]) ?? []),
    ];
    const product = candidates.find((p) => String(p.symbol) === symbol);
    if (product) {
      ratioScale = 10 ** Number(product.ratioScale || 8);
    }
  }

  const leverageEr = Math.round(apiLeverage * ratioScale);
  const qs = `symbol=${symbol}&leverageEr=${leverageEr}`;
  const res = await request("PUT", "/positions/leverage", qs, apiKey, secretRaw, "");
  if (res.code !== 0) {
    throw new Error(`Leverage API error: ${res.msg ?? res.code}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Market order placement                                             */
/* ------------------------------------------------------------------ */

/**
 * Place a USDT-M (linear) market order.
 * Optionally includes take-profit and stop-loss trigger prices.
 * @internal — use placeMarketOrder() instead.
 */
export async function placeMarketLinear(
  params: PlaceLimitOrderParams,
  apiKey: string,
  secretRaw: Buffer,
  httpRequest?: HttpRequest,
): Promise<PlaceOrderResult> {
  const _request = httpRequest ?? request;
  const clOrdID = uuid();
  const posSide = params.posSide ?? "Merged";
  const timeInForce = params.timeInForce ?? "ImmediateOrCancel";

  const paramsList: string[] = [
    `symbol=${params.symbol}`,
    `side=${params.side}`,
    `posSide=${posSide}`,
    `ordType=Market`,
    `timeInForce=${timeInForce}`,
    `orderQtyRq=${params.qty}`,
    `clOrdID=${clOrdID}`,
  ];
  if ((params.takeProfit !== undefined) && (params.takeProfit > 0)) {
    paramsList.push(`takeProfitRp=${params.takeProfit}`);
  }
  if ((params.stopLoss !== undefined) && (params.stopLoss > 0)) {
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
 * Place a Coin-M (inverse) market order.
 * @internal — use placeMarketOrder() instead.
 */
export async function placeMarketInverse(
  params: PlaceLimitOrderParams,
  apiKey: string,
  secretRaw: Buffer,
  httpRequest?: HttpRequest,
): Promise<PlaceOrderResult> {
  const _request = httpRequest ?? request;
  const clOrdID = uuid();
  const timeInForce = params.timeInForce ?? "ImmediateOrCancel";
  const orderQty = Math.round(params.qty);

  const query = [
    `symbol=${params.symbol}`,
    `side=${params.side}`,
    `ordType=Market`,
    `timeInForce=${timeInForce}`,
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

/**
 * Place a market order on Phemex.
 *
 * Automatically selects the correct placement logic based on the account type.
 * For USDT-M, you can optionally include take-profit and stop-loss trigger prices.
 *
 * @param params      Order parameters (account, symbol, side, qty, …)
 *                    The `price` field is ignored for market orders.
 * @param apiKey      Phemex API key
 * @param secretRaw   Phemex API secret (decoded via base64UrlDecode)
 * @param httpRequest Optional injectable HTTP request function (for testing)
 * @returns           The order placement result from the API
 */
export async function placeMarketOrder(
  params: PlaceLimitOrderParams,
  apiKey: string,
  secretRaw: Buffer,
  httpRequest?: HttpRequest,
): Promise<PlaceOrderResult> {
  switch (params.account) {
    case "usdt-m":
      return placeMarketLinear(params, apiKey, secretRaw, httpRequest);
    case "coin-m":
      return placeMarketInverse(params, apiKey, secretRaw, httpRequest);
    default:
      throw new Error(`Market orders not supported for account type: ${params.account}`);
  }
}