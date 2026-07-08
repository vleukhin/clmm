"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { PoolsFilters } from "@/components/PoolsFilters";
import { PoolsTable } from "@/components/PoolsTable";
import {
  DEFAULT_FILTERS,
  DEFAULT_SORT,
  applyFilters,
  filtersToParams,
  paramsToFilters,
  type FilterState,
  type SortState,
} from "@/lib/filters";
import type { PoolsResponse, SortKey } from "@/lib/types";

async function fetchPools(): Promise<PoolsResponse> {
  const res = await fetch("/api/pools");
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

export default function Home() {
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const hydrated = useRef(false);

  // Hydrate from the URL once on mount.
  useEffect(() => {
    const parsed = paramsToFilters(
      new URLSearchParams(window.location.search),
    );
    setFilters(parsed.filters);
    setSort(parsed.sort);
    hydrated.current = true;
  }, []);

  // Push filter/sort state back to the URL (shareable view).
  useEffect(() => {
    if (!hydrated.current) return;
    const params = filtersToParams(filters, sort);
    const qs = params.toString();
    const url = qs ? `?${qs}` : window.location.pathname;
    window.history.replaceState(null, "", url);
  }, [filters, sort]);

  const { data, isLoading, isError, error, isFetching, refetch } = useQuery({
    queryKey: ["pools"],
    queryFn: fetchPools,
  });

  const allPools = data?.pools ?? [];
  const visible = useMemo(
    () => applyFilters(allPools, filters, sort),
    [allPools, filters, sort],
  );

  const onSort = (key: SortKey) =>
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "desc" ? "asc" : "desc" }
        : { key, dir: "desc" },
    );

  return (
    <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
      {/* Header */}
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-text sm:text-3xl">
            CLMM Pool Explorer
          </h1>
          <p className="mt-1 max-w-xl text-sm text-text-muted">
            Concentrated-liquidity pools — ETH &amp; BTC vs stablecoins across
            Uniswap, PancakeSwap and more. Sorted by turnover (Vol/TVL), a proxy
            for fee yield.
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-text-faint">
          {data?.generatedAt && (
            <span className="tnum">
              Updated {new Date(data.generatedAt).toLocaleTimeString()}
            </span>
          )}
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="rounded-md border border-border px-2.5 py-1 text-text-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
          >
            {isFetching ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      <div className="flex flex-col gap-5">
        <PoolsFilters
          filters={filters}
          onChange={setFilters}
          shown={visible.length}
          total={allPools.length}
        />

        {/* Warnings from partial fetch failures */}
        {data?.warnings && data.warnings.length > 0 && (
          <div className="rounded-lg border border-btc/30 bg-btc/5 px-3 py-2 text-xs text-btc">
            Some sources returned partial data ({data.warnings.length} warning
            {data.warnings.length > 1 ? "s" : ""}).
          </div>
        )}

        {isLoading ? (
          <TableSkeleton />
        ) : isError ? (
          <ErrorState
            message={error instanceof Error ? error.message : "Unknown error"}
            onRetry={() => refetch()}
          />
        ) : visible.length === 0 ? (
          <EmptyState hasPools={allPools.length > 0} />
        ) : (
          <PoolsTable pools={visible} sort={sort} onSort={onSort} />
        )}
      </div>

      <footer className="mt-8 text-center text-[11px] text-text-faint">
        Data via GeckoTerminal · Vol/TVL is a turnover proxy, not realized APR.
      </footer>
    </main>
  );
}

function TableSkeleton() {
  return (
    <div className="overflow-hidden rounded-2xl border border-border-soft">
      <div className="h-10 border-b border-border bg-bg-elev" />
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-4 border-b border-border-soft px-4 py-3.5"
        >
          <div className="h-4 w-32 animate-pulse rounded bg-surface-hover" />
          <div className="ml-auto h-4 w-20 animate-pulse rounded bg-surface-hover" />
          <div className="h-4 w-20 animate-pulse rounded bg-surface-hover" />
          <div className="h-4 w-16 animate-pulse rounded bg-surface-hover" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({ hasPools }: { hasPools: boolean }) {
  return (
    <div className="rounded-2xl border border-dashed border-border py-16 text-center">
      <p className="text-sm text-text-muted">
        {hasPools
          ? "No pools match the current filters."
          : "No pools available right now."}
      </p>
    </div>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="rounded-2xl border border-neg/30 bg-neg/5 py-16 text-center">
      <p className="text-sm text-neg">Failed to load pools.</p>
      <p className="mt-1 text-xs text-text-faint">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 rounded-md border border-border px-3 py-1.5 text-xs text-text-muted transition-colors hover:border-accent hover:text-accent"
      >
        Try again
      </button>
    </div>
  );
}
