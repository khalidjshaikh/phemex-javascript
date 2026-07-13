#!/usr/bin/env node

import { getFlag, setFlag } from "../src/dynamodb-flag.js";

function usage() {
  console.error("Usage:");
  console.error("  dynamodb-flag get <key>                  # read a flag");
  console.error("  dynamodb-flag set <key> <true|false>     # set a flag");
  console.error("");
  console.error("Environment variables:");
  console.error("  FLAG_TABLE   DynamoDB table name (default: flags)");
  console.error("  AWS_REGION   AWS region (default: us-east-1)");
  process.exit(1);
}

async function main() {
  const [, , command, key, rawValue] = process.argv;

  if (!command || !key) usage();

  try {
    switch (command) {
      case "get": {
        const value = await getFlag(key);
        if (value === null) {
          console.log(`${key} → null (not found)`);
        } else {
          console.log(`${key} → ${value}`);
        }
        break;
      }

      case "set": {
        if (rawValue === undefined) usage();
        if (rawValue !== "true" && rawValue !== "false") {
          console.error(`Value must be "true" or "false", got "${rawValue}"`);
          process.exit(1);
        }
        const boolValue = rawValue === "true";
        await setFlag(key, boolValue);
        console.log(`${key} → ${boolValue}`);
        break;
      }

      default:
        usage();
    }
  } catch (err) {
    console.error("Error:", err.message);
    process.exit(1);
  }
}

main();