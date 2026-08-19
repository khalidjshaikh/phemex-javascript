#!/usr/bin/env -S npx tsx

import { ReconnectingWs } from "../src/ws-client.js";
import { findSymbolRow } from "../src/cli-utils.js";

const WS_URL = "wss://ws.phemex.com";
const SYMBOL = process.argv[2] || "BTCUSDT";

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
    process.stdout.write(
      `\r\x1b[K${now}  ${SYMBOL}  $${last.toFixed(2)}  H: $${high.toFixed(2)}  L: $${low.toFixed(2)}  Chg: ${sign}${changePct.toFixed(2)}%  Vol: ${volume.toFixed(0)}`
    );
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
