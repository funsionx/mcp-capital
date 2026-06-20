import type { PositionItem } from "../lib/types.ts";
import { stringifyErr } from "../lib/http.ts";
import { bybitSignedGet, bybitSpotPrice } from "../lib/bybit.ts";

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
const EARN_CATEGORIES = ["FlexibleSaving", "OnChain"] as const;

export async function fetchPositions(): Promise<PositionItem[]> {
  const [wallet, positions, earn] = await Promise.all([fetchWallet(), fetchOpenPositions(), fetchEarn()]);
  return [...wallet, ...positions, ...earn];
}

async function fetchWallet(): Promise<PositionItem[]> {
  const result = await bybitSignedGet<WalletBalance>("/v5/account/wallet-balance", "accountType=UNIFIED");
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

async function fetchOpenPositions(): Promise<PositionItem[]> {
  try {
    const result = await bybitSignedGet<PositionList>("/v5/position/list", "category=linear&settleCoin=USDT");
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

async function fetchEarn(): Promise<PositionItem[]> {
  const out: PositionItem[] = [];
  for (const category of EARN_CATEGORIES) {
    try {
      const result = await bybitSignedGet<EarnList>("/v5/earn/position", `category=${category}`);
      for (const p of result.list ?? []) {
        const coin = p.coin ?? "";
        const quantity = num(p.amount);
        if (!coin || quantity <= 0) continue;
        const price = await bybitSpotPrice(coin);
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

function num(v: string | undefined): number {
  if (v == null || v === "") return 0;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}
