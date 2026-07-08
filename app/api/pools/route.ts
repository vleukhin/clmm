import { NextResponse } from "next/server";
import { getAllPools } from "@/lib/aggregate";

// Run per request (do not prerender at build time). The underlying GeckoTerminal
// fetches are still cached for 60s via the Data Cache (see geckoterminal.ts),
// so repeated requests within a minute are cheap.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await getAllPools();
    return NextResponse.json(data, {
      headers: {
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120",
      },
    });
  } catch (err) {
    return NextResponse.json(
      {
        pools: [],
        generatedAt: new Date().toISOString(),
        warnings: [err instanceof Error ? err.message : "Aggregation failed"],
      },
      { status: 500 },
    );
  }
}
