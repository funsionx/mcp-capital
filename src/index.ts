import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerPortfolioTool } from "./tools/portfolio.ts";

async function main(): Promise<void> {
  const server = new McpServer({
    name: "portfolio-mcp",
    version: "1.0.0",
  });

  registerPortfolioTool(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stdout is reserved for the MCP protocol — log only to stderr.
  console.error("[portfolio-mcp] server connected over stdio");
}

main().catch((err) => {
  console.error("[portfolio-mcp] fatal:", err);
  process.exit(1);
});
