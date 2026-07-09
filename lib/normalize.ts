// Turn a raw GeckoTerminal pool into our domain Pool, enforcing the
// "one side ETH/BTC, other side a stablecoin" rule. Returns null if the pool
// does not qualify.

import type { DexConfig, NetworkConfig } from "./config";
import { addressFromTokenId, type RawPool } from "./geckoterminal";
import type { Pool } from "./types";

/** Parse a trailing fee percentage from a pool name, e.g. "... 0.05%" -> 0.0005. */
export function parseFeeTier(name: string): number | null {
  const m = name.match(/([\d.]+)\s*%\s*$/);
  if (!m) return null;
  const pct = parseFloat(m[1]);
  return Number.isFinite(pct) ? pct / 100 : null;
}

/** Fee tier from the pool name, falling back to `pool_fee_percentage` (a
 * percentage like "0.01") for pools whose name has no trailing "%". */
function resolveFeeTier(
  name: string,
  poolFeePercentage: string | null | undefined,
): number | null {
  const fromName = parseFeeTier(name);
  if (fromName != null) return fromName;
  if (poolFeePercentage != null) {
    const pct = parseFloat(poolFeePercentage);
    if (Number.isFinite(pct)) return pct / 100;
  }
  return null;
}

function num(v: string | null | undefined): number {
  const n = v == null ? NaN : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

export function normalizePool(
  raw: RawPool,
  network: NetworkConfig,
  dex: DexConfig,
): Pool | null {
  const baseAddr = addressFromTokenId(raw.relationships?.base_token?.data?.id);
  const quoteAddr = addressFromTokenId(raw.relationships?.quote_token?.data?.id);
  if (!baseAddr || !quoteAddr) return null;

  // Determine which side is the volatile (ETH/BTC) token and which is the stable.
  const baseVol = network.volatile[baseAddr];
  const quoteVol = network.volatile[quoteAddr];
  const baseStable = network.stables[baseAddr];
  const quoteStable = network.stables[quoteAddr];

  let volatile: { asset: "ETH" | "BTC"; symbol: string };
  let stableSymbol: string;
  let volatileIsBase: boolean;
  if (baseVol && quoteStable) {
    volatile = baseVol;
    stableSymbol = quoteStable;
    volatileIsBase = true;
  } else if (quoteVol && baseStable) {
    volatile = quoteVol;
    stableSymbol = baseStable;
    volatileIsBase = false;
  } else {
    return null; // not an ETH/BTC <-> stable pair
  }

  const tvlUsd = num(raw.attributes.reserve_in_usd);
  const volume24hUsd = num(raw.attributes.volume_usd?.h24);
  const priceChangeRaw = raw.attributes.price_change_percentage?.h24;
  const tx = raw.attributes.transactions?.h24;

  return {
    id: raw.id,
    address: raw.attributes.address,
    name: raw.attributes.name,
    networkId: network.id,
    networkName: network.name,
    dexId: dex.id,
    dexName: dex.name,
    dexFamily: dex.family,
    baseAsset: volatile.asset,
    volatileSymbol: volatile.symbol,
    stableSymbol,
    volatileIsBase,
    feeTier: resolveFeeTier(
      raw.attributes.name,
      raw.attributes.pool_fee_percentage,
    ),
    tvlUsd,
    volume24hUsd,
    volumeToTvl: tvlUsd > 0 ? volume24hUsd / tvlUsd : 0,
    priceChange24h: priceChangeRaw != null ? num(priceChangeRaw) : null,
    txCount24h: tx ? (tx.buys ?? 0) + (tx.sells ?? 0) : null,
    createdAt: raw.attributes.pool_created_at,
    url: `https://www.geckoterminal.com/${network.id}/pools/${raw.attributes.address}`,
  };
}
