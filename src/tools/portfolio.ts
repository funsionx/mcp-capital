import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PositionItem } from "../lib/types.ts";
import { stringifyErr } from "../lib/http.ts";
import { getUsdRub } from "../lib/usdRub.ts";
import { computeAllocation, type Allocation } from "../lib/analytics.ts";
import { sourceLabel, staticLabel } from "../lib/labels.ts";
import { SOURCE_IDS, type SourceFilter, fetchFor } from "../sources/index.ts";

/** Hard cap per source so one slow/hung API can't make the whole tool time out. */
const SOURCE_TIMEOUT_MS = 18_000;
/** Default: hide sub-$1 noise from the listing (still counted in totals). */
const DEFAULT_MIN_VALUE_USD = 1;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([p.finally(() => clearTimeout(t)), timeout]);
}

interface SourceBreakdownEntry {
  label: string;
  valueUsd: number;
  positionCount: number;
}
interface Summary {
  timestamp: string;
  totalValueUsd: number;
  totalValueRub: number;
  positionCount: number;
  sourceBreakdown: Record<string, SourceBreakdownEntry>;
  allocation: Allocation;
  positions: Record<string, unknown>[];
  hiddenBelowThreshold: { count: number; valueUsd: number; minValueUsd: number };
  errors: { source: string; error: string }[];
}

export function registerPortfolioTool(server: McpServer): void {
  server.registerTool(
    "get_portfolio_summary",
    {
      title: "Get Portfolio Summary",
      description:
        "Returns a complete snapshot of the entire investment portfolio across all " +
        "sources: T-Invest, Bybit, MOEX (AKMM), EVM wallets, Solana, Sui, Near, " +
        "Hyperliquid, and static/manual positions. Includes totals in USD and RUB, a " +
        "per-source breakdown, an allocation block (by asset class, by chain, and " +
        "stablecoin share), and the position list. Each position has ticker, name, " +
        "quantity, current price, value, category, chain, and description.",
      inputSchema: {
        includeSources: z
          .array(z.enum(SOURCE_IDS))
          .optional()
          .describe("Filter by sources. If omitted, fetches all sources."),
        minValueUsd: z
          .number()
          .optional()
          .describe(
            `Hide positions worth less than this (USD) from the listing; they're still counted in totals. Default ${DEFAULT_MIN_VALUE_USD}. Pass 0 to list everything.`,
          ),
      },
    },
    async ({ includeSources, minValueUsd }) => {
      const threshold = minValueUsd ?? DEFAULT_MIN_VALUE_USD;
      const selected: SourceFilter[] =
        includeSources && includeSources.length > 0 ? includeSources : [...SOURCE_IDS];

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

      // Totals stay accurate over ALL positions; only the listing is trimmed.
      const totalValueUsd = positions.reduce((s, p) => s + (p.value || 0), 0);
      // Whole portfolio converted to RUB at the live CBR rate (not just the
      // RUB-denominated subset). Falls back to summing RUB-native positions.
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
          k === "static" ? staticLabel(positions.filter((p) => p.source === "static")) : sourceLabel(k as Parameters<typeof sourceLabel>[0]);
      }

      const shown = positions
        .filter((p) => Math.abs(p.value || 0) >= threshold)
        .sort((a, b) => (b.value || 0) - (a.value || 0));
      const hidden = positions.filter((p) => Math.abs(p.value || 0) < threshold);

      const summary: Summary = {
        timestamp: new Date().toISOString(),
        totalValueUsd: round(totalValueUsd),
        totalValueRub: round(totalValueRub),
        positionCount: positions.length,
        sourceBreakdown,
        allocation: computeAllocation(positions, totalValueUsd),
        positions: shown.map(compact),
        hiddenBelowThreshold: {
          count: hidden.length,
          valueUsd: round(hidden.reduce((s, p) => s + (p.value || 0), 0)),
          minValueUsd: threshold,
        },
        errors,
      };

      // Compact (no indentation) to minimize tokens for the consuming agent.
      return { content: [{ type: "text", text: JSON.stringify(summary) }] };
    },
  );
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Trim a position for output: round numbers, drop empty/zero optional fields. */
function compact(p: PositionItem): Record<string, unknown> {
  const o: Record<string, unknown> = {
    source: p.source,
    ticker: p.ticker,
    name: p.name,
    quantity: roundTo(p.quantity, 6),
    price: round(p.price),
    value: round(p.value),
    currency: p.currency,
    category: p.category,
  };
  if (p.chain) o.chain = p.chain;
  if (p.priceRub != null) o.priceRub = round(p.priceRub);
  if (p.valueRub != null) o.valueRub = round(p.valueRub);
  if (p.apy != null) o.apy = p.apy;
  if (p.description) o.description = p.description;
  return o;
}

function roundTo(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
