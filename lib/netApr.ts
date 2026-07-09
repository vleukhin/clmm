// Net range APR: the estimated return of a concentrated position over a
// relative price band, net of impermanent loss. Pure (imports only rangeMath),
// so it is safe on both server and client.
//
// FEE MODEL: liquidity-share. Your fee income is your share of the pool's
// in-range liquidity — position raw liquidity / (position + pool in-range
// liquidity) — times the pool's fees while the price is in your band. This
// avoids the "uniform-liquidity" overstatement of the concentration-factor
// model: real CLMM liquidity is already dense near price, so you don't get the
// full concentration multiplier for free.
//
// ORIENTATION: time-in-range and IL are built from the series' own last close
// (Pa = last/m, Pb = last*m) and are invariant under inverting the price
// orientation, so pool-native subgraph closes work directly. The liquidity
// share needs a USD-per-volatile price, recovered from the close by magnitude
// (USD-per-ETH/BTC is always >> 1, its reciprocal << 1).

import {
  ilVsHodl,
  rawLiquidityForDeposit,
  timeInRange,
} from "./rangeMath";

export interface RangeWidth {
  key: RangeWidthKey;
  label: string;
  /** Geometric half-width multiplier: band = [last/m, last*m]. null = full range. */
  m: number | null;
}

export type RangeWidthKey = "5" | "10" | "15" | "25" | "50" | "full";

export const RANGE_WIDTHS: RangeWidth[] = [
  { key: "5", label: "±5%", m: 1.05 },
  { key: "10", label: "±10%", m: 1.1 },
  { key: "15", label: "±15%", m: 1.15 },
  { key: "25", label: "±25%", m: 1.25 },
  { key: "50", label: "±50%", m: 1.5 },
  { key: "full", label: "Full", m: null },
];

export const DEFAULT_WIDTH: RangeWidthKey = "10";

export interface RangeAprPoint {
  /** Net APR (fees − IL), annualized fraction. */
  netApr: number;
  /** Annualized fee component (≥ 0). */
  feeApr: number;
  /** Annualized IL component (≤ 0). */
  ilApr: number;
  /** Fraction of days the close sat inside the band. */
  timeInRange: number;
}

/** Inputs for a pool's net range APR (all daily arrays oldest→newest). */
export interface RangeAprInputs {
  /** Daily closes, pool-native orientation. */
  closes: number[];
  /** Average whole-pool daily fees over the window, USD. */
  avgDailyFeesUsd: number;
  /** Pool current in-range liquidity, raw uint128 as a number. */
  liquidityRaw: number;
  decimals0: number;
  decimals1: number;
}

/** Nominal marginal deposit; cancels out in the marginal-share APR. */
const DEPOSIT_USD = 10_000;

/**
 * Net range APR for one band width. Fees use the liquidity-share model for
 * finite bands and the plain whole-pool APR for the full range. Returns null if
 * the series is empty or the last close is invalid.
 */
export function computeRangeApr(
  inp: RangeAprInputs,
  m: number | null,
): RangeAprPoint | null {
  const { closes, avgDailyFeesUsd, liquidityRaw, decimals0, decimals1 } = inp;
  if (closes.length === 0) return null;
  const last = closes[closes.length - 1];
  if (!(last > 0)) return null;

  const Pa = m == null ? 0 : last / m;
  const Pb = m == null ? Infinity : last * m;
  const days = closes.length;

  try {
    const tir = timeInRange(closes, Pa, Pb);
    const ilApr = (ilVsHodl(closes[0], last, Pa, Pb) * 365) / days;

    // Liquidity-share fee model for every width, including full range: your raw
    // liquidity for the band / (yours + pool in-range liquidity), times the
    // fees earned while in range. Concentrating raises your share; full range
    // spreads it thin. Uses USD-per-volatile price (the large orientation).
    const pUsd = last > 1 ? last : 1 / last;
    const paUsd = m == null ? 0 : pUsd / m;
    const pbUsd = m == null ? Infinity : pUsd * m;
    const lPos = rawLiquidityForDeposit(
      DEPOSIT_USD, pUsd, paUsd, pbUsd, decimals0, decimals1,
    );
    const denom = lPos + liquidityRaw;
    const share = denom > 0 ? lPos / denom : 0;
    const feeApr = (avgDailyFeesUsd * share * tir * 365) / DEPOSIT_USD;

    return { netApr: feeApr + ilApr, feeApr, ilApr, timeInRange: tir };
  } catch {
    return null;
  }
}

/** Compute {@link computeRangeApr} for every preset width. */
export function computeAllWidths(
  inp: RangeAprInputs,
): Record<RangeWidthKey, RangeAprPoint | null> {
  const out = {} as Record<RangeWidthKey, RangeAprPoint | null>;
  for (const w of RANGE_WIDTHS) out[w.key] = computeRangeApr(inp, w.m);
  return out;
}
