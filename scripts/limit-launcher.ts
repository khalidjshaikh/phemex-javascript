#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * limit-launcher.ts — Runs two orders per side based on the sign of markLast.txt:
 *
 *   markLast > 0:
 *     1) long-limit.ts  (mark-based)           → spawned and AWAITED (waits for exit)
 *     2) long-limit.ts  (last-based, one-shot) → spawned and AWAITED (waits for exit)
 *   markLast < 0:
 *     1) short-limit.ts (mark-based)           → spawned and AWAITED (waits for exit)
 *     2) short-limit.ts (last-based, one-shot) → spawned and AWAITED (waits for exit)
 *
 * The launcher loops forever; each cycle it re-reads markLast.txt/indexLast.txt,
 * spawns the mark-based child and AWAITS its exit (it runs its own
 * place → sleep → cancel cycle and exits), then awaits the one-shot last-based
 * placement. On a sign flip the launcher simply switches sides — the awaited
 * mark-based child has already exited by the time the flip is detected.
 * The awaited one-shot has a watchdog: if it does not exit within SPREAD_LAST_TIMEOUT_MS
 * it is SIGINTed and the cycle moves on (guards against the child blocking
 * forever in its markLast gate or on a stalled price fetch).
 * indexLast.txt is read alongside markLast.txt and logged for context.
 * When the desired side is disabled (DISABLE_LONG/DISABLE_SHORT) no orders
 * run; the cycle logs once and sleeps DISABLED_POLL_MS (7s) before re-reading.
 * The --gap of the last-based one-shot is computed each cycle as
 * min(max(|indexLast|, |markLast|), 10) / 100, signed - for long, + for short.
 * Its --qty is 0.1 when max(|indexLast|, |markLast|) > 10, else 0.01.
 *
 * Usage: ./limit-launcher.ts   (Ctrl+C stops children and exits)
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const ROOT = resolve(__dirname, ".."); // project root — markLast.txt/indexLast.txt live here
const MARK_FILE = resolve(ROOT, "markLast.txt");
const INDEX_FILE = resolve(ROOT, "indexLast.txt");

const LONG_SCRIPT = resolve(__dirname, "long-limit.ts");
const SHORT_SCRIPT = resolve(__dirname, "short-limit.ts");

type Side = "long" | "short";

/** Per-side commands: priceMark is spawned and awaited, spreadLast is awaited. */
const LONG_PRICE_MARK = [
  "--symbol", "XBRUSDT",
  "--spread", "-0",
  "--gap", "-0.01",
  "--dispersion", "1",
  "--qty", "0.01",
  "--cancel",
  "--sleep", "5",
  // "--takeProfit", "mark+.1",
  "--price", "mark",
];

const LONG_SPREAD_LAST = [
  "--symbol", "XBRUSDT",
  "--spread", "-28",
  "--dispersion", "1",
  "--cancel",
  "--sleep", "5",
  // "--takeProfit", "last+.1",
  "--price", "last",
];

const SHORT_PRICE_MARK = [
  "--symbol", "XBRUSDT",
  "--spread", "+0",
  "--gap", "+0.01",
  "--dispersion", "1",
  "--qty", "0.01",
  "--cancel",
  "--sleep", "5",
  // "--takeProfit", "mark-.1",
  "--price", "mark",
];

const SHORT_SPREAD_LAST = [
  "--symbol", "XBRUSDT",
  "--spread", "+16",
  "--dispersion", "1",
  "--cancel",
  "--sleep", "5",
  // "--takeProfit", "last-.1",
  "--price", "last",
];

const SIDES: Record<Side, { script: string; priceMark: string[]; spreadLast: string[] }> = {
  long: { script: LONG_SCRIPT, priceMark: LONG_PRICE_MARK, spreadLast: LONG_SPREAD_LAST },
  short: { script: SHORT_SCRIPT, priceMark: SHORT_PRICE_MARK, spreadLast: SHORT_SPREAD_LAST },
};

/** Pause between cycles (also the retry interval when no action applies). */
const POLL_MS = 1000;

/**
 * Pause between cycles while the desired side is disabled (DISABLE_LONG /
 * DISABLE_SHORT). Longer than POLL_MS: a disabled side does no work, so this
 * poll only needs to catch a sign flip back to an enabled side.
 */
