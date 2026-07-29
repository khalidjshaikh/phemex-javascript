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

import fs from "node:fs";
import { ReconnectingWs } from "./src/ws-client.js";
import { findSymbolRow } from "./src/cli-utils.js";
import { base64UrlDecode } from "./src/http-client.js";
import { loadCredentials } from "./src/credentials.js";
import { placeLimitOrder, setLeverageUsdtM } from "./src/place-limit-order.js";
import {
  fetchPositions,
  calcPnlPct,
  closePosition,
  Position,
} from "./src/lib/positions.js";

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

const PRICE_FILE = "xbrusdt-last-price.txt";
const LONG_PID_FILE = ".long-limit.pid";
const SHORT_PID_FILE = ".short-limit.pid";

const WS_URL = "wss://ws.phemex.com";
const SYMBOL = "XBRUSDT";
const POLL_INTERVAL_MS = 2_000;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function fmtTime(): string {
  return new Date().toLocaleString();
}

function fmtNum(n: number, d: number = 2): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

let lastTickerPrice = 0;
let direction: "↑" | "↓" = "↑";
let streak = 0;
/** All open positions across all symbols, refreshed every POLL_INTERVAL_MS */
let allPositions: Position[] = [];
/** Tracks a position opened by the auto-trader so we know when to close it */
let botPosition: { side: "Long" | "Short"; qty: number; entryPrice: number } | null = null;
/** Previous arrow direction — used to detect flips and close the bot position */
let prevDirection: "↑" | "↓" = "↑";
/** API credentials, set once in main() */
let apiKey = "";
let secretRaw: Buffer = Buffer.alloc(0);

function updateDirection(last: number, prev: number): void {
  if (last > prev) {
    if (direction === "↑") streak++;
    else { direction = "↑"; streak = 1; }
  } else if (last < prev) {
    if (direction === "↓") streak++;
    else { direction = "↓"; streak = 1; }
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
    const streakStr = ` (${direction}×${streak})`;
    console.log(line + streakStr);
    lastTickerPrice = last;
    savePrice(last);
    notifyLimitScripts();
  // }
}

/* ------------------------------------------------------------------ */
/*  Trade print (from trade_p channel)                                 */
/* ------------------------------------------------------------------ */

async function printTrade(symbol: string, price: number): Promise<void> {
  if (price !== lastTickerPrice) {
    console.log(price, lastTickerPrice)
    updateDirection(price, lastTickerPrice);
    const arrow = direction;
    const streakStr = ` (${arrow}×${streak})`;
    console.log(`${fmtTime()}  ${symbol}  ${arrow} $${price.toFixed(2)}${streakStr}`);

    // ── Auto-trade logic ──────────────────────────────────────────
    const delta = price - lastTickerPrice;

    // Close bot position when the arrow flips
    if (botPosition && direction !== prevDirection) {
      const pos = allPositions.find((p) => p.symbol === symbol);
      if (pos) {
        await closePosition(pos, apiKey, secretRaw);
      }
      botPosition = null;
    }

    // Enter new position when conditions are met
    if (!botPosition) {
      if ((streak >= 3 || delta > 0.10) && lastTickerPrice != 0) {
        await setLeverageUsdtM(symbol, 100, "Long", apiKey, secretRaw);
        await placeLimitOrder(
          {
            account: "usdt-m",
            symbol,
            side: "Buy",
            price,
            qty: 0.01,
            posSide: "Long",
            timeInForce: "GoodTillCancel",
            stopLoss: +(price - 0.01).toFixed(2),
          },
          apiKey,
          secretRaw,
        );
        botPosition = { side: "Long", qty: 0.01, entryPrice: price };
        console.log(`[${fmtTime()}]  🤖  LONG limit @ $${price.toFixed(2)}  SL: $${(price - 0.01).toFixed(2)}`);
      } else if ((streak >= 3 || delta < -0.10) && lastTickerPrice != 0) {
        await setLeverageUsdtM(symbol, 100, "Short", apiKey, secretRaw);
        await placeLimitOrder(
          {
            account: "usdt-m",
            symbol,
            side: "Sell",
            price,
            qty: 0.01,
            posSide: "Short",
            timeInForce: "GoodTillCancel",
            stopLoss: +(price + 0.01).toFixed(2),
          },
          apiKey,
          secretRaw,
        );
        botPosition = { side: "Short", qty: 0.01, entryPrice: price };
        console.log(`[${fmtTime()}]  🤖  SHORT limit @ $${price.toFixed(2)}  SL: $${(price + 0.01).toFixed(2)}`);
      }
    }

    prevDirection = direction;
    // ───────────────────────────────────────────────────────────────

    lastTickerPrice = price;
    savePrice(price);
    notifyLimitScripts();
  }
}

/* ------------------------------------------------------------------ */
/*  Main                                                              */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const creds = loadCredentials(import.meta.dirname);
  apiKey = creds.PHEMEX_API_KEY;
  secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

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
      if (m.trades_p && m.symbol === SYMBOL) {
        const trades = m.trades_p as unknown[][];
        if (trades.length > 0 && trades[0].length >= 3) {
          const last = Number(trades[0][2]);
          await printTrade(SYMBOL, last);
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
