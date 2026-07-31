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
import "./src/lib/globals.js"
import fs from "node:fs";
import { ReconnectingWs } from "./src/ws-client.js";
import { findSymbolRow } from "./src/cli-utils.js";
import { base64UrlDecode } from "./src/http-client.js";
import { loadCredentials } from "./src/credentials.js";
import { 
  placeLimitOrder, 
  cancelOrders, 
  setLeverageUsdtM,
  placeMarketOrder
 } from "./src/place-limit-order.js";
import {
  fetchPositions,
  calcPnlPct,
  closePosition,
  Position,
} from "./src/lib/positions.js";

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

const LONG_PID_FILE = ".long-limit.pid";
const SHORT_PID_FILE = ".short-limit.pid";

const WS_URL = "wss://ws.phemex.com";
const SYMBOL_DEFAULT = "XBRUSDT";
const POLL_INTERVAL_MS = 2_000;

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
let botPosition: { side: "Long" | "Short"; qty: number; entryPrice: number } | null = null;
/** Previous arrow direction — used to detect flips and close the bot position */
let prevDirection: "↑" | "↓" = "↑";
/** API credentials, set once in main() */
let apiKey = "";
let secretRaw: Buffer = Buffer.alloc(0);

const creds = loadCredentials(import.meta.dirname);
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
    const bigMove = Math.abs(lastDelta) >= 0.10 ? '≥0.10' : '';
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
   * - Closes the bot position when the direction arrow flips.
   * - Enters a Long position when streak≥3 with positive Δ or Δ≥$0.10.
   * - Enters a Short position when streak≥3 with negative Δ or Δ≤−$0.10.
   *
   * Must be called AFTER process_trade() with the same trade tuple.
   */
  static async auto_trade(trade: unknown[]): Promise<void> {
    const price = Number(trade[2]);
    const symbol = SYMBOL;

    // Nothing to evaluate on the very first trade of a batch
    if (this.prevPrice === null) return;

    // ── Close bot position when the arrow flips ──────────────────
    if (botPosition && this.directionChanged) {
      this.lastShortPrice = null;

      await cancelOrders({ symbol }, apiKey, secretRaw);
      // console.log(
      //   `[${fmtTime()}]  🗑  Cancelled all ${this.prevPrevDirection === "↑" ? "Long" : "Short"} orders`,
      // );
      const pos = allPositions.find((p) => p.symbol === symbol);
      if (pos) {
        await closePosition(pos, apiKey, secretRaw);
      }
      botPosition = null;
    }

    // ── Enter new position when conditions are met ───────────────
    const streakDelta =
      this.streakStartPrice !== null
        ? price - this.streakStartPrice
        : 0;

    if ((this.streak >= 3 && streakDelta > 0) || streakDelta >= 0.10) {
      console.log(this.lastLongPrice, price)
      if (this.lastLongPrice && this.lastLongPrice >= price) return;

        {
          let posSide = "Long"
          let symbol = "XBRUSDT"
          await setLeverageUsdtM(symbol, 100, posSide, creds.PHEMEX_API_KEY, secretRaw);
          const result = await placeMarketOrder(
          {
            account: "usdt-m", symbol, posSide, price, qty: 0.01,
            side: "Buy"
          },
          creds.PHEMEX_API_KEY,
          secretRaw,
          );
        }
        this.lastLongPrice = price;

      // await setLeverageUsdtM(symbol, 100, "Long", apiKey, secretRaw);
      // await placeLongLimitOrders(price, 10, symbol, apiKey, secretRaw);
      // this.lastShortPrice = null;
      //await placeShortLimitOrders(price, 10, symbol, apiKey, secretRaw);
      botPosition = { side: "Long", entryPrice: price };
    } else if ((this.streak >= 3 && streakDelta < 0) || streakDelta <= -0.10) {
      console.log(this.lastLongPrice, price)
      if (this.lastLongPrice && this.lastShortPrice <= price) return;

      { 
        let posSide = "Short"
        let symbol = "XBRUSDT"
        await setLeverageUsdtM(symbol, 100, posSide, creds.PHEMEX_API_KEY, secretRaw);
        const result = await placeMarketOrder(
          {
            account: "usdt-m", symbol, posSide, price: price, qty: 0.01,
            side: "Sell"
          },
          creds.PHEMEX_API_KEY,
          secretRaw,
        );
      }
      this.lastLongPrice = price;

      // await setLeverageUsdtM(symbol, 100, "Short", apiKey, secretRaw);
      // await placeShortLimitOrders(price, 10, symbol, apiKey, secretRaw);
      // this.lastLongPrice = null;
      //await placeLongLimitOrders(price, 10, symbol, apiKey, secretRaw);
      botPosition = { side: "Short", entryPrice: price };
    }
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
  let maxPnlPct: number | null = null; // peak PnL% seen since monitor start (trailing stop anchor)

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

      // Trailing stop: track the peak PnL% and close if the current PnL%
      // deviates to less than 10% of that peak (e.g. peak +20% → close below +2%).
      // Positions that never reach a positive peak keep the -10% hard stop.
      if (maxPnlPct === null || pnlPct > maxPnlPct) maxPnlPct = pnlPct;
      const stopFloor = maxPnlPct > 0 ? maxPnlPct * 0.1 : -10;
      if (pnlPct < stopFloor) {
        console.log(
          `[${fmtTime()}]  🛑  STOP-LOSS TRIGGERED — PnL ${fmtNum(pnlPct, 2)}% < ` +
          `${fmtNum(stopFloor, 2)}% (floor, peak ${fmtNum(maxPnlPct, 2)}%). Closing position …`
        );
        await closePosition(pos, apiKey, secretRaw);
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
