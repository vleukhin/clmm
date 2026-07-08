// Static configuration: networks, CLMM DEX allowlist, and the ETH/BTC + stablecoin
// token addresses we care about. GeckoTerminal returns token addresses lowercased
// inside relationships, so every address here is stored lowercased for matching.

import type { BaseAsset } from "./types";

/** Subgraph schema families we have an adapter for. Only "uniswap-v3" today
 * (covers Uniswap v3 and its forks: PancakeSwap v3, SushiSwap v3). */
export type SubgraphSchema = "uniswap-v3";

export interface DexConfig {
  /** GeckoTerminal dex id, e.g. "uniswap_v3". */
  id: string;
  /** Short display name, e.g. "Uniswap V3". */
  name: string;
  /** Family used for grouping across chains, e.g. "Uniswap". */
  family: string;
  /** The Graph subgraph for real fee data. Absent => APR falls back to the
   * OHLCV volume estimate. Fill `id` from Graph Explorer per (chain, dex). */
  subgraph?: { id: string; schema: SubgraphSchema };
}

export interface NetworkConfig {
  /** GeckoTerminal network id, e.g. "eth". */
  id: string;
  name: string;
  /** CLMM (concentrated-liquidity) DEXes to scan on this network. */
  dexes: DexConfig[];
  /** Volatile (ETH/BTC) tokens: address -> {asset, symbol}. */
  volatile: Record<string, { asset: BaseAsset; symbol: string }>;
  /** Stablecoin tokens: address -> symbol. */
  stables: Record<string, string>;
}

/** Helper to build a lowercased address map. */
function lc<T>(entries: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(entries).map(([k, v]) => [k.toLowerCase(), v]),
  );
}

