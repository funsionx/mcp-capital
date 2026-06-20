import { getDb } from "../lib/db.ts";
import { buildPortfolio } from "./build.ts";

export type Trigger = "month_start" | "month_end" | "daily" | "manual" | "on_chat";
export type FlowDirection = "deposit" | "withdraw";

export interface SnapshotRow {
  id: number;
  ts: string;
  trigger: string;
  total_usd: number;
  total_rub: number;
}
export type FlowStatus = "confirmed" | "pending" | "rejected";
export interface FlowRow {
  id: number;
  ts: string;
  direction: FlowDirection;
  amount_usd: number;
  source: string | null;
  note: string | null;
  auto: number;
  status: FlowStatus;
  ext_id: string | null;
}

const DEDUP_MS = 60 * 60 * 1000; // on_chat: at most one snapshot per hour

export interface WriteResult {
  saved: boolean;
  reason?: string;
  id?: number;
  ts: string;
  totalUsd?: number;
  totalRub?: number;
}

/** Build the current portfolio and persist it as a snapshot (with on_chat dedup). */
export async function writeSnapshot(trigger: Trigger): Promise<WriteResult> {
  const db = getDb();

  if (trigger === "on_chat") {
    const last = db.query("SELECT ts FROM snapshots ORDER BY ts DESC LIMIT 1").get() as { ts: string } | null;
    if (last && Date.now() - Date.parse(last.ts) < DEDUP_MS) {
      return { saved: false, reason: "deduplicated (a snapshot was taken < 1h ago)", ts: last.ts };
    }
  }

  const pf = await buildPortfolio();
  const row = db
    .query(
      `INSERT INTO snapshots (ts, trigger, total_usd, total_rub, breakdown_json, allocation_json, positions_json)
       VALUES ($ts, $trigger, $usd, $rub, $bd, $al, $pos) RETURNING id`,
    )
    .get({
      $ts: pf.timestamp,
      $trigger: trigger,
      $usd: pf.totalValueUsd,
      $rub: pf.totalValueRub,
      $bd: JSON.stringify(pf.sourceBreakdown),
      $al: JSON.stringify(pf.allocation),
      $pos: JSON.stringify(pf.positions),
    }) as { id: number };

  return { saved: true, id: row.id, ts: pf.timestamp, totalUsd: pf.totalValueUsd, totalRub: pf.totalValueRub };
}

/** Most recent snapshot at or before `ts` (ISO). */
export function snapshotAtOrBefore(ts: string): SnapshotRow | null {
  return getDb()
    .query("SELECT id, ts, trigger, total_usd, total_rub FROM snapshots WHERE ts <= $ts ORDER BY ts DESC LIMIT 1")
    .get({ $ts: ts }) as SnapshotRow | null;
}

/** First snapshot at or after `ts` (ISO) — the start anchor for a period. */
export function snapshotAtOrAfter(ts: string): SnapshotRow | null {
  return getDb()
    .query("SELECT id, ts, trigger, total_usd, total_rub FROM snapshots WHERE ts >= $ts ORDER BY ts ASC LIMIT 1")
    .get({ $ts: ts }) as SnapshotRow | null;
}

export function latestSnapshot(): SnapshotRow | null {
  return getDb()
    .query("SELECT id, ts, trigger, total_usd, total_rub FROM snapshots ORDER BY ts DESC LIMIT 1")
    .get() as SnapshotRow | null;
}

export function recordFlow(f: {
  direction: FlowDirection;
  amountUsd: number;
  source?: string;
  note?: string;
  ts?: string;
  auto?: boolean;
}): number {
  const row = getDb()
    .query(
      `INSERT INTO flows (ts, direction, amount_usd, source, note, auto)
       VALUES ($ts, $dir, $amt, $src, $note, $auto) RETURNING id`,
    )
    .get({
      $ts: f.ts ?? new Date().toISOString(),
      $dir: f.direction,
      $amt: Math.abs(f.amountUsd),
      $src: f.source ?? null,
      $note: f.note ?? null,
      $auto: f.auto ? 1 : 0,
    }) as { id: number };
  return row.id;
}

