import { NextResponse } from "next/server";
import { getPoolRewards } from "@/lib/rewards";

// Run per request; underlying DefiLlama/Merkl fetches are cached 30 min (lib/rewards.ts).
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const data = await getPoolRewards();
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
        warnings: [err instanceof Error ? err.message : "Rewards aggregation failed"],
      },
      { status: 500 },
    );
  }
}
