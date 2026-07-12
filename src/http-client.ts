// SPDX-License-Identifier: MIT
/**
 * http-client.ts — Phemex API HTTP client shared library.
 *
 * Provides:
 *   base64UrlDecode    — RFC 4648 §5 base64-url decoding
 *   sign               — HMAC-SHA256 signature per Phemex spec
 *   request            — Signed HTTPS request (GET/PUT/POST/DELETE)
 *   httpGet            — Convenience GET wrapper
 *   httpDelete         — Convenience DELETE wrapper
 *   HttpRequest        — Type signature for the request function
 *
 * Usage:
 *   import { request, base64UrlDecode } from "./src/http-client.js";
 */

import https from "node:https";
import crypto from "node:crypto";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type HttpMethod = "GET" | "PUT" | "POST" | "DELETE";

export type HttpRequest = (
  method: HttpMethod,
  path: string,
  query: string | null,
  apiKey: string,
  secretRaw: Buffer,
  body: string,
) => Promise<Record<string, unknown>>;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Base64-url decode (RFC 4648 §5) */
export function base64UrlDecode(s: string): Buffer {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

/**
 * Sign a request per Phemex spec: HMAC-SHA256(path + queryString + expiry + body)
 * Note: the query string does NOT include the leading '?'.
 */
export function sign(
  _method: string,
  path: string,
  query: string | null,
  expiry: number,
  secretRaw: Buffer,
  body: string,
): string {
  const queryStr = query ?? "";
  const payload = path + queryStr + expiry + body;
  return crypto.createHmac("sha256", secretRaw).update(payload).digest("hex");
}

/**
 * Perform one signed HTTPS request and parse the JSON response.
 * Supports GET, PUT, POST, and DELETE methods.
 */
export function request(
  method: HttpMethod,
  urlPath: string,
  query: string | null,
  apiKey: string,
  secretRaw: Buffer,
  body: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const expiry = Math.floor(Date.now() / 1000) + 60;
    const sig = sign(method, urlPath, query, expiry, secretRaw, body);
    const qs = query ? "?" + query : "";

    const req = https.request(
      {
        hostname: "api.phemex.com",
        path: urlPath + qs,
        method,
        headers: {
          "x-phemex-access-token": apiKey,
          "x-phemex-request-expiry": String(expiry),
          "x-phemex-request-signature": sig,
          "Content-Type": "application/json",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`Bad JSON: ${data.slice(0, 200)}`));
          }
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Convenience: signed GET request */
export function httpGet(
  path: string,
  query: string | null,
  apiKey: string,
  secretRaw: Buffer,
): Promise<Record<string, unknown>> {
  return request("GET", path, query, apiKey, secretRaw, "");
}

/** Convenience: signed DELETE request */
export function httpDelete(
  path: string,
  query: string | null,
  apiKey: string,
  secretRaw: Buffer,
): Promise<Record<string, unknown>> {
  return request("DELETE", path, query, apiKey, secretRaw, "");
}