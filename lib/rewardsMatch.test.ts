/**
 * Tests for lib/rewardsMatch.ts — run with: node --test lib/rewardsMatch.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// Same computed-specifier trick as rangeMath.test.ts (see comment there).
const { parseLlamaPoolMeta, pairKey, matchLlamaPool, mergeRewardComponents, shortAddress } =
  (await import("./rewardsMatch" + ".ts")) as typeof import("./rewardsMatch");

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const AERO = "0x940181a94a35a4569e4529a3cdfb74e38fd98631";

function row(
  poolMeta: string | null,
  tvlUsd: number,
  apyReward: number | null = 10,
  tokens = [WETH, USDC],
) {
  return {
    chain: "Base",
    project: "aerodrome-slipstream",
    symbol: "WETH-USDC",
    underlyingTokens: tokens,
    poolMeta,
    tvlUsd,
    apyReward,
    rewardTokens: apyReward ? [AERO] : [],
  };
}

test("parseLlamaPoolMeta: Slipstream and Uniswap shapes", () => {
  assert.deepEqual(parseLlamaPoolMeta("CL100 - 0.0579%"), { tickSpacing: 100, fee: 0.000579 });
  assert.deepEqual(parseLlamaPoolMeta("CL1 - 0.008%"), { tickSpacing: 1, fee: 0.00008 });
  assert.deepEqual(parseLlamaPoolMeta("0.05%"), { tickSpacing: null, fee: 0.0005 });
  assert.deepEqual(parseLlamaPoolMeta(null), { tickSpacing: null, fee: null });
  assert.deepEqual(parseLlamaPoolMeta("7 days unstaking"), { tickSpacing: null, fee: null });
});

test("pairKey: order- and case-insensitive", () => {
  assert.equal(pairKey(WETH, USDC), pairKey(USDC.toUpperCase(), WETH));
});

test("matchLlamaPool: picks the CL pool by tick spacing", () => {
  const cands = [row("CL100 - 0.0579%", 9.4e6), row("CL50 - 0.05%", 9.0e6), row("CL1 - 0.008%", 1.4e5)];
  const pool = { volatileAddress: WETH, stableAddress: USDC, feeTier: 0.0005, tickSpacing: 50, tvlUsd: 8e6 };
  assert.equal(matchLlamaPool(pool, cands)?.poolMeta, "CL50 - 0.05%");
});

test("matchLlamaPool: falls back to fee tier without tick spacing", () => {
  const cands = [row("0.3%", 1e6), row("0.05%", 2e6)];
  const pool = { volatileAddress: WETH, stableAddress: USDC, feeTier: 0.0005, tvlUsd: 2e6 };
  assert.equal(matchLlamaPool(pool, cands)?.poolMeta, "0.05%");
});

test("matchLlamaPool: ignores other pairs and unmatched tiers", () => {
  const other = row("CL100 - 0.05%", 1e6, 10, [WETH, AERO]);
  const pool = { volatileAddress: WETH, stableAddress: USDC, feeTier: 0.0005, tickSpacing: 100, tvlUsd: 1e6 };
  assert.equal(matchLlamaPool(pool, [other]), null);
  assert.equal(matchLlamaPool(pool, [row("CL200 - 0.05%", 1e6)]), null);
});

test("matchLlamaPool: duplicate rows resolve by TVL proximity, within bounds", () => {
  const dupes = [row("CL1 - 0.008%", 142_699, null), row("CL1 - 0.008%", 124_142, 5655)];
  const pool = { volatileAddress: WETH, stableAddress: USDC, feeTier: 0.0005, tickSpacing: 1, tvlUsd: 125_000 };
  assert.equal(matchLlamaPool(pool, dupes)?.apyReward, 5655);
  const far = { ...pool, tvlUsd: 5_000_000 };
  assert.equal(matchLlamaPool(far, dupes), null);
});

test("mergeRewardComponents: sums sources, unions tokens, drops zeros", () => {
  const merged = mergeRewardComponents([
    { source: "defillama", apr: 0.2, tokens: ["AERO"] },
    { source: "merkl", apr: 0.05, tokens: ["AERO", "UNI"] },
    { source: "merkl", apr: 0, tokens: ["X"] },
  ]);
  if (!merged) throw new Error("expected merged rewards");
  assert.ok(Math.abs(merged.rewardApr - 0.25) < 1e-12);
  assert.deepEqual(merged.tokens, ["AERO", "UNI"]);
  assert.equal(merged.components.length, 2);
  assert.equal(mergeRewardComponents([{ source: "merkl", apr: 0, tokens: [] }]), null);
  assert.equal(mergeRewardComponents([]), null);
});

test("shortAddress", () => {
  assert.equal(shortAddress(AERO), "0x9401…8631");
  assert.equal(shortAddress("AERO"), "AERO");
});
