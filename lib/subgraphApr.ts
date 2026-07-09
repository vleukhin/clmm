// uniswap-v3 schema adapter over a subgraph's PoolDayData. One batched query
// per subgraph gives daily fees AND daily close price for many pools at once —
// far cheaper than per-pool OHLCV. `fetchSubgraphDaily` is the shared primitive;
// `fetchSubgraphApr` derives 7d/30d fee APR from it.

import { NETWORKS_BY_ID } from "./config";
import { feeAprFromFees } from "./apr";
import { querySubgraph } from "./subgraph";
import type { Pool, PoolApr } from "./types";

const DAY = 86_400;
/** Days of history to pull — covers the 30d APR window and the range backtest. */
const WINDOW_DAYS = 91;

// Newest-first daily rows. `close` is token0Price at day end; orientation is
// pool-native, which is fine for relative-range math (see lib/netApr.ts).
// NOTE: querySubgraph caches by (subgraphId, variables) only, NOT query text —
// every caller must use THIS exact query so the cache never returns a payload
// missing `close`.
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
      close
    }
  }
`;

interface RawPoolDayData {
  pool: { id: string };
  date: number;
  feesUSD: string;
  close: string;
}

/** One day of pool data, newest-first within a pool's array. */
export interface SubgraphDailyRow {
  date: number;
  feesUSD: number;
  close: number;
}

function sumFirst(nums: number[], n: number): number | null {
  if (nums.length < n) return null;
  let t = 0;
  for (let i = 0; i < n; i++) t += nums[i];
  return t;
}

/**
 * Fetch daily {feesUSD, close} rows (newest-first) for every pool whose DEX has
 * a subgraph configured, keyed by pool id. Pools with no returned data are
 * omitted (callers fall back to OHLCV). One batched request per subgraph.
 */
export async function fetchSubgraphDaily(
  pools: Pool[],
  warnings: string[],
): Promise<Map<string, SubgraphDailyRow[]>> {
  const bySubgraph = new Map<string, Pool[]>();
  for (const pool of pools) {
    const dex = NETWORKS_BY_ID[pool.networkId]?.dexes.find(
      (d) => d.id === pool.dexId,
    );
    const id = dex?.subgraph?.id;
    if (!id) continue;
    (bySubgraph.get(id) ?? bySubgraph.set(id, []).get(id)!).push(pool);
  }

  const result = new Map<string, SubgraphDailyRow[]>();
  const since = (Math.floor(Date.now() / 1000 / DAY) - WINDOW_DAYS) * DAY;

  await Promise.all(
    [...bySubgraph.entries()].map(async ([subgraphId, group]) => {
      // Subgraph pool ids are lowercased addresses.
      const addrToPool = new Map(group.map((p) => [p.address.toLowerCase(), p]));
      const ids = [...addrToPool.keys()];

      const data = await querySubgraph<{ poolDayDatas: RawPoolDayData[] }>(
        subgraphId,
        POOL_DAY_QUERY,
        { ids, since },
        warnings,
      );
      if (!data) return;

      const rowsByAddr = new Map<string, SubgraphDailyRow[]>();
      for (const row of data.poolDayDatas) {
        const arr = rowsByAddr.get(row.pool.id) ?? [];
        arr.push({
          date: row.date,
          feesUSD: Number(row.feesUSD) || 0,
          close: Number(row.close) || 0,
        });
        rowsByAddr.set(row.pool.id, arr);
      }

      for (const [addr, pool] of addrToPool) {
        const rows = rowsByAddr.get(addr);
        if (rows && rows.length > 0) result.set(pool.id, rows);
      }
    }),
  );

  return result;
}

/**
 * Real-fee 7d/30d APR per pool (keyed by pool id), derived from the shared
 * daily rows. Only pools with subgraph data are included.
 */
export async function fetchSubgraphApr(
  pools: Pool[],
  warnings: string[],
): Promise<Map<string, PoolApr>> {
  const daily = await fetchSubgraphDaily(pools, warnings);
  const poolById = new Map(pools.map((p) => [p.id, p]));

  const result = new Map<string, PoolApr>();
  for (const [poolId, rows] of daily) {
    const pool = poolById.get(poolId);
    if (!pool) continue;
    const fees = rows.map((r) => r.feesUSD); // newest-first
    const f7 = sumFirst(fees, 7);
    const f30 = sumFirst(fees, 30);
    result.set(poolId, {
      feeApr7d: f7 != null ? feeAprFromFees(f7, pool.tvlUsd, 7) : null,
      feeApr30d: f30 != null ? feeAprFromFees(f30, pool.tvlUsd, 30) : null,
      source: "fees",
    });
  }
  return result;
}
