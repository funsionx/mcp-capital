/**
 * Integration log: call get_portfolio_summary with all sources and print the MCP response.
 * Requires .env with your keys; network-dependent sources may return errors[] entries.
 *
 * Usage: bun run scripts/all-sources.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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

interface SourceBreakdownEntry {
  valueUsd: number;
  positionCount: number;
}

function breakdownForFilter(
  filter: (typeof ALL_SOURCES)[number],
  breakdown: Record<string, SourceBreakdownEntry>,
): SourceBreakdownEntry | undefined {
  if (filter === "evm") {
    const keys = ["evm_1", "evm_2"] as const;
    const entries = keys
      .map((key) => breakdown[key])
      .filter((entry): entry is SourceBreakdownEntry => entry !== undefined);
    if (entries.length === 0) return undefined;
    return entries.reduce(
      (acc, entry) => ({
        valueUsd: acc.valueUsd + entry.valueUsd,
        positionCount: acc.positionCount + entry.positionCount,
      }),
      { valueUsd: 0, positionCount: 0 },
    );
  }

  return breakdown[filter];
}

interface PortfolioSummary {
  timestamp: string;
  totalValueUsd: number;
  totalValueRub: number;
  positionCount: number;
  sourceBreakdown: Record<string, SourceBreakdownEntry>;
  positions: Array<{
    source: string;
    ticker: string;
    name: string;
    quantity: number;
    price: number;
    value: number;
    valueRub?: number;
    currency: string;
    category: string;
    chain?: string;
    description?: string;
  }>;
  errors: Array<{ source: string; error: string }>;
}

function logSection(title: string): void {
  console.log(`\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}`);
}

const transport = new StdioClientTransport({
  command: "bun",
  args: ["run", "src/index.ts", "--stdio"],
});
const client = new Client({ name: "all-sources", version: "1.0.0" });

try {
  await client.connect(transport);

  const tools = await client.listTools();
  console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

  logSection(`TOOL CALL: get_portfolio_summary (${ALL_SOURCES.join(", ")})`);
  const startedAt = Date.now();

  const res = await client.callTool({
    name: "get_portfolio_summary",
    arguments: { includeSources: [...ALL_SOURCES] },
  });

  console.log("MCP isError:", res.isError ?? false);
  if (res.isError) {
    console.log("MCP content:", JSON.stringify(res.content, null, 2));
    process.exitCode = 1;
  } else {
    const text = (res.content as { type: string; text: string }[])[0]?.text ?? "";
    const summary = JSON.parse(text) as PortfolioSummary;

    console.log("elapsedMs:", Date.now() - startedAt);
    console.log("timestamp:", summary.timestamp);
    console.log("totalValueUsd:", summary.totalValueUsd);
    console.log("totalValueRub:", summary.totalValueRub);
    console.log("positionCount:", summary.positionCount);

    logSection("SOURCE BREAKDOWN");
    for (const source of ALL_SOURCES) {
      const entry = breakdownForFilter(source, summary.sourceBreakdown);
      if (entry) {
        console.log(
          `${source.padEnd(12)} positions=${entry.positionCount} valueUsd=${entry.valueUsd}`,
        );
        continue;
      }

      const err = summary.errors.find((e) => e.source === source);
      if (err) {
        console.log(`${source.padEnd(12)} ERROR: ${err.error}`);
        continue;
      }

      console.log(`${source.padEnd(12)} (no positions, no error)`);
    }

    logSection(`ERRORS (${summary.errors.length})`);
    if (summary.errors.length === 0) {
      console.log("none");
    } else {
      for (const { source, error } of summary.errors) {
        console.log(`[${source}] ${error}`);
      }
    }

    logSection(`POSITIONS BY SOURCE (${summary.positions.length})`);
    const bySource = new Map<string, PortfolioSummary["positions"]>();
    for (const position of summary.positions) {
      const list = bySource.get(position.source) ?? [];
      list.push(position);
      bySource.set(position.source, list);
    }

    for (const source of [...bySource.keys()].sort()) {
      const positions = bySource.get(source)!;
      console.log(`\n--- ${source} (${positions.length}) ---`);
      for (const p of positions) {
        const rub =
          p.valueRub !== undefined ? ` valueRub=${p.valueRub}` : "";
        const chain = p.chain ? ` chain=${p.chain}` : "";
        console.log(
          `  ${p.ticker.padEnd(16)} qty=${p.quantity} price=${p.price} value=${p.value}${rub} ${p.currency} [${p.category}]${chain}`,
        );
        if (p.description) {
          console.log(`    ${p.description}`);
        }
      }
    }

    logSection("RAW JSON");
    console.log(JSON.stringify(summary, null, 2));
  }
} finally {
  await client.close();
}
