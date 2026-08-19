#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-ws-xtiusdt-trader.ts — XTIUSDT WebSocket auto-trader on USDT-M.
 *
 * Streams real-time data via WebSocket:
 *   • 24h ticker (perp_market24h_pack_p) — ask, bid, last, index, high, low
 *   • Trade feed (trade_p)               — granular price updates + streak detection
 *
 * Trading strategy (maximizes profit through all four operations):
 *   • Open Long  — rise detected: streak up + delta threshold + index divergence
 *   • Open Short — drop detected: streak down + delta threshold + index divergence
 *   • Close Long — direction flips or trailing stop / hard stop hit
 *   • Close Short — direction flips or trailing stop / hard stop hit
 *
 * Risk management:
 *   • Trailing stop: close if PnL% gives back TRAILING_STOP_PCT from peak
 *   • Hard stop:     close if PnL% falls below HARD_STOP_PCT
 *   • Max position:  one position at a time (no hedging by default)
 *
 * Usage:
 *   ./phemex-ws-xtiusdt-trader.ts                     # dry-run (default)
 *   ./phemex-ws-xtiusdt-trader.ts --live              # place real orders
 *   ./phemex-ws-xtiusdt-trader.ts --hedge              # allow both Long + Short
 *   ./phemex-ws-xtiusdt-trader.ts --size 0.02          # position size
 *   ./phemex-ws-xtiusdt-trader.ts --leverage 50        # leverage
 *   ./phemex-ws-xtiusdt-trader.ts --threshold 0.20     # entry delta threshold
 *   ./phemex-ws-xtiusdt-trader.ts --trailing 3         # trailing stop %
 *   ./phemex-ws-xtiusdt-trader.ts --hard-stop -8       # hard stop %
 */

import { ReconnectingWs } from "../src/ws-client.js";
import { findSymbolRow } from "../src/cli-utils.js";
import { base64UrlDecode } from "../src/http-client.js";
import { loadCredentialsLocal } from "../src/credentials.js";
import JSON5 from "json5";
import fs from "node:fs";
import path from "node:path";
import {
  placeMarketOrder,
  setLeverageUsdtM,
} from "../src/place-limit-order.js";
import {
  fetchPositions,
  calcPnlPct,
  closePosition,
  Position,
} from "../src/positions.js";

/* ── Constants ──────────────────────────────────────────────────────── */

const WS_URL = "wss://ws.phemex.com";
const SYMBOL = "XTIUSDT";
const POLL_INTERVAL_MS = 2_000;

/* ── Defaults (overridable via CLI) ─────────────────────────────────── */

const DEFAULT_LEVERAGE = 100;
const DEFAULT_SIZE = 0.01;
const DEFAULT_THRESHOLD = 0.30;     // min $ delta from streak start to enter
const DEFAULT_ENTRY_STREAK = 3;     // min consecutive ticks to confirm move
const DEFAULT_MIN_FAIR_EDGE = 0.02; // index must clear the executable quote
const DEFAULT_TAKE_PROFIT = 0.02;   // estimated net USDT profit per unit
const DEFAULT_FEE_BPS = 10;         // estimated taker fee, per side
const DEFAULT_TRAILING_STOP = 5;    // PnL% trailing stop from peak
const DEFAULT_HARD_STOP = -10;      // PnL% hard stop

/* ── CLI flags ──────────────────────────────────────────────────────── */

function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}
function hasFlag(name: string): boolean {
  const flag = name.startsWith("-") ? name : `--${name}`;
  return process.argv.includes(flag);
}

