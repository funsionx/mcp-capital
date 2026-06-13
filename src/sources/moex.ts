import type { PositionItem } from "../lib/types.ts";
import { fetchJson } from "../lib/http.ts";
import { getUsdRub } from "../lib/usdRub.ts";

const QUANTITY = 182;
const URL =
  "https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQTF/securities/AKMM.json" +
  "?iss.meta=off&iss.only=securities,marketdata" +
  "&securities.columns=SECID,SHORTNAME,SECNAME,DECIMALS" +
  "&marketdata.columns=SECID,LAST,LCURRENTPRICE";

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

  const mdRow = res.marketdata?.data?.[0];
  if (!mdRow) throw new Error("MOEX ISS: no marketdata row for AKMM");

  const last = toNum(col(res.marketdata, mdRow, "LAST"));
  const lcp = toNum(col(res.marketdata, mdRow, "LCURRENTPRICE"));
  const priceRub = last ?? lcp;
  if (priceRub == null) throw new Error("MOEX ISS: AKMM price (LAST/LCURRENTPRICE) unavailable");

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
