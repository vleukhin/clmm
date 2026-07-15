/**
 * Tests for lib/onchainFees.ts — run with: node --test lib/onchainFees.test.ts
 * Covers the hand-rolled Multicall3 aggregate3 ABI codec; the fetch path is
 * exercised against a live RPC manually (values verified on Base 2026-07-15).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// Same computed-specifier trick as rangeMath.test.ts (see comment there).
const { encodeAggregate3, decodeAggregate3 } = (await import(
  "./onchainFees" + ".ts"
)) as typeof import("./onchainFees");

const word = (hex: string) => hex.padStart(64, "0");

test("encodeAggregate3: one no-arg getter call", () => {
  const target = "0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa";
  const data = encodeAggregate3([target], ["0xddca3f43"]);
  const expected =
    "0x82ad56cb" +
    word("20") + // offset to Call3[]
    word("1") + // length
    word("20") + // element 0 offset (after the 1 offset word)
    word("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") + // target, lowercased
    word("1") + // allowFailure
    word("60") + // bytes offset within element
    word("4") + // callData length
    "ddca3f43" + "0".repeat(56); // selector right-padded
  assert.equal(data, expected);
});

test("encodeAggregate3: element offsets advance by 5 words", () => {
  const t = "0x" + "11".repeat(20);
  const data = encodeAggregate3([t, t], ["0xddca3f43", "0xb64cc67b"]);
  const body = data.slice(10); // strip 0x + selector
  const words = body.match(/.{64}/g)!;
  assert.equal(parseInt(words[1], 16), 2); // length
  assert.equal(parseInt(words[2], 16), 2 * 32); // elem 0
  assert.equal(parseInt(words[3], 16), 2 * 32 + 5 * 32); // elem 1
});

test("encodeAggregate3: length mismatch throws", () => {
  assert.throws(() => encodeAggregate3(["0x" + "11".repeat(20)], []), RangeError);
});

test("decodeAggregate3: success word and failed call", () => {
  // (bool success, bytes returnData)[] = [(true, uint256(282)), (false, "")]
  const blob =
    "0x" +
    word("20") + // offset to Result[]
    word("2") + // length
    word("40") + // elem 0 offset (after the 2 offset words)
    word("c0") + // elem 1 offset: 0x40 + 4 words
    word("1") + // elem 0: success
    word("40") + // bytes offset within element
    word("20") + // bytes length 32
    word("11a") + // 282
    word("0") + // elem 1: failure
    word("40") +
    word("0"); // empty returnData
  assert.deepEqual(decodeAggregate3(blob), [282, null]);
});

test("decodeAggregate3: round-trips fee-sized values", () => {
  for (const v of [1, 500, 100000, 999999]) {
    const blob =
      "0x" + word("20") + word("1") + word("20") +
      word("1") + word("40") + word("20") + word(v.toString(16));
    assert.deepEqual(decodeAggregate3(blob), [v]);
  }
});

test("decodeAggregate3: truncated payload throws", () => {
  const blob = "0x" + word("20") + word("1") + word("20") + word("1");
  assert.throws(() => decodeAggregate3(blob), RangeError);
});
