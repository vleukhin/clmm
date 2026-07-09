/**
 * Pure math engine for concentrated-liquidity (Uniswap-v3-style) range analysis.
 *
 * Scope: tick/price conversions, position math on sqrt-prices, impermanent
 * loss vs HODL, range concentration factor, time-in-range, fee-APR estimation
 * (two models), and a simple daily backtest.
 *
 * Conventions used throughout (documented per function as well):
 * - "Price" P is the HUMAN-UNIT price of token1 per token0 (decimals-adjusted),
 *   matching Uniswap v3's tick convention: P = 1.0001^tick * 10^(decimals0 - decimals1).
 *   For this app's pools the quote side is the stablecoin, so when token1 is the
 *   stable, P is "USD per ETH/BTC". All price-shaped inputs (P, Pa, Pb, closes)
 *   must share ONE orientation ("quote per base").
 * - "Quote" value units are token1 units under that orientation. All position
 *   math is symmetric under inverting the orientation (swap token0/token1 and
 *   use 1/P, 1/Pb..1/Pa), including rawLiquidityForDeposit.
 * - PRECISION: everything is plain IEEE-754 double math (~15-16 significant
 *   digits). This is ANALYTICS-GRADE, not settlement-grade: raw uint128
 *   liquidity values (up to ~3.4e38) are parsed into doubles with ~1e-16
 *   relative error, which is fine for APR/share ratios but must never be used
 *   to construct on-chain transactions.
 *
 * This module has NO imports and performs NO I/O; all types are defined locally
 * so the parallel data-API modules can plug in with plain numbers/strings.
 */

/** Minimum tick supported by Uniswap v3 (price ~ 2^-128 in raw units). */
export const MIN_TICK = -887272;
/** Maximum tick supported by Uniswap v3 (price ~ 2^128 in raw units). */
export const MAX_TICK = 887272;

/** Rounding mode for {@link alignToSpacing}. */
export type RoundMode = "down" | "up" | "nearest";

/** Token amounts in HUMAN units (decimals-adjusted), token0 and token1. */
export interface TokenAmounts {
  /** Human-unit amount of token0 (the base asset under quote-per-base orientation). */
  amount0: number;
  /** Human-unit amount of token1 (the quote asset). */
  amount1: number;
}

/** Parameters for {@link estimateRangeAprSimple}. */
export interface SimpleRangeAprParams {
  /**
   * Whole-pool fee APR as a fraction (e.g. 0.25 = 25%/yr), i.e. annualized
   * fees / TVL. Matches the app's feeApr7d / feeApr30d fields.
   */
  poolFeeApr: number;
  /** Current price, quote per base (same orientation as Pa/Pb). */
  P: number;
  /** Range lower bound price. Must satisfy 0 <= Pa < Pb. */
  Pa: number;
  /** Range upper bound price. May be Infinity for a full-range upper bound. */
  Pb: number;
  /** Fraction of time the price is expected in [Pa, Pb], in [0, 1]. */
  timeInRangeFraction: number;
}

/** Parameters for {@link estimateRangeAprFromLiquidity}. */
export interface LiquidityShareAprParams {
  /** Average daily fees earned by the whole pool over the window, USD. */
  dailyFeesUsd: number;
  /** The prospective deposit, USD. Must be > 0. */
  depositUsd: number;
  /**
   * The position's liquidity in RAW pool units (uint128 scale). Accepts a
   * decimal string (as returned raw from a subgraph / tick API) or a number.
   * MUST be in the same raw units as {@link avgActiveLiquidityInRange} — use
   * {@link rawLiquidityForDeposit} to convert a USD deposit to raw units.
   */
  positionLiquidity: number | string;
  /**
   * Average active liquidity of the pool across the ticks inside [Pa, Pb], in
   * RAW pool units (uint128 scale), e.g. a liquidity-weighted or simple
   * average of the tick API's `activeLiquidity` segments within the range.
   * Accepts a decimal string or a number.
   */
  avgActiveLiquidityInRange: number | string;
  /** Fraction of time the price is expected in range, in [0, 1]. */
  timeInRangeFraction: number;
}

