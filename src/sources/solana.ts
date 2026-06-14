import type { PositionItem } from "../lib/types.ts";
import { fetchJson, stringifyErr } from "../lib/http.ts";
import { requireEnv } from "../lib/env.ts";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUP_PRICE = "https://lite-api.jup.ag/price/v3";

interface RpcResponse<T> {
  result?: T;
  error?: { message?: string };
}
interface AssetsByOwner {
  items?: Asset[];
}
interface Asset {
  id: string;
  content?: { metadata?: { name?: string; symbol?: string } };
  token_info?: {
    balance?: number;
    decimals?: number;
    symbol?: string;
    price_info?: { price_per_token?: number };
  };
}

export async function fetchPositions(): Promise<PositionItem[]> {
  const wallet = requireEnv("SOLANA_WALLET");
  const apiKey = requireEnv("HELIUS_API_KEY");
  const rpc = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;

  const [native, tokens] = await Promise.all([
    fetchNative(rpc, wallet),
    fetchTokens(rpc, wallet),
  ]);

  const all = native ? [native, ...tokens] : tokens;
  await backfillPrices(all);
  // Drop dust we still can't price.
  return all.filter((p) => p.value > 0 || p.quantity > 0);
}

async function rpcCall<T>(rpc: string, method: string, params: unknown): Promise<T> {
  const res = await fetchJson<RpcResponse<T>>(rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "1", method, params }),
  });
  if (res.error) throw new Error(`Helius ${method}: ${res.error.message ?? "rpc error"}`);
  if (res.result === undefined) throw new Error(`Helius ${method}: empty result`);
  return res.result;
}

async function fetchNative(rpc: string, wallet: string): Promise<PositionItem | null> {
  const result = await rpcCall<{ value?: number }>(rpc, "getBalance", [wallet]);
  const lamports = result.value ?? 0;
  const sol = lamports / 1e9;
  if (sol <= 0) return null;
  return {
    source: "solana",
    ticker: "SOL",
    name: "Solana",
    quantity: sol,
    price: 0,
    value: 0,
    currency: "SOL",
    category: "crypto",
    chain: "solana",
  };
}

async function fetchTokens(rpc: string, wallet: string): Promise<PositionItem[]> {
  const result = await rpcCall<AssetsByOwner>(rpc, "getAssetsByOwner", {
    ownerAddress: wallet,
    page: 1,
    limit: 1000,
    displayOptions: { showFungible: true, showZeroBalance: false },
  });

  const out: PositionItem[] = [];
  for (const asset of result.items ?? []) {
    const ti = asset.token_info;
    if (!ti || ti.balance == null) continue;
    const decimals = ti.decimals ?? 0;
    const quantity = ti.balance / 10 ** decimals;
    if (quantity <= 0) continue;
    const price = ti.price_info?.price_per_token ?? 0;
    out.push({
      source: "solana",
      ticker: ti.symbol ?? asset.content?.metadata?.symbol ?? short(asset.id),
      name: asset.content?.metadata?.name ?? ti.symbol ?? short(asset.id),
      quantity,
      price,
      value: price * quantity,
      currency: ti.symbol ?? "SPL",
      category: "crypto",
      chain: "solana",
      description: `mint ${asset.id}`,
    });
  }
  return out;
}

/** Fill USD prices for SOL + any token left at price 0 via Jupiter (keyless). */
async function backfillPrices(items: PositionItem[]): Promise<void> {
  const mints = new Map<string, PositionItem[]>();
  for (const it of items) {
    if (it.price > 0) continue;
    const mint = it.ticker === "SOL" ? SOL_MINT : mintFromDescription(it.description);
    if (!mint) continue;
    const arr = mints.get(mint) ?? [];
    arr.push(it);
    mints.set(mint, arr);
  }
  if (mints.size === 0) return;

  try {
    const ids = [...mints.keys()].join(",");
    const data = await fetchJson<Record<string, { usdPrice?: number }>>(
      `${JUP_PRICE}?ids=${ids}`,
    );
    for (const [mint, arr] of mints) {
      const price = data[mint]?.usdPrice;
      if (typeof price !== "number") continue;
      for (const it of arr) {
        it.price = price;
        it.value = price * it.quantity;
      }
    }
  } catch (e) {
    console.error(`[solana] Jupiter price backfill failed: ${stringifyErr(e)}`);
  }
}

function mintFromDescription(desc?: string): string | undefined {
  const m = desc?.match(/^mint (.+)$/);
  return m?.[1];
}

function short(s: string): string {
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}
