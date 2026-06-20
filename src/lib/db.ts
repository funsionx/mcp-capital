import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
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
      positions_json  TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON snapshots(ts);

    CREATE TABLE IF NOT EXISTS flows (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          TEXT    NOT NULL,
      direction   TEXT    NOT NULL,           -- 'deposit' | 'withdraw'
      amount_usd  REAL    NOT NULL,           -- always positive; sign comes from direction
      source      TEXT,                       -- which account it hit (optional)
      note        TEXT,
      auto        INTEGER NOT NULL DEFAULT 0  -- 0 = manual, 1 = auto-detected
    );
    CREATE INDEX IF NOT EXISTS idx_flows_ts ON flows(ts);
  `);
  return db;
}
