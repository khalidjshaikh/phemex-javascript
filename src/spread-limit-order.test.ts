#!/usr/bin/env npx tsx
/**
 * Tests for spread-limit-order pure spread helpers.
 *
 * Run with: npx tsx src/spread-limit-order.test.ts
 */

import assert from "node:assert/strict";
import { buildSpreadPrices, parseSpread } from "./spread-limit-order.js";

{
  const parsed = parseSpread("-16");
  assert.deepEqual(parsed, { value: -16, explicitSign: true });
  assert.deepEqual(buildSpreadPrices(70, parsed.value, parsed.explicitSign, 1), [
    69.84, 69.85, 69.86, 69.87, 69.88, 69.89, 69.9, 69.91, 69.92, 69.93,
    69.94, 69.95, 69.96, 69.97, 69.98, 69.99, 70,
  ]);

  console.log("✓  Test 1 — integer one-sided spread: PASSED");
}

{
  const parsed = parseSpread("-0.16");
  assert.deepEqual(parsed, { value: -0.16, explicitSign: true });
  assert.deepEqual(buildSpreadPrices(70, parsed.value, parsed.explicitSign, 1), [
    69.84, 69.85, 69.86, 69.87, 69.88, 69.89, 69.9, 69.91, 69.92, 69.93,
    69.94, 69.95, 69.96, 69.97, 69.98, 69.99, 70,
  ]);

  console.log("✓  Test 2 — decimal one-sided spread: PASSED");
}

{
  const parsed = parseSpread("0.04");
  assert.deepEqual(parsed, { value: 0.04, explicitSign: false });
  assert.deepEqual(buildSpreadPrices(70, parsed.value, parsed.explicitSign, 2), [
    69.96, 69.98, 70, 70.02, 70.04,
  ]);

  console.log("✓  Test 3 — decimal symmetric spread with dispersion: PASSED");
}

{
  const parsed = parseSpread("-0.03");
  assert.throws(
    () => buildSpreadPrices(70, parsed.value, parsed.explicitSign, 2),
    /Decimal --spread value -0.03 must align with tick size 0.02/,
  );

  console.log("✓  Test 4 — decimal spread alignment validation: PASSED");
}

console.log("\nAll spread-limit-order tests passed!");
