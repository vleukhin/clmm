// Aggregate the full universe of ETH/BTC <-> stablecoin CLMM pools across all
// configured networks and DEXes. Result is cached by the Next.js data layer
// (each underlying fetch uses `revalidate: 60`), so filtering/sorting is done
// cheaply on the client from this single payload.

import { NETWORKS, PAGES_PER_DEX } from "./config";
import { fetchPoolsPage } from "./geckoterminal";
import { normalizePool } from "./normalize";
import type { Pool, PoolsResponse } from "./types";

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
