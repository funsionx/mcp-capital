import { getDb } from "../lib/db.ts";
import { buildPortfolio, type Portfolio } from "./build.ts";

export type Trigger = "month_start" | "month_end" | "daily" | "manual" | "on_chat";
export type FlowDirection = "deposit" | "withdraw";

export interface SnapshotRow {
  id: number;
  ts: string;
  trigger: string;
  total_usd: number;
  total_rub: number;
  /** 1 when ≥1 source still failed after retries; such rows are skipped as return/PnL anchors. */
  partial?: number;
  failed_sources?: string | null;
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
  /** True when the persisted snapshot is missing one or more sources (see failedSources). */
  partial?: boolean;
  failedSources?: string[];
}

/** Insert one assembled portfolio as a snapshot row. The single INSERT both writers share. */
function persistSnapshot(pf: Portfolio, trigger: Trigger, partial: boolean, failedSources: string | null): number {
  const row = getDb()
    .query(
      `INSERT INTO snapshots (ts, trigger, total_usd, total_rub, breakdown_json, allocation_json, positions_json, partial, failed_sources)
       VALUES ($ts, $trigger, $usd, $rub, $bd, $al, $pos, $partial, $failed) RETURNING id`,
    )
    .get({
      $ts: pf.timestamp,
      $trigger: trigger,
      $usd: pf.totalValueUsd,
      $rub: pf.totalValueRub,
      $bd: JSON.stringify(pf.sourceBreakdown),
      $al: JSON.stringify(pf.allocation),
      $pos: JSON.stringify(pf.positions),
      $partial: partial ? 1 : 0,
      $failed: failedSources,
    }) as { id: number };
  return row.id;
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
  const id = persistSnapshot(pf, trigger, false, null);
  return { saved: true, id, ts: pf.timestamp, totalUsd: pf.totalValueUsd, totalRub: pf.totalValueRub };
}

const DEFAULT_SNAPSHOT_RETRIES = 2;
const DEFAULT_SNAPSHOT_RETRY_MS = 5 * 60 * 1000; // 5 minutes between attempts

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Cron-grade snapshot writer: if any source fails, rebuild up to `retries` more times
 * (default 2, 5 min apart), keeping the most complete portfolio seen. Any source still
 * failing after the last attempt is recorded in `failed_sources` and the row is flagged
 * `partial=1` so return/PnL anchors skip it (a degraded total never poisons performance).
 *
 * A full rebuild per attempt (not just the failed source) keeps each snapshot internally
 * consistent — all values come from the same point in time, never Frankenstein-merged.
 */
export async function writeSnapshotResilient(
  trigger: Trigger,
  opts?: { retries?: number; retryDelayMs?: number },
): Promise<WriteResult> {
  const retries = opts?.retries ?? DEFAULT_SNAPSHOT_RETRIES;
  const delayMs = opts?.retryDelayMs ?? DEFAULT_SNAPSHOT_RETRY_MS;

  let best = await buildPortfolio();
  for (let attempt = 1; attempt <= retries && best.errors.length > 0; attempt++) {
    console.error(
      `[snapshot] ${trigger}: ${best.errors.length} source(s) failed (${best.errors
        .map((e) => e.source)
        .join(", ")}); retry ${attempt}/${retries} in ${Math.round(delayMs / 1000)}s`,
    );
    await sleep(delayMs);
    const next = await buildPortfolio();
    if (next.errors.length < best.errors.length) best = next; // keep the most complete result
  }

  const failed = [...new Set(best.errors.map((e) => e.source))];
  const partial = failed.length > 0;
  const id = persistSnapshot(best, trigger, partial, partial ? failed.join(",") : null);
  if (partial) console.error(`[snapshot] ${trigger}: persisted PARTIAL snapshot, missing: ${failed.join(", ")}`);
  return { saved: true, id, ts: best.timestamp, totalUsd: best.totalValueUsd, totalRub: best.totalValueRub, partial, failedSources: failed };
}

/** Most recent complete snapshot at or before `ts` (ISO). Partial snapshots are skipped. */
export function snapshotAtOrBefore(ts: string): SnapshotRow | null {
  return getDb()
    .query("SELECT id, ts, trigger, total_usd, total_rub FROM snapshots WHERE ts <= $ts AND partial = 0 ORDER BY ts DESC LIMIT 1")
    .get({ $ts: ts }) as SnapshotRow | null;
}

/** First complete snapshot at or after `ts` (ISO) — the start anchor for a period. */
export function snapshotAtOrAfter(ts: string): SnapshotRow | null {
  return getDb()
    .query("SELECT id, ts, trigger, total_usd, total_rub FROM snapshots WHERE ts >= $ts AND partial = 0 ORDER BY ts ASC LIMIT 1")
    .get({ $ts: ts }) as SnapshotRow | null;
}

export function latestSnapshot(): SnapshotRow | null {
  return getDb()
    .query("SELECT id, ts, trigger, total_usd, total_rub FROM snapshots WHERE partial = 0 ORDER BY ts DESC LIMIT 1")
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
  txHash?: string;
}): boolean {
  const r = getDb()
    .query(
      `INSERT OR IGNORE INTO flows (ts, direction, amount_usd, source, note, auto, status, ext_id, tx_hash)
       VALUES ($ts, $dir, $amt, $src, $note, 1, 'pending', $ext, $hash)`,
    )
    .run({
      $ts: f.ts,
      $dir: f.direction,
      $amt: Math.abs(f.amountUsd),
      $src: f.source ?? null,
      $note: f.note ?? null,
      $ext: f.extId,
      $hash: f.txHash ?? null,
    });
  return r.changes > 0;
}

/**
 * Reject pending flows whose on-chain hash matches one of `hashes` — the EVM leg of
 * a CEX↔chain transfer the exchange already accounts for (e.g. a Bybit→EVM_1
 * withdrawal seen on both sides). Nets both legs to zero.
 */
export function rejectInternalByHash(hashes: string[]): number {
  if (hashes.length === 0) return 0;
  const set = new Set(hashes.map((h) => h.toLowerCase()));
  const db = getDb();
  const pending = db
    .query("SELECT id, tx_hash FROM flows WHERE status = 'pending' AND tx_hash IS NOT NULL")
    .all() as { id: number; tx_hash: string }[];
  let n = 0;
  for (const f of pending) {
    if (!set.has(f.tx_hash.toLowerCase())) continue;
    db.query("UPDATE flows SET status = 'rejected', note = note || ' [auto: internal CEX↔chain]' WHERE id = $id").run({
      $id: f.id,
    });
    n++;
  }
  return n;
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
