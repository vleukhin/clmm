// Extra LP rewards (on top of swap fees) from two keyless sources:
//
//  * DefiLlama yields — `apyReward` for DEXes whose incentives are native gauge
//    emissions (Aerodrome's AERO). Only DEXes with `llamaProject` in config use
//    it: DefiLlama's reward figure for Uniswap/Sushi is itself Merkl-sourced.
//    No pool address in the free payload, so rows are matched by pair + tick
//    spacing / fee tier (lib/rewardsMatch.ts).
//  * Merkl v4 — live incentive campaigns keyed by (chainId, pool address), any
//    DEX. Exact match.
//
// Components from the two sources cover different mechanisms and are summed.
// Both payloads are memoized in-process for 30 min (the DefiLlama one is ~12 MB,
// too big for the Next.js data cache). Never throws: failures go to `warnings`.

import { DEFILLAMA_YIELDS_API, MERKL_API, NETWORKS, NETWORKS_BY_ID, REWARD_TOKEN_SYMBOLS } from "./config";
import { getAllPools } from "./aggregate";
import {
  matchLlamaPool,
  mergeRewardComponents,
  shortAddress,
  type LlamaPool,
  type RewardComponent,
} from "./rewardsMatch";
import type { PoolRewards, PoolRewardsResponse } from "./types";

const TTL_MS = 30 * 60_000;
const FETCH_TIMEOUT_MS = 20_000;
const MERKL_PAGE_SIZE = 100; // the API rejects larger pages (HTTP 400)
const MERKL_MAX_PAGES = 10;

interface CacheEntry<T> {
  at: number;
  value: T;
}
let llamaCache: CacheEntry<LlamaPool[]> | null = null;
const merklCache = new Map<number, CacheEntry<Map<string, MerklReward>>>();

/** Live Merkl rewards for one pool. */
interface MerklReward {
  apr: number;
  tokens: string[];
}

// --- DefiLlama -----------------------------------------------------------------

interface LlamaRow {
  chain?: string;
  project?: string;
  symbol?: string;
  underlyingTokens?: string[] | null;
  poolMeta?: string | null;
  tvlUsd?: number | null;
  apyReward?: number | null;
  rewardTokens?: string[] | null;
}

/** DefiLlama rows for the (chain, project) combos we care about. */
export async function fetchLlamaPools(warnings: string[]): Promise<LlamaPool[]> {
  if (llamaCache && Date.now() - llamaCache.at < TTL_MS) return llamaCache.value;

  const wanted = new Set<string>();
  for (const n of NETWORKS) {
    for (const d of n.dexes) if (d.llamaProject) wanted.add(`${n.llamaChain}|${d.llamaProject}`);
  }
  if (wanted.size === 0) return [];

  try {
    const res = await fetch(DEFILLAMA_YIELDS_API, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      warnings.push(`defillama yields: HTTP ${res.status}`);
      return llamaCache?.value ?? [];
    }
    const json = (await res.json()) as { data?: LlamaRow[] };
    const rows: LlamaPool[] = [];
    for (const r of json.data ?? []) {
      if (!r.chain || !r.project || !wanted.has(`${r.chain}|${r.project}`)) continue;
      rows.push({
        chain: r.chain,
        project: r.project,
        symbol: r.symbol ?? "",
        underlyingTokens: (r.underlyingTokens ?? []).map((t) => t.toLowerCase()),
        poolMeta: r.poolMeta ?? null,
        tvlUsd: r.tvlUsd ?? 0,
        apyReward: r.apyReward ?? null,
        rewardTokens: (r.rewardTokens ?? []).map((t) => t.toLowerCase()),
      });
    }
    llamaCache = { at: Date.now(), value: rows };
    return rows;
  } catch (err) {
    warnings.push(`defillama yields: ${err instanceof Error ? err.message : "request failed"}`);
    return llamaCache?.value ?? [];
  }
}

// --- Merkl ---------------------------------------------------------------------

interface MerklOpportunity {
  identifier?: string;
  status?: string;
  apr?: number | null;
  rewardsRecord?: {
    breakdowns?: { token?: { symbol?: string; address?: string } }[];
  } | null;
}

