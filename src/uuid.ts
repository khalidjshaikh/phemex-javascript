// SPDX-License-Identifier: MIT
/**
 * uuid.ts — UUID v4 generation.
 *
 * Usage:
 *   import { uuid } from "./src/uuid.js";
 *   const id = uuid();
 */

import crypto from "node:crypto";

/** Generate a random UUID v4 string. */
export function uuid(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for older Node versions
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}