#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * limit-launcher.ts — Runs two orders per side based on the sign of markLast.txt:
 *
 *   markLast > 0:
 *     1) long-limit.ts  (mark-based)           → spawned, NOT awaited
 *     2) long-limit.ts  (last-based, one-shot) → spawned and AWAITED (waits for exit)
 *   markLast < 0:
 *     1) short-limit.ts (mark-based)           → spawned, NOT awaited
 *     2) short-limit.ts (last-based, one-shot) → spawned and AWAITED (waits for exit)
 *
 * The launcher loops forever; each cycle it re-reads markLast.txt/indexLast.txt,
 * keeps exactly one mark-based child per side alive (respawns if it exits), and
 * awaits the one-shot last-based placement. On a sign flip the old child is
 * SIGINTed (it finishes its current cycle) before the new side starts.
 * The awaited one-shot has a watchdog: if it does not exit within CMD2_TIMEOUT_MS
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

/** Per-side commands: cmd1 is spawned without awaiting, cmd2 is awaited. */
const LONG_CMD1 = [
  "--symbol", "XBRUSDT",
  "--spread", "-0",
  "--gap", "-0.01",
  "--dispersion", "1",
  "--qty", "0.01",
  "--cancel",
  "--sleep", "5",
  "--takeProfit", "mark+.1",
  "--price", "mark",
];

const LONG_CMD2 = [
  "--symbol", "XBRUSDT",
  "--spread", "-16",
  "--dispersion", "1",
  "--cancel",
  "--sleep", "5",
  "--takeProfit", "last+.1",
  "--price", "last",
];

const SHORT_CMD1 = [
  "--symbol", "XBRUSDT",
  "--spread", "+0",
  "--gap", "+0.01",
  "--dispersion", "1",
  "--qty", "0.01",
  "--cancel",
  "--sleep", "5",
  "--takeProfit", "mark-.1",
  "--price", "mark",
];

const SHORT_CMD2 = [
  "--symbol", "XBRUSDT",
  "--spread", "+16",
  "--dispersion", "1",
  "--cancel",
  "--sleep", "5",
  "--takeProfit", "last-.1",
  "--price", "last",
];