const DRY_RUN = !hasFlag("live");
const CREDENTIAL = parseArg("credential");
const HEDGE = hasFlag("hedge");
const LEVERAGE = Number(parseArg("leverage")) || DEFAULT_LEVERAGE;
const QTY = Number(parseArg("size")) || DEFAULT_SIZE;
const ENTRY_DELTA = Number(parseArg("threshold")) || DEFAULT_THRESHOLD;
const ENTRY_STREAK_MIN = Number(parseArg("streak")) || DEFAULT_ENTRY_STREAK;
const MIN_FAIR_EDGE = Number(parseArg("min-edge") ?? DEFAULT_MIN_FAIR_EDGE);
const TAKE_PROFIT = Number(parseArg("take-profit") ?? DEFAULT_TAKE_PROFIT);
const FEE_BPS = Number(parseArg("fee-bps") ?? DEFAULT_FEE_BPS);
const TRAILING_STOP_PCT = Number(parseArg("trailing")) || DEFAULT_TRAILING_STOP;
const HARD_STOP_PCT = -Math.abs(Number(parseArg("hard-stop") ?? Math.abs(DEFAULT_HARD_STOP)));

if (hasFlag("help") || hasFlag("h")) {
  console.log(`Usage: scripts/phemex-ws-xtiusdt-trader.ts [options]

Examines ask, bid, index, and last to manage all four actions. It runs in
dry-run mode unless --live is explicitly supplied.

  --live                Place real orders (default: dry-run)
  --credential <name>   Credential profile from .credentials.json (default: .phemex-credentials.json)
  --size <qty>          Position quantity (default: ${DEFAULT_SIZE})
  --leverage <n>        Leverage (default: ${DEFAULT_LEVERAGE})
  --threshold <price>   Last-price momentum required (default: ${DEFAULT_THRESHOLD})
  --streak <ticks>      Consecutive ticks required (default: ${DEFAULT_ENTRY_STREAK})
  --min-edge <price>    Index edge beyond ask/bid (default: ${DEFAULT_MIN_FAIR_EDGE})
  --take-profit <price> Estimated net profit per unit (default: ${DEFAULT_TAKE_PROFIT})
  --fee-bps <bps>       Estimated taker fee per side (default: ${DEFAULT_FEE_BPS})
  --trailing <pct>      PnL trailing distance (default: ${DEFAULT_TRAILING_STOP})
  --hard-stop <pct>     Maximum PnL loss (default: ${DEFAULT_HARD_STOP})
  --hedge               Allow independent Long and Short positions
  --help, -h            Show this help
`);
  process.exit(0);
}

for (const [name, value, allowZero] of [
  ["size", QTY, false], ["leverage", LEVERAGE, false], ["threshold", ENTRY_DELTA, false],
  ["streak", ENTRY_STREAK_MIN, false], ["min-edge", MIN_FAIR_EDGE, true],
  ["take-profit", TAKE_PROFIT, true], ["fee-bps", FEE_BPS, true],
  ["trailing", TRAILING_STOP_PCT, false],
] as const) {
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new Error(`--${name} has an invalid value`);
  }
}

/* ── Credentials ────────────────────────────────────────────────────── */

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

const credentials = CREDENTIAL
  ? loadCredentialProfile(CREDENTIAL)
  : loadCredentialsLocal();
const apiKey = credentials.PHEMEX_API_KEY;
const secretRaw = base64UrlDecode(credentials.PHEMEX_API_SECRET);

/* ── State ──────────────────────────────────────────────────────────── */

let allPositions: Position[] = [];

/** Current bot-opened position (one at a time unless --hedge) */
let botLong: { entryPrice: number; maxPnlPct: number } | null = null;
let botShort: { entryPrice: number; maxPnlPct: number } | null = null;

/** Trade feed streak tracking */
let streak = 0;
let streakStartPrice = 0;
let direction: "↑" | "↓" = "↑";
let prevDirection: "↑" | "↓" = "↑";
let directionChanged = false;

/** Latest ticker snapshot */
let lastPrice = 0;
let bidPrice = 0;
let askPrice = 0;
let indexPrice = 0;
let highPrice = 0;
let lowPrice = 0;
let tickerReady = false;
let actionInFlight = false;

/* ── Helpers ────────────────────────────────────────────────────────── */

function fmtTime(): string {
  return new Date().toLocaleString();
}

function fmtDollar(n: number): string {
  return `$${n.toFixed(2)}`;
}

