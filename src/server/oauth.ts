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

function refreshTtlMs(): number {
  const days = Number(process.env.OAUTH_REFRESH_TTL_DAYS ?? "90");
  if (!Number.isFinite(days) || days <= 0) return 90 * 24 * 60 * 60 * 1000;
  return Math.floor(days) * 24 * 60 * 60 * 1000;
}

interface AuthCode {
  redirectUri: string;
  codeChallenge: string;
  expiresAt: number;
}
const codes = new Map<string, AuthCode>();

function purgeExpiredAuthCodes(): number {
  const now = Date.now();
  let n = 0;
  for (const [code, entry] of codes) {
    if (entry.expiresAt < now) {
      codes.delete(code);
      n++;
    }
  }
  return n;
}

/** Exported for periodic maintenance (app HTTP process). */
export function purgeOAuthAuthCodes(): number {
  return purgeExpiredAuthCodes();
}

export function oauthEnabled(): boolean {
  return !!(process.env.OAUTH_CLIENT_ID && process.env.OAUTH_CLIENT_SECRET);
}

/** Validate OAuth env when OAuth is enabled (call at startup). */
export function requireOAuthConfig(): void {
  if (!oauthEnabled()) return;
  const uris = allowedRedirectUris();
  if (uris.length === 0) {
    throw new Error(
      "OAuth is enabled but OAUTH_REDIRECT_URIS is empty. " +
        "Set comma-separated allowed redirect URIs (e.g. https://claude.ai/api/mcp/auth_callback).",
    );
  }
}

function allowedRedirectUris(): string[] {
  return (process.env.OAUTH_REDIRECT_URIS ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function isAllowedRedirect(uri: string): boolean {
  return allowedRedirectUris().includes(uri);
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
      return handleRegister(req);

    case "/authorize":
      if (req.method === "POST") return handleAuthorizePost(req);
      return handleAuthorizeGet(url);

    case "/token":
      return handleToken(req);

    default:
      return null;
  }
}

function handleRegister(req: Request): Response {
  const regSecret = process.env.OAUTH_REGISTRATION_SECRET?.trim();
  const provided = req.headers.get("x-oauth-registration-secret") ?? "";
  const includeSecret = !!(regSecret && provided && regSecret === provided);

  const body: Record<string, unknown> = {
    client_id: process.env.OAUTH_CLIENT_ID,
    token_endpoint_auth_method: "client_secret_post",
    grant_types: ["authorization_code", "refresh_token"],
  };
  if (includeSecret) body.client_secret = process.env.OAUTH_CLIENT_SECRET;

  return Response.json(body, { status: 201 });
}

function parseAuthorizeParams(url: URL): { ok: true; params: URLSearchParams } | { ok: false; error: Response } {
  const p = url.searchParams;
  if (p.get("client_id") !== process.env.OAUTH_CLIENT_ID) {
    return { ok: false, error: Response.json({ error: "unauthorized_client" }, { status: 400 }) };
  }
  const redirectUri = p.get("redirect_uri");
  const challenge = p.get("code_challenge");
  if (!redirectUri || !challenge || p.get("code_challenge_method") !== "S256") {
    return {
      ok: false,
      error: Response.json(
        { error: "invalid_request", error_description: "PKCE S256 + redirect_uri required" },
        { status: 400 },
      ),
    };
  }
  if (!isAllowedRedirect(redirectUri)) {
    return {
      ok: false,
      error: Response.json({ error: "invalid_request", error_description: "redirect_uri not allowed" }, { status: 400 }),
    };
  }
  return { ok: true, params: p };
}

function handleAuthorizeGet(url: URL): Response {
  const parsed = parseAuthorizeParams(url);
  if (!parsed.ok) return parsed.error;

  const p = parsed.params;
  const redirectUri = p.get("redirect_uri")!;
  const challenge = p.get("code_challenge")!;
  const state = p.get("state") ?? "";

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Authorize portfolio-mcp</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}
button{background:#111;color:#fff;border:0;padding:.6rem 1.2rem;border-radius:6px;cursor:pointer}
.cancel{background:#eee;color:#111;margin-left:.5rem}</style></head>
<body>
<h1>Authorize portfolio-mcp?</h1>
<p>This MCP server exposes your investment portfolio. Only approve if you initiated this request.</p>
<p><strong>Redirect:</strong> ${escapeHtml(redirectUri)}</p>
<form method="post" action="/authorize">
<input type="hidden" name="client_id" value="${escapeAttr(process.env.OAUTH_CLIENT_ID ?? "")}">
<input type="hidden" name="redirect_uri" value="${escapeAttr(redirectUri)}">
<input type="hidden" name="code_challenge" value="${escapeAttr(challenge)}">
<input type="hidden" name="code_challenge_method" value="S256">
<input type="hidden" name="state" value="${escapeAttr(state)}">
<input type="hidden" name="approve" value="1">
<button type="submit">Authorize</button>
</form>
</body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function handleAuthorizePost(req: Request): Promise<Response> {
  const body = new URLSearchParams(await req.text());
  if (body.get("approve") !== "1") {
    return Response.json({ error: "access_denied" }, { status: 400 });
  }

  const url = new URL(req.url);
  for (const [k, v] of body.entries()) url.searchParams.set(k, v);

  const parsed = parseAuthorizeParams(url);
  if (!parsed.ok) return parsed.error;

  const p = parsed.params;
  const redirectUri = p.get("redirect_uri")!;
  const code = randomToken();
  codes.set(code, {
    redirectUri,
    codeChallenge: p.get("code_challenge")!,
    expiresAt: Date.now() + CODE_TTL_MS,
  });

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
    if (!isAllowedRedirect(entry.redirectUri)) {
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
    revokeToken(rt);
    return Response.json(issueTokens());
  }

  return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
}

function issueTokens(): Record<string, unknown> {
  const access = randomToken();
  const refresh = randomToken();
  const db = getDb();
  const refreshExpires = Date.now() + refreshTtlMs();
  db.query("INSERT INTO oauth_tokens (token, type, expires_at) VALUES ($t, 'access', $e)").run({
    $t: access,
    $e: Date.now() + ACCESS_TTL_MS,
  });
  db.query("INSERT INTO oauth_tokens (token, type, expires_at) VALUES ($t, 'refresh', $e)").run({
    $t: refresh,
    $e: refreshExpires,
  });
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh };
}

function revokeToken(token: string): void {
  getDb().query("DELETE FROM oauth_tokens WHERE token = $t").run({ $t: token });
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, "&#39;");
}