/** Confirmed flows strictly after `fromTs` and at/before `toTs` (pending excluded). */
export function flowsBetween(fromTs: string, toTs: string): FlowRow[] {
  return getDb()
    .query("SELECT * FROM flows WHERE status = 'confirmed' AND ts > $from AND ts <= $to ORDER BY ts ASC")
    .all({ $from: fromTs, $to: toTs }) as FlowRow[];
}

/** Insert an auto-detected flow as 'pending'; ignored if its ext_id already exists. */
export function insertAutoFlow(f: {
  ts: string;
  direction: FlowDirection;
  amountUsd: number;
  source?: string;
  note?: string;
  extId: string;
}): boolean {
  const r = getDb()
    .query(
      `INSERT OR IGNORE INTO flows (ts, direction, amount_usd, source, note, auto, status, ext_id)
       VALUES ($ts, $dir, $amt, $src, $note, 1, 'pending', $ext)`,
    )
    .run({
      $ts: f.ts,
      $dir: f.direction,
      $amt: Math.abs(f.amountUsd),
      $src: f.source ?? null,
      $note: f.note ?? null,
      $ext: f.extId,
    });
  return r.changes > 0;
}

export function listFlows(status?: FlowStatus, limit = 50): FlowRow[] {
  const db = getDb();
  return status
    ? (db.query("SELECT * FROM flows WHERE status = $s ORDER BY ts DESC LIMIT $l").all({ $s: status, $l: limit }) as FlowRow[])
    : (db.query("SELECT * FROM flows ORDER BY ts DESC LIMIT $l").all({ $l: limit }) as FlowRow[]);
}

export function setFlowStatus(id: number, status: FlowStatus): number {
  return getDb().query("UPDATE flows SET status = $s WHERE id = $id").run({ $s: status, $id: id }).changes;
}

export function confirmAllPending(): number {
  return getDb().query("UPDATE flows SET status = 'confirmed' WHERE status = 'pending'").run().changes;
}

// ── Manual positions (deposits, ЦФА, кубышка) stored in the DB ──────────────
export interface ManualPositionRow {
  ticker: string;
  name: string;
  value_usd: number | null;
  value_rub: number | null;
  category: string | null;
  currency: string | null;
  description: string | null;
  updated_at: string;
}

export function listManualPositions(): ManualPositionRow[] {
  return getDb().query("SELECT * FROM manual_positions ORDER BY ticker").all() as ManualPositionRow[];
}

export function countManualPositions(): number {
  return (getDb().query("SELECT COUNT(*) AS n FROM manual_positions").get() as { n: number }).n;
}

export function upsertManualPosition(p: {
  ticker: string;
  name: string;
  valueUsd?: number;
  valueRub?: number;
  category?: string;
  currency?: string;
  description?: string;
}): void {
  getDb()
    .query(
      `INSERT INTO manual_positions (ticker, name, value_usd, value_rub, category, currency, description, updated_at)
       VALUES ($t, $n, $vu, $vr, $cat, $cur, $d, $u)
       ON CONFLICT(ticker) DO UPDATE SET
         name=$n, value_usd=$vu, value_rub=$vr, category=$cat, currency=$cur, description=$d, updated_at=$u`,
    )
    .run({
      $t: p.ticker,
      $n: p.name,
      $vu: p.valueUsd ?? null,
      $vr: p.valueRub ?? null,
      $cat: p.category ?? null,
      $cur: p.currency ?? null,
      $d: p.description ?? null,
      $u: new Date().toISOString(),
    });
}

export function removeManualPosition(ticker: string): number {
  return getDb().query("DELETE FROM manual_positions WHERE ticker = $t").run({ $t: ticker }).changes;
}
