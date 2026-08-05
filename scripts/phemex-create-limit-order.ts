#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-create-limit-order.ts  —  Place a limit order on Phemex.
 * Credentials are read from .phemex-credentials.json.
 *
 * Usage:
 *   ./phemex-create-limit-order.ts --account <type> --symbol <pair> --side <Buy|Sell>
 *                                   --price <num> --qty <num> [options]
 *
 * Ladder mode (--from/--to): place a limit order at --from, wait --delay ms,
 * cancel it, then re-offer at --from+--step, sweeping up/down to --to
 * (inclusive).  Each rung is place → wait → cancel; stops early on fill.
 * With --loop the sweep repeats indefinitely — file-based endpoints
 * ("last"/"mark") are re-read each pass so the range tracks the market —
 * until a rung fills or an API error stops it (Ctrl+C to interrupt).
 * Prices accept a number, "last"/"mark" (last.txt / mark.txt at project
 * root), or an offset like "last-0.10" / "mark+0.20" (file ± delta).
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

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { request, base64UrlDecode } from "../src/http-client.js";
import { uuid } from "../src/uuid.js";
import { getArg, hasFlag } from "../src/cli-utils.js";
import { loadCredentialsLocal } from "../src/credentials.js";
import { setLeverageCoinM, setLeverageUsdtM } from "../src/place-limit-order.js";

