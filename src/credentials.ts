// SPDX-License-Identifier: MIT
/**
 * credentials.ts — Shared Phemex API credentials interface and loader.
 *
 * Exports:
 *   Credentials          — { PHEMEX_API_KEY, PHEMEX_API_SECRET }
 *   loadCredentials      — reads .phemex-credentials.json from a given directory
 *   loadCredentialsLocal — convenience: reads from the caller's directory
 */

import fs from "node:fs";
import path from "node:path";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface Credentials {
  PHEMEX_API_KEY: string;
  PHEMEX_API_SECRET: string;
}

/* ------------------------------------------------------------------ */
/*  Loader                                                             */
/* ------------------------------------------------------------------ */

/**
 * Load credentials from `.phemex-credentials.json` in the given directory.
 * @param credsDir  Directory containing the credentials file.
 *                  Defaults to the project root (one level above this
 *                  module's directory, i.e. the parent of src/).
 */
export function loadCredentials(credsDir?: string): Credentials {
  const dir = credsDir ?? path.resolve(import.meta.dirname, "..");
  const credsPath = path.resolve(dir, ".phemex-credentials.json");
  if (!fs.existsSync(credsPath)) {
    console.error("✗  Missing .phemex-credentials.json");
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(credsPath, "utf8"));
}

export function loadCredentialsPath(credsPath: string): Credentials {
  if (!fs.existsSync(credsPath)) {
    console.error(`✗  Missing ${credsPath}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(credsPath, "utf8"));
}


/**
 * Convenience: load credentials from the calling script's directory.
 * Equivalent to `loadCredentials(import.meta.dirname)`.
 */
export function loadCredentialsLocal(): Credentials {
  //return loadCredentials(import.meta.dirname);
  return loadCredentials();
}
