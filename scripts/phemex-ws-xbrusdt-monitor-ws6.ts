#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-ws-xbrusdt-monitor-ws.ts — XBRUSDT WebSocket monitor: live ticker +
 *                                     trade feed + read-only position display.
 *
 * Data sources:
 *   1. WebSocket 24h ticker (perp_market24h_pack_p) — prints ticker line ~1s
 *   2. WebSocket trade feed (trade_p)                — prints trade arrows on each fill
 *   3. REST position polling (fetchPositions)         — displays open position, PnL %, margin
 *                                                      (read-only — no auto-trading)
 *
 * Usage:  ./phemex-ws-xbrusdt-monitor-ws.ts
 */
//import { add as gpuAdd } from '../src/gpu.js';
//  (async () => console.log(`[${fmtTime()}] #16 ${await gpuAdd(2, 3)}`))();

//import { add as npuAdd } from '../src/npu.js';
//  (async () => console.log(`[${fmtTime()}] #19 ${await npuAdd(2, 3)}`))();


// async function main(): Promise<void> {
//   const sum = await add(2, 3);
//   console.log(`2 + 3 = ${sum} (on NPU)`);
// }
// main()

import "../src/globals.js"
import fs from "node:fs";
import { ReconnectingWs } from "../src/ws-client.js";
import { findSymbolRow } from "../src/cli-utils.js";
import { base64UrlDecode } from "../src/http-client.js";
import { loadCredentials } from "../src/credentials.js";
import { 
  placeLimitOrder, 
  cancelOrders, 
  setLeverageUsdtM,
  placeMarketOrder
 } from "../src/place-limit-order.js";
import {
  fetchPositions,
  closePosition,
  Position,
} from "../src/positions.js";

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

const LONG_PID_FILE = ".long-limit.pid";
const SHORT_PID_FILE = ".short-limit.pid";

const WS_URL = "wss://ws.phemex.com";
const SYMBOL_DEFAULT = "XBRUSDT";
const POLL_INTERVAL_MS = 2_000;

/* ── Auto-trader configuration (tune these) ───────────────────────── */
const AUTO_TRADE_ENABLED = true;      // master switch for placing real orders
const AUTO_TRADE_LEVERAGE = 100;      // leverage used for bot positions
const AUTO_TRADE_QTY = 0.01;          // position size (also filters our own fills)
const ENTRY_STREAK_MIN = 1;           // consecutive ↓/↑ ticks confirming a move has started
const ENTRY_DELTA_MIN = 0.25;         // shared threshold for the ≥ markers in the trade log
const ENTRY_DELTA_MIN_LONG = 0.30;    // $ move from streak start required to open a Long
const ENTRY_DELTA_MIN_SHORT = 0.20;   // $ move from streak start required to open a Short
const ALLOW_LONG_ENTRY = false;        // enable/disable the bot opening Long positions
const ALLOW_SHORT_ENTRY = false;       // enable/disable the bot opening Short positions
const ALLOW_FETCH_POSITION = false;
const OWN_FILL_WINDOW_MS = 10_000;    // window in which a fill from an order the bot just placed may arrive

/* Parse CLI flags like --symbol XTIUSDT */
function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}

const SYMBOL = parseArg("symbol") ?? SYMBOL_DEFAULT;
const PRICE_FILE = `${(parseArg("symbol") ?? "xbrusdt").toLowerCase()}-last-price.txt`;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function fmtTime(): string {
  return new Date().toLocaleString();
}

