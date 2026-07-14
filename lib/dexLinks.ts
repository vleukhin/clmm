// Build a link to a pool's page on the DEX's own front-end, so a Uniswap pool
// opens on Uniswap, a PancakeSwap pool on PancakeSwap, etc. Keyed by dexFamily
// (see lib/config.ts) + networkId + pool address. All URL formats were verified
// live 2026-07-14.
//
// Where the DEX exposes a reliable per-pool deep link keyed by the pool address
// we point straight at that pool (`exact: true`). A few front-ends have no
// address-addressable pool page, so we land on their pools page instead
// (`exact: false`) — still on-platform, just not pre-selected.

import type { Pool } from "./types";

/** Chain slug in app.uniswap.org/explore/pools/{slug}/{address}. */
const UNISWAP_CHAIN: Record<string, string> = {
  eth: "ethereum",
  bsc: "bnb",
  arbitrum: "arbitrum",
  base: "base",
  polygon_pos: "polygon",
};

/** Chain path segment in pancakeswap.finance/info/v3/{seg}pairs/{address}.
 * BNB Chain is the default and takes no segment. */
const PANCAKE_CHAIN: Record<string, string> = {
  bsc: "",
  eth: "ethereum/",
  arbitrum: "arbitrum/",
  base: "base/",
};

/** Chain slug in www.sushi.com/{slug}/pool/v3/{address}. */
const SUSHI_CHAIN: Record<string, string> = {
  eth: "ethereum",
  polygon_pos: "polygon",
};

export interface NativePoolLink {
  url: string;
  /** Platform label for the link text, e.g. "Uniswap". */
  label: string;
  /** True when the URL targets this exact pool; false when it only lands on the
   * DEX's pools page (no reliable per-pool deep link for that front-end). */
  exact: boolean;
}

/** Link to `pool` on its DEX's own site, or null if we have no mapping. */
export function nativePoolLink(pool: Pool): NativePoolLink | null {
  const addr = pool.address.toLowerCase();
  switch (pool.dexFamily) {
    case "Uniswap": {
      const chain = UNISWAP_CHAIN[pool.networkId];
      if (!chain) return null;
      return {
        url: `https://app.uniswap.org/explore/pools/${chain}/${addr}`,
        label: "Uniswap",
        exact: true,
      };
    }
    case "PancakeSwap": {
      const seg = PANCAKE_CHAIN[pool.networkId];
      if (seg == null) return null;
      return {
        url: `https://pancakeswap.finance/info/v3/${seg}pairs/${addr}`,
        label: "PancakeSwap",
        exact: true,
      };
    }
    case "SushiSwap": {
      const chain = SUSHI_CHAIN[pool.networkId];
      if (!chain) return null;
      return {
        url: `https://www.sushi.com/${chain}/pool/v3/${addr}`,
        label: "SushiSwap",
        exact: true,
      };
    }
    case "Camelot":
      // Camelot is Arbitrum-only; its info site addresses pools by address.
      return {
        url: `https://info.camelot.exchange/pair/arbitrum/v3/${addr}`,
        label: "Camelot",
        exact: true,
      };
    case "Aerodrome":
      // No address-addressable pool page; land on the liquidity list.
      return { url: "https://aerodrome.finance/liquidity", label: "Aerodrome", exact: false };
    case "THENA":
      return { url: "https://thena.fi/pools", label: "THENA", exact: false };
    case "QuickSwap":
      return { url: "https://quickswap.exchange/#/pools", label: "QuickSwap", exact: false };
    default:
      return null;
  }
}
