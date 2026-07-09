// Per-pool net range APR, precomputed for every preset band width, so the
// client can rank/re-sort instantly without any range math or refetch.
//
// Daily price + fees come from subgraphs where available (one batched query,
// real fees), else from GeckoTerminal OHLCV (volume × feeTier estimate). The
// OHLCV fallback is capped by TVL to bound the request count.

import { MAX_APR_POOLS, NETWORKS_BY_ID } from "./config";
import { getAllPools } from "./aggregate";
import { feeAprFromFees } from "./apr";
import { fetchSubgraphDaily } from "./subgraphApr";
import { fetchPriceHistory } from "./priceHistory";
import { computeAllWidths } from "./netApr";
import type { Pool, PoolRangeApr, PoolRangeAprResponse } from "./types";

const OHLCV_DAYS = 90;

function hasSubgraph(pool: Pool): boolean {
  const dex = NETWORKS_BY_ID[pool.networkId]?.dexes.find(
    (d) => d.id === pool.dexId,
  );
  return Boolean(dex?.subgraph);
}

/** Per-day whole-pool fee APR from fees, aligned to the closes. */
function feeAprSeries(feesOrVolumeUsd: number[], tvlUsd: number): number[] {
  return feesOrVolumeUsd.map((f) => feeAprFromFees(f, tvlUsd, 1) ?? 0);
}

export async function getPoolRangeData(): Promise<PoolRangeAprResponse> {
  const warnings: string[] = [];
  const { pools } = await getAllPools();
  const byId: Record<string, PoolRangeApr> = {};

  // 1) Subgraph pools: closes + real daily fees from one batched query.
  const daily = await fetchSubgraphDaily(pools.filter(hasSubgraph), warnings);
  const poolById = new Map(pools.map((p) => [p.id, p]));

  for (const [poolId, rows] of daily) {
    const pool = poolById.get(poolId);
    if (!pool || pool.tvlUsd <= 0) continue;
    // rows newest-first → chronological, drop days without a usable close so
    // closes and fees stay aligned.
    const chron = [...rows].reverse().filter((r) => r.close > 0);
    if (chron.length === 0) continue;
    const closes = chron.map((r) => r.close);
    const dailyFeeAprs = feeAprSeries(
      chron.map((r) => r.feesUSD),
      pool.tvlUsd,
    );
    byId[poolId] = {
      widths: computeAllWidths(closes, dailyFeeAprs),
      source: "fees",
      days: closes.length,
    };
  }

  // 2) OHLCV fallback for the rest (and subgraph pools that returned nothing),
  //    capped by TVL to bound GeckoTerminal requests.
  const fallback = pools
    .filter((p) => !byId[p.id] && p.tvlUsd > 0)
    .sort((a, b) => b.tvlUsd - a.tvlUsd)
    .slice(0, MAX_APR_POOLS);

  await Promise.all(
    fallback.map(async (pool) => {
      const side = pool.volatileIsBase ? "base" : "quote";
      const candles = await fetchPriceHistory(
        pool.networkId,
        pool.address,
        OHLCV_DAYS,
        warnings,
        side,
      );
      if (!candles || candles.length === 0) return;
      const closes = candles.map((c) => c.close);
      const dailyFeeAprs =
        pool.feeTier != null
          ? feeAprSeries(
              candles.map((c) => c.volumeUsd * pool.feeTier!),
              pool.tvlUsd,
            )
          : closes.map(() => 0);
      byId[pool.id] = {
        widths: computeAllWidths(closes, dailyFeeAprs),
        source: "estimate",
        days: closes.length,
      };
    }),
  );

  return { byId, generatedAt: new Date().toISOString(), warnings };
}