const DISABLED_POLL_MS = 7_000;

/**
 * Watchdog for the awaited last-based one-shot: if the child has not exited
 * within this window it is SIGINTed and the cycle continues. Guards against
 * the child blocking forever in its markLast gate or on a stalled fetch.
 * A normal cycle (fetch + place + 5s sleep + cancel) finishes well under this.
 */
const SPREAD_LAST_TIMEOUT_MS = 20_000;

/** Kill-switches per side: when true, neither the mark-based spawn (priceMark)
 *  nor the last-based one-shot (spreadLast) is run for that side. */
const DISABLE_LONG = false;
const DISABLE_SHORT = true;

function isSideDisabled(side: Side): boolean {
  return side === "long" ? DISABLE_LONG : DISABLE_SHORT;
}

let child1: ChildProcess | null = null; // mark-based child (awaited)
let currentSide: Side | null = null;
let awaitingSpreadLastCmd: { proc: ChildProcess } | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read a file as a float; NaN when missing/unreadable/not a number. */
function readLastValue(file: string): number {
  try {
    return parseFloat(readFileSync(file, "utf8"));
  } catch {
    return NaN;
  }
}

/**
 * Max of |indexLast| and |markLast|. Drives the last-based --gap
 * (min(maxAbs, 10) / 100) and its --qty switch (> 10 → "0.1", else "0.01").
 */
function maxAbsLastValue(markLast: number, indexLast: number): number {
  return Math.max(Math.abs(indexLast), Math.abs(markLast));
}

/** Cycle log tag: `[<cycle> <local YYYY-MM-DD HH:mm:ss>]`. */
function cycleTag(cycle: number): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `[${cycle} ${stamp}]`;
}

/** Spawn the mark-based child and wait for it to exit (resolves on exit/error). */
function runPriceMarkCommand(script: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    console.log(`   ▶  starting ${basename(script)} ${args.join(" ")}  (awaited)`);
    const proc = spawn(script, args, { cwd: ROOT, stdio: "inherit" });
    proc.on("error", (err) => {
      console.error(`   ✗  failed to launch ${basename(script)}:`, err instanceof Error ? err.message : err);
      if (child1 === proc) child1 = null;
      resolve();
    });
    proc.on("exit", (code, signal) => {
      console.log(`   ⏹  ${basename(script)} exited (code=${code ?? "?"}${signal ? `, signal ${signal}` : ""})`);
      if (child1 === proc) child1 = null;
      resolve();
    });
    child1 = proc;
  });
}

