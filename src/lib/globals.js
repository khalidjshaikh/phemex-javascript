// persistent-globals.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STORE_FILE = path.join(__dirname, "globals.json");

function isSerializable(value) {
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

function loadGlobals() {
  if (!fs.existsSync(STORE_FILE)) {
    return;
  }

  const data = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));

  for (const [key, value] of Object.entries(data)) {
    try {
      globalThis[key] = value;
    } catch {}
  }
  console.log("Loaded globals");
}

function saveGlobals() {
  const data = {};

  for (const key of Object.keys(globalThis)) {
    const value = globalThis[key];

    if (isSerializable(value)) {
      data[key] = value;
    }
  }

  fs.writeFileSync(
    STORE_FILE,
    JSON.stringify(data, null, 2)
  );

  console.log("Saved globals");
}

// Load immediately when imported
loadGlobals();

// Save on exit
process.on("exit", saveGlobals);

process.on("SIGINT", () => {
  saveGlobals();
  process.exit(0);
});

process.on("SIGTERM", () => {
  saveGlobals();
  process.exit(0);
});
