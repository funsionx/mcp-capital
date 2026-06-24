import { oauthEnabled } from "./oauth.ts";

/** True when HTTP mode has at least one auth mechanism configured. */
export function httpAuthConfigured(): boolean {
  return !!(process.env.AUTH_TOKEN?.trim() || oauthEnabled());
}

/** Fail fast on startup if HTTP would be exposed without auth. */
export function requireHttpAuth(): void {
  if (!httpAuthConfigured()) {
    throw new Error(
      "HTTP mode requires AUTH_TOKEN or OAUTH_CLIENT_ID + OAUTH_CLIENT_SECRET. " +
        "Set at least one before starting (this server exposes your net worth).",
    );
  }
}

/** Constant-time bearer token comparison. */
export function bearerMatches(token: string, bearer: string): boolean {
  if (!token || !bearer) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(bearer);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
