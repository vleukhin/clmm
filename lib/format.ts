// Compact formatting helpers for USD amounts, percentages and ratios.

export function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "$0";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

export function formatPercent(n: number | null, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n.toFixed(digits)}%`;
}

/** volumeToTvl is a raw ratio (0.5 = 50%). Show it as a percentage. */
export function formatRatio(ratio: number): string {
  if (!Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(1)}%`;
}

/** Fee APR is a fraction (0.25 = 25%). */
export function formatApr(apr: number | null | undefined): string {
  if (apr == null || !Number.isFinite(apr)) return "—";
  const pct = apr * 100;
  const abs = Math.abs(pct);
  if (abs >= 1000) return `${Math.round(pct).toLocaleString("en-US")}%`;
  return `${pct.toFixed(abs < 10 ? 1 : 0)}%`;
}

export function formatFeeTier(fee: number | null): string {
  if (fee == null) return "—";
  return `${(fee * 100).toFixed(fee < 0.001 ? 2 : fee < 0.01 ? 2 : 1)}%`;
}

/** USD price with sensible precision across magnitudes (BTC ~$100K, ETH ~$1.7K,
 * sub-$1 alt prices). Used for chart axes/tooltips and range inputs. */
export function formatPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 100_000) return `$${(n / 1000).toFixed(1)}K`;
  if (abs >= 1_000) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (abs >= 10) return `$${n.toFixed(2)}`;
  if (abs >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toPrecision(3)}`;
}

export function formatCount(n: number | null): string {
  if (n == null) return "—";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return `${n}`;
}
