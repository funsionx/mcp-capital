import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PositionItem } from "../lib/types.ts";
import { SOURCE_IDS } from "../sources/index.ts";
import { buildPortfolio, round } from "../portfolio/build.ts";

/** Default: hide sub-$1 noise from the listing (still counted in totals). */
const DEFAULT_MIN_VALUE_USD = 1;

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
      const pf = await buildPortfolio(includeSources);

      const shown = pf.positions
        .filter((p) => Math.abs(p.value || 0) >= threshold)
        .sort((a, b) => (b.value || 0) - (a.value || 0));
      const hidden = pf.positions.filter((p) => Math.abs(p.value || 0) < threshold);

      const summary = {
        timestamp: pf.timestamp,
        totalValueUsd: pf.totalValueUsd,
        totalValueRub: pf.totalValueRub,
        positionCount: pf.positionCount,
        sourceBreakdown: pf.sourceBreakdown,
        allocation: pf.allocation,
        positions: shown.map(compact),
        hiddenBelowThreshold: {
          count: hidden.length,
          valueUsd: round(hidden.reduce((s, p) => s + (p.value || 0), 0)),
          minValueUsd: threshold,
        },
        errors: pf.errors,
      };

      // Compact (no indentation) to minimize tokens for the consuming agent.
      return { content: [{ type: "text", text: JSON.stringify(summary) }] };
    },
  );
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
