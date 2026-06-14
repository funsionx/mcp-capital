import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerPortfolioTool } from "./tools/portfolio.ts";

const MCP_PATH = "/mcp";

function createServer(): McpServer {
  const server = new McpServer({
    name: "portfolio-mcp",
    version: "1.0.0",
  });

  registerPortfolioTool(server);
  return server;
}

function isMcpPath(pathname: string): boolean {
  return pathname === MCP_PATH || pathname === `${MCP_PATH}/`;
}

function corsHeaders(req: Request): Record<string, string> {
  const configured = (process.env.ALLOWED_ORIGINS ?? "*")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const origin = req.headers.get("origin");

  let allowOrigin = "*";
  if (configured[0] !== "*" && origin && configured.includes(origin)) {
    allowOrigin = origin;
  } else if (configured[0] !== "*") {
    allowOrigin = configured[0] ?? "*";
  }

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Accept, mcp-session-id, last-event-id, mcp-protocol-version",
    "Access-Control-Expose-Headers": "mcp-session-id, mcp-protocol-version",
  };
}

function withCors(req: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(req))) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function handleMcpRequest(req: Request): Promise<Response> {
  // Stateless: fresh transport + server per request (required for proxies/ngrok).
  const transport = new WebStandardStreamableHTTPServerTransport();
  const server = createServer();
  await server.connect(transport);

  const response = await transport.handleRequest(req);
  return withCors(req, response);
}

async function startStdio(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stdout is reserved for the MCP protocol — log only to stderr.
  console.error("[portfolio-mcp] connected over stdio");
}

async function startHttp(port: number, hostname: string): Promise<void> {
  Bun.serve({
    port,
    hostname,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "OPTIONS" && isMcpPath(url.pathname)) {
        return new Response(null, { status: 204, headers: corsHeaders(req) });
      }

      if (isMcpPath(url.pathname)) {
        console.error(
          `[portfolio-mcp] ${req.method} ${url.pathname} accept=${req.headers.get("accept") ?? "-"} session=${req.headers.get("mcp-session-id") ?? "-"}`,
        );

        try {
          const response = await handleMcpRequest(req);
          console.error(`[portfolio-mcp] -> ${response.status}`);
          return response;
        } catch (err) {
          console.error("[portfolio-mcp] MCP handler error:", err);
          return withCors(
            req,
            Response.json(
              {
                jsonrpc: "2.0",
                error: { code: -32603, message: "Internal server error" },
                id: null,
              },
              { status: 500 },
            ),
          );
        }
      }

      if (url.pathname === "/" || url.pathname === "/health") {
        return Response.json({ ok: true, mcp: MCP_PATH });
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  console.error(
    `[portfolio-mcp] listening on http://${hostname}:${port}${MCP_PATH} (stateless HTTP)`,
  );
}

async function main(): Promise<void> {
  const useStdio =
    process.argv.includes("--stdio") || process.env.MCP_TRANSPORT === "stdio";

  if (useStdio) {
    await startStdio();
    return;
  }

  const port = Number(process.env.PORT ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${process.env.PORT ?? "3000"}`);
  }

  const hostname = process.env.HOST ?? "127.0.0.1";
  await startHttp(port, hostname);
}

main().catch((err) => {
  console.error("[portfolio-mcp] fatal:", err);
  process.exit(1);
});