function fmtPct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function log(...args: unknown[]): void {
  console.log(`[${fmtTime()}]`, ...args);
}

/** Estimated round-trip result per unit using prices that are executable now. */
function estimatedNetPerUnit(side: "Long" | "Short", entry: number): number {
  const exit = side === "Long" ? bidPrice : askPrice;
  if (entry <= 0 || exit <= 0) return Number.NEGATIVE_INFINITY;
  const gross = side === "Long" ? exit - entry : entry - exit;
  const fees = (entry + exit) * FEE_BPS / 10_000;
  return gross - fees;
}

function runAction(label: string, action: () => Promise<void>): void {
  if (actionInFlight) return;
  actionInFlight = true;
  action().catch((err) => log(`✗  ${label}:`, err instanceof Error ? err.message : err))
    .finally(() => { actionInFlight = false; });
}

/* ── Ticker display ─────────────────────────────────────────────────── */

function printTicker(ticker: Record<string, unknown>): void {
  const open = Number(ticker.openRp ?? 0);
  const high = Number(ticker.highRp ?? 0);
  const low = Number(ticker.lowRp ?? 0);
  const last = Number(ticker.lastRp ?? 0);
  // Prefer human-readable Rp fields. Ep fields may be scaled integers.
  const bid = Number(ticker.bidRp ?? ticker.bidEp ?? 0);
  const ask = Number(ticker.askRp ?? ticker.askEp ?? 0);
  const index = Number(ticker.indexRp ?? ticker.indexEp ?? 0);
  const volume = Number(ticker.volumeRq ?? 0);

  if (last > 0) lastPrice = last;
  if (bid > 0) bidPrice = bid;
  if (ask > 0) askPrice = ask;
  if (index > 0) indexPrice = index;
  if (high > 0) highPrice = high;
  if (low > 0) lowPrice = low;
  if (open > 0) tickerReady = true;

  const changePct = open > 0 ? ((last - open) / open) * 100 : 0;
  const sign = changePct >= 0 ? "+" : "";

  process.stdout.write(
    `\r\x1B[K  ${SYMBOL}  ${fmtDollar(last)}  ` +
    `Bid: ${fmtDollar(bid)}  Ask: ${fmtDollar(ask)}  ` +
    `Idx: ${fmtDollar(index)}  ` +
    `H: ${fmtDollar(high)}  L: ${fmtDollar(low)}  ` +
    `Chg: ${sign}${changePct.toFixed(2)}%  ` +
    `Vol: ${volume.toLocaleString(undefined, { maximumFractionDigits: 0 })}  ` +
    `(${direction}×${streak})`
  );
}

/* ── Streak tracking ────────────────────────────────────────────────── */

function updateDirection(price: number, prevPrice: number): void {
  prevDirection = direction;
  if (price > prevPrice) {
    if (direction === "↑") streak++;
    else { direction = "↑"; streak = 1; streakStartPrice = prevPrice; }
  } else if (price < prevPrice) {
    if (direction === "↓") streak++;
    else { direction = "↓"; streak = 1; streakStartPrice = prevPrice; }
  }
  directionChanged = direction !== prevDirection;
}

/* ── Trading actions ────────────────────────────────────────────────── */

async function openLong(price: number): Promise<void> {
  if (DRY_RUN) {
    log(`[DRY-RUN]  🟢  Open Long ${QTY} ${SYMBOL} @ ${fmtDollar(price)}  ${LEVERAGE}x`);
    botLong = { entryPrice: price, maxPnlPct: 0 };
    return;
  }
  log(`🟢  Opening Long ${QTY} ${SYMBOL} @ ${fmtDollar(price)}  ${LEVERAGE}x …`);
  await setLeverageUsdtM(SYMBOL, LEVERAGE, "Long", apiKey, secretRaw);
  const result = await placeMarketOrder(
    { account: "usdt-m", symbol: SYMBOL, side: "Buy", price: 0, qty: QTY, posSide: "Long" },
    apiKey, secretRaw,
  );
  botLong = { entryPrice: price, maxPnlPct: 0 };
  log(`✓  Long opened  orderID: ${result.orderID ?? result.clOrdID ?? "—"}  code: ${(result as Record<string, unknown>).code}`);
}

