// Typed GeckoTerminal fetchers with light concurrency limiting + retry so we stay
// under the ~30 req/min free-tier rate limit.

import { GECKOTERMINAL_API } from "./config";

export interface RawPool {
  id: string;
  type: "pool";
  attributes: {
    address: string;
    name: string;
    pool_created_at: string | null;
    reserve_in_usd: string | null;
    volume_usd: { h24?: string | null } | null;
    price_change_percentage: { h24?: string | null } | null;
    transactions: { h24?: { buys?: number; sells?: number } | null } | null;
  };
  relationships: {
    base_token: { data: { id: string } | null };
    quote_token: { data: { id: string } | null };
    dex: { data: { id: string } | null };
  };
}

interface PoolsPageResponse {
  data?: RawPool[];
}

/** Extract the raw token address from a GeckoTerminal token id like "eth_0xabc..." */
export function addressFromTokenId(id: string | null | undefined): string | null {
  if (!id) return null;
  const idx = id.indexOf("_");
  return idx === -1 ? id.toLowerCase() : id.slice(idx + 1).toLowerCase();
}

// --- Rate-limited scheduler --------------------------------------------------
// GeckoTerminal's free tier allows ~30 requests/minute. We dispatch at most
// `concurrency` requests in flight and space successive dispatches by
// `minIntervalMs`, keeping the whole aggregation comfortably under the limit.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function createLimiter(concurrency: number, minIntervalMs: number) {
  let active = 0;
  let lastDispatch = 0;
  const queue: (() => void)[] = [];

  const pump = async () => {
    if (active >= concurrency || queue.length === 0) return;
    const wait = Math.max(0, lastDispatch + minIntervalMs - Date.now());
    if (wait > 0) {
      setTimeout(pump, wait);
      return;
    }
    lastDispatch = Date.now();
    active++;
    const run = queue.shift()!;
    run();
    // Try to fill remaining concurrency slots (respecting the interval).
    pump();
  };

  return function limit<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        fn()
          .then(resolve, reject)
          .finally(() => {
            active--;
            pump();
          });
      });
      pump();
    });
  };
}

// Serial dispatch, one request every 1.5s => <=~20 req in a full aggregation,
// staying safely under the ~30 req/min free-tier limit.
const limit = createLimiter(1, 1500);

async function fetchWithRetry(url: string, retries = 2): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      // Cache at the Next.js data layer; refresh every 60s.
      next: { revalidate: 60 },
    });
    if (res.status !== 429 || attempt >= retries) return res;
    // Backoff on rate limit: 4s, 8s.
    await sleep(4000 * Math.pow(2, attempt));
  }
}

/**
 * Fetch one page of pools for a (network, dex). Returns [] on any error and
 * pushes a human-readable message to `warnings` instead of throwing, so one bad
 * DEX never breaks the whole aggregation.
 */
export async function fetchPoolsPage(
  networkId: string,
  dexId: string,
  page: number,
  warnings: string[],
): Promise<RawPool[]> {
  const url =
    `${GECKOTERMINAL_API}/networks/${networkId}/dexes/${dexId}/pools` +
    `?page=${page}&sort=h24_volume_usd_desc`;
  return limit(async () => {
    try {
      const res = await fetchWithRetry(url);
      if (!res.ok) {
        warnings.push(`${networkId}/${dexId} p${page}: HTTP ${res.status}`);
        return [];
      }
      const json = (await res.json()) as PoolsPageResponse;
      return json.data ?? [];
    } catch (err) {
      warnings.push(
        `${networkId}/${dexId} p${page}: ${err instanceof Error ? err.message : "fetch failed"}`,
      );
      return [];
    }
  });
}
