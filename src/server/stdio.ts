import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

/** Serve the MCP over stdio (for local clients / the MCP Inspector). */
export async function startStdio(createServer: () => McpServer): Promise<void> {
  await createServer().connect(new StdioServerTransport());
  // stdout is reserved for the MCP protocol — log only to stderr.
  console.error("[portfolio-mcp] connected over stdio");
}
