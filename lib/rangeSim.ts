// Client-side glue between the UI's price orientation (USD per volatile asset)
// and the range-math engine + tick data (which live in the pool's own
// token1-per-token0 orientation). Pure functions, no I/O.

import {
  backtestRange,
  concentrationFactor,
  estimateRangeAprFromLiquidity,
  estimateRangeAprSimple,
  ilVsHodl,
  priceToTick,
  rawLiquidityForDeposit,
  timeInRange,
  type BacktestRangeResult,
} from "./rangeMath";
import {
  activeLiquidityInRange,
  type LiquiditySegment,
  type TickPoolMeta,
} from "./ticks";
import type { DailyCandle } from "./priceHistory";
import type { Pool } from "./types";

/**
 * Whether the pool's token0 is the stablecoin, i.e. the subgraph's
 * token1-per-token0 price is volatile-per-stable and must be INVERTED to get
 * the UI's USD-per-volatile orientation. Decided by magnitude: whichever
 * orientation of the pool price lands closer (log-distance) to the known USD
 * price is the right one — robust to symbol naming differences.
 */
export function stableIsToken0(meta: TickPoolMeta, usdPrice: number): boolean {
  const p = meta.currentPrice1per0;
  if (!(p > 0) || !(usdPrice > 0)) return false;
  const dDirect = Math.abs(Math.log(p / usdPrice));
  const dInverted = Math.abs(Math.log(1 / p / usdPrice));
  return dInverted < dDirect;
}

/** Convert a USD-per-volatile price into the pool's token1-per-token0 units. */
export function usdToPoolPrice(
  usdPrice: number,
  inverted: boolean,
): number {
  return inverted ? 1 / usdPrice : usdPrice;
}

/** Convert a pool-orientation (token1 per token0) price into USD-per-volatile. */
export function poolToUsdPrice(
  poolPrice: number,
  inverted: boolean,
): number {
  return inverted ? 1 / poolPrice : poolPrice;
}

/** A liquidity segment mapped into UI space: [x0, x1) in USD, y = raw liquidity. */
export interface UsdLiquidityBucket {
  x0: number;
  x1: number;
  liquidity: number;
}

/**
 * Map tick segments into USD-price buckets (ascending by price). Each segment
 * spans [tickIdx, next tickIdx); when the orientation is inverted the USD
 * interval flips ends. The (half-open) last segment is dropped — its liquidity
 * is normally zero and it has no finite end.
 */
export function segmentsToUsdBuckets(
  segments: LiquiditySegment[],
  inverted: boolean,
): UsdLiquidityBucket[] {
  const out: UsdLiquidityBucket[] = [];
  for (let i = 0; i + 1 < segments.length; i++) {
    const pA = poolToUsdPrice(segments[i].price1per0, inverted);
    const pB = poolToUsdPrice(segments[i + 1].price1per0, inverted);
    out.push({
      x0: Math.min(pA, pB),
      x1: Math.max(pA, pB),
      liquidity: Number(segments[i].activeLiquidity),
    });
  }
  out.sort((a, b) => a.x0 - b.x0);
  return out;
}

export interface SimulationInputs {
  pool: Pool;
  candles: DailyCandle[];
  /** Tick data when the pool's DEX has a subgraph; null otherwise. */
  tickMeta: TickPoolMeta | null;
  segments: LiquiditySegment[] | null;
  depositUsd: number;
  /** Range bounds, USD per volatile. paUsd=0 / pbUsd=Infinity => full range. */
  paUsd: number;
  pbUsd: number;
}

export interface SimulationResult {
  priceUsd: number;
  concentration: number;
  /** Historical fraction of daily closes inside the range. */
  timeInRange: number;
  /** Crude estimate: pool APR × concentration × time-in-range. */
  aprSimple: number | null;
  /** Share-based estimate from real tick liquidity (null without tick data). */
  aprLiquidity: number | null;
  /** IL if the price settles at the lower / upper bound (fractions <= 0). */
  ilAtLower: number | null;
  ilAtUpper: number | null;
  backtest: BacktestRangeResult | null;
  /** Whole-pool fee APR used as the fee-intensity input, fraction/yr. */
  poolFeeApr: number;
  error: string | null;
}

/**
 * Run the full range simulation. Returns partial results with `error` set when
 * inputs are unusable (bad range, no price). All APR values are fractions/yr.
 */
