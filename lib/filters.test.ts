import { test } from "node:test";
import assert from "node:assert/strict";

const { compareNetRangeApr, effectiveFeeTier } = (await import(
  "./filterUtils" + ".ts"
)) as typeof import("./filterUtils");

test("net range APR missing values stay last in both sort directions", () => {
  assert.ok(compareNetRangeApr(0.1, 0.2, "asc") < 0);
  assert.ok(compareNetRangeApr(0.2, 0.1, "desc") < 0);
  assert.equal(compareNetRangeApr(null, 0.1, "asc"), 1);
  assert.equal(compareNetRangeApr(null, 0.1, "desc"), 1);
});

test("live fee tier overrides the nominal tier", () => {
  assert.equal(effectiveFeeTier(0.01, 0.0005), 0.0005);
  assert.equal(effectiveFeeTier(0.0005, null), 0.0005);
});