const SIDES: Record<Side, { script: string; cmd1: string[]; cmd2: string[] }> = {
  long: { script: LONG_SCRIPT, cmd1: LONG_CMD1, cmd2: LONG_CMD2 },
  short: { script: SHORT_SCRIPT, cmd1: SHORT_CMD1, cmd2: SHORT_CMD2 },
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
const CMD2_TIMEOUT_MS = 20_000;

/** Kill-switches per side: when true, neither the mark-based spawn (cmd1)
 *  nor the last-based one-shot (cmd2) is run for that side. */
const DISABLE_LONG = false;
const DISABLE_SHORT = true;

function isSideDisabled(side: Side): boolean {
  return side === "long" ? DISABLE_LONG : DISABLE_SHORT;
}

let child1: ChildProcess | null = null; // mark-based child (not awaited)
let currentSide: Side | null = null;
let awaitingCmd2: { proc: ChildProcess } | null = null;

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

/** Spawn the mark-based child; do NOT await it. Respawns once it exits. */
function spawnCmd1(script: string, args: string[]): void {
  console.log(`   ▶  starting ${basename(script)} ${args.join(" ")}  (not awaited)`);
  const proc = spawn(script, args, { cwd: ROOT, stdio: "inherit" });
  proc.on("error", (err) => {
    console.error(`   ✗  failed to launch ${basename(script)}:`, err instanceof Error ? err.message : err);
    if (child1 === proc) child1 = null;
  });
  proc.on("exit", (code, signal) => {
    console.log(`   ⏹  ${basename(script)} exited (code=${code ?? "?"}${signal ? `, signal ${signal}` : ""})`);
    if (child1 === proc) child1 = null;
  });
  child1 = proc;
}

/** SIGINT the mark-based child (it finishes its current cycle) and forget it. */
function stopCmd1(): void {
  if (!child1) return;
  console.log("   ⏹  stopping mark-based child (SIGINT — finishes current cycle) …");
  child1.kill("SIGINT");
  child1 = null;
}

/** Spawn the one-shot last-based child and wait for it to finish. */
function runCmd2(script: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn(script, args, { cwd: ROOT, stdio: "inherit" });
    awaitingCmd2 = { proc };
    const watchdog = setTimeout(() => {
      console.error(`   ⏱  ${basename(script)} did not exit within ${CMD2_TIMEOUT_MS / 1000}s — SIGINTing it and moving on`);
      if (awaitingCmd2?.proc === proc) awaitingCmd2 = null;
      proc.kill("SIGINT");
      resolve(124);
    }, CMD2_TIMEOUT_MS);
    proc.on("error", (err) => {
      clearTimeout(watchdog);
      console.error(`   ✗  failed to launch ${basename(script)}:`, err instanceof Error ? err.message : err);
      if (awaitingCmd2?.proc === proc) awaitingCmd2 = null;
      resolve(1);
    });
    proc.on("exit", (code, signal) => {
      clearTimeout(watchdog);
      if (awaitingCmd2?.proc === proc) awaitingCmd2 = null;
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

function usage(): never {
  console.log(`
Usage: ./limit-launcher.ts

Runs two order scripts per side, chosen by the sign of markLast.txt:
  markLast > 0  → long-limit.ts   ${LONG_CMD1.join(" ")}   (spawned, not awaited)
                 long-limit.ts   ${LONG_CMD2.join(" ")} --gap -<gap> --qty <qty>   (awaited — waits for exit)
  markLast < 0  → short-limit.ts  ${SHORT_CMD1.join(" ")}   (spawned, not awaited)
                 short-limit.ts  ${SHORT_CMD2.join(" ")} --gap +<gap> --qty <qty>   (awaited — waits for exit)
The mark-based child is spawned without waiting; the last-based one-shot is
awaited to completion each cycle. The --gap of the last-based one-shot is
computed each cycle as min(max(|indexLast|, |markLast|), 10) / 100 with the
sign shown (- for long, + for short); its --qty is 0.1 when
max(|indexLast|, |markLast|) > 10, else 0.01. On a sign flip the old child is
stopped with SIGINT (it finishes its current cycle) and the new side starts.
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
    stopCmd1();
    if (awaitingCmd2) {
      awaitingCmd2.proc.kill("SIGINT");
      awaitingCmd2 = null;
    }
  });

  const fmt = (v: number) => (Number.isNaN(v) ? "n/a" : String(v));

  for (let cycle = 1; !stopRequested; cycle++) {
    // console.log(`${cycleTag(cycle)} reading ${MARK_FILE} and ${INDEX_FILE} …`);
    const markLast = readLastValue(MARK_FILE);
    const indexLast = readLastValue(INDEX_FILE);
    const desired: Side | null = markLast > 0 ? "long" : markLast < 0 ? "short" : null;

    if (desired !== currentSide) {
      stopCmd1();
      currentSide = desired;
    }

    if (desired === null) {
      console.log(`${cycleTag(cycle)} markLast=${fmt(markLast)} indexLast=${fmt(indexLast)} → no action (markLast must be non-zero), retrying in ${POLL_MS / 1000}s …`);
      await sleep(POLL_MS);
      continue;
    }

    const { script, cmd1, cmd2 } = SIDES[desired];
    // console.log(desired)
    // console.log(SIDES[desired])
    // console.log(isSideDisabled(desired))
    if (isSideDisabled(desired)) {
      console.log(`${cycleTag(cycle)} ${desired} side disabled (DISABLE_LONG=${DISABLE_LONG}, DISABLE_SHORT=${DISABLE_SHORT}) — skipping both orders, retrying in ${DISABLED_POLL_MS / 1000}s …`);
      await sleep(DISABLED_POLL_MS);
      continue;
    }

    // console.log(child1)
    if (!child1) {
      // console.log("spawn")
      spawnCmd1(script, cmd1);
    } else {
      console.log(`${cycleTag(cycle)} mark-based ${desired} child already running, keeping it`);
    }

    if (Number.isNaN(indexLast)) {
      console.log(`${cycleTag(cycle)} indexLast=${fmt(indexLast)} is not a number — skipping last-based placement (cannot compute --gap)`);
      await sleep(POLL_MS);
      continue;
    }
    const maxAbs = Math.abs(markLast); //maxAbsLastValue(markLast, indexLast);
    const gapMag = 0.05 - (Math.min(maxAbs, 0.4)) /2; //* 0.05 / 0.10;
    // const gapMag = 0.05 - maxAbs/2; //* 0.05 / 0.10;
    const qty = maxAbs > 0.1 ? "0.1" : "0.01";
    const cmd2Args = [...cmd2, "--gap", desired === "long" ? (-1 * gapMag).toFixed(2) : (+1 * gapMag).toFixed(2), "--qty", qty];

    // console.log(`${cycleTag(cycle)} markLast=${fmt(markLast)} indexLast=${fmt(indexLast)} → running ${basename(script)} ${cmd2Args.join(" ")}  (awaiting) …`);
    // const code = await runCmd2(script, cmd2Args);
    // console.log(`${cycleTag(cycle)} ${basename(script)} (last-based) finished with exit code ${code}`);
    if (stopRequested) break;
    await sleep(POLL_MS);
  }

  stopCmd1();
  console.log("Launcher stopped.");
}

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