export function simulateRange(inputs: SimulationInputs): SimulationResult {
  const { pool, candles, tickMeta, segments, depositUsd, paUsd, pbUsd } = inputs;

  const empty: SimulationResult = {
    priceUsd: NaN,
    concentration: NaN,
    timeInRange: 0,
    aprSimple: null,
    aprLiquidity: null,
    ilAtLower: null,
    ilAtUpper: null,
    backtest: null,
    poolFeeApr: 0,
    error: null,
  };

  const closes = candles.map((c) => c.close).filter((v) => v > 0);
  const priceUsd = closes.length > 0 ? closes[closes.length - 1] : NaN;
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
    return { ...empty, error: "No price history available for this pool." };
  }
  if (!(paUsd >= 0) || !(paUsd < pbUsd)) {
    return { ...empty, priceUsd, error: "Range bounds must satisfy 0 ≤ min < max." };
  }
  if (!(depositUsd > 0)) {
    return { ...empty, priceUsd, error: "Deposit must be positive." };
  }

  // Whole-pool fee APR: prefer the real 30d figure, then 7d, then a crude
  // volume × feeTier estimate — same fallback ladder as the list columns.
  const poolFeeApr =
    pool.feeApr30d ??
    pool.feeApr7d ??
    (pool.feeTier != null ? pool.volumeToTvl * pool.feeTier * 365 : 0);

  try {
    const tir = timeInRange(closes, paUsd, pbUsd);
    const concentration = concentrationFactor(priceUsd, paUsd, pbUsd);
    const aprSimple = estimateRangeAprSimple({
      poolFeeApr,
      P: priceUsd,
      Pa: paUsd,
      Pb: pbUsd,
      timeInRangeFraction: tir,
    });

    // IL at the bounds is undefined for full-range limits (0 / Infinity).
    const ilAtLower = paUsd > 0 ? ilVsHodl(priceUsd, paUsd, paUsd, pbUsd) : null;
    const ilAtUpper = Number.isFinite(pbUsd)
      ? ilVsHodl(priceUsd, pbUsd, paUsd, pbUsd)
      : null;

    // Share-based APR from real tick liquidity, when available.
    let aprLiquidity: number | null = null;
    if (tickMeta && segments && segments.length > 0) {
      const inverted = stableIsToken0(tickMeta, priceUsd);
      // Convert USD bounds to pool orientation; inversion flips the order.
      const poolP1 = usdToPoolPrice(paUsd > 0 ? paUsd : 1e-18, inverted);
      const poolP2 = Number.isFinite(pbUsd)
        ? usdToPoolPrice(pbUsd, inverted)
        : usdToPoolPrice(1e18, inverted);
      const t1 = priceToTick(poolP1, tickMeta.token0.decimals, tickMeta.token1.decimals);
      const t2 = priceToTick(poolP2, tickMeta.token0.decimals, tickMeta.token1.decimals);
      const tickLower = Math.round(Math.min(t1, t2));
      const tickUpper = Math.max(Math.round(Math.max(t1, t2)), tickLower + 1);

      const avg = activeLiquidityInRange(segments, tickLower, tickUpper);
      const positionLiquidity = rawLiquidityForDeposit(
        depositUsd,
        priceUsd,
        paUsd,
        pbUsd,
        tickMeta.token0.decimals,
        tickMeta.token1.decimals,
      );
      const dailyFeesUsd = (poolFeeApr * pool.tvlUsd) / 365;
      aprLiquidity = estimateRangeAprFromLiquidity({
        dailyFeesUsd,
        depositUsd,
        positionLiquidity,
        avgActiveLiquidityInRange: avg.liquidityNumber,
        timeInRangeFraction: tir,
      });
    }

    // Backtest with per-day fee APRs from real daily volumes when the fee tier
    // is known (assumes today's TVL across the window), else constant pool APR.
    const dailyFeeAprs =
      pool.feeTier != null && pool.tvlUsd > 0
        ? candles
            .filter((c) => c.close > 0)
            .map((c) => (c.volumeUsd * pool.feeTier! * 365) / pool.tvlUsd)
        : undefined;
    const backtest = backtestRange({
      closes,
      Pa: paUsd,
      Pb: pbUsd,
      poolFeeApr,
      dailyFeeAprs,
    });

    return {
      priceUsd,
      concentration,
      timeInRange: tir,
      aprSimple,
      aprLiquidity,
      ilAtLower,
      ilAtUpper,
      backtest,
      poolFeeApr,
      error: null,
    };
  } catch (err) {
    return {
      ...empty,
      priceUsd,
      error: err instanceof Error ? err.message : "Simulation failed.",
    };
  }
}
