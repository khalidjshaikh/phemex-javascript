#!/usr/bin/env -S npx tsx
/**
 * monitor-xau.ts — Monitor XAUUSDT price via phemex-cli, notify when it
 * crosses 4000 USDT.
 *
 * Polls `phemex-cli get_ticker --symbol XAUUSDT` every 10 seconds. When the
 * mark price crosses the 4000 USDT threshold (above → below or below → above),
 * it runs test-email.ts with a custom notification message.
 *
 * Usage:
 *   npx tsx monitor-xau.ts
 */

import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

const SYMBOL = "XAUUSDT";
const THRESHOLD = 4000;
const POLL_INTERVAL_MS = 60_000; // 60 seconds

enum Side {
  Below = "below",
  Above = "above",
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function fmtTime(): string {
  return new Date().toLocaleString();
}

function fmtPrice(rp: string): string {
  const val = parseFloat(rp);
  return val.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Parse the JSON output of `phemex-cli get_ticker --symbol XAUUSDT`. */
interface TickerResult {
  markPrice: string;
  indexPrice: string;
  symbol: string;
  [key: string]: unknown;
}

function fetchTicker(): TickerResult {
  const stdout = execFileSync("phemex-cli", ["get_ticker", "--symbol", SYMBOL], {
    encoding: "utf-8",
  });
  const body = JSON.parse(stdout);
  if (body.error) {
    throw new Error(`API error: ${JSON.stringify(body.error)}`);
  }
  return body as TickerResult;
}

/**
 * Spawn test-email.ts with env vars set for the XAUUSDT alert.
 * Returns a promise that resolves when the subprocess exits.
 */
function sendAlert(markPrice: string, direction: "above" | "below"): Promise<void> {
  return new Promise((resolve, reject) => {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const script = path.join(__dirname, "test-email.ts");

    const price = fmtPrice(markPrice);
    const subject = `🚨 XAUUSDT crossed ${direction} ${THRESHOLD} USDT`;
    const body = [
      `XAUUSDT price alert!`,
      ``,
      `Price crossed ${direction} ${THRESHOLD} USDT.`,
      `Current mark price: ${price} USDT`,
      `Time: ${fmtTime()}`,
    ].join("\n");

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      SUBJECT: subject,
      BODY: body,
    };

    console.log(`[${fmtTime()}]  📧  Sending alert: ${subject}`);
    console.log(`[${fmtTime()}]  📧  Body:\n${body}\n`);

    const child = spawn("npx", ["tsx", script], {
      env,
      stdio: "inherit",
      shell: true,
    });

    child.on("close", (code) => {
      if (code === 0) {
        console.log(`[${fmtTime()}]  ✅  Alert sent successfully`);
        resolve();
      } else {
        console.warn(`[${fmtTime()}]  ⚠  Alert process exited with code ${code}`);
        resolve(); // don't reject — the monitor should keep running
      }
    });

    child.on("error", (err) => {
      console.error(`[${fmtTime()}]  ✗  Failed to spawn alert: ${err.message}`);
      resolve(); // keep running
    });
  });
}

/* ------------------------------------------------------------------ */
/*  Main loop                                                          */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log(`[${fmtTime()}]  ⚡  Starting XAUUSDT price monitor`);
  console.log(`     Threshold:   ${THRESHOLD} USDT`);
  console.log(`     Poll every:  ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`     CLI:         phemex-cli get_ticker --symbol ${SYMBOL}`);
  console.log("");

  let prevSide: Side | null = null; // null = no previous reading
  let running = true;

  // Register Ctrl+C handler
  process.on("SIGINT", () => {
    console.log(`\n[${fmtTime()}]  ⏹  Shutting down …`);
    running = false;
  });

  while (running) {
    try {
      const ticker = fetchTicker();
      const markPrice = parseFloat(ticker.markPrice);
      const indexPrice = parseFloat(ticker.indexPrice);
      const currentSide = markPrice >= THRESHOLD ? Side.Above : Side.Below;

      console.log(
        `[${fmtTime()}]  ${SYMBOL}  ` +
        `mark: ${fmtPrice(ticker.markPrice)}  ` +
        `index: ${fmtPrice(ticker.indexPrice)}  ` +
        `(threshold: ${THRESHOLD})`
      );

      // Check for crossing event (skip on first reading)
      if (prevSide !== null && currentSide !== prevSide) {
        const direction = currentSide === Side.Above ? "above" : "below";
        console.log(
          `[${fmtTime()}]  🚨  Crossed ${direction} ${THRESHOLD}! ` +
          `(was ${prevSide}, now ${currentSide} — mark price: ${fmtPrice(ticker.markPrice)})`
        );
        await sendAlert(ticker.markPrice, direction);
      }

      prevSide = currentSide;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${fmtTime()}]  ✗  Error: ${msg}`);
    }

    // Wait for next poll
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  console.log(`[${fmtTime()}]  ✅  Monitor stopped`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
