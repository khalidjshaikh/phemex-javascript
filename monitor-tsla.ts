#!/usr/bin/env npx tsx
/**
 * monitor-tsla.ts — Monitor TSLAUSDT price, notify via email when it
 * crosses the 300 USDT threshold.
 *
 * Polls the Phemex public ticker every 10 seconds. When the mark price
 * crosses 300 USDT (above→below or below→above), it sends an email
 * via nodemailer using the Mailer library.
 *
 * Environment variables (via .env):
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, FROM_ADDR, TO_ADDR
 *
 * Usage:
 *   npx tsx monitor-tsla.ts
 */

import "dotenv/config";
import { Mailer } from "./src/mailer.js";

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

const SYMBOL = "TSLAUSDT";
const THRESHOLD = 300;
const POLL_INTERVAL_MS = 60_000; // 60 seconds
const TICKER_URL = "https://testnet-api.phemex.com/md/v2/ticker/24hr";

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

/** Fetch the TSLAUSDT ticker from Phemex public API. */
interface TickerResult {
  markPriceRp: string;
  indexPriceRp: string;
  symbol: string;
  [key: string]: unknown;
}

async function fetchTicker(): Promise<TickerResult> {
  const url = `${TICKER_URL}?symbol=${SYMBOL}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }
  const body = await res.json();
  if (body.error) {
    throw new Error(`API error: ${JSON.stringify(body.error)}`);
  }
  return body.result as TickerResult;
}

/**
 * Send an email alert via the Mailer library.
 */
async function sendAlert(
  mailer: Mailer,
  to: string,
  markPrice: string,
  direction: "above" | "below",
): Promise<void> {
  const price = fmtPrice(markPrice);
  const subject = `🚨 TSLAUSDT crossed ${direction} ${THRESHOLD} USDT`;
  const body = [
    `TSLAUSDT price alert!`,
    ``,
    `Price crossed ${direction} ${THRESHOLD} USDT.`,
    `Current mark price: ${price} USDT`,
    `Time: ${fmtTime()}`,
  ].join("\n");

  console.log(`[${fmtTime()}]  📧  Sending alert: ${subject}`);
  console.log(`[${fmtTime()}]  📧  Body:\n${body}\n`);

  try {
    const result = await mailer.send({ to, subject, text: body });
    console.log(`[${fmtTime()}]  ✅  Alert sent (ID: ${result.messageId})`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${fmtTime()}]  ✗  Failed to send alert: ${msg}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Main loop                                                          */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.log(`[${fmtTime()}]  ⚡  Starting TSLAUSDT price monitor`);
  console.log(`     Threshold:   ${THRESHOLD} USDT`);
  console.log(`     Poll every:  ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`     API:         ${TICKER_URL}`);
  console.log("");

  // Initialise mailer once
  const toAddr = process.env.TO_ADDR ?? "";
  if (!toAddr) {
    console.error("❌ TO_ADDR is not set in .env — alerts will not be sent!");
    process.exit(1);
  }
  const mailer = Mailer.fromEnv();

  let prevSide: Side | null = null; // null = no previous reading
  let running = true;

  // Register Ctrl+C handler
  process.on("SIGINT", () => {
    console.log(`\n[${fmtTime()}]  ⏹  Shutting down …`);
    running = false;
  });

  while (running) {
    try {
      const ticker = await fetchTicker();
      const markPrice = parseFloat(ticker.markPriceRp);
      const indexPrice = parseFloat(ticker.indexPriceRp);
      const currentSide = markPrice >= THRESHOLD ? Side.Above : Side.Below;

      console.log(
        `[${fmtTime()}]  TSLAUSDT  ` +
        `mark: ${fmtPrice(ticker.markPriceRp)}  ` +
        `index: ${fmtPrice(ticker.indexPriceRp)}  ` +
        `(threshold: ${THRESHOLD})`
      );

      // Check for crossing event (skip on first reading)
      if (prevSide !== null && currentSide !== prevSide) {
        const direction = currentSide === Side.Above ? "above" : "below";
        console.log(
          `[${fmtTime()}]  🚨  Crossed ${direction} ${THRESHOLD}! ` +
          `(was ${prevSide}, now ${currentSide} — mark price: ${fmtPrice(ticker.markPriceRp)})`
        );
        await sendAlert(mailer, toAddr, ticker.markPriceRp, direction);
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
