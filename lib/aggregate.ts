// Aggregate the full universe of ETH/BTC <-> stablecoin CLMM pools across all
// configured networks and DEXes. Result is cached by the Next.js data layer
// (each underlying fetch uses `revalidate: 60`), so filtering/sorting is done
// cheaply on the client from this single payload.

import { MAX_APR_POOLS, NETWORKS, PAGES_PER_DEX } from "./config";
import { computeFeeApr, sumWindow } from "./apr";
import { fetchDailyVolumes, fetchPoolsPage } from "./geckoterminal";
import { normalizePool } from "./normalize";
import type { Pool, PoolApr, PoolAprResponse, PoolsResponse } from "./types";

export async function getAllPools(): Promise<PoolsResponse> {
  const warnings: string[] = [];

  // Build the list of (network, dex, page) fetch tasks.
  const tasks: Promise<Pool[]>[] = [];
  for (const network of NETWORKS) {
    for (const dex of network.dexes) {
      for (let page = 1; page <= PAGES_PER_DEX; page++) {
        tasks.push(
          fetchPoolsPage(network.id, dex.id, page, warnings).then((raws) =>
            raws
              .map((raw) => normalizePool(raw, network, dex))
              .filter((p): p is Pool => p !== null),
          ),
        );
      }
    }
  }

  const results = await Promise.all(tasks);

  // Flatten + de-duplicate by pool id (a pool can appear on multiple pages).
  const byId = new Map<string, Pool>();
  for (const pools of results) {
    for (const pool of pools) {
      const existing = byId.get(pool.id);
      if (!existing || pool.tvlUsd > existing.tvlUsd) byId.set(pool.id, pool);
    }
  }

  const pools = Array.from(byId.values()).sort(
    (a, b) => b.volumeToTvl - a.volumeToTvl,
  );

  return {
    pools,
    generatedAt: new Date().toISOString(),
    warnings,
  };
}

/**
 * Enrich pools with 7d/30d fee APR from daily OHLCV. One OHLCV request per pool,
 * so only the top `MAX_APR_POOLS` by TVL are enriched; the underlying fetches are
 * cached for 30 min. Returns a map keyed by pool id.
 */
export async function getPoolApr(): Promise<PoolAprResponse> {
  const warnings: string[] = [];
  const { pools } = await getAllPools();

  const targets = [...pools]
    .sort((a, b) => b.tvlUsd - a.tvlUsd)
    .slice(0, MAX_APR_POOLS);

  const entries = await Promise.all(
    targets.map(async (pool): Promise<[string, PoolApr]> => {
      const daily = await fetchDailyVolumes(pool.networkId, pool.address, warnings);
      const vol7d = sumWindow(daily, 7);
      const vol30d = sumWindow(daily, 30);
      return [
        pool.id,
        {
          feeApr7d:
            vol7d != null
              ? computeFeeApr(vol7d, pool.tvlUsd, pool.feeTier, 7)
              : null,
          feeApr30d:
            vol30d != null
              ? computeFeeApr(vol30d, pool.tvlUsd, pool.feeTier, 30)
              : null,
        },
      ];
    }),
  );

  return {
    aprById: Object.fromEntries(entries),
    generatedAt: new Date().toISOString(),
    warnings,
  };
}
