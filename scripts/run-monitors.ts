#!/usr/bin/env -S npx tsx
/**
 * run-monitors.ts — Run both price monitors concurrently.
 *
 * Spawns monitor-tsla.ts and monitor-xau.ts as child processes, forwarding
 * their output to the parent terminal. Press Ctrl+C to stop both.
 *
 * Usage:
 *   npx tsx run-monitors.ts
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

// __dirname is available in CommonJS

function fmtTime(): string {
  return new Date().toLocaleString();
}

function runMonitor(name: string, script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, script);
    const child = spawn("npx", ["tsx", scriptPath], {
      stdio: ["ignore", "inherit", "inherit"],
      shell: true,
      env: { ...process.env as Record<string, string> },
    });

    child.on("close", (code) => {
      if (code === 0 || code === null) {
        resolve();
      } else {
        console.warn(`[${fmtTime()}]  ⚠  ${name} exited with code ${code}`);
        resolve(); // keep the other monitor running
      }
    });

    child.on("error", (err) => {
      console.error(`[${fmtTime()}]  ✗  ${name} failed: ${err.message}`);
      resolve(); // keep the other monitor running
    });
  });
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log(`[${fmtTime()}]  🚀  Starting price monitors (60s polling)`);
  console.log(`     Monitor 1: monitor-tsla.ts (TSLAUSDT, threshold 300 USDT)`);
  console.log(`     Monitor 2: monitor-xau.ts  (XAUUSDT,  threshold 4000 USDT)`);
  console.log(`     Press Ctrl+C to stop both.`);
  console.log("");

  // Run both monitors concurrently
  await Promise.all([
    runMonitor("TSLAUSDT", "monitor-tsla.ts"),
    runMonitor("XAUUSDT",  "monitor-xau.ts"),
  ]);

  console.log(`[${fmtTime()}]  ✅  Both monitors have stopped.`);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
