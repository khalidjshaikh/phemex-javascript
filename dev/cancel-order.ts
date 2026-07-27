#!/usr/bin/env npx tsx
// SPDX-License-Identifier: MIT
/**
 * Cancel a single USDT-M order via DELETE /g-orders/cancel
 */
import https from "node:https";
import crypto from "node:crypto";
import { base64UrlDecode } from "../src/http-client.js";
import { loadCredentialsLocal } from "../src/credentials.js";

const HOST = "api.phemex.com";
const creds = loadCredentialsLocal();
const secretRaw = base64UrlDecode(creds.PHEMEX_API_SECRET);

const ORDER_ID = "5c251c17-9989-4d0d-af1e-8c2c238faeb5";
const SYMBOL = "XTIUSDT";
const POS_SIDE = "Long";

const PATH = "/g-orders/cancel";
const query = `orderID=${ORDER_ID}&posSide=${POS_SIDE}&symbol=${SYMBOL}`;

const expiry = Math.floor(Date.now() / 1000) + 60;
const payload = PATH + query + expiry + "";
const sig = crypto.createHmac("sha256", secretRaw).update(payload).digest("hex");

console.log(`⟐  DELETE ${HOST}${PATH}?${query}`);

const req = https.request(
  {
    hostname: HOST,
    path: PATH + "?" + query,
    method: "DELETE",
    headers: {
      "x-phemex-access-token": creds.PHEMEX_API_KEY,
      "x-phemex-request-expiry": String(expiry),
      "x-phemex-request-signature": sig,
      "Content-Type": "application/json",
    },
  },
  (res) => {
    let data = "";
    res.on("data", (c) => (data += c));
    res.on("end", () => {
      console.log(`HTTP ${res.statusCode}`);
      console.log(JSON.stringify(JSON.parse(data), null, 2));
    });
  },
);
req.on("error", (e) => console.error("Error:", e.message));
req.end();
