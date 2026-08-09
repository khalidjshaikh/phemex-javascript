#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-ticker-24hr.ts — poll the Phemex v3 24h ticker every second and
 * print every variable of the response horizontally on one line.
 *
 * Public endpoint, no credentials needed.
 *
 * Each tick also writes the current ask and bid prices to ask.txt and
 * bid.txt in the project root (value only, no newline), so other scripts
 * can find them regardless of the launch directory.
 *
 * Usage:
 *   npx tsx phemex-ticker-24hr.ts                  # default symbol XBRUSDT
 *   npx tsx phemex-ticker-24hr.ts --symbol BTCUSDT
 *   npx tsx phemex-ticker-24hr.ts --interval 2000  # poll every 2s
 */

import fs from "node:fs";
import { resolve } from "node:path";
import { publicGet } from "../src/http-client.js";
import { getArg } from "../src/cli-utils.js";

const SYMBOL = getArg("--symbol") ?? "XBRUSDT";
const INTERVAL_MS = Number(getArg("--interval") ?? 1000);

// Value files live at the project root (like last.txt / mark.txt) so both
// the ticker and the monitor see the same files from any launch directory.
const ROOT = resolve(__dirname, "..");
const ASK_FILE = resolve(ROOT, "ask.txt");
const BID_FILE = resolve(ROOT, "bid.txt");

/* ------------------------------------------------------------------ */
/*  Column definitions — abbreviation (printed in the header) and the  */
/*  full variable name, defined once at the top of the program.        */
/* ------------------------------------------------------------------ */

const COLUMNS: Record<string, { label: string; full: string }> = {
  askRp:             { label: "ask",      full: "ask price" },
  bidRp:             { label: "bid",      full: "bid price" },
  fundingRateRr:     { label: "fundRate", full: "funding rate" },
  highRp:            { label: "high",     full: "24h high" },
  indexRp:           { label: "index",    full: "index price" },
  lastRp:            { label: "last",     full: "last price" },
  lowRp:             { label: "low",      full: "24h low" },
  markRp:            { label: "mark",     full: "mark price" },
  openInterestRv:    { label: "openInt",  full: "open interest" },
  openRp:            { label: "open",     full: "24h open" },
  predFundingRateRr: { label: "predFund", full: "predicted funding rate" },
  symbol:            { label: "symbol",   full: "symbol" },
  timestamp:         { label: "time",     full: "timestamp" },
  turnoverRv:        { label: "turnover", full: "turnover" },
  volumeRq:          { label: "volume",   full: "volume" },
};

/** Header label for a response field (falls back to the raw field name). */
function colLabel(key: string): string {
  return COLUMNS[key]?.label ?? key;
}

/** Full variable name for a response field (falls back to the raw name). */
function colFull(key: string): string {
  return COLUMNS[key]?.full ?? key;
}

/** Right-pad a string to a fixed width so columns stay aligned. */
function padRight(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

/** Format a number with exactly 2 decimals; dash when absent/invalid. */
function fmt(v: unknown): string {
  if (v == null) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n.toFixed(2);
}

/** Exact value (up to 8 decimals, trailing zeros stripped) — for file writes. */
function fmtExact(v: unknown): string {
  if (v == null) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return String(Math.round(n * 1e8) / 1e8);
}

function tsToHMS(ms: number): string {
  const d = new Date(ms);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Format a Phemex ticker timestamp (nanoseconds since epoch) as local time. */
function fmtTsLocal(v: unknown): string {
  const ns = Number(v);
  if (!Number.isFinite(ns)) return fmt(v);
  const d = new Date(Math.floor(ns / 1e6));
  const p = (x: number) => String(x).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Pick the formatter for a response field: timestamps as local time. */
function fmtField(k: string, v: unknown): string {
  return k === "timestamp" ? fmtTsLocal(v) : fmt(v);
}

async function fetchTicker(): Promise<Record<string, unknown>> {
  const resp = (await publicGet(
    "/md/v3/ticker/24hr",
    `symbol=${encodeURIComponent(SYMBOL)}`,
  )) as Record<string, unknown>;

  // v3 envelope: { error: null, id: 0, result: { ...fields } }
  if (resp.error != null) {
    throw new Error(`API error: ${JSON.stringify(resp.error)}`);
  }
  const data = resp.result as Record<string, unknown> | undefined;
  if (!data || typeof data !== "object") {
    throw new Error(`Unexpected response shape: ${JSON.stringify(resp).slice(0, 200)}`);
  }
  return data;
}

async function main(): Promise<void> {
  const HEADER_EVERY = 25; // reprint column labels every N data rows
  let rows = 0;
  let legendPrinted = false;
  // Minimum spacing: each column is padded to exactly its widest content
  // (label or value seen so far) and columns are joined by a single space.
  const widths = new Map<string, number>();

  for (;;) {
    const started = Date.now();
    try {
      const data = await fetchTicker();
      const keys = Object.keys(data);

      // Grow each column width to fit its label and current value.
      for (const k of keys) {
        const valStr = fmtField(k, data[k]);
        widths.set(k, Math.max(colLabel(k).length, valStr.length, widths.get(k) ?? 0));
      }

      // Print the abbreviation → full-name legend once at startup.
      if (!legendPrinted) {
        console.log(
          "Columns: " +
            keys
              .map((k) => `${colLabel(k)}=${colFull(k)}`)
              .join(", "),
        );
        legendPrinted = true;
      }

      if (rows % HEADER_EVERY === 0) {
        const head = keys.map((k) => padRight(colLabel(k), widths.get(k)!)).join(" ");
        console.log(`[${tsToHMS(Date.now())}] ${head}`);
      }

      // Persist the current ask and bid prices to plain-text files at the
      // project root each tick, so the monitor finds them from any cwd.
      fs.writeFileSync(ASK_FILE, fmtExact(data.askRp), "utf8");
      fs.writeFileSync(BID_FILE, fmtExact(data.bidRp), "utf8");

      // Render every variable on one horizontal line, timestamp as local time.
      const line = keys
        .map((k) =>
          padRight(fmtField(k, data[k]), widths.get(k)!),
        )
        .join(" ");
      console.log(`[${tsToHMS(Date.now())}] ${line}`);
      rows++;
    } catch (e) {
      console.log(`[${tsToHMS(Date.now())}] error: ${(e as Error).message}`);
    }

    // Sleep until the next tick (keep a steady 1s cadence).
    const elapsed = Date.now() - started;
    await new Promise((r) => setTimeout(r, Math.max(0, INTERVAL_MS - elapsed)));
  }
}

main().catch((e) => {
  console.error(`Fatal: ${(e as Error).message}`);
  process.exit(1);
});
