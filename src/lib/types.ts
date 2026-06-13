/** Canonical, fine-grained source identifier attached to every position. */
export type Source =
  | "tinkoff"
  | "bybit"
  | "moex"
  | "evm_1"
  | "evm_2"
  | "solana"
  | "sui"
  | "near"
  | "static";

/** Coarse source token accepted by the tool's `includeSources` filter. */
export type SourceFilter =
  | "tinkoff"
  | "bybit"
  | "moex"
  | "evm"
  | "solana"
  | "sui"
  | "near"
  | "static";

export type Category =
  | "stock"
  | "bond"
  | "crypto"
  | "etf"
  | "defi"
  | "mmf"
  | "cfa";

/** Single normalized holding, shared across every source. */
export interface PositionItem {
  source: Source;
  ticker: string;
  name: string;
  quantity: number;
  /** Current unit price in USD. */
  price: number;
  /** Unit price in RUB, when applicable. */
  priceRub?: number;
  /** quantity * price, in USD. */
  value: number;
  /** Total value in RUB, when applicable. */
  valueRub?: number;
  /** "RUB" | "USD" | "USDT" | token symbol ... */
  currency: string;
  description?: string;
  category: Category;
  /** For crypto/DeFi: "ethereum" | "bsc" | "solana" | "sui" | "near" | "bybit" ... */
  chain?: string;
  /** For DeFi positions, when available. */
  apy?: number;
}

/** Contract implemented by every source module. */
export type FetchPositions = () => Promise<PositionItem[]>;
