import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { FetchPositions, PositionItem, SourceFilter } from "../lib/types.ts";
import { stringifyErr } from "../lib/http.ts";

import * as tinkoff from "../sources/tinkoff.ts";
import * as bybit from "../sources/bybit.ts";
import * as moex from "../sources/moex.ts";
import * as evm from "../sources/evm.ts";
import * as solana from "../sources/solana.ts";
import * as sui from "../sources/sui.ts";
import * as near from "../sources/near.ts";
import * as staticSrc from "../sources/static.ts";

const ALL_SOURCES = [
  "tinkoff",
  "bybit",
  "moex",
  "evm",
  "solana",
  "sui",
  "near",
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
  static: staticSrc.fetchPositions,
};

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
  positions: PositionItem[];
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
      },
    },
    async ({ includeSources }) => {
      const selected = (includeSources && includeSources.length > 0
        ? includeSources
        : ALL_SOURCES) as SourceFilter[];

      const settled = await Promise.allSettled(
        selected.map((s) => REGISTRY[s]()),
      );

      const positions: PositionItem[] = [];
      const errors: { source: string; error: string }[] = [];
      const sourceBreakdown: Record<string, SourceBreakdownEntry> = {};

      settled.forEach((result, i) => {
        const source = selected[i]!;
        if (result.status === "fulfilled") {
          for (const p of result.value) {
            positions.push(p);
            const key = p.source;
            const entry = (sourceBreakdown[key] ??= { valueUsd: 0, positionCount: 0 });
            entry.valueUsd += p.value || 0;
            entry.positionCount += 1;
          }
        } else {
          errors.push({ source, error: stringifyErr(result.reason) });
        }
      });

      const totalValueUsd = positions.reduce((s, p) => s + (p.value || 0), 0);
      const totalValueRub = positions.reduce((s, p) => s + (p.valueRub || 0), 0);

      const summary: Summary = {
        timestamp: new Date().toISOString(),
        totalValueUsd: round(totalValueUsd),
        totalValueRub: round(totalValueRub),
        positionCount: positions.length,
        sourceBreakdown: roundBreakdown(sourceBreakdown),
        positions,
        errors,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      };
    },
  );
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
function roundBreakdown(
  b: Record<string, SourceBreakdownEntry>,
): Record<string, SourceBreakdownEntry> {
  for (const k of Object.keys(b)) {
    b[k]!.valueUsd = round(b[k]!.valueUsd);
  }
  return b;
}
