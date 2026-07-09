"use client";

// Daily close line chart with the selected range overlaid as a band.
// Marks per dataviz spec: 2px line, ~10% area wash, hairline solid gridlines,
// crosshair + tooltip (pointer and keyboard), table view for accessibility.

import { useMemo, useRef, useState } from "react";
import type { DailyCandle } from "@/lib/priceHistory";
import { formatPrice, formatUsd } from "@/lib/format";

const W = 720;
const H = 240;
const PAD = { top: 12, right: 12, bottom: 26, left: 56 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

/** ~4 clean axis values across [min, max]. */
function niceTicks(min: number, max: number, count = 4): number[] {
  if (!(max > min)) return [min];
  const span = max - min;
  const step0 = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count + 1) ?? mag * 10;
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + 1e-9; v += step) out.push(v);
  return out;
}

export function PriceChart({
  candles,
  rangeLow,
  rangeHigh,
}: {
  candles: DailyCandle[];
  /** Selected range bounds in the same USD orientation; null = no band. */
  rangeLow: number | null;
  rangeHigh: number | null;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const model = useMemo(() => {
    const closes = candles.map((c) => c.close);
    let lo = Math.min(...closes);
    let hi = Math.max(...closes);
    // Include finite range bounds when they are near the price action.
    for (const b of [rangeLow, rangeHigh]) {
      if (b != null && Number.isFinite(b) && b > lo / 2.5 && b < hi * 2.5) {
        lo = Math.min(lo, b);
        hi = Math.max(hi, b);
      }
    }
    const padY = (hi - lo || hi * 0.01) * 0.06;
    lo -= padY;
    hi += padY;
    const x = (i: number) =>
      PAD.left + (candles.length <= 1 ? 0 : (i / (candles.length - 1)) * PLOT_W);
    const y = (v: number) => PAD.top + PLOT_H - ((v - lo) / (hi - lo)) * PLOT_H;
    const line = closes.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
    const area =
      `${line}L${x(candles.length - 1).toFixed(1)},${(PAD.top + PLOT_H).toFixed(1)}` +
      `L${x(0).toFixed(1)},${(PAD.top + PLOT_H).toFixed(1)}Z`;
    return { lo, hi, x, y, line, area, ticks: niceTicks(lo, hi) };
  }, [candles, rangeLow, rangeHigh]);

  if (candles.length === 0) return null;
  const { lo, hi, x, y, line, area, ticks } = model;

  const clampY = (v: number) => Math.min(Math.max(v, lo), hi);
  const bandTop = rangeHigh != null && rangeLow != null ? y(clampY(Math.min(rangeHigh, hi))) : null;
  const bandBottom = rangeHigh != null && rangeLow != null ? y(clampY(Math.max(rangeLow, lo))) : null;

  const xTickIdx = [0, 0.25, 0.5, 0.75, 1].map((f) =>
    Math.round(f * (candles.length - 1)),
  );

  const setFromClientX = (clientX: number) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const fx = ((clientX - rect.left) / rect.width) * W;
    const frac = (fx - PAD.left) / PLOT_W;
    const i = Math.round(frac * (candles.length - 1));
    setHover(Math.min(Math.max(i, 0), candles.length - 1));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const d = e.key === "ArrowLeft" ? -1 : 1;
      setHover((h) => Math.min(Math.max((h ?? candles.length - 1) + d, 0), candles.length - 1));
    } else if (e.key === "Escape") {
      setHover(null);
    }
  };

  const h = hover != null ? candles[hover] : null;

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="block w-full outline-none focus-visible:ring-1 focus-visible:ring-accent/60 rounded"
        role="img"
        aria-label="Daily close price with selected range band"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerMove={(e) => setFromClientX(e.clientX)}
        onPointerLeave={() => setHover(null)}
        onBlur={() => setHover(null)}
      >
        {/* gridlines + y ticks */}
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)}
              stroke="var(--border-soft)" strokeWidth={1}
            />
            <text
              x={PAD.left - 8} y={y(t) + 3.5} textAnchor="end"
              className="tnum" fontSize={10} fill="var(--text-faint)"
            >
              {formatPrice(t)}
            </text>
          </g>
        ))}

        {/* selected range band */}
        {bandTop != null && bandBottom != null && bandBottom > bandTop && (
          <g>
            <rect
              x={PAD.left} width={PLOT_W}
              y={bandTop} height={bandBottom - bandTop}
              fill="var(--chart-range)" opacity={0.12}
            />
            {rangeHigh != null && rangeHigh <= hi && (
              <line x1={PAD.left} x2={W - PAD.right} y1={bandTop} y2={bandTop}
                stroke="var(--chart-range)" strokeWidth={1} opacity={0.55} />
            )}
            {rangeLow != null && rangeLow >= lo && (
              <line x1={PAD.left} x2={W - PAD.right} y1={bandBottom} y2={bandBottom}
                stroke="var(--chart-range)" strokeWidth={1} opacity={0.55} />
            )}
          </g>
        )}

        {/* series */}
        <path d={area} fill="var(--chart-data)" opacity={0.1} />
        <path d={line} fill="none" stroke="var(--chart-data)" strokeWidth={2}
          strokeLinejoin="round" strokeLinecap="round" />

        {/* x tick labels */}
        {xTickIdx.map((i) => (
          <text key={i} x={x(i)} y={H - 8}
            textAnchor={i === 0 ? "start" : i === candles.length - 1 ? "end" : "middle"}
            fontSize={10} fill="var(--text-faint)"
          >
            {new Date(candles[i].date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
          </text>
        ))}

        {/* crosshair */}
        {hover != null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + PLOT_H}
              stroke="var(--text-faint)" strokeWidth={1} />
            {/* marker with surface ring */}
            <circle cx={x(hover)} cy={y(candles[hover].close)} r={6} fill="var(--bg-elev)" />
            <circle cx={x(hover)} cy={y(candles[hover].close)} r={4} fill="var(--chart-data)" />
          </g>
        )}
      </svg>

      {/* tooltip */}
      {h != null && hover != null && (
        <div
          className="pointer-events-none absolute top-1 z-10 rounded-lg border border-border bg-bg-elev px-2.5 py-1.5 shadow-lg"
          style={{
            left: `${(x(hover) / W) * 100}%`,
            transform: x(hover) > W * 0.7 ? "translateX(-105%)" : "translateX(8px)",
          }}
        >
          <div className="tnum text-sm font-semibold text-text">{formatPrice(h.close)}</div>
          <div className="text-[11px] text-text-muted">
            {new Date(h.date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
            {" · vol "}{formatUsd(h.volumeUsd)}
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
                <th className="px-2 py-1 font-medium">Date</th>
                <th className="px-2 py-1 text-right font-medium">Close</th>
                <th className="px-2 py-1 text-right font-medium">Volume</th>
              </tr>
            </thead>
            <tbody>
              {[...candles].reverse().map((c) => (
                <tr key={c.date} className="border-t border-border-soft text-text-muted">
                  <td className="px-2 py-1">{c.date}</td>
                  <td className="tnum px-2 py-1 text-right">{formatPrice(c.close)}</td>
                  <td className="tnum px-2 py-1 text-right">{formatUsd(c.volumeUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}
