import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { oauthEnabled, isOAuthPath, handleOAuth, validateAccessToken } from "./oauth.ts";

const MCP_PATH = "/mcp";

type CreateServer = () => McpServer;

function isMcpPath(pathname: string): boolean {
  return pathname === MCP_PATH || pathname === `${MCP_PATH}/`;
}

/**
 * Auth gate for /mcp. Accepts either the static bearer (AUTH_TOKEN) or a valid
 * OAuth access token. No-op only when NEITHER AUTH_TOKEN nor OAuth is configured —
 * configure one before exposing this server publicly (it reveals your net worth).
 */
function authorized(req: Request): boolean {
  const staticToken = process.env.AUTH_TOKEN;
  if (!staticToken && !oauthEnabled()) return true;

  const header = req.headers.get("authorization") ?? "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (staticToken && bearer === staticToken) return true;
  if (oauthEnabled() && bearer && validateAccessToken(bearer)) return true;
  return false;
}

function corsHeaders(req: Request): Record<string, string> {
  const configured = (process.env.ALLOWED_ORIGINS ?? "*")
    .split(",")
    .map((v) => v.trim())
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
  for (const [k, v] of Object.entries(corsHeaders(req))) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function handleMcpRequest(createServer: CreateServer, req: Request): Promise<Response> {
  // Stateless: a fresh transport + server per request (required for proxies/ngrok).
  const transport = new WebStandardStreamableHTTPServerTransport();
  const server = createServer();
  await server.connect(transport);
  return withCors(req, await transport.handleRequest(req));
}

/** Serve the MCP over stateless streamable HTTP at `/mcp`, plus a `/health` route. */
export function startHttp(createServer: CreateServer, port: number, hostname: string): void {
  Bun.serve({
    port,
    hostname,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "OPTIONS" && isMcpPath(url.pathname)) {
        return new Response(null, { status: 204, headers: corsHeaders(req) });
      }

      // OAuth endpoints are public (no bearer gate) when OAuth is enabled.
      if (oauthEnabled() && isOAuthPath(url.pathname)) {
        const res = await handleOAuth(req);
        if (res) return withCors(req, res);
      }

      if (isMcpPath(url.pathname) && !authorized(req)) {
        return withCors(
          req,
          Response.json(
            { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null },
            { status: 401 },
          ),
        );
      }

      if (isMcpPath(url.pathname)) {
        console.error(
          `[portfolio-mcp] ${req.method} ${url.pathname} accept=${req.headers.get("accept") ?? "-"} session=${req.headers.get("mcp-session-id") ?? "-"}`,
        );
        try {
          const response = await handleMcpRequest(createServer, req);
          console.error(`[portfolio-mcp] -> ${response.status}`);
          return response;
        } catch (err) {
          console.error("[portfolio-mcp] MCP handler error:", err);
          return withCors(
            req,
            Response.json(
              { jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null },
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

  console.error(`[portfolio-mcp] listening on http://${hostname}:${port}${MCP_PATH} (stateless HTTP)`);
}
