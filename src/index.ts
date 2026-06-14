import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPortfolioTool } from "./tools/portfolio.ts";
import { startHttp } from "./server/http.ts";
import { startStdio } from "./server/stdio.ts";

/** Build a fresh server instance with all tools registered. */
function createServer(): McpServer {
  const server = new McpServer({ name: "portfolio-mcp", version: "1.0.0" });
  registerPortfolioTool(server);
  return server;
}

async function main(): Promise<void> {
  const useStdio = process.argv.includes("--stdio") || process.env.MCP_TRANSPORT === "stdio";
  if (useStdio) {
    await startStdio(createServer);
    return;
  }

  const port = Number(process.env.PORT ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${process.env.PORT ?? "3000"}`);
  }
  startHttp(createServer, port, process.env.HOST ?? "127.0.0.1");
}

main().catch((err) => {
  console.error("[portfolio-mcp] fatal:", err);
  process.exit(1);
});
