import type { PositionItem } from "../lib/types.ts";
import { fetchJson, stringifyErr } from "../lib/http.ts";
import { requireEnv } from "../lib/env.ts";

const HOST = "https://api.bybit.com";
const RECV_WINDOW = "5000";

interface BybitEnvelope<T> {
  retCode: number;
  retMsg: string;
  result: T;
}
interface WalletBalance {
  list?: { coin?: BybitCoin[] }[];
}
interface BybitCoin {
  coin: string;
  walletBalance?: string;
  usdValue?: string;
}
interface PositionList {
  list?: BybitPosition[];
}
interface BybitPosition {
  symbol: string;
  side?: string;
  size?: string;
  markPrice?: string;
  positionValue?: string;
  leverage?: string;
  unrealisedPnl?: string;
}
interface EarnList {
  list?: EarnPosition[];
}
interface EarnPosition {
  coin?: string;
  amount?: string;
  totalPnl?: string;
  productId?: string;
}
interface TickerList {
  list?: { symbol?: string; lastPrice?: string }[];
}

const EARN_CATEGORIES = ["FlexibleSaving", "OnChain"] as const;
const STABLES = new Set(["USDT", "USDC", "USDE", "DAI", "USD", "BUSD", "FDUSD"]);

export async function fetchPositions(): Promise<PositionItem[]> {
  const apiKey = requireEnv("BYBIT_API_KEY");
  const apiSecret = requireEnv("BYBIT_API_SECRET");

  const [wallet, positions, earn] = await Promise.all([
    fetchWallet(apiKey, apiSecret),
    fetchOpenPositions(apiKey, apiSecret),
    fetchEarn(apiKey, apiSecret),
  ]);

  return [...wallet, ...positions, ...earn];
}

async function signedGet<T>(
  apiKey: string,
  apiSecret: string,
  path: string,
  query: string,
): Promise<T> {
  const timestamp = Date.now().toString();
  const sign = await hmacSha256Hex(apiSecret, timestamp + apiKey + RECV_WINDOW + query);
  const url = `${HOST}${path}${query ? `?${query}` : ""}`;
  const res = await fetchJson<BybitEnvelope<T>>(url, {
    headers: {
      "X-BAPI-API-KEY": apiKey,
      "X-BAPI-SIGN": sign,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": RECV_WINDOW,
    },
  });
  if (res.retCode !== 0) {
    throw new Error(`Bybit ${path} retCode=${res.retCode}: ${res.retMsg}`);
  }
  return res.result;
}

async function fetchWallet(apiKey: string, apiSecret: string): Promise<PositionItem[]> {
  const query = "accountType=UNIFIED";
  const result = await signedGet<WalletBalance>(apiKey, apiSecret, "/v5/account/wallet-balance", query);
  const coins = result.list?.[0]?.coin ?? [];
  const out: PositionItem[] = [];
  for (const c of coins) {
    const usdValue = num(c.usdValue);
    const quantity = num(c.walletBalance);
    if (usdValue <= 0 || quantity <= 0) continue;
    out.push({
      source: "bybit",
      ticker: c.coin,
      name: c.coin,
      quantity,
      price: usdValue / quantity,
      value: usdValue,
      currency: c.coin,
      category: "crypto",
      chain: "bybit",
      description: "Bybit Unified account balance",
    });
  }
  return out;
}

async function fetchOpenPositions(apiKey: string, apiSecret: string): Promise<PositionItem[]> {
  try {
    const query = "category=linear&settleCoin=USDT";
    const result = await signedGet<PositionList>(apiKey, apiSecret, "/v5/position/list", query);
    const out: PositionItem[] = [];
    for (const p of result.list ?? []) {
      const size = num(p.size);
      if (size === 0) continue;
      const markPrice = num(p.markPrice);
      const value = num(p.positionValue) || size * markPrice;
      out.push({
        source: "bybit",
        ticker: p.symbol,
        name: `${p.symbol} perp`,
        quantity: size,
        price: markPrice,
        value,
        currency: "USDT",
        category: "crypto",
        chain: "bybit",
        description: `Derivative ${p.side ?? ""} x${p.leverage ?? "?"}, uPnL ${p.unrealisedPnl ?? "0"} USDT`.trim(),
      });
    }
    return out;
  } catch (e) {
    // Derivatives may be disabled on the account; don't fail the whole source.
    console.error(`[bybit] open positions unavailable: ${stringifyErr(e)}`);
    return [];
  }
}

async function fetchEarn(apiKey: string, apiSecret: string): Promise<PositionItem[]> {
  const out: PositionItem[] = [];
  for (const category of EARN_CATEGORIES) {
    try {
      const query = `category=${category}`;
      const result = await signedGet<EarnList>(apiKey, apiSecret, "/v5/earn/position", query);
      for (const p of result.list ?? []) {
        const coin = p.coin ?? "";
        const quantity = num(p.amount);
        if (!coin || quantity <= 0) continue;
        const price = await spotPrice(coin);
        out.push({
          source: "bybit",
          ticker: coin,
          name: `${coin} (Earn)`,
          quantity,
          price,
          value: price * quantity,
          currency: coin,
          category: "defi",
          chain: "bybit",
          description: `Bybit Earn — ${category}${p.totalPnl ? `, PnL ${p.totalPnl}` : ""}`,
        });
      }
    } catch (e) {
      // A category may be unsupported or empty; don't fail the whole source.
      console.error(`[bybit] earn ${category} unavailable: ${stringifyErr(e)}`);
    }
  }
  return out;
}

const priceCache = new Map<string, number>();

/** Public spot price coin->USD (via USDT pair). Stables resolve to 1. */
async function spotPrice(coin: string): Promise<number> {
  const up = coin.toUpperCase();
  if (STABLES.has(up)) return 1;
  if (priceCache.has(up)) return priceCache.get(up)!;
  try {
    const res = await fetchJson<BybitEnvelope<TickerList>>(
      `${HOST}/v5/market/tickers?category=spot&symbol=${up}USDT`,
    );
    const last = num(res.result?.list?.[0]?.lastPrice);
    priceCache.set(up, last);
    return last;
  } catch {
    priceCache.set(up, 0);
    return 0;
  }
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
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

function num(v: string | undefined): number {
  if (v == null || v === "") return 0;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}
