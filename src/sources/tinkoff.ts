import type { Category, PositionItem } from "../lib/types.ts";
import { fetchJson, stringifyErr } from "../lib/http.ts";
import { requireEnv, optionalEnv } from "../lib/env.ts";
import { quotationToNumber, type Quotation } from "../lib/money.ts";
import { getUsdRub } from "../lib/usdRub.ts";
import { TBANK_CA } from "../lib/tbankCa.ts";

const HOST = "https://invest-public-api.tbank.ru/rest";
const ACCOUNTS = `${HOST}/tinkoff.public.invest.api.contract.v1.UsersService/GetAccounts`;
const PORTFOLIO = `${HOST}/tinkoff.public.invest.api.contract.v1.OperationsService/GetPortfolio`;
const INSTRUMENT = `${HOST}/tinkoff.public.invest.api.contract.v1.InstrumentsService/GetInstrumentBy`;

interface Account {
  id: string;
  name?: string;
  type?: string;
  status?: string;
}
interface AccountsResponse {
  accounts?: Account[];
}
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
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  const accounts = await resolveAccounts(headers);
  if (accounts.length === 0) throw new Error("Tinkoff: no accounts to query");

  const usdRub = await getUsdRub();

  // One account failing (e.g. a DFA smart-account that has no standard portfolio)
  // must not drop the others.
  const perAccount = await Promise.all(
    accounts.map((acc) =>
      fetchAccountPortfolio(headers, acc, usdRub).catch((e) => {
        console.error(`[tinkoff] account ${acc.id} (${acc.name ?? "?"}) failed: ${stringifyErr(e)}`);
        return [] as PositionItem[];
      }),
    ),
  );
  return perAccount.flat();
}

/** Use explicit ids from env (comma-separated) if provided, else auto-discover. */
async function resolveAccounts(headers: Record<string, string>): Promise<Account[]> {
  const override = optionalEnv("TINKOFF_ACCOUNT_ID");
  if (override) {
    return override
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
      .map((id) => ({ id }));
  }

  const res = await fetchJson<AccountsResponse>(
    ACCOUNTS,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ status: "ACCOUNT_STATUS_UNSPECIFIED" }),
    },
    { caCert: TBANK_CA },
  );
  // Keep open accounts only; skip closed ones.
  return (res.accounts ?? []).filter(
    (a) => !a.status || a.status === "ACCOUNT_STATUS_OPEN",
  );
}

async function fetchAccountPortfolio(
  headers: Record<string, string>,
  account: Account,
  usdRub: number,
): Promise<PositionItem[]> {
  const portfolio = await fetchJson<PortfolioResponse>(
    PORTFOLIO,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ accountId: account.id }),
    },
    { caCert: TBANK_CA },
  );
  const positions = portfolio.positions ?? [];

  return Promise.all(
    positions.map((p) => mapPosition(headers, p, account, usdRub)),
  );
}

async function mapPosition(
  headers: Record<string, string>,
  p: PortfolioPosition,
  account: Account,
  usdRub: number,
): Promise<PositionItem> {
  const quantity = quotationToNumber(p.quantity);
  const unitPrice = quotationToNumber(p.currentPrice);
  const currency = (p.currentPrice?.currency ?? "rub").toUpperCase();
  const instrument = await lookupInstrument(headers, p.figi);

  const ticker = instrument?.ticker ?? p.figi;
  const name = instrument?.name ?? p.figi;
  const category = mapCategory(p.instrumentType, instrument?.instrumentKind);

  const accountLabel = account.name ?? account.id;
  const isin = instrument?.isin ? ` · ISIN ${instrument.isin}` : "";

  const item: PositionItem = {
    source: "tinkoff",
    ticker,
    name,
    quantity,
    price: 0,
    value: 0,
    currency,
    category,
    description: `Счёт: ${accountLabel}${isin}`,
  };

  if (currency === "RUB") {
    item.priceRub = unitPrice;
    item.valueRub = quantity * unitPrice;
    item.price = unitPrice / usdRub;
    item.value = item.valueRub / usdRub;
  } else {
    // USD or other: report native unit price as USD-equivalent best-effort.
    item.price = unitPrice;
    item.value = quantity * unitPrice;
  }
  return item;
}

async function lookupInstrument(
  headers: Record<string, string>,
  figi: string,
): Promise<Instrument | undefined> {
  try {
    const res = await fetchJson<InstrumentResponse>(
      INSTRUMENT,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ idType: "INSTRUMENT_ID_TYPE_FIGI", id: figi }),
      },
      { caCert: TBANK_CA },
    );
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