async function openShort(price: number): Promise<void> {
  if (DRY_RUN) {
    log(`[DRY-RUN]  🔴  Open Short ${QTY} ${SYMBOL} @ ${fmtDollar(price)}  ${LEVERAGE}x`);
    botShort = { entryPrice: price, maxPnlPct: 0 };
    return;
  }
  log(`🔴  Opening Short ${QTY} ${SYMBOL} @ ${fmtDollar(price)}  ${LEVERAGE}x …`);
  await setLeverageUsdtM(SYMBOL, LEVERAGE, "Short", apiKey, secretRaw);
  const result = await placeMarketOrder(
    { account: "usdt-m", symbol: SYMBOL, side: "Sell", price: 0, qty: QTY, posSide: "Short" },
    apiKey, secretRaw,
  );
  botShort = { entryPrice: price, maxPnlPct: 0 };
  log(`✓  Short opened  orderID: ${result.orderID ?? result.clOrdID ?? "—"}  code: ${(result as Record<string, unknown>).code}`);
}

async function closeLong(pos: Position, reason: string): Promise<void> {
  const price = bidPrice;
  if (DRY_RUN) {
    log(`[DRY-RUN]  ✖  Close Long ${SYMBOL} @ ${fmtDollar(price)} — ${reason}`);
    botLong = null;
    return;
  }
  log(`✖  Closing Long ${SYMBOL} @ ${fmtDollar(price)} — ${reason} …`);
  await closePosition(pos, apiKey, secretRaw);
  botLong = null;
  log(`✓  Long closed`);
}

async function closeShort(pos: Position, reason: string): Promise<void> {
  const price = askPrice;
  if (DRY_RUN) {
    log(`[DRY-RUN]  ✖  Close Short ${SYMBOL} @ ${fmtDollar(price)} — ${reason}`);
    botShort = null;
    return;
  }
  log(`✖  Closing Short ${SYMBOL} @ ${fmtDollar(price)} — ${reason} …`);
  await closePosition(pos, apiKey, secretRaw);
  botShort = null;
  log(`✓  Short closed`);
}

/* ── Auto-trade logic (called after each trade batch) ───────────────── */

function checkEntrySignals(): void {
  if (actionInFlight) return;
  if (streak < ENTRY_STREAK_MIN) return;
  if (!tickerReady || lastPrice <= 0 || bidPrice <= 0 || askPrice <= bidPrice || indexPrice <= 0) return;

  const delta = lastPrice - streakStartPrice;

  // Open Long: rising streak + delta exceeds threshold + (optional) index divergence
  if (direction === "↑" && delta >= ENTRY_DELTA && indexPrice - askPrice >= MIN_FAIR_EDGE) {
    const liveLong = allPositions.some((p) => p.symbol === SYMBOL && p.side === "Buy");
    const liveAny = allPositions.some((p) => p.symbol === SYMBOL);
    const botActive = HEDGE ? (botLong !== null || liveLong) : (botLong !== null || botShort !== null || liveAny);
    if (!botActive) {
      runAction("openLong error", () => openLong(askPrice));
    }
  }

  // Open Short: falling streak + delta below -threshold
  if (direction === "↓" && delta <= -ENTRY_DELTA && bidPrice - indexPrice >= MIN_FAIR_EDGE) {
    const liveShort = allPositions.some((p) => p.symbol === SYMBOL && p.side === "Sell");
    const liveAny = allPositions.some((p) => p.symbol === SYMBOL);
    const botActive = HEDGE ? (botShort !== null || liveShort) : (botLong !== null || botShort !== null || liveAny);
    if (!botActive) {
      runAction("openShort error", () => openShort(bidPrice));
    }
  }
}

