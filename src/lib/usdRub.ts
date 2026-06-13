import { fetchText } from "./http.ts";

const CBR_URL = "https://www.cbr.ru/scripts/XML_daily.asp";
const USD_CODE = "R01235"; // CBR valute id for USD

let cached: number | undefined;

/**
 * Current USD/RUB rate from the Central Bank of Russia (free, keyless).
 * Cached for the process lifetime (one tool invocation).
 * Returns RUB per 1 USD.
 */
export async function getUsdRub(): Promise<number> {
  if (cached !== undefined) return cached;

  const xml = await fetchText(CBR_URL);
  // Find the <Valute ID="R01235"> ... <Nominal>1</Nominal><Value>78,1234</Value>
  const block = sliceValute(xml, USD_CODE);
  if (!block) throw new Error("CBR XML: USD valute block not found");

  const value = matchTag(block, "Value");
  const nominal = matchTag(block, "Nominal");
  if (!value) throw new Error("CBR XML: USD <Value> not found");

  const rate = parseFloat(value.replace(",", ".")) / (nominal ? parseInt(nominal, 10) : 1);
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`CBR XML: parsed invalid USD rate "${value}"`);
  }
  cached = rate;
  return rate;
}

function sliceValute(xml: string, id: string): string | undefined {
  const start = xml.indexOf(`ID="${id}"`);
  if (start === -1) return undefined;
  const end = xml.indexOf("</Valute>", start);
  return end === -1 ? xml.slice(start) : xml.slice(start, end);
}

function matchTag(block: string, tag: string): string | undefined {
  const m = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m?.[1];
}
