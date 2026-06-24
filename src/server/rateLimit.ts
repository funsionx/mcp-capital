/** In-memory sliding-window rate limiter (per client IP). Single-process only. */

interface Window {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Window>();

function limitFor(key: string, defaultLimit: number): number {
  const envKey = key === "mcp" ? "RATE_LIMIT_MCP" : "RATE_LIMIT_OAUTH";
  const raw = process.env[envKey];
  if (raw == null || raw === "") return defaultLimit;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : defaultLimit;
}

function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
  return req.headers.get("x-real-ip") ?? "unknown";
}

/**
 * Returns null if allowed, or a 429 Response if the limit is exceeded.
 * @param bucket - logical bucket name (`mcp` or `oauth`)
 * @param defaultLimit - max requests per 60s window
 */
export function rateLimit(req: Request, bucket: "mcp" | "oauth", defaultLimit: number): Response | null {
  const limit = limitFor(bucket, defaultLimit);
  const key = `${bucket}:${clientIp(req)}`;
  const now = Date.now();
  const windowMs = 60_000;

  for (const [k, entry] of buckets) {
    if (now >= entry.resetAt) buckets.delete(k);
  }

  let entry = buckets.get(key);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + windowMs };
    buckets.set(key, entry);
  }

  entry.count++;
  if (entry.count <= limit) return null;

  const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
  return new Response(JSON.stringify({ error: "rate_limit_exceeded" }), {
    status: 429,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": String(retryAfter),
    },
  });
}
