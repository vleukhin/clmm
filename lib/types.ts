// Domain types for the CLMM pool analytics app.

import type { RangeAprPoint, RangeWidthKey } from "./netApr";

export type BaseAsset = "ETH" | "BTC";

/** A normalized CLMM pool ready for display. */
export interface Pool {
  /** Unique id: `${networkId}_${address}` (GeckoTerminal style). */
  id: string;
  address: string;
  /** e.g. "USDC / WETH 0.01%" */
  name: string;
  networkId: string;
  networkName: string;
  dexId: string;
  dexName: string;
  /** Cross-chain grouping, e.g. "Uniswap V3" -> "Uniswap". */
  dexFamily: string;
  /** Which side is the volatile asset. */
  baseAsset: BaseAsset;
  /** Symbol of the volatile token, e.g. "WETH", "WBTC". */
  volatileSymbol: string;
  /** Symbol of the stablecoin, e.g. "USDC". */
  stableSymbol: string;
  /** Whether the volatile token is GeckoTerminal's "base" side of the pool.
   * Needed to request OHLCV history for the right token (?token=base|quote). */
  volatileIsBase: boolean;
  /** Fee tier as a fraction, e.g. 0.0005 for 0.05%. Null if unknown. */
  feeTier: number | null;
  /** Total value locked, USD. */
  tvlUsd: number;
  /** 24h trading volume, USD. */
  volume24hUsd: number;
  /** volume24h / tvl. 0 if tvl is 0. */
  volumeToTvl: number;
  /** Fee APR from 7d volume, as a fraction (0.25 = 25%). Merged in client-side
   * from the /api/pools/apr enrichment; undefined until that resolves. */
  feeApr7d?: number | null;
  /** Fee APR from 30d volume, as a fraction. */
  feeApr30d?: number | null;
  /** Source of the APR figures: real subgraph fees vs OHLCV estimate. */
  aprSource?: "fees" | "estimate";
  /** Net range APR for the currently selected band width, merged client-side
   * from /api/pools/range-apr. undefined until that resolves. */
  rangeApr?: RangeAprPoint | null;
  rangeAprSource?: "fees" | "estimate";
  /** Daily samples behind the range backtest (for the tooltip). */
  rangeAprDays?: number;
  /** 24h price change of base token, percent. */
  priceChange24h: number | null;
  /** 24h transaction count. */
  txCount24h: number | null;
  createdAt: string | null;
  /** External link to the pool page. */
  url: string;
}

export interface PoolsResponse {
  pools: Pool[];
  /** ISO timestamp the data was assembled. */
  generatedAt: string;
  /** Non-fatal warnings (e.g. a network/dex fetch failed). */
  warnings: string[];
}

export interface PoolsFilters {
  networks: string[];
  dexes: string[];
  baseAssets: BaseAsset[];
  stables: string[];
  feeTiers: number[];
  minTvl: number | null;
  minVolume: number | null;
  minVolumeToTvl: number | null;
  search: string;
  sortBy: SortKey;
  sortDir: "asc" | "desc";
}

export type SortKey =
  | "tvlUsd"
  | "volume24hUsd"
  | "volumeToTvl"
  | "feeTier"
  | "feeApr7d"
  | "feeApr30d"
  | "netRangeApr";

/** Per-pool fee APR enrichment returned by /api/pools/apr, keyed by pool id. */
export interface PoolApr {
  feeApr7d: number | null;
  feeApr30d: number | null;
  /** Where the APR came from: "fees" = real subgraph feesUSD; "estimate" =
   * volume × feeTier from OHLCV (approximate). */
  source?: "fees" | "estimate";
}

export interface PoolAprResponse {
  aprById: Record<string, PoolApr>;
  generatedAt: string;
  warnings: string[];
}

/** Net range APR for every preset band width, per pool (from /api/pools/range-apr). */
export interface PoolRangeApr {
  widths: Record<RangeWidthKey, RangeAprPoint | null>;
  source: "fees" | "estimate";
  /** Daily samples the backtest used. */
  days: number;
}

export interface PoolRangeAprResponse {
  byId: Record<string, PoolRangeApr>;
  generatedAt: string;
  warnings: string[];
}
