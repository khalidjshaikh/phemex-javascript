#!/usr/bin/env npx tsx

/**
 * Phemex Public Time — fetches the server timestamp.
 * Public endpoint, no credentials needed.
 *
 * Usage:  npx tsx phemex-public-time.ts
 */

import { publicGet } from "./src/http-client.js";

async function main(): Promise<void> {
  const resp = await publicGet("/public/time", null);

  if (resp.code !== 0) {
    console.error("API error:", resp.msg || "unknown error");
    process.exit(1);
  }

  const serverTime = (resp.data as { serverTime?: number })?.serverTime;
  if (serverTime == null) {
    console.error("Missing serverTime in response");
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
