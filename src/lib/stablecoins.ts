/**
 * Single source of truth for USD-stablecoin detection (previously duplicated in
 * evm/bybit/hyperliquid/sui sources).
 */
const STABLE_SYMBOLS = new Set([
  "USDC", "USDT", "USDT0", "USDH", "USDE", "USDS", "USDD", "USDY",
  "DAI", "TUSD", "FDUSD", "BUSD", "FRAX", "GUSD", "AUSD", "USD",
]);

/** True if a coin/token symbol is a known USD stablecoin. */
export function isStableSymbol(symbol?: string): boolean {
  return !!symbol && STABLE_SYMBOLS.has(symbol.toUpperCase());
}

/**
 * Best-effort ~$1 price for assets a price feed couldn't value but that are
 * clearly USD stables — including protocol wrappers (aTokens, vault receipts).
 * Returns 1 when it looks like a USD stable, else null. Used to recover Zerion
 * positions that come back with `value: null` (e.g. `aPlaUSDT0` on Plasma).
 */
export function usdStableValue(symbol?: string, name?: string): number | null {
  const s = `${symbol ?? ""} ${name ?? ""}`.toLowerCase();
  if (/\b(usdt0?|usdc|usde|usdh|usds|usdd|usdy|dai|tusd|fdusd|busd|frax|gusd|ausd)\b/.test(s)) return 1;
  if (/aave .*usd|plasma usd|usd vault/.test(s)) return 1;
  return null;
}

/** True if a Sui coinType is a USD stablecoin (matched on the module name). */
export function isStableCoinType(coinType: string): boolean {
  return /::(usdc|usdt|usdt0|egusdc|usdy|ausd|usdh)::/i.test(coinType);
}
