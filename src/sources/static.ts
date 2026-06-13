import type { PositionItem } from "../lib/types.ts";
import { getUsdRub } from "../lib/usdRub.ts";

/** Hardcoded off-exchange positions. Currently: ЦФА Альфа (digital financial asset). */
export async function fetchPositions(): Promise<PositionItem[]> {
  const rub = 50_000;
  const usdRub = await getUsdRub();
  const valueUsd = rub / usdRub;

  return [
    {
      source: "static",
      ticker: "ALFA_CFA",
      name: "ЦФА Альфа",
      quantity: 1,
      price: valueUsd,
      priceRub: rub,
      value: valueUsd,
      valueRub: rub,
      currency: "RUB",
      description: "Цифровой финансовый актив Альфа (внебиржевая позиция, фиксированная стоимость)",
      category: "cfa",
    },
  ];
}