/** Parameters for {@link backtestRange}. */
export interface BacktestRangeParams {
  /**
   * Daily closing prices, quote per base — SAME orientation as Pa/Pb (for this
   * app: stable per ETH/BTC). Each close represents one day of fee accrual.
   * Must be non-empty.
   */
  closes: number[];
  /** Range lower bound price. */
  Pa: number;
  /** Range upper bound price. */
  Pb: number;
  /**
   * Constant whole-pool fee APR (fraction/yr) applied to every day. Provide
   * either this or {@link dailyFeeAprs}. Ignored if dailyFeeAprs is given.
   */
  poolFeeApr?: number;
  /**
   * Per-day whole-pool fee APRs (fraction/yr, one per close, same length as
   * closes) for windows where daily fee data is available.
   */
  dailyFeeAprs?: number[];
}

/** Result of {@link backtestRange}. All returns are fractions of the deposit. */
export interface BacktestRangeResult {
  /** Fraction of daily closes inside [Pa, Pb] (inclusive). */
  timeInRange: number;
  /**
   * Simple (non-compounded) sum of daily in-range fee accrual, as a fraction
   * of the initial deposit: sum over in-range days of
   * (dayPoolFeeApr / 365) * concentrationFactor(close, Pa, Pb).
   */
  feeReturn: number;
  /** Impermanent loss vs HODL from first to last close (<= 0), see {@link ilVsHodl}. */
  il: number;
  /** feeReturn + il. */
  netReturn: number;
  /** netReturn scaled to a year: netReturn * 365 / closes.length. */
  annualized: number;
}

// ---------------------------------------------------------------------------
// Validation helpers (internal)
// ---------------------------------------------------------------------------

function assertFinitePositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite number > 0, got ${value}`);
  }
}

/** Pa may be 0 and Pb may be Infinity (full-range limits), but Pa < Pb always. */
function assertPriceRange(Pa: number, Pb: number): void {
  if (Number.isNaN(Pa) || Number.isNaN(Pb) || Pa < 0 || !(Pa < Pb)) {
    throw new RangeError(`Invalid price range: need 0 <= Pa < Pb, got Pa=${Pa}, Pb=${Pb}`);
  }
}

function toLiquidityNumber(value: number | string, name: string): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n) || n < 0) {
    throw new RangeError(`${name} must be a non-negative finite liquidity, got ${value}`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// 1) Tick / price conversions
// ---------------------------------------------------------------------------

/**
 * Convert a Uniswap v3 tick to a HUMAN-UNIT price of token1 per token0.
 *
 * Uniswap v3 defines the raw price (token1 raw units per token0 raw unit) as
 * 1.0001^tick; the human price adjusts for decimals:
 *   price = 1.0001^tick * 10^(decimals0 - decimals1)
 *
 * E.g. for mainnet USDC(6)/WETH(18) pools (token0=USDC, token1=WETH) this
 * returns WETH per USDC; invert for USD-per-ETH.
 *
 * @param tick Tick index (may be fractional; integer ticks match on-chain ticks).
 * @param decimals0 token0 decimals.
 * @param decimals1 token1 decimals.
 * @returns Price of token1 per token0 in human units.
 */
export function tickToPrice(tick: number, decimals0: number, decimals1: number): number {
  if (!Number.isFinite(tick)) throw new RangeError(`tick must be finite, got ${tick}`);
  return Math.pow(1.0001, tick) * Math.pow(10, decimals0 - decimals1);
}

/**
 * Inverse of {@link tickToPrice}: the (real-valued, NOT rounded) tick whose
 * price equals the given human-unit token1-per-token0 price:
 *   tick = log_{1.0001}(price * 10^(decimals1 - decimals0))
 *
 * Round or use {@link alignToSpacing} to land on an initializable tick.
 *
 * @param price Human-unit price of token1 per token0. Must be > 0.
 * @returns Real-valued tick (fractional).
 */
export function priceToTick(price: number, decimals0: number, decimals1: number): number {
  assertFinitePositive(price, "price");
  return Math.log(price * Math.pow(10, decimals1 - decimals0)) / Math.log(1.0001);
}

/**
 * Snap a (possibly fractional) tick onto the pool's tick-spacing grid, clamped
 * to the usable [MIN_TICK, MAX_TICK] grid.
 *
 * @param tick Tick to align (fractional allowed, e.g. straight from priceToTick).
 * @param tickSpacing Pool tick spacing (positive integer, e.g. 10 / 60 / 200).
 * @param mode "down" = floor to grid, "up" = ceil to grid, "nearest" = round. Default "nearest".
 * @returns An integer tick that is a multiple of tickSpacing within the usable range.
 */
export function alignToSpacing(
  tick: number,
  tickSpacing: number,
  mode: RoundMode = "nearest",
): number {
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) {
    throw new RangeError(`tickSpacing must be a positive integer, got ${tickSpacing}`);
  }
  if (!Number.isFinite(tick)) throw new RangeError(`tick must be finite, got ${tick}`);
  const q = tick / tickSpacing;
  const steps = mode === "down" ? Math.floor(q) : mode === "up" ? Math.ceil(q) : Math.round(q);
  const aligned = steps * tickSpacing;
  const minUsable = Math.ceil(MIN_TICK / tickSpacing) * tickSpacing;
  const maxUsable = Math.floor(MAX_TICK / tickSpacing) * tickSpacing;
  return Math.min(Math.max(aligned, minUsable), maxUsable);
}

// ---------------------------------------------------------------------------
// 2) Position math (standard Uniswap v3 formulas on sqrt prices)
// ---------------------------------------------------------------------------
//
// With s = sqrt(P), sa = sqrt(Pa), sb = sqrt(Pb) (all in human-unit prices):
//   token0 held while price in [s, sb]: amount0 = L * (1/s - 1/sb)
//   token1 held while price in [sa, s]: amount1 = L * (s - sa)
// The "1/s - 1/sb" form (rather than (sb-s)/(s*sb)) is used so sb = Infinity
// (full-range upper bound) degrades gracefully.
//
// NOTE these are HUMAN-UNIT liquidity values; multiply by
// 10^((decimals0+decimals1)/2) to get raw pool (uint128-scale) liquidity —
// see rawLiquidityForDeposit.

/**
 * Liquidity L obtainable from given HUMAN-UNIT token amounts at current sqrt
 * price sqrtP for the range [sqrtPa, sqrtPb] (standard Uniswap v3 min rule:
 * in-range, L is the binding minimum of what each token side supports).
 *
 * @param amount0 Human-unit amount of token0 available.
 * @param amount1 Human-unit amount of token1 available.
 * @param sqrtP Current sqrt(price), price in token1-per-token0 human units.
 * @param sqrtPa sqrt(lower bound price); must be < sqrtPb.
 * @param sqrtPb sqrt(upper bound price); Infinity allowed.
 * @returns Liquidity in human units (same scale as other functions here).
 */
export function liquidityForAmounts(
  amount0: number,
  amount1: number,
  sqrtP: number,
  sqrtPa: number,
  sqrtPb: number,
): number {
  assertPriceRange(sqrtPa, sqrtPb);
  if (amount0 < 0 || amount1 < 0) {
    throw new RangeError(`amounts must be >= 0, got amount0=${amount0}, amount1=${amount1}`);
  }
  const liq0 = (a0: number, lo: number, hi: number) => a0 / (1 / lo - 1 / hi);
  const liq1 = (a1: number, lo: number, hi: number) => a1 / (hi - lo);
  if (sqrtP <= sqrtPa) return liq0(amount0, sqrtPa, sqrtPb);
  if (sqrtP >= sqrtPb) return liq1(amount1, sqrtPa, sqrtPb);
  return Math.min(liq0(amount0, sqrtP, sqrtPb), liq1(amount1, sqrtPa, sqrtP));
}

/**
 * Inverse of {@link liquidityForAmounts}: the HUMAN-UNIT token amounts a
 * position of liquidity L holds at sqrt price sqrtP for range [sqrtPa, sqrtPb].
 * Below range it is all token0; above range all token1.
 *
 * @param L Liquidity in human units.
 * @returns {@link TokenAmounts} in human units.
 */
export function amountsForLiquidity(
  L: number,
  sqrtP: number,
  sqrtPa: number,
  sqrtPb: number,
): TokenAmounts {
  assertPriceRange(sqrtPa, sqrtPb);
  if (!Number.isFinite(L) || L < 0) throw new RangeError(`L must be >= 0, got ${L}`);
  const s = Math.min(Math.max(sqrtP, sqrtPa), sqrtPb);
  return {
    amount0: L * (1 / s - 1 / sqrtPb),
    amount1: L * (s - sqrtPa),
  };
}

/**
 * Liquidity received for a deposit of total value `depositQuote` (denominated
 * in the QUOTE token, i.e. token1 under the price orientation used) at price
 * P into range [Pa, Pb], depositing exactly the value-balanced amounts the
 * range requires at P:
 * - P inside range: both tokens, in the range's natural ratio;
 * - P <= Pa: all token0 (valued at P);
 * - P >= Pb: all token1.
 *
 * Closed forms (s = sqrtP etc.):
 *   in-range:  L = D / (2s - s^2/sb - sa)
 *   below:     L = (D / P) * sa / (1 - sa/sb)
 *   above:     L = D / (sb - sa)
 * Continuous at both edges. Pa = 0 and/or Pb = Infinity give the full-range
 * limit (in-range: L = D / (2s)).
 *
 * @param depositQuote Deposit value in quote-token (token1) human units. > 0.
 * @param P Current price, quote per base. > 0.
 * @param Pa Lower bound price (0 allowed).
 * @param Pb Upper bound price (Infinity allowed).
 * @returns Liquidity in human units.
 */
export function liquidityForDeposit(depositQuote: number, P: number, Pa: number, Pb: number): number {
  assertFinitePositive(depositQuote, "depositQuote");
  assertFinitePositive(P, "P");
  assertPriceRange(Pa, Pb);
  const s = Math.sqrt(P);
  const sa = Math.sqrt(Pa);
  const sb = Math.sqrt(Pb);
  if (s <= sa) return (depositQuote / P) * (sa / (1 - sa / sb));
  if (s >= sb) return depositQuote / (sb - sa);
  return depositQuote / (2 * s - (s * s) / sb - sa);
}

// ---------------------------------------------------------------------------
// 3) Position value
// ---------------------------------------------------------------------------

/**
 * Mark-to-market value, in QUOTE-token (token1) human units, of a position of
 * liquidity L over [Pa, Pb] when the price is P. Handles P below / inside /
 * above the range (token0 holdings are valued at the CURRENT price P even
 * when P is outside the range). Continuous in P; constant for P >= Pb.
 *
 * @param L Liquidity in human units (e.g. from {@link liquidityForDeposit}).
 * @param P Current price, quote per base.
 * @returns Position value in quote units.
 */
export function positionValue(L: number, P: number, Pa: number, Pb: number): number {
  assertFinitePositive(P, "P");
  const { amount0, amount1 } = amountsForLiquidity(L, Math.sqrt(P), Math.sqrt(Pa), Math.sqrt(Pb));
  return amount0 * P + amount1;
}

// ---------------------------------------------------------------------------
// 4) Impermanent loss vs HODL
// ---------------------------------------------------------------------------

/**
 * Impermanent (divergence) loss vs HODL for a range position, EXCLUDING fees:
 * enter at P0 with the value-balanced deposit for [Pa, Pb] (see
 * {@link liquidityForDeposit}), evaluate at P1, and compare with simply
 * holding the entry amounts.
 *
 *   il = positionValue(P1) / hodlValue(P1) - 1
 *
 * Properties (tested): il = 0 at P1 = P0; il <= 0 for any P1 (concavity of
 * the position value in P); as [Pa, Pb] -> (0, Infinity) it converges to the
 * classic full-range formula 2*sqrt(k)/(1+k) - 1 with k = P1/P0. Because the
 * position is never rebalanced, the result depends only on the endpoint
 * prices, not the path.
 *
 * @param P0 Entry price (quote per base).
 * @param P1 Evaluation price.
 * @param Pa Range lower bound (0 allowed).
 * @param Pb Range upper bound (Infinity allowed).
 * @returns Fraction of the HODL value lost (<= 0, e.g. -0.03 = -3%).
 */
export function ilVsHodl(P0: number, P1: number, Pa: number, Pb: number): number {
  assertFinitePositive(P0, "P0");
  assertFinitePositive(P1, "P1");
  assertPriceRange(Pa, Pb);
  const L = liquidityForDeposit(1, P0, Pa, Pb);
  const entry = amountsForLiquidity(L, Math.sqrt(P0), Math.sqrt(Pa), Math.sqrt(Pb));
  const hodl = entry.amount0 * P1 + entry.amount1;
  const pos = positionValue(L, P1, Pa, Pb);
  return pos / hodl - 1;
}

// ---------------------------------------------------------------------------
// 5) Concentration factor
// ---------------------------------------------------------------------------

/**
 * How many times more liquidity per deposited quote unit the range [Pa, Pb]
 * position has versus a FULL-RANGE position with the same deposit at the same
 * price P. This is the fee-earning multiplier while in range (your share of
 * fees scales with L for a marginal position).
 *
 * Derived directly from {@link liquidityForDeposit} (not a hardcoded closed
 * form): L(range) / L(full range). For a geometrically symmetric range
 * (Pa = P/m, Pb = P*m) this equals 1 / (1 - (Pa/Pb)^(1/4)) — asserted in tests.
 *
 * @param P Current price, quote per base; typically inside [Pa, Pb].
 * @returns Multiplier > 1 for any finite range (when P is in range).
 */
export function concentrationFactor(P: number, Pa: number, Pb: number): number {
  return liquidityForDeposit(1, P, Pa, Pb) / liquidityForDeposit(1, P, 0, Infinity);
}

// ---------------------------------------------------------------------------
// 6) Time in range
// ---------------------------------------------------------------------------

/**
 * Fraction of samples with lower <= close <= upper (bounds INCLUSIVE).
 * Non-finite samples count as out of range. Returns 0 for an empty array.
 *
 * @param closes Price samples (e.g. daily closes), any orientation as long as
 *   it matches lower/upper.
 * @returns Fraction in [0, 1].
 */
export function timeInRange(closes: number[], lower: number, upper: number): number {
  if (!(lower <= upper)) {
    throw new RangeError(`need lower <= upper, got lower=${lower}, upper=${upper}`);
  }
  if (closes.length === 0) return 0;
  let inCount = 0;
  for (const c of closes) {
    if (Number.isFinite(c) && c >= lower && c <= upper) inCount++;
  }
  return inCount / closes.length;
}

// ---------------------------------------------------------------------------
// 7) Fee APR estimation
// ---------------------------------------------------------------------------

/**
 * Quick screening estimate of the range position's fee APR:
 *
 *   apr = poolFeeApr * concentrationFactor(P, Pa, Pb) * timeInRangeFraction
 *
 * ASSUMPTIONS (this is deliberately crude):
 * - your position is marginal (does not dilute the pool's fee share);
 * - the pool's existing liquidity is roughly uniform across the trading range,
 *   so the whole-pool fee APR is representative of full-range LPs and your
 *   concentration factor scales it linearly;
 * - fee intensity is independent of where in your range the price sits.
 * Use {@link estimateRangeAprFromLiquidity} when real tick-liquidity data is
 * available.
 *
 * @returns Estimated fee APR as a fraction (0.25 = 25%/yr). Excludes IL.
 */
export function estimateRangeAprSimple(params: SimpleRangeAprParams): number {
  const { poolFeeApr, P, Pa, Pb, timeInRangeFraction } = params;
  if (!Number.isFinite(poolFeeApr) || poolFeeApr < 0) {
    throw new RangeError(`poolFeeApr must be >= 0, got ${poolFeeApr}`);
  }
  if (!Number.isFinite(timeInRangeFraction) || timeInRangeFraction < 0 || timeInRangeFraction > 1) {
    throw new RangeError(`timeInRangeFraction must be in [0, 1], got ${timeInRangeFraction}`);
  }
  return poolFeeApr * concentrationFactor(P, Pa, Pb) * timeInRangeFraction;
}

/**
 * Share-based fee APR estimate from real tick-liquidity data:
 *
 *   apr = dailyFeesUsd * Lpos / (Lpos + Lactive) * timeInRangeFraction * 365 / depositUsd
 *
 * where Lpos is the position's raw liquidity and Lactive the pool's average
 * active raw liquidity inside [Pa, Pb] (the position is ADDED to the pool, so
 * it dilutes: share = Lpos / (Lpos + Lactive)).
 *
 * UNITS: positionLiquidity and avgActiveLiquidityInRange MUST be in the same
 * RAW pool units (uint128 scale, as the tick API returns in its
 * `activeLiquidity` strings). Convert a USD deposit to raw liquidity with
 * {@link rawLiquidityForDeposit} using the SAME price orientation and token
 * decimals as the tick data. Strings are parsed with Number(): values above
 * 2^53 lose precision (~1e-16 relative) — irrelevant for the share ratio.
 *
 * ASSUMPTIONS: all pool fees accrue to in-range liquidity; the window-average
 * active liquidity and daily fees are representative going forward; fee
 * intensity is uniform across days you are in range.
 *
 * @returns Estimated fee APR as a fraction. Excludes IL.
 */
export function estimateRangeAprFromLiquidity(params: LiquidityShareAprParams): number {
  const { dailyFeesUsd, depositUsd, timeInRangeFraction } = params;
  if (!Number.isFinite(dailyFeesUsd) || dailyFeesUsd < 0) {
    throw new RangeError(`dailyFeesUsd must be >= 0, got ${dailyFeesUsd}`);
  }
  assertFinitePositive(depositUsd, "depositUsd");
  if (!Number.isFinite(timeInRangeFraction) || timeInRangeFraction < 0 || timeInRangeFraction > 1) {
    throw new RangeError(`timeInRangeFraction must be in [0, 1], got ${timeInRangeFraction}`);
  }
  const lPos = toLiquidityNumber(params.positionLiquidity, "positionLiquidity");
  const lActive = toLiquidityNumber(params.avgActiveLiquidityInRange, "avgActiveLiquidityInRange");
  const denom = lPos + lActive;
  const share = denom > 0 ? lPos / denom : 0;
  return (dailyFeesUsd * share * timeInRangeFraction * 365) / depositUsd;
}

/**
 * Liquidity in RAW pool units (uint128 scale — directly comparable to the
 * tick API's `activeLiquidity` strings and to subgraph liquidity) for a
 * deposit of `depositQuote` quote-token units at price P into [Pa, Pb].
 *
 *   L_raw = liquidityForDeposit(depositQuote, P, Pa, Pb) * 10^((decimals0 + decimals1) / 2)
 *
 * The decimals factor comes from raw amounts being human amounts * 10^dec and
 * the raw sqrt price being sqrt(P) * 10^((decimals1-decimals0)/2). It is
 * symmetric in the two tokens, and L itself is invariant under inverting the
 * price orientation, so either orientation works as long as depositQuote is
 * denominated in that orientation's quote token (tested).
 *
 * PRECISION: double math — good to ~15 significant digits, NOT exact uint128
 * arithmetic. Use only for analytics ratios, never for on-chain amounts.
 *
 * @param depositQuote Deposit value in quote-token human units (USD if the quote is a stablecoin).
 * @param P Current price, quote per base.
 * @param decimals0 token0 decimals under the SAME orientation as P.
 * @param decimals1 token1 decimals.
 * @returns Raw-unit liquidity as a number (may exceed 2^53; analytics-grade).
 */
export function rawLiquidityForDeposit(
  depositQuote: number,
  P: number,
  Pa: number,
  Pb: number,
  decimals0: number,
  decimals1: number,
): number {
  return liquidityForDeposit(depositQuote, P, Pa, Pb) * Math.pow(10, (decimals0 + decimals1) / 2);
}

// ---------------------------------------------------------------------------
// 8) Backtest
// ---------------------------------------------------------------------------

/**
 * Transparent "what would this range have done over the window" estimate on
 * daily closes. MODEL (kept deliberately simple):
 * - Enter at the first close with a value-balanced deposit for [Pa, Pb]; never
 *   rebalance; exit at the last close.
 * - Each close represents one day. A day earns fees only if its close is
 *   inside [Pa, Pb] (inclusive); intraday range exits are invisible, which
 *   OVERSTATES fees for ranges the price straddles.
 * - Daily fee accrual = (that day's pool fee APR / 365) * concentrationFactor
 *   at that day's close: marginal-position, uniform-pool-liquidity assumption
 *   as in {@link estimateRangeAprSimple}.
 * - feeReturn is a simple (non-compounded) sum of daily accruals on the
 *   initial deposit; fees are assumed NOT redeposited.
 * - il is endpoint-to-endpoint ({@link ilVsHodl} from closes[0] to the last
 *   close) — exact for a never-rebalanced position, as position and HODL
 *   values depend only on the final price.
 * - annualized = netReturn * 365 / closes.length (simple scaling, no
 *   compounding).
 *
 * @returns {@link BacktestRangeResult}; all values are fractions of the deposit.
 */
export function backtestRange(params: BacktestRangeParams): BacktestRangeResult {
  const { closes, Pa, Pb, poolFeeApr, dailyFeeAprs } = params;
  assertPriceRange(Pa, Pb);
  if (!Array.isArray(closes) || closes.length === 0) {
    throw new RangeError("closes must be a non-empty array of daily prices");
  }
  if (dailyFeeAprs !== undefined && dailyFeeAprs.length !== closes.length) {
    throw new RangeError(
      `dailyFeeAprs length (${dailyFeeAprs.length}) must match closes length (${closes.length})`,
    );
  }
  if (dailyFeeAprs === undefined && (poolFeeApr === undefined || !Number.isFinite(poolFeeApr) || poolFeeApr < 0)) {
    throw new RangeError("provide dailyFeeAprs or a non-negative poolFeeApr");
  }

  let inCount = 0;
  let feeReturn = 0;
  for (let i = 0; i < closes.length; i++) {
    const close = closes[i];
    assertFinitePositive(close, `closes[${i}]`);
    if (close >= Pa && close <= Pb) {
      inCount++;
      const apr = dailyFeeAprs !== undefined ? dailyFeeAprs[i] : (poolFeeApr as number);
      if (!Number.isFinite(apr) || apr < 0) {
        throw new RangeError(`daily fee APR at index ${i} must be >= 0, got ${apr}`);
      }
      feeReturn += (apr / 365) * concentrationFactor(close, Pa, Pb);
    }
  }

  const il = ilVsHodl(closes[0], closes[closes.length - 1], Pa, Pb);
  const netReturn = feeReturn + il;
  return {
    timeInRange: inCount / closes.length,
    feeReturn,
    il,
    netReturn,
    annualized: (netReturn * 365) / closes.length,
  };
}