/** Spawn the one-shot last-based child and wait for it to finish. */
function runSpreadLastCommand(script: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(script, args, { cwd: ROOT, stdio: "inherit" });
    awaitingSpreadLastCmd = { proc };
    const watchdog = setTimeout(() => {
      console.error(`   ⏱  ${basename(script)} did not exit within ${SPREAD_LAST_TIMEOUT_MS / 1000}s — SIGINTing it and moving on`);
      if (awaitingSpreadLastCmd?.proc === proc) awaitingSpreadLastCmd = null;
      proc.kill("SIGINT");
      resolve(124);
    }, SPREAD_LAST_TIMEOUT_MS);
    proc.on("error", (err) => {
      clearTimeout(watchdog);
      console.error(`   ✗  failed to launch ${basename(script)}:`, err instanceof Error ? err.message : err);
      if (awaitingSpreadLastCmd?.proc === proc) awaitingSpreadLastCmd = null;
      resolve(1);
    });
    proc.on("exit", (code, signal) => {
      clearTimeout(watchdog);
      if (awaitingSpreadLastCmd?.proc === proc) awaitingSpreadLastCmd = null;
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

function usage(): never {
  console.log(`
Usage: ./limit-launcher.ts

Runs two order scripts per side, chosen by the sign of markLast.txt:
  markLast > 0  → long-limit.ts   ${LONG_PRICE_MARK.join(" ")}   (awaited — waits for exit)
                 long-limit.ts   ${LONG_SPREAD_LAST.join(" ")} --gap -<gap> --qty <qty>   (awaited — waits for exit)
  markLast < 0  → short-limit.ts  ${SHORT_PRICE_MARK.join(" ")}   (awaited — waits for exit)
                 short-limit.ts  ${SHORT_SPREAD_LAST.join(" ")} --gap +<gap> --qty <qty>   (awaited — waits for exit)
Both children are awaited: the mark-based child runs its place → sleep → cancel
cycle and exits on its own; the last-based one-shot is
awaited to completion each cycle. The --gap of the last-based one-shot is
computed each cycle as min(max(|indexLast|, |markLast|), 10) / 100 with the
sign shown (- for long, + for short); its --qty is 0.1 when
max(|indexLast|, |markLast|) > 10, else 0.01. On a sign flip the launcher
simply switches sides for the next cycle (the awaited child has already exited).
markLast.txt and indexLast.txt are read from the project root.
Ctrl+C stops the children and exits.
`);
  process.exit(0);
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) usage();

  let stopRequested = false;
  process.on("SIGINT", () => {
    stopRequested = true;
    console.log("   ⏹  Stop requested — stopping children …");
    if (awaitingSpreadLastCmd) {
      awaitingSpreadLastCmd.proc.kill("SIGINT");
      awaitingSpreadLastCmd = null;
    }
  });

  const fmt = (v: number) => (Number.isNaN(v) ? "n/a" : String(v));

  for (let cycle = 1; !stopRequested; cycle++) {
    // console.log(`${cycleTag(cycle)} reading ${MARK_FILE} and ${INDEX_FILE} …`);
    const markLast = Math.max(readLastValue(MARK_FILE), 0.01);
    const indexLast = readLastValue(INDEX_FILE);
    const desired: Side | null = markLast > 0 ? "long" : markLast < 0 ? "short" : null;

    if (desired !== currentSide) {
      currentSide = desired;
    }

    if (desired === null) {
      console.log(`${cycleTag(cycle)} markLast=${fmt(markLast)} indexLast=${fmt(indexLast)} → no action (markLast must be non-zero), retrying in ${POLL_MS / 1000}s …`);
      await sleep(POLL_MS);
      continue;
    }

    // console.dir(SIDES)
    // console.log(desired)
    // const { script, priceMark, spreadLast } = SIDES[desired];
    const { script, priceMark, spreadLast } = SIDES["long"];
  
    if (isSideDisabled(desired)) {
      console.log(`${cycleTag(cycle)} ${desired} side disabled (DISABLE_LONG=${DISABLE_LONG}, DISABLE_SHORT=${DISABLE_SHORT}) — skipping both orders, retrying in ${DISABLED_POLL_MS / 1000}s …`);
      await sleep(DISABLED_POLL_MS);
      continue;
    }

    // Start the mark-based child; it exits after its own cycle.
    const priceMarkPromise = runPriceMarkCommand(script, priceMark);

    if (Number.isNaN(indexLast)) {
      console.log(`${cycleTag(cycle)} indexLast=${fmt(indexLast)} is not a number — skipping last-based placement (cannot compute --gap)`);
      await priceMarkPromise;
      if (stopRequested) break;
      await sleep(POLL_MS);
      continue;
    }
    const maxAbs = Math.abs(markLast); //maxAbsLastValue(markLast, indexLast);
    const gapMag = 0.05 - (Math.min(maxAbs, 0.4)) /2; //* 0.05 / 0.10;
    // const qty = maxAbs > 0.1 ? "0.1" : "0.01";
    const qty: Number = 0.01
    // const cmdSpreadLastArgs = [...spreadLast, "--gap", desired === "long" ? (-1 * gapMag).toFixed(2) : (+1 * gapMag).toFixed(2), "--qty", qty];
    const cmdSpreadLastArgs = [...spreadLast, "--gap", -0.10, "--qty", qty];
    console.log(markLast)

    console.log(`${cycleTag(cycle)} markLast=${fmt(markLast)} indexLast=${fmt(indexLast)} → running ${basename(script)} ${priceMark.join(" ")} and ${basename(script)} ${cmdSpreadLastArgs.join(" ")} in parallel (awaiting) …`);
    const [, code] = await Promise.all([priceMarkPromise, runSpreadLastCommand(script, cmdSpreadLastArgs)]);
    console.log(`${cycleTag(cycle)} ${basename(script)} (last-based) finished with exit code ${code}`);
    if (stopRequested) break;
    await sleep(POLL_MS);
  }

  console.log("Launcher stopped.");
}

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
