/**
 * Tests for lib/rangeMath.ts — run with: node --test lib/rangeMath.test.ts
 * (Node >= 23 strips TypeScript types natively; imports use explicit .ts
 * extensions and no path aliases for that reason.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// Node's type-stripping runtime requires the literal ".ts" extension in the
// specifier, but the project tsconfig doesn't enable allowImportingTsExtensions
// (TS5097) and is shared, so it can't be edited here. A computed specifier
// bypasses tsc's extension check while `typeof import(...)` (extensionless,
// fine under bundler resolution) recovers full static types.
const {
  MIN_TICK,
  MAX_TICK,
  tickToPrice,
  priceToTick,
  alignToSpacing,
  liquidityForAmounts,
  amountsForLiquidity,
  liquidityForDeposit,
  positionValue,
  ilVsHodl,
  concentrationFactor,
  timeInRange,
  estimateRangeAprSimple,
  estimateRangeAprFromLiquidity,
  rawLiquidityForDeposit,
  backtestRange,
} = (await import("./rangeMath" + ".ts")) as typeof import("./rangeMath");

/** assert |a - b| <= tol with a readable message. */
function assertClose(actual: number, expected: number, tol: number, msg?: string): void {
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${msg ?? "values differ"}: actual=${actual}, expected=${expected}, tol=${tol}`,
  );
}

/** assert relative closeness for values far from zero. */
function assertRelClose(actual: number, expected: number, relTol: number, msg?: string): void {
  assertClose(actual, expected, Math.abs(expected) * relTol, msg);
}

// ---------------------------------------------------------------------------
// 1) Tick / price conversions
// ---------------------------------------------------------------------------

test("tickToPrice: known anchors", () => {
  assert.equal(tickToPrice(0, 18, 18), 1);
  assertRelClose(tickToPrice(0, 18, 6), 1e12, 1e-12, "tick 0 with 18/6 decimals");
  assertRelClose(tickToPrice(1, 18, 18), 1.0001, 1e-12, "one tick = 1 bp of 1.0001");
});

test("tick <-> price roundtrips across ticks and decimal combos", () => {
  const ticks = [MIN_TICK + 52, -100000, -6932, -60, 0, 60, 6932, 100000, MAX_TICK - 52];
  const decimalPairs: Array<[number, number]> = [
    [18, 18],
    [6, 18], // USDC/WETH-style
    [18, 6], // WETH/USDT-style
    [8, 18], // WBTC/WETH-style
  ];
  for (const [d0, d1] of decimalPairs) {
    for (const t of ticks) {
      const p = tickToPrice(t, d0, d1);
      const back = priceToTick(p, d0, d1);
      assertClose(back, t, 1e-6, `roundtrip tick=${t} decimals=${d0}/${d1}`);
      assert.equal(Math.round(back), t, `rounded roundtrip tick=${t} decimals=${d0}/${d1}`);
    }
  }
});

test("priceToTick rejects non-positive prices", () => {
  assert.throws(() => priceToTick(0, 18, 18), RangeError);
  assert.throws(() => priceToTick(-5, 18, 18), RangeError);
});

test("alignToSpacing: down / up / nearest, negatives, clamping", () => {
  assert.equal(alignToSpacing(87, 60, "down"), 60);
  assert.equal(alignToSpacing(87, 60, "up"), 120);
  assert.equal(alignToSpacing(87, 60, "nearest"), 60);
  assert.equal(alignToSpacing(91, 60, "nearest"), 120);
  assert.equal(alignToSpacing(-87, 60, "down"), -120);
  assert.equal(alignToSpacing(-87, 60, "up"), -60);
  assert.equal(alignToSpacing(-87, 60, "nearest"), -60);
  assert.equal(alignToSpacing(120, 60, "down"), 120, "already aligned is a fixed point");
  // clamped to the usable grid: floor(887272 / 60) * 60 = 887220
  assert.equal(alignToSpacing(MAX_TICK + 100, 60, "up"), 887220);
  assert.equal(alignToSpacing(MIN_TICK - 100, 60, "down"), -887220);
  assert.throws(() => alignToSpacing(100, 0, "down"), RangeError);
  assert.throws(() => alignToSpacing(100, -10, "nearest"), RangeError);
});

// ---------------------------------------------------------------------------
// 2) Position math
// ---------------------------------------------------------------------------

const P = 3000;
const Pa = 2500;
const Pb = 3600;
const [s, sa, sb] = [Math.sqrt(P), Math.sqrt(Pa), Math.sqrt(Pb)];

test("liquidity <-> amounts roundtrip, price inside range", () => {
  const L = 12345.678;
  const { amount0, amount1 } = amountsForLiquidity(L, s, sa, sb);
  assert.ok(amount0 > 0 && amount1 > 0, "in-range holds both tokens");
  assertRelClose(liquidityForAmounts(amount0, amount1, s, sa, sb), L, 1e-12, "roundtrip L");
});

test("liquidity <-> amounts roundtrip, price below range (all token0)", () => {
  const L = 777.7;
  const sLow = Math.sqrt(2000);
  const { amount0, amount1 } = amountsForLiquidity(L, sLow, sa, sb);
  assert.equal(amount1, 0, "below range holds no token1");
  assert.ok(amount0 > 0);
  assertRelClose(liquidityForAmounts(amount0, 0, sLow, sa, sb), L, 1e-12);
});

test("liquidity <-> amounts roundtrip, price above range (all token1)", () => {
  const L = 55555;
  const sHigh = Math.sqrt(5000);
  const { amount0, amount1 } = amountsForLiquidity(L, sHigh, sa, sb);
  assert.equal(amount0, 0, "above range holds no token0");
  assert.ok(amount1 > 0);
  assertRelClose(liquidityForAmounts(0, amount1, sHigh, sa, sb), L, 1e-12);
});

test("liquidityForDeposit: deposit value is conserved (in range)", () => {
  const deposit = 10_000;
  const L = liquidityForDeposit(deposit, P, Pa, Pb);
  // The value-balanced amounts at P must be worth exactly the deposit.
  assertRelClose(positionValue(L, P, Pa, Pb), deposit, 1e-12, "value at entry = deposit");
});

test("liquidityForDeposit: continuous at range edges and handles full-range limits", () => {
  const deposit = 1000;
  const eps = 1e-7;
  const atEdgeA = liquidityForDeposit(deposit, Pa, Pa, Pb);
  const belowA = liquidityForDeposit(deposit, Pa * (1 - eps), Pa, Pb);
  const aboveA = liquidityForDeposit(deposit, Pa * (1 + eps), Pa, Pb);
  assertRelClose(belowA, atEdgeA, 1e-5, "continuity at Pa (below)");
  assertRelClose(aboveA, atEdgeA, 1e-5, "continuity at Pa (above)");
  const atEdgeB = liquidityForDeposit(deposit, Pb, Pa, Pb);
  assertRelClose(liquidityForDeposit(deposit, Pb * (1 - eps), Pa, Pb), atEdgeB, 1e-5, "continuity at Pb");
  assertRelClose(liquidityForDeposit(deposit, Pb * (1 + eps), Pa, Pb), atEdgeB, 1e-5, "continuity above Pb");
  // Full-range limit: L = D / (2 sqrt(P))
  assertRelClose(liquidityForDeposit(deposit, P, 0, Infinity), deposit / (2 * s), 1e-12, "full-range L = D/(2s)");
  assert.throws(() => liquidityForDeposit(deposit, P, Pb, Pa), RangeError, "Pa >= Pb rejected");
  assert.throws(() => liquidityForDeposit(0, P, Pa, Pb), RangeError, "zero deposit rejected");
});

// ---------------------------------------------------------------------------
// 3) positionValue
// ---------------------------------------------------------------------------

test("positionValue: continuous at range edges, non-decreasing in P, constant above Pb", () => {
  const L = 1000;
  const eps = 1e-7;
  for (const edge of [Pa, Pb]) {
    const v = positionValue(L, edge, Pa, Pb);
    assertRelClose(positionValue(L, edge * (1 - eps), Pa, Pb), v, 1e-5, `continuity below ${edge}`);
    assertRelClose(positionValue(L, edge * (1 + eps), Pa, Pb), v, 1e-5, `continuity above ${edge}`);
  }
  let prev = -Infinity;
  for (let price = 1500; price <= 5000; price += 25) {
    const v = positionValue(L, price, Pa, Pb);
    assert.ok(v >= prev - 1e-9, `positionValue non-decreasing at P=${price}`);
    prev = v;
  }
  assertRelClose(
    positionValue(L, 5000, Pa, Pb),
    positionValue(L, Pb, Pa, Pb),
    1e-12,
    "constant above Pb (all quote token)",
  );
});

// ---------------------------------------------------------------------------
// 4) Impermanent loss
// ---------------------------------------------------------------------------

test("ilVsHodl: zero at P1 = P0", () => {
  assertClose(ilVsHodl(P, P, Pa, Pb), 0, 1e-14);
  assertClose(ilVsHodl(2000, 2000, Pa, Pb), 0, 1e-14, "also when entering below range");
});

test("ilVsHodl: converges to classic full-range formula for a very wide range", () => {
  const P0 = 3000;
  const widePa = P0 * 1e-12;
  const widePb = P0 * 1e12;
  for (const k of [0.5, 0.8, 1.25, 2, 4]) {
    const il = ilVsHodl(P0, P0 * k, widePa, widePb);
    const classic = (2 * Math.sqrt(k)) / (1 + k) - 1;
    assertClose(il, classic, 1e-5, `full-range IL for k=${k}`);
  }
});

test("ilVsHodl: strictly a loss for P1 != P0 (in and out of range)", () => {
  for (const P1 of [2000, 2500.01, 2800, 3200, 3599, 4200, 6000]) {
    const il = ilVsHodl(P, P1, Pa, Pb);
    assert.ok(il < 0, `IL should be negative at P1=${P1}, got ${il}`);
    assert.ok(il > -1, `IL cannot lose more than everything, got ${il}`);
  }
});

test("ilVsHodl: narrower range means deeper IL for the same move", () => {
  const narrow = ilVsHodl(P, 3400, 2800, 3200);
  const wide = ilVsHodl(P, 3400, 2000, 4500);
  assert.ok(narrow < wide, `narrow IL (${narrow}) should be worse than wide IL (${wide})`);
});

// ---------------------------------------------------------------------------
// 5) concentrationFactor
// ---------------------------------------------------------------------------

test("concentrationFactor: > 1, increases as the range narrows", () => {
  const cWide = concentrationFactor(P, P * 0.5, P * 2);
  const cMid = concentrationFactor(P, P * 0.8, P * 1.25);
  const cNarrow = concentrationFactor(P, P * 0.95, P / 0.95);
  assert.ok(cWide > 1, `wide range factor should exceed 1, got ${cWide}`);
  assert.ok(cMid > cWide, "narrower beats wider");
  assert.ok(cNarrow > cMid, "narrowest beats mid");
  assertRelClose(concentrationFactor(P, 0, Infinity), 1, 1e-12, "full range factor is 1");
});

test("concentrationFactor: matches symmetric closed form 1/(1 - (Pa/Pb)^(1/4))", () => {
  // Independent derivation for a geometric-symmetric range Pa = P/m, Pb = P*m:
  // in-range L per deposit = 1/(2s - s^2/sb - sa) with sa = s/sqrt(m),
  // sb = s*sqrt(m)  =>  denominator = 2s(1 - m^(-1/2)); full-range L = 1/(2s);
  // ratio = 1/(1 - m^(-1/2)) and m^(-1/2) = (Pa/Pb)^(1/4). Matches the claim.
  for (const m of [1.05, 1.2, 1.5, 2, 4]) {
    const pa = P / m;
    const pb = P * m;
    const closed = 1 / (1 - Math.pow(pa / pb, 0.25));
    assertRelClose(concentrationFactor(P, pa, pb), closed, 1e-10, `symmetric closed form m=${m}`);
  }
});

// ---------------------------------------------------------------------------
// 6) timeInRange
// ---------------------------------------------------------------------------

test("timeInRange: basic fractions and inclusive edges", () => {
  assert.equal(timeInRange([1, 2, 3, 4], 2, 3), 0.5);
  assert.equal(timeInRange([1, 2, 3], 1, 3), 1, "bounds are inclusive");
  assert.equal(timeInRange([1, 2, 3], 4, 5), 0);
  assert.equal(timeInRange([], 0, 1), 0, "empty input -> 0");
  assert.equal(timeInRange([2, NaN, 2], 1, 3), 2 / 3, "non-finite samples count as out of range");
  assert.equal(timeInRange([5], 5, 5), 1, "degenerate range still inclusive");
  assert.throws(() => timeInRange([1], 3, 2), RangeError);
});

// ---------------------------------------------------------------------------
// 7) Fee APR estimation
// ---------------------------------------------------------------------------

test("estimateRangeAprSimple: poolFeeApr x concentration x timeInRange", () => {
  const apr = estimateRangeAprSimple({ poolFeeApr: 0.2, P, Pa, Pb, timeInRangeFraction: 0.75 });
  const expected = 0.2 * concentrationFactor(P, Pa, Pb) * 0.75;
  assertRelClose(apr, expected, 1e-12);
  assert.ok(apr > 0.2 * 0.75, "concentration should amplify the pool APR");
  assert.throws(
    () => estimateRangeAprSimple({ poolFeeApr: 0.2, P, Pa, Pb, timeInRangeFraction: 1.5 }),
    RangeError,
  );
});

test("estimateRangeAprFromLiquidity: share model, accepts raw uint128 strings", () => {
  // 25% share: Lpos = 1e30, Lactive = 3e30 (strings, beyond 2^53).
  const apr = estimateRangeAprFromLiquidity({
    dailyFeesUsd: 1000,
    depositUsd: 50_000,
    positionLiquidity: "1000000000000000000000000000000",
    avgActiveLiquidityInRange: "3000000000000000000000000000000",
    timeInRangeFraction: 0.8,
    // 1000 * 0.25 * 0.8 * 365 / 50000 = 1.46
  });
  assertRelClose(apr, 1.46, 1e-9);
  const zero = estimateRangeAprFromLiquidity({
    dailyFeesUsd: 1000,
    depositUsd: 50_000,
    positionLiquidity: 0,
    avgActiveLiquidityInRange: "0",
    timeInRangeFraction: 1,
  });
  assert.equal(zero, 0, "empty pool and no position -> 0, not NaN");
  assert.throws(
    () =>
      estimateRangeAprFromLiquidity({
        dailyFeesUsd: 1000,
        depositUsd: 0,
        positionLiquidity: 1,
        avgActiveLiquidityInRange: 1,
        timeInRangeFraction: 1,
      }),
    RangeError,
  );
});

test("rawLiquidityForDeposit: decimals scaling and orientation invariance", () => {
  const deposit = 1000;
  // Scaling: raw L = human L * 10^((d0+d1)/2).
  const human = liquidityForDeposit(deposit, P, Pa, Pb);
  assertRelClose(rawLiquidityForDeposit(deposit, P, Pa, Pb, 18, 6), human * 1e12, 1e-12);
  // Orientation invariance: the same physical deposit (1000 units of the
  // stable) computed with the price flipped to base-per-quote must give the
  // same raw L. Under inversion the quote token flips, so the deposit is
  // re-denominated: 1000 stable = 1000/P base units.
  const a = rawLiquidityForDeposit(deposit, P, Pa, Pb, 18, 6);
  const b = rawLiquidityForDeposit(deposit / P, 1 / P, 1 / Pb, 1 / Pa, 6, 18);
  assertRelClose(a, b, 1e-9, "raw liquidity is orientation-invariant");
});

// ---------------------------------------------------------------------------
// 8) Backtest
// ---------------------------------------------------------------------------

test("backtestRange: constant in-range price -> net = fees, IL = 0", () => {
  const days = 30;
  const closes = new Array(days).fill(3000);
  const res = backtestRange({ closes, Pa, Pb, poolFeeApr: 0.1 });
  assert.equal(res.timeInRange, 1);
  assertClose(res.il, 0, 1e-14, "no price move -> no IL");
  const expectedFees = days * (0.1 / 365) * concentrationFactor(3000, Pa, Pb);
  assertRelClose(res.feeReturn, expectedFees, 1e-12);
  assertRelClose(res.netReturn, res.feeReturn, 1e-12, "net = fees when IL = 0");
  assertRelClose(res.annualized, 0.1 * concentrationFactor(3000, Pa, Pb), 1e-12, "annualizes back to apr x C");
});

test("backtestRange: series that exits the range above", () => {
  const inDays = new Array(10).fill(3000);
  const outDays = [4000, 4500, 5000];
  const closes = [...inDays, ...outDays];
  const res = backtestRange({ closes, Pa, Pb, poolFeeApr: 0.1 });
  assertClose(res.timeInRange, 10 / 13, 1e-12);
  // Fees only accrue on the 10 in-range days.
  assertRelClose(res.feeReturn, 10 * (0.1 / 365) * concentrationFactor(3000, Pa, Pb), 1e-12);
  // Price moved 3000 -> 5000: real divergence loss.
  assertRelClose(res.il, ilVsHodl(3000, 5000, Pa, Pb), 1e-12);
  assert.ok(res.il < 0, "exiting the range must show IL");
  assertRelClose(res.netReturn, res.feeReturn + res.il, 1e-12);
  assertRelClose(res.annualized, (res.netReturn * 365) / 13, 1e-12);
});

test("backtestRange: dailyFeeAprs variant matches constant poolFeeApr, validates inputs", () => {
  const closes = [3000, 3100, 2900, 3050];
  const constant = backtestRange({ closes, Pa, Pb, poolFeeApr: 0.15 });
  const perDay = backtestRange({ closes, Pa, Pb, dailyFeeAprs: [0.15, 0.15, 0.15, 0.15] });
  assertRelClose(perDay.feeReturn, constant.feeReturn, 1e-12);
  assert.throws(() => backtestRange({ closes, Pa, Pb, dailyFeeAprs: [0.1] }), RangeError, "length mismatch");
  assert.throws(() => backtestRange({ closes: [], Pa, Pb, poolFeeApr: 0.1 }), RangeError, "empty closes");
  assert.throws(() => backtestRange({ closes, Pa, Pb }), RangeError, "no fee input at all");
  assert.throws(() => backtestRange({ closes, Pa: Pb, Pb: Pa, poolFeeApr: 0.1 }), RangeError, "inverted range");
});
