#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-create-limit-order.ts  —  Place a limit order on Phemex.
 * Credentials are read from phemex-credentials.json.
 *
 * Usage:
 *   ./phemex-create-limit-order.ts --account <type> --symbol <pair> --side <Buy|Sell>
 *                                   --price <num> --qty <num> [options]
 *
 * Examples:
 *   ./phemex-create-limit-order.ts --account spot    --symbol BTCUSDT --side Buy  --price 60000 --qty 0.001
 *   ./phemex-create-limit-order.ts --account usdt-m  --symbol BTCUSDT --side Buy  --price 60000 --qty 0.01
 *   ./phemex-create-limit-order.ts --account coin-m --symbol BTCUSD  --side Buy  --price 60000 --qty 1
 *
 * Flags:
 *   --account       Account type (required)
 *                   spot     — Spot wallet (s-prefixed symbols, scaled 10^8)
 *                   usdt-m  — USDⓈ-M perpetual (real-value strings)
 *                   coin-m  — Coin-M perpetual (scaled by product info)
 *
 *   --symbol        Trading pair (required)
 *                   Spot:    BTCUSDT, ETHUSDT, ...
 *                   USDT-M:  BTCUSDT, ETHUSDT, ...
 *                   Coin-M:  BTCUSD, ETHUSD, ...
 *
 *   --side          Order direction: Buy | Sell (required)
 *   --price         Limit price in quote currency (required)
 *   --qty           Quantity  (required)
 *                   Spot:    base currency amount  (e.g. 0.001 BTC)
 *                   USDT-M:  contract qty          (e.g. 0.01)
 *                   Coin-M:  contract count        (e.g. 1 contract = $1)
 *
 *   --posSide       Position side (usdt-m only, default: Merged)
 *                   Merged — one-way mode
 *                   Long   — hedge mode, open long
 *                   Short  — hedge mode, open short
 *
 *   --timeInForce   Time in force (default: GoodTillCancel)
 *                   GoodTillCancel | PostOnly | ImmediateOrCancel | FillOrKill
 */

import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Credentials {
  PHEMEX_API_KEY: string;
  PHEMEX_API_SECRET: string;
}

interface CliArgs {
  account: "spot" | "usdt-m" | "coin-m";
  symbol: string;
  side: "Buy" | "Sell";
  price: number;
  qty: number;
  posSide: string;
  timeInForce: string;
  leverage?: number;
}

