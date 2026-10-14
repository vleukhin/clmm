/** Helpers kept dependency-free so the filtering rules can be tested directly
 * with Node's native TypeScript runner. */
export function effectiveFeeTier(
  feeTier: number | null,
  feeTierActual: number | null | undefined,
): number | null {
  return feeTierActual ?? feeTier;
}

/** Compare optional net-APR values while always placing missing data last. */
export function compareNetRangeApr(
  a: number | null | undefined,
  b: number | null | undefined,
  dir: "asc" | "desc",
): number {
  const aMissing = a == null;
  const bMissing = b == null;
  if (aMissing || bMissing) return aMissing === bMissing ? 0 : aMissing ? 1 : -1;
  const order = a < b ? -1 : a > b ? 1 : 0;
  return dir === "asc" ? order : -order;
}
