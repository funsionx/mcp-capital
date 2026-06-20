import type { SnapshotRow, FlowRow } from "./store.ts";
import { round } from "./build.ts";

export interface ReturnResult {
  from: { ts: string; valueUsd: number };
  to: { ts: string; valueUsd: number };
  netFlowUsd: number; // deposits − withdrawals within the window
  gainUsd: number; // V_end − V_start − netFlow (true investment gain)
  returnPct: number; // Modified Dietz (flow-time-weighted)
  flowCount: number;
  method: "modified-dietz";
}

/**
 * Modified Dietz return: the industry-standard single-formula way to measure
 * return when there are deposits/withdrawals mid-period, without needing a
 * snapshot at every flow. Deposits/withdrawals are excluded from "gain" and
 * time-weighted in the denominator.
 */
export function computeReturn(start: SnapshotRow, end: SnapshotRow, flows: FlowRow[]): ReturnResult {
  const v0 = start.total_usd;
  const v1 = end.total_usd;
  const t0 = Date.parse(start.ts);
  const t1 = Date.parse(end.ts);
  const dur = Math.max(t1 - t0, 1);

  let netFlow = 0;
  let weighted = 0;
  for (const f of flows) {
    const signed = f.direction === "deposit" ? f.amount_usd : -f.amount_usd;
    netFlow += signed;
    weighted += signed * ((t1 - Date.parse(f.ts)) / dur);
  }

  const gain = v1 - v0 - netFlow;
  const denom = v0 + weighted;
  const returnPct = denom !== 0 ? (gain / denom) * 100 : 0;

  return {
    from: { ts: start.ts, valueUsd: round(v0) },
    to: { ts: end.ts, valueUsd: round(v1) },
    netFlowUsd: round(netFlow),
    gainUsd: round(gain),
    returnPct: Math.round(returnPct * 100) / 100,
    flowCount: flows.length,
    method: "modified-dietz",
  };
}

export type Period = "today" | "7d" | "30d" | "mtd" | "ytd" | "all";

/** Resolve a period preset to a start ISO timestamp (UTC boundaries). */
export function periodStart(period: Period, now = new Date()): string {
  const d = new Date(now);
  switch (period) {
    case "today":
      d.setUTCHours(0, 0, 0, 0);
      break;
    case "7d":
      d.setUTCDate(d.getUTCDate() - 7);
      break;
    case "30d":
      d.setUTCDate(d.getUTCDate() - 30);
      break;
    case "mtd":
      d.setUTCDate(1);
      d.setUTCHours(0, 0, 0, 0);
      break;
    case "ytd":
      d.setUTCMonth(0, 1);
      d.setUTCHours(0, 0, 0, 0);
      break;
    case "all":
      return new Date(0).toISOString();
  }
  return d.toISOString();
}
