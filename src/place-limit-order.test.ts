#!/usr/bin/env npx tsx
/**
 * Tests for the place-limit-order library.
 *
 * Run with: npx tsx src/place-limit-order.test.ts
 *
 * These tests cover:
 *   - Pure functions: base64UrlDecode, sign, uuid
 *   - HTTP-dependent placement functions via a mock request injector
 *   - Error handling (API errors, missing data)
 */

import crypto from "node:crypto";
import assert from "node:assert/strict";
import {
  base64UrlDecode,
  sign,
  uuid,
  placeSpot,
  placeLinear,
  placeInverse,
  placeLimitOrder,
  cancelOrder,
  type HttpRequest,
  type PlaceOrderResult,
  type PlaceLimitOrderParams,
} from "./place-limit-order.js";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const FAKE_API_KEY = "test-api-key";
const FAKE_SECRET_RAW = Buffer.from("test-secret-raw");

/**
 * Create a mock HTTP request function that returns a given response.
 * Records the last call's arguments for inspection.
 */
function mockRequest(
  response: Record<string, unknown>,
): { lastCall: { method: string; path: string; query: string | null; body: string }; fn: HttpRequest } {
  const captured: { method: string; path: string; query: string | null; body: string } = {
    method: "",
    path: "",
    query: null,
    body: "",
  };
  const fn: HttpRequest = (method, path, query, _apiKey, _secretRaw, body) => {
    captured.method = method;
    captured.path = path;
    captured.query = query;
    captured.body = body;
    return Promise.resolve(response);
  };
  return { lastCall: captured, fn };
}

/**
 * Create a mock HTTP request function that rejects with an error.
 */
function mockRequestError(errorMsg: string): HttpRequest {
  return () => Promise.reject(new Error(errorMsg));
}

/* ================================================================== */
/*  Test 1: base64UrlDecode                                            */
/* ================================================================== */
{
  // Standard base64url with - and _ replacements
  const input = "dGVzdC1zZWNyZXQtcmF3";  // "test-secret-raw" in base64 (no padding)
  const result = base64UrlDecode(input);
  assert.ok(result instanceof Buffer, "Should return a Buffer");
  assert.equal(result.toString("utf8"), "test-secret-raw", "Should decode correctly");

  // With url-safe chars: - → +, _ → /
  const urlSafe = "dGVzdC1zZWNyZXQtcmF3"; // same but with - instead of + (it doesn't have + or /)
  const result2 = base64UrlDecode(urlSafe);
  assert.equal(result2.toString("utf8"), "test-secret-raw");

  console.log("✓  Test 1 — base64UrlDecode: PASSED");
}

/* ================================================================== */
/*  Test 2: sign (HMAC-SHA256)                                         */
/* ================================================================== */
{
  // Known test: path + query + expiry + body, HMAC-SHA256 with a known secret
  const secret = Buffer.from("mysecret");
  const path = "/orders/create";
  const query = "symbol=BTCUSD&side=Buy";
  const expiry = 1700000000;
  const body = "";

  const sig = sign("PUT", path, query, expiry, secret, body);

  // Manually compute the expected signature using Node's crypto
  const expectedPayload = path + query + expiry + body;
  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(expectedPayload)
    .digest("hex");

  assert.equal(sig, expectedSig, "Signature should match manually computed HMAC-SHA256");
  assert.equal(typeof sig, "string", "Signature should be a string");
  assert.equal(sig.length, 64, "SHA-256 hex should be 64 characters");

  // Test with no query string
  const sigNoQuery = sign("POST", "/spot/orders", null, expiry, secret, '{"key":"value"}');
  const expectedPayloadNoQuery = "/spot/orders" + "" + expiry + '{"key":"value"}';
  const expectedSigNoQuery = crypto
    .createHmac("sha256", secret)
    .update(expectedPayloadNoQuery)
    .digest("hex");
  assert.equal(sigNoQuery, expectedSigNoQuery, "Signature with null query should treat query as empty string");

  console.log("✓  Test 2 — sign: PASSED");
}

/* ================================================================== */
/*  Test 3: uuid                                                       */
/* ================================================================== */
{
  const id = uuid();
  assert.equal(typeof id, "string", "UUID should be a string");
  // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  assert.match(id, uuidRegex, `UUID ${id} should match v4 format`);

  // Verify uniqueness (two calls should produce different values)
  const id2 = uuid();
  assert.notEqual(id, id2, "Two UUIDs should not be equal");

  console.log("✓  Test 3 — uuid: PASSED");
}

