#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-public-time.ts  —  Fetches the Phemex server timestamp.
 *
 * Public endpoint, no credentials needed.
 *
 * Usage:
 *   npx tsx phemex-public-time.ts
 */

import { publicGet } from "../src/http-client.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface TimeResponse {
  code: number;
  msg?: string;
  data?: {
    serverTime?: number;
  };
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  console.error("⟐  Fetching /public/time …");

  const resp = (await publicGet("/public/time", null)) as unknown as TimeResponse;

  if (resp.code !== 0) {
    console.error(`✗  API error: ${resp.msg ?? resp.code}`);
    process.exit(1);
  }

  const serverTime = resp.data?.serverTime;
  if (serverTime == null) {
    console.error("✗  Missing serverTime in response");
    process.exit(1);
  }

  const date = new Date(serverTime);
  console.log("Phemex server time:");
  console.log(`  Timestamp:  ${serverTime}`);
  console.log(`  ISO:        ${date.toISOString()}`);
  console.log(`  Local:      ${date.toLocaleString()}`);
  console.log(`  UTC:        ${date.toUTCString()}`);
}

main().catch((e) => {
  console.error("Fatal:", (e as Error).message);
  process.exit(1);
});
