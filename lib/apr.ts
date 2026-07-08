// Fee-APR estimation for CLMM pools.
//
// Fee APR ≈ (fees earned over a window / TVL) annualized, where
// fees = traded volume × fee tier. This is a pool-level estimate assuming
// liquidity is spread like the current TVL — it is NOT the realized APR of any
// single concentrated position (which depends on the chosen price range).

const DAYS_PER_YEAR = 365;

/**
 * @param volumeUsd  total traded volume over `days`.
 * @param tvlUsd     current TVL.
 * @param feeTier    fee tier as a fraction (e.g. 0.0005 for 0.05%).
 * @param days       length of the window the volume covers.
 * @returns annualized fee APR as a fraction (0.25 = 25%), or null if inputs
 *          are insufficient.
 */
export function computeFeeApr(
  volumeUsd: number,
  tvlUsd: number,
  feeTier: number | null,
  days: number,
): number | null {
  if (feeTier == null || tvlUsd <= 0 || days <= 0) return null;
  if (!Number.isFinite(volumeUsd) || volumeUsd < 0) return null;
  const fees = volumeUsd * feeTier;
  return (fees / tvlUsd) * (DAYS_PER_YEAR / days);
}

/**
 * Fee APR from real accrued fees (subgraph feesUSD summed over a window).
 * @param feesUsd  total fees over `days`.
 * @param tvlUsd   current TVL (denominator; we use GeckoTerminal's for
 *                 consistency with the displayed TVL column).
 * @returns annualized fee APR as a fraction, or null if inputs are insufficient.
 */
export function feeAprFromFees(
  feesUsd: number,
  tvlUsd: number,
  days: number,
): number | null {
  if (tvlUsd <= 0 || days <= 0) return null;
  if (!Number.isFinite(feesUsd) || feesUsd < 0) return null;
  return (feesUsd / tvlUsd) * (DAYS_PER_YEAR / days);
}

/** Sum the first `n` daily volumes (newest-first array). Returns null if the
 * series is too short to cover the window. */
export function sumWindow(dailyVolumes: number[], n: number): number | null {
  if (dailyVolumes.length < n) return null;
  let total = 0;
  for (let i = 0; i < n; i++) total += dailyVolumes[i];
  return total;
}
