const DEFAULT_TIMEOUT_MS = 15_000;

interface HttpOpts {
  timeoutMs?: number;
  /**
   * Additional trust anchor(s) (PEM) for this request. TLS verification stays ON —
   * this is for hosts chained to a CA absent from the default store
   * (e.g. tbank.ru -> Russian Trusted Root CA), NOT for disabling verification.
   */
  caCert?: string;
  /** Retry attempts on HTTP 429 / 5xx, with backoff honoring Retry-After. */
  retries?: number;
}

function truncate(s: string, n = 400): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryDelayMs(res: Response, attempt: number): number {
  const ra = res.headers.get("retry-after");
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return Math.min(secs * 1000, 10_000);
  }
  return Math.min(500 * 2 ** attempt, 5_000); // 500ms, 1s, 2s, ...
}

/** Build the final fetch init, folding in Bun-specific tls options. */
function buildInit(init: RequestInit, signal: AbortSignal, opts: HttpOpts): RequestInit {
  const merged: Record<string, unknown> = { ...init, signal };
  if (opts.caCert) merged.tls = { ca: opts.caCert };
  return merged as RequestInit;
}

/** Fetch and parse JSON, normalizing failures into descriptive Errors. */
export async function fetchJson<T = unknown>(
  url: string,
  init: RequestInit = {},
  opts: HttpOpts = {},
): Promise<T> {
  const retries = opts.retries ?? 0;
  for (let attempt = 0; ; attempt++) {
    const signal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, buildInit(init, signal, opts));
    } catch (e) {
      throw new Error(`Request to ${hostOf(url)} failed: ${stringifyErr(e)}`);
    }
    const text = await res.text();
    if (!res.ok) {
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < retries) {
        await sleep(retryDelayMs(res, attempt));
        continue;
      }
      throw new Error(`${hostOf(url)} -> HTTP ${res.status}: ${truncate(text)}`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`${hostOf(url)} returned non-JSON body: ${truncate(text)}`);
    }
  }
}

/** Fetch raw text (used for CBR XML). */
export async function fetchText(
  url: string,
  init: RequestInit = {},
  opts: HttpOpts = {},
): Promise<string> {
  const signal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal });
  } catch (e) {
    throw new Error(`Request to ${hostOf(url)} failed: ${stringifyErr(e)}`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${hostOf(url)} -> HTTP ${res.status}: ${truncate(text)}`);
  }
  return text;
}

/**
 * Minimal JSON-RPC 2.0 POST helper shared by the chain sources (sui/solana/near).
 * Throws on an `error` member or a missing `result`.
 */
export async function jsonRpc<T>(
  url: string,
  method: string,
  params: unknown,
  init: RequestInit = {},
  opts: HttpOpts = {},
): Promise<T> {
  const res = await fetchJson<{ result?: T; error?: { message?: string } | string }>(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    },
    opts,
  );
  if (res.error) {
    const msg = typeof res.error === "string" ? res.error : res.error.message ?? JSON.stringify(res.error);
    throw new Error(`rpc ${method}: ${msg}`);
  }
  if (res.result === undefined) throw new Error(`rpc ${method}: empty result`);
  return res.result;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function stringifyErr(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
