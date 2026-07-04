#!/usr/bin/env node

/**
 * Phemex Public Time — fetches the server timestamp.
 * Public endpoint, no credentials needed.
 *
 * Usage:  npx tsx phemex-public-time.ts
 */

import https from "node:https";

const BASE = "api.phemex.com";

async function getTime(): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: BASE,
        path: "/public/time",
        method: "GET",
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Bad JSON: ${data.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

async function main(): Promise<void> {
  const resp = await getTime();

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
  console.error("Fatal:", e.message);
  process.exit(1);
});
