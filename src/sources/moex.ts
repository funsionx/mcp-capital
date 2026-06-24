import type { PositionItem } from "../lib/types.ts";
import { fetchJson } from "../lib/http.ts";
import { getUsdRub } from "../lib/usdRub.ts";

const QUANTITY = 182;
// AKMM trades on board TQBR (it migrated off the old TQTF ETF board, which now returns
// zero rows — that was the real cause of "no marketdata row").
const URL =
  "https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/securities/AKMM.json" +
  "?iss.meta=off&iss.only=securities,marketdata" +
  "&securities.columns=SECID,SHORTNAME,SECNAME,DECIMALS,PREVPRICE,PREVLEGALCLOSEPRICE" +
  "&marketdata.columns=SECID,LAST,LCURRENTPRICE,LCLOSEPRICE";

interface IssBlock {
  columns: string[];
  data: (string | number | null)[][];
}
interface IssResponse {
  securities: IssBlock;
  marketdata: IssBlock;
}

/** Read by column name, never by positional assumption. */
function col(block: IssBlock, row: (string | number | null)[], name: string): string | number | null {
  const i = block.columns.indexOf(name);
  return i === -1 ? null : row[i] ?? null;
}

/** AKMM — Альфа-Капитал Денежный рынок (money-market fund) on MOEX. */
export async function fetchPositions(): Promise<PositionItem[]> {
  const res = await fetchJson<IssResponse>(URL);

  // Live price during the trading session …
  const mdRow = res.marketdata?.data?.[0];
  const last = mdRow ? toNum(col(res.marketdata, mdRow, "LAST")) : null;
  const lcp = mdRow ? toNum(col(res.marketdata, mdRow, "LCURRENTPRICE")) : null;
  const lclose = mdRow ? toNum(col(res.marketdata, mdRow, "LCLOSEPRICE")) : null;

  // … else fall back to the previous close from the securities block, so AKMM does
  // not vanish from the portfolio every night and weekend when MOEX is closed.
  const secRow = res.securities?.data?.[0];
  const prevPrice = secRow ? toNum(col(res.securities, secRow, "PREVPRICE")) : null;
  const prevLegal = secRow ? toNum(col(res.securities, secRow, "PREVLEGALCLOSEPRICE")) : null;

  const priceRub = last ?? lcp ?? lclose ?? prevPrice ?? prevLegal;
  if (priceRub == null) throw new Error("MOEX ISS: AKMM price unavailable (no live or previous-close quote)");

  const usdRub = await getUsdRub();
  const valueRub = QUANTITY * priceRub;

  return [
    {
      source: "moex",
      ticker: "AKMM",
      name: "Альфа-Капитал Денежный рынок",
      quantity: QUANTITY,
      price: priceRub / usdRub,
      priceRub,
      value: valueRub / usdRub,
      valueRub,
      currency: "RUB",
      description: "Альфа-Капитал Денежный рынок — фонд денежного рынка (ликвидность)",
      category: "mmf",
    },
  ];
}

function toNum(v: string | number | null): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}