function checkExitSignals(): void {
  if (actionInFlight) return;
  // Close Long on direction flip
  if (botLong && directionChanged && direction === "↓") {
    const pos = allPositions.find((p) => p.symbol === SYMBOL && p.side === "Buy");
    if (pos && estimatedNetPerUnit("Long", parseFloat(pos.avgEntryPriceRp || "0")) >= TAKE_PROFIT) {
      runAction("closeLong error", () => closeLong(pos, "profitable direction flip ↓"));
    } else if (DRY_RUN) {
      botLong = null;
    }
  }

  // Close Short on direction flip
  if (botShort && directionChanged && direction === "↑") {
    const pos = allPositions.find((p) => p.symbol === SYMBOL && p.side === "Sell");
    if (pos && estimatedNetPerUnit("Short", parseFloat(pos.avgEntryPriceRp || "0")) >= TAKE_PROFIT) {
      runAction("closeShort error", () => closeShort(pos, "profitable direction flip ↑"));
    } else if (DRY_RUN) {
      botShort = null;
    }
  }
}

/* ── Position polling (REST) — trailing stop + hard stop ─────────────── */

async function pollPositions(): Promise<void> {
  try {
    const positions = await fetchPositions(apiKey, secretRaw);
    allPositions = positions;
    const pos = positions.find((p) => p.symbol === SYMBOL);

    if (!pos) {
      // No open position — reset tracking
      if (botLong && !DRY_RUN) {
        log(`  ℹ  Long position gone (closed externally) — resetting`);
        botLong = null;
      }
      if (botShort && !DRY_RUN) {
        log(`  ℹ  Short position gone (closed externally) — resetting`);
        botShort = null;
      }
      return;
    }

    const pnlPct = calcPnlPct(pos);
    const entry = parseFloat(pos.avgEntryPriceRp || "0");
    const mark = parseFloat(pos.markPriceRp || "0");
    const size = parseFloat(pos.size || "0");
    const margin = parseFloat(pos.posCostRv || "0");

    const isLong = pos.side === "Buy";
    const bot = isLong ? botLong : botShort;

    if (bot) {
      // Update peak PnL
      if (pnlPct > bot.maxPnlPct) bot.maxPnlPct = pnlPct;

      const floor = Math.max(bot.maxPnlPct - TRAILING_STOP_PCT, HARD_STOP_PCT);

      log(
        `  ${pos.side === "Buy" ? "🟢" : "🔴"}  ${SYMBOL} ${pos.side}  ` +
        `size: ${size.toFixed(4)}  entry: ${fmtDollar(entry)}  mark: ${fmtDollar(mark)}  ` +
        `PnL: ${fmtPct(pnlPct)}  peak: ${fmtPct(bot.maxPnlPct)}  floor: ${fmtPct(floor)}  ` +
        `margin: ${fmtDollar(margin)}`
      );

      const netPerUnit = estimatedNetPerUnit(isLong ? "Long" : "Short", entry);
      if (netPerUnit >= TAKE_PROFIT && !actionInFlight) {
        const reason = `net target (estimated ${fmtDollar(netPerUnit)}/unit >= ${fmtDollar(TAKE_PROFIT)})`;
        runAction(isLong ? "closeLong error" : "closeShort error", () =>
          isLong ? closeLong(pos, reason) : closeShort(pos, reason));
        return;
      }

      // Trailing stop / hard stop
      if (pnlPct < floor && !actionInFlight) {
        const reason = pnlPct <= HARD_STOP_PCT
          ? `hard stop (PnL ${fmtPct(pnlPct)} < ${fmtPct(HARD_STOP_PCT)})`
          : `trailing stop (PnL ${fmtPct(pnlPct)} < floor ${fmtPct(floor)}, peak ${fmtPct(bot.maxPnlPct)})`;
        runAction(isLong ? "closeLong error" : "closeShort error", () =>
          isLong ? closeLong(pos, reason) : closeShort(pos, reason));
      }
    } else {
      // Position exists but not tracked by bot (opened externally or manually)
      log(
        `  📊  ${SYMBOL} ${pos.side}  ` +
        `size: ${size.toFixed(4)}  entry: ${fmtDollar(entry)}  mark: ${fmtDollar(mark)}  ` +
        `PnL: ${fmtPct(pnlPct)}  margin: ${fmtDollar(margin)}  (external)`
      );
    }
  } catch (err: unknown) {
    log("✗  Position poll error:", err instanceof Error ? err.message : err);
  }
}

