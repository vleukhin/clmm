// Per-pool net range APR, precomputed for every preset band width, so the
// client can rank/re-sort instantly without any range math or refetch.
//
// Fees use the liquidity-share model (netApr.ts), which needs the pool's
// in-range liquidity — only available from subgraphs. Pools without a subgraph
// (no liquidity data) are omitted; the client shows "—" for their net APR.

import { getAllPools } from "./aggregate";
import { fetchSubgraphDaily } from "./subgraphApr";
import { computeAllWidths } from "./netApr";
import type { PoolRangeAprResponse } from "./types";

export async function getPoolRangeData(): Promise<PoolRangeAprResponse> {
  const warnings: string[] = [];
  const { pools } = await getAllPools();
  const byId: PoolRangeAprResponse["byId"] = {};

  const daily = await fetchSubgraphDaily(pools, warnings);
  const poolById = new Map(pools.map((p) => [p.id, p]));

  for (const [poolId, { rows, meta }] of daily) {
    const pool = poolById.get(poolId);
    if (!pool || pool.tvlUsd <= 0 || !meta) continue;

    // rows newest-first → chronological; drop days without a usable close.
    const chron = [...rows].reverse().filter((r) => r.close > 0);
    if (chron.length === 0) continue;

    const closes = chron.map((r) => r.close);
    const avgDailyFeesUsd =
      chron.reduce((s, r) => s + r.feesUSD, 0) / chron.length;

    byId[poolId] = {
      widths: computeAllWidths({
        closes,
        avgDailyFeesUsd,
        liquidityRaw: meta.liquidityRaw,
        decimals0: meta.decimals0,
        decimals1: meta.decimals1,
      }),
      source: "fees",
      days: closes.length,
    };
  }

  return { byId, generatedAt: new Date().toISOString(), warnings };
}
