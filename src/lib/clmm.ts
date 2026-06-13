/**
 * Concentrated-liquidity (Uniswap-V3 / Cetus / Bluefin-style) token amount math.
 *
 * Given a position's liquidity and tick range plus the pool's current sqrt price,
 * compute the underlying raw token amounts. This is a floating-point approximation
 * — adequate for portfolio valuation, not for on-chain settlement.
 *
 * Sui CLMM pools store the price as sqrtPrice in Q64.64 fixed point
 * (sqrtPriceX64 = sqrt(token1/token0) * 2^64), where the ratio already includes
 * token decimals. The resulting amounts are in each token's raw (smallest) units.
 */

const Q64 = 2 ** 64;

function tickToSqrtPrice(tick: number): number {
  // sqrt(1.0001^tick) = 1.0001^(tick/2)
  return Math.pow(1.0001, tick / 2);
}

export interface ClmmAmounts {
  amount0Raw: number;
  amount1Raw: number;
}

export function getAmountsForLiquidity(
  sqrtPriceX64: number,
  lowerTick: number,
  upperTick: number,
  liquidity: number,
): ClmmAmounts {
  const sqrtP = sqrtPriceX64 / Q64;
  let sqrtA = tickToSqrtPrice(lowerTick);
  let sqrtB = tickToSqrtPrice(upperTick);
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];

  let amount0Raw = 0;
  let amount1Raw = 0;

  if (sqrtP <= sqrtA) {
    amount0Raw = liquidity * (1 / sqrtA - 1 / sqrtB);
  } else if (sqrtP < sqrtB) {
    amount0Raw = liquidity * (1 / sqrtP - 1 / sqrtB);
    amount1Raw = liquidity * (sqrtP - sqrtA);
  } else {
    amount1Raw = liquidity * (sqrtB - sqrtA);
  }

  return {
    amount0Raw: Number.isFinite(amount0Raw) ? amount0Raw : 0,
    amount1Raw: Number.isFinite(amount1Raw) ? amount1Raw : 0,
  };
}
