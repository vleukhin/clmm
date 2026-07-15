// uniswap-v3 schema adapter over a subgraph's PoolDayData. One batched query
// per subgraph gives daily fees AND daily close price for many pools at once —
// far cheaper than per-pool OHLCV. `fetchSubgraphDaily` is the shared primitive;
// `fetchSubgraphApr` derives 7d/30d fee APR from it.

import { NETWORKS_BY_ID } from "./config";
import { feeAprFromFees } from "./apr";
import { fetchPoolFees } from "./onchainFees";
import { querySubgraph } from "./subgraph";
import type { Pool, PoolApr } from "./types";

const DAY = 86_400;
/** Days of history to pull — covers the 30d APR window and the range backtest. */
const WINDOW_DAYS = 91;

// Newest-first daily rows plus the pool's current in-range liquidity + decimals
// (for the liquidity-share APR model). `close` is token0Price at day end;
// orientation is pool-native, which is fine for relative-range math (netApr.ts).
// `volumeUSD` is needed to recompute fees for dynamic-fee DEXes (see
// applyDynamicFees below). querySubgraph keys its cache on the query text, so
// shape changes here never collide with stale cached payloads.
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
      volumeUSD
      close
    }
    pools(first: 1000, where: { id_in: $ids }) {
      id
      liquidity
      token0 { decimals }
      token1 { decimals }
    }
  }
`;

interface RawPoolDayData {
  pool: { id: string };
  date: number;
  feesUSD: string;
  volumeUSD: string;
  close: string;
}

interface RawPoolMeta {
  id: string;
  liquidity: string;
  token0: { decimals: string };
  token1: { decimals: string };
}

/** One day of pool data, newest-first within a pool's array. */
export interface SubgraphDailyRow {
  date: number;
  /** Whole-pool fees for the day, USD. For dynamic-fee DEXes this is already
   * corrected to volume × live on-chain fee × LP share (see applyDynamicFees). */
  feesUSD: number;
  volumeUSD: number;
  close: number;
}

/** Pool-level fields for the liquidity-share model. */
export interface SubgraphPoolMeta {
  /** Current in-range liquidity, raw uint128 as a number (analytics-grade). */
  liquidityRaw: number;
  decimals0: number;
  decimals1: number;
}

export interface SubgraphPoolData {
  rows: SubgraphDailyRow[];
  meta: SubgraphPoolMeta | null;
}

function sumFirst(nums: number[], n: number): number | null {
  if (nums.length < n) return null;
  let t = 0;
  for (let i = 0; i < n; i++) t += nums[i];
  return t;
}

/**
 * Fetch daily {feesUSD, close} rows (newest-first) plus pool liquidity/decimals
 * for every pool whose DEX has a subgraph configured, keyed by pool id. Pools
 * with no returned day data are omitted. One batched request per subgraph.
 */
export async function fetchSubgraphDaily(
  pools: Pool[],
  warnings: string[],
): Promise<Map<string, SubgraphPoolData>> {
  const bySubgraph = new Map<string, Pool[]>();
  for (const pool of pools) {
    const dex = NETWORKS_BY_ID[pool.networkId]?.dexes.find(
      (d) => d.id === pool.dexId,
    );
    const id = dex?.subgraph?.id;
    if (!id) continue;
    (bySubgraph.get(id) ?? bySubgraph.set(id, []).get(id)!).push(pool);
  }

  const result = new Map<string, SubgraphPoolData>();
  const since = (Math.floor(Date.now() / 1000 / DAY) - WINDOW_DAYS) * DAY;

  await Promise.all(
    [...bySubgraph.entries()].map(async ([subgraphId, group]) => {
      // Subgraph pool ids are lowercased addresses.
      const addrToPool = new Map(group.map((p) => [p.address.toLowerCase(), p]));
      const ids = [...addrToPool.keys()];

      const data = await querySubgraph<{
        poolDayDatas: RawPoolDayData[];
        pools: RawPoolMeta[];
      }>(subgraphId, POOL_DAY_QUERY, { ids, since }, warnings);
      if (!data) return;

      const rowsByAddr = new Map<string, SubgraphDailyRow[]>();
      for (const row of data.poolDayDatas) {
        const arr = rowsByAddr.get(row.pool.id) ?? [];
        arr.push({
          date: row.date,
          feesUSD: Number(row.feesUSD) || 0,
          volumeUSD: Number(row.volumeUSD) || 0,
          close: Number(row.close) || 0,
        });
        rowsByAddr.set(row.pool.id, arr);
      }

      const metaByAddr = new Map<string, SubgraphPoolMeta>();
      for (const m of data.pools ?? []) {
        const liq = Number(m.liquidity);
        const d0 = Number(m.token0?.decimals);
        const d1 = Number(m.token1?.decimals);
        if (Number.isFinite(liq) && liq > 0 && Number.isFinite(d0) && Number.isFinite(d1)) {
          metaByAddr.set(m.id, { liquidityRaw: liq, decimals0: d0, decimals1: d1 });
        }
      }

      for (const [addr, pool] of addrToPool) {
        const rows = rowsByAddr.get(addr);
        if (rows && rows.length > 0) {
          result.set(pool.id, { rows, meta: metaByAddr.get(addr) ?? null });
        }
      }
    }),
  );

  await applyDynamicFees(pools, result, warnings);
  return result;
}

/**
 * Rewrite feesUSD for pools of dynamic-fee DEXes (Aerodrome Slipstream): the
 * subgraph derives feesUSD from the STATIC creation-time tier, but the live
 * fee comes from the factory's fee module and is often far lower (the "1%"
 * cbBTC/USDC pool actually charges 0.037% — a 27x overstatement). Uses
 * volume × live fee × (1 - unstaked-fee skim), i.e. the fees a marginal
 * UNSTAKED LP's liquidity share actually earns. The live fee is applied to the
 * whole history window — fee-module changes within the window are invisible,
 * which is still an order of magnitude closer than the static tier. On-chain
 * read failures keep the subgraph values and add a warning.
 */
async function applyDynamicFees(
  pools: Pool[],
  result: Map<string, SubgraphPoolData>,
  warnings: string[],
): Promise<void> {
  const byRpc = new Map<string, Pool[]>();
  for (const pool of pools) {
    if (!result.has(pool.id)) continue;
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
        const terms = fees.get(pool.address.toLowerCase());
        if (!terms) {
          warnings.push(
            `${pool.name}: live fee unavailable — subgraph fees may be overstated`,
          );
          continue;
        }
        for (const row of result.get(pool.id)!.rows) {
          row.feesUSD = row.volumeUSD * terms.fee * terms.lpFeeShare;
        }
      }
    }),
  );
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
  for (const [poolId, { rows }] of daily) {
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
