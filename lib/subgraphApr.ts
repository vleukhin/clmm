// uniswap-v3 schema adapter: compute real 7d/30d fee APR from a subgraph's
// PoolDayData.feesUSD. Pools are grouped by subgraph and fetched in one batch
// query each, so this scales far better than per-pool OHLCV.

import { NETWORKS_BY_ID } from "./config";
import { feeAprFromFees } from "./apr";
import { querySubgraph } from "./subgraph";
import type { Pool, PoolApr } from "./types";

const DAY = 86_400;

// Newest-first daily fees; sum the first N for the window.
const POOL_DAY_QUERY = `
  query($ids: [String!]!, $since: Int!) {
    poolDayDatas(
      first: 1000
      where: { pool_in: $ids, date_gte: $since }
      orderBy: date
      orderDirection: desc
    ) {
      pool { id }
      date
      feesUSD
    }
  }
`;

interface PoolDayData {
  pool: { id: string };
  date: number;
  feesUSD: string;
}

function sumFirst(nums: number[], n: number): number | null {
  if (nums.length < n) return null;
  let t = 0;
  for (let i = 0; i < n; i++) t += nums[i];
  return t;
}

/**
 * Returns real-fee APR for the given pools, keyed by pool id. Only pools whose
 * DEX has a `subgraph` config and that actually return day data are included;
 * everything else is left out (caller falls back to the OHLCV estimate).
 */
export async function fetchSubgraphApr(
  pools: Pool[],
  warnings: string[],
): Promise<Map<string, PoolApr>> {
  // Group pools by subgraph id; remember each pool's address -> pool.
  const bySubgraph = new Map<string, Pool[]>();
  for (const pool of pools) {
    const dex = NETWORKS_BY_ID[pool.networkId]?.dexes.find(
      (d) => d.id === pool.dexId,
    );
    const id = dex?.subgraph?.id;
    if (!id) continue;
    (bySubgraph.get(id) ?? bySubgraph.set(id, []).get(id)!).push(pool);
  }

  const result = new Map<string, PoolApr>();
  const since = (Math.floor(Date.now() / 1000 / DAY) - 31) * DAY;

  await Promise.all(
    [...bySubgraph.entries()].map(async ([subgraphId, group]) => {
      // Subgraph pool ids are lowercased addresses.
      const addrToPool = new Map(group.map((p) => [p.address.toLowerCase(), p]));
      const ids = [...addrToPool.keys()];

      const data = await querySubgraph<{ poolDayDatas: PoolDayData[] }>(
        subgraphId,
        POOL_DAY_QUERY,
        { ids, since },
        warnings,
      );
      if (!data) return;

      // Bucket daily fees per pool (already newest-first from the query).
      const feesByPool = new Map<string, number[]>();
      for (const row of data.poolDayDatas) {
        const arr = feesByPool.get(row.pool.id) ?? [];
        arr.push(Number(row.feesUSD) || 0);
        feesByPool.set(row.pool.id, arr);
      }

      for (const [addr, pool] of addrToPool) {
        const fees = feesByPool.get(addr);
        if (!fees) continue; // no data -> caller falls back
        const f7 = sumFirst(fees, 7);
        const f30 = sumFirst(fees, 30);
        result.set(pool.id, {
          feeApr7d: f7 != null ? feeAprFromFees(f7, pool.tvlUsd, 7) : null,
          feeApr30d: f30 != null ? feeAprFromFees(f30, pool.tvlUsd, 30) : null,
          source: "fees",
        });
      }
    }),
  );

  return result;
}
