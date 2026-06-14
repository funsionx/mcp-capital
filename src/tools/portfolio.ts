import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FetchPositions, PositionItem, SourceFilter } from "../lib/types.ts";
import { stringifyErr } from "../lib/http.ts";
import { getUsdRub } from "../lib/usdRub.ts";

import * as tinkoff from "../sources/tinkoff.ts";
import * as bybit from "../sources/bybit.ts";
import * as moex from "../sources/moex.ts";
import * as evm from "../sources/evm.ts";
import * as solana from "../sources/solana.ts";
import * as sui from "../sources/sui.ts";
import * as near from "../sources/near.ts";
import * as hyperliquid from "../sources/hyperliquid.ts";
import * as staticSrc from "../sources/static.ts";

const ALL_SOURCES = [
  "tinkoff",
  "bybit",
  "moex",
  "evm",
  "solana",
  "sui",
  "near",
  "hyperliquid",
  "static",
] as const;

const REGISTRY: Record<SourceFilter, FetchPositions> = {
  tinkoff: tinkoff.fetchPositions,
  bybit: bybit.fetchPositions,
  moex: moex.fetchPositions,
  evm: evm.fetchPositions,
  solana: solana.fetchPositions,
  sui: sui.fetchPositions,
  near: near.fetchPositions,
  hyperliquid: hyperliquid.fetchPositions,
  static: staticSrc.fetchPositions,
};

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
  valueUsd: number;
  positionCount: number;
}
interface Summary {
  timestamp: string;
  totalValueUsd: number;
  totalValueRub: number;
  positionCount: number;
  sourceBreakdown: Record<string, SourceBreakdownEntry>;
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
        "sources: T-Invest, Bybit, MOEX (AKMM), EVM wallets, Solana, Sui, Near, and " +
        "static positions (Alfa CFA). Each position includes ticker, name, quantity, " +
        "current price, total value in USD and RUB where available, category, and description.",
      inputSchema: {
        includeSources: z
          .array(z.enum(ALL_SOURCES))
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
      const selected = (includeSources && includeSources.length > 0
        ? includeSources
        : ALL_SOURCES) as SourceFilter[];

      const settled = await Promise.allSettled(
        selected.map((s) => withTimeout(REGISTRY[s](), SOURCE_TIMEOUT_MS, s)),
      );

      const positions: PositionItem[] = [];
      const errors: { source: string; error: string }[] = [];
      const sourceBreakdown: Record<string, SourceBreakdownEntry> = {};

      settled.forEach((result, i) => {
        const source = selected[i]!;
        if (result.status === "fulfilled") {
          for (const p of result.value) {
            positions.push(p);
            const entry = (sourceBreakdown[p.source] ??= { valueUsd: 0, positionCount: 0 });
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
      for (const k of Object.keys(sourceBreakdown)) sourceBreakdown[k]!.valueUsd = round(sourceBreakdown[k]!.valueUsd);

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
