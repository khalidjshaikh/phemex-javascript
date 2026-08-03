#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-dime-roller.ts — XBRUSDT "dime" position roller on USDT-M.
 *
 * Places a market order and keeps rolling the position every time the price
 * moves one dime ($0.10) in the strategy's direction:
 *
 *   --max   Short strategy: open a Short @ current price; when the price
 *           INCREASES by a dime, close the short and re-open a new short.
 *   --min   Long strategy:  open a Long  @ current price; when the price
 *           DECREASES by a dime, close the long and re-open a new long.
 *
 * Both use 100x leverage on symbol XBRUSDT, qty 0.01.
 *
 * At startup the script checks for an already-open XBRUSDT position and
 * adopts it instead of placing a new order, so repeated runs don't stack
 * quantity on top of a leftover position.
 *
 * Usage:
 *   ./phemex-dime-roller.ts --max
 *   ./phemex-dime-roller.ts --min
 *
 * Options:
 *   --max              Short-roll strategy (close & re-short when price +$0.10)
 *   --min              Long-roll strategy  (close & re-long  when price -$0.10)
 *   --help, -h         Show this help message
 *
 * Exactly one of --max / --min must be given.
 */

import { base64UrlDecode } from "../src/http-client.js";
import { loadCredentialsPath } from "../src/credentials.js";
import { ReconnectingWs } from "../src/ws-client.js";
import { findSymbolRow } from "../src/cli-utils.js";
import { placeMarketOrder, setLeverageUsdtM } from "../src/place-limit-order.js";
import { closePosition, fetchPositions } from "../src/positions.js";

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

const SYMBOL = "XBRUSDT";
const QTY = 0.01;          // contract quantity
const LEVERAGE = 100;      // 100x as requested
const DIME = 0.10;         // $0.10 trigger move
const WS_URL = "wss://ws.phemex.com";
const REFRESH_DELAY_MS = 1_500; // wait for fills before reading the new avg entry

function usage(): never {
  console.log(`
Usage: ./phemex-dime-roller.ts --max | --min

Place a ${QTY} ${SYMBOL} market order at 100x and roll the position each
time the price moves a dime (\$${DIME.toFixed(2)}) in the strategy direction:

  --max   Short strategy — open Short; when price rises \$${DIME.toFixed(2)},
          close the short and open a new short.
  --min   Long strategy  — open Long;  when price falls \$${DIME.toFixed(2)},
          close the long and open a new long.

Options:
  --max               Short-roll strategy
  --min               Long-roll strategy
  --help, -h          Show this help message

Examples:
  ./phemex-dime-roller.ts --max
  ./phemex-dime-roller.ts --min
`);
  process.exit(0);
}

function fmtTime(): string {
  return new Date().toLocaleString();
}

