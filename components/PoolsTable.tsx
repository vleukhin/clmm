"use client";

import Link from "next/link";
import type { SortState } from "@/lib/filters";
import {
  formatApr,
  formatFeeTier,
  formatRatio,
  formatUsd,
  formatPercent,
} from "@/lib/format";
import type { Pool, SortKey } from "@/lib/types";
import { nativePoolLink } from "@/lib/dexLinks";

const NETWORK_COLOR: Record<string, string> = {
  eth: "#7c9cff",
  bsc: "#f0b90b",
  arbitrum: "#28a0f0",
  base: "#0052ff",
  polygon_pos: "#8247e5",
};

/** Emerald tint whose intensity scales with volume/TVL (turnover = fee signal). */
function ratioStyle(ratio: number): React.CSSProperties {
  const t = Math.max(0, Math.min(1, ratio / 1.5)); // clamp at 150%
  return {
    background: `color-mix(in oklab, var(--accent) ${Math.round(t * 22)}%, transparent)`,
    color:
      t > 0.15
        ? `color-mix(in oklab, var(--accent) ${Math.round(60 + t * 40)}%, var(--text))`
        : "var(--text-muted)",
  };
}

function SortHeader({
  label,
  col,
  sort,
  onSort,
  align = "right",
}: {
  label: string;
  col: SortKey;
  sort: SortState;
  onSort: (key: SortKey) => void;
  align?: "left" | "right";
}) {
  const active = sort.key === col;
  return (
    <th
      className={`sticky top-0 z-10 whitespace-nowrap bg-bg-elev px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      <button
        type="button"
        onClick={() => onSort(col)}
        className={`inline-flex items-center gap-1 transition-colors hover:text-text ${
          active ? "text-accent" : "text-text-faint"
        } ${align === "right" ? "flex-row-reverse" : ""}`}
      >
        {label}
        <span className="w-2 text-[9px]">
          {active ? (sort.dir === "desc" ? "▼" : "▲") : ""}
        </span>
      </button>
    </th>
  );
}

/** Emerald-tinted APR pill; intensity scales with APR, capped at 50%.
 * Estimates (OHLCV volume × fee) get a leading "≈"; real subgraph fees don't. */
function aprCell(
  apr: number | null | undefined,
  loading: boolean,
  source: "fees" | "estimate" | undefined,
) {
  if (loading && apr === undefined) {
    return (
      <span className="tnum inline-block h-5 w-12 animate-pulse rounded bg-surface-hover align-middle" />
    );
  }
  if (apr == null) return <span className="tnum text-text-faint">—</span>;
  const t = Math.max(0, Math.min(1, apr / 0.5));
  const estimate = source === "estimate";
  return (
    <span
      className="tnum inline-block rounded-md px-2 py-1 text-xs font-semibold"
      style={{
        background: `color-mix(in oklab, var(--accent) ${Math.round(t * 20)}%, transparent)`,
        color:
          t > 0.1
            ? `color-mix(in oklab, var(--accent) ${Math.round(55 + t * 45)}%, var(--text))`
            : "var(--text-muted)",
      }}
    >
      {estimate && <span className="text-text-faint">≈</span>}
      {formatApr(apr)}
    </span>
  );
}

const APR_TITLE: Record<"fees" | "estimate", string> = {
  fees: "Annualized fee APR from real accrued fees (subgraph feesUSD ÷ TVL)",
  estimate: "Estimated fee APR (24h-style volume × fee tier ÷ TVL)",
};

/** Diverging pill for net range APR: teal when positive, red when negative;
 * intensity scales with magnitude. Estimates get a leading "≈". */
function netAprCell(p: Pool, loading: boolean) {
  const r = p.rangeApr;
  if (loading && r === undefined) {
    return (
      <span className="tnum inline-block h-5 w-14 animate-pulse rounded bg-surface-hover align-middle" />
    );
  }
  if (r == null) return <span className="tnum text-text-faint">—</span>;
  const v = r.netApr;
  const pos = v >= 0;
  const base = pos ? "var(--pos)" : "var(--neg)";
  const t = Math.max(0, Math.min(1, Math.abs(v) / 0.5));
  return (
    <span
      className="tnum inline-block rounded-md px-2 py-1 text-xs font-semibold"
      style={{
        background: `color-mix(in oklab, ${base} ${Math.round(t * 20)}%, transparent)`,
        color: t > 0.1 ? base : "var(--text-muted)",
      }}
    >
      {p.rangeAprSource === "estimate" && <span className="text-text-faint">≈</span>}
      {pos ? "" : "−"}
      {formatApr(Math.abs(v))}
    </span>
  );
}

function netAprTitle(p: Pool, widthLabel: string): string | undefined {
  const r = p.rangeApr;
  if (!r) return undefined;
  return (
    `Net range APR (${widthLabel}) over ${p.rangeAprDays ?? "?"}d, from your ` +
    `share of in-range liquidity — fees +${formatApr(r.feeApr)}, ` +
    `IL ${formatApr(r.ilApr)}, in range ${formatPercent(r.timeInRange * 100, 0)}`
  );
}

export function PoolsTable({
  pools,
  sort,
  onSort,
  aprLoading,
  rangeLoading,
  rangeWidthLabel,
}: {
  pools: Pool[];
  sort: SortState;
  onSort: (key: SortKey) => void;
  aprLoading: boolean;
  rangeLoading: boolean;
  rangeWidthLabel: string;
}) {
  return (
    <div className="scroll-x overflow-x-auto rounded-2xl border border-border-soft">
      <table className="w-full min-w-[1080px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className="sticky top-0 z-10 bg-bg-elev px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-text-faint">
              Pool
            </th>
            <th className="sticky top-0 z-10 bg-bg-elev px-3 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-text-faint">
              DEX · Network
            </th>
            <SortHeader label="Fee" col="feeTier" sort={sort} onSort={onSort} />
            <SortHeader label="TVL" col="tvlUsd" sort={sort} onSort={onSort} />
            <SortHeader
              label="Vol 24h"
              col="volume24hUsd"
              sort={sort}
              onSort={onSort}
            />
            <SortHeader
              label="Vol / TVL"
              col="volumeToTvl"
              sort={sort}
              onSort={onSort}
            />
            <SortHeader
              label={`Net APR ${rangeWidthLabel}`}
              col="netRangeApr"
              sort={sort}
              onSort={onSort}
            />
            <SortHeader
              label="APR 7d"
              col="feeApr7d"
              sort={sort}
              onSort={onSort}
            />
            <SortHeader
              label="APR 30d"
              col="feeApr30d"
              sort={sort}
              onSort={onSort}
            />
          </tr>
        </thead>
        <tbody>
          {pools.map((p) => (
            <tr
              key={p.id}
              className="group border-b border-border-soft transition-colors hover:bg-surface-hover"
            >
              {/* Pool + pair */}
              <td className="px-3 py-2.5">
                <div className="flex flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 font-medium text-text">
                    <Link
                      href={`/pools/${encodeURIComponent(p.id)}`}
                      className="flex items-center gap-1.5 hover:underline"
                    >
                      <span style={{ color: p.baseAsset === "ETH" ? "var(--eth)" : "var(--btc)" }}>
                        {p.volatileSymbol}
                      </span>
                      <span className="text-text-faint">/</span>
                      <span className="text-text-muted">{p.stableSymbol}</span>
                    </Link>
                    {(() => {
                      const native = nativePoolLink(p);
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
                          className="ml-1 text-[11px] text-text-faint opacity-0 transition-opacity hover:text-accent group-hover:opacity-100"
                        >
                          {native.label} ↗
                        </a>
                      );
                    })()}
                    <a
                      href={p.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Open on GeckoTerminal"
                      className="ml-1 text-text-faint opacity-0 transition-opacity hover:text-accent group-hover:opacity-100"
                    >
                      ↗
                    </a>
                  </span>
                  {p.priceChange24h != null && (
                    <span
                      className="tnum text-[11px]"
                      style={{
                        color:
                          p.priceChange24h >= 0 ? "var(--pos)" : "var(--neg)",
                      }}
                    >
                      {p.priceChange24h >= 0 ? "+" : ""}
                      {formatPercent(p.priceChange24h)} 24h
                    </span>
                  )}
                </div>
              </td>

              {/* DEX + network */}
              <td className="px-3 py-2.5">
                <div className="flex flex-col gap-0.5">
                  <span className="text-text">{p.dexName}</span>
                  <span className="flex items-center gap-1.5 text-[11px] text-text-muted">
                    <span
                      className="inline-block h-2 w-2 rounded-full"
                      style={{
                        background: NETWORK_COLOR[p.networkId] ?? "var(--text-faint)",
                      }}
                    />
                    {p.networkName}
                  </span>
                </div>
              </td>

              {/* Fee */}
              <td className="tnum px-3 py-2.5 text-right text-text-muted">
                {formatFeeTier(p.feeTier)}
              </td>

              {/* TVL */}
              <td className="tnum px-3 py-2.5 text-right text-text">
                {formatUsd(p.tvlUsd)}
              </td>

              {/* Volume */}
              <td className="tnum px-3 py-2.5 text-right text-text">
                {formatUsd(p.volume24hUsd)}
              </td>

              {/* Vol/TVL heat */}
              <td className="px-2 py-2 text-right">
                <span
                  className="tnum inline-block rounded-md px-2 py-1 text-xs font-semibold"
                  style={ratioStyle(p.volumeToTvl)}
                  title="24h volume ÷ TVL — a proxy for fee yield"
                >
                  {formatRatio(p.volumeToTvl)}
                </span>
              </td>

              {/* Net range APR (selected width) */}
              <td className="px-2 py-2 text-right" title={netAprTitle(p, rangeWidthLabel)}>
                {netAprCell(p, rangeLoading)}
              </td>

              {/* Fee APR 7d / 30d */}
              <td
                className="px-2 py-2 text-right"
                title={p.aprSource ? APR_TITLE[p.aprSource] : undefined}
              >
                {aprCell(p.feeApr7d, aprLoading, p.aprSource)}
              </td>
              <td
                className="px-2 py-2 text-right"
                title={p.aprSource ? APR_TITLE[p.aprSource] : undefined}
              >
                {aprCell(p.feeApr30d, aprLoading, p.aprSource)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
