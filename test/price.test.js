import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeCoupangPrice, computePrice } from "../src/utils/price.js";

test("sanitizeCoupangPrice clamps to min and returns integer", () => {
  assert.equal(sanitizeCoupangPrice("abc", { min: 1000 }), 1000);
  assert.equal(sanitizeCoupangPrice(NaN, { min: 1000 }), 1000);
  assert.equal(sanitizeCoupangPrice(9, { min: 1000 }), 1000);
  assert.equal(sanitizeCoupangPrice(1050.9, { min: 1000 }), 1050);
});

test("computePrice returns min fallback for non-numeric base", () => {
  assert.equal(computePrice("not-a-number", { min: 1234 }), 1234);
});