function fmtNum(n: number, d = 4): string {
  return n.toFixed(d);
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) usage();

  const isMax = process.argv.includes("--max");
  const isMin = process.argv.includes("--min");
  if (isMax === isMin) {
    console.error("✗  Pass exactly one of --max or --min");
    usage();
  }

  const direction = isMax ? "short" : "long";
  const openSide = isMax ? "Sell" : "Buy";        // Short = Sell, Long = Buy
  const openPosSide = isMax ? "Short" : "Long";
  const expectedPosSide = isMax ? "Sell" : "Buy"; // position side reported by the API

  const creds = loadCredentialsPath(".phemex-credentials-gmail.json");
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  console.log(`[${fmtTime()}] ═ ${SYMBOL} Dime Roller (${direction}) ═══════════════════════`);
  console.log(`[${fmtTime()}]   Strategy:  ${isMax ? "Short — re-short when price +$" + DIME.toFixed(2) : "Long — re-long when price -$" + DIME.toFixed(2)}`);
  console.log(`[${fmtTime()}]   Symbol:    ${SYMBOL}   qty: ${QTY}   leverage: ${LEVERAGE}x`);
  console.log(`[${fmtTime()}] ═══════════════════════════════════════════════════════════════`);

  await setLeverageUsdtM(SYMBOL, LEVERAGE, openPosSide, creds.PHEMEX_API_KEY, secretRaw);

  // Track the reference price the next dime is measured from.
  let entryRef = 0;   // avg entry price of the current position
  let lastPrice = 0;  // latest live price from the WS feed
  let busy = false;   // true while a close+reopen cycle is in flight
  let rolled = 0;     // number of rolls performed

  async function readEntryRef(): Promise<void> {
    await new Promise((r) => setTimeout(r, REFRESH_DELAY_MS));
    const positions = await fetchPositions(creds.PHEMEX_API_KEY, secretRaw);
    const pos = positions.find((p) => p.symbol === SYMBOL && p.side === expectedPosSide);
    if (pos) {
      entryRef = parseFloat(pos.avgEntryPriceRp || "0");
      console.log(`[${fmtTime()}] ⟐  ${direction} position @ avg entry $${fmtNum(entryRef)} (size ${pos.size})`);
    } else {
      entryRef = lastPrice;
      console.warn(`[${fmtTime()}] ⚠  Could not read new avg entry — using live price $${fmtNum(lastPrice)} as reference`);
    }
  }

  /**
   * Open a fresh position unless one is already open for the symbol.
   *
   * The initial open checks positions first so a leftover position from a
   * previous run is adopted instead of stacking a new order on top of it.
   * `force` bypasses the check — used when rolling, since the position was
   * just closed and the API may still report it.
   */
  async function openPosition(force = false): Promise<void> {
    if (!force) {
      const positions = await fetchPositions(creds.PHEMEX_API_KEY, secretRaw);
      const existing = positions.find((p) => p.symbol === SYMBOL);
      if (existing) {
        const side = existing.side === "Buy" ? "Long" : "Short";
        console.log(`[${fmtTime()}]   –  ${side} position already open (size ${existing.size}) — adopting it, no new order placed`);
        return;
      }
    }
    const result = await placeMarketOrder(
      { account: "usdt-m", symbol: SYMBOL, side: openSide, price: 0, qty: QTY, posSide: openPosSide },
      creds.PHEMEX_API_KEY,
      secretRaw,
    );
    console.log(
      `[${fmtTime()}]   ✓  ${isMax ? "Short" : "Long"} opened — orderID: ${result.orderID ?? result.clOrdID ?? "—"}  status: ${result.ordStatus ?? "—"}`,
    );
  }

  /** Close the current position (if any) then open a fresh one in the strategy direction. */
  async function roll(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      console.log(`[${fmtTime()}] ⟐  Trigger: price $${fmtNum(lastPrice)} — rolling ${direction} …`);
      const positions = await fetchPositions(creds.PHEMEX_API_KEY, secretRaw);
      const pos = positions.find((p) => p.symbol === SYMBOL);
      if (pos) {
        await closePosition(pos, creds.PHEMEX_API_KEY, secretRaw);
      } else {
        console.log(`[${fmtTime()}]   –  No open position to close; skipping close`);
      }
      await openPosition(true);
      rolled++;
      await readEntryRef();
    } catch (err: unknown) {
      console.error(`[${fmtTime()}] ✗  Roll error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      busy = false;
    }
  }

  /** Evaluate the dime trigger against the latest pri`c`e. */
  function checkTrigger(): void {
    if (busy || lastPrice <= 0 || entryRef <= 0) return;
    const hit = isMax
      ? lastPrice >= entryRef + DIME   // short: price rose a dime
      : lastPrice <= entryRef - DIME;  // long:  price fell a dime
    if (hit) {
      roll().catch((err: unknown) => {
        console.error(`[${fmtTime()}] ✗  Roll failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  await readEntryRef();
  console.log(`[${fmtTime()}] ⏳  Watching ${SYMBOL} — rolling on ${isMax ? "price +$" + DIME.toFixed(2) : "price -$" + DIME.toFixed(2)} …`);

  /* ------------------------------------------------------------------ */
  /*  WebSocket — live price feed (ticker + trades)                      */
  /* ------------------------------------------------------------------ */

  const ws = new ReconnectingWs(WS_URL, {
    registerSigint: false,
    onOpen: () => {
      ws.send({ method: "perp_market24h_pack_p.subscribe", params: [SYMBOL], id: 1 });
      ws.send({ method: "trade_p.subscribe", params: [SYMBOL], id: 2 });
    },
    onMessage: (msg) => {
      try {
        const m = msg as Record<string, unknown>;

        // 24h ticker (columnar USDT-M format) — ~1s updates
        if (
          m.method === "perp_market24h_pack_p.update" &&
          Array.isArray(m.fields) &&
          Array.isArray(m.data)
        ) {
          const ticker = findSymbolRow(m.data as unknown[][], m.fields as string[], SYMBOL);
          if (ticker) {
            const p = Number(ticker.lastRp ?? 0);
            if (p > 0) {
              lastPrice = p;
              const target = isMax ? entryRef + DIME : entryRef - DIME;
              process.stdout.write(
                `[${fmtTime()}] ${SYMBOL}  $${fmtNum(lastPrice)}  ` +
                `ref: $${fmtNum(entryRef)}  target: $${fmtNum(target)}  ` +
                `(rolls: ${rolled})${busy ? "  ⏳ rolling…" : ""}\r`,
              );
              checkTrigger();
            }
          }
          return;
        }

        // Real-time trades — faster price updates
        if (m.trades_p && m.symbol === SYMBOL) {
          const trades = m.trades_p as unknown[][];
          if (trades.length > 0) {
            const p = Number(trades[trades.length - 1][2]);
            if (p > 0) {
              lastPrice = p;
              checkTrigger();
            }
          }
        }
      } catch (err: unknown) {
        console.error(`[${fmtTime()}] ✗  WS message error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    onReconnect: (delayMs) => {
      process.stdout.write("\n");
      console.log(`[${fmtTime()}] ⟐  WebSocket reconnecting in ${delayMs / 1000}s …`);
    },
  });

  process.on("SIGINT", () => {
    console.log(`\n[${fmtTime()}] ⏹  Shutting down — ${rolled} roll(s) performed. Position left as-is.`);
    ws.shutdown();
    process.exit(0);
  });

  ws.connect();
}

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
