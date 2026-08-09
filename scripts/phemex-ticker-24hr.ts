#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-ticker-24hr.ts — poll the Phemex v3 24h ticker every second and
 * print every variable of the response horizontally on one line.
 *
 * Public endpoint, no credentials needed.
 *
 * A line is printed only when a field actually changed (the ticker's own
 * timestamp is excluded from the comparison — it advances even while prices
 * are frozen). Each tick still writes the current ask and bid prices to
 * ask.txt and bid.txt in the project root (value only, no newline), so other
 * scripts can find them regardless of the launch directory.
 *
 * With --csv <FILE> every tick is also appended to FILE as a CSV row
 * (time,ask,bid,index,mark,last); the header line is written when the file
 * is new, so a fresh log is self-describing and appending to an existing
 * log only adds rows.
 *
 * Usage:
 *   npx tsx phemex-ticker-24hr.ts                  # default symbol XBRUSDT
 *   npx tsx phemex-ticker-24hr.ts --symbol BTCUSDT
 *   npx tsx phemex-ticker-24hr.ts --interval 2000  # poll every 2s
 *   npx tsx phemex-ticker-24hr.ts --delta          # add Δask/Δbid/... = field − last
 *   npx tsx phemex-ticker-24hr.ts --csv ticker.csv # append CSV rows
 */

import fs from "node:fs";
import { resolve } from "node:path";
import { publicGet } from "../src/http-client.js";
import { getArg, hasFlag } from "../src/cli-utils.js";

const USAGE = `Usage: npx tsx phemex-ticker-24hr.ts [options]

Poll the Phemex v3 24h ticker every second and print every variable of
the response horizontally on one line. Public endpoint, no credentials
needed. A line is printed only when a field actually changed; ask.txt
and bid.txt are still updated in the project root on every tick.

Options:
  --symbol <SYMBOL>   Symbol to poll (default: XBRUSDT)
  --interval <MS>     Poll interval in milliseconds (default: 1000)
  --concise           Hide fundRate, high, low, openInt, open, predFund,
                      symbol, turnover, volume columns
  --delta             Add Δask, Δbid, Δindex, Δlast, Δmark columns showing
                      each field minus the last price
  --csv <FILE>        Append a CSV row (time,ask,bid,index,mark,last) to
                      FILE on every tick; writes the header when FILE is new
  --help              Show this help and exit
`;

if (hasFlag("--help")) {
  console.log(USAGE);
  process.exit(0);
}

const SYMBOL = getArg("--symbol") ?? "XBRUSDT";
const INTERVAL_MS = Number(getArg("--interval") ?? 1000);
// --csv <FILE>: append a time,ask,bid,index,mark,last row to FILE every tick.
const CSV_FILE = getArg("--csv");

// Columns hidden in --concise mode (keyed by raw response field name).
const CONCISE_HIDDEN = new Set([
  "fundingRateRr", "highRp", "lowRp", "openInterestRv", "openRp",
  "predFundingRateRr", "symbol", "turnoverRv", "volumeRq",
]);

// --delta: fields for which a Δ column (field value minus last price) is added.
const DELTA = hasFlag("--delta");
const DELTA_FIELDS = ["askRp", "bidRp", "indexRp", "lastRp", "markRp"] as const;

// Display order of the columns: index, mark, last (and their Δ columns) are
// listed in that order; anything not listed keeps its API order.
const COLUMN_ORDER = [
  "askRp", "bidRp", "fundingRateRr", "highRp",
  "indexRp", "markRp", "lastRp",
  "lowRp", "openInterestRv", "openRp", "predFundingRateRr", "symbol",
  "timestamp", "turnoverRv", "volumeRq",
  "askRpDelta", "bidRpDelta", "indexRpDelta", "markRpDelta", "lastRpDelta",
];
const COLUMN_RANK = new Map(COLUMN_ORDER.map((k, i) => [k, i]));

// Value files live at the project root (like last.txt / mark.txt) so both
// the ticker and the monitor see the same files from any launch directory.
const ROOT = resolve(__dirname, "..");
const ASK_FILE = resolve(ROOT, "ask.txt");
const BID_FILE = resolve(ROOT, "bid.txt");

/* ------------------------------------------------------------------ */
/*  CSV logging (--csv <FILE>) — append one row per tick.              */
/* ------------------------------------------------------------------ */

// Columns appended to the CSV file, in order (time is prepended).
const CSV_COLUMNS = ["askRp", "bidRp", "indexRp", "markRp", "lastRp"] as const;

/**
 * Append one CSV row (time,ask,bid,index,mark,last) to FILE. When FILE does
 * not exist yet (or is empty) the header line is written first, so a fresh
 * log is self-describing; appending to an existing log only adds rows.
 */
