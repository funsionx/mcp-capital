import type { PositionItem } from "../lib/types.ts";
import { jsonRpc, stringifyErr } from "../lib/http.ts";
import { requireEnv } from "../lib/env.ts";
import { getCoinGeckoPrices } from "../lib/coingecko.ts";
import { isStableCoinType } from "../lib/stablecoins.ts";

const RPC = "https://fullnode.mainnet.sui.io:443";
const SUI_TYPE = "0x2::sui::SUI";

/** Sui coinType -> CoinGecko id. Unknown coins are listed at price 0. */
const COIN_COINGECKO: Record<string, string> = {
  [SUI_TYPE]: "sui",
  "0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT": "volo-staked-sui",
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC": "usd-coin",
  "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN": "usd-coin", // wormhole USDC
  "0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN": "tether", // wormhole USDT
};

interface Balance {
  coinType: string;
  totalBalance: string;
}
interface CoinMetadata {
  decimals?: number;
  symbol?: string;
  name?: string;
}

const metadataCache = new Map<string, CoinMetadata>();

/**
 * Sui spot coins. NOTE: the wallet's DeFi position is on AlphaLend
 * (…::position::PositionCap), intentionally NOT valued yet (see README) — it has
 * no free REST API and needs the @alphafi/alphalend-sdk or on-chain + Pyth math.
 */
export async function fetchPositions(): Promise<PositionItem[]> {
  const wallet = requireEnv("SUI_WALLET");
  return fetchCoins(wallet);
}

const rpcCall = <T>(method: string, params: unknown[]): Promise<T> => jsonRpc<T>(RPC, method, params);

async function coinMetadata(coinType: string): Promise<CoinMetadata> {
  const cached = metadataCache.get(coinType);
  if (cached) return cached;
  let meta: CoinMetadata = {};
  try {
    meta = (await rpcCall<CoinMetadata | null>("suix_getCoinMetadata", [coinType])) ?? {};
  } catch (e) {
    console.error(`[sui] metadata for ${coinType} failed: ${stringifyErr(e)}`);
  }
  metadataCache.set(coinType, meta);
  return meta;
}

async function priceFor(coinType: string): Promise<number> {
  if (isStableCoinType(coinType)) return 1;
  const id = COIN_COINGECKO[coinType];
  if (!id) return 0;
  const prices = await getCoinGeckoPrices([id]).catch(() => new Map<string, number>());
  return prices.get(id) ?? 0;
}

async function fetchCoins(wallet: string): Promise<PositionItem[]> {
  const balances = await rpcCall<Balance[]>("suix_getAllBalances", [wallet]);
  const out: PositionItem[] = [];
  for (const b of balances) {
    const raw = BigInt(b.totalBalance || "0");
    if (raw <= 0n) continue;
    const meta = await coinMetadata(b.coinType);
    const decimals = meta.decimals ?? 9;
    const quantity = Number(raw) / 10 ** decimals;
    const price = await priceFor(b.coinType);
    out.push({
      source: "sui",
      ticker: meta.symbol ?? short(b.coinType),
      name: meta.name ?? meta.symbol ?? short(b.coinType),
      quantity,
      price,
      value: price * quantity,
      currency: meta.symbol ?? "SUI",
      category: "crypto",
      chain: "sui",
      description: b.coinType,
    });
  }
  return out;
}

function short(s: string): string {
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}
