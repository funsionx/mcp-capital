import type { PositionItem } from "./types.ts";
import { isStableSymbol } from "./stablecoins.ts";

interface Bucket {
  valueUsd: number;
  pct: number;
}
export interface Allocation {
  /** By asset class: stock / bond / crypto / etf / defi / mmf / cfa. */
  byCategory: Record<string, Bucket>;
  /** By chain for on-chain assets; brokerage/cash grouped under "offchain". */
  byChain: Record<string, Bucket>;
  /** Share held in USD stablecoins (a rough "dry powder" / low-volatility gauge). */
  stablecoin: Bucket;
}

/** Compute portfolio allocation breakdowns from the position list. */
export function computeAllocation(positions: PositionItem[], totalUsd: number): Allocation {
  const byCategory: Record<string, number> = {};
  const byChain: Record<string, number> = {};
  let stableUsd = 0;

  for (const p of positions) {
    const v = p.value || 0;
    if (v <= 0) continue;
    byCategory[p.category] = (byCategory[p.category] ?? 0) + v;
    const chain = p.chain ?? "offchain";
    byChain[chain] = (byChain[chain] ?? 0) + v;
    if (isStableSymbol(p.ticker) || isStableSymbol(p.currency)) stableUsd += v;
  }

  return {
    byCategory: toBuckets(byCategory, totalUsd),
    byChain: toBuckets(byChain, totalUsd),
    stablecoin: bucket(stableUsd, totalUsd),
  };
}

function toBuckets(raw: Record<string, number>, total: number): Record<string, Bucket> {
  const out: Record<string, Bucket> = {};
  // Largest first so the agent reads the meaningful buckets up top; skip sub-$1
  // dust buckets to keep the breakdown compact.
  for (const [k, v] of Object.entries(raw).sort((a, b) => b[1] - a[1])) {
    if (v < 1) continue;
    out[k] = bucket(v, total);
  }
  return out;
}

function bucket(value: number, total: number): Bucket {
  return {
    valueUsd: Math.round(value * 100) / 100,
    pct: total > 0 ? Math.round((value / total) * 1000) / 10 : 0,
  };
}