const ROOT = resolve(import.meta.dirname, ".."); // project root
const LAST_FILE = resolve(ROOT, "last.txt"); // written by phemex-mark-price2.ts
const MARK_FILE = resolve(ROOT, "mark.txt");

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface CliArgs {
  account: "spot" | "usdt-m" | "coin-m";
  symbol: string;
  side: "Buy" | "Sell";
  price: number;
  qty: number;
  posSide: string;
  timeInForce: string;
  leverage?: number;
  takeProfit?: number;
  stopLoss?: number;
  jsonOutput: boolean;
  /** Ladder mode (--from/--to) — sweep a limit order across a price range. */
  ladder: boolean;
  from?: number;
  to?: number;
  fromSrc?: string;
  toSrc?: string;
  step: number;
  delay: number;
  /** Infinite loop: repeat the ladder sweep until filled or interrupted. */
  loop: boolean;
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

/** Offset form: "mark+0.20" / "last-0.05" / "mark+.1" — price file ± delta (US-ASCII +/-). */
const PRICE_EXPR = /^(last|mark)([+-])(\d+(?:\.\d+)?|\.\d+)$/;

/** Read the price stored in last.txt / mark.txt (project root). */
function readPriceFile(file: string): number {
  const raw = readFileSync(file, "utf8").trim();
  const v = parseFloat(raw);
  if (!Number.isFinite(v) || v <= 0) {
    throw new Error(`Invalid price in ${file}: "${raw}"`);
  }
  return v;
}

/**
 * Resolve a price arg that may be "last" (last.txt), "mark" (mark.txt),
 * "last/mark ± delta" (e.g. "mark+0.20"), or a plain number.  On failure
 * pushes an error into `errors` and returns undefined.
 */
function resolvePriceArg(raw: string, errors: string[], label: string): number | undefined {
  const m = PRICE_EXPR.exec(raw);
  if (m) {
    let base: number;
    try {
      base = readPriceFile(m[1] === "last" ? LAST_FILE : MARK_FILE);
    } catch (err: unknown) {
      errors.push(`${label}  ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
    const delta = parseFloat(m[3]);
    const price = m[2] === "+" ? base + delta : base - delta;
    if (!Number.isFinite(price) || price <= 0) {
      errors.push(`${label}  invalid price "${raw}" → $${price}`);
      return undefined;
    }
    return Math.round(price * 10_000) / 10_000;
  }

  if (raw === "last" || raw === "mark") {
    try {
      return readPriceFile(raw === "last" ? LAST_FILE : MARK_FILE);
    } catch (err: unknown) {
      errors.push(`${label}  ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  const v = parseFloat(raw);
  if (!Number.isFinite(v)) {
    errors.push(`${label}  invalid price "${raw}" — use a number, "last", "mark", or "last±delta" / "mark±delta"`);
    return undefined;
  }
  return v;
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
  usdt-m  Ladder open long 79.49→79.62 (step 0.01, 1s each)
            ./phemex-create-limit-order.ts --account usdt-m --symbol XBRUSDT --side Buy --from 79.49 --to 79.62 --qty 0.01 --posSide Long --leverage 100 --step 0.01 --delay 1000
  usdt-m  Ladder from last-0.10 → last (file-based endpoints)
            ./phemex-create-limit-order.ts --account usdt-m --symbol XBRUSDT --side Buy --from last-0.10 --to last --qty 0.01 --posSide Long --leverage 100 --delay 1000 --step 0.01
  usdt-m  Ladder loop — sweep last-0.10 → last-0.01 forever (until filled)
            ./phemex-create-limit-order.ts --account usdt-m --symbol XBRUSDT --side Buy --from last-0.10 --to last-0.01 --qty 0.01 --posSide Long --leverage 100 --delay 1000 --step 0.01 --loop

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
  --price      Limit price in quote currency (e.g. 60000; also "last"/"mark"
               or "last±delta" / "mark±delta" — omit with --from/--to ladder)
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

  --takeProfit    Take-profit trigger price (usdt-m only, optional)
                  Example:  --takeProfit 69   set TP at $69.00

  --stopLoss      Stop-loss trigger price (usdt-m only, optional)
                  Example:  --stopLoss 76     set SL at $76.00

  --from <price>  Ladder start price — place a limit order at each rung from
                  --from to --to (requires --to; --price is not needed).
                  Prices accept a number, "last"/"mark" (last.txt / mark.txt),
                  or an offset like "last-0.10" / "mark+0.20" (file ± delta)
  --to <price>    Ladder end price, inclusive (same syntax as --from)
  --step <price>  Ladder step between rungs, as a magnitude (default: 0.01);
                  direction follows --from → --to (downward allowed)
  --delay <ms>    Ladder: wait between place and cancel (default: 0)

  --loop          Ladder: repeat the sweep indefinitely — re-reads
                  last.txt / mark.txt each pass so the range tracks the
                  market.  Stops on fill or API error; Ctrl+C to interrupt.

  --json          Print the order result as JSON instead of the human-readable summary
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
  const takeProfitRaw = m("--takeProfit");
  const stopLossRaw = m("--stopLoss");
  const fromRaw = m("--from");
  const toRaw = m("--to");
  const stepRaw = m("--step");
  const delayRaw = m("--delay");
  const ladder = fromRaw !== undefined || toRaw !== undefined;
  const loop = argv.includes("--loop");
  const jsonOutput = argv.includes("--json");

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
  if (!ladder && price === undefined) {
    errors.push("--price    is required (numeric) — or use --from/--to for a ladder");
  }
  if (ladder && price !== undefined) {
    errors.push("--price    cannot be combined with --from/--to (ladder mode)");
  }
  // "last"/"mark" (last.txt / mark.txt) and "last±delta" / "mark±delta" resolve here
  const priceValue = !ladder && price !== undefined ? resolvePriceArg(price, errors, "--price") : undefined;
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

  // Validate takeProfit / stopLoss
  let takeProfit: number | undefined;
  if (takeProfitRaw !== undefined) {
    takeProfit = Number(takeProfitRaw);
    if (isNaN(takeProfit)) {
      errors.push("--takeProfit must be numeric");
    }
  }
  let stopLoss: number | undefined;
  if (stopLossRaw !== undefined) {
    stopLoss = Number(stopLossRaw);
    if (isNaN(stopLoss)) {
      errors.push("--stopLoss must be numeric");
    }
  }

  // Validate ladder mode (--from/--to)
  let step = stepRaw !== undefined ? Number(stepRaw) : 0.01;
  let delay = delayRaw !== undefined ? Number(delayRaw) : 0;
  let from: number | undefined;
  let to: number | undefined;
  if (ladder) {
    if (fromRaw === undefined || toRaw === undefined) {
      errors.push("--from/--to  both required for ladder mode");
    } else {
      from = resolvePriceArg(fromRaw, errors, "--from");
      to = resolvePriceArg(toRaw, errors, "--to");
    }
    if (isNaN(step) || step === 0) {
      errors.push("--step     must be a non-zero number (default: 0.01)");
    }
    if (isNaN(delay) || delay < 0) {
      errors.push("--delay    must be a non-negative number of ms (default: 0)");
    }
    if (jsonOutput) {
      errors.push("--json     cannot be combined with --from/--to (ladder mode)");
    }
    if (account === "spot") {
      errors.push("--from/--to ladder is not supported for spot (no spot cancel path)");
    }
  }
  if (loop && !ladder) {
    errors.push("--loop     requires --from/--to ladder mode");
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
    price: ladder ? 0 : (priceValue ?? 0),
    qty: Number(qty),
    posSide,
    timeInForce,
    leverage,
    takeProfit,
    stopLoss,
    jsonOutput,
    ladder,
    from,
    to,
    fromSrc: fromRaw,
    toSrc: toRaw,
    step,
    delay,
    loop,
  };
}

/** Fetch product info for an inverse (Coin-M) symbol */
async function fetchProductInfo(symbol: string): Promise<ProductInfo | null> {
  const creds = loadCredentialsLocal();
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

/* ------------------------------------------------------------------ */
/*  Leverage                                                            */
/* ------------------------------------------------------------------ */

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
  const params: string[] = [
    `symbol=${args.symbol}`,
    `side=${args.side}`,
    `posSide=${args.posSide}`,
    `ordType=Limit`,
    `timeInForce=${args.timeInForce}`,
    `priceRp=${args.price}`,
    `orderQtyRq=${args.qty}`,
    `clOrdID=${clOrdID}`,
  ];
  if (args.takeProfit !== undefined) {
    params.push(`takeProfitRp=${args.takeProfit}`);
  }
  if (args.stopLoss !== undefined) {
    params.push(`stopLossRp=${args.stopLoss}`);
  }
  const query = params.join("&");

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
/*  Ladder mode (--from/--to)                                          */
/* ------------------------------------------------------------------ */

/** Wait for the given number of milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Place a limit order at a specific rung price.  Same dispatch as the
 * single-order path, with `args.price` overridden per rung.
 */
async function placeAt(args: CliArgs, price: number, apiKey: string, secretRaw: Buffer): Promise<PlaceOrderResult> {
  const rung = { ...args, price };
  switch (args.account) {
    case "spot":
      return placeSpot(rung, apiKey, secretRaw);
    case "usdt-m":
      return placeLinear(rung, apiKey, secretRaw);
    case "coin-m":
      return placeInverse(rung, apiKey, secretRaw);
  }
}

/**
 * Cancel a rung order by ID.  Returns a status string:
 *   "cancelled"  — successfully cancelled
 *   "filled"     — order not found (already filled / does not exist)
 *   "error: …"   — something went wrong
 */
async function cancelRung(
  symbol: string,
  orderId: string,
  posSide: string,
  apiKey: string,
  secretRaw: Buffer,
): Promise<string> {
  const qp = new URLSearchParams({ orderID: orderId, symbol, posSide });
  const endpoint = symbol.toUpperCase().endsWith("USDT") ? "/g-orders" : "/orders";
  const resp = (await request("DELETE", endpoint, qp.toString(), apiKey, secretRaw, "")) as Record<string, unknown>;

  // code 0 = success
  if (resp.code === 0) return "cancelled";

  // Order not found (20001 / 60017 / 10002 / "not found") → already filled
  const msg = String(resp.msg ?? "");
  const data = resp.data as { bizError?: number }[] | undefined;
  const bizError = data?.[0]?.bizError;
  if (
    /not.?found/i.test(msg) ||
    /20001/.test(msg) || /60017/.test(msg) || /10002/.test(msg) ||
    bizError === 60017 || bizError === 10002
  ) return "filled";

  const biz = bizError === undefined ? "" : ` bizError=${bizError}`;
  return `error: code=${String(resp.code ?? "?")} msg="${msg}"${biz}`;
}

/** Outcome of a single ladder sweep. */
type LadderOutcome = "filled" | "aborted" | "complete";

/**
 * Resolve the ladder --from/--to endpoints for one pass.  File-based
 * endpoints ("last", "mark", "last±delta", …) are re-read so the range
 * tracks the current price on every pass (used by --loop).
 */
function resolveLadderRange(args: CliArgs): { from: number; to: number } {
  const errors: string[] = [];
  const from = args.fromSrc !== undefined ? resolvePriceArg(args.fromSrc, errors, "--from") : args.from;
  const to = args.toSrc !== undefined ? resolvePriceArg(args.toSrc, errors, "--to") : args.to;
  if (errors.length > 0) throw new Error(errors.join("; "));
  return { from: from as number, to: to as number };
}

/**
 * Sweep an opening limit order across from → to: place at each price,
 * wait --delay ms, cancel, then move to the next rung.  Stops early if an
 * order gets filled (cancel returns "not found") or an API call errors.
 * Returns the outcome; `pass` is shown in the header (loop mode).
 */
async function runLadder(args: CliArgs, apiKey: string, secretRaw: Buffer, from: number, to: number, pass: number): Promise<LadderOutcome> {
  const dir = to >= from ? 1 : -1;
  const prices: number[] = [];
  for (let p = from; dir > 0 ? p <= to + 1e-9 : p >= to - 1e-9; p += dir * Math.abs(args.step)) {
    prices.push(Math.round(p * 10_000) / 10_000);
  }

  const passLabel = pass > 1 ? ` (pass ${pass})` : "";
  console.log(`═ ${args.symbol} Ladder: ${args.side} / ${args.posSide} — opening${passLabel} ══════════════════`);
  const fromSrc = args.fromSrc !== undefined ? ` (${args.fromSrc})` : "";
  const toSrc = args.toSrc !== undefined ? ` (${args.toSrc})` : "";
  console.log(`   Range:     $${from}${fromSrc} → $${to}${toSrc} (inclusive)   step: $${Math.abs(args.step)}   rungs: ${prices.length}`);
  console.log(`   Qty/order: ${args.qty}   delay: ${args.delay}ms  place → wait → cancel`);
  console.log(`   Leverage:  ${args.leverage ?? "cross-margin"}${args.takeProfit !== undefined ? `   TP: $${args.takeProfit}` : ""}${args.stopLoss !== undefined ? `   SL: $${args.stopLoss}` : ""}`);
  console.log(`══════════════════════════════════════════════════════`);

  let filled = false;
  let aborted: string | null = null;
  let swept = 0;

  for (const price of prices) {
    // --- Place ---
    process.stdout.write(`   ${args.side} ${args.qty} ${args.symbol} @ $${price.toFixed(4)}  →  placing …  `);
    let orderId: string;
    try {
      const result = await placeAt(args, price, apiKey, secretRaw);
      orderId = result.orderID ?? result.clOrdID ?? "";
      if (!orderId) throw new Error("No orderID in response");
      console.log(`✓  orderID: ${orderId.slice(0, 8)}…`);
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      console.log(`✗  ${reason}`);
      aborted = reason;
      break;
    }

    // --- Wait ---
    if (args.delay > 0) {
      process.stdout.write(`       waiting ${args.delay}ms …  `);
      await sleep(args.delay);
      console.log("✓");
    }

    // --- Cancel ---
    process.stdout.write(`       cancelling ${orderId.slice(0, 8)}…  `);
    try {
      const status = await cancelRung(args.symbol, orderId, args.posSide, apiKey, secretRaw);
      if (status === "cancelled") {
        console.log("✓  cancelled");
      } else if (status === "filled") {
        console.log("⚡  already filled — ladder stopped");
        filled = true;
        break;
      } else {
        console.log(`✗  ${status}`);
        aborted = status;
        break;
      }
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      console.log(`✗  ${reason}`);
      aborted = reason;
      break;
    }
    swept++;
  }

  console.log(`══════════════════════════════════════════════════════`);
  if (filled) {
    console.log(`✔  Ladder filled at rung ${swept + 1}/${prices.length} — position opened.`);
    return "filled";
  } else if (aborted) {
    console.log(`✗  Ladder aborted at rung ${swept + 1}/${prices.length} — ${aborted}`);
    return "aborted";
  }
  console.log(`✔  Ladder complete — ${swept}/${prices.length} rung(s) swept, none filled.`);
  return "complete";
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const args = parseArgs();
  const creds = loadCredentialsLocal();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  // console.log(`   Placing ${args.side} limit order on ${args.account}:${args.symbol}`);
  // console.log(`   Price: ${args.price}, Qty: ${args.qty}, TIF: ${args.timeInForce}`);

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

  if (args.ladder) {
    if (args.loop) {
      console.log("↻  Loop mode: re-sweeping until filled — Ctrl+C to stop");
      for (let pass = 1; ; pass++) {
        const { from, to } = resolveLadderRange(args);
        const outcome = await runLadder(args, creds.PHEMEX_API_KEY, secretRaw, from, to, pass);
        if (outcome === "filled") return;
        if (outcome === "aborted") return;
        console.log(`\n↻  Pass ${pass} complete — sweeping again …`);
      }
    }
    const { from, to } = resolveLadderRange(args);
    await runLadder(args, creds.PHEMEX_API_KEY, secretRaw, from, to, 1);
    return;
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

  if (args.jsonOutput) {
    console.log(JSON.stringify(result));
    return;
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
