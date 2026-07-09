"use client";

// Range simulator panel: deposit + range inputs with presets, and the computed
// yield picture (concentration, time-in-range, two APR estimates, IL, backtest).

import { useEffect, useMemo, useState } from "react";
import { simulateRange } from "@/lib/rangeSim";
import type { LiquiditySegment, TickPoolMeta } from "@/lib/ticks";
import type { DailyCandle } from "@/lib/priceHistory";
import type { Pool } from "@/lib/types";
import { formatApr, formatPercent, formatPrice } from "@/lib/format";

const PRESETS = [
  { label: "±5%", m: 1.05 },
  { label: "±10%", m: 1.1 },
  { label: "±25%", m: 1.25 },
  { label: "±50%", m: 1.5 },
  { label: "Full", m: null },
] as const;

function Tile({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "pos" | "neg";
}) {
  return (
    <div className="rounded-xl border border-border-soft bg-surface px-3 py-2.5">
      <div className="text-[11px] text-text-faint">{label}</div>
      <div
        className="mt-0.5 text-lg font-semibold"
        style={{
          color:
            tone === "pos" ? "var(--pos)" : tone === "neg" ? "var(--neg)" : "var(--text)",
        }}
      >
        {value}
      </div>
      {hint && <div className="mt-0.5 text-[10px] leading-tight text-text-faint">{hint}</div>}
    </div>
  );
}

function BoundInput({
  label,
  text,
  onText,
  placeholder,
}: {
  label: string;
  text: string;
  onText: (v: string) => void;
  placeholder: string;
}) {
  return (
    <label className="flex flex-1 flex-col gap-1">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-text-faint">
        {label}
      </span>
      <div className="flex items-center rounded-lg border border-border bg-surface focus-within:border-accent">
        <span className="pl-2.5 text-xs text-text-faint">$</span>
        <input
          type="number"
          inputMode="decimal"
          min={0}
          step="any"
          value={text}
          placeholder={placeholder}
          onChange={(e) => onText(e.target.value)}
          className="tnum w-full bg-transparent px-2 py-1.5 text-sm text-text outline-none placeholder:text-text-faint"
        />
      </div>
    </label>
  );
}

