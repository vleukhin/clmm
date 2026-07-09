"use client";

import { DEX_FAMILIES, FEE_TIERS, NETWORKS, STABLE_SYMBOLS } from "@/lib/config";
import { DEFAULT_FILTERS, type FilterState } from "@/lib/filters";
import { RANGE_WIDTHS } from "@/lib/netApr";
import type { BaseAsset } from "@/lib/types";

interface Props {
  filters: FilterState;
  onChange: (next: FilterState) => void;
  /** Count after filtering / total, for the summary line. */
  shown: number;
  total: number;
}

function toggle<T>(arr: T[], value: T): T[] {
  return arr.includes(value)
    ? arr.filter((v) => v !== value)
    : [...arr, value];
}

function Chip({
  active,
  onClick,
  children,
  color,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  color?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? "border-accent bg-accent/15 text-accent"
          : "border-border bg-surface text-text-muted hover:border-border hover:bg-surface-hover hover:text-text"
      }`}
      style={active && color ? { color, borderColor: color, background: `${color}22` } : undefined}
    >
      {children}
    </button>
  );
}

function Group({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-text-faint">
        {label}
      </span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function NumberField({
  label,
  suffix,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  suffix?: string;
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder: string;
}) {
  return (
    <label className="flex flex-col gap-2">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-text-faint">
        {label}
      </span>
      <div className="flex items-center rounded-lg border border-border bg-surface focus-within:border-accent">
        <input
          type="number"
          inputMode="decimal"
          min={0}
          value={value ?? ""}
          placeholder={placeholder}
          onChange={(e) =>
            onChange(e.target.value === "" ? null : Number(e.target.value))
          }
          className="tnum w-full bg-transparent px-3 py-1.5 text-sm text-text outline-none placeholder:text-text-faint"
        />
        {suffix && (
          <span className="pr-3 text-xs text-text-faint">{suffix}</span>
        )}
      </div>
    </label>
  );
}

export function PoolsFilters({ filters, onChange, shown, total }: Props) {
  const set = (patch: Partial<FilterState>) =>
    onChange({ ...filters, ...patch });

  const isDirty =
    JSON.stringify(filters) !== JSON.stringify(DEFAULT_FILTERS);

  return (
    <section className="rounded-2xl border border-border-soft bg-bg-elev/70 p-4 backdrop-blur sm:p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <input
          type="search"
          value={filters.search}
          onChange={(e) => set({ search: e.target.value })}
          placeholder="Search pool, token, DEX…"
          className="w-full max-w-xs rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-text outline-none placeholder:text-text-faint focus:border-accent"
        />
        <div className="flex items-center gap-3 whitespace-nowrap text-xs text-text-muted">
          <span className="tnum">
            {shown}
            <span className="text-text-faint"> / {total}</span> pools
          </span>
          {isDirty && (
            <button
              type="button"
              onClick={() => onChange({ ...DEFAULT_FILTERS })}
              className="rounded-md border border-border px-2 py-1 text-text-muted transition-colors hover:border-neg hover:text-neg"
            >
              Reset
            </button>
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Group label="Network">
          {NETWORKS.map((n) => (
            <Chip
              key={n.id}
              active={filters.networks.includes(n.id)}
              onClick={() => set({ networks: toggle(filters.networks, n.id) })}
            >
              {n.name}
            </Chip>
          ))}
        </Group>

        <Group label="DEX">
          {DEX_FAMILIES.map((d) => (
            <Chip
              key={d}
              active={filters.families.includes(d)}
              onClick={() => set({ families: toggle(filters.families, d) })}
            >
              {d}
            </Chip>
          ))}
        </Group>

        <Group label="Base asset">
          {(["ETH", "BTC"] as BaseAsset[]).map((a) => (
            <Chip
              key={a}
              active={filters.baseAssets.includes(a)}
              color={a === "ETH" ? "var(--eth)" : "var(--btc)"}
              onClick={() => set({ baseAssets: toggle(filters.baseAssets, a) })}
            >
              {a}
            </Chip>
          ))}
        </Group>

        <Group label="Stablecoin">
          {STABLE_SYMBOLS.map((s) => (
            <Chip
              key={s}
              active={filters.stables.includes(s)}
              onClick={() => set({ stables: toggle(filters.stables, s) })}
            >
              {s}
            </Chip>
          ))}
        </Group>

        <Group label="Fee tier">
          {FEE_TIERS.map((t) => (
            <Chip
              key={t.value}
              active={filters.feeTiers.includes(t.value)}
              onClick={() => set({ feeTiers: toggle(filters.feeTiers, t.value) })}
            >
              {t.label}
            </Chip>
          ))}
        </Group>

        <Group label="Net APR range">
          {RANGE_WIDTHS.map((w) => (
            <Chip
              key={w.key}
              active={filters.rangeWidth === w.key}
              color="var(--chart-range)"
              onClick={() => set({ rangeWidth: w.key })}
            >
              {w.label}
            </Chip>
          ))}
        </Group>

        <div className="grid grid-cols-3 gap-2">
          <NumberField
            label="Min TVL"
            suffix="$"
            placeholder="0"
            value={filters.minTvl}
            onChange={(v) => set({ minTvl: v })}
          />
          <NumberField
            label="Min Vol 24h"
            suffix="$"
            placeholder="0"
            value={filters.minVolume}
            onChange={(v) => set({ minVolume: v })}
          />
          <NumberField
            label="Min Vol/TVL"
            suffix="%"
            placeholder="0"
            value={filters.minVolumeToTvlPct}
            onChange={(v) => set({ minVolumeToTvlPct: v })}
          />
        </div>
      </div>
    </section>
  );
}
