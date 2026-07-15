"use client";

import Link from "next/link";
import { use, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PriceChart } from "@/components/charts/PriceChart";
import { LiquidityChart } from "@/components/charts/LiquidityChart";
import { RangeSimulator } from "@/components/RangeSimulator";
import { NETWORKS_BY_ID } from "@/lib/config";
import { nativePoolLink } from "@/lib/dexLinks";
import { segmentsToUsdBuckets, stableIsToken0 } from "@/lib/rangeSim";
import type { DailyCandle, PriceStats } from "@/lib/priceHistory";
import type { LiquiditySegment, TickPoolMeta } from "@/lib/ticks";
import type { Pool, PoolAprResponse, PoolsResponse } from "@/lib/types";
import {
  formatApr,
  formatFeeTier,
  formatPercent,
  formatPrice,
  formatRatio,
  formatUsd,
} from "@/lib/format";

interface HistoryResponse {
  series: DailyCandle[];
  stats: PriceStats | null;
  warnings: string[];
}

interface TicksResponse {
  pool: TickPoolMeta;
  segments: LiquiditySegment[];
  warnings: string[];
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

const NETWORK_COLOR: Record<string, string> = {
  eth: "#7c9cff",
  bsc: "#f0b90b",
  arbitrum: "#28a0f0",
  base: "#0052ff",
  polygon_pos: "#8247e5",
};

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-border-soft bg-bg-elev/70 px-3 py-2.5">
      <div className="text-[11px] text-text-faint">{label}</div>
      <div className="mt-0.5 text-lg font-semibold text-text">{value}</div>
      {hint && <div className="text-[10px] text-text-faint">{hint}</div>}
    </div>
  );
}

