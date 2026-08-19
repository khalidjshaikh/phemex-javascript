#!/usr/bin/env -S npx tsx

import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { ReconnectingWs } from "../src/ws-client.js";
import { findSymbolRow, getArg, hasFlag } from "../src/cli-utils.js";
import { loadCredentials } from "../src/credentials.js";
import { placeMarketOrder } from "../src/place-limit-order.js";
import { fetchPositions, closePosition } from "../src/positions.js";

const WS_URL = "wss://ws.phemex.com";

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: phemex-ws-last-price [SYMBOL] [options]

Connects to Phemex WebSocket and displays live last price data.
Optionally trades based on index vs last price comparison.

Options:
  --trade              Enable trading logic (disabled by default)
  --credential <name>  Credential profile (e.g. 67b)
  -h, --help           Show this help message

Trading Logic (when --trade is enabled):
  If index < last: buy short size 0.001, close any long positions
  If index > last: buy long size 0.001, close any short positions

Examples:
  phemex-ws-last-price BTCUSDT
  phemex-ws-last-price ETHUSDT --trade --credential 67b`);
  process.exit(0);
}

const credential = getArg("--credential");
const enableTrade = hasFlag("--trade");
const SYMBOL = process.argv.find(a => !a.startsWith("-") && a !== process.argv[0] && a !== process.argv[1] && a !== credential) || "BTCUSDT";

function loadCredentialProfile(name: string): { PHEMEX_API_KEY: string; PHEMEX_API_SECRET: string } {
  const credsPath = path.resolve(process.cwd(), ".credentials.json");
  if (!fs.existsSync(credsPath)) {
    console.error(`✗  Missing ${credsPath}`);
    process.exit(1);
  }
  const all = JSON5.parse(fs.readFileSync(credsPath, "utf8")) as Record<string, { PHEMEX_API_KEY: string; PHEMEX_API_SECRET: string }>;
  if (!all[name]) {
    console.error(`✗  Credential profile "${name}" not found in .credentials.json (available: ${Object.keys(all).join(", ")})`);
    process.exit(1);
  }
  return all[name];
}

let creds: { PHEMEX_API_KEY: string; PHEMEX_API_SECRET: string } | null = null;
let secretRaw: Buffer | null = null;

if (enableTrade) {
  creds = credential ? loadCredentialProfile(credential) : loadCredentials();
  secretRaw = Buffer.from(creds.PHEMEX_API_SECRET, "base64");
}

const TRADE_SIZE = 0.001;

async function executeTrade(index: number, last: number): Promise<void> {
  if (!creds || !secretRaw) return;

  const positions = await fetchPositions(creds.PHEMEX_API_KEY, secretRaw);
  const pos = positions.find(p => p.symbol === SYMBOL);

  if (index < last) {
    if (pos?.side === "Long") {
      await closePosition(pos, creds.PHEMEX_API_KEY, secretRaw);
    }
    if (!pos || pos.side !== "Short") {
      await placeMarketOrder(
        { account: "usdt-m", symbol: SYMBOL, side: "Sell", qty: TRADE_SIZE, posSide: "Short", price: 0 },
        creds.PHEMEX_API_KEY, secretRaw
      );
      console.log(`\n[${new Date().toLocaleString()}]  Sold short ${TRADE_SIZE} ${SYMBOL}`);
    }
  } else if (index > last) {
    if (pos?.side === "Short") {
      await closePosition(pos, creds.PHEMEX_API_KEY, secretRaw);
    }
    if (!pos || pos.side !== "Long") {
      await placeMarketOrder(
        { account: "usdt-m", symbol: SYMBOL, side: "Buy", qty: TRADE_SIZE, posSide: "Long", price: 0 },
        creds.PHEMEX_API_KEY, secretRaw
      );
      console.log(`\n[${new Date().toLocaleString()}]  Bought long ${TRADE_SIZE} ${SYMBOL}`);
    }
  }
}

let lastSig = "";
let cachedFields: string[] | null = null;

const ws = new ReconnectingWs(WS_URL, {
  onOpen: () => {
    ws.send({ method: "perp_market24h_pack_p.subscribe", params: [], id: 1 });
    ws.send({ method: "market24h_p.subscribe", params: [SYMBOL], id: 2 });
    console.log(`Subscribed to ${SYMBOL} ticker`);
  },
  onMessage: (msg) => {
    const m = msg as Record<string, unknown>;

    let ticker: Record<string, unknown> | null = null;

    // market24h_p.update — single-symbol push
    if (m.method === "market24h_p.update") {
      const d = (m.market24h_p ?? m.data) as Record<string, unknown> | undefined;
      if (d?.symbol === SYMBOL) ticker = d;
    }

    // perp_market24h_pack_p.update — batch (columnar or rows-only)
    if (m.method === "perp_market24h_pack_p.update") {
      if (Array.isArray(m.fields)) cachedFields = m.fields as string[];
      if (cachedFields && Array.isArray(m.data)) {
        ticker = findSymbolRow(m.data as unknown[][], cachedFields, SYMBOL);
      }
    }

    if (!ticker) return;

    const sig = `ask=${ticker.askRp} bid=${ticker.bidRp} index=${ticker.indexRp} mark=${ticker.markRp} last=${ticker.lastRp}`;
    if (sig === lastSig) return;
    lastSig = sig;

    const last = Number(ticker.lastRp ?? 0);
    const open = Number(ticker.openRp ?? 0);
    const high = Number(ticker.highRp ?? 0);
    const low = Number(ticker.lowRp ?? 0);
    const volume = Number(ticker.volumeRq ?? 0);
    const changePct = open > 0 ? ((last - open) / open) * 100 : 0;
    const sign = changePct >= 0 ? "+" : "";

    const now = new Date().toLocaleString();
    const ask = Number(ticker.askRp ?? 0);
    const bid = Number(ticker.bidRp ?? 0);
    const index = Number(ticker.indexRp ?? 0);
    const mark = Number(ticker.markRp ?? 0);
    const arrow = index < last ? "↓" : index > last ? "↑" : " ";

    process.stdout.write(
      `\r\x1b[K${now}  ${SYMBOL} ${arrow}  Last: $${last.toFixed(2)}  Ask: $${ask.toFixed(2)}  Bid: $${bid.toFixed(2)}  Index: $${index.toFixed(2)}  Mark: $${mark.toFixed(2)}  H: $${high.toFixed(2)}  L: $${low.toFixed(2)}  Chg: ${sign}${changePct.toFixed(2)}%  Vol: ${volume.toFixed(0)}`
    );

    if (enableTrade && index !== last) {
      executeTrade(index, last).catch(err => {
        console.error(`\n[${new Date().toLocaleString()}]  Trade error:`, err.message);
      });
    }
  },
  onReconnect: (delayMs) => {
    process.stdout.write("\n");
    console.log(`Reconnecting in ${delayMs / 1000}s...`);
    lastSig = "";
    cachedFields = null;
  },
});

console.log(`Connecting to ${WS_URL}...`);
ws.connect();
