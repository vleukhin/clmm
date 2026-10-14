// Pure helpers for attaching external LP-rewards data to our pools. No imports
// (like rangeMath.ts) so `node --test` can load it without a bundler.

/** The subset of a DefiLlama yields row we match on. */
export interface LlamaPool {
  chain: string;
  project: string;
  symbol: string;
  /** Lowercased token addresses. */
  underlyingTokens: string[];
  /** e.g. "0.05%" (Uniswap-style tier) or "CL100 - 0.0579%" (Slipstream). */
  poolMeta: string | null;
  tvlUsd: number;
  /** Percent, e.g. 22.4 for 22.4%. */
  apyReward: number | null;
  /** Reward token addresses. */
  rewardTokens: string[];
}

export interface RewardComponent {
  source: "defillama" | "merkl";
  apr: number;
  tokens: string[];
}

export interface PoolRewards {
  rewardApr: number;
  tokens: string[];
  components: RewardComponent[];
}

/** Pool fields needed to find its DefiLlama row. */
export interface MatchablePool {
  volatileAddress: string;
  stableAddress: string;
  feeTier: number | null;
  tickSpacing?: number | null;
  tvlUsd: number;
}

/** Parse DefiLlama `poolMeta`: "CL100 - 0.0579%" -> tick spacing 100 + fee as a
 * fraction; "0.05%" -> fee only. Unknown shapes yield nulls. */
export function parseLlamaPoolMeta(meta: string | null | undefined): {
  tickSpacing: number | null;
  fee: number | null;
} {
  if (!meta) return { tickSpacing: null, fee: null };
  const cl = meta.match(/\bCL(\d+)\b/);
  const pct = meta.match(/([\d.]+)\s*%/);
  const tickSpacing = cl ? parseInt(cl[1], 10) : null;
  const feePct = pct ? parseFloat(pct[1]) : NaN;
  return {
    tickSpacing: tickSpacing != null && Number.isFinite(tickSpacing) ? tickSpacing : null,
    fee: Number.isFinite(feePct) ? feePct / 100 : null,
  };
}

/** Order-independent key for a token pair (lowercased). */
export function pairKey(a: string, b: string): string {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? `${x}:${y}` : `${y}:${x}`;
}

/** When several rows share the pair + tier (DefiLlama occasionally lists a
 * pool twice), the one whose TVL is closest to ours wins — but only within
 * this factor; anything further off is treated as a different pool. */
const MAX_TVL_RATIO = 3;

/**
 * Pick the DefiLlama row for `pool` among `candidates` (already filtered to the
 * right chain + project). Matches on the token pair, then on tick spacing when
 * we have it (Slipstream: several CL pools per pair), else on fee tier.
 * Returns null when nothing or something ambiguous matches.
 */
export function matchLlamaPool(
  pool: MatchablePool,
  candidates: LlamaPool[],
): LlamaPool | null {
  const key = pairKey(pool.volatileAddress, pool.stableAddress);
  const samePair = candidates.filter(
    (c) => c.underlyingTokens.length === 2 && pairKey(c.underlyingTokens[0], c.underlyingTokens[1]) === key,
  );
  if (samePair.length === 0) return null;

  let hits: LlamaPool[];
  if (pool.tickSpacing != null) {
    hits = samePair.filter((c) => parseLlamaPoolMeta(c.poolMeta).tickSpacing === pool.tickSpacing);
  } else if (pool.feeTier != null) {
    const tier = pool.feeTier;
    hits = samePair.filter((c) => {
      const fee = parseLlamaPoolMeta(c.poolMeta).fee;
      return fee != null && Math.abs(fee - tier) < 1e-9;
    });
  } else {
    hits = samePair.length === 1 ? samePair : [];
  }
  if (hits.length === 0) return null;
  if (hits.length === 1) return hits[0];

  // Tie-break by TVL proximity (log ratio), within a sanity bound.
  if (!(pool.tvlUsd > 0)) return null;
  let best: LlamaPool | null = null;
  let bestDist = Infinity;
  for (const c of hits) {
    if (!(c.tvlUsd > 0)) continue;
    const d = Math.abs(Math.log(c.tvlUsd / pool.tvlUsd));
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best && bestDist <= Math.log(MAX_TVL_RATIO) ? best : null;
}

/** Sum components into one figure; null when there is nothing positive. */
export function mergeRewardComponents(components: RewardComponent[]): PoolRewards | null {
  const live = components.filter((c) => Number.isFinite(c.apr) && c.apr > 0);
  if (live.length === 0) return null;
  const tokens: string[] = [];
  for (const c of live) for (const t of c.tokens) if (!tokens.includes(t)) tokens.push(t);
  return {
    rewardApr: live.reduce((s, c) => s + c.apr, 0),
    tokens,
    components: live,
  };
}

/** "0x940181a9…8631" for reward tokens we have no symbol for. */
export function shortAddress(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr;
}
