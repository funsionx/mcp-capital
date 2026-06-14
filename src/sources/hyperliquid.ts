import type { PositionItem } from "../lib/types.ts";
import { fetchJson } from "../lib/http.ts";
import { optionalEnv } from "../lib/env.ts";

const INFO = "https://api.hyperliquid.xyz/info";

const STABLES = new Set(["USDC", "USDT", "USDT0", "USDH", "USDE", "USD", "DAI"]);

interface ClearinghouseState {
  marginSummary?: { accountValue?: string };
  assetPositions?: { position?: { coin?: string; szi?: string; positionValue?: string; unrealizedPnl?: string } }[];
}
interface SpotState {
  balances?: { coin?: string; token?: number; total?: string }[];
}
// spotMetaAndAssetCtxs returns [meta, ctxs]
interface SpotMeta {
  tokens?: { name?: string; index?: number }[];
  universe?: { tokens?: [number, number]; index?: number }[];
}
type SpotAssetCtx = { midPx?: string | null };

/**
 * Hyperliquid (HyperCore) holdings by address: perps account equity + spot
 * balances. Keyless. NOTE: this is the L1 trading account, which Zerion's
 * "hyperevm" coverage does NOT include. Address defaults to EVM_WALLET_2 (the
 * account is funded from / addressed by that EVM address) unless HYPERLIQUID_WALLET
 * is set explicitly.
 */
export async function fetchPositions(): Promise<PositionItem[]> {
  const wallet = optionalEnv("HYPERLIQUID_WALLET") ?? optionalEnv("EVM_WALLET_2");
  if (!wallet) throw new Error("Set HYPERLIQUID_WALLET (or EVM_WALLET_2) for Hyperliquid");

  const [perps, spot] = await Promise.all([
    fetchPerps(wallet),
    fetchSpot(wallet),
  ]);
  return [...perps, ...spot];
}

async function post<T>(body: unknown): Promise<T> {
  return fetchJson<T>(INFO, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function fetchPerps(wallet: string): Promise<PositionItem[]> {
  const ch = await post<ClearinghouseState>({ type: "clearinghouseState", user: wallet });
  const accountValue = Number(ch.marginSummary?.accountValue ?? "0");
  if (accountValue <= 0) return [];

  const open = (ch.assetPositions ?? [])
    .map((p) => p.position)
    .filter((p): p is NonNullable<typeof p> => !!p && Number(p.szi ?? "0") !== 0)
    .map((p) => `${p.coin} ${p.szi} (uPnL ${p.unrealizedPnl ?? "0"})`)
    .join(", ");

  // Account equity is the true USD worth; positions are summarized in description
  // to avoid double-counting notional position value.
  return [
    {
      source: "hyperliquid",
      ticker: "HL-PERPS",
      name: "Hyperliquid perps account",
      quantity: 1,
      price: accountValue,
      value: accountValue,
      currency: "USDC",
      category: "defi",
      chain: "hyperliquid",
      description: open ? `Open: ${open}` : "Margin/collateral (no open positions)",
    },
  ];
}

async function fetchSpot(wallet: string): Promise<PositionItem[]> {
  const [state, prices] = await Promise.all([
    post<SpotState>({ type: "spotClearinghouseState", user: wallet }),
    spotPrices(),
  ]);

  const out: PositionItem[] = [];
  for (const b of state.balances ?? []) {
    const coin = b.coin ?? "";
    const quantity = Number(b.total ?? "0");
    if (!coin || quantity <= 0) continue;
    // Price by token index (spot names collide); stables resolve to 1.
    const price = STABLES.has(coin.toUpperCase())
      ? 1
      : (b.token != null ? prices.get(b.token) : undefined) ?? 0;
    out.push({
      source: "hyperliquid",
      ticker: coin,
      name: coin,
      quantity,
      price,
      value: price * quantity,
      currency: coin,
      category: "crypto",
      chain: "hyperliquid",
      description: "Hyperliquid spot",
    });
  }
  return out;
}

/** Build token-index -> USD mid price from spot pairs quoted in a USD stable. */
async function spotPrices(): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  try {
    const [meta, ctxs] = await post<[SpotMeta, SpotAssetCtx[]]>({ type: "spotMetaAndAssetCtxs" });
    const tokens = meta.tokens ?? [];
    const usdcIndex = tokens.find((t) => (t.name ?? "").toUpperCase() === "USDC")?.index;
    const stableIdx = new Set(
      tokens.filter((t) => STABLES.has((t.name ?? "").toUpperCase())).map((t) => t.index),
    );
    const universe = meta.universe ?? [];
    const consider = (preferUsdc: boolean) =>
      universe.forEach((pair, i) => {
        const mid = ctxs[i]?.midPx;
        if (!pair.tokens || mid == null) return;
        const [baseIdx, quoteIdx] = pair.tokens;
        const px = Number(mid);
        if (!Number.isFinite(px) || px <= 0) return;
        const quoteOk = preferUsdc ? quoteIdx === usdcIndex : stableIdx.has(quoteIdx);
        if (!quoteOk || map.has(baseIdx)) return;
        map.set(baseIdx, px); // quote is a ~$1 stable, so mid ≈ USD price
      });
    consider(true); // prefer USDC-quoted
    consider(false); // fall back to other stable-quoted pairs
  } catch {
    // Pricing best-effort; balances still listed (possibly at price 0).
  }
  return map;
}
