// SPDX-License-Identifier: MIT
/**
 * persistence.ts — Shared JSON state persistence helpers.
 *
 * Provides:
 *   saveJson  — Write a JSON-serializable value to a file
 *   loadJson  — Read and parse a JSON file, returning null on failure
 *   saveState — Write state to a file (alias for saveJson)
 *   loadState — Read state from a file with type validation (alias for loadJson)
 *
 * Usage:
 *   import { saveJson, loadJson } from "./src/persistence.js";
 *   await saveJson("/path/to/file.json", { foo: 42 });
 *   const data = await loadJson<{ foo: number }>("/path/to/file.json");
 */

import fs from "node:fs";

/**
 * Serialize a value to JSON and write it to a file.
 * Synchronous — safe for use in signal handlers.
 */
export function saveJson<T>(filePath: string, data: T): void {
  try {
    const json = JSON.stringify(data);
    fs.writeFileSync(filePath, json, "utf8");
  } catch (e) {
    console.error(`Failed to save ${filePath}:`, e);
  }
}

/**
 * Read a JSON file and parse it.
 * Returns `null` if the file doesn't exist or parsing fails.
 */
export function loadJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as T;
    return parsed;
  } catch (e) {
    console.error(`Failed to load ${filePath}:`, e);
    return null;
  }
}

/**
 * Alias for saveJson — used for application state persistence.
 */
export function saveState<T>(filePath: string, state: T): void {
  saveJson(filePath, state);
}

/**
 * Alias for loadJson — used for application state persistence.
 */
export function loadState<T>(filePath: string): T | null {
  return loadJson<T>(filePath);
}