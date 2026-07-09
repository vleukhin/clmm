// Tick-level liquidity data layer (uniswap-v3 subgraph schema).
//
// Fetches a pool's current state plus ALL initialized ticks, then reconstructs
// the active-liquidity curve: walking ticks in ascending order, active
// liquidity in the segment starting at an initialized tick is the cumulative
// sum of `liquidityNet` up to and including that tick. Liquidity values are
// 128-bit, so all accumulation uses BigInt and JSON serializes them as strings.
//
// NOTE: querySubgraph caches by (subgraphId, variables) only — the query text
// is NOT part of the cache key. Variable names here (`poolId`, `gtTick`) are
// deliberately distinctive so they can't collide with other queries against
// the same subgraph.

import { querySubgraph } from "./subgraph";

// ---------------------------------------------------------------------------
// Types (local to this module by design — see AGENTS/task constraints).
// ---------------------------------------------------------------------------

export interface TickPoolToken {
  symbol: string;
  decimals: number;
}

/** Pool state snapshot from the subgraph, normalized for JSON transport. */
export interface TickPoolMeta {
  /** Lowercased on-chain pool address. */
  address: string;
  /** Current tick the pool price sits in. */
  currentTick: number;
  /** Decimals-adjusted price of token0 in token1 units (from sqrtPrice). */
  currentPrice1per0: number;
  /** Raw Q64.96 sqrt price, as a decimal string. */
  sqrtPrice: string;
  /** In-range liquidity reported by the pool, 128-bit, as a decimal string. */
  liquidity: string;
  /** Fee tier as a fraction (e.g. 0.0005 for 0.05%). */
  feeTier: number;
  /** Raw subgraph fee tier in hundredths of a bip (e.g. "500"). */
  feeTierRaw: string;
  token0: TickPoolToken;
  token1: TickPoolToken;
}

/**
 * One liquidity segment: active liquidity from this initialized tick up to
 * (but not including) the next initialized tick.
 */
export interface LiquiditySegment {
  tickIdx: number;
  /** Cumulative active liquidity in this segment (BigInt as decimal string). */
  activeLiquidity: string;
  /** Decimals-adjusted price of token0 in token1 units at `tickIdx`. */
  price1per0: number;
}

export interface PoolTickData {
  pool: TickPoolMeta;
  segments: LiquiditySegment[];
}

// ---------------------------------------------------------------------------
// Price helpers
// ---------------------------------------------------------------------------

/**
 * Decimals-adjusted price of token0 in token1 units at a tick:
 * 1.0001^tick x 10^(decimals0 - decimals1). Safe as a double across the full
 * tick range (+/-887272 => ~1e+/-38.5).
 */
export function price1per0(
  tick: number,
  decimals0: number,
  decimals1: number,
): number {
  return Math.pow(1.0001, tick) * Math.pow(10, decimals0 - decimals1);
}

const Q96 = Math.pow(2, 96);

/** Same price derived from the pool's Q64.96 sqrtPrice (more precise). */
function priceFromSqrtPrice(
  sqrtPrice: string,
  decimals0: number,
  decimals1: number,
): number {
  const ratio = Number(sqrtPrice) / Q96;
  return ratio * ratio * Math.pow(10, decimals0 - decimals1);
}

// ---------------------------------------------------------------------------
// Subgraph queries
// ---------------------------------------------------------------------------

const POOL_QUERY = `
  query($poolId: ID!) {
    pool(id: $poolId) {
      tick
      liquidity
      sqrtPrice
      feeTier
      token0 { symbol decimals }
      token1 { symbol decimals }
    }
  }
`;

// Cursor-paginated: `tickIdx_gt` walks pages in ascending tickIdx order.
const TICKS_QUERY = `
  query($poolId: String!, $gtTick: BigInt!) {
    ticks(
      first: 1000
      where: { pool: $poolId, tickIdx_gt: $gtTick }
      orderBy: tickIdx
      orderDirection: asc
    ) {
      tickIdx
      liquidityNet
    }
  }
`;

interface SubgraphPool {
  tick: string | null;
  liquidity: string;
  sqrtPrice: string;
  feeTier: string;
  token0: { symbol: string; decimals: string };
  token1: { symbol: string; decimals: string };
}

interface SubgraphTick {
  tickIdx: string;
  liquidityNet: string;
}

const PAGE_SIZE = 1000;
/** Hard stop: 50 pages = 50k initialized ticks (majors have hundreds). */
const MAX_PAGES = 50;
/** Below the minimum possible tick (-887272), so the first page includes it. */
const CURSOR_START = "-887273";

// ---------------------------------------------------------------------------
// Fetch + reconstruct
// ---------------------------------------------------------------------------

/**
 * Fetch pool state and the full initialized-tick liquidity distribution from a
 * uniswap-v3-schema subgraph. Returns null on failure (details pushed into
 * `warnings`, mirroring querySubgraph's contract). Non-fatal anomalies (e.g.
 * the cumulative-liquidity sanity check failing) only add warnings.
 */
