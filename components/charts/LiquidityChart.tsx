"use client";

// Active-liquidity distribution around the current price, as a step area over
// USD price. Overlays: selected range band, current-price hairline. Crosshair
// tooltip (pointer + keyboard) and a table view for accessibility.

import { useMemo, useRef, useState } from "react";
import type { UsdLiquidityBucket } from "@/lib/rangeSim";
import { formatPrice } from "@/lib/format";

const W = 720;
const H = 200;
const PAD = { top: 14, right: 12, bottom: 26, left: 56 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

export function LiquidityChart({
  buckets,
  priceUsd,
  rangeLow,
  rangeHigh,
}: {
  buckets: UsdLiquidityBucket[];
  priceUsd: number;
  rangeLow: number | null;
  rangeHigh: number | null;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null); // index into visible

  const model = useMemo(() => {
    // Window: cover the selected range with margin, always include the price.
    const loSel = rangeLow != null && rangeLow > 0 ? rangeLow : priceUsd * 0.6;
    const hiSel = rangeHigh != null && Number.isFinite(rangeHigh) ? rangeHigh : priceUsd * 1.6;
    const lo = Math.max(Math.min(loSel * 0.85, priceUsd * 0.65), 1e-12);
    const hi = Math.max(hiSel * 1.15, priceUsd * 1.35);

    const visible = buckets
      .filter((b) => b.x1 > lo && b.x0 < hi && b.liquidity > 0)
      .map((b) => ({ ...b, x0: Math.max(b.x0, lo), x1: Math.min(b.x1, hi) }));
    const maxLiq = visible.reduce((m, b) => Math.max(m, b.liquidity), 0);

    const x = (v: number) => PAD.left + ((v - lo) / (hi - lo)) * PLOT_W;
    const y = (liq: number) =>
      PAD.top + PLOT_H - (maxLiq > 0 ? (liq / maxLiq) * PLOT_H : 0);

    // Step path across visible buckets (touching the baseline in gaps).
    let d = "";
    for (const b of visible) {
      d += `M${x(b.x0).toFixed(1)},${(PAD.top + PLOT_H).toFixed(1)}` +
        `L${x(b.x0).toFixed(1)},${y(b.liquidity).toFixed(1)}` +
        `L${x(b.x1).toFixed(1)},${y(b.liquidity).toFixed(1)}` +
        `L${x(b.x1).toFixed(1)},${(PAD.top + PLOT_H).toFixed(1)}Z`;
    }
    return { lo, hi, visible, maxLiq, x, y, path: d };
  }, [buckets, priceUsd, rangeLow, rangeHigh]);

  const { lo, hi, visible, maxLiq, x, path } = model;
  if (buckets.length === 0) return null;

  const bandX0 = rangeLow != null && rangeLow > lo ? x(Math.min(rangeLow, hi)) : x(lo);
  const bandX1 =
    rangeHigh != null && Number.isFinite(rangeHigh) && rangeHigh < hi
      ? x(Math.max(rangeHigh, lo))
      : x(hi);
  const showBand = rangeLow != null && rangeHigh != null && bandX1 > bandX0;

  const xTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => lo + f * (hi - lo));

  const findBucket = (priceAtX: number) =>
    visible.findIndex((b) => priceAtX >= b.x0 && priceAtX < b.x1);

  const setFromClientX = (clientX: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const fx = ((clientX - rect.left) / rect.width) * W;
    const price = lo + ((fx - PAD.left) / PLOT_W) * (hi - lo);
    const i = findBucket(price);
    setHover(i >= 0 ? i : null);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const d = e.key === "ArrowLeft" ? -1 : 1;
      setHover((h) => {
        const start = h ?? findBucket(priceUsd);
        return Math.min(Math.max((start < 0 ? 0 : start) + d, 0), visible.length - 1);
      });
    } else if (e.key === "Escape") {
      setHover(null);
    }
  };

  const h = hover != null ? visible[hover] : null;
  const topBuckets = [...visible].sort((a, b) => b.liquidity - a.liquidity).slice(0, 10);

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="block w-full outline-none focus-visible:ring-1 focus-visible:ring-accent/60 rounded"
        role="img"
        aria-label="Active liquidity by price with selected range band"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerMove={(e) => setFromClientX(e.clientX)}
        onPointerLeave={() => setHover(null)}
        onBlur={() => setHover(null)}
      >
        {/* baseline */}
        <line
          x1={PAD.left} x2={W - PAD.right}
          y1={PAD.top + PLOT_H} y2={PAD.top + PLOT_H}
          stroke="var(--border-soft)" strokeWidth={1}
        />

        {/* selected range band */}
        {showBand && (
          <rect
            x={bandX0} width={bandX1 - bandX0}
            y={PAD.top} height={PLOT_H}
            fill="var(--chart-range)" opacity={0.12}
          />
        )}

        {/* liquidity steps */}
        <path d={path} fill="var(--chart-data)" opacity={0.35} />

        {/* hovered bucket lift */}
        {h != null && (
          <rect
            x={x(h.x0)} width={Math.max(x(h.x1) - x(h.x0), 1)}
            y={model.y(h.liquidity)}
            height={PAD.top + PLOT_H - model.y(h.liquidity)}
            fill="var(--chart-data)" opacity={0.6}
          />
        )}

        {/* current price hairline + direct label */}
        <line
          x1={x(priceUsd)} x2={x(priceUsd)} y1={PAD.top - 2} y2={PAD.top + PLOT_H}
          stroke="var(--text-muted)" strokeWidth={1}
        />
        <text
          x={x(priceUsd)} y={PAD.top - 4} textAnchor="middle"
          fontSize={10} fill="var(--text-muted)"
        >
          {formatPrice(priceUsd)}
        </text>

        {/* x tick labels */}
        {xTicks.map((t, i) => (
          <text key={i} x={x(t)} y={H - 8}
            textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"}
            fontSize={10} fill="var(--text-faint)"
          >
            {formatPrice(t)}
          </text>
        ))}
      </svg>

      {/* tooltip */}
      {h != null && (
        <div
          className="pointer-events-none absolute top-1 z-10 rounded-lg border border-border bg-bg-elev px-2.5 py-1.5 shadow-lg"
          style={{
            left: `${(x((h.x0 + h.x1) / 2) / W) * 100}%`,
            transform: x((h.x0 + h.x1) / 2) > W * 0.7 ? "translateX(-105%)" : "translateX(8px)",
          }}
        >
          <div className="tnum text-sm font-semibold text-text">
            {maxLiq > 0 ? `${((h.liquidity / maxLiq) * 100).toFixed(0)}% of peak` : "—"}
          </div>
          <div className="tnum text-[11px] text-text-muted">
            {formatPrice(h.x0)} – {formatPrice(h.x1)}
          </div>
        </div>
      )}

      {/* accessible table view */}
      <details className="mt-1">
        <summary className="cursor-pointer text-[11px] text-text-faint hover:text-text-muted">
          Data table
        </summary>
        <div className="mt-1 max-h-48 overflow-y-auto rounded-lg border border-border-soft">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-text-faint">
                <th className="px-2 py-1 font-medium">Price range</th>
                <th className="px-2 py-1 text-right font-medium">Liquidity (share of peak)</th>
              </tr>
            </thead>
            <tbody>
              {topBuckets.map((b, i) => (
                <tr key={i} className="border-t border-border-soft text-text-muted">
                  <td className="tnum px-2 py-1">
                    {formatPrice(b.x0)} – {formatPrice(b.x1)}
                  </td>
                  <td className="tnum px-2 py-1 text-right">
                    {maxLiq > 0 ? `${((b.liquidity / maxLiq) * 100).toFixed(0)}%` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