/* ================================================================== */
/*  Test 4: placeSpot — request formatting                             */
/* ================================================================== */
{
  const mockResponse = { code: 0, data: { orderID: "spot-123", ordStatus: "New" } };
  const mock = mockRequest(mockResponse);

  const result = await placeSpot(
    { account: "spot", symbol: "BTCUSDT", side: "Buy", price: 60000, qty: 0.001 },
    FAKE_API_KEY,
    FAKE_SECRET_RAW,
    mock.fn,
  );

  // Verify the HTTP request was made correctly
  assert.equal(mock.lastCall.method, "POST", "Spot should use POST");
  assert.equal(mock.lastCall.path, "/spot/orders", "Spot should use /spot/orders");
  assert.equal(mock.lastCall.query, null, "Spot should have no query string");

  // Verify the body
  const body = JSON.parse(mock.lastCall.body);
  assert.equal(body.symbol, "sBTCUSDT", "Spot symbol should have 's' prefix");
  assert.equal(body.side, "Buy");
  assert.equal(body.ordType, "Limit");
  assert.equal(body.timeInForce, "GoodTillCancel", "Default TIF should be GoodTillCancel");
  assert.equal(body.priceEp, 60000 * 1e8, "Spot price should be scaled by 1e8");
  assert.equal(body.baseQtyEv, 0.001 * 1e8, "Spot qty should be scaled by 1e8");
  assert.equal(body.qtyType, "ByBase");
  assert.ok(body.clOrdID, "Should have a clOrdID");

  // Verify the result
  assert.equal(result.orderID, "spot-123");
  assert.equal(result.ordStatus, "New");

  console.log("✓  Test 4 — placeSpot: PASSED");
}

/* ================================================================== */
/*  Test 5: placeSpot — error handling                                 */
/* ================================================================== */
{
  const mockResponse = { code: 2001, msg: "Invalid symbol" };
  const mock = mockRequest(mockResponse);

  try {
    await placeSpot(
      { account: "spot", symbol: "INVALID", side: "Buy", price: 1, qty: 1 },
      FAKE_API_KEY,
      FAKE_SECRET_RAW,
      mock.fn,
    );
    assert.fail("Should have thrown");
  } catch (err: unknown) {
    assert.ok(err instanceof Error);
    assert.match(err.message, /Invalid symbol/);
  }

  console.log("✓  Test 5 — placeSpot error: PASSED");
}

/* ================================================================== */
/*  Test 6: cancelOrder — request formatting                          */
/* ================================================================== */
{
  const mockResponse = { code: 0, data: { orderID: "cancel-789", ordStatus: "Canceled" } };
  const mock = mockRequest(mockResponse);

  const result = await cancelOrder(
    { symbol: "XTIUSDT", orderId: "cancel-789", posSide: "Short" },
    FAKE_API_KEY,
    FAKE_SECRET_RAW,
    mock.fn,
  );

  assert.equal(mock.lastCall.method, "DELETE", "Cancel should use DELETE");
  assert.equal(mock.lastCall.path, "/g-orders", "USDT-M cancel should use /g-orders");
  assert.equal(mock.lastCall.query, "orderID=cancel-789&symbol=XTIUSDT&posSide=Short");
  assert.equal(result.code, 0);

  console.log("✓  Test 6 — cancelOrder: PASSED");
}

/* ================================================================== */
/*  Test 7: placeLinear (USDT-M) — request formatting                  */
/* ================================================================== */
{
  const mockResponse = { code: 0, data: { orderID: "linear-456", ordStatus: "New" } };
  const mock = mockRequest(mockResponse);

  const result = await placeLinear(
    {
      account: "usdt-m",
      symbol: "XTIUSDT",
      side: "Sell",
      price: 75.0,
      qty: 0.01,
      posSide: "Short",
      timeInForce: "PostOnly",
    },
    FAKE_API_KEY,
    FAKE_SECRET_RAW,
    mock.fn,
  );

  assert.equal(mock.lastCall.method, "PUT", "Linear should use PUT");
  assert.equal(mock.lastCall.path, "/g-orders/create", "Linear should use /g-orders/create");
  assert.equal(mock.lastCall.body, "", "Linear should have empty body");

  // Verify query params
  const qs = mock.lastCall.query!;
  assert.ok(qs.includes("symbol=XTIUSDT"));
  assert.ok(qs.includes("side=Sell"));
  assert.ok(qs.includes("posSide=Short"));
  assert.ok(qs.includes("ordType=Limit"));
  assert.ok(qs.includes("timeInForce=PostOnly"));
  assert.ok(qs.includes("priceRp=75"));
  assert.ok(qs.includes("orderQtyRq=0.01"));
  assert.ok(qs.includes("clOrdID="));

  assert.equal(result.orderID, "linear-456");

  console.log("✓  Test 6 — placeLinear: PASSED");
}