export async function poolTickData(
  subgraphId: string,
  poolAddress: string,
  warnings: string[],
): Promise<PoolTickData | null> {
  // Subgraph entity ids are lowercased addresses.
  const address = poolAddress.toLowerCase();

  const poolRes = await querySubgraph<{ pool: SubgraphPool | null }>(
    subgraphId,
    POOL_QUERY,
    { poolId: address },
    warnings,
  );
  if (!poolRes) return null; // querySubgraph already recorded a warning
  const pool = poolRes.pool;
  if (!pool) {
    warnings.push(`pool ${address} not found in subgraph ${subgraphId}`);
    return null;
  }
  if (pool.tick == null) {
    warnings.push(`pool ${address}: subgraph has no current tick (uninitialized pool)`);
    return null;
  }

  // Page through all initialized ticks with a tickIdx_gt cursor.
  const ticks: SubgraphTick[] = [];
  let cursor = CURSOR_START;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await querySubgraph<{ ticks: SubgraphTick[] }>(
      subgraphId,
      TICKS_QUERY,
      { poolId: address, gtTick: cursor },
      warnings,
    );
    if (!res) return null;
    ticks.push(...res.ticks);
    if (res.ticks.length < PAGE_SIZE) break;
    cursor = res.ticks[res.ticks.length - 1].tickIdx;
    if (page === MAX_PAGES - 1) {
      warnings.push(
        `pool ${address}: tick pagination stopped at ${ticks.length} ticks (MAX_PAGES)`,
      );
    }
  }
  if (ticks.length === 0) {
    warnings.push(`pool ${address}: subgraph returned no initialized ticks`);
  }

  const decimals0 = Number(pool.token0.decimals);
  const decimals1 = Number(pool.token1.decimals);
  const currentTick = Number(pool.tick);

  // Cumulative sum of liquidityNet in ascending tickIdx order = active
  // liquidity for the segment starting at each initialized tick.
  const segments: LiquiditySegment[] = [];
  let cumulative = BigInt(0);
  let sawNegative = false;
  for (const t of ticks) {
    const tickIdx = Number(t.tickIdx);
    cumulative += BigInt(t.liquidityNet);
    if (cumulative < BigInt(0)) sawNegative = true;
    segments.push({
      tickIdx,
      activeLiquidity: cumulative.toString(),
      price1per0: price1per0(tickIdx, decimals0, decimals1),
    });
  }
  if (sawNegative) {
    warnings.push(
      `pool ${address}: negative cumulative liquidity encountered (subgraph data anomaly)`,
    );
  }

  // Sanity check: active liquidity in the segment containing the current tick
  // must match the pool's reported in-range liquidity.
  let atCurrent = BigInt(0); // below the first initialized tick => 0
  for (const s of segments) {
    if (s.tickIdx > currentTick) break;
    atCurrent = BigInt(s.activeLiquidity);
  }
  if (atCurrent !== BigInt(pool.liquidity)) {
    warnings.push(
      `pool ${address}: reconstructed liquidity at current tick (${atCurrent}) != pool.liquidity (${pool.liquidity})`,
    );
  }

  return {
    pool: {
      address,
      currentTick,
      currentPrice1per0: priceFromSqrtPrice(pool.sqrtPrice, decimals0, decimals1),
      sqrtPrice: pool.sqrtPrice,
      liquidity: pool.liquidity,
      feeTier: Number(pool.feeTier) / 1_000_000,
      feeTierRaw: pool.feeTier,
      token0: { symbol: pool.token0.symbol, decimals: decimals0 },
      token1: { symbol: pool.token1.symbol, decimals: decimals1 },
    },
    segments,
  };
}

// ---------------------------------------------------------------------------
// Range helper
// ---------------------------------------------------------------------------

/**
 * Tick-width-weighted average active liquidity over [tickLower, tickUpper).
 * Pure BigInt math over the segment list; ticks below the first initialized
 * tick contribute zero liquidity. Returns the exact value as a decimal string
 * plus a lossy Number for convenience. Zero if the range is empty/inverted.
 */
export function activeLiquidityInRange(
  segments: LiquiditySegment[],
  tickLower: number,
  tickUpper: number,
): { liquidity: string; liquidityNumber: number } {
  const width = tickUpper - tickLower;
  if (width <= 0 || segments.length === 0) {
    return { liquidity: "0", liquidityNumber: 0 };
  }

  let weighted = BigInt(0);
  for (let i = 0; i < segments.length; i++) {
    const start = segments[i].tickIdx;
    if (start >= tickUpper) break;
    // Segment extends to the next initialized tick; the last one is clamped
    // to the range end (its liquidity is normally zero anyway).
    const end = i + 1 < segments.length ? segments[i + 1].tickIdx : tickUpper;
    const overlap = Math.min(end, tickUpper) - Math.max(start, tickLower);
    if (overlap <= 0) continue;
    weighted += BigInt(segments[i].activeLiquidity) * BigInt(overlap);
  }

  const avg = weighted / BigInt(width);
  return { liquidity: avg.toString(), liquidityNumber: Number(avg) };
}
