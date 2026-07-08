"use client";

import type { SortState } from "@/lib/filters";
import {
  formatFeeTier,
  formatRatio,
  formatUsd,
  formatPercent,
} from "@/lib/format";
import type { Pool, SortKey } from "@/lib/types";

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

export function PoolsTable({
  pools,
  sort,
  onSort,
}: {
  pools: Pool[];
  sort: SortState;
  onSort: (key: SortKey) => void;
}) {
  return (
    <div className="scroll-x overflow-x-auto rounded-2xl border border-border-soft">
      <table className="w-full min-w-[820px] border-collapse text-sm">
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
                <a
                  href={p.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex flex-col gap-0.5"
                >
                  <span className="flex items-center gap-1.5 font-medium text-text">
                    <span style={{ color: p.baseAsset === "ETH" ? "var(--eth)" : "var(--btc)" }}>
                      {p.volatileSymbol}
                    </span>
                    <span className="text-text-faint">/</span>
                    <span className="text-text-muted">{p.stableSymbol}</span>
                    <span className="ml-1 text-text-faint opacity-0 transition-opacity group-hover:opacity-100">
                      ↗
                    </span>
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
                </a>
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
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
