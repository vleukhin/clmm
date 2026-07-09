// Daily price-history data layer for range analysis.
//
// Fetches up to ~180 days of daily OHLCV candles for a pool from GeckoTerminal,
// computes volatility statistics over the series, and provides an inversion
// helper so callers can flip the price orientation.
//
// Orientation note (verified live): which token is GeckoTerminal's "base"
// varies PER POOL (e.g. the USDC/WETH 0.05% pool reports base=WETH, but the
// 0.01% pool reports base=USDC). Candles are the price of ONE side in USD, so
// callers must pass `tokenSide` ("base" | "quote") for the token they want —
// for this app, the volatile side (see Pool.volatileIsBase). `invertSeries`
// remains for flipping a ratio series, not for fixing a wrong-side request.
//
// NOTE: lib/geckoterminal.ts owns the same limiter/retry pattern but does not
// export those internals, and it must not be modified while other work is in
// flight, so they are replicated here. Keep the pacing in sync (1 request per
// 2s) so the combined budget stays near the ~30 req/min free tier.

import { GECKOTERMINAL_API } from "./config";

// --- Types -------------------------------------------------------------------

/** One daily OHLCV candle. Prices are base-token-in-USD unless inverted. */
export interface DailyCandle {
  /** UTC calendar day, ISO yyyy-mm-dd. */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Daily traded volume in USD (always USD, regardless of inversion). */
  volumeUsd: number;
}

/** Volatility/range statistics over a candle series (oldest -> newest).
 * Field names say "90d" for the default window; they actually cover whatever
 * series is passed in. All fields are null when the series is too short. */
export interface PriceStats {
  /** Sample stdev of the last (up to) 30 daily log-returns, annualized by
   * sqrt(365). Null when fewer than 5 returns are available. */
  realizedVol30dAnnualized: number | null;
  /** Lowest close in the series. */
  min90d: number | null;
  /** Highest close in the series. */
  max90d: number | null;
  /** Most recent close (the newest candle is the in-progress UTC day, so this
   * tracks the current price). */
  lastClose: number | null;
  /** Mid-rank of the last close among all closes, normalized to 0..1
   * (0 = lowest of the window, 1 = highest, 0.5 = median-ish). */
  percentileOfLast: number | null;
  /** Worst peak-to-trough decline of closes, as a fraction <= 0
   * (e.g. -0.35 = 35% below the running peak). */
  maxDrawdown: number | null;
}

interface OhlcvResponse {
  data?: { attributes?: { ohlcv_list?: number[][] } };
}

// --- Rate-limited fetch (replicated from lib/geckoterminal.ts) ---------------

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

// Serial dispatch, one request every 2s, same pacing as lib/geckoterminal.ts.
const limit = createLimiter(1, 2000);

async function fetchWithRetry(
  url: string,
  revalidate = 60,
  retries = 2,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      // Cache at the Next.js data layer.
      next: { revalidate },
    });
    if (res.status !== 429 || attempt >= retries) return res;
    // Backoff on rate limit: 4s, 8s.
    await sleep(4000 * Math.pow(2, attempt));
  }
}

// --- In-process cache ----------------------------------------------------------

const CACHE_TTL_MS = 30 * 60 * 1000; // daily candles change slowly

interface CacheEntry {
  at: number;
  candles: DailyCandle[];
}

const historyCache = new Map<string, CacheEntry>();

// --- Fetching ------------------------------------------------------------------

/**
 * Fetch up to `days` daily OHLCV candles for a pool, oldest -> newest. The
 * newest candle is the current (partial) UTC day. Results are cached in-process
 * for 30 min per (network, address, days). On any error a human-readable
 * message is pushed to `warnings` and null is returned - never throws.
 */