function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-border-soft bg-bg-elev/70 p-4">
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-text">{title}</h2>
        {subtitle && <p className="text-[11px] text-text-faint">{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

export default function PoolPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const poolId = decodeURIComponent(id);

  const poolsQuery = useQuery({
    queryKey: ["pools"],
    queryFn: () => getJson<PoolsResponse>("/api/pools"),
    staleTime: 60_000,
  });

  // Fee APR enrichment (same payload the list page merges in).
  const aprQuery = useQuery({
    queryKey: ["pools-apr"],
    queryFn: () => getJson<PoolAprResponse>("/api/pools/apr"),
    staleTime: 30 * 60_000,
  });

  const pool: Pool | undefined = useMemo(() => {
    const raw = poolsQuery.data?.pools.find((p) => p.id === poolId);
    if (!raw) return undefined;
    const apr = aprQuery.data?.aprById[poolId];
    return apr
      ? {
          ...raw,
          feeApr7d: apr.feeApr7d,
          feeApr30d: apr.feeApr30d,
          aprSource: apr.source,
        }
      : raw;
  }, [poolsQuery.data, aprQuery.data, poolId]);

  // The volatile side varies per pool on GeckoTerminal, so wait for the pool
  // row and request history for the right side.
  const side = pool ? (pool.volatileIsBase ? "base" : "quote") : null;
  const historyQuery = useQuery({
    queryKey: ["pool-history", poolId, side],
    queryFn: () =>
      getJson<HistoryResponse>(
        `/api/pools/${encodeURIComponent(poolId)}/history?days=90&side=${side}`,
      ),
    enabled: side !== null,
    staleTime: 30 * 60_000,
  });

  const dexConfig = pool
    ? NETWORKS_BY_ID[pool.networkId]?.dexes.find((d) => d.id === pool.dexId)
    : undefined;
  const hasTicks = Boolean(dexConfig?.subgraph);

  const ticksQuery = useQuery({
    queryKey: ["pool-ticks", poolId, pool?.dexId],
    queryFn: () =>
      getJson<TicksResponse>(
        `/api/pools/${encodeURIComponent(poolId)}/ticks?dex=${encodeURIComponent(pool!.dexId)}`,
      ),
    enabled: Boolean(pool) && hasTicks,
    staleTime: 30 * 60_000,
    retry: 1,
  });

  const candles = historyQuery.data?.series ?? [];
  const stats = historyQuery.data?.stats ?? null;
  const lastPrice = stats?.lastClose ?? null;

  // Selected range (USD per volatile). Initialized to ±10% once price is known.
  const [range, setRange] = useState<{ pa: number; pb: number } | null>(null);
  useEffect(() => {
    if (range === null && lastPrice != null && lastPrice > 0) {
      setRange({ pa: lastPrice / 1.1, pb: lastPrice * 1.1 });
    }
  }, [range, lastPrice]);

  useEffect(() => {
    if (pool) document.title = `${pool.volatileSymbol}/${pool.stableSymbol} · CLMM Analytics`;
  }, [pool]);

  const buckets = useMemo(() => {
    const t = ticksQuery.data;
    if (!t || lastPrice == null) return [];
    return segmentsToUsdBuckets(t.segments, stableIsToken0(t.pool, lastPrice));
  }, [ticksQuery.data, lastPrice]);

  const paForCharts = range?.pa ?? null;
  const pbForCharts = range != null && Number.isFinite(range.pb) ? range.pb : null;

  if (poolsQuery.isLoading) {
    return (
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6">
        <div className="h-8 w-64 animate-pulse rounded bg-surface-hover" />
        <div className="mt-6 h-72 animate-pulse rounded-2xl bg-surface" />
      </main>
    );
  }

  if (!pool) {
    return (
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-16 text-center sm:px-6">
        <p className="text-sm text-text-muted">Pool not found.</p>
        <Link
          href="/"
          className="mt-4 inline-block rounded-md border border-border px-3 py-1.5 text-xs text-text-muted transition-colors hover:border-accent hover:text-accent"
        >
          ← All pools
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6 sm:py-8">
      {/* Header */}
      <div className="mb-5">
        <Link
          href="/"
          className="text-xs text-text-faint transition-colors hover:text-accent"
        >
          ← All pools
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            <span style={{ color: pool.baseAsset === "ETH" ? "var(--eth)" : "var(--btc)" }}>
              {pool.volatileSymbol}
            </span>
            <span className="text-text-faint"> / </span>
            <span className="text-text">{pool.stableSymbol}</span>
          </h1>
          <span className="rounded-full border border-border bg-surface px-2.5 py-0.5 text-xs text-text-muted">
            {pool.dexName}
          </span>
          <span className="flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-0.5 text-xs text-text-muted">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: NETWORK_COLOR[pool.networkId] ?? "var(--text-faint)" }}
            />
            {pool.networkName}
          </span>
          {(pool.feeTierActual ?? pool.feeTier) != null && (
            <span
              className="rounded-full border border-border bg-surface px-2.5 py-0.5 text-xs text-text-muted"
              title={
                pool.feeTierActual != null && pool.feeTierActual !== pool.feeTier
                  ? `Live on-chain fee (nominal tier ${formatFeeTier(pool.feeTier)})`
                  : undefined
              }
            >
              fee {formatFeeTier(pool.feeTierActual ?? pool.feeTier)}
            </span>
          )}
          {(() => {
            const native = nativePoolLink(pool);
            if (!native) return null;
            return (
              <a
                href={native.url}
                target="_blank"
                rel="noopener noreferrer"
                title={
                  native.exact
                    ? `Open this pool on ${native.label}`
                    : `Open ${native.label}'s pools page`
                }
                className="text-xs text-text-faint transition-colors hover:text-accent"
              >
                {native.label} ↗
              </a>
            );
          })()}
          <a
            href={pool.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-text-faint transition-colors hover:text-accent"
          >
            GeckoTerminal ↗
          </a>
        </div>
      </div>

      {/* Stat tiles */}
      <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Price" value={formatPrice(lastPrice)} />
        <StatTile label="TVL" value={formatUsd(pool.tvlUsd)} />
        <StatTile label="Volume 24h" value={formatUsd(pool.volume24hUsd)} />
        <StatTile label="Vol / TVL" value={formatRatio(pool.volumeToTvl)} />
        <StatTile
          label="Fee APR 7d"
          value={
            aprQuery.isLoading
              ? "…"
              : `${pool.aprSource === "estimate" ? "≈" : ""}${formatApr(pool.feeApr7d)}`
          }
          hint={
            pool.aprSource === "fees"
              ? "real fees"
              : pool.aprSource === "estimate"
                ? "volume estimate"
                : undefined
          }
        />
        <StatTile
          label="Volatility 30d"
          value={
            stats?.realizedVol30dAnnualized != null
              ? formatPercent(stats.realizedVol30dAnnualized * 100, 0)
              : "—"
          }
          hint="annualized"
        />
      </div>

      {/* Charts + simulator */}
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-5">
          <Card
            title="Price — 90 days"
            subtitle={`Daily closes, ${pool.volatileSymbol} in ${pool.stableSymbol} · selected range shaded`}
          >
            {historyQuery.isLoading ? (
              <div className="h-56 animate-pulse rounded bg-surface" />
            ) : historyQuery.isError || candles.length === 0 ? (
              <div className="flex h-40 flex-col items-center justify-center gap-2 text-xs text-text-muted">
                Failed to load price history.
                <button
                  type="button"
                  onClick={() => historyQuery.refetch()}
                  className="rounded-md border border-border px-2.5 py-1 text-text-muted hover:border-accent hover:text-accent"
                >
                  Try again
                </button>
              </div>
            ) : (
              <PriceChart candles={candles} rangeLow={paForCharts} rangeHigh={pbForCharts} />
            )}
          </Card>

          <Card
            title="Liquidity distribution"
            subtitle="Active liquidity by price · current price marked · selected range shaded"
          >
            {!hasTicks ? (
              <p className="py-6 text-center text-xs text-text-faint">
                Tick-level data isn&apos;t available for this DEX yet (no subgraph configured).
              </p>
            ) : ticksQuery.isLoading ? (
              <div className="h-44 animate-pulse rounded bg-surface" />
            ) : ticksQuery.isError || buckets.length === 0 || lastPrice == null ? (
              <p className="py-6 text-center text-xs text-text-faint">
                Failed to load tick data from the subgraph.
              </p>
            ) : (
              <LiquidityChart
                buckets={buckets}
                priceUsd={lastPrice}
                rangeLow={paForCharts}
                rangeHigh={pbForCharts}
              />
            )}
          </Card>
        </div>

        <div className="lg:sticky lg:top-4 lg:self-start">
          {historyQuery.isLoading || range === null ? (
            <div className="h-96 animate-pulse rounded-2xl bg-surface" />
          ) : (
            <RangeSimulator
              pool={pool}
              candles={candles}
              tickMeta={ticksQuery.data?.pool ?? null}
              segments={ticksQuery.data?.segments ?? null}
              paUsd={range.pa}
              pbUsd={range.pb}
              onRange={(pa, pb) => setRange({ pa, pb })}
            />
          )}
        </div>
      </div>

      <footer className="mt-8 text-center text-[11px] text-text-faint">
        All figures are pool-level estimates for a marginal position — not financial advice.
      </footer>
    </main>
  );
}
