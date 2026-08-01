#!/usr/bin/env npx tsx
/**
 * Quick test: send an email / SMS using the Mailer library.
 *
 * Usage:
 *   npx tsx test-email.ts                  # full send (reads creds from .env)
 *   DRY_RUN=1 npx tsx test-email.ts       # validate config only, no send
 */

import "dotenv/config";
import { Mailer } from "../src/mailer.js";

async function main() {
  const mailer = Mailer.fromEnv();
  const toAddr = process.env.TO_ADDR ?? "";
  const subject = process.env.SUBJECT ?? "Test from phemex-javascript";
  const body = process.env.BODY ?? "Hello from phemex-javascript!\n\nThis is a test message.";
  const dryRun = process.env.DRY_RUN === "1";

  if (!toAddr) {
    console.error("❌ TO_ADDR is not set in .env");
    process.exit(1);
  }

  console.log(`📧  To:      ${toAddr}`);
  console.log(`📧  Subject: ${subject}`);
  console.log(`📧  Body:    ${body}`);
  console.log(`📧  Dry-run: ${dryRun}`);
  console.log();

  if (dryRun) {
    console.log("✅ Config looks good (dry-run, no send).");
    return;
  }

  const result = await mailer.send({ to: toAddr, subject, text: body });
  console.log("✅ Message sent!");
  console.log(`   Message ID: ${result.messageId}`);
  console.log(`   Response:   ${result.response}`);

  await mailer.close();
}

main().catch((err) => {
  console.error("❌ Failed:", err);
  process.exit(1);
});
