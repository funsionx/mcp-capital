import type { PositionItem } from "../lib/types.ts";
import { fetchJson, stringifyErr } from "../lib/http.ts";
import { requireEnv } from "../lib/env.ts";
import { getCoinGeckoPrices } from "../lib/coingecko.ts";
import { getAmountsForLiquidity } from "../lib/clmm.ts";

const RPC = "https://fullnode.mainnet.sui.io:443";
const SUI_TYPE = "0x2::sui::SUI";

// Bluefin Spot CLMM position object type (mainnet).
const BLUEFIN_POSITION_TYPE =
  "0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267::position::Position";

/** Sui coinType -> CoinGecko id. Unknown coins are listed at price 0. */
const COIN_COINGECKO: Record<string, string> = {
  [SUI_TYPE]: "sui",
  "0x549e8b69270defbfafd4f94e17ec44cdbdd99820b33bda2278dea3b9a32d3f55::cert::CERT": "volo-staked-sui",
  // USDC (native Circle) and common stables:
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC": "usd-coin",
  "0x5d4b302506645c37ff133b98c4b50a5ae14841659738d6d733d59d0d217a93bf::coin::COIN": "usd-coin", // wormhole USDC
  "0xc060006111016b8a020ad5b33834984a437aaa7d3c74c18e09a95d48aceab08c::coin::COIN": "tether", // wormhole USDT
};

interface RpcResponse<T> {
  result?: T;
  error?: { message?: string };
}
interface Balance {
  coinType: string;
  totalBalance: string;
}
interface CoinMetadata {
  decimals?: number;
  symbol?: string;
  name?: string;
}
interface OwnedObjects {
  data?: { data?: SuiObjectData }[];
}
interface SuiObjectData {
  objectId?: string;
  type?: string;
  content?: { fields?: Record<string, unknown> };
}

const metadataCache = new Map<string, CoinMetadata>();

export async function fetchPositions(): Promise<PositionItem[]> {
  const wallet = requireEnv("SUI_WALLET");

  const [coins, defi] = await Promise.all([
    fetchCoins(wallet),
    fetchBluefinLp(wallet).catch((e) => {
      console.error(`[sui] Bluefin LP scan failed: ${stringifyErr(e)}`);
      return [] as PositionItem[];
    }),
  ]);
  return [...coins, ...defi];
}

async function rpcCall<T>(method: string, params: unknown[]): Promise<T> {
  const res = await fetchJson<RpcResponse<T>>(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (res.error) throw new Error(`Sui ${method}: ${res.error.message ?? "rpc error"}`);
  if (res.result === undefined) throw new Error(`Sui ${method}: empty result`);
  return res.result;
}

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

/** Bluefin Spot concentrated-liquidity positions (DeFi). */
async function fetchBluefinLp(wallet: string): Promise<PositionItem[]> {
  const owned = await rpcCall<OwnedObjects>("suix_getOwnedObjects", [
    wallet,
    {
      filter: { StructType: BLUEFIN_POSITION_TYPE },
      options: { showContent: true, showType: true },
    },
  ]);

  const out: PositionItem[] = [];
  for (const entry of owned.data ?? []) {
    const data = entry.data;
    const fields = data?.content?.fields;
    if (!fields) continue;
    try {
      out.push(await valueBluefinPosition(data!, fields));
    } catch (e) {
      // Never drop a position silently; report it unvalued.
      console.error(`[sui] Bluefin position ${data?.objectId} valuation failed: ${stringifyErr(e)}`);
      out.push({
        source: "sui",
        ticker: "BLUEFIN-LP",
        name: "Bluefin Spot LP",
        quantity: 1,
        price: 0,
        value: 0,
        currency: "USD",
        category: "defi",
        chain: "sui",
        description: `Bluefin Spot LP ${short(data?.objectId ?? "?")} (valuation unavailable)`,
      });
    }
  }
  return out;
}

async function valueBluefinPosition(
  data: SuiObjectData,
  fields: Record<string, unknown>,
): Promise<PositionItem> {
  const poolId = String(fields["pool_id"] ?? fields["pool"] ?? "");
  const liquidity = Number(parseField(fields["liquidity"]) ?? 0);
  const lowerTick = Number(parseField(fields["lower_tick"] ?? fields["tick_lower_index"]) ?? 0);
  const upperTick = Number(parseField(fields["upper_tick"] ?? fields["tick_upper_index"]) ?? 0);
  if (!poolId || liquidity <= 0) throw new Error("missing pool_id/liquidity");

  const pool = await rpcCall<{ data?: SuiObjectData }>("sui_getObject", [
    poolId,
    { showContent: true, showType: true },
  ]);
  const poolData = pool.data;
  const poolFields = poolData?.content?.fields ?? {};
  const sqrtPriceX64 = Number(parseField(poolFields["current_sqrt_price"] ?? poolFields["sqrt_price"]) ?? 0);
  if (sqrtPriceX64 <= 0) throw new Error("pool sqrt price unavailable");

  const [coinA, coinB] = parseGenerics(poolData?.type ?? "");
  if (!coinA || !coinB) throw new Error("pool coin types unavailable");

  const [metaA, metaB, priceA, priceB] = await Promise.all([
    coinMetadata(coinA),
    coinMetadata(coinB),
    priceFor(coinA),
    priceFor(coinB),
  ]);
  const decA = metaA.decimals ?? 9;
  const decB = metaB.decimals ?? 9;

  const { amount0Raw, amount1Raw } = getAmountsForLiquidity(
    sqrtPriceX64,
    lowerTick,
    upperTick,
    liquidity,
  );
  const amountA = amount0Raw / 10 ** decA;
  const amountB = amount1Raw / 10 ** decB;
  const value = amountA * priceA + amountB * priceB;

  const symA = metaA.symbol ?? short(coinA);
  const symB = metaB.symbol ?? short(coinB);

  return {
    source: "sui",
    ticker: `BLUEFIN-${symA}/${symB}`,
    name: `Bluefin Spot LP ${symA}/${symB}`,
    quantity: 1,
    price: value,
    value,
    currency: "USD",
    category: "defi",
    chain: "sui",
    description:
      `Bluefin Spot LP ${short(data.objectId ?? "?")}: ` +
      `${amountA.toFixed(4)} ${symA} + ${amountB.toFixed(4)} ${symB}` +
      (value === 0 ? " (token prices unavailable)" : ""),
  };
}

/** Sui Move fields can be a scalar or a wrapped struct like { fields: { bits } }. */
function parseField(v: unknown): string | number | undefined {
  if (v == null) return undefined;
  if (typeof v === "number" || typeof v === "string") return v;
  if (typeof v === "object") {
    const obj = v as Record<string, unknown>;
    const inner = (obj["fields"] as Record<string, unknown> | undefined) ?? obj;
    const bits = inner["bits"] ?? inner["value"] ?? inner["val"];
    if (typeof bits === "number" || typeof bits === "string") return bits;
  }
  return undefined;
}

/** Extract top-level generic type args from a Move type string. */
function parseGenerics(type: string): [string?, string?] {
  const lt = type.indexOf("<");
  const gt = type.lastIndexOf(">");
  if (lt === -1 || gt === -1 || gt <= lt) return [undefined, undefined];
  const inner = type.slice(lt + 1, gt);
  const args: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of inner) {
    if (ch === "<") depth++;
    if (ch === ">") depth--;
    if (ch === "," && depth === 0) {
      args.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) args.push(cur.trim());
  return [args[0], args[1]];
}

function short(s: string): string {
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}
