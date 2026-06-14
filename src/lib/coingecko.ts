import { fetchJson } from "./http.ts";

const BASE = "https://api.coingecko.com/api/v3/simple/price";

const cache = new Map<string, number>();

/**
 * Free, keyless CoinGecko simple/price lookup. Returns a map of
 * coingecko-id -> USD price. Results are cached per process. Missing/illiquid
 * ids simply won't appear in the returned map.
 */
export async function getCoinGeckoPrices(ids: string[]): Promise<Map<string, number>> {
  const need = [...new Set(ids)].filter((id) => id && !cache.has(id));
  if (need.length > 0) {
    const url = `${BASE}?ids=${encodeURIComponent(need.join(","))}&vs_currencies=usd`;
    const data = await fetchJson<Record<string, { usd?: number }>>(url, {}, { retries: 2 });
    for (const id of need) {
      const usd = data[id]?.usd;
      if (typeof usd === "number") cache.set(id, usd);
    }
  }
  const out = new Map<string, number>();
  for (const id of ids) {
    const v = cache.get(id);
    if (typeof v === "number") out.set(id, v);
  }
  return out;
}
