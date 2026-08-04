#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-pnl-monitor.ts — Monitor open USDT-M positions, auto-close on PnL decrement.
 *
 * - Polls USDT-M positions via fetchPositions every ~2 s (configurable).
 * - For each open position prints EVERY field returned by the API in one line.
 * - Analyzes the unrealized PnL (USDT) and computes pnlPct (% of position margin).
 * - Tracks pnlPct per position across ticks: while it increments we keep watching;
 *   the moment it decrements vs. the previous tick, the position is closed with a
 *   market order.
 * - Loops indefinitely.  Ctrl+C (SIGINT) to stop.
 *
 * Usage:
 *   npx tsx phemex-pnl-monitor.ts                  — monitor & auto-close
 *   npx tsx phemex-pnl-monitor.ts --dry-run        — log only, never place orders
 *   npx tsx phemex-pnl-monitor.ts --interval 5000  — poll every 5 s
 *   npx tsx phemex-pnl-monitor.ts --once --dry-run — single read-only poll, then exit
 */

import { base64UrlDecode } from "../src/http-client.js";
import { loadCredentials } from "../src/credentials.js";
import { calcPnlPct, closePosition, fetchPositions, Position } from "../src/positions.js";

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

const DEFAULT_INTERVAL_MS = 2_000;   // ms between position polls
const CLOSE_COOLDOWN_MS = 30_000;    // skip a symbol for this long after closing it
                                     // (API lag can keep showing the position)

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function fmtTime(): string {
  return new Date().toLocaleString();
}