function fmtNum(n: number, d: number = 2): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** Format a millisecond duration as `0s`, `1s`, `1m 47s`, … */
function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}m ${rem}s` : `${rem}s`;
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
/** Set synchronously before the entry order's awaits so a second qualifying trade
 *  can't pass the guard while the first market order is still in flight. */
let botEntryPending = false;
/** Fill expected from the order the bot just placed (side+qty), so its own fills aren't misread as signals */
let pendingOwnFill: { side: "Buy" | "Sell"; qty: number; expiresAt: number } | null = null;
/** Previous arrow direction — used to detect flips and close the bot position */
let prevDirection: "↑" | "↓" = "↑";
/** API credentials, set once in main() */
let apiKey = "";
let secretRaw: Buffer = Buffer.alloc(0);
let symbol: string;

const creds = loadCredentials();
apiKey = creds.PHEMEX_API_KEY;
secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

function updateDirection(last: number, prev: number): void {
  // First tick after startup — seed the streak baseline from the first real
  // price instead of measuring the delta from the 0 sentinel (lastTickerPrice).
  if (!prev) {
    streakStartPrice = last;
    streak = 1;
    return;
  }
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

/**
 * True when `trade` looks like the fill of an order this bot just placed:
 * side and qty match the last order and it arrived within OWN_FILL_WINDOW_MS.
 * The expectation is consumed on the first match.
 */
function isOwnFill(trade: unknown[]): boolean {
  if (!pendingOwnFill) return false;
  if (Date.now() > pendingOwnFill.expiresAt) {
    pendingOwnFill = null; // window elapsed — not our fill
    return false;
  }
  const side = String(trade[1]);
  const qty = Number(trade[3]);
  if (side !== pendingOwnFill.side || Math.abs(qty - pendingOwnFill.qty) > 1e-9) return false;
  pendingOwnFill = null; // consumed — our fill
  return true;
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

  const now = fmtTime();
  const sign = changePct >= 0 ? "+" : "";
  const priceStr = `$${last.toFixed(2)}`;
  const highStr = `H: $${high.toFixed(2)}`;
  const lowStr = `L: $${low.toFixed(2)}`;
  const chgStr = `Chg: ${sign}${changePct.toFixed(2)}%`;
  const volStr = `Vol: ${volume.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

  const line = `${symbol}  ${priceStr}  ${highStr}  ${lowStr}  ${chgStr}  ${volStr}`;

  // if (last !== lastTickerPrice) {
    updateDirection(last, lastTickerPrice);
    const delta = last - streakStartPrice;
    const deltaStr = delta >= 0 ? `Δ+$${delta.toFixed(2)}` : `Δ-$${Math.abs(delta).toFixed(2)}`;
    const streakStr = ` (${direction}×${streak}, ${deltaStr})`;
    console.log(`[${now}] #188 ` + line + streakStr);
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
  /** ms timestamp of the last processed trade — used to print elapsed time since the previous line */
  static lastLogTimeMs: number | null = null;

  /** Set to true when the direction just changed on the most recent process_trade call. */
  static directionChanged: boolean = false;
  /** The direction value BEFORE the most recent process_trade call (for flip logging). */
  static prevPrevDirection: string | null = null;

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
    const [timestamp, side, price, quantity] = trade;
    const p = Number(price);
    const tsMs = Number(timestamp / 1e6);
    const date = new Date(tsMs);
    let arrow = '';
    let delta = 0;
    let sign = '';
    let dir: any;
    if (this.prevPrice !== null) {
      dir = p > this.prevPrice ? '↑' : p < this.prevPrice ? '↓' : this.prevDirection;
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
      // arrow = this.streak > 1 ? `${dir}${this.streak}` : dir;
      arrow = `${dir}x${this.streak}`;
      this.prevDirection = dir;
    } else {
      this.streak = 1;
      this.streakStartPrice = p;
      this.prevDirection = '→';
    }
    const deltaStr = `${sign}${delta.toFixed(2)}`.padStart(5);
    const lastDelta = this.prevPrice !== null ? p - this.prevPrice : 0;
    const lastDeltaStr = this.prevPrice !== null ? (lastDelta >= 0 ? '+' : '') + lastDelta.toFixed(2) : '';
    const bigMove = Math.abs(lastDelta) >= ENTRY_DELTA_MIN ? `≥${ENTRY_DELTA_MIN}` : "";

    const lastDeltaMinLong = lastDelta >= ENTRY_DELTA_MIN_LONG ? `≥${ENTRY_DELTA_MIN_LONG.toFixed(2)}` : "";
    const streakDeltaMinLong = delta >= ENTRY_DELTA_MIN_LONG ? `≥${ENTRY_DELTA_MIN_LONG.toFixed(2)}` : "";
    const lastDeltaMinShort = lastDelta <= -ENTRY_DELTA_MIN_SHORT ? `≤-${ENTRY_DELTA_MIN_SHORT.toFixed(2)}` : "";
    const streakDeltaMinShort = delta <= -ENTRY_DELTA_MIN_SHORT ? `≤-${ENTRY_DELTA_MIN_SHORT.toFixed(2)}` : "";
        
    arrow = arrow ? `${arrow.padStart(2)}` : '';

    // Elapsed time since the previous line, from the trades' own timestamps
    let elapsedStr = "";
    if (this.lastLogTimeMs !== null) {
      elapsedStr = `${fmtElapsed(Math.max(0, tsMs - this.lastLogTimeMs))}`;
    }
    this.lastLogTimeMs = tsMs;
    // console.log(
    //   `[${date.toLocaleString().padEnd(22)}] #325 ${side.padEnd(4)} ${('$' + Number(price).toFixed(2)).padStart(6)} ${Number(quantity).toFixed(2).padStart(5)} ${lastDeltaStr.padStart(5)} ${arrow.padEnd(6)} ${(Math.abs(delta) >= ENTRY_DELTA_MIN ? "≥" + ENTRY_DELTA_MIN : "").padEnd(5)} ${bigMove.padEnd(3)}`
    // );
    // Fixed-width columns: ts(24) symbol(8) side(5) qty(6) price(9)
    // delta(24) then the four optional flag columns (7 each).
    console.log(
      (
        `[${date.toLocaleString()}]`.padEnd(24) +
        `${symbol} `.padEnd(8) +
        `${side.padStart(4)} ` +
        `${Number(quantity).toFixed(2).padStart(5)} ` +
        `${(dir + '$' + Number(price).toFixed(2)).padStart(8)} ` +
        `${arrow.padEnd(4)} Δ${deltaStr} ${lastDeltaStr.padStart(6)} ${elapsedStr.padEnd(6)}` +
        ` ${streakDeltaMinShort.padEnd(6)} ` +
        `${lastDeltaMinShort.padEnd(6)} ` +
        `${streakDeltaMinLong.padEnd(6)} ` +
        `${lastDeltaMinLong.padEnd(6)} `
      ).trimEnd()
    );
    this.prevPrice = p;
  }

  /**
   * Auto-trade: enter/exit bot positions based on the current streak/direction
   * state (set by the most recent process_trade call).
   *
   * Entry — the BEGINNING of a move:
   * - Long  when a rise is starting: ≥ ENTRY_STREAK_MIN consecutive ↑ ticks
   *   with a cumulative Δ ≥ ENTRY_DELTA_MIN_LONG from the streak start.
   * - Short when a drop is starting: ≥ ENTRY_STREAK_MIN consecutive ↓ ticks
   *   with a cumulative Δ ≤ -ENTRY_DELTA_MIN_SHORT from the streak start.
   *
   * Exit — the END of the move:
   * - When the direction flips (the graph starts going the other way) the bot
   *   position is closed with a market order.
   * - The polling loop in main() additionally closes the position when the
   *   PnL declines (trailing stop from the PnL peak / hard stop).
   *
   * Must be called AFTER process_trade() with the same trade tuple.
   *
   * @param exitOnly when true (1000-trade batch replays), only the flip-exit
   *                 is evaluated — historical streaks must not open positions.
   */
  static async auto_trade(trade: unknown[], exitOnly = false): Promise<void> {
    if (!AUTO_TRADE_ENABLED) return;
    if (this.prevPrice === null) return;               // nothing to evaluate on the very first trade

    try {
      const price = Number(trade[2]);
      const symbol = SYMBOL;

      // ── Exit: direction flipped → the move is over, close the bot position ──
      if (botPosition && this.directionChanged && ALLOW_FETCH_POSITION) {
        // allPositions is refreshed every POLL_INTERVAL_MS; fall back to a fresh
        // fetch so a just-opened position is found even if the cache is stale.
        const pos = allPositions.find((p) => p.symbol === symbol)
          ?? (await fetchPositions(apiKey, secretRaw)).find((p) => p.symbol === symbol);
        if (pos) {
          console.log(
            `[${fmtTime()}] #386 ⟐  ${botPosition.side} flip → closing bot ${symbol} ` +
            `(entry $${botPosition.entryPrice} → $${price}) …`,
          );
          await closePosition(pos, apiKey, secretRaw);
        }
        botPosition = null;
        this.lastLongPrice = null;
        this.lastShortPrice = null;
      }

      // One position at a time — the pending flag is claimed synchronously before
      // any await, so concurrent trades can't open a second position.
      if (botPosition || botEntryPending) return;

      // Batch replays evaluate the exit only — historical streaks must not open
      // new positions.  Own fills are also filtered here (they must not be read
      // as signals), but only AFTER the exit above, so a flip trade that is also
      // our own fill can still close the position.
      if (exitOnly || isOwnFill(trade)) return;

      const delta = this.streakStartPrice !== null ? price - this.streakStartPrice : 0;

      // ── Entry: beginning of a rise → Long ─────────────────────────────
      if (ALLOW_LONG_ENTRY && this.prevDirection === "↑" && this.streak >= ENTRY_STREAK_MIN && delta >= ENTRY_DELTA_MIN_LONG) {
        // if (this.lastLongPrice && price < this.lastLongPrice) return; // don't chase a lower price
        console.log(`[${fmtTime()}] #412 🟢  Rise detected (↑${this.streak}, Δ+$${delta.toFixed(2)}) — opening Long ${symbol} @ $${price} …`);
        botEntryPending = true; // claim the slot before any await — prevents a double open
        pendingOwnFill = { side: "Buy", qty: AUTO_TRADE_QTY, expiresAt: Date.now() + OWN_FILL_WINDOW_MS };
        try {
          await setLeverageUsdtM(symbol, AUTO_TRADE_LEVERAGE, "Long", apiKey, secretRaw);
          const result = await placeMarketOrder(
            { account: "usdt-m", symbol, posSide: "Long", price, qty: AUTO_TRADE_QTY, side: "Buy" },
            apiKey,
            secretRaw,
          );
          this.lastLongPrice = price;
          botPosition = { side: "Long", entryPrice: price };
          console.log(`[${fmtTime()}] #424 ✓  Long ${symbol} opened @ $${price}  code: ${(result as Record<string, unknown>).code}`);
        } finally {
          botEntryPending = false; // release on success or failure
        }
        return;
      }

      // ── Entry: beginning of a drop → Short ────────────────────────────
      if (ALLOW_SHORT_ENTRY && this.prevDirection === "↓" && this.streak >= ENTRY_STREAK_MIN && delta <= -ENTRY_DELTA_MIN_SHORT) {
        // if (this.lastShortPrice && price > this.lastShortPrice) return; // don't chase a higher price
        console.log(`[${fmtTime()}] #434 🔴  Drop detected (↓${this.streak}, Δ-$${Math.abs(delta).toFixed(2)}) — opening Short ${symbol} @ $${price} …`);
        botEntryPending = true; // claim the slot before any await — prevents a double open
        pendingOwnFill = { side: "Sell", qty: AUTO_TRADE_QTY, expiresAt: Date.now() + OWN_FILL_WINDOW_MS };
        try {
          await setLeverageUsdtM(symbol, AUTO_TRADE_LEVERAGE, "Short", apiKey, secretRaw);
          const result = await placeMarketOrder(
            { account: "usdt-m", symbol, posSide: "Short", price, qty: AUTO_TRADE_QTY, side: "Sell" },
            apiKey,
            secretRaw,
          );
          this.lastShortPrice = price;
          botPosition = { side: "Short", entryPrice: price };
          console.log(`[${fmtTime()}] #446 ✓  Short ${symbol} opened @ $${price}  code: ${(result as Record<string, unknown>).code}`);
        } finally {
          botEntryPending = false; // release on success or failure
        }
        return;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${fmtTime()}] #452 ✗  auto_trade error: ${msg}`);
    }
  }
}

