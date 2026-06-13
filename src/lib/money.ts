/** Tinkoff Quotation / MoneyValue: { units, nano } -> number. */
export interface Quotation {
  units?: string | number;
  nano?: number;
  currency?: string;
}

export function quotationToNumber(q: Quotation | null | undefined): number {
  if (!q) return 0;
  const units = typeof q.units === "string" ? parseFloat(q.units) : q.units ?? 0;
  const nano = q.nano ?? 0;
  return units + nano / 1e9;
}
