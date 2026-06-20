import { getDb } from "../lib/db.ts";

/**
 * Minimal single-user OAuth 2.1 Authorization Server for MCP clients that require
 * OAuth (e.g. Claude). Supports the Authorization Code + PKCE flow and refresh
 * tokens, with one statically-configured client (OAUTH_CLIENT_ID / _SECRET that you
 * paste into the client). Bearer auth (AUTH_TOKEN) keeps working in parallel.
 *
 * Enabled only when OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET are set.
 */
const ACCESS_TTL_MS = 60 * 60 * 1000; // 1h
const CODE_TTL_MS = 5 * 60 * 1000; // 5m

interface AuthCode {
  redirectUri: string;
  codeChallenge: string;
  expiresAt: number;
}
const codes = new Map<string, AuthCode>();

export function oauthEnabled(): boolean {
  return !!(process.env.OAUTH_CLIENT_ID && process.env.OAUTH_CLIENT_SECRET);
}

/** Public base URL used as the OAuth issuer (env override, else derived from the request). */
function issuer(req: Request): string {
  if (process.env.OAUTH_ISSUER) return process.env.OAUTH_ISSUER.replace(/\/$/, "");
  const url = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  return `${proto}://${host}`;
}

export function isOAuthPath(pathname: string): boolean {
  return (
    pathname === "/.well-known/oauth-authorization-server" ||
    pathname === "/.well-known/oauth-protected-resource" ||
    pathname === "/authorize" ||
    pathname === "/token" ||
    pathname === "/register"
  );
}

export async function handleOAuth(req: Request): Promise<Response | null> {
  const url = new URL(req.url);
  const iss = issuer(req);

  switch (url.pathname) {
    case "/.well-known/oauth-authorization-server":
      return Response.json({
        issuer: iss,
        authorization_endpoint: `${iss}/authorize`,
        token_endpoint: `${iss}/token`,
        registration_endpoint: `${iss}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
      });

    case "/.well-known/oauth-protected-resource":
      return Response.json({ resource: `${iss}/mcp`, authorization_servers: [iss] });

    case "/register":
      // Single static client — hand back the configured credentials (no real DCR).
      return Response.json(
        {
          client_id: process.env.OAUTH_CLIENT_ID,
          client_secret: process.env.OAUTH_CLIENT_SECRET,
          token_endpoint_auth_method: "client_secret_post",
          grant_types: ["authorization_code", "refresh_token"],
        },
        { status: 201 },
      );

    case "/authorize":
      return handleAuthorize(url);

    case "/token":
      return handleToken(req);

    default:
      return null;
  }
}

function handleAuthorize(url: URL): Response {
  const p = url.searchParams;
  if (p.get("client_id") !== process.env.OAUTH_CLIENT_ID) {
    return Response.json({ error: "unauthorized_client" }, { status: 400 });
  }
  const redirectUri = p.get("redirect_uri");
  const challenge = p.get("code_challenge");
  if (!redirectUri || !challenge || p.get("code_challenge_method") !== "S256") {
    return Response.json({ error: "invalid_request", error_description: "PKCE S256 + redirect_uri required" }, { status: 400 });
  }

  // Single-user: auto-approve. Redemption still needs client_secret + PKCE verifier.
  const code = randomToken();
  codes.set(code, { redirectUri, codeChallenge: challenge, expiresAt: Date.now() + CODE_TTL_MS });

  const redirect = new URL(redirectUri);
  redirect.searchParams.set("code", code);
  const state = p.get("state");
  if (state) redirect.searchParams.set("state", state);
  return Response.redirect(redirect.toString(), 302);
}

async function handleToken(req: Request): Promise<Response> {
  const body = new URLSearchParams(await req.text());
  const { clientId, clientSecret } = clientCreds(req, body);
  if (clientId !== process.env.OAUTH_CLIENT_ID || clientSecret !== process.env.OAUTH_CLIENT_SECRET) {
    return Response.json({ error: "invalid_client" }, { status: 401 });
  }

  const grant = body.get("grant_type");
  if (grant === "authorization_code") {
    const code = body.get("code") ?? "";
    const entry = codes.get(code);
    codes.delete(code);
    if (!entry || entry.expiresAt < Date.now() || entry.redirectUri !== body.get("redirect_uri")) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    const verifier = body.get("code_verifier") ?? "";
    if ((await sha256url(verifier)) !== entry.codeChallenge) {
      return Response.json({ error: "invalid_grant", error_description: "PKCE mismatch" }, { status: 400 });
    }
    return Response.json(issueTokens());
  }

  if (grant === "refresh_token") {
    const rt = body.get("refresh_token") ?? "";
    if (!isValidToken(rt, "refresh")) return Response.json({ error: "invalid_grant" }, { status: 400 });
    return Response.json(issueTokens());
  }

  return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
}

function issueTokens(): Record<string, unknown> {
  const access = randomToken();
  const refresh = randomToken();
  const db = getDb();
  db.query("INSERT INTO oauth_tokens (token, type, expires_at) VALUES ($t, 'access', $e)").run({
    $t: access,
    $e: Date.now() + ACCESS_TTL_MS,
  });
  db.query("INSERT INTO oauth_tokens (token, type, expires_at) VALUES ($t, 'refresh', NULL)").run({ $t: refresh });
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh };
}

/** True if the bearer token is a live OAuth access token. */
export function validateAccessToken(token: string): boolean {
  return isValidToken(token, "access");
}

function isValidToken(token: string, type: "access" | "refresh"): boolean {
  if (!token) return false;
  const row = getDb()
    .query("SELECT expires_at FROM oauth_tokens WHERE token = $t AND type = $ty")
    .get({ $t: token, $ty: type }) as { expires_at: number | null } | null;
  if (!row) return false;
  return row.expires_at == null || row.expires_at > Date.now();
}

function clientCreds(req: Request, body: URLSearchParams): { clientId: string | null; clientSecret: string | null } {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Basic ")) {
    const [id, secret] = atob(auth.slice(6)).split(":");
    return { clientId: id ?? null, clientSecret: secret ?? null };
  }
  return { clientId: body.get("client_id"), clientSecret: body.get("client_secret") };
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256url(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return base64url(new Uint8Array(digest));
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
