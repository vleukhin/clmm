// Aggregate the full universe of ETH/BTC <-> stablecoin CLMM pools across all
// configured networks and DEXes. Result is cached by the Next.js data layer
// (each underlying fetch uses `revalidate: 60`), so filtering/sorting is done
// cheaply on the client from this single payload.

import { MAX_APR_POOLS, NETWORKS, NETWORKS_BY_ID, PAGES_PER_DEX } from "./config";
import { computeFeeApr, sumWindow } from "./apr";
import { fetchDailyVolumes, fetchPoolsPage } from "./geckoterminal";
import { normalizePool } from "./normalize";
import { fetchPoolFees } from "./onchainFees";
import { fetchSubgraphApr } from "./subgraphApr";
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

  await enrichDynamicFees(pools, warnings);

  return {
    pools,
    generatedAt: new Date().toISOString(),
    warnings,
  };
}

/**
 * Fill `feeTierActual` for pools of dynamic-fee DEXes (Aerodrome Slipstream)
 * from the live on-chain `fee()` — the nominal tier in the pool name can be
 * wildly off (a "1%" pool charging 0.037%). One Multicall3 request per network,
 * memoized 30 min inside fetchPoolFees.
 */
async function enrichDynamicFees(pools: Pool[], warnings: string[]): Promise<void> {
  const byRpc = new Map<string, Pool[]>();
  for (const pool of pools) {
    const network = NETWORKS_BY_ID[pool.networkId];
    const dex = network?.dexes.find((d) => d.id === pool.dexId);
    if (!dex?.dynamicFees || !network?.rpcUrl) continue;
    const rpc = network.rpcUrl;
    (byRpc.get(rpc) ?? byRpc.set(rpc, []).get(rpc)!).push(pool);
  }

  await Promise.all(
    [...byRpc.entries()].map(async ([rpcUrl, group]) => {
      const fees = await fetchPoolFees(
        rpcUrl,
        group.map((p) => p.address.toLowerCase()),
        warnings,
      );
      for (const pool of group) {
        pool.feeTierActual = fees.get(pool.address.toLowerCase())?.fee ?? null;
      }
    }),
  );
}

function hasSubgraph(pool: Pool): boolean {
  const dex = NETWORKS_BY_ID[pool.networkId]?.dexes.find(
    (d) => d.id === pool.dexId,
  );
  return Boolean(dex?.subgraph);
}

/**
 * Enrich pools with 7d/30d fee APR. Pools whose DEX has a subgraph get real
 * accrued fees (batched, uncapped). Everything else — including subgraph pools
 * that returned no data or when THEGRAPH_API_KEY is unset — falls back to the
 * OHLCV volume estimate, capped to the top `MAX_APR_POOLS` by TVL to bound
 * per-pool requests. Returns a map keyed by pool id.
 */
export async function getPoolApr(): Promise<PoolAprResponse> {
  const warnings: string[] = [];
  const { pools } = await getAllPools();

  // 1) Real fees via subgraph for pools whose DEX has one configured.
  const subgraphPools = pools.filter(hasSubgraph);
  const subgraphApr = await fetchSubgraphApr(subgraphPools, warnings);

  // 2) OHLCV estimate for the rest (and any subgraph pool without data / no key),
  //    capped by TVL so we don't blow the GeckoTerminal rate limit.
  const fallbackTargets = pools
    .filter((p) => !subgraphApr.has(p.id))
    .sort((a, b) => b.tvlUsd - a.tvlUsd)
    .slice(0, MAX_APR_POOLS);

  const fallbackEntries = await Promise.all(
    fallbackTargets.map(async (pool): Promise<[string, PoolApr]> => {
      const daily = await fetchDailyVolumes(pool.networkId, pool.address, warnings);
      const vol7d = sumWindow(daily, 7);
      const vol30d = sumWindow(daily, 30);
      return [
        pool.id,
        {
          feeApr7d:
            vol7d != null
              ? computeFeeApr(vol7d, pool.tvlUsd, pool.feeTierActual ?? pool.feeTier, 7)
              : null,
          feeApr30d:
            vol30d != null
              ? computeFeeApr(vol30d, pool.tvlUsd, pool.feeTierActual ?? pool.feeTier, 30)
              : null,
          source: "estimate",
        },
      ];
    }),
  );

  const aprById: Record<string, PoolApr> = Object.fromEntries(fallbackEntries);
  for (const [id, apr] of subgraphApr) aprById[id] = apr;

  return {
    aprById,
    generatedAt: new Date().toISOString(),
    warnings,
  };
}
