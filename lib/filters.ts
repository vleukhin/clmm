// Client-side filtering + sorting of the aggregated pool list, plus compact
// URL (query-string) serialization so a filtered view is shareable.

import type { BaseAsset, Pool, SortKey } from "./types";
import { DEFAULT_WIDTH, RANGE_WIDTHS, type RangeWidthKey } from "./netApr";

export interface FilterState {
  /** Selected network ids; empty = all. */
  networks: string[];
  /** Selected DEX families; empty = all. */
  families: string[];
  /** Selected base assets; empty = all. */
  baseAssets: BaseAsset[];
  /** Selected stablecoin symbols; empty = all. */
  stables: string[];
  /** Selected fee tiers (fractions); empty = all. */
  feeTiers: number[];
  minTvl: number | null;
  minVolume: number | null;
  /** Minimum volume/TVL as a percentage value (e.g. 20 = 20%). */
  minVolumeToTvlPct: number | null;
  search: string;
  /** Band width for the net range APR column/ranking (not a filter — a
   * simulation parameter persisted alongside the filters). */
  rangeWidth: RangeWidthKey;
}

export interface SortState {
  key: SortKey;
  dir: "asc" | "desc";
}

export const DEFAULT_FILTERS: FilterState = {
  networks: [],
  families: [],
  baseAssets: [],
  stables: [],
  feeTiers: [],
  minTvl: null,
  minVolume: null,
  minVolumeToTvlPct: null,
  search: "",
  rangeWidth: DEFAULT_WIDTH,
};

// The list is a ranking tool: default to net range APR (falls back to the
// server's Vol/TVL order — a stable sort — until the range data loads).
export const DEFAULT_SORT: SortState = { key: "netRangeApr", dir: "desc" };

export function applyFilters(
  pools: Pool[],
  f: FilterState,
  sort: SortState,
): Pool[] {
  const q = f.search.trim().toLowerCase();
  const minRatio =
    f.minVolumeToTvlPct != null ? f.minVolumeToTvlPct / 100 : null;

  const out = pools.filter((p) => {
    if (f.networks.length && !f.networks.includes(p.networkId)) return false;
    if (f.families.length && !f.families.includes(p.dexFamily)) return false;
    if (f.baseAssets.length && !f.baseAssets.includes(p.baseAsset)) return false;
    if (f.stables.length && !f.stables.includes(p.stableSymbol)) return false;
    if (f.feeTiers.length) {
      if (p.feeTier == null) return false;
      // Match on nearest tier to avoid float noise.
      const match = f.feeTiers.some((t) => Math.abs(t - p.feeTier!) < 1e-9);
      if (!match) return false;
    }
    if (f.minTvl != null && p.tvlUsd < f.minTvl) return false;
    if (f.minVolume != null && p.volume24hUsd < f.minVolume) return false;
    if (minRatio != null && p.volumeToTvl < minRatio) return false;
    if (q) {
      const hay = `${p.name} ${p.volatileSymbol} ${p.stableSymbol} ${p.dexName} ${p.networkName}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const dir = sort.dir === "asc" ? 1 : -1;
  out.sort((a, b) => {
    const av = sortValue(a, sort.key);
    const bv = sortValue(b, sort.key);
    // NaN/Infinity-safe: equal (incl. two missing sentinels) => 0, so JS's
    // stable sort preserves the incoming order (server's Vol/TVL ranking).
    const d = av < bv ? -1 : av > bv ? 1 : 0;
    return d * dir;
  });
  return out;
}

function sortValue(p: Pool, key: SortKey): number {
  switch (key) {
    case "tvlUsd":
      return p.tvlUsd;
    case "volume24hUsd":
      return p.volume24hUsd;
    case "volumeToTvl":
      return p.volumeToTvl;
    case "feeTier":
      return p.feeTier ?? -1;
    case "feeApr7d":
      return p.feeApr7d ?? -1;
    case "feeApr30d":
      return p.feeApr30d ?? -1;
    case "netRangeApr":
      // Missing sinks to the bottom regardless of direction handling above.
      return p.rangeApr?.netApr ?? -Infinity;
  }
}

// --- URL serialization -------------------------------------------------------

export function filtersToParams(
  f: FilterState,
  sort: SortState,
): URLSearchParams {
  const p = new URLSearchParams();
  if (f.networks.length) p.set("net", f.networks.join(","));
  if (f.families.length) p.set("dex", f.families.join(","));
  if (f.baseAssets.length) p.set("base", f.baseAssets.join(","));
  if (f.stables.length) p.set("stable", f.stables.join(","));
  if (f.feeTiers.length) p.set("fee", f.feeTiers.join(","));
  if (f.minTvl != null) p.set("mintvl", String(f.minTvl));
  if (f.minVolume != null) p.set("minvol", String(f.minVolume));
  if (f.minVolumeToTvlPct != null) p.set("minratio", String(f.minVolumeToTvlPct));
  if (f.search) p.set("q", f.search);
  if (f.rangeWidth !== DEFAULT_WIDTH) p.set("range", f.rangeWidth);
  if (sort.key !== DEFAULT_SORT.key) p.set("sort", sort.key);
  if (sort.dir !== DEFAULT_SORT.dir) p.set("dir", sort.dir);
  return p;
}

export function paramsToFilters(p: URLSearchParams): {
  filters: FilterState;
  sort: SortState;
} {
  const list = (key: string) =>
    p.get(key)?.split(",").filter(Boolean) ?? [];
  const numlist = (key: string) =>
    list(key).map(Number).filter((n) => Number.isFinite(n));
  const numOrNull = (key: string) => {
    const v = p.get(key);
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const filters: FilterState = {
    networks: list("net"),
    families: list("dex"),
    baseAssets: list("base").filter(
      (x): x is BaseAsset => x === "ETH" || x === "BTC",
    ),
    stables: list("stable"),
    feeTiers: numlist("fee"),
    minTvl: numOrNull("mintvl"),
    minVolume: numOrNull("minvol"),
    minVolumeToTvlPct: numOrNull("minratio"),
    search: p.get("q") ?? "",
    rangeWidth: RANGE_WIDTHS.some((w) => w.key === p.get("range"))
      ? (p.get("range") as RangeWidthKey)
      : DEFAULT_WIDTH,
  };

  const sortKey = p.get("sort");
  const validKeys: SortKey[] = [
    "tvlUsd",
    "volume24hUsd",
    "volumeToTvl",
    "feeTier",
    "feeApr7d",
    "feeApr30d",
    "netRangeApr",
  ];
  const sort: SortState = {
    key: validKeys.includes(sortKey as SortKey)
      ? (sortKey as SortKey)
      : DEFAULT_SORT.key,
    dir: p.get("dir") === "asc" ? "asc" : DEFAULT_SORT.dir,
  };

  return { filters, sort };
}
