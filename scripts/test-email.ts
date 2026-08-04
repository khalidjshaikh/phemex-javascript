#!/usr/bin/env -S npx tsx
/**
 * Quick test: send an SMS to the phone configured in .env.
 *
 * Uses the notifyPhone() helper from src/notify.ts (email-to-SMS gateway).
 *
 * Usage:
 *   npx tsx test-email.ts                       # message from BODY env (or default)
 *   npx tsx test-email.ts "Your message here"
 *   DRY_RUN=1 npx tsx test-email.ts             # validate config only, no send
 */

import { notifyPhone } from "../src/notify.js";

async function main() {
  const message = process.argv[2] ?? process.env.BODY ?? "Hello from phemex-javascript!";
  const subject = process.env.SUBJECT ?? "Test from phemex-javascript";

  console.log(`📧  Sending SMS: ${message}`);

  const result = await notifyPhone(message, subject);
  if (result) {
    console.log("✅ Message sent!");
    console.log(`   Message ID: ${result.messageId}`);
    console.log(`   Response:   ${result.response}`);
  }
}

main().catch((err) => {
  console.error("❌ Failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
