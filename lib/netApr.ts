// Net range APR: the backtested return of a concentrated position over a
// relative price band, net of impermanent loss. Pure (imports only rangeMath),
// so it is safe on both server and client.
//
// Orientation note: the band is built from the series' own last close
// (Pa = last/m, Pb = last*m), and range math is invariant under inverting the
// price orientation, so the result is the same whether `closes` are quoted as
// USD-per-volatile or its reciprocal. Callers may therefore pass pool-native
// subgraph closes without converting them.

import { backtestRange } from "./rangeMath";

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

/**
 * Net range APR for one band width from a pool's daily series. `closes` and
 * `dailyFeeAprs` must be the SAME length, oldest→newest and aligned by day
 * (dailyFeeAprs[i] = that day's whole-pool fee APR). Returns null if the series
 * is empty or the last close is invalid.
 */
export function computeRangeApr(
  closes: number[],
  dailyFeeAprs: number[],
  m: number | null,
): RangeAprPoint | null {
  if (closes.length === 0 || closes.length !== dailyFeeAprs.length) return null;
  const last = closes[closes.length - 1];
  if (!(last > 0)) return null;

  const Pa = m == null ? 0 : last / m;
  const Pb = m == null ? Infinity : last * m;
  try {
    const bt = backtestRange({ closes, Pa, Pb, dailyFeeAprs });
    // bt.feeReturn / bt.il are period totals; scale to annual so the parts sum
    // to bt.annualized.
    const scale = 365 / closes.length;
    return {
      netApr: bt.annualized,
      feeApr: bt.feeReturn * scale,
      ilApr: bt.il * scale,
      timeInRange: bt.timeInRange,
    };
  } catch {
    return null;
  }
}

/** Compute {@link computeRangeApr} for every preset width. */
export function computeAllWidths(
  closes: number[],
  dailyFeeAprs: number[],
): Record<RangeWidthKey, RangeAprPoint | null> {
  const out = {} as Record<RangeWidthKey, RangeAprPoint | null>;
  for (const w of RANGE_WIDTHS) {
    out[w.key] = computeRangeApr(closes, dailyFeeAprs, w.m);
  }
  return out;
}
