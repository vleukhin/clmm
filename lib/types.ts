// Domain types for the CLMM pool analytics app.

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
  /** Fee tier as a fraction, e.g. 0.0005 for 0.05%. Null if unknown. */
  feeTier: number | null;
  /** Total value locked, USD. */
  tvlUsd: number;
  /** 24h trading volume, USD. */
  volume24hUsd: number;
  /** volume24h / tvl. 0 if tvl is 0. */
  volumeToTvl: number;
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
  | "feeTier";