interface ProductInfo {
  priceScale: number;
  valueScale: number;
  ratioScale: number;
  settleCurrency: string;
  contractSize: number;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function base64UrlDecode(s: string): Buffer {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

/** Sign per Phemex spec: HMAC-SHA256(path + queryString + expiry + body) */
function sign(
  _method: string,
  path: string,
  query: string | null,
  expiry: number,
  secretRaw: Buffer,
  body: string
): string {
  const queryStr = query ?? "";
  const payload = path + queryStr + expiry + body;
  return crypto.createHmac("sha256", secretRaw).update(payload).digest("hex");
}

/** Perform one signed HTTP request (GET, PUT or POST) */
function request(
  method: "GET" | "PUT" | "POST",
  path: string,
  query: string | null,
  apiKey: string,
  secretRaw: Buffer,
  body: string
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
            // If the top-level response wraps data inside a nested "data" field
            resolve(parsed);
          } catch {
            reject(new Error(`Bad JSON: ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Generate a v4 UUID for clOrdID */
function uuid(): string {
  // Use crypto.randomUUID if available (Node 19+)
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function usage(): never {
  const text = `
Usage:
  ./phemex-create-limit-order.ts --account <type> --symbol <pair> --side <Buy|Sell> --price <num> --qty <num> [options]

Examples:
  spot    Buy   30 sats at $60k     ./phemex-create-limit-order.ts --account spot      --symbol BTCUSDT --side Buy   --price 60000 --qty 1
  usdt-m  Buy   3000 sats 100x L    ./phemex-create-limit-order.ts --account usdt-m    --symbol BTCUSDT --side Buy   --price 60000 --qty 1  --leverage 100 --posSide Long
  usdt-m  Sell  3000 sats 100x S    ./phemex-create-limit-order.ts --account usdt-m    --symbol BTCUSDT --side Sell  --price 63000 --qty 1  --leverage 100 --posSide Short
  coin-m  Long   3000 sats 100x L   ./phemex-create-limit-order.ts --account coin-m    --symbol BTCUSD  --side Long  --price 6e4   --qty 1  --leverage 100
  coin-m  Short  3000 sats 100x S   ./phemex-create-limit-order.ts --account coin-m    --symbol BTCUSD  --side Short --price 6.3e4 --qty 1  --leverage 100

Required flags:
  --account    Account type
               spot     Spot wallet (symbol gets "s" prefix, price/qty scaled by 10⁸)
               usdt-m   USDⓈ-M perpetual (real-value strings, no scaling)
               coin-m   Coin-M perpetual (scaled by product info, fetched automatically)

  --symbol     Trading pair
               Spot:    BTCUSDT, ETHUSDT, ...
               USDT-M:  BTCUSDT, ETHUSDT, ...
               Coin-M:  BTCUSD, ETHUSD, ...

  --side       Order direction: Buy | Sell
  --price      Limit price in quote currency (e.g. 60000)
  --qty        Quantity
               Spot:    base currency amount (e.g. 0.001 BTC)
               USDT-M:  contract quantity (e.g. 0.01)
               Coin-M:  number of contracts (e.g. 1 contract = $1 USD)

Optional flags:
  --posSide       Position side for usdt-m only (default: Merged)
                  Merged  one-way mode
                  Long    hedge mode — open / add to long
                  Short   hedge mode — open / add to short

  --timeInForce   Time in force (default: GoodTillCancel)
                  GoodTillCancel    order stays until filled or cancelled
                  PostOnly          order must be maker, rejected if taker
                  ImmediateOrCancel fill what is available, cancel the rest
                  FillOrKill        fill fully or cancel entirely

  --leverage      Leverage for usdt-m / coin-m (optional, default: cross-margin)
                  Value is always positive (e.g. 100 = 100x)
                  Use 0 for max cross-margin leverage
                  Example:  --leverage 100   100x cross-margin
`.trim();
  console.log(text);
  process.exit(0);
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);

  // --help or no args -> show usage
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    usage();
  }

  const m = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };

  const errors: string[] = [];

  const account = m("--account") as CliArgs["account"] | undefined;
  const symbol = m("--symbol");
  const side = m("--side") as CliArgs["side"] | undefined;
  const price = m("--price");
  const qty = m("--qty");
  const posSideRaw = m("--posSide") ?? "Merged";
  const timeInForce = m("--timeInForce") ?? "GoodTillCancel";
  const leverageRaw = m("--leverage");

  // Normalize case for side and posSide
  const sideNorm = side
    ? (() => {
        const s = side.charAt(0).toUpperCase() + side.slice(1).toLowerCase();
        // Accept long/buy interchangeably → Buy, short/sell → Sell
        if (s === "Long") return "Buy";
        if (s === "Short") return "Sell";
        return s;
      })()
    : undefined;
  const posSide = posSideRaw.charAt(0).toUpperCase() + posSideRaw.slice(1).toLowerCase();

  if (!account || !["spot", "usdt-m", "coin-m"].includes(account)) {
    errors.push("--account  must be one of: spot, usdt-m, coin-m");
  }
  if (!symbol) {
    errors.push("--symbol   is required (e.g. BTCUSDT)");
  }
  if (!sideNorm || !["Buy", "Sell"].includes(sideNorm)) {
    errors.push("--side     must be Buy or Sell (case-insensitive)");
  }
  if (!price || isNaN(Number(price))) {
    errors.push("--price    is required (numeric)");
  }
  if (!qty || isNaN(Number(qty))) {
    errors.push("--qty      is required (numeric)");
  }

  // Validate leverage
  let leverage: number | undefined;
  if (leverageRaw !== undefined) {
    leverage = Number(leverageRaw);
    if (isNaN(leverage) || !Number.isInteger(leverage)) {
      errors.push("--leverage must be an integer (e.g. -100, 50, 0)");
    }
    if (account === "spot") {
      errors.push("--leverage is not supported for spot");
    }
  }

  if (errors.length > 0) {
    console.error("✗  Missing or invalid arguments:\n");
    for (const e of errors) console.error(`   ${e}`);
    console.error(`\n   Run with --help for full usage.`);
    process.exit(1);
  }

  return {
    account: account as CliArgs["account"],
    symbol: symbol as string,
    side: sideNorm as CliArgs["side"],
    price: Number(price),
    qty: Number(qty),
    posSide,
    timeInForce,
    leverage,
  };
}

/** Fetch product info for an inverse (Coin-M) symbol */
async function fetchProductInfo(symbol: string): Promise<ProductInfo | null> {
  const creds = loadCredentials();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);
  const resp = (await request(
    "GET",
    "/public/products",
    null,
    creds.PHEMEX_API_KEY,
    secretRaw,
    ""
  )) as Record<string, unknown>;

  if (resp.code !== 0) return null;
  const data = resp.data as Record<string, unknown> | undefined;

  // Try the old (non-perp) products array first
  const products = (data?.products as Record<string, unknown>[]) ?? [];
  // For hedged perpetual, data may be an array directly
  const allProducts = products.length > 0 ? products : (data as Record<string, unknown>[] | undefined) ?? [];

  // Also check perpProductsV2 for USDT-M products
  const perpProducts = (data?.perpProductsV2 as Record<string, unknown>[]) ?? [];

  // Search all product sources
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

  // Fallback: default BTCUSD values (exponents: priceScale=4, ratioScale=8, valueScale=8)
  if (symbol === "BTCUSD") {
    return { priceScale: 10000, valueScale: 100_000_000, ratioScale: 100_000_000, settleCurrency: "BTC", contractSize: 1 };
  }
  return null;
}

function loadCredentials(): Credentials {
  const credsPath = path.resolve(import.meta.dirname, "phemex-credentials.json");
  if (!fs.existsSync(credsPath)) {
    console.error("✗  Missing phemex-credentials.json");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(credsPath, "utf8"));
}

/* ------------------------------------------------------------------ */
/*  Leverage                                                            */
/* ------------------------------------------------------------------ */

/** Set leverage for Coin-M (inverse) account. Positive user value = cross-margin. */
async function setLeverageCoinM(
  symbol: string,
  leverage: number,
  apiKey: string,
  secretRaw: Buffer,
): Promise<void> {
  // User passes positive value for cross-margin; Phemex API expects negative
  const apiLeverage = leverage > 0 ? -leverage : 0;

  // Fetch product info for ratioScale
  const creds = loadCredentials();
  const secretRaw2 = base64UrlDecode(creds.PHEMEX_API_SECRET);
  const resp = (await request(
    "GET",
    "/public/products",
    null,
    apiKey,
    secretRaw2,
    ""
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

  console.log(`   Setting cross-margin leverage for ${symbol}: ${leverage}x`);

  const qs = `symbol=${symbol}&leverageEr=${leverageEr}`;
  const res = await request("PUT", "/positions/leverage", qs, apiKey, secretRaw, "");
  if (res.code !== 0) {
    throw new Error(`Leverage API error: ${res.msg ?? res.code}`);
  }
}

/** Set leverage for USDⓈ-M (linear) account. Positive user value = cross-margin. */
async function setLeverageUsdtM(
  symbol: string,
  leverage: number,
  posSide: string,
  apiKey: string,
  secretRaw: Buffer,
): Promise<void> {
  // User passes positive value for cross-margin; Phemex API expects negative
  const apiLeverage = leverage > 0 ? -leverage : 0;

  console.log(`   Setting cross-margin leverage for ${symbol}: ${leverage}x`);

  const qs = `symbol=${symbol}&leverageRr=${apiLeverage}&posSide=${posSide}`;
  const res = await request("PUT", "/g-positions/leverage", qs, apiKey, secretRaw, "");
  if (res.code !== 0) {
    const msg = String(res.msg ?? res.code);
    if (msg.includes("INCONSISTENT_POS_MODE")) {
      throw new Error(
        `Leverage API error: ${msg} — the account position mode may not support this endpoint. ` +
        `Try setting leverage via the Phemex web UI for this account.`
      );
    }
    throw new Error(`Leverage API error: ${msg}`);
  }
}

function accountLabel(_leverage: number): string {
  return "cross-margin";
}

/* ------------------------------------------------------------------ */
/*  Order placement by account type                                    */
/* ------------------------------------------------------------------ */

interface PlaceOrderResult {
  orderID?: string;
  clOrdID?: string;
  ordStatus?: string;
  symbol?: string;
  side?: string;
  price?: unknown;
  qty?: unknown;
  [key: string]: unknown;
}

async function placeSpot(args: CliArgs, apiKey: string, secretRaw: Buffer): Promise<PlaceOrderResult> {
  // Spot symbols get an "s" prefix, and use scaled integer values (scale 10^8)
  const spotSymbol = "s" + args.symbol;
  const priceEp = Math.round(args.price * 1e8);
  const baseQtyEv = Math.round(args.qty * 1e8);
  const clOrdID = uuid();

  const body = JSON.stringify({
    symbol: spotSymbol,
    clOrdID,
    side: args.side,
    ordType: "Limit",
    timeInForce: args.timeInForce,
    priceEp,
    baseQtyEv,
    qtyType: "ByBase",
  });

  // Spot uses POST (not PUT) with body — signature example 3 confirms this format
  const resp = (await request(
    "POST",
    "/spot/orders",
    null,
    apiKey,
    secretRaw,
    body
  )) as Record<string, unknown>;

  if (resp.code !== 0) throw new Error(String(resp.msg ?? `API code ${resp.code}`));
  const data = resp.data as PlaceOrderResult | undefined;
  if (!data) throw new Error("Empty response data");
  return data;
}

async function placeLinear(args: CliArgs, apiKey: string, secretRaw: Buffer): Promise<PlaceOrderResult> {
  // USDT-M uses the PUT method with query params (no body)
  const clOrdID = uuid();
  const query = [
    `symbol=${args.symbol}`,
    `side=${args.side}`,
    `posSide=${args.posSide}`,
    `ordType=Limit`,
    `timeInForce=${args.timeInForce}`,
    `priceRp=${args.price}`,
    `orderQtyRq=${args.qty}`,
    `clOrdID=${clOrdID}`,
  ].join("&");

  const resp = (await request(
    "PUT",
    "/g-orders/create",
    query,
    apiKey,
    secretRaw,
    ""  // no body for PUT with query params
  )) as Record<string, unknown>;

  if (resp.code !== 0) throw new Error(String(resp.msg ?? `API code ${resp.code}`));
  const data = resp.data as PlaceOrderResult | undefined;
  if (!data) throw new Error("Empty response data");
  return data;
}

async function placeInverse(args: CliArgs, apiKey: string, secretRaw: Buffer): Promise<PlaceOrderResult> {
  // Fetch product info for scaling
  const product = await fetchProductInfo(args.symbol);
  if (!product) {
    throw new Error(`Could not fetch product info for ${args.symbol}`);
  }

  // Inverse contracts: priceEp = price * priceScale
  const priceEp = Math.round(args.price * product.priceScale);

  // Order qty is number of contracts. For BTCUSD, 1 contract = 1 USD.
  // We assume the user passes contract count directly.
  const orderQty = Math.round(args.qty);
  const clOrdID = uuid();

  // Inverse uses the PUT method with query params (no body)
  const query = [
    `symbol=${args.symbol}`,
    `side=${args.side}`,
    `ordType=Limit`,
    `timeInForce=${args.timeInForce}`,
    `priceEp=${priceEp}`,
    `orderQty=${orderQty}`,
    `clOrdID=${clOrdID}`,
  ].join("&");

  const resp = (await request(
    "PUT",
    "/orders/create",
    query,
    apiKey,
    secretRaw,
    ""  // no body for PUT with query params
  )) as Record<string, unknown>;

  if (resp.code !== 0) throw new Error(String(resp.msg ?? `API code ${resp.code}`));
  const data = resp.data as PlaceOrderResult | undefined;
  if (!data) throw new Error("Empty response data");
  return data;
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const args = parseArgs();
  const creds = loadCredentials();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  console.log(`⟐  Placing ${args.side} limit order on ${args.account}:${args.symbol}`);
  console.log(`   Price: ${args.price}, Qty: ${args.qty}, TIF: ${args.timeInForce}`);

  // Set leverage first if requested (only for perpetual accounts)
  if (args.leverage !== undefined) {
    switch (args.account) {
      case "coin-m":
        await setLeverageCoinM(args.symbol, args.leverage, creds.PHEMEX_API_KEY, secretRaw);
        break;
      case "usdt-m":
        await setLeverageUsdtM(args.symbol, args.leverage, args.posSide, creds.PHEMEX_API_KEY, secretRaw);
        break;
    }
  }

  let result: PlaceOrderResult;
  switch (args.account) {
    case "spot":
      result = await placeSpot(args, creds.PHEMEX_API_KEY, secretRaw);
      break;
    case "usdt-m":
      result = await placeLinear(args, creds.PHEMEX_API_KEY, secretRaw);
      break;
    case "coin-m":
      result = await placeInverse(args, creds.PHEMEX_API_KEY, secretRaw);
      break;
  }

  const ordID = result.orderID ?? result.clOrdID ?? "—";
  const status = result.ordStatus ?? "—";
  const sym = result.symbol ?? args.symbol;
  const s = result.side ?? args.side;
  const p = result.price ?? args.price;
  const q = result.qty ?? args.qty;

  console.log(`✓  Order placed — ID: ${ordID}, Symbol: ${sym}, Side: ${s}, Price: ${p}, Qty: ${q}, Status: ${status}`);
}

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
