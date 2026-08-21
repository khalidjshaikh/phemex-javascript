#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-ws-xbrusdt-monitor-ws3.ts — XBRUSDT WebSocket monitor: live ticker +
 *                                     trade feed + delta-rule auto-trader.
 *
 * Data sources:
 *   1. WebSocket 24h ticker (perp_market24h_pack_p) — prints ticker line ~1s
 *   2. WebSocket trade feed (trade_p)                — prints trade arrows on each fill
 *   3. REST position polling (fetchPositions)         — displays open position, PnL %, margin
 *
 * Auto-trader (delta rule):
 *   Δ = price − last-pivot price (the pivot is the price where direction last
 *   flipped). Buy Long when a new up-leg starts (direction flips to ↑ with
 *   Δ ≥ ENTRY_DELTA_MIN); hold while Δ stays positive; sell when Δ turns
 *   negative (direction flips to ↓). Rides a sustained rally (e.g. $88 → $90)
 *   and exits when the price breaks back below the pivot.
 *
 * Usage:  ./phemex-ws-xbrusdt-monitor-ws3.ts
 */
import "../src/globals.js"
import fs from "node:fs";
import path from "node:path";
import { ReconnectingWs } from "../src/ws-client.js";
import { findSymbolRow, getArg, hasFlag } from "../src/cli-utils.js";
import { base64UrlDecode } from "../src/http-client.js";
import { loadCredentialsLocal } from "../src/credentials.js";
import JSON5 from "json5";
import { 
  placeLimitOrder, 
  cancelOrders, 
  setLeverageUsdtM,
  placeMarketOrder
 } from "../src/place-limit-order.js";
import {
  fetchPositions,
  calcPnlPct,
  closePosition,
  Position,
} from "../src/positions.js";

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

const LONG_PID_FILE = ".long-limit.pid";
const SHORT_PID_FILE = ".short-limit.pid";

const WS_URL = "wss://ws.phemex.com";
const SYMBOL_DEFAULT = "XAUUSDT";
const POLL_INTERVAL_MS = 2_000;

/* ── Auto-trader configuration (tune these) ───────────────────────── */
const AUTO_TRADE_ENABLED = !hasFlag("--no-trade");  // master switch for placing real orders
const AUTO_TRADE_LEVERAGE = 100;      // leverage used for bot positions
const ENTRY_DELTA_MIN = 0.10;         // buy when the up-leg is ≥ this far ($) above its pivot; 0 = strict "Δ > 0" rule
const TRAILING_PNL_PCT = 5;          // safety: close bot position if PnL% gives back this many points from peak
const HARD_STOP_PNL_PCT = -10;        // close bot position if PnL% (margin-based) falls below this

/* Parse CLI flags like --symbol XTIUSDT */
function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}

const AUTO_TRADE_QTY = Number(parseArg("size") ?? parseArg("qty") ?? "0.001");
const SYMBOL = parseArg("symbol") ?? SYMBOL_DEFAULT;
const PRICE_FILE = `${(parseArg("symbol") ?? "xbrusdt").toLowerCase()}-last-price.txt`;
const DECIMALS = Number(parseArg("decimals") ?? "3");
const CREDENTIAL = parseArg("credential");

