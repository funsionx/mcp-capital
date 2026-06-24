import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const DB_PATH = process.env.DB_PATH ?? "./data/portfolio.db";

let db: Database | undefined;

/**
 * Lazily open the SQLite database (one file, WAL mode) and ensure the schema.
 * Tiny single-user time-series — SQLite is the right tool; no external service.
 */
export function getDb(): Database {
  if (db) return db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS snapshots (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      ts              TEXT    NOT NULL,
      trigger         TEXT    NOT NULL,
      total_usd       REAL    NOT NULL,
      total_rub       REAL    NOT NULL,
      breakdown_json  TEXT    NOT NULL,
      allocation_json TEXT    NOT NULL,
      positions_json  TEXT    NOT NULL,
      partial         INTEGER NOT NULL DEFAULT 0,   -- 1 = ≥1 source still failed after retries
      failed_sources  TEXT                          -- CSV of sources missing from this snapshot
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON snapshots(ts);

    CREATE TABLE IF NOT EXISTS flows (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          TEXT    NOT NULL,
      direction   TEXT    NOT NULL,             -- 'deposit' | 'withdraw'
      amount_usd  REAL    NOT NULL,             -- always positive; sign comes from direction
      source      TEXT,                         -- which account it hit (optional)
      note        TEXT,
      auto        INTEGER NOT NULL DEFAULT 0,   -- 0 = manual, 1 = auto-detected
      status      TEXT    NOT NULL DEFAULT 'confirmed', -- 'confirmed' | 'pending' | 'rejected'
      ext_id      TEXT,                         -- stable external id (tx id:idx) for dedup
      tx_hash     TEXT                          -- on-chain hash, for CEX↔chain netting
    );
    CREATE INDEX IF NOT EXISTS idx_flows_ts ON flows(ts);

    CREATE TABLE IF NOT EXISTS oauth_tokens (
      token      TEXT PRIMARY KEY,
      type       TEXT NOT NULL,   -- 'access' | 'refresh'
      expires_at INTEGER          -- epoch ms; NULL = no expiry
    );

    CREATE TABLE IF NOT EXISTS manual_positions (
      ticker      TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      value_usd   REAL,                         -- one of value_usd / value_rub
      value_rub   REAL,
      category    TEXT,
      currency    TEXT,
      description TEXT,
      updated_at  TEXT NOT NULL
    );
  `);

  // Migrate older DBs that predate these columns (ALTER is a no-op if present).
  for (const stmt of [
    "ALTER TABLE flows ADD COLUMN status TEXT NOT NULL DEFAULT 'confirmed'",
    "ALTER TABLE flows ADD COLUMN ext_id TEXT",
    "ALTER TABLE flows ADD COLUMN tx_hash TEXT", // on-chain hash, for CEX↔chain netting
    "ALTER TABLE snapshots ADD COLUMN partial INTEGER NOT NULL DEFAULT 0", // degraded snapshot marker
    "ALTER TABLE snapshots ADD COLUMN failed_sources TEXT",
  ]) {
    try {
      db.exec(stmt);
    } catch {
      /* column already exists */
    }
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_flows_extid ON flows(ext_id) WHERE ext_id IS NOT NULL");

  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA cache_size = -8000"); // ~8 MB page cache cap

  try {
    chmodSync(DB_PATH, 0o600);
  } catch {
    /* best-effort on platforms that support it */
  }

  return db;
}
