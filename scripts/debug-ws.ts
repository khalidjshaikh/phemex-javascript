#!/usr/bin/env -S npx tsx

import { ReconnectingWs } from "../src/ws-client.js";

let count = 0;
const ws = new ReconnectingWs("wss://ws.phemex.com", {
  onOpen: () => {
    ws.send({ method: "perp_market24h_pack_p.subscribe", params: [], id: 1 });
    ws.send({ method: "market24h_p.subscribe", params: ["ETHUSDT"], id: 2 });
    console.log("Subscribed");
  },
  onMessage: (msg) => {
    count++;
    const m = msg as any;
    if (m.method) {
      console.log(`[${count}] method=${m.method} fields=${Array.isArray(m.fields) ? m.fields.length : "none"} rows=${Array.isArray(m.data) ? m.data.length : "none"}`);
    } else {
      console.log(`[${count}] keys=${Object.keys(m).join(",")}`);
    }
  },
});
ws.connect();