// Every `subgraph.id` below was verified live (2026-07-08): active indexer,
// uniswap-v3 schema (poolDayDatas.feesUSD), rows for our pool addresses, data
// fresh same-day. Re-verify the same way before adding new ids.
// Still WITHOUT a working subgraph (fall back to OHLCV estimate):
//   bsc/pancakeswap-v3-bsc  — A1fvJWQLBeUAggX2WQTMm3FKjXTekNXo77ZySun4YN2m exists
//     but gateway returned "bad indexers" (retry later);
//     Hv1GncLY5docZoGtXjo4kwbTvxm3MAhVZqBZE4sUT9eZ has the schema but 0 rows
//     for our BSC pools (wrong chain/deployment)
//   bsc/uniswap-bsc, bsc/thena-fusion (Algebra), arbitrum/pancakeswap-v3-arbitrum,
//   arbitrum/camelot-v3 (Algebra), base/pancakeswap-v3-base,
//   base/aerodrome-slipstream (own schema), polygon_pos/quickswap_v3 (Algebra),
//   polygon_pos/sushiswap-v3-polygon
export const NETWORKS: NetworkConfig[] = [
  {
    id: "eth",
    name: "Ethereum",
    dexes: [
      {
        id: "uniswap_v3",
        name: "Uniswap V3",
        family: "Uniswap",
        // Confirmed Uniswap v3 Ethereum mainnet subgraph.
        subgraph: { id: "5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV", schema: "uniswap-v3" },
      },
      {
        id: "pancakeswap-v3-ethereum",
        name: "PancakeSwap V3",
        family: "PancakeSwap",
        subgraph: { id: "CJYGNhb7RvnhfBDjqpRnD3oxgyhibzc7fkAMa38YV3oS", schema: "uniswap-v3" },
      },
      {
        id: "sushiswap-v3-ethereum",
        name: "SushiSwap V3",
        family: "SushiSwap",
        subgraph: { id: "5nnoU1nUFeWqtXgbpC54L9PWdpgo7Y9HYinR3uTMsfzs", schema: "uniswap-v3" },
      },
    ],
    volatile: lc({
      "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2": { asset: "ETH", symbol: "WETH" },
      "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599": { asset: "BTC", symbol: "WBTC" },
      "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf": { asset: "BTC", symbol: "cbBTC" },
      "0x18084fbA666a33d37592fA2633fD49a74DD93a88": { asset: "BTC", symbol: "tBTC" },
    }),
    stables: lc({
      "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": "USDC",
      "0xdAC17F958D2ee523a2206206994597C13D831ec7": "USDT",
      "0x6B175474E89094C44Da98b954EedeAC495271d0F": "DAI",
      "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3": "USDe",
      "0xdC035D45d973E3EC169d2276DDab16f1e407384F": "USDS",
    }),
  },
  {
    id: "bsc",
    name: "BNB Chain",
    dexes: [
      { id: "pancakeswap-v3-bsc", name: "PancakeSwap V3", family: "PancakeSwap" },
      { id: "uniswap-bsc", name: "Uniswap V3", family: "Uniswap" },
      { id: "thena-fusion", name: "THENA Fusion", family: "THENA" },
    ],
    volatile: lc({
      "0x2170Ed0880ac9A755fd29B2688956BD959F933F8": { asset: "ETH", symbol: "ETH" },
      "0x7130d2A12B9BCBFAe4f2634d864A1Ee1Ce3Ead9c": { asset: "BTC", symbol: "BTCB" },
    }),
    stables: lc({
      "0x55d398326f99059fF775485246999027B3197955": "USDT",
      "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d": "USDC",
      "0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409": "FDUSD",
      "0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3": "DAI",
    }),
  },
  {
    id: "arbitrum",
    name: "Arbitrum",
    dexes: [
      {
        id: "uniswap_v3_arbitrum",
        name: "Uniswap V3",
        family: "Uniswap",
        subgraph: { id: "FbCGRftH4a3yZugY7TnbYgPJVEv2LvMT6oF1fxPe9aJM", schema: "uniswap-v3" },
      },
      { id: "pancakeswap-v3-arbitrum", name: "PancakeSwap V3", family: "PancakeSwap" },
      { id: "camelot-v3", name: "Camelot V3", family: "Camelot" },
    ],
    volatile: lc({
      "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1": { asset: "ETH", symbol: "WETH" },
      "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f": { asset: "BTC", symbol: "WBTC" },
    }),
    stables: lc({
      "0xaf88d065e77c8cC2239327C5EDb3A432268e5831": "USDC",
      "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8": "USDC.e",
      "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9": "USDT",
      "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1": "DAI",
    }),
  },
  {
    id: "base",
    name: "Base",
    dexes: [
      {
        id: "uniswap-v3-base",
        name: "Uniswap V3",
        family: "Uniswap",
        subgraph: { id: "43Hwfi3dJSoGpyas9VwNoDAv55yjgGrPpNSmbQZArzMG", schema: "uniswap-v3" },
      },
      { id: "aerodrome-slipstream", name: "Aerodrome Slipstream", family: "Aerodrome" },
      { id: "pancakeswap-v3-base", name: "PancakeSwap V3", family: "PancakeSwap" },
    ],
    volatile: lc({
      "0x4200000000000000000000000000000000000006": { asset: "ETH", symbol: "WETH" },
      "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf": { asset: "BTC", symbol: "cbBTC" },
    }),
    stables: lc({
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913": "USDC",
      "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA": "USDbC",
      "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb": "DAI",
    }),
  },
  {
    id: "polygon_pos",
    name: "Polygon",
    dexes: [
      {
        id: "uniswap_v3_polygon_pos",
        name: "Uniswap V3",
        family: "Uniswap",
        subgraph: { id: "3hCPRGf4z88VC5rsBKU5AA9FBBq5nF3jbKJG7VZCbhjm", schema: "uniswap-v3" },
      },
      { id: "quickswap_v3", name: "QuickSwap V3", family: "QuickSwap" },
      { id: "sushiswap-v3-polygon", name: "SushiSwap V3", family: "SushiSwap" },
    ],
    volatile: lc({
      "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619": { asset: "ETH", symbol: "WETH" },
      "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6": { asset: "BTC", symbol: "WBTC" },
    }),
    stables: lc({
      "0x3c499c542cEF5E3811e1192ce70d8cc03d5c3359": "USDC",
      "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174": "USDC.e",
      "0xc2132D05D31c914a87C6611C10748AEb04B58e8F": "USDT",
      "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063": "DAI",
    }),
  },
];

export const NETWORKS_BY_ID: Record<string, NetworkConfig> = Object.fromEntries(
  NETWORKS.map((n) => [n.id, n]),
);

/** All distinct DEX families for the filter UI. */
export const DEX_FAMILIES: string[] = Array.from(
  new Set(NETWORKS.flatMap((n) => n.dexes.map((d) => d.family))),
).sort();

/** All distinct stablecoin symbols for the filter UI. */
export const STABLE_SYMBOLS: string[] = Array.from(
  new Set(NETWORKS.flatMap((n) => Object.values(n.stables))),
).sort();

/** Standard CLMM fee tiers (as fractions) for the filter UI. */
export const FEE_TIERS: { value: number; label: string }[] = [
  { value: 0.0001, label: "0.01%" },
  { value: 0.0005, label: "0.05%" },
  { value: 0.0025, label: "0.25%" },
  { value: 0.003, label: "0.3%" },
  { value: 0.01, label: "1%" },
];

export const GECKOTERMINAL_API = "https://api.geckoterminal.com/api/v2";

/** How many pages of pools to fetch per (network, dex). 20 pools per page.
 * Page 1 (top by 24h volume) already contains the major ETH/BTC-stable pools,
 * so 1 page keeps us well under the free-tier rate limit. */
export const PAGES_PER_DEX = 1;

/** Cap on how many pools (top by TVL) get OHLCV-based 7d/30d APR enrichment.
 * Each enriched pool costs one OHLCV request (free-tier ~30 req/min), so this
 * bounds the cold-load cost. Lower-TVL pools show "—" for APR. */
export const MAX_APR_POOLS = 30;
