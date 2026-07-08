import { NextResponse } from "next/server";
import { getPoolApr } from "@/lib/aggregate";

// Run per request; underlying OHLCV fetches are cached 30 min (see geckoterminal.ts).
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await getPoolApr();
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=3600",
      },
    });
  } catch (err) {
    return NextResponse.json(
      {
        aprById: {},
        generatedAt: new Date().toISOString(),
        warnings: [err instanceof Error ? err.message : "APR aggregation failed"],
      },
      { status: 500 },
    );
  }
}
