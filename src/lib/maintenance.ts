import { getDb } from "./db.ts";

/** Remove expired OAuth access/refresh tokens from SQLite. */
export function purgeExpiredOAuthTokens(): number {
  const result = getDb()
    .query("DELETE FROM oauth_tokens WHERE expires_at IS NOT NULL AND expires_at < $now")
    .run({ $now: Date.now() });
  return result.changes ?? 0;
}

/** Flush WAL pages to the main DB file (reduces WAL growth on long-lived cron). */
export function checkpointWal(mode: "PASSIVE" | "TRUNCATE" = "PASSIVE"): void {
  getDb().exec(`PRAGMA wal_checkpoint(${mode})`);
}

/** Periodic DB housekeeping — safe to call from cron and HTTP app. */
export function runDbMaintenance(opts?: { truncateWal?: boolean }): void {
  const removed = purgeExpiredOAuthTokens();
  checkpointWal(opts?.truncateWal ? "TRUNCATE" : "PASSIVE");
  if (removed > 0) console.error(`[maintenance] purged ${removed} expired oauth token(s)`);
}