/* ================================================================== */
/*  Test 7: placeLinear with TP/SL                                     */
/* ================================================================== */
{
  const mockResponse = { code: 0, data: { orderID: "linear-tpsl" } };
  const mock = mockRequest(mockResponse);

  await placeLinear(
    {
      account: "usdt-m",
      symbol: "BTCUSDT",
      side: "Buy",
      price: 50000,
      qty: 1,
      posSide: "Long",
      takeProfit: 55000,
      stopLoss: 48000,
    },
    FAKE_API_KEY,
    FAKE_SECRET_RAW,
    mock.fn,
  );

  const qs = mock.lastCall.query!;
  assert.ok(qs.includes("takeProfitRp=55000"), "Should include takeProfitRp");
  assert.ok(qs.includes("stopLossRp=48000"), "Should include stopLossRp");

  console.log("✓  Test 7 — placeLinear with TP/SL: PASSED");
}

/* ================================================================== */
/*  Test 8: placeLinear — default posSide and timeInForce              */
/* ================================================================== */
{
  const mockResponse = { code: 0, data: { orderID: "linear-defaults" } };
  const mock = mockRequest(mockResponse);

  await placeLinear(
    {
      account: "usdt-m",
      symbol: "ETHUSDT",
      side: "Buy",
      price: 3000,
      qty: 0.1,
      // no posSide, no timeInForce — should use defaults
    },
    FAKE_API_KEY,
    FAKE_SECRET_RAW,
    mock.fn,
  );

  const qs = mock.lastCall.query!;
  assert.ok(qs.includes("posSide=Merged"), "Default posSide should be Merged");
  assert.ok(qs.includes("timeInForce=GoodTillCancel"), "Default TIF should be GoodTillCancel");

  console.log("✓  Test 8 — placeLinear defaults: PASSED");
}

/* ================================================================== */
/*  Test 9: placeInverse (Coin-M) — request formatting                 */
/* ================================================================== */
{
  // Mock the product info fetch first, then the order placement
  let fetchCalled = false;
  const mockFn: HttpRequest = (method, path, query, _key, _secret, body) => {
    if (path === "/public/products" && !fetchCalled) {
      fetchCalled = true;
      return Promise.resolve({
        code: 0,
        data: {
          products: [
            { symbol: "BTCUSD", priceScale: 4, valueScale: 8, ratioScale: 8, settleCurrency: "BTC", contractSize: 1 },
          ],
        },
      });
    }
    return Promise.resolve({ code: 0, data: { orderID: "inverse-789", ordStatus: "New" } });
  };

  const result = await placeInverse(
    {
      account: "coin-m",
      symbol: "BTCUSD",
      side: "Buy",
      price: 60000,
      qty: 1,
    },
    FAKE_API_KEY,
    FAKE_SECRET_RAW,
    mockFn,
  );

  // placeInverse internally calls fetchProductInfo which calls the mock,
  // then calls the mock again for the order placement. We can't capture
  // the last call cleanly with the multi-call mock, but we can verify the result.
  assert.equal(result.orderID, "inverse-789");

  console.log("✓  Test 9 — placeInverse: PASSED");
}

/* ================================================================== */
/*  Test 10: placeInverse — product info fallback (BTCUSD)             */
/* ================================================================== */
{
  // Mock returns null for products (no matching symbol), but BTCUSD has a fallback
  const captured: { method: string; path: string; query: string | null }[] = [];
  const mockFn: HttpRequest = (method, path, query, _key, _secret, body) => {
    if (path === "/public/products") {
      // Return empty products — should trigger fallback
      return Promise.resolve({ code: 0, data: { products: [] } });
    }
    captured.push({ method, path, query });
    return Promise.resolve({ code: 0, data: { orderID: "inverse-fallback", ordStatus: "New" } });
  };

  const result = await placeInverse(
    { account: "coin-m", symbol: "BTCUSD", side: "Sell", price: 65000, qty: 2 },
    FAKE_API_KEY,
    FAKE_SECRET_RAW,
    mockFn,
  );

  assert.equal(result.orderID, "inverse-fallback");

  // Verify the order query params
  assert.equal(captured.length, 1, "Should have captured one order call");
  const orderCall = captured[0];
  const qs = orderCall.query!;
  assert.ok(qs.includes("symbol=BTCUSD"));
  assert.ok(qs.includes("side=Sell"));
  assert.ok(qs.includes("ordType=Limit"));
  // BTCUSD fallback priceScale = 10000, so priceEp = 65000 * 10000 = 650000000
  assert.ok(qs.includes("priceEp=650000000"));
  assert.ok(qs.includes("orderQty=2"));

  console.log("✓  Test 10 — placeInverse fallback: PASSED");
}

