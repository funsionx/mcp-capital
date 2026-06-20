import type { PositionItem } from "../lib/types.ts";
import { getUsdRub } from "../lib/usdRub.ts";
import { computeAllocation, type Allocation } from "../lib/analytics.ts";
import { sourceLabel, staticLabel } from "../lib/labels.ts";
import { SOURCE_IDS, type SourceFilter, fetchFor } from "../sources/index.ts";
import { stringifyErr } from "../lib/http.ts";

/** Hard cap per source so one slow/hung API can't make the whole build hang. */
const SOURCE_TIMEOUT_MS = 18_000;

export interface SourceBreakdownEntry {
  label: string;
  valueUsd: number;
  positionCount: number;
}

/** The raw, untrimmed portfolio — shared by the live tool and the snapshot writer. */
export interface Portfolio {
  timestamp: string;
  totalValueUsd: number;
  totalValueRub: number;
  positionCount: number;
  sourceBreakdown: Record<string, SourceBreakdownEntry>;
  allocation: Allocation;
  positions: PositionItem[];
  errors: { source: string; error: string }[];
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([p.finally(() => clearTimeout(t)), timeout]);
}

/** Fetch every selected source in parallel and assemble the full portfolio. */
export async function buildPortfolio(sources?: SourceFilter[]): Promise<Portfolio> {
  const selected: SourceFilter[] = sources && sources.length > 0 ? sources : [...SOURCE_IDS];

  const settled = await Promise.allSettled(
    selected.map((s) => withTimeout(fetchFor(s)(), SOURCE_TIMEOUT_MS, s)),
  );

  const positions: PositionItem[] = [];
  const errors: { source: string; error: string }[] = [];
  const sourceBreakdown: Record<string, SourceBreakdownEntry> = {};

  settled.forEach((result, i) => {
    const source = selected[i]!;
    if (result.status === "fulfilled") {
      for (const p of result.value) {
        positions.push(p);
        const entry = (sourceBreakdown[p.source] ??= { label: "", valueUsd: 0, positionCount: 0 });
        entry.valueUsd += p.value || 0;
        entry.positionCount += 1;
      }
    } else {
      errors.push({ source, error: stringifyErr(result.reason) });
    }
  });

  const totalValueUsd = positions.reduce((s, p) => s + (p.value || 0), 0);
  let totalValueRub: number;
  try {
    totalValueRub = totalValueUsd * (await getUsdRub());
  } catch {
    totalValueRub = positions.reduce((s, p) => s + (p.valueRub || 0), 0);
  }

  for (const k of Object.keys(sourceBreakdown)) {
    const entry = sourceBreakdown[k]!;
    entry.valueUsd = round(entry.valueUsd);
    entry.label =
      k === "static"
        ? staticLabel(positions.filter((p) => p.source === "static"))
        : sourceLabel(k as Parameters<typeof sourceLabel>[0]);
  }

  return {
    timestamp: new Date().toISOString(),
    totalValueUsd: round(totalValueUsd),
    totalValueRub: round(totalValueRub),
    positionCount: positions.length,
    sourceBreakdown,
    allocation: computeAllocation(positions, totalValueUsd),
    positions,
    errors,
  };
}

export function round(n: number): number {
  return Math.round(n * 100) / 100;
}
