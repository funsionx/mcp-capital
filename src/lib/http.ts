const DEFAULT_TIMEOUT_MS = 15_000;

interface HttpOpts {
  timeoutMs?: number;
}

function truncate(s: string, n = 400): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Fetch and parse JSON, normalizing failures into descriptive Errors. */
export async function fetchJson<T = unknown>(
  url: string,
  init: RequestInit = {},
  opts: HttpOpts = {},
): Promise<T> {
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
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${hostOf(url)} returned non-JSON body: ${truncate(text)}`);
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
