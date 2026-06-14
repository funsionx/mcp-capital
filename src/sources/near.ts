import type { PositionItem } from "../lib/types.ts";
import { fetchJson, stringifyErr } from "../lib/http.ts";
import { requireEnv } from "../lib/env.ts";
import { getCoinGeckoPrices } from "../lib/coingecko.ts";

const RPC = "https://rpc.mainnet.near.org";
const FASTNEAR = (acc: string) => `https://api.fastnear.com/v1/account/${acc}/ft`;
const FASTNEAR_STAKING = (acc: string) => `https://api.fastnear.com/v1/account/${acc}/staking`;

/** Known NEAR FT contract -> CoinGecko id. Unknown tokens are listed at price 0. */
const FT_COINGECKO: Record<string, string> = {
  "wrap.near": "wrapped-near",
  "usdt.tether-token.near": "tether",
  "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1": "usd-coin", // USDC (Circle native)
  "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.factory.bridge.near": "usd-coin", // USDC.e (bridged)
  "dac17f958d2ee523a2206206994597c13d831ec7.factory.bridge.near": "tether", // USDT.e (bridged)
  "aurora": "ethereum", // wrapped ETH on Aurora
  "token.sweat": "sweatcoin",
};

interface RpcResponse<T> {
  result?: T;
  error?: unknown;
}
interface ViewAccount {
  amount?: string;
}
interface CallFunctionResult {
  result?: number[];
}
interface FtMetadata {
  symbol?: string;
  name?: string;
  decimals?: number;
}
interface FastNearFt {
  tokens?: { contract_id: string; balance?: string }[];
}
interface FastNearStaking {
  pools?: { pool_id: string }[];
}

export async function fetchPositions(): Promise<PositionItem[]> {
  const wallet = requireEnv("NEAR_WALLET");

  const [native, fts, staked] = await Promise.all([
    fetchNative(wallet),
    fetchFts(wallet),
    fetchStaking(wallet),
  ]);

  const items = [...(native ? [native] : []), ...fts, ...staked];

  // Price native NEAR + any FT we have a CoinGecko mapping for.
  const ids = new Set<string>(["near"]);
  for (const it of items) {
    const id = it.description ? FT_COINGECKO[it.description] : undefined;
    if (id) ids.add(id);
  }
  const prices = await getCoinGeckoPrices([...ids]).catch(() => new Map<string, number>());

  for (const it of items) {
    const id = it.ticker === "NEAR" ? "near" : it.description ? FT_COINGECKO[it.description] : undefined;
    const price = id ? prices.get(id) : undefined;
    if (typeof price === "number") {
      it.price = price;
      it.value = price * it.quantity;
    }
  }
  return items;
}

async function rpcCall<T>(method: string, params: unknown): Promise<T> {
  const res = await fetchJson<RpcResponse<T>>(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "1", method, params }),
  });
  if (res.error) throw new Error(`NEAR ${method}: ${JSON.stringify(res.error)}`);
  if (res.result === undefined) throw new Error(`NEAR ${method}: empty result`);
  return res.result;
}

async function fetchNative(wallet: string): Promise<PositionItem | null> {
  const acc = await rpcCall<ViewAccount>("query", {
    request_type: "view_account",
    finality: "final",
    account_id: wallet,
  });
  const near = Number(BigInt(acc.amount ?? "0")) / 1e24;
  if (near <= 0) return null;
  return {
    source: "near",
    ticker: "NEAR",
    name: "NEAR Protocol",
    quantity: near,
    price: 0,
    value: 0,
    currency: "NEAR",
    category: "crypto",
    chain: "near",
  };
}

async function fetchFts(wallet: string): Promise<PositionItem[]> {
  let list: FastNearFt;
  try {
    list = await fetchJson<FastNearFt>(FASTNEAR(wallet));
  } catch (e) {
    console.error(`[near] FastNear FT list failed: ${stringifyErr(e)}`);
    return [];
  }

  const tokens = (list.tokens ?? []).filter((t) => t.balance && t.balance !== "0");
  const items = await Promise.all(
    tokens.map(async (t) => {
      try {
        const meta = await ftMetadata(t.contract_id);
        const decimals = meta.decimals ?? 0;
        const quantity = Number(BigInt(t.balance ?? "0")) / 10 ** decimals;
        if (quantity <= 0) return null;
        const item: PositionItem = {
          source: "near",
          ticker: meta.symbol ?? t.contract_id,
          name: meta.name ?? meta.symbol ?? t.contract_id,
          quantity,
          price: 0,
          value: 0,
          currency: meta.symbol ?? "FT",
          category: "crypto",
          chain: "near",
          description: t.contract_id, // used to map to CoinGecko id
        };
        return item;
      } catch (e) {
        console.error(`[near] FT ${t.contract_id} skipped: ${stringifyErr(e)}`);
        return null;
      }
    }),
  );
  return items.filter((x): x is PositionItem => x !== null);
}

/** Staked NEAR delegated to staking pools (e.g. here.poolv1.near). */
async function fetchStaking(wallet: string): Promise<PositionItem[]> {
  let list: FastNearStaking;
  try {
    list = await fetchJson<FastNearStaking>(FASTNEAR_STAKING(wallet));
  } catch (e) {
    console.error(`[near] FastNear staking list failed: ${stringifyErr(e)}`);
    return [];
  }

  const pools = (list.pools ?? []).map((p) => p.pool_id).filter(Boolean);
  const items = await Promise.all(
    pools.map(async (pool) => {
      try {
        const total = await viewU128(pool, "get_account_total_balance", { account_id: wallet });
        const near = Number(total) / 1e24;
        if (near <= 0) return null;
        const item: PositionItem = {
          source: "near",
          ticker: "NEAR", // priced as NEAR below
          name: `Staked NEAR @ ${pool}`,
          quantity: near,
          price: 0,
          value: 0,
          currency: "NEAR",
          category: "defi",
          chain: "near",
          description: `Delegated stake in ${pool}`,
        };
        return item;
      } catch (e) {
        console.error(`[near] staking ${pool} skipped: ${stringifyErr(e)}`);
        return null;
      }
    }),
  );
  return items.filter((x): x is PositionItem => x !== null);
}

/** Call a view method returning a U128 (JSON-quoted yoctoNEAR string). */
async function viewU128(contract: string, method: string, args: object): Promise<bigint> {
  const res = await rpcCall<CallFunctionResult>("query", {
    request_type: "call_function",
    finality: "final",
    account_id: contract,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  const json = Buffer.from(res.result ?? []).toString("utf8").trim();
  // U128 view methods return a JSON string like "12345..."
  return BigInt(JSON.parse(json));
}

async function ftMetadata(contract: string): Promise<FtMetadata> {
  const res = await rpcCall<CallFunctionResult>("query", {
    request_type: "call_function",
    finality: "final",
    account_id: contract,
    method_name: "ft_metadata",
    args_base64: Buffer.from("{}").toString("base64"),
  });
  const bytes = res.result ?? [];
  const json = Buffer.from(bytes).toString("utf8");
  return JSON.parse(json) as FtMetadata;
}