/*  Main                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {

  console.log(`[${fmtTime()}] #502 ═ XBRUSDT WS Monitor (read-only) ═══════════════════════════`);
  console.log(`[${fmtTime()}] #503   Symbol:       ${SYMBOL}`);
  console.log(`[${fmtTime()}] #504   Position poll: every ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`[${fmtTime()}] #505 ═════════════════════════════════════════════════════════════`);

  // ---------------------------------------------------------------
  // WebSocket — ticker + trade feed
  // ---------------------------------------------------------------
  const ws = new ReconnectingWs(WS_URL, {
    onOpen: () => {
      ws.send({ method: "perp_market24h_pack_p.subscribe", params: [SYMBOL], id: 1 });
      ws.send({ method: "trade_p.subscribe", params: [SYMBOL], id: 2 });
    },
    onMessage: async (msg) => {
      try {
        const m = msg as Record<string, unknown>;
        symbol = m.symbol as string;
        // console.log(m)
        if(msg.trades_p && msg.trades_p.length == 1000){
          TradeBatchProcessor.reset();
          for (const trade of msg.trades_p.reverse()) {
            TradeBatchProcessor.process_trade(trade);
            // Exit-only pass: a flip inside the historical batch must still
            // close the bot position, but batch streaks must not open one.
            await TradeBatchProcessor.auto_trade(trade, true);
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

        // Real-time trades
        if (m.trades_p && m.symbol === SYMBOL && m.trades_p.length != 1000) {
          // console.log("Received")
          // console.log(m.trades_p.length)
          const trades = m.trades_p as unknown[][];
          if (trades.length > 0) {
            for (const trade of trades) {
              // console.log(trade)
              TradeBatchProcessor.process_trade(trade);
              await TradeBatchProcessor.auto_trade(trade);
            }
          }
        }
      } catch (err: unknown) {
        const emsg = err instanceof Error ? err.message : String(err);
        console.error(`[${fmtTime()}] #516 ✗  onMessage error: ${emsg}`);
      }
    },
    onReconnect: (delayMs) => {
      process.stdout.write("\n");
      console.log(`[${fmtTime()}] #514 ⟐  WebSocket reconnecting in ${delayMs / 1000}s …`);
    },
  });

  ws.connect();

  // ---------------------------------------------------------------
  // Position polling loop (REST)
  // ---------------------------------------------------------------
  let running = true;

  process.on("SIGINT", () => {
    console.log(`\n[${fmtTime()}] #526 ⏹  Shutting down …`);
    running = false;
    ws.shutdown();
    process.exit(0);
  });

  while (running) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    if (!running) break;

    try {
      if (ALLOW_FETCH_POSITION)
      {
        const positions = await fetchPositions(creds.PHEMEX_API_KEY, secretRaw);
        allPositions = positions;
        const pos = positions.find((p) => p.symbol === SYMBOL);

        if (!pos) {
          // Position gone (closed by the flip exit, a stop, or manually) — reset tracking.
          botPosition = null;
          continue;
        }

        const entry = parseFloat(pos.avgEntryPriceRp || "0");
        const mark = parseFloat(pos.markPriceRp || "0");
        const size = parseFloat(pos.size || "0");
        const margin = parseFloat(pos.posCostRv || "0");

        const pnl = pos.side === "Buy" ? (mark - entry) * size : (entry - mark) * size; // PnL from the data structure
        const pnlPct = margin > 0 ? (pnl / margin) * 100 : 0;
        console.log(
          `[${fmtTime()}] #554 ${SYMBOL}  ${pos.side.padEnd(4)}  ` +
          `size: ${fmtNum(size, 4)}  entry: $${fmtNum(entry)}  mark: $${fmtNum(mark)}  ` +
          `PnL: ${pnl >= 0 ? "+" : "-"}$${fmtNum(Math.abs(pnl), 8)} (${pnlPct >= 0 ? "+" : ""}${fmtNum(pnlPct, 8)}%)  `
        );

        // Adopt a position this process didn't open (previous run / another
        // script) so the flip-exit can still manage it.  Only bot-sized
        // positions are adopted, so manual positions are left alone.
        if (botPosition === null && !botEntryPending && Math.abs(size - AUTO_TRADE_QTY) < 1e-9) {
          botPosition = { side: pos.side === "Buy" ? "Long" : "Short", entryPrice: entry };
          console.log(
            `[${fmtTime()}] #566 ⟐  Adopted existing ${SYMBOL} ${pos.side} ` +
            `(${fmtNum(size, 4)} @ $${fmtNum(entry)}) — flip-exit active`,
          );
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${fmtTime()}] #574  ✗  Position poll error: ${msg}`);
    }
  }

  console.log(`[${fmtTime()}] #578 ✅  Monitor stopped`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`[${fmtTime()}] #583 Fatal:`, err instanceof Error ? err.message : String(err));
  process.exit(1);
});