if (hasFlag("--help")) {
  console.log(`
Usage: ${process.argv[1]} [OPTIONS]

XBRUSDT WebSocket monitor with live ticker, trade feed, orderbook bid/ask,
and delta-rule auto-trader.

Options:
  --symbol <SYMBOL>       Trading pair (default: ${SYMBOL_DEFAULT})
  --size/--qty <num>      Contract quantity per trade (default: 0.01)
  --decimals <N>          Decimal places for displayed values (default: 2)
  --credential <name>     Credential profile from .credentials.json (e.g. A02, meta, gmail)
  --no-trade              Suppress trading activity (read-only mode)
  --help                  Show this help message

Examples:
  ${process.argv[1]}
  ${process.argv[1]} --symbol XTIUSDT
  ${process.argv[1]} --size 0.001
  ${process.argv[1]} --decimals 4
  ${process.argv[1]} --credential A02
`);
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function loadCredentialProfile(name: string): { PHEMEX_API_KEY: string; PHEMEX_API_SECRET: string } {
  const credsPath = path.resolve(process.cwd(), ".credentials.json");
  if (!fs.existsSync(credsPath)) {
    console.error(`✗  Missing ${credsPath}`);
    process.exit(1);
  }
  const all = JSON5.parse(fs.readFileSync(credsPath, "utf8")) as Record<string, { PHEMEX_API_KEY: string; PHEMEX_API_SECRET: string }>;
  if (!all[name]) {
    console.error(`✗  Credential profile "${name}" not found in .credentials.json (available: ${Object.keys(all).join(", ")})`);
    process.exit(1);
  }
  return all[name];
}

function fmtTime(): string {
  return new Date().toLocaleString();
}

function fmtNum(n: number, d: number = DECIMALS): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

//homelastTickerPrice ??= 0
//lastTradePrice ??= 0
// streak ??= 0
// streakStartPrice ??= 0

let direction: "↑" | "↓" = "↑";
/** All open positions across all symbols, refreshed every POLL_INTERVAL_MS */
let allPositions: Position[] = [];
/** Tracks a position opened by the auto-trader so we know when to close it */
let botPosition: { side: "Long" | "Short"; entryPrice: number } | null = null;
/** Peak PnL% reached by the current bot position (anchor for the PnL-decline stop) */
let botMaxPnlPct: number | null = null;
/** Peak PnL% seen since monitor start (anchor for the generic trailing stop) */
let maxPnlPct: number | null = null;
/** Previous arrow direction — used to detect flips and close the bot position */
let prevDirection: "↑" | "↓" = "↑";
/** Best bid/ask from orderbook WebSocket */
let bestBid = 0;
let bestAsk = 0;
/** API credentials, set once in main() */
let apiKey = "";
let secretRaw: Buffer = Buffer.alloc(0);

const credentials = CREDENTIAL
  ? loadCredentialProfile(CREDENTIAL)
  : loadCredentialsLocal();
const secretRawBuf = base64UrlDecode(credentials.PHEMEX_API_SECRET);
const apiKeyVal = credentials.PHEMEX_API_KEY;
apiKey = apiKeyVal;
secretRaw = secretRawBuf;

function updateDirection(last: number, prev: number): void {
  if (last > prev) {
    if (direction === "↑") streak++;
    else { direction = "↑"; streak = 1; streakStartPrice = prev; }
  } else if (last < prev) {
    if (direction === "↓") streak++;
    else { direction = "↓"; streak = 1; streakStartPrice = prev; }
  }
}

function notifyLimitScripts(): void {
  for (const pidFile of [LONG_PID_FILE, SHORT_PID_FILE]) {
    try {
      const pidText = fs.readFileSync(pidFile, "utf8").trim();
      const pid = Number(pidText);
      if (!Number.isNaN(pid)) {
        process.kill(pid, "SIGUSR1");
      }
    } catch {
      // Ignore if the target process is not running or the PID file is absent.
    }
  }
}

function savePrice(price: number): void {
  fs.writeFileSync(PRICE_FILE, String(price), "utf8");
}

/* ------------------------------------------------------------------ */
/*  Ticker display (USDT-M Rp format, columnar data)                   */
/* ------------------------------------------------------------------ */

function printTicker(symbol: string, ticker: Record<string, unknown>): void {
  const open = Number(ticker.openRp ?? 0);
  const high = Number(ticker.highRp ?? 0);
  const low = Number(ticker.lowRp ?? 0);
  const last = Number(ticker.lastRp ?? 0);
  const volume = Number(ticker.volumeRq ?? 0);
  const changePct = open > 0 ? ((last - open) / open) * 100 : 0;

  // Update intraday low for trade log column
  TradeBatchProcessor.intradayLow = low;

  const now = fmtTime();
  const sign = changePct >= 0 ? "+" : "";
  const priceStr = `$${last.toFixed(DECIMALS)}`;
  const highStr = `H: $${high.toFixed(DECIMALS)}`;
  const lowStr = `L: $${low.toFixed(DECIMALS)}`;
  const chgStr = `Chg: ${sign}${changePct.toFixed(DECIMALS)}%`;
  const volStr = `Vol: ${volume.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  const bidStr = bestBid > 0 ? `Bid: $${bestBid.toFixed(DECIMALS)}` : "";
  const askStr = bestAsk > 0 ? `Ask: $${bestAsk.toFixed(DECIMALS)}` : "";

  const line = `${now}  ${symbol}  ${priceStr}  ${bidStr}  ${askStr}  ${highStr}  ${lowStr}  ${chgStr}  ${volStr}`;

  // if (last !== lastTickerPrice) {
    updateDirection(last, lastTickerPrice);
    const delta = last - streakStartPrice;
    const deltaStr = delta >= 0 ? `Δ+$${delta.toFixed(DECIMALS)}` : `Δ-$${Math.abs(delta).toFixed(DECIMALS)}`;
    const streakStr = ` (${direction}×${streak}, ${deltaStr})`;
    console.log(line + streakStr);
    lastTickerPrice = last;
    // savePrice(last);
    // notifyLimitScripts();
  // }
}


/* ── Order helpers (used by auto_trade) ───────────────────────────── */

/**
 * Place `spread` Long limit orders at descending prices (price - cent * 0.01),
 * each with a stop-loss 1 tick below the entry.
 */
async function placeLongLimitOrders(
  price: number,
  spread: number,
  symbol: string,
  apiKey: string,
  secretRaw: Buffer,
): Promise<void> {
  for (let cent = 0; cent < spread; cent++) {
    const entryPrice = +(price - cent * 0.01).toFixed(2);
    const slPrice = +(entryPrice - 0.01).toFixed(2);
    await placeLimitOrder(
      {
        account: "usdt-m",
        symbol,
        side: "Buy",
        price: entryPrice,
        qty: 0.01,
        posSide: "Long",
        timeInForce: "GoodTillCancel",
        stopLoss: slPrice,
      },
      apiKey,
      secretRaw,
    );
  }
}

/**
 * Place `spread` Short limit orders at ascending prices (price + cent * 0.01),
 * each with a stop-loss 1 tick above the entry.
 */
async function placeShortLimitOrders(
  price: number,
  spread: number,
  symbol: string,
  apiKey: string,
  secretRaw: Buffer,
): Promise<void> {
  for (let cent = 0; cent < spread; cent++) {
    const entryPrice = +(price + cent * 0.01).toFixed(2);
    const slPrice = +(entryPrice + 0.01).toFixed(2);
    await placeLimitOrder(
      {
        account: "usdt-m",
        symbol,
        side: "Sell",
        price: entryPrice,
        qty: 0.01,
        posSide: "Short",
        timeInForce: "GoodTillCancel",
        stopLoss: slPrice,
      },
      apiKey,
      secretRaw,
    );
  }
}

/*  Trade batch processor (encapsulates streak tracking for 1000-trade batches) */
/* ------------------------------------------------------------------ */

class TradeBatchProcessor {
  static prevPrice: number | null = null;
  static prevDirection: string | null = null;
  static streak: number = 0;
  static streakStartPrice: number | null = null;
  static lastLongPrice: number | null = null;
  static lastShortPrice: number | null = null;
  static intradayLow: number = 0;

  /** Set to true when the direction just changed on the most recent process_trade call. */
  static directionChanged: boolean = false;
  /** The direction value BEFORE the most recent process_trade call (for flip logging). */
  static prevPrevDirection: string | null = null;

  static headersPrinted = false;

  /** Print column headers once before the first trade is processed. */
  static printHeaders(): void {
    if (this.headersPrinted) return;
    console.log(
      `${"Timestamp".padEnd(22)} ${"Side".padEnd(4)} ${"Price".padStart(8)} ${"Qty".padStart(10)} ${"Last Δ".padStart(10)} ${"Dir".padEnd(6)} ${"Δ".padStart(8)} ${"I-L".padStart(8)} ${"Ask".padStart(8)} ${"Bid".padStart(8)} ${"Spread".padStart(8)}`
    );
    this.headersPrinted = true;
  }

  /** Reset all static tracking state before starting a new batch. */
  static reset(): void {
    this.prevPrice = null;
    this.prevDirection = null;
    this.streak = 0;
    this.streakStartPrice = null;
    this.lastLongPrice = null;
    this.lastShortPrice = null;
    this.directionChanged = false;
    this.prevPrevDirection = null;
  }

  /**
   * Process a single trade tuple [timestamp, side, price, quantity].
   * Logs a formatted line with direction arrows, streak count, delta,
   * and big-move indicator.  Updates the static tracking state.
   */
  static process_trade(trade: unknown[]): void {
    this.printHeaders();
    const [timestamp, side, price, quantity] = trade;
    const p = Number(price);
    const date = new Date(Number(timestamp / 1e6));
    let arrow = '';
    let delta = 0;
    let sign = '';
    if (this.prevPrice !== null) {
      let dir: any = p > this.prevPrice ? '↑' : p < this.prevPrice ? '↓' : this.prevDirection;
      // Save pre-update direction for auto_trade flip detection
      this.prevPrevDirection = this.prevDirection;
      this.directionChanged = (dir !== this.prevDirection);
      if (dir === this.prevDirection) {
        this.streak++;
      } else {
        this.streak = 1;
        this.streakStartPrice = this.prevPrice;
      }
      delta = this.streakStartPrice !== null ? p - this.streakStartPrice : 0;
      sign = delta >= 0 ? '+' : '';
      arrow = this.streak > 1 ? `${dir}${this.streak}` : dir;
      this.prevDirection = dir;
    } else {
      this.streak = 1;
      this.streakStartPrice = p;
      this.prevDirection = '→';
    }
    const deltaStr = `${sign}${delta.toFixed(DECIMALS)}`.padStart(5);
    const lastDelta = this.prevPrice !== null ? p - this.prevPrice : 0;
    const lastDeltaStr = this.prevPrice !== null ? (lastDelta >= 0 ? '+' : '') + lastDelta.toFixed(DECIMALS) : '';
    arrow = arrow ? `${arrow.padEnd(3)} Δ${deltaStr.padEnd(5)}` : '';
    const bidStr = bestBid > 0 ? `$${bestBid.toFixed(DECIMALS)}` : '';
    const askStr = bestAsk > 0 ? `$${bestAsk.toFixed(DECIMALS)}` : '';
    const spread = bestBid > 0 && bestAsk > 0 ? (bestAsk - bestBid).toFixed(DECIMALS) : '';
    const ilStr = this.intradayLow > 0 ? `$${this.intradayLow.toFixed(DECIMALS)}` : "";
    console.log(
      `${date.toLocaleString().padEnd(22)} ${side.padEnd(4)} ${('$' + Number(price).toFixed(DECIMALS)).padStart(8)} ${Number(quantity).toFixed(DECIMALS).padStart(10)} ${lastDeltaStr.padStart(10)} ${arrow.padEnd(6)} ${ilStr.padStart(8)} ${askStr.padStart(8)} ${bidStr.padStart(8)} ${spread.padStart(8)}`
    );
    this.prevPrice = p;
  }

  /**
   * Auto-trade: pure delta rule — buy when Δ turns positive, sell when Δ
   * turns negative (state set by the most recent process_trade call).
   *
   * Δ (the cumulative delta printed in the trade log) = price − the price at
   * the last direction flip (the "pivot"):
   *   Δ > 0  ⇔  price is above the pivot — a new up-leg is in progress
   *   Δ < 0  ⇔  price broke below the pivot — the up-leg is over
   *
   * Entry — a new up-leg starts:
   * - Buy Long the moment the direction flips to ↑ with Δ ≥ ENTRY_DELTA_MIN.
   *   (ENTRY_DELTA_MIN = 0 is the strict "buy when Δ is positive" rule; a
   *   small value skips sub-cent noise so we don't trade every wiggle.)
   *
   * Exit — the up-leg ends:
   * - Sell when the direction flips to ↓ — that is exactly the first tick on
   *   which Δ turns negative (price falls back below the pivot).
   * - The polling loop in main() is a safety net only (hard stop / trailing
   *   PnL decline); the delta flip is the primary exit.
   *
   * Must be called AFTER process_trade() with the same trade tuple.
   */
  static async auto_trade(trade: unknown[]): Promise<void> {
    if (!AUTO_TRADE_ENABLED) return;
    if (this.prevPrice === null) return;               // nothing to evaluate on the very first trade
    if (Number(trade[3]) === AUTO_TRADE_QTY) return;   // ignore our own 0.01 fills

    const price = Number(trade[2]);
    const symbol = SYMBOL;
    const delta = this.streakStartPrice !== null ? price - this.streakStartPrice : 0;

    // ── Exit: Δ turned negative → the up-leg is over, close the bot position ──
    // A flip to ↓ is the first tick on which Δ < 0 (price broke below the pivot).
    if (botPosition && this.directionChanged && this.prevDirection === "↓") {
      // allPositions is refreshed every POLL_INTERVAL_MS; fall back to a fresh
      // fetch so a just-opened position is found even if the cache is stale.
      const pos = allPositions.find((p) => p.symbol === symbol)
        ?? (await fetchPositions(apiKey, secretRaw)).find((p) => p.symbol === symbol);
      if (pos) {
        console.log(
          `[${fmtTime()}]  ⟐  ${botPosition.side} Δ<0 → closing bot ${symbol} ` +
          `(entry $${botPosition.entryPrice.toFixed(DECIMALS)} → $${price.toFixed(DECIMALS)}) …`,
        );
        await closePosition(pos, apiKey, secretRaw);
      }
      botPosition = null;
      botMaxPnlPct = null;
      maxPnlPct = null;
      this.lastLongPrice = null;
      this.lastShortPrice = null;
      return;
    }

    // One position at a time
    if (botPosition) return;

    // ── Entry: Δ just turned positive → ride the new up-leg ─────────────
    // A flip to ↑ starts a fresh up-leg (streakStartPrice = the pivot where
    // the previous leg ended), so Δ = price − pivot > 0. Buy, then HOLD while
    // the leg keeps making progress — the exit is the next flip to ↓ (Δ < 0).
    if (this.prevDirection === "↑" && delta >= ENTRY_DELTA_MIN) {
      // if (this.lastLongPrice && price < this.lastLongPrice) return; // don't chase a lower price
      console.log(`[${fmtTime()}]  🟢  Rise detected (Δ+$${delta.toFixed(2)} from pivot $${this.streakStartPrice?.toFixed(2)}) — opening Long ${symbol} @ $${price} …`);
      await setLeverageUsdtM(symbol, AUTO_TRADE_LEVERAGE, "Long", apiKey, secretRaw);
      const result = await placeMarketOrder(
        { account: "usdt-m", symbol, posSide: "Long", price, qty: AUTO_TRADE_QTY, side: "Buy" },
        apiKey,
        secretRaw,
      );
      this.lastLongPrice = price;
      botPosition = { side: "Long", entryPrice: price };
      botMaxPnlPct = null;
      maxPnlPct = null;
      console.log(`[${fmtTime()}]  ✓  Long ${symbol} opened @ $${price}  code: ${(result as Record<string, unknown>).code}`);
      return;
    }

    // ── Entry: beginning of a drop → Short ────────────────────────────
    // if (this.prevDirection === "↓" && this.streak >= ENTRY_STREAK_MIN && delta <= -ENTRY_DELTA_MIN) {
    //   // if (this.lastShortPrice && price > this.lastShortPrice) return; // don't chase a higher price
    //   console.log(`[${fmtTime()}]  🔴  Drop detected (↓${this.streak}, Δ-$${Math.abs(delta).toFixed(2)}) — opening Short ${symbol} @ $${price} …`);
    //   await setLeverageUsdtM(symbol, AUTO_TRADE_LEVERAGE, "Short", apiKey, secretRaw);
    //   const result = await placeMarketOrder(
    //     { account: "usdt-m", symbol, posSide: "Short", price, qty: AUTO_TRADE_QTY, side: "Sell" },
    //     apiKey,
    //     secretRaw,
    //   );
    //   this.lastShortPrice = price;
    //   botPosition = { side: "Short", entryPrice: price };
    //   botMaxPnlPct = null;
    //   maxPnlPct = null;
    //   console.log(`[${fmtTime()}]  ✓  Short ${symbol} opened @ $${price}  code: ${(result as Record<string, unknown>).code}`);
    //   return;
    // }
  }
}

/*  Main                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {

  console.log(`═ XBRUSDT WS Monitor (read-only) ═══════════════════════════`);
  console.log(`  Symbol:       ${SYMBOL}`);
  console.log(`  Position poll: every ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`═════════════════════════════════════════════════════════════`);

  // ---------------------------------------------------------------
  // WebSocket — ticker + trade feed
  // ---------------------------------------------------------------
  const ws = new ReconnectingWs(WS_URL, {
    onOpen: () => {
      ws.send({ method: "perp_market24h_pack_p.subscribe", params: [SYMBOL], id: 1 });
      ws.send({ method: "trade_p.subscribe", params: [SYMBOL], id: 2 });
      ws.send({ method: "orderbook_p.subscribe", params: [SYMBOL, 5], id: 3 });
    },
    onMessage: async (msg) => {
      const m = msg as Record<string, unknown>;
      // console.log(msg)
      // if(msg.dts)
      // {
      //   console.log({ dts: new Date(Number(msg.dts/1e6)),
      //                 locale: (new Date(Number(msg.dts/1e6)).toLocaleString())
      //   })
      // }
      // if(msg.mts)
      // {
      //   console.log({ dts: new Date(Number(msg.mts/1e6)),
      //                 locale: (new Date(Number(msg.mts/1e6)).toLocaleString())
      //   })
      // }
      if(msg.trades_p && msg.trades_p.length == 1000){
        TradeBatchProcessor.reset();
        for (const trade of msg.trades_p.reverse()) {
          TradeBatchProcessor.process_trade(trade);
        }
        // lastTradePrice = TradeBatchProcessor.prevPrice
      }
      // 24h ticker (columnar USDT-M format)
      if (
        m.method === "perp_market24h_pack_p.update" &&
        Array.isArray(m.fields) &&
        Array.isArray(m.data)
      ) {
        const ticker = findSymbolRow(m.data as unknown[][], m.fields as string[], SYMBOL);
        if (ticker) {
          printTicker(SYMBOL, ticker);
        }
        return;
      }

      // Orderbook — best bid/ask
      if (m.orderbook_p) {
        const book = m.orderbook_p as Record<string, unknown>;
        const asks = book.asks as unknown[][] | undefined;
        const bids = book.bids as unknown[][] | undefined;
        if (asks && asks.length > 0) bestAsk = Number(asks[0][0]);
        if (bids && bids.length > 0) bestBid = Number(bids[0][0]);
        return;
      }

      // Real-time trades
      if (m.trades_p && m.symbol === SYMBOL && m.trades_p.length != 1000) {
        const trades = m.trades_p as unknown[][];
        if (trades.length > 0) {
          for (const trade of trades) {
            TradeBatchProcessor.process_trade(trade);
            try {
              await TradeBatchProcessor.auto_trade(trade);
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              console.error(`[${fmtTime()}]  ✗  auto_trade error: ${msg}`);
            }
          }
        }
      }
    },
    onReconnect: (delayMs) => {
      process.stdout.write("\n");
      console.log(`[${fmtTime()}]  ⟐  WebSocket reconnecting in ${delayMs / 1000}s …`);
    },
  });

  ws.connect();

  // ---------------------------------------------------------------
  // Position polling loop (REST)
  // ---------------------------------------------------------------
  let running = true;

  process.on("SIGINT", () => {
    console.log(`\n[${fmtTime()}]  ⏹  Shutting down …`);
    running = false;
    ws.shutdown();
    process.exit(0);
  });

  while (running) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    if (!running) break;

    try {
      const positions = await fetchPositions(apiKey, secretRaw);
      allPositions = positions;
      const pos = positions.find((p) => p.symbol === SYMBOL);

      if (!pos) {
        // Position gone (closed by the flip exit, a stop, or manually) — reset tracking.
        botPosition = null;
        botMaxPnlPct = null;
        maxPnlPct = null;
        continue;
      }

      const pnlPct = calcPnlPct(pos);
      const entry = parseFloat(pos.avgEntryPriceRp || "0");
      const mark = parseFloat(pos.markPriceRp || "0");
      const size = parseFloat(pos.size || "0");
      const margin = parseFloat(pos.posCostRv || "0");

      console.log(
        `[${fmtTime()}]  ${SYMBOL}  ${pos.side.padEnd(4)}  ` +
        `size: ${fmtNum(size, 4)}  entry: $${fmtNum(entry)}  mark: $${fmtNum(mark)}  ` +
        `PnL: ${pnlPct >= 0 ? "+" : ""}${fmtNum(pnlPct, 2)}%  ` +
        `margin: $${fmtNum(margin, 4)}`
      );

      // ── Auto-trader position: close when the PnL declines ───────────
      // PnL% is margin-based, so at 100x leverage a -10% PnL is only a
      // -0.1% adverse price move.  Close if the PnL% gives back more than
      // TRAILING_PNL_PCT points from its peak, or falls below the hard stop.
      // The primary exit is the Δ<0 flip in auto_trade(); this is a backstop.
      if (botPosition) {
        if (botMaxPnlPct === null || pnlPct > botMaxPnlPct) botMaxPnlPct = pnlPct;
        const floor = Math.max(botMaxPnlPct - TRAILING_PNL_PCT, HARD_STOP_PNL_PCT);
        if (pnlPct < floor) {
          console.log(
            `[${fmtTime()}]  🛑  BOT PnL DECLINED — PnL ${fmtNum(pnlPct, 2)}% < floor ` +
            `${fmtNum(floor, 2)}% (peak ${fmtNum(botMaxPnlPct, 2)}%). Closing ${botPosition.side} …`
          );
          await closePosition(pos, apiKey, secretRaw);
          botPosition = null;
          botMaxPnlPct = null;
          maxPnlPct = null;
        }
        continue;
      }

      // ── Generic trailing stop for manually-held positions ───────────
      if (maxPnlPct === null || pnlPct > maxPnlPct) maxPnlPct = pnlPct;
      const floor = Math.max(maxPnlPct - TRAILING_PNL_PCT, HARD_STOP_PNL_PCT);
      // if (pnlPct < maxPnlPct - TRAILING_PNL_PCT) {
      if (pnlPct < floor) {
        console.log(
          `[${fmtTime()}]  🛑  STOP-LOSS TRIGGERED — PnL ${fmtNum(pnlPct, 2)}% < ` +
          `(floor, peak ${fmtNum(maxPnlPct, 2)}%). Closing position …`
        );
        await closePosition(pos, apiKey, secretRaw);
        maxPnlPct = null;
      }

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${fmtTime()}]  ✗  Position poll error: ${msg}`);
    }
  }

  console.log(`[${fmtTime()}]  ✅  Monitor stopped`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