/** Live Merkl pool campaigns on a chain, keyed by lowercased pool address. */
export async function fetchMerklOpportunities(
  chainId: number,
  warnings: string[],
): Promise<Map<string, MerklReward>> {
  const hit = merklCache.get(chainId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const out = new Map<string, MerklReward>();
  try {
    for (let page = 0; page < MERKL_MAX_PAGES; page++) {
      const url =
        `${MERKL_API}/opportunities?chainId=${chainId}&status=LIVE&action=POOL` +
        `&items=${MERKL_PAGE_SIZE}&page=${page}`;
      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        warnings.push(`merkl chain ${chainId}: HTTP ${res.status}`);
        return hit?.value ?? out;
      }
      const list = (await res.json()) as MerklOpportunity[];
      for (const o of list) {
        if (!o.identifier || !(o.apr != null && o.apr > 0)) continue;
        const addr = o.identifier.toLowerCase();
        const tokens: string[] = [];
        for (const b of o.rewardsRecord?.breakdowns ?? []) {
          const sym =
            b.token?.symbol ||
            (b.token?.address ? REWARD_TOKEN_SYMBOLS[b.token.address.toLowerCase()] : undefined) ||
            (b.token?.address ? shortAddress(b.token.address) : undefined);
          if (sym && !tokens.includes(sym)) tokens.push(sym);
        }
        // Several opportunities can target one pool (e.g. two campaigns); sum.
        const prev = out.get(addr);
        out.set(addr, {
          apr: (prev?.apr ?? 0) + o.apr / 100,
          tokens: prev ? [...prev.tokens, ...tokens.filter((t) => !prev.tokens.includes(t))] : tokens,
        });
      }
      if (list.length < MERKL_PAGE_SIZE) break;
    }
    merklCache.set(chainId, { at: Date.now(), value: out });
    return out;
  } catch (err) {
    warnings.push(`merkl chain ${chainId}: ${err instanceof Error ? err.message : "request failed"}`);
    return hit?.value ?? out;
  }
}

// --- Aggregation ---------------------------------------------------------------

function tokenSymbol(addr: string): string {
  return REWARD_TOKEN_SYMBOLS[addr.toLowerCase()] ?? shortAddress(addr);
}

/** Rewards APR per pool id for the whole pool universe. */
export async function getPoolRewards(): Promise<PoolRewardsResponse> {
  const warnings: string[] = [];
  const { pools } = await getAllPools();

  const chainIds = Array.from(new Set(pools.map((p) => NETWORKS_BY_ID[p.networkId]?.chainId)))
    .filter((id): id is number => typeof id === "number");

  const [llama, ...merklPerChain] = await Promise.all([
    fetchLlamaPools(warnings),
    ...chainIds.map((id) => fetchMerklOpportunities(id, warnings)),
  ]);
  const merklByChain = new Map(chainIds.map((id, i) => [id, merklPerChain[i]]));

  const byId: Record<string, PoolRewards> = {};
  for (const pool of pools) {
    const network = NETWORKS_BY_ID[pool.networkId];
    const dex = network?.dexes.find((d) => d.id === pool.dexId);
    if (!network || !dex) continue;
    const components: RewardComponent[] = [];

    if (dex.llamaProject) {
      const candidates = llama.filter(
        (r) => r.chain === network.llamaChain && r.project === dex.llamaProject,
      );
      const row = matchLlamaPool(pool, candidates);
      if (row && row.apyReward != null && row.apyReward > 0) {
        components.push({
          source: "defillama",
          apr: row.apyReward / 100,
          tokens: row.rewardTokens.map(tokenSymbol),
        });
      }
    }

    const merkl = merklByChain.get(network.chainId)?.get(pool.address.toLowerCase());
    if (merkl) components.push({ source: "merkl", apr: merkl.apr, tokens: merkl.tokens });

    const merged = mergeRewardComponents(components);
    if (merged) byId[pool.id] = merged;
  }

  return { byId, generatedAt: new Date().toISOString(), warnings };
}
