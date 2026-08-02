#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * limit-launcher.ts — Infinite launcher that runs long-limit.ts or
 * short-limit.ts based on the sign of the value in markLast.txt.
 *
 * Each cycle:
 *   markLast > 0  → run  scripts/long-limit.ts   with LONG_ARGS
 *   markLast < 0  → run  scripts/short-limit.ts  with SHORT_ARGS
 *   markLast == 0 or unreadable → wait POLL_MS and re-check
 * The launcher waits for the spawned script to finish before looping again.
 * indexLast.txt is read alongside markLast.txt and logged for context.
 *
 * Usage: ./limit-launcher.ts   (Ctrl+C stops after the current run)
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const ROOT = resolve(__dirname, ".."); // project root — markLast.txt/indexLast.txt live here
const MARK_FILE = resolve(ROOT, "markLast.txt");
const INDEX_FILE = resolve(ROOT, "indexLast.txt");

const LONG_SCRIPT = resolve(__dirname, "long-limit.ts");
const SHORT_SCRIPT = resolve(__dirname, "short-limit.ts");

/** Default arguments for each side. */
const LONG_ARGS = [
  "--symbol", "XBRUSDT",
  "--spread", "-16",
  "--gap", "-0.05",
  "--dispersion", "1",
  "--qty", "0.01",
  "--cancel",
  "--sleep", "5",
  "--takeProfit", "last+.1",
  "--price", "last",
];

const SHORT_ARGS = [
  "--symbol", "XBRUSDT",
  "--spread", "+16",
  "--gap", "+0.05",
  "--dispersion", "1",
  "--qty", "0.01",
  "--cancel",
  "--sleep", "5",
  "--takeProfit", "last-.1",
  "--price", "last",
];

/** Pause between cycles (also the retry interval when no action applies). */
const POLL_MS = 1000;

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

/** Spawn a script with `inherit` stdio and resolve with its exit code. */
function runScript(script: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(script, args, { cwd: ROOT, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

function usage(): never {
  console.log(`
Usage: ./limit-launcher.ts

Runs scripts/long-limit.ts or scripts/short-limit.ts in an infinite loop,
choosing the side from the sign of markLast.txt:
  markLast > 0  → long-limit.ts   ${LONG_ARGS.join(" ")}
  markLast < 0  → short-limit.ts  ${SHORT_ARGS.join(" ")}
markLast.txt and indexLast.txt are read from the project root.
Ctrl+C stops after the current run finishes.
`);
  process.exit(0);
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) usage();

  let stopRequested = false;
  process.on("SIGINT", () => {
    stopRequested = true;
    console.log("   ⏹  Stop requested — finishing current run …");
  });

  const fmt = (v: number) => (Number.isNaN(v) ? "n/a" : String(v));

  for (let cycle = 1; !stopRequested; cycle++) {
    const markLast = readLastValue(MARK_FILE);
    const indexLast = readLastValue(INDEX_FILE);

    const script = markLast > 0 ? LONG_SCRIPT : markLast < 0 ? SHORT_SCRIPT : null;
    if (script === null) {
      console.log(
        `[${cycle}] markLast=${fmt(markLast)} indexLast=${fmt(indexLast)} → no action (markLast must be non-zero), retrying in ${POLL_MS / 1000}s …`
      );
      await sleep(POLL_MS);
      continue;
    }

    const args = script === LONG_SCRIPT ? LONG_ARGS : SHORT_ARGS;
    console.log(`[${cycle}] markLast=${fmt(markLast)} indexLast=${fmt(indexLast)} → running ${basename(script)}`);
    try {
      const code = await runScript(script, args);
      console.log(`[${cycle}] ${basename(script)} finished with exit code ${code}`);
    } catch (err) {
      console.error(`[${cycle}] ✗ failed to launch ${basename(script)}:`, err instanceof Error ? err.message : err);
    }
    if (stopRequested) break;
    await sleep(POLL_MS);
  }
  console.log("Launcher stopped.");
}

main().catch((err) => {
  console.error("✗", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
