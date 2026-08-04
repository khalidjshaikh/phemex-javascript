#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * phemex-cancel-complex-orders.ts  —  Cancel ALL complex orders (including
 * untriggered) via the Phemex API.
 *
 * Endpoint:  DELETE https://{host}/complex-orders/cancel-all?untriggered=true
 *
 * The complex-orders endpoint uses JWT token auth (x-phemex-auth-token)
 * rather than the standard API-key HMAC signing.
 *
 * Arguments:
 *   --host         <host>  (optional)  API host (default: api.phemex.com)
 *   --untriggered  <bool>  (optional)  Cancel untriggered orders (default: true)
 *   --auth-token   <jwt>   (optional)  JWT auth token (default: reads from PHEMEX_AUTH_TOKEN env)
 *   --dry-run              (optional)  Print the request without sending it
 *   --help, -h             (optional)  Show this help message and exit
 *
 * Examples:
 *   npx tsx phemex-cancel-complex-orders.ts
 *   npx tsx phemex-cancel-complex-orders.ts --host api.phemex.com
 *   PHEMEX_AUTH_TOKEN="<jwt>" npx tsx phemex-cancel-complex-orders.ts
 *   npx tsx phemex-cancel-complex-orders.ts --auth-token "<jwt>"
 *   npx tsx phemex-cancel-complex-orders.ts --untriggered false --dry-run
 *   npx tsx phemex-cancel-complex-orders.ts --help
 */

import https from "node:https";
import { getArg, hasFlag } from "../src/cli-utils.js";

/* ------------------------------------------------------------------ */
/*  Config                                                             */
/* ------------------------------------------------------------------ */

const DEFAULT_HOST = "api.phemex.com";
const PATH = "/complex-orders/cancel-all";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function usage(host: string): never {
  console.log(`
Usage: ./phemex-cancel-complex-orders.ts [options]

Cancel ALL complex orders (including untriggered) on Phemex.

The complex-orders endpoint uses JWT token auth (x-phemex-auth-token).

Arguments:
  --host         <host>  (optional)  API host (default: ${DEFAULT_HOST})
  --untriggered  <bool>  (optional)  Cancel untriggered orders (default: true)
  --auth-token   <jwt>   (optional)  JWT auth token (default: PHEMEX_AUTH_TOKEN env)
  --dry-run              (optional)  Print the request details without sending it
  --help, -h             (optional)  Show this help message and exit

Endpoint:
  DELETE https://${host}${PATH}?untriggered=true

Examples:
  ./phemex-cancel-complex-orders.ts
  PHEMEX_AUTH_TOKEN="<jwt>" ./phemex-cancel-complex-orders.ts
  ./phemex-cancel-complex-orders.ts --auth-token "<jwt>"
  ./phemex-cancel-complex-orders.ts --untriggered false --dry-run
`);
  process.exit(0);
}

/**
 * Perform one token-authenticated DELETE request and parse the JSON response.
 * Uses x-phemex-auth-token header (JWT) instead of API-key HMAC signing.
 */
function deleteRequest(
  host: string,
  path: string,
  query: string | null,
  authToken: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const qs = query ? "?" + query : "";

    const req = https.request(
      {
        hostname: host,
        path: path + qs,
        method: "DELETE",
        headers: {
          "x-phemex-auth-token": authToken,
          "Content-Type": "application/json",
        },
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
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const host = getArg("--host") ?? DEFAULT_HOST;

  if (hasFlag("--help") || hasFlag("-h")) usage(host);

  const untriggeredRaw = getArg("--untriggered");
  const untriggered = untriggeredRaw !== "false"; // default true
  const dryRun = hasFlag("--dry-run");

  const query = `untriggered=${untriggered}`;

  // Auth token: --auth-token arg, or PHEMEX_AUTH_TOKEN env var
  const authToken = getArg("--auth-token") ?? process.env.PHEMEX_AUTH_TOKEN;
  if (!authToken) {
    console.error("✗  No auth token provided. Set --auth-token or PHEMEX_AUTH_TOKEN env.");
    process.exit(1);
  }

  if (dryRun) {
    console.log(`\n  DRY RUN — Would send:\n`);
    console.log(`  DELETE https://${host}${PATH}?${query}`);
    console.log(`  x-phemex-auth-token: ${authToken.slice(0, 20)}…${authToken.slice(-8)}`);
    console.log();
    process.exit(0);
  }

  console.log(`⟐  Cancelling complex orders on ${host} (untriggered=${untriggered}) …`);

  const resp = await deleteRequest(host, PATH, query, authToken);

  if (resp.code === 0) {
    const data = resp.data as Record<string, unknown> | undefined;
    const closedOrders = (data?.closedOrders as Record<string, unknown>[] | undefined) ?? [];
    const untriggeredOrders = (data?.untriggered as Record<string, unknown>[] | undefined) ?? [];

    console.log(`  ✓  ${closedOrders.length} active + ${untriggeredOrders.length} untriggered complex order(s) cancelled`);

    for (const o of closedOrders) {
      console.log(`     ${String(o.orderID ?? "?")}  ${String(o.side ?? "?")}  qty ${String(o.qty ?? "?")}`);
    }
    for (const o of untriggeredOrders) {
      console.log(`     ${String(o.orderID ?? "?")}  ${String(o.side ?? "?")}  qty ${String(o.qty ?? "?")}  (conditional)`);
    }
  } else {
    console.error(`  ✗  API error: ${String(resp.msg ?? resp.code)}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