export function RangeSimulator({
  pool,
  candles,
  tickMeta,
  segments,
  paUsd,
  pbUsd,
  onRange,
}: {
  pool: Pool;
  candles: DailyCandle[];
  tickMeta: TickPoolMeta | null;
  segments: LiquiditySegment[] | null;
  paUsd: number;
  pbUsd: number;
  onRange: (pa: number, pb: number) => void;
}) {
  const [depositText, setDepositText] = useState("10000");
  // Text mirrors of the numeric bounds so typing isn't clobbered by rounding.
  const [paText, setPaText] = useState("");
  const [pbText, setPbText] = useState("");

  const fmtBound = (v: number) =>
    !Number.isFinite(v) || v === 0 ? "" : v >= 100 ? v.toFixed(0) : v.toPrecision(5);

  // Sync mirrors when bounds change from outside (presets / initialization).
  useEffect(() => {
    setPaText(fmtBound(paUsd));
    setPbText(fmtBound(pbUsd));
  }, [paUsd, pbUsd]);

  const depositUsd = Number(depositText) || 0;
  const isFull = paUsd === 0 && !Number.isFinite(pbUsd);
  const price =
    candles.length > 0 ? candles[candles.length - 1].close : NaN;

  const activePreset = useMemo(() => {
    if (isFull) return "Full";
    if (!Number.isFinite(price) || paUsd <= 0) return null;
    for (const p of PRESETS) {
      if (p.m == null) continue;
      if (
        Math.abs(paUsd - price / p.m) / price < 1e-6 &&
        Math.abs(pbUsd - price * p.m) / price < 1e-6
      ) {
        return p.label;
      }
    }
    return null;
  }, [isFull, paUsd, pbUsd, price]);

  const onBoundText = (which: "pa" | "pb", text: string) => {
    if (which === "pa") setPaText(text);
    else setPbText(text);
    const pa = which === "pa" ? Number(text) : Number(paText);
    const pb = which === "pb" ? Number(text) : Number(pbText);
    if (Number.isFinite(pa) && Number.isFinite(pb) && pa >= 0 && pa < pb) {
      onRange(pa, pb);
    }
  };

  const sim = useMemo(
    () =>
      simulateRange({
        pool,
        candles,
        tickMeta,
        segments,
        depositUsd,
        paUsd,
        pbUsd,
      }),
    [pool, candles, tickMeta, segments, depositUsd, paUsd, pbUsd],
  );

  const bt = sim.backtest;
  const days = candles.length;

  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-border-soft bg-bg-elev/70 p-4">
      <div>
        <h2 className="text-sm font-semibold text-text">Position simulator</h2>
        <p className="mt-0.5 text-[11px] leading-snug text-text-faint">
          Pick a price range — see the expected fee yield, impermanent loss and a{" "}
          {days}-day backtest. Estimates, not guarantees.
        </p>
      </div>

      {/* Deposit */}
      <label className="flex flex-col gap-1">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-text-faint">
          Deposit
        </span>
        <div className="flex items-center rounded-lg border border-border bg-surface focus-within:border-accent">
          <span className="pl-2.5 text-xs text-text-faint">$</span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            value={depositText}
            onChange={(e) => setDepositText(e.target.value)}
            className="tnum w-full bg-transparent px-2 py-1.5 text-sm text-text outline-none"
          />
        </div>
      </label>

      {/* Range presets */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-text-faint">
          Range around {formatPrice(price)}
        </span>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() =>
                p.m == null
                  ? onRange(0, Infinity)
                  : Number.isFinite(price) && onRange(price / p.m, price * p.m)
              }
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                activePreset === p.label
                  ? "border-[var(--chart-range)] bg-[var(--chart-range)]/15 text-[var(--chart-range)]"
                  : "border-border bg-surface text-text-muted hover:bg-surface-hover hover:text-text"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Bounds */}
      <div className="flex gap-2">
        <BoundInput
          label="Min price"
          text={paText}
          onText={(v) => onBoundText("pa", v)}
          placeholder={isFull ? "0 (full)" : "0"}
        />
        <BoundInput
          label="Max price"
          text={pbText}
          onText={(v) => onBoundText("pb", v)}
          placeholder={isFull ? "∞ (full)" : "∞"}
        />
      </div>

      {sim.error ? (
        <div className="rounded-lg border border-neg/30 bg-neg/5 px-3 py-2 text-xs text-neg">
          {sim.error}
        </div>
      ) : (
        <>
          {/* Expected yield */}
          <div className="grid grid-cols-2 gap-2">
            <Tile
              label="Concentration"
              value={`×${sim.concentration.toFixed(1)}`}
              hint="Fee multiplier vs full range"
            />
            <Tile
              label={`Time in range (${days}d)`}
              value={formatPercent(sim.timeInRange * 100, 0)}
              hint="Daily closes inside the range"
            />
            <Tile
              label="Est. fee APR — simple"
              value={formatApr(sim.aprSimple)}
              hint="Pool APR × concentration × time in range"
            />
            <Tile
              label="Est. fee APR — liquidity share"
              value={sim.aprLiquidity != null ? formatApr(sim.aprLiquidity) : "—"}
              hint={
                sim.aprLiquidity != null
                  ? "Your share of in-range tick liquidity"
                  : "Needs tick data (subgraph)"
              }
            />
            <Tile
              label="IL if price → min"
              value={sim.ilAtLower != null ? formatPercent(sim.ilAtLower * 100) : "—"}
              tone={sim.ilAtLower != null && sim.ilAtLower < -0.0005 ? "neg" : undefined}
              hint="vs HODL, excludes fees"
            />
            <Tile
              label="IL if price → max"
              value={sim.ilAtUpper != null ? formatPercent(sim.ilAtUpper * 100) : "—"}
              tone={sim.ilAtUpper != null && sim.ilAtUpper < -0.0005 ? "neg" : undefined}
              hint="vs HODL, excludes fees"
            />
          </div>

          {/* Backtest */}
          {bt && (
            <div className="rounded-xl border border-border-soft bg-surface p-3">
              <div className="mb-2 flex items-baseline justify-between">
                <span className="text-xs font-semibold text-text">
                  Backtest — last {days} days
                </span>
                <span
                  className="tnum text-sm font-semibold"
                  style={{ color: bt.netReturn >= 0 ? "var(--pos)" : "var(--neg)" }}
                >
                  {bt.netReturn >= 0 ? "+" : ""}
                  {formatPercent(bt.netReturn * 100)}
                </span>
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
                <div className="flex justify-between">
                  <dt className="text-text-faint">Fees earned</dt>
                  <dd className="tnum text-text-muted">+{formatPercent(bt.feeReturn * 100)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-text-faint">Impermanent loss</dt>
                  <dd className="tnum text-text-muted">{formatPercent(bt.il * 100)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-text-faint">Time in range</dt>
                  <dd className="tnum text-text-muted">{formatPercent(bt.timeInRange * 100, 0)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-text-faint">Annualized</dt>
                  <dd
                    className="tnum"
                    style={{ color: bt.annualized >= 0 ? "var(--pos)" : "var(--neg)" }}
                  >
                    {bt.annualized >= 0 ? "+" : ""}
                    {formatPercent(bt.annualized * 100)}
                  </dd>
                </div>
              </dl>
              <p className="mt-2 text-[10px] leading-snug text-text-faint">
                Enter at day 1, never rebalance; fees accrue only on days closing
                in range; IL measured endpoint-to-endpoint. Daily fee intensity
                from real volumes at today&apos;s TVL.
              </p>
            </div>
          )}
        </>
      )}
    </section>
  );
}