export async function fetchPriceHistory(
  networkId: string,
  poolAddress: string,
  days = 90,
  warnings: string[] = [],
  tokenSide: "base" | "quote" = "base",
): Promise<DailyCandle[] | null> {
  const address = poolAddress.toLowerCase();
  const cacheKey = `${networkId}_${address}_${days}_${tokenSide}`;
  const hit = historyCache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.candles.map((c) => ({ ...c }));
  }

  // The endpoint returns newest-first candles, max 1000 per request; one
  // candle per day means limit=days covers the window (newest = today).
  const url =
    `${GECKOTERMINAL_API}/networks/${networkId}/pools/${address}/ohlcv/day` +
    `?aggregate=1&limit=${Math.min(Math.max(1, Math.round(days)), 1000)}` +
    `&currency=usd&token=${tokenSide}`;

  return limit(async () => {
    try {
      const res = await fetchWithRetry(url, 1800);
      if (!res.ok) {
        warnings.push(`price history ${networkId}/${address}: HTTP ${res.status}`);
        return null;
      }
      const json = (await res.json()) as OhlcvResponse;
      const list = json.data?.attributes?.ohlcv_list ?? [];

      const candles: DailyCandle[] = [];
      for (const row of list) {
        if (!Array.isArray(row) || row.length < 6) continue;
        const ts = Number(row[0]);
        const open = Number(row[1]);
        const high = Number(row[2]);
        const low = Number(row[3]);
        const close = Number(row[4]);
        const volume = Number(row[5]);
        if (!Number.isFinite(ts) || ts <= 0) continue;
        // Prices must be positive for log-returns and inversion to make sense.
        if (![open, high, low, close].every((v) => Number.isFinite(v) && v > 0)) {
          continue;
        }
        candles.push({
          date: new Date(ts * 1000).toISOString().slice(0, 10),
          open,
          high,
          low,
          close,
          volumeUsd: Number.isFinite(volume) && volume > 0 ? volume : 0,
        });
      }
      if (candles.length === 0) {
        warnings.push(`price history ${networkId}/${address}: no candles returned`);
        return null;
      }
      // API returns newest-first; expose oldest -> newest.
      candles.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

      historyCache.set(cacheKey, { at: Date.now(), candles });
      return candles.map((c) => ({ ...c }));
    } catch (err) {
      warnings.push(
        `price history ${networkId}/${address}: ${err instanceof Error ? err.message : "fetch failed"}`,
      );
      return null;
    }
  });
}

// --- Transformations -------------------------------------------------------------

/**
 * Flip a candle series to the reciprocal price (1/x). High and low swap roles
 * because the reciprocal reverses ordering. Volume stays in USD. Returns new
 * objects; the input is not mutated.
 */
export function invertSeries(candles: DailyCandle[]): DailyCandle[] {
  const inv = (x: number) => (x > 0 ? 1 / x : 0);
  return candles.map((c) => ({
    date: c.date,
    open: inv(c.open),
    high: inv(c.low),
    low: inv(c.high),
    close: inv(c.close),
    volumeUsd: c.volumeUsd,
  }));
}

// --- Statistics --------------------------------------------------------------------

/** Minimum daily log-returns for a meaningful realized-vol estimate. */
const MIN_VOL_RETURNS = 5;

/**
 * Compute volatility/range stats over a series (oldest -> newest). Short or
 * empty series yield nulls for the fields that cannot be computed - never NaN.
 */
export function computeStats(candles: DailyCandle[]): PriceStats {
  const closes = candles
    .map((c) => c.close)
    .filter((v) => Number.isFinite(v) && v > 0);
  const n = closes.length;

  if (n === 0) {
    return {
      realizedVol30dAnnualized: null,
      min90d: null,
      max90d: null,
      lastClose: null,
      percentileOfLast: null,
      maxDrawdown: null,
    };
  }

  const lastClose = closes[n - 1];
  const min90d = Math.min(...closes);
  const max90d = Math.max(...closes);

  // Realized vol: sample stdev of the last (up to) 30 daily log-returns,
  // annualized by sqrt(365) (crypto trades every day).
  let realizedVol30dAnnualized: number | null = null;
  const window = closes.slice(-31);
  const returns: number[] = [];
  for (let i = 1; i < window.length; i++) {
    returns.push(Math.log(window[i] / window[i - 1]));
  }
  if (returns.length >= MIN_VOL_RETURNS) {
    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance =
      returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
    realizedVol30dAnnualized = Math.sqrt(variance) * Math.sqrt(365);
  }

  // Mid-rank percentile of the last close within the whole series, 0..1.
  let percentileOfLast: number | null = null;
  if (n >= 2) {
    let below = 0;
    let equal = 0;
    for (const v of closes) {
      if (v < lastClose) below++;
      else if (v === lastClose) equal++;
    }
    // `equal` >= 1 (the last close itself). Extremes map to exactly 0 and 1.
    percentileOfLast = (below + (equal - 1) / 2) / (n - 1);
  }

  // Max drawdown of closes: worst decline from the running peak, <= 0.
  let maxDrawdown: number | null = null;
  if (n >= 2) {
    let peak = closes[0];
    let worst = 0;
    for (const v of closes) {
      if (v > peak) peak = v;
      const dd = v / peak - 1;
      if (dd < worst) worst = dd;
    }
    maxDrawdown = worst;
  }

  return {
    realizedVol30dAnnualized,
    min90d,
    max90d,
    lastClose,
    percentileOfLast,
    maxDrawdown,
  };
}
