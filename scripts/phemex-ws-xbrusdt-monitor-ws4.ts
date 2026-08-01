#!/usr/bin/env npx tsx
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
const SYMBOL_DEFAULT = "XBRUSDT";
const POLL_INTERVAL_MS = 2_000;

/* ── Auto-trader configuration (tune these) ───────────────────────── */
const AUTO_TRADE_ENABLED = true;      // master switch for placing real orders
const AUTO_TRADE_LEVERAGE = 100;      // leverage used for bot positions
const AUTO_TRADE_QTY = 0.01;          // position size (also filters our own fills)
const ENTRY_STREAK_MIN = 2;           // consecutive ↓/↑ ticks confirming a move has started
const ENTRY_DELTA_MIN = 0.15;         // $ move from streak start marking a "long" drop/rise
const TRAILING_PNL_PCT = 5;          // close bot position if PnL% gives back this many points from peak
const HARD_STOP_PNL_PCT = -10;        // close bot position if PnL% (margin-based) falls below this
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

//homelastTickerPrice ??= 0
//lastTradePrice ??= 0
// streak ??= 0
// streakStartPrice ??= 0

let direction: "↑" | "↓" = "↑";
/** All open positions across all symbols, refreshed every POLL_INTERVAL_MS */
let allPositions: Position[] = [];
/** Tracks a position opened by the auto-trader so we know when to close it */
let botPosition: { side: "Long" | "Short"; entryPrice: number } | null = null;
/** Fill expected from the order the bot just placed (side+qty), so its own fills aren't misread as signals */
let pendingOwnFill: { side: "Buy" | "Sell"; qty: number; expiresAt: number } | null = null;
/** Peak PnL% reached by the current bot position (anchor for the PnL-decline stop) */
let botMaxPnlPct: number | null = null;
/** Peak PnL% seen since monitor start (anchor for the generic trailing stop) */
let maxPnlPct: number | null = null;
/** Previous arrow direction — used to detect flips and close the bot position */
let prevDirection: "↑" | "↓" = "↑";
/** API credentials, set once in main() */
let apiKey = "";
let secretRaw: Buffer = Buffer.alloc(0);

