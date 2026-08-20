// SPDX-License-Identifier: MIT
/**
 * credentials.ts — Shared Phemex API credentials interface and loader.
 *
 * Exports:
 *   Credentials          — { PHEMEX_API_KEY, PHEMEX_API_SECRET }
 *   loadCredentials      — reads .phemex-credentials.json from a given directory
 *   loadCredentialsLocal — convenience: reads from the caller's directory
 *   loadCredentialNamed  — reads .credentials.json with a named profile
 */

import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";

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
  const dir = credsDir ?? path.resolve(__dirname, "..");
  const credsPath = path.resolve(dir, ".phemex-credentials.json");
  if (!fs.existsSync(credsPath)) {
    console.error("✗  Missing .phemex-credentials.json");
    process.exit(1);
  }
  return JSON5.parse(fs.readFileSync(credsPath, "utf8"));
}

export function loadCredentialsPath(credsPath: string): Credentials {
  if (!fs.existsSync(credsPath)) {
    console.error(`✗  Missing ${credsPath}`);
    process.exit(1);
  }
  return JSON5.parse(fs.readFileSync(credsPath, "utf8"));
}

/**
 * Load a named profile from `.credentials.json`.
 * File format: { "gmail": { "PHEMEX_API_KEY": "...", "PHEMEX_API_SECRET": "..." }, ... }
 * @param name      Profile name (e.g. "gmail", "meta", "high")
 * @param credsDir  Directory containing .credentials.json (default: project root)
 */
export function loadCredentialNamed(name: string, credsDir?: string): Credentials {
  const dir = credsDir ?? path.resolve(__dirname, "..");
  const credsPath = path.resolve(dir, ".credentials.json");
  if (!fs.existsSync(credsPath)) {
    console.error("✗  Missing .credentials.json");
    process.exit(1);
  }
  const all = JSON5.parse(fs.readFileSync(credsPath, "utf8")) as Record<string, Credentials>;
  const creds = all[name];
  if (!creds) {
    const available = Object.keys(all).join(", ");
    console.error(`✗  Credential profile "${name}" not found. Available: ${available}`);
    process.exit(1);
  }
  if (!creds.PHEMEX_API_KEY || !creds.PHEMEX_API_SECRET) {
    console.error(`✗  Credential profile "${name}" missing PHEMEX_API_KEY or PHEMEX_API_SECRET`);
    process.exit(1);
  }
  return creds;
}

/**
 * Convenience: load credentials from the calling script's directory.
 * Equivalent to `loadCredentials(import.meta.dirname)`.
 */
export function loadCredentialsLocal(): Credentials {
  //return loadCredentials(import.meta.dirname);
  return loadCredentials();
}
