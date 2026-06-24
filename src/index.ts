import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPortfolioTool } from "./tools/portfolio.ts";
import { registerTrackingTools } from "./tools/tracking.ts";
import { requireHttpAuth } from "./server/auth.ts";
import { requireOAuthConfig, oauthEnabled, purgeOAuthAuthCodes } from "./server/oauth.ts";
import { runDbMaintenance } from "./lib/maintenance.ts";
import { startHttp } from "./server/http.ts";
import { startStdio } from "./server/stdio.ts";

/** Build a fresh server instance with all tools registered. */
function createServer(): McpServer {
  const server = new McpServer({ name: "portfolio-mcp", version: "1.0.0" });
  registerPortfolioTool(server);
  registerTrackingTools(server);
  return server;
}

async function main(): Promise<void> {
  const useStdio = process.argv.includes("--stdio") || process.env.MCP_TRANSPORT === "stdio";
  if (useStdio) {
    await startStdio(createServer);
    return;
  }

  requireHttpAuth();
  requireOAuthConfig();

  const port = Number(process.env.PORT ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${process.env.PORT ?? "3000"}`);
  }
  startHttp(createServer, port, process.env.HOST ?? "127.0.0.1");
  startMaintenanceLoop();
}

/** Periodic purge of expired OAuth tokens/codes and WAL checkpoint (HTTP process). */
function startMaintenanceLoop(): void {
  const tick = (): void => {
    runDbMaintenance();
    if (oauthEnabled()) {
      const n = purgeOAuthAuthCodes();
      if (n > 0) console.error(`[maintenance] purged ${n} expired oauth auth code(s)`);
    }
  };
  tick();
  setInterval(tick, 6 * 60 * 60 * 1000);
}

main().catch((err) => {
  console.error("[portfolio-mcp] fatal:", err);
  process.exit(1);
});
