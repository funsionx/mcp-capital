import type { Category, PositionItem } from "../lib/types.ts";
import { getUsdRub } from "../lib/usdRub.ts";
import { optionalEnv } from "../lib/env.ts";
import { stringifyErr } from "../lib/http.ts";

/**
 * Static / manually-tracked positions that can't be pulled from any API
 * (e.g. ЦФА Альфа, a VTB savings account / "кубышка", off-exchange holdings).
 *
 * Sources, merged by ticker (later overrides earlier):
 *   1. built-in DEFAULTS below
 *   2. positions.local.json at the project root (gitignored)
 *   3. MANUAL_POSITIONS env var (JSON array)
 *
 * Each entry: { ticker, name, valueRub? | value?(USD), category?, currency?, description? }
 */
interface ManualInput {
  ticker: string;
  name: string;
  category?: Category;
  currency?: string;
  /** Total value in RUB (converted to USD via the live CBR rate). */
  valueRub?: number;
  /** Total value in USD (used directly). */
  value?: number;
  quantity?: number;
  description?: string;
}

const DEFAULTS: ManualInput[] = [
  {
    ticker: "ALFA_CFA",
    name: "ЦФА Альфа",
    valueRub: 50_000,
    category: "cfa",
    currency: "RUB",
    description: "Цифровой финансовый актив Альфа (внебиржевая позиция, фиксированная стоимость)",
  },
];

export async function fetchPositions(): Promise<PositionItem[]> {
  const merged = mergeByTicker([DEFAULTS, await fromFile(), fromEnv()]);
  const usdRub = await getUsdRub();
  return merged.map((m) => toPosition(m, usdRub));
}

function toPosition(m: ManualInput, usdRub: number): PositionItem {
  const quantity = m.quantity ?? 1;
  const category = m.category ?? "mmf";
  const item: PositionItem = {
    source: "static",
    ticker: m.ticker,
    name: m.name,
    quantity,
    price: 0,
    value: 0,
    currency: m.currency ?? (m.valueRub != null ? "RUB" : "USD"),
    category,
    description: m.description,
  };
  if (m.valueRub != null) {
    item.valueRub = m.valueRub;
    item.priceRub = m.valueRub / quantity;
    item.value = m.valueRub / usdRub;
    item.price = item.value / quantity;
  } else {
    const value = m.value ?? 0;
    item.value = value;
    item.price = value / quantity;
  }
  return item;
}

/** Later arrays override earlier ones for the same ticker. */
function mergeByTicker(groups: ManualInput[][]): ManualInput[] {
  const map = new Map<string, ManualInput>();
  for (const group of groups) {
    for (const m of group) {
      if (m && typeof m.ticker === "string" && m.ticker) map.set(m.ticker, m);
    }
  }
  return [...map.values()];
}

async function fromFile(): Promise<ManualInput[]> {
  try {
    const file = Bun.file(new URL("../../positions.local.json", import.meta.url));
    if (!(await file.exists())) return [];
    const parsed = JSON.parse(await file.text());
    return Array.isArray(parsed) ? (parsed as ManualInput[]) : [];
  } catch (e) {
    console.error(`[static] positions.local.json ignored: ${stringifyErr(e)}`);
    return [];
  }
}

function fromEnv(): ManualInput[] {
  const raw = optionalEnv("MANUAL_POSITIONS");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ManualInput[]) : [];
  } catch (e) {
    console.error(`[static] MANUAL_POSITIONS ignored (invalid JSON): ${stringifyErr(e)}`);
    return [];
  }
}