const creds = loadCredentials();
apiKey = creds.PHEMEX_API_KEY;
secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

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

  const line = `${now}  ${symbol}  ${priceStr}  ${highStr}  ${lowStr}  ${chgStr}  ${volStr}`;

  // if (last !== lastTickerPrice) {
    updateDirection(last, lastTickerPrice);
    const delta = last - streakStartPrice;
    const deltaStr = delta >= 0 ? `Δ+$${delta.toFixed(2)}` : `Δ-$${Math.abs(delta).toFixed(2)}`;
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
    const deltaStr = `${sign}${delta.toFixed(2)}`.padStart(5);
    const lastDelta = this.prevPrice !== null ? p - this.prevPrice : 0;
    const lastDeltaStr = this.prevPrice !== null ? (lastDelta >= 0 ? '+' : '') + lastDelta.toFixed(2) : '';
    const bigMove = Math.abs(lastDelta) >= 0.15 ? '≥0.15' : '';
    arrow = arrow ? `${arrow.padEnd(3)} Δ${deltaStr.padEnd(5)}` : '';
    console.log(
      `${date.toLocaleString().padEnd(22)} ${side.padEnd(4)} ${('$' + Number(price).toFixed(2)).padStart(6)} ${Number(quantity).toFixed(2).padStart(5)} ${lastDeltaStr.padStart(5)} ${arrow.padEnd(6)} ${bigMove.padEnd(3)}`
    );
    this.prevPrice = p;
  }

  /**
   * Auto-trade: enter/exit bot positions based on the current streak/direction
   * state (set by the most recent process_trade call).
   *
   * Entry — the BEGINNING of a move:
   * - Long  when a rise is starting: ≥ ENTRY_STREAK_MIN consecutive ↑ ticks
   *   with a cumulative Δ ≥ ENTRY_DELTA_MIN from the streak start.
   * - Short when a drop is starting: ≥ ENTRY_STREAK_MIN consecutive ↓ ticks
   *   with a cumulative Δ ≤ -ENTRY_DELTA_MIN from the streak start.
   *
   * Exit — the END of the move:
   * - When the direction flips (the graph starts going the other way) the bot
   *   position is closed with a market order.
   * - The polling loop in main() additionally closes the position when the
   *   PnL declines (trailing stop from the PnL peak / hard stop).
   *
   * Must be called AFTER process_trade() with the same trade tuple.
   */
  static async auto_trade(trade: unknown[]): Promise<void> {
    if (!AUTO_TRADE_ENABLED) return;
    if (this.prevPrice === null) return;               // nothing to evaluate on the very first trade
    if (isOwnFill(trade)) return;                      // ignore fills from orders this bot just placed

    const price = Number(trade[2]);
    const symbol = SYMBOL;

    // ── Exit: direction flipped → the move is over, close the bot position ──
    if (botPosition && this.directionChanged) {
      // allPositions is refreshed every POLL_INTERVAL_MS; fall back to a fresh
      // fetch so a just-opened position is found even if the cache is stale.
      const pos = allPositions.find((p) => p.symbol === symbol)
        ?? (await fetchPositions(apiKey, secretRaw)).find((p) => p.symbol === symbol);
      if (pos) {
        console.log(
          `[${fmtTime()}]  ⟐  ${botPosition.side} flip → closing bot ${symbol} ` +
          `(entry $${botPosition.entryPrice} → $${price}) …`,
        );
        pendingOwnFill = {
          side: pos.side === "Buy" ? "Sell" : "Buy",
          qty: parseFloat(pos.size || "0"),
          expiresAt: Date.now() + OWN_FILL_WINDOW_MS,
        };
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

    const delta = this.streakStartPrice !== null ? price - this.streakStartPrice : 0;

    // ── Entry: beginning of a rise → Long ─────────────────────────────
    if (this.prevDirection === "↑" && this.streak >= ENTRY_STREAK_MIN && delta >= ENTRY_DELTA_MIN) {
      // if (this.lastLongPrice && price < this.lastLongPrice) return; // don't chase a lower price
      console.log(`[${fmtTime()}]  🟢  Rise detected (↑${this.streak}, Δ+$${delta.toFixed(2)}) — opening Long ${symbol} @ $${price} …`);
      pendingOwnFill = { side: "Buy", qty: AUTO_TRADE_QTY, expiresAt: Date.now() + OWN_FILL_WINDOW_MS };
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
      const positions = await fetchPositions(creds.PHEMEX_API_KEY, secretRaw);
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
      const floor = Math.max(botMaxPnlPct - TRAILING_PNL_PCT, HARD_STOP_PNL_PCT);
      if (botPosition) {
        if (botMaxPnlPct === null || pnlPct > botMaxPnlPct) botMaxPnlPct = pnlPct;
        if (pnlPct < floor) {
          console.log(
            `[${fmtTime()}]  🛑  BOT PnL DECLINED — PnL ${fmtNum(pnlPct, 2)}% < floor ` +
            `${fmtNum(floor, 2)}% (peak ${fmtNum(botMaxPnlPct, 2)}%). Closing ${botPosition.side} …`
          );
          pendingOwnFill = {
            side: pos.side === "Buy" ? "Sell" : "Buy",
            qty: parseFloat(pos.size || "0"),
            expiresAt: Date.now() + OWN_FILL_WINDOW_MS,
          };
          await closePosition(pos, apiKey, secretRaw);
          botPosition = null;
          botMaxPnlPct = null;
          maxPnlPct = null;
        }
        continue;
      }

      // ── Generic trailing stop for manually-held positions ───────────
      if (maxPnlPct === null || pnlPct > maxPnlPct) maxPnlPct = pnlPct;
      // if (pnlPct < maxPnlPct - TRAILING_PNL_PCT) {
      if (pnlPct < floor) {
        console.log(
          `[${fmtTime()}]  🛑  STOP-LOSS TRIGGERED — PnL ${fmtNum(pnlPct, 2)}% < ` +
          `(floor, peak ${fmtNum(maxPnlPct, 2)}%). Closing position …`
        );
        pendingOwnFill = {
          side: pos.side === "Buy" ? "Sell" : "Buy",
          qty: parseFloat(pos.size || "0"),
          expiresAt: Date.now() + OWN_FILL_WINDOW_MS,
        };
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
