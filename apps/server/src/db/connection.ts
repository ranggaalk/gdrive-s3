// SQLite connection with the startup pragmas required by AGENTS.md §9.
// Single-writer, local file only. WAL mode.

import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export type DB = Database;

export function openDatabase(path: string): DB {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = NORMAL;");
  return db;
}

/** Open an in-memory DB for tests (foreign keys + busy timeout still applied). */
export function openMemoryDatabase(): DB {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}
