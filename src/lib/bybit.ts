import { fetchJson } from "./http.ts";
import { requireEnv } from "./env.ts";
import { isStableSymbol } from "./stablecoins.ts";

const HOST = "https://api.bybit.com";
const RECV_WINDOW = "5000";

/** Signed GET to the Bybit v5 REST API; returns `result`, throws on non-zero retCode. */
export async function bybitSignedGet<T>(path: string, query = ""): Promise<T> {
  const apiKey = requireEnv("BYBIT_API_KEY");
  const apiSecret = requireEnv("BYBIT_API_SECRET");
  const timestamp = Date.now().toString();
  const sign = await hmacHex(apiSecret, timestamp + apiKey + RECV_WINDOW + query);
  const res = await fetchJson<{ retCode: number; retMsg: string; result: T }>(
    `${HOST}${path}${query ? `?${query}` : ""}`,
    {
      headers: {
        "X-BAPI-API-KEY": apiKey,
        "X-BAPI-SIGN": sign,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": RECV_WINDOW,
      },
    },
  );
  if (res.retCode !== 0) throw new Error(`Bybit ${path} retCode=${res.retCode}: ${res.retMsg}`);
  return res.result;
}

const priceCache = new Map<string, number>();

/** Public spot price coin→USD (via the USDT pair). Stables resolve to 1; cached. */
export async function bybitSpotPrice(coin: string): Promise<number> {
  const up = coin.toUpperCase();
  if (isStableSymbol(up)) return 1;
  const cached = priceCache.get(up);
  if (cached !== undefined) return cached;
  let price = 0;
  try {
    const r = await fetchJson<{ result?: { list?: { lastPrice?: string }[] } }>(
      `${HOST}/v5/market/tickers?category=spot&symbol=${up}USDT`,
    );
    price = Number(r.result?.list?.[0]?.lastPrice ?? 0);
    if (!Number.isFinite(price)) price = 0;
  } catch {
    price = 0;
  }
  priceCache.set(up, price);
  return price;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