function fmtNum(n: number, d: number = 2): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** Format a single field value for the one-line dump */
function fmtField(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

interface Args {
  intervalMs: number;
  dryRun: boolean;
  once: boolean;
}

function parseArgs(): Args {
  const args: Args = {
    intervalMs: DEFAULT_INTERVAL_MS,
    dryRun: process.argv.includes("--dry-run"),
    once: process.argv.includes("--once"),
  };
  const idx = process.argv.indexOf("--interval");
  if (idx !== -1 && idx + 1 < process.argv.length) {
    const v = parseInt(process.argv[idx + 1], 10);
    if (!isNaN(v) && v > 0) args.intervalMs = v;
  }
  return args;
}

/** Unrealized PnL in USDT, direction-aware: (mark − entry) × size for longs */
function calcPnlUsdt(pos: Position): number {
  const size = parseFloat(pos.size || "0");
  const entry = parseFloat(pos.avgEntryPriceRp || "0");
  const mark = parseFloat(pos.markPriceRp || "0");
  return pos.side === "Buy" ? (mark - entry) * size : (entry - mark) * size;
}

/* ------------------------------------------------------------------ */
/*  Main loop                                                          */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const { intervalMs, dryRun, once } = parseArgs();

  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(`
Usage:  npx tsx phemex-pnl-monitor.ts [--dry-run] [--interval <ms>] [--once] [--help]

Monitor open USDT-M positions; close any position whose pnlPct decrements.

Options:
  --dry-run           Log what would be closed, but never place orders
  --interval <ms>     Poll interval in ms (default: ${DEFAULT_INTERVAL_MS})
  --once              Run a single poll, then exit
  --help, -h          Show this help
`);
    process.exit(0);
  }

  const creds = loadCredentials();
  const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

  console.log(`[${fmtTime()}]  ⚡  Starting PnL monitor${dryRun ? "  (DRY-RUN — no orders will be placed)" : ""}`);
  console.log(`     Poll interval: ${intervalMs} ms   Mode: ${once ? "single poll" : "infinite loop"}`);
  console.log("");

  let running = true;
  process.on("SIGINT", () => {
    console.log(`\n[${fmtTime()}]  ⏹  Shutting down …`);
    running = false;
  });

  // per-symbol tracking: last pnlPct observed and the peak pnlPct reached
  const track = new Map<string, { lastPnlPct: number; peakPnlPct: number }>();
  // symbols recently closed via this monitor (skipped until they vanish or cooldown passes)
  const closedAt = new Map<string, number>();
  let hadPositions = false;

  while (running) {
    try {
      const positions = await fetchPositions(creds.PHEMEX_API_KEY, secretRaw);
      const openSymbols = new Set<string>();

      if (positions.length === 0) {
        if (hadPositions) console.log(`[${fmtTime()}]  ℹ  No open positions`);
        hadPositions = false;
      } else {
        hadPositions = true;
      }

      for (const pos of positions) {
        openSymbols.add(pos.symbol);

        // Skip symbols we just closed — the exchange may still report them for a bit
        const closedTs = closedAt.get(pos.symbol);
        if (closedTs !== undefined && Date.now() - closedTs < CLOSE_COOLDOWN_MS) continue;
        closedAt.delete(pos.symbol);

        const pnlUsdt = calcPnlUsdt(pos);
        const pnlPct = calcPnlPct(pos);
        const prev = track.get(pos.symbol);
        const delta = prev ? pnlPct - prev.lastPnlPct : 0;
        const arrow = delta > 0 ? "▲" : delta < 0 ? "▼" : "—";

        const entry = parseFloat(pos.avgEntryPriceRp || "0");
        const mark = parseFloat(pos.markPriceRp || "0");
        const size = parseFloat(pos.size || "0");
        const margin = parseFloat(pos.posCostRv || "0");

        const SYMBOL = pos.symbol.padEnd(8);
        const pnl = pos.side === "Buy" ? (mark - entry) * size : (entry - mark) * size; // PnL from the data structure
        // const pnlPct = margin > 0 ? (pnl / margin) * 100 : 0;
        console.log(
          `[${fmtTime()}] ${SYMBOL}  ${pos.side.padEnd(4)}  ` +
          `size: ${fmtNum(size, 4)}  entry: $${fmtNum(entry)}  mark: $${fmtNum(mark)}  ` +
          `PnL: ${pnl >= 0 ? "+" : "-"}$${fmtNum(Math.abs(pnl), 8)} (${pnlPct >= 0 ? "+" : ""}${fmtNum(pnlPct, 8)}%)  ` +
          `margin: $${fmtNum(margin, 8)}`
        );

        // One line: every field the API returned, then the PnL analysis
        // const raw = Object.entries(pos)
        //   .map(([k, v]) => `${k}=${fmtField(v)}`)
        //   .join("  ");
        // console.log(
        //   `[${fmtTime()}]  ${pos.symbol}  ${arrow}  pnl: ${pnlUsdt >= 0 ? "+" : ""}${fmtNum(pnlUsdt, 4)}  ` +
        //   `pnlPct: ${pnlPct >= 0 ? "+" : ""}${fmtNum(pnlPct, 2)}%  ` +
        //   `peak: ${prev ? `${prev.peakPnlPct >= 0 ? "+" : ""}${fmtNum(prev.peakPnlPct, 2)}%` : "—"}  ` +
        //   `raw: ${raw}`
        // );
        // [8/1/2026, 12:06:01 PM]  XBRUSDT  ▼  pnl: -0.0003  pnlPct: -3.11%  peak: -1.04%  raw: userID=9187469  accountID=91874690003  symbol=XBRUSDT  currency=USDT  side=Sell  positionStatus=Normal  crossMargin=true  leverageRr=-100  initMarginReqRr=0.01  maintMarginReqRr=0.005  riskLimitRv=20000  size=0.01  valueRv=0.908  avgEntryPriceRp=90.8  avgEntryPrice=90.8  posCostRv=0.0096313086  assignedPosBalanceRv=0.0097313086  bankruptCommRv=0.0005475843  bankruptPriceRp=96.02  positionMarginRv=0.0090837243  liquidationPriceRp=95.54  deleveragePercentileRr=0  buyValueToCostRr=0.011194  sellValueToCostRr=0.011206  markPriceRp=90.83  estimatedOrdLossRv=0  usedBalanceRv=0.0096313086  cumClosedPnlRv=-0.276  cumFundingFeeRv=0  cumTransactFeeRv=0.29280465  transactTimeNs=1785603958883272200  takerFeeRateRr=-1  makerFeeRateRr=-1  term=81  lastTermEndTimeNs=1785596378657271800  lastFundingTimeNs=1783584000000000000  curTermRealisedPnlRv=-0.0005448  execSeq=10366065016  posSide=Short  posMode=Hedged  buyLeavesValueRv=0  buyLeavesQtyRq=0  sellLeavesValueRv=0  sellLeavesQtyRq=0


        // Decrement detected → close the position
        if (prev !== undefined && pnlPct < prev.lastPnlPct) {
          console.log(
            `[${fmtTime()}]  ⚠  ${pos.symbol} pnlPct decremented ` +
            `${prev.lastPnlPct >= 0 ? "+" : ""}${fmtNum(prev.lastPnlPct, 2)}% → ` +
            `${pnlPct >= 0 ? "+" : ""}${fmtNum(pnlPct, 2)}%  — closing position`
          );
          if (dryRun) {
            console.log(`[${fmtTime()}]     (dry-run) would close ${pos.symbol} qty ${pos.size}`);
          } else {
            await closePosition(pos, creds.PHEMEX_API_KEY, secretRaw);
          }
          closedAt.set(pos.symbol, Date.now());
          track.delete(pos.symbol);
          continue;
        }

        // Keep tracking: pnlPct is incrementing (or first observation)
        track.set(pos.symbol, {
          lastPnlPct: pnlPct,
          peakPnlPct: Math.max(prev?.peakPnlPct ?? pnlPct, pnlPct),
        });
      }

      // Drop tracking for symbols that are no longer open
      for (const sym of track.keys()) {
        if (!openSymbols.has(sym)) track.delete(sym);
      }
      for (const sym of closedAt.keys()) {
        if (!openSymbols.has(sym)) closedAt.delete(sym);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${fmtTime()}]  ✗  Error: ${msg}`);
    }

    if (once) break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  console.log(`[${fmtTime()}]  ✅  Monitor stopped`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
