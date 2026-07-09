import { NextResponse, type NextRequest } from "next/server";
import { NETWORKS_BY_ID } from "@/lib/config";
import { poolTickData } from "@/lib/ticks";

// Run per request; subgraph responses are cached 30 min (see lib/subgraph.ts).
export const dynamic = "force-dynamic";

const CACHE_HEADERS = {
  "Cache-Control": "public, s-maxage=1800, stale-while-revalidate=3600",
};

/**
 * GET /api/pools/[id]/ticks?dex=<dexId>
 *
 * `id` is `${networkId}_${address}` (networkId itself may contain underscores,
 * e.g. "polygon_pos", so the address is everything after the LAST underscore).
 * The dex id is required to resolve which subgraph serves this pool.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const sep = id.lastIndexOf("_");
  const networkId = sep > 0 ? id.slice(0, sep) : "";
  const address = sep > 0 ? id.slice(sep + 1) : "";
  if (!networkId || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json(
      { error: `invalid pool id "${id}" — expected "<networkId>_<0x-address>"` },
      { status: 400 },
    );
  }

  const network = NETWORKS_BY_ID[networkId];
  if (!network) {
    return NextResponse.json(
      { error: `unknown network "${networkId}"` },
      { status: 404 },
    );
  }

  const dexId = request.nextUrl.searchParams.get("dex");
  if (!dexId) {
    return NextResponse.json(
      { error: "missing required query parameter: dex" },
      { status: 400 },
    );
  }

  const dex = network.dexes.find((d) => d.id === dexId);
  if (!dex) {
    return NextResponse.json(
      { error: `unknown dex "${dexId}" on network "${networkId}"` },
      { status: 404 },
    );
  }
  if (!dex.subgraph) {
    return NextResponse.json(
      { error: `no subgraph configured for this dex ("${dexId}" on "${networkId}")` },
      { status: 400 },
    );
  }

  const warnings: string[] = [];
  try {
    const data = await poolTickData(dex.subgraph.id, address, warnings);
    if (!data) {
      const notFound = warnings.some((w) => w.includes("not found in subgraph"));
      return NextResponse.json(
        {
          error: notFound
            ? `pool ${address.toLowerCase()} not found in the "${dexId}" subgraph`
            : "failed to load tick data from subgraph",
          warnings,
        },
        { status: notFound ? 404 : 502 },
      );
    }
    return NextResponse.json(
      {
        pool: data.pool,
        segments: data.segments,
        generatedAt: new Date().toISOString(),
        warnings,
      },
      { headers: CACHE_HEADERS },
    );
  } catch (err) {
    return NextResponse.json(
      {
        pool: null,
        segments: [],
        generatedAt: new Date().toISOString(),
        warnings: [
          ...warnings,
          err instanceof Error ? err.message : "tick data fetch failed",
        ],
      },
      { status: 500 },
    );
  }
}
