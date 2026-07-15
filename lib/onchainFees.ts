// On-chain swap-fee reader for dynamic-fee CLMM pools (Aerodrome Slipstream).
//
// WHY: Slipstream pools route `fee()` through the factory's swap-fee module, so
// the live fee can differ wildly from the static tier the pool was created with
// (e.g. the "1%" cbBTC/USDC pool on Base actually charges 0.037%). Subgraphs
// and GeckoTerminal names both carry the static tier, which inflates every
// fee-derived APR — verified on-chain 2026-07-15. Slipstream also skims
// `unstakedFee()` (e.g. 10%) from fees earned by unstaked positions (staked
// positions forfeit swap fees entirely for AERO emissions), so the share of
// fees an unstaked LP keeps is (1 - unstakedFee).
//
// All pools of a chain are read in ONE eth_call via Multicall3 (deployed at the
// same address on every major EVM chain). ABI encoding/decoding is done by hand
// (exported for tests) to avoid pulling in a web3 library for two uint24 reads.
// Results are memoized in-process for 30 min, matching lib/subgraph.ts.

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const SEL_AGGREGATE3 = "0x82ad56cb"; // aggregate3((address,bool,bytes)[])
const SEL_FEE = "0xddca3f43"; // fee() -> uint24
const SEL_UNSTAKED_FEE = "0xb64cc67b"; // unstakedFee() -> uint24
/** Uniswap-v3-style fee units: 1e6 = 100% (fee 500 = 0.05%). */
const FEE_DENOM = 1e6;
const TTL_MS = 30 * 60_000;

/** Live fee terms of one pool, as fractions. */
export interface PoolSwapFee {
  /** Current swap fee as a fraction of volume (e.g. 0.000282 = 0.0282%). */
  fee: number;
  /** Share of earned fees an unstaked LP keeps: 1 - unstakedFee (e.g. 0.9). */
  lpFeeShare: number;
}

const cache = new Map<string, { at: number; value: PoolSwapFee }>();

const WORD = 64; // hex chars per 32-byte word

function padWord(hex: string): string {
  return hex.padStart(WORD, "0");
}

/**
 * Calldata for Multicall3.aggregate3 where every call is a no-argument getter
 * (4-byte calldata) with allowFailure = true. `targets` are 0x-addresses,
 * `selectors[i]` the 4-byte selector for call i (same length as targets).
 */
export function encodeAggregate3(targets: string[], selectors: string[]): string {
  if (targets.length !== selectors.length) {
    throw new RangeError("targets and selectors must have equal length");
  }
  const n = targets.length;
  // Head: offset to the Call3[] array (always 0x20), then array length.
  let data = padWord("20") + padWord(n.toString(16));
  // Offsets of each element, relative to the start of the elements area.
  const ELEMENT_WORDS = 5; // target, allowFailure, bytes offset, bytes len, payload
  for (let i = 0; i < n; i++) {
    data += padWord(((n + i * ELEMENT_WORDS) * 32).toString(16));
  }
  for (let i = 0; i < n; i++) {
    data +=
      padWord(targets[i].toLowerCase().replace(/^0x/, "")) + // address
      padWord("1") + // allowFailure = true
      padWord("60") + // offset of `bytes callData` within the element
      padWord("4") + // callData length: bare selector
      selectors[i].replace(/^0x/, "").padEnd(WORD, "0"); // right-padded
  }
  return SEL_AGGREGATE3 + data;
}

/**
 * Decode Multicall3.aggregate3's `(bool success, bytes returnData)[]` result.
 * Returns one entry per call: the first 32-byte word of returnData as a number
 * (all fees fit far below 2^53), or null if the call failed / returned nothing.
 */
export function decodeAggregate3(hexResult: string): (number | null)[] {
  const hex = hexResult.replace(/^0x/, "");
  const word = (i: number): bigint => {
    const chunk = hex.slice(i * WORD, (i + 1) * WORD);
    if (chunk.length < WORD) throw new RangeError("truncated multicall result");
    return BigInt("0x" + chunk);
  };
  const arrayPos = Number(word(0)) / 32; // word index of the array length
  const n = Number(word(arrayPos));
  const out: (number | null)[] = [];
  for (let i = 0; i < n; i++) {
    // Element offsets are relative to the first word after the array length;
    // within an element, the bytes offset is relative to the element start.
    const elem = arrayPos + 1 + Number(word(arrayPos + 1 + i)) / 32;
    const success = word(elem) === BigInt(1);
    const bytesPos = elem + Number(word(elem + 1)) / 32;
    const bytesLen = Number(word(bytesPos));
    out.push(success && bytesLen >= 32 ? Number(word(bytesPos + 1)) : null);
  }
  return out;
}

/**
 * Read {fee(), unstakedFee()} for many pools in one Multicall3 eth_call.
 * Keyed by LOWERCASED pool address. Pools whose fee read fails are omitted
 * (with a warning); a missing unstakedFee getter just means no skim (share 1).
 * Never throws — on transport errors it returns whatever the cache has.
 */
export async function fetchPoolFees(
  rpcUrl: string,
  addresses: string[],
  warnings: string[],
): Promise<Map<string, PoolSwapFee>> {
  const result = new Map<string, PoolSwapFee>();
  const missing: string[] = [];
  for (const addr of addresses) {
    const a = addr.toLowerCase();
    const hit = cache.get(`${rpcUrl}:${a}`);
    if (hit && Date.now() - hit.at < TTL_MS) result.set(a, hit.value);
    else missing.push(a);
  }
  if (missing.length === 0) return result;

  const targets = missing.flatMap((a) => [a, a]);
  const selectors = missing.flatMap(() => [SEL_FEE, SEL_UNSTAKED_FEE]);

  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: MULTICALL3, data: encodeAggregate3(targets, selectors) }, "latest"],
      }),
      cache: "no-store",
      // A hung public RPC must not stall the whole pools endpoint; callers
      // degrade gracefully (keep subgraph fees / null feeTierActual).
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      warnings.push(`onchain fees ${rpcUrl}: HTTP ${res.status}`);
      return result;
    }
    const json = (await res.json()) as { result?: string; error?: { message?: string } };
    if (!json.result) {
      warnings.push(`onchain fees ${rpcUrl}: ${json.error?.message ?? "empty result"}`);
      return result;
    }
    const words = decodeAggregate3(json.result);
    for (let i = 0; i < missing.length; i++) {
      const feeRaw = words[i * 2];
      const unstakedRaw = words[i * 2 + 1];
      if (feeRaw == null || !(feeRaw > 0) || feeRaw >= FEE_DENOM) {
        warnings.push(`onchain fees: no fee() from pool ${missing[i]}`);
        continue;
      }
      const skim =
        unstakedRaw != null && unstakedRaw >= 0 && unstakedRaw < FEE_DENOM
          ? unstakedRaw / FEE_DENOM
          : 0;
      const value: PoolSwapFee = { fee: feeRaw / FEE_DENOM, lpFeeShare: 1 - skim };
      cache.set(`${rpcUrl}:${missing[i]}`, { at: Date.now(), value });
      result.set(missing[i], value);
    }
  } catch (err) {
    warnings.push(
      `onchain fees ${rpcUrl}: ${err instanceof Error ? err.message : "request failed"}`,
    );
  }
  return result;
}