/* ── Main ───────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  log(`══ ${SYMBOL} WebSocket Trader ${DRY_RUN ? "(DRY RUN)" : ""} ══════════════════════════`);
  log(`  Symbol:       ${SYMBOL}`);
  log(`  Leverage:     ${LEVERAGE}x`);
  log(`  Size:         ${QTY}`);
  log(`  Entry:        streak ≥ ${ENTRY_STREAK_MIN}  delta ≥ $${ENTRY_DELTA.toFixed(2)}`);
  log(`  Fair edge:    index beyond executable quote by ≥ $${MIN_FAIR_EDGE.toFixed(2)}`);
  log(`  Profit:       estimated net ≥ $${TAKE_PROFIT.toFixed(2)}/unit (fees ${FEE_BPS} bps/side)`);
  log(`  Stops:        trailing ${TRAILING_STOP_PCT}%  hard ${HARD_STOP_PCT}%`);
  log(`  Mode:         ${HEDGE ? "HEDGE (independent Long/Short)" : "ONE-POSITION"}`);
  log(`═════════════════════════════════════════════════════════════════════`);

  // Discover existing exposure before accepting any entry signal.
  await pollPositions();

  /* ── WebSocket ────────────────────────────────────────────────────── */

  const ws = new ReconnectingWs(WS_URL, {
    onOpen: () => {
      // Subscribe to 24h ticker for all USDT-M symbols (columnar format)
      ws.send({ method: "perp_market24h_pack_p.subscribe", params: [SYMBOL], id: 1 });
      // Subscribe to real-time trade feed for XTIUSDT
      ws.send({ method: "trade_p.subscribe", params: [SYMBOL], id: 2 });
    },
    onMessage: async (msg) => {
      const m = msg as Record<string, unknown>;

      /* ── 24h ticker (columnar USDT-M format) ────────────────────── */
      if (
        m.method === "perp_market24h_pack_p.update" &&
        Array.isArray(m.fields) &&
        Array.isArray(m.data)
      ) {
        const ticker = findSymbolRow(m.data as unknown[][], m.fields as string[], SYMBOL);
        if (ticker) {
          printTicker(ticker);
        }
        return;
      }

      /* ── Initial 1000-trade batch ───────────────────────────────── */
      if (m.trades_p && m.symbol === SYMBOL && Array.isArray(m.trades_p) && m.trades_p.length === 1000) {
        const trades = m.trades_p as unknown[][];
        // Process the batch in reverse to get chronological order
        let previous = 0;
        for (const trade of [...trades].reverse()) {
          const p = Number(trade[2]);
          if (p > 0) {
            if (previous > 0) updateDirection(p, previous);
            previous = p;
          }
        }
        return;
      }

      /* ── Real-time trades ───────────────────────────────────────── */
      if (m.trades_p && m.symbol === SYMBOL && Array.isArray(m.trades_p) && m.trades_p.length > 0) {
        const trades = m.trades_p as unknown[][];
        for (const trade of trades) {
          const p = Number(trade[2]);
          if (p > 0) {
            updateDirection(p, lastPrice || p);
            lastPrice = p;

            // Check entry/exit signals after each trade
            if (tickerReady) {
              checkEntrySignals();
              checkExitSignals();
            }
          }
        }
      }
    },
    onReconnect: (delayMs) => {
      log(`⟐  Reconnecting in ${delayMs / 1000}s …`);
    },
  });

  ws.connect();

  /* ── Position polling loop ────────────────────────────────────────── */

  let running = true;
  process.on("SIGINT", () => {
    log("⏹  Shutting down …");
    running = false;
    ws.shutdown();
    process.exit(0);
  });

  while (running) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    if (!running) break;
    await pollPositions();
  }
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
