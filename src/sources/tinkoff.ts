import type { Category, PositionItem } from "../lib/types.ts";
import { fetchJson, stringifyErr } from "../lib/http.ts";
import { requireEnv } from "../lib/env.ts";
import { quotationToNumber, type Quotation } from "../lib/money.ts";
import { getUsdRub } from "../lib/usdRub.ts";

const HOST = "https://invest-public-api.tbank.ru/rest";
const PORTFOLIO = `${HOST}/tinkoff.public.invest.api.contract.v1.OperationsService/GetPortfolio`;
const INSTRUMENT = `${HOST}/tinkoff.public.invest.api.contract.v1.InstrumentsService/GetInstrumentBy`;

interface PortfolioPosition {
  figi: string;
  instrumentType?: string;
  quantity?: Quotation;
  currentPrice?: Quotation;
  averagePositionPrice?: Quotation;
  expectedYield?: Quotation;
}
interface PortfolioResponse {
  positions?: PortfolioPosition[];
}
interface Instrument {
  ticker?: string;
  name?: string;
  isin?: string;
  instrumentKind?: string;
}
interface InstrumentResponse {
  instrument?: Instrument;
}

export async function fetchPositions(): Promise<PositionItem[]> {
  const token = requireEnv("TINKOFF_TOKEN");
  const accountId = requireEnv("TINKOFF_ACCOUNT_ID");
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };

  const portfolio = await fetchJson<PortfolioResponse>(PORTFOLIO, {
    method: "POST",
    headers,
    body: JSON.stringify({ accountId }),
  });

  const positions = portfolio.positions ?? [];
  const usdRub = await getUsdRub();

  return Promise.all(
    positions.map(async (p) => {
      const quantity = quotationToNumber(p.quantity);
      const unitPrice = quotationToNumber(p.currentPrice);
      const currency = (p.currentPrice?.currency ?? "rub").toUpperCase();
      const instrument = await lookupInstrument(headers, p.figi);

      const ticker = instrument?.ticker ?? p.figi;
      const name = instrument?.name ?? p.figi;
      const category = mapCategory(p.instrumentType, instrument?.instrumentKind);

      const item: PositionItem = {
        source: "tinkoff",
        ticker,
        name,
        quantity,
        price: 0,
        value: 0,
        currency,
        category,
        description: instrument?.isin ? `ISIN ${instrument.isin}` : undefined,
      };

      if (currency === "RUB") {
        item.priceRub = unitPrice;
        item.valueRub = quantity * unitPrice;
        item.price = unitPrice / usdRub;
        item.value = item.valueRub / usdRub;
      } else if (currency === "USD") {
        item.price = unitPrice;
        item.value = quantity * unitPrice;
      } else {
        // Other currencies: report native value as USD-equivalent best-effort.
        item.price = unitPrice;
        item.value = quantity * unitPrice;
      }
      return item;
    }),
  );
}

async function lookupInstrument(
  headers: Record<string, string>,
  figi: string,
): Promise<Instrument | undefined> {
  try {
    const res = await fetchJson<InstrumentResponse>(INSTRUMENT, {
      method: "POST",
      headers,
      body: JSON.stringify({ idType: "INSTRUMENT_ID_TYPE_FIGI", id: figi }),
    });
    return res.instrument;
  } catch (e) {
    // Degrade to figi-as-ticker rather than dropping the position.
    console.error(`[tinkoff] instrument lookup failed for ${figi}: ${stringifyErr(e)}`);
    return undefined;
  }
}

function mapCategory(instrumentType?: string, instrumentKind?: string): Category {
  const t = (instrumentType ?? instrumentKind ?? "").toLowerCase();
  if (t.includes("bond")) return "bond";
  if (t.includes("etf")) return "etf";
  if (t.includes("share") || t.includes("stock")) return "stock";
  if (t.includes("currency")) return "mmf"; // cash / money position
  return "stock";
}
