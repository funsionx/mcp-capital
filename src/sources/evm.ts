import type { Category, PositionItem, Source } from "../lib/types.ts";
import { fetchJson } from "../lib/http.ts";
import { requireEnv } from "../lib/env.ts";

const BASE = "https://api.zerion.io/v1";

interface ZerionResponse {
  data?: ZerionPosition[];
}
interface ZerionPosition {
  attributes?: {
    quantity?: { float?: number };
    value?: number | null;
    price?: number | null;
    position_type?: string; // wallet | deposited | staked | borrowed | reward
    protocol?: string | null;
    apy?: number | null;
    fungible_info?: {
      name?: string;
      symbol?: string;
      description?: string | null;
    };
  };
  relationships?: {
    chain?: { data?: { id?: string } };
  };
}

/** Both EVM wallets via Zerion, including DeFi (deposited/staked/borrowed). */
export async function fetchPositions(): Promise<PositionItem[]> {
  const apiKey = requireEnv("ZERION_API_KEY");
  const w1 = requireEnv("EVM_WALLET_1");
  const w2 = requireEnv("EVM_WALLET_2");
  const auth = `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`;

  const [p1, p2] = await Promise.all([
    fetchWallet(w1, "evm_1", auth),
    fetchWallet(w2, "evm_2", auth),
  ]);
  return [...p1, ...p2];
}

async function fetchWallet(address: string, source: Source, auth: string): Promise<PositionItem[]> {
  const url =
    `${BASE}/wallets/${address}/positions/` +
    `?filter[position_types]=wallet,deposited,borrowed,staked&currency=usd`;
  const res = await fetchJson<ZerionResponse>(url, {
    headers: { Authorization: auth, accept: "application/json" },
  });

  const out: PositionItem[] = [];
  for (const p of res.data ?? []) {
    const a = p.attributes;
    if (!a) continue;
    const quantity = a.quantity?.float ?? 0;
    const value = a.value ?? 0;
    if (quantity === 0 && value === 0) continue;

    const positionType = a.position_type ?? "wallet";
    const isDefi = positionType !== "wallet";
    const category: Category = isDefi ? "defi" : "crypto";
    const fi = a.fungible_info;
    const protocol = a.protocol ?? undefined;

    out.push({
      source,
      ticker: fi?.symbol ?? "?",
      name: fi?.name ?? fi?.symbol ?? "?",
      quantity,
      price: a.price ?? (quantity ? value / quantity : 0),
      value,
      currency: fi?.symbol ?? "USD",
      category,
      chain: p.relationships?.chain?.data?.id,
      apy: a.apy ?? undefined,
      description: describe(positionType, protocol, fi?.description),
    });
  }
  return out;
}

function describe(
  positionType: string,
  protocol?: string,
  fallback?: string | null,
): string | undefined {
  if (positionType !== "wallet") {
    return `${positionType}${protocol ? ` @ ${protocol}` : ""}`;
  }
  return fallback ?? undefined;
}