/* ================================================================== */
/*  Test 11: placeInverse — product info fetch error                   */
/* ================================================================== */
{
  const mockFn: HttpRequest = (method, path, _query, _key, _secret, _body) => {
    if (path === "/public/products") {
      return Promise.resolve({ code: 0, data: { products: [] } });
    }
    // Unknown symbol — no fallback, should throw
    return Promise.resolve({ code: 0, data: { orderID: "never" } });
  };

  try {
    await placeInverse(
      { account: "coin-m", symbol: "UNKNOWN", side: "Buy", price: 100, qty: 1 },
      FAKE_API_KEY,
      FAKE_SECRET_RAW,
      mockFn,
    );
    assert.fail("Should have thrown for unknown Coin-M symbol");
  } catch (err: unknown) {
    assert.ok(err instanceof Error);
    assert.match(err.message, /Could not fetch product info/);
  }

  console.log("✓  Test 11 — placeInverse error: PASSED");
}

/* ================================================================== */
/*  Test 12: placeLimitOrder — dispatcher routes to correct function   */
/* ================================================================== */
{
  // Spot
  const spotMock = mockRequest({ code: 0, data: { orderID: "dispatcher-spot" } });
  const spotResult = await placeLimitOrder(
    { account: "spot", symbol: "ETHUSDT", side: "Buy", price: 3000, qty: 0.1 },
    FAKE_API_KEY,
    FAKE_SECRET_RAW,
    spotMock.fn,
  );
  assert.equal(spotResult.orderID, "dispatcher-spot");
  assert.equal(spotMock.lastCall.path, "/spot/orders");

  // USDT-M
  const linearMock = mockRequest({ code: 0, data: { orderID: "dispatcher-linear" } });
  const linearResult = await placeLimitOrder(
    { account: "usdt-m", symbol: "BTCUSDT", side: "Sell", price: 50000, qty: 1 },
    FAKE_API_KEY,
    FAKE_SECRET_RAW,
    linearMock.fn,
  );
  assert.equal(linearResult.orderID, "dispatcher-linear");
  assert.equal(linearMock.lastCall.path, "/g-orders/create");

  console.log("✓  Test 12 — placeLimitOrder dispatcher: PASSED");
}

/* ================================================================== */
/*  Test 13: placeLimitOrder — unknown account type                    */
/* ================================================================== */
{
  try {
    await placeLimitOrder(
      { account: "invalid" as "spot", symbol: "X", side: "Buy", price: 1, qty: 1 },
      FAKE_API_KEY,
      FAKE_SECRET_RAW,
    );
    assert.fail("Should have thrown for unknown account type");
  } catch (err: unknown) {
    assert.ok(err instanceof Error);
    assert.match(err.message, /Unknown account type/);
  }

  console.log("✓  Test 13 — placeLimitOrder unknown account: PASSED");
}

/* ================================================================== */
/*  Test 14: HTTP transport error propagation                          */
/* ================================================================== */
{
  const mock = mockRequestError("socket hang up");

  try {
    await placeSpot(
      { account: "spot", symbol: "BTCUSDT", side: "Buy", price: 1, qty: 1 },
      FAKE_API_KEY,
      FAKE_SECRET_RAW,
      mock,
    );
    assert.fail("Should have thrown on transport error");
  } catch (err: unknown) {
    assert.ok(err instanceof Error);
    assert.match(err.message, /socket hang up/);
  }

  console.log("✓  Test 14 — HTTP transport error: PASSED");
}

/* ================================================================== */
/*  Test 15: Empty response data                                       */
/* ================================================================== */
{
  const mock = mockRequest({ code: 0, data: undefined });

  try {
    await placeSpot(
      { account: "spot", symbol: "BTCUSDT", side: "Buy", price: 1, qty: 1 },
      FAKE_API_KEY,
      FAKE_SECRET_RAW,
      mock.fn,
    );
    assert.fail("Should have thrown on empty data");
  } catch (err: unknown) {
    assert.ok(err instanceof Error);
    assert.match(err.message, /Empty response data/);
  }

  console.log("✓  Test 15 — Empty response data: PASSED");
}

/* ================================================================== */
/*  Summary                                                             */
/* ================================================================== */
console.log("\n🎉  All place-limit-order tests passed!");