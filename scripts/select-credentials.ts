#!/usr/bin/env -S npx tsx
// SPDX-License-Identifier: MIT
/**
 * select-credentials.ts  —  Phemex credential selector.
 *
 * Reads the named credential vault (.credentials.json) at the project root,
 * lets you pick a set interactively (or by --name), and writes it to
 * .phemex-credentials.json so every other script uses the selected account.
 *
 * Usage:
 *   npx tsx scripts/select-credentials.ts               # interactive picker
 *   npx tsx scripts/select-credentials.ts --list        # list sets only
 *   npx tsx scripts/select-credentials.ts --name meta   # select non-interactively
 *   npx tsx scripts/select-credentials.ts --help        # show this help
 *
 * Exit codes:
 *   0   Selection written (or --list ran)
 *   1   Vault missing/empty/invalid, or unknown --name
 */

import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import { getArg, hasFlag } from "../src/cli-utils.js";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** One named credential set, e.g. { PHEMEX_API_KEY, PHEMEX_API_SECRET } */
type CredentialSet = Record<string, string>;
/** Vault file contents: name → credential set */
type Vault = Record<string, CredentialSet>;

/* ------------------------------------------------------------------ */
/*  Paths                                                              */
/* ------------------------------------------------------------------ */

const PROJECT_ROOT = path.resolve(__dirname, "..");
const VAULT_PATH = path.join(PROJECT_ROOT, ".credentials.json");
const ACTIVE_PATH = path.join(PROJECT_ROOT, ".phemex-credentials.json");

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function usage(): never {
  console.log(`
Usage: npx tsx scripts/select-credentials.ts [options]

Pick which Phemex credential set from .credentials.json is written to
.phemex-credentials.json (the file all other scripts read).

Options:
  --list              List available sets and the active one, then exit
  --name <set>        Select a set by name without prompting
  --help, -h          Show this help message
`);
  process.exit(0);
}

/** Short masked form of an API key for safe display, e.g. "dcfa…a62" */
function maskKey(key: string): string {
  return key.length > 8 ? `${key.slice(0, 4)}…${key.slice(-3)}` : "••••";
}

/** Read and validate the credential vault; exit(1) if unusable. */
function loadVault(): Vault {
  if (!fs.existsSync(VAULT_PATH)) {
    console.error(`✗  Missing ${VAULT_PATH}`);
    console.error(
      '   Create it with named sets, e.g. { "gmail": { "PHEMEX_API_KEY": …, "PHEMEX_API_SECRET": … } }',
    );
    process.exit(1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(VAULT_PATH, "utf8"));
  } catch (err) {
    console.error(`✗  Invalid JSON in ${VAULT_PATH}: ${(err as Error).message}`);
    process.exit(1);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    console.error(`✗  ${VAULT_PATH} must be a JSON object of named credential sets`);
    process.exit(1);
  }
  const vault = parsed as Vault;
  const names = Object.keys(vault);
  if (names.length === 0) {
    console.error(`✗  ${VAULT_PATH} contains no credential sets`);
    process.exit(1);
  }
  for (const [name, set] of Object.entries(vault)) {
    if (
      typeof set !== "object" || set === null ||
      typeof set.PHEMEX_API_KEY !== "string" ||
      typeof set.PHEMEX_API_SECRET !== "string"
    ) {
      console.warn(`⚠  Skipping invalid set "${name}": needs PHEMEX_API_KEY and PHEMEX_API_SECRET strings`);
      delete vault[name];
    }
  }
  if (Object.keys(vault).length === 0) {
    console.error(`✗  ${VAULT_PATH} has no valid credential sets`);
    process.exit(1);
  }
  return vault;
}

/** Which vault set currently matches .phemex-credentials.json, if any. */
function activeName(vault: Vault): string | null {
  if (!fs.existsSync(ACTIVE_PATH)) return null;
  try {
    const active = JSON.parse(fs.readFileSync(ACTIVE_PATH, "utf8")) as Record<string, unknown>;
    for (const [name, set] of Object.entries(vault)) {
      if (
        set.PHEMEX_API_KEY === active.PHEMEX_API_KEY &&
        set.PHEMEX_API_SECRET === active.PHEMEX_API_SECRET
      ) {
        return name;
      }
    }
  } catch {
    /* unreadable/corrupt active file → no match */
  }
  return null;
}

/** Print the numbered list of sets, marking the active one. */
function listSets(vault: Vault, active: string | null): void {
  const names = Object.keys(vault);
  console.log(`Credential vault: ${VAULT_PATH}`);
  names.forEach((name, i) => {
    const marker = name === active ? "●" : "○";
    console.log(
      `  ${String(i + 1).padStart(2)}. ${marker} ${name.padEnd(16)} ${maskKey(vault[name].PHEMEX_API_KEY)}`,
    );
  });
  console.log(
    active
      ? `\nCurrently active: ${active}`
      : `\nNo active set (${ACTIVE_PATH} missing or unmatched)`,
  );
}

/** Prompt for a selection by number or name; returns the chosen name or null. */
async function promptSelection(vault: Vault, active: string | null): Promise<string | null> {
  const names = Object.keys(vault);
  listSets(vault, active);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let answer = "";
  try {
    answer = (await rl.question(`\nSelect credential set [1-${names.length}] or name: `)).trim();
  } finally {
    rl.close();
  }
  if (!answer) return null;
  const asNumber = Number(answer);
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= names.length) {
    return names[asNumber - 1];
  }
  if (vault[answer]) return answer;
  console.error(`✗  Unknown set: ${answer}`);
  return null;
}

/** Write the chosen set to .phemex-credentials.json. */
function writeActive(name: string, set: CredentialSet): void {
  fs.writeFileSync(ACTIVE_PATH, JSON.stringify(set, null, 2) + "\n");
  console.log(`✓  ${name} → .phemex-credentials.json (key ${maskKey(set.PHEMEX_API_KEY)})`);
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  if (hasFlag("--help") || hasFlag("-h")) usage();

  const vault = loadVault();
  const active = activeName(vault);

  if (hasFlag("--list")) {
    listSets(vault, active);
    return;
  }

  const requested = getArg("--name");
  const name = requested ?? (await promptSelection(vault, active));
  if (!name) {
    console.error("✗  No set selected — .phemex-credentials.json unchanged");
    process.exit(1);
  }
  if (requested && !vault[name]) {
    console.error(`✗  Unknown credential set: ${name}`);
    process.exit(1);
  }
  writeActive(name, vault[name]);
}

main().catch((err) => {
  console.error(`✗  Unexpected error: ${(err as Error).message}`);
  process.exit(1);
});