function appendCsvRow(file: string, data: Record<string, unknown>): void {
  const header = "time,ask,bid,index,mark,last\n";
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
    fs.appendFileSync(file, header, "utf8");
  }
  const row = [tsToHMS(Date.now()), ...CSV_COLUMNS.map((k) => fmt(data[k]))].join(",");
  fs.appendFileSync(file, `${row}\n`, "utf8");
}

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
  // Delta columns (--delta): Δ<label> = field value minus the last price.
  askRpDelta:        { label: "Δask",    full: "ask − last" },
  bidRpDelta:        { label: "Δbid",    full: "bid − last" },
  indexRpDelta:      { label: "Δindex",  full: "index − last" },
  lastRpDelta:       { label: "Δlast",   full: "last − last" },
  markRpDelta:       { label: "Δmark",   full: "mark − last" },
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

/** Left-pad a string to a fixed width (right-aligns numeric columns). */
function padLeft(s: string, w: number): string {
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

/** Format a number with exactly 2 decimals; dash when absent/invalid. */
function fmt(v: unknown): string {
  if (v == null) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return n.toFixed(2);
}

/**
 * Format a delta value with a sign so columns align: "+0.05", "-0.02",
 * " 0.00" (a space holds the sign position for zero).
 */
function fmtDelta(v: unknown): string {
  if (v == null) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  const s = n.toFixed(2);
  return n > 0 ? `+${s}` : n < 0 ? s : ` ${s}`;
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
  if (k === "timestamp") return fmtTsLocal(v);
  return k.endsWith("Delta") ? fmtDelta(v) : fmt(v);
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
  let legendPrinted = false;
  // The column header is reprinted once per minute, whenever the minute
  // rolls over (the seconds are ignored), so the labels sit just ahead of
  // the values for the minute they introduce.
  let lastHeaderMinute = -1;
  // Minimum spacing: each column is padded to exactly its widest content
  // (label or value seen so far) and columns are joined by a single space.
  const widths = new Map<string, number>();
  // Signature of the last tick: every field except the ticker timestamp,
  // which advances every ~second even while prices are frozen. Excluding it
  // means a line is printed only when a real value changed.
  let lastSig = "";

  for (;;) {
    const started = Date.now();
    try {
      const data = await fetchTicker();

      // --delta: append Δ columns, each field minus the last price.
      if (DELTA) {
        const last = Number(data.lastRp);
        for (const f of DELTA_FIELDS) {
          const v = Number(data[f]);
          data[`${f}Delta`] =
            Number.isFinite(v) && Number.isFinite(last) ? v - last : null;
        }
      }

      const keys = Object.keys(data)
        .filter((k) => !hasFlag("--concise") || !CONCISE_HIDDEN.has(k))
        .sort(
          (a, b) =>
            (COLUMN_RANK.get(a) ?? COLUMN_ORDER.length) -
            (COLUMN_RANK.get(b) ?? COLUMN_ORDER.length),
        );

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

      // Persist the current ask and bid prices to plain-text files at the
      // project root each tick, so the monitor finds them from any cwd —
      // this must happen even when nothing is printed.
      fs.writeFileSync(ASK_FILE, fmtExact(data.askRp), "utf8");
      fs.writeFileSync(BID_FILE, fmtExact(data.bidRp), "utf8");

      // --csv: append a time-series row every tick (even when nothing changed).
      if (CSV_FILE) appendCsvRow(CSV_FILE, data);

      // Only print when a field actually changed (timestamp excluded).
      const sig = keys
        .filter((k) => k !== "timestamp")
        .map((k) => `${k}=${data[k]}`)
        .join("|");
      const changed = sig !== lastSig;
      lastSig = sig;

      if (changed) {
        // Reprint the header whenever the minute rolls over, ignoring the
        // seconds: the first changed tick of a new minute carries the header.
        const now = Date.now();
        const minute = Math.floor(now / 60000);
        if (minute !== lastHeaderMinute) {
          lastHeaderMinute = minute;
          const head = keys.map((k) => padRight(colLabel(k), widths.get(k)!)).join(" ");
          console.log(`[${tsToHMS(now)}] ${head}`);
        }

        // Render every variable on one horizontal line, timestamp as local time.
        // Numeric columns are right-aligned so values line up vertically.
        const line = keys
          .map((k) => {
            const s = fmtField(k, data[k]);
            const rightAlign = k !== "timestamp" && k !== "symbol";
            return rightAlign
              ? padLeft(s, widths.get(k)!)
              : padRight(s, widths.get(k)!);
          })
          .join(" ");
        console.log(`[${tsToHMS(Date.now())}] ${line}`);
      }
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
