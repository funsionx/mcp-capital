import type { PositionItem, Source } from "./types.ts";

/**
 * Human-friendly display names per source, surfaced in `sourceBreakdown[*].label`
 * so the consuming agent renders meaningful group names. Edit freely — purely cosmetic.
 */
const LABELS: Partial<Record<Source, string>> = {
  tinkoff: "Российский фондовый рынок",
  moex: "Фонд денежного рынка Альфа",
  evm_1: "EVM 1 (The Vault)",
  evm_2: "EVM 2 (Risk)",
  bybit: "Bybit",
  solana: "Solana",
  sui: "Sui",
  near: "NEAR",
  hyperliquid: "Hyperliquid",
  static: "Депозиты",
};

export function sourceLabel(source: Source): string {
  return LABELS[source] ?? source;
}

/** Static/manual sources show the held assets in parens, e.g. "Депозиты (Кубышка ВТБ, ...)". */
export function staticLabel(staticPositions: PositionItem[]): string {
  const names = staticPositions.map((p) => p.name).filter(Boolean);
  return names.length ? `${LABELS.static} (${names.join(", ")})` : (LABELS.static ?? "static");
}
