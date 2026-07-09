import { NextResponse, type NextRequest } from "next/server";
import { NETWORKS_BY_ID } from "@/lib/config";
import {
  computeStats,
  fetchPriceHistory,
  invertSeries,
  type DailyCandle,
  type PriceStats,
} from "@/lib/priceHistory";

// Run per request; the underlying OHLCV fetch is cached 30 min in-process
// (see lib/priceHistory.ts), mirroring app/api/pools/apr/route.ts.
export const dynamic = "force-dynamic";

const CACHE_CONTROL = "public, s-maxage=1800, stale-while-revalidate=3600";

const DAYS_DEFAULT = 90;
const DAYS_MIN = 30;
const DAYS_MAX = 180;

export interface PoolHistoryResponse {
  /** Daily candles, oldest -> newest. Empty on error responses. */
  series: DailyCandle[];
  /** Stats over `series` in the requested orientation; null when unavailable. */
  stats: PriceStats | null;
  generatedAt: string;
  warnings: string[];
}

/**
 * Parse a pool id of the form `${networkId}_${address}`. Network ids can
 * themselves contain underscores (e.g. "polygon_pos") while EVM addresses
 * cannot, so split on the LAST underscore and validate both halves.
 */
function parsePoolId(
  id: string,
): { networkId: string; address: string } | null {
  const idx = id.lastIndexOf("_");
  if (idx <= 0) return null;
  const networkId = id.slice(0, idx);
  const address = id.slice(idx + 1).toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) return null;
  if (!NETWORKS_BY_ID[networkId]) return null;
  return { networkId, address };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const warnings: string[] = [];

  const parsed = parsePoolId(id);
  if (!parsed) {
    const body: PoolHistoryResponse = {
      series: [],
      stats: null,
      generatedAt: new Date().toISOString(),
      warnings: [
        `malformed pool id "${id}": expected "<networkId>_<0xaddress>" with a known network`,
      ],
    };
    return NextResponse.json(body, { status: 400 });
  }

  const searchParams = request.nextUrl.searchParams;

  const daysRaw = searchParams.get("days");
  let days = DAYS_DEFAULT;
  if (daysRaw !== null) {
    const parsedDays = Number(daysRaw);
    if (Number.isFinite(parsedDays)) {
      days = Math.min(DAYS_MAX, Math.max(DAYS_MIN, Math.round(parsedDays)));
      if (days !== parsedDays) {
        warnings.push(`days=${daysRaw} clamped to ${days} (${DAYS_MIN}..${DAYS_MAX})`);
      }
    } else {
      warnings.push(`days=${daysRaw} is not a number; using ${DAYS_DEFAULT}`);
    }
  }

  const invert = searchParams.get("invert") === "1";

  // Which side of the pool to price ("base" default). The volatile side varies
  // per pool on GeckoTerminal — the client passes it from Pool.volatileIsBase.
  const sideRaw = searchParams.get("side");
  const tokenSide = sideRaw === "quote" ? "quote" : "base";
  if (sideRaw !== null && sideRaw !== "base" && sideRaw !== "quote") {
    warnings.push(`side=${sideRaw} is not "base"|"quote"; using "base"`);
  }

  const candles = await fetchPriceHistory(
    parsed.networkId,
    parsed.address,
    days,
    warnings,
    tokenSide,
  );
  if (candles === null) {
    const body: PoolHistoryResponse = {
      series: [],
      stats: null,
      generatedAt: new Date().toISOString(),
      warnings,
    };
    // Upstream failure: don't cache it at the CDN.
    return NextResponse.json(body, { status: 502 });
  }

  const series = invert ? invertSeries(candles) : candles;
  const body: PoolHistoryResponse = {
    series,
    stats: computeStats(series),
    generatedAt: new Date().toISOString(),
    warnings,
  };
  return NextResponse.json(body, {
    headers: { "Cache-Control": CACHE_CONTROL },
  });
}
