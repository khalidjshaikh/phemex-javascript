#!/usr/bin/env npx tsx
import { readFileSync } from "fs";

const FILES = {
  ask: "ask.txt",
  bid: "bid.txt",
  index: "index.txt",
  mark: "mark.txt",
  last: "last.txt",
} as const;

const LABELS = {
  ask: "A",
  bid: "B",
  index: "I",
  mark: "M",
  last: "L",
} as const;

const COLORS = {
  ask: "\x1b[31m",   // red
  bid: "\x1b[32m",   // green
  index: "\x1b[36m", // cyan
  mark: "\x1b[33m",  // yellow
  last: "\x1b[35m",  // magenta
} as const;

const RESET = "\x1b[0m";
const LINE_WIDTH = 72;

function readValue(file: string): number | null {
  try {
    const raw = readFileSync(file, "utf-8").trim();
    const val = parseFloat(raw);
    return isNaN(val) ? null : val;
  } catch {
    return null;
  }
}

function readAll(): Record<string, number | null> {
  const result: Record<string, number | null> = {};
  for (const [key, file] of Object.entries(FILES)) {
    result[key] = readValue(file);
  }
  return result;
}

function buildLine(values: Record<string, number | null>): string {
  const valid = Object.entries(values).filter(
    ([, v]) => v !== null
  ) as [string, number][];

  if (valid.length === 0) return "No data available.";

  const nums = valid.map(([, v]) => v);
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const range = max - min || 1;
  const pad = range * 0.05;
  const lo = min - pad;
  const hi = max + pad;
  const span = hi - lo;

  const line = Array(LINE_WIDTH).fill(" ");
  const occupied = Array(LINE_WIDTH).fill(false);

  for (const [key, val] of valid) {
    let pos = Math.round(((val - lo) / span) * (LINE_WIDTH - 1));
    pos = Math.max(0, Math.min(LINE_WIDTH - 1, pos));

    let offset = 0;
    while (occupied[pos] && offset < LINE_WIDTH) {
      offset++;
      const next = pos + (offset % 2 === 1 ? offset : -offset);
      if (next >= 0 && next < LINE_WIDTH && !occupied[next]) {
        pos = next;
        break;
      }
    }

    line[pos] = LABELS[key as keyof typeof LABELS];
    occupied[pos] = true;
  }

  const bar = line.map((ch, i) => {
    if (ch === " ") return ch;
    const key = valid.find(
      ([k]) => LABELS[k as keyof typeof LABELS] === ch
    )?.[0];
    const color = key ? COLORS[key as keyof typeof COLORS] : "";
    return `${color}${ch}${RESET}`;
  });

  const rulerStart = lo.toFixed(1);
  const rulerEnd = hi.toFixed(1);
  const ruler = `  ${rulerStart.padEnd(8)}${"─".repeat(LINE_WIDTH - 18)}${rulerEnd.padStart(8)}`;

  return `${ruler}\n  ${bar.join("")}`;
}

function legend(values: Record<string, number | null>): string {
  const parts: string[] = [];
  for (const [key, val] of Object.entries(values)) {
    const label = LABELS[key as keyof typeof LABELS];
    const color = COLORS[key as keyof typeof COLORS];
    const display = val !== null ? val.toFixed(2) : "N/A";
    parts.push(`${color}${label}${RESET}=${display}`);
  }
  return parts.join("  ");
}

function render(values: Record<string, number | null>): void {
  process.stdout.write("\x1b[2J\x1b[H");
  console.log("Price Number Line\n");
  console.log(buildLine(values));
  console.log();
  console.log(legend(values));
  console.log(`\nUpdated: ${new Date().toLocaleTimeString()}`);
}

function main(): void {
  render(readAll());
  setInterval(() => render(readAll()), 1000);
}

main();
