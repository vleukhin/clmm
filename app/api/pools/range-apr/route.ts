import { NextResponse } from "next/server";
import { getPoolRangeData } from "@/lib/rangeApr";

// Run per request; underlying subgraph/OHLCV fetches are cached 30 min.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await getPoolRangeData();
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=3600",
      },
    });
  } catch (err) {
    return NextResponse.json(
      {
        byId: {},
        generatedAt: new Date().toISOString(),
        warnings: [err instanceof Error ? err.message : "Range APR failed"],
      },
      { status: 500 },
    );
  }
}
