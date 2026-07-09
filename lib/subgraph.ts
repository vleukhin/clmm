// Minimal GraphQL client for The Graph decentralized network (gateway).
// Requires THEGRAPH_API_KEY (server-only). Results are memoized in-process for
// 30 min so repeated /api/pools/apr calls stay well within the free query budget.

const GATEWAY = "https://gateway.thegraph.com/api";
const TTL_MS = 30 * 60_000;

const cache = new Map<string, { at: number; value: unknown }>();

export function hasGraphKey(): boolean {
  return Boolean(process.env.THEGRAPH_API_KEY);
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

/**
 * POST a GraphQL query to a subgraph. Returns the `data` payload, or null on any
 * error (missing key, HTTP error, GraphQL error), recording a message in
 * `warnings` instead of throwing so one bad subgraph never breaks aggregation.
 */
export async function querySubgraph<T>(
  subgraphId: string,
  query: string,
  variables: Record<string, unknown>,
  warnings: string[],
): Promise<T | null> {
  const key = process.env.THEGRAPH_API_KEY;
  if (!key) {
    warnings.push("THEGRAPH_API_KEY not set — using OHLCV estimate");
    return null;
  }

  // Key includes the query text so changing a query's shape (adding a field)
  // never returns a cached payload from the old shape.
  const cacheKey = `${subgraphId}:${query}:${JSON.stringify(variables)}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;

  try {
    const res = await fetch(`${GATEWAY}/${key}/subgraphs/id/${subgraphId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      cache: "no-store",
    });
    if (!res.ok) {
      warnings.push(`subgraph ${subgraphId}: HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as GraphQLResponse<T>;
    if (json.errors?.length) {
      warnings.push(`subgraph ${subgraphId}: ${json.errors[0].message}`);
      return null;
    }
    const data = json.data ?? null;
    if (data !== null) cache.set(cacheKey, { at: Date.now(), value: data });
    return data;
  } catch (err) {
    warnings.push(
      `subgraph ${subgraphId}: ${err instanceof Error ? err.message : "request failed"}`,
    );
    return null;
  }
}
