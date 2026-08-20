// Sequential, immutable migration runner (AGENTS.md §9).
// Migrations live as .sql files in ./migrations, named NNNN_description.sql.
// Each runs once, inside a transaction, recorded in schema_migrations.

import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { openDatabase } from "./connection.ts";

// Source runs resolve `./migrations` next to this file. A bundled production
// server resolves next to `dist/server/index.js`, where Docker copies the SQL
// directory. MIGRATIONS_DIR can override both for custom packaging.
const MIGRATIONS_DIR =
  process.env.MIGRATIONS_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "migrations");

interface MigrationFile {
  version: number;
  name: string;
  path: string;
  sql: string;
}

function loadMigrations(): MigrationFile[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const migrations: MigrationFile[] = [];
  for (const file of files) {
    const match = /^(\d{4})_(.+)\.sql$/.exec(file);
    if (!match) {
      throw new Error(`Invalid migration filename: ${file} (expected NNNN_name.sql)`);
    }
    const version = Number(match[1]);
    const path = join(MIGRATIONS_DIR, file);
    migrations.push({
      version,
      name: match[2]!,
      path,
      sql: readFileSync(path, "utf8"),
    });
  }
  // Ensure versions are strictly increasing and gap-free from 1.
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(`Migration version gap or disorder at ${m.path} (expected ${i + 1})`);
    }
  });
  return migrations;
}

export interface MigrateResult {
  applied: number[];
  currentVersion: number;
}

export function runMigrations(db: Database): MigrateResult {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const appliedRows = db
    .query<{ version: number }, []>("SELECT version FROM schema_migrations ORDER BY version")
    .all();
  const appliedVersions = new Set(appliedRows.map((r) => r.version));

  const migrations = loadMigrations();
  const applied: number[] = [];

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) continue;

    const tx = db.transaction(() => {
      db.exec(migration.sql);
      db.query("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
    });
    tx();
    applied.push(migration.version);
  }

  const currentVersion = migrations.length > 0 ? migrations[migrations.length - 1]!.version : 0;
  return { applied, currentVersion };
}

/** Latest migration version declared on disk (for readiness checks). */
export function latestMigrationVersion(): number {
  const migrations = loadMigrations();
  return migrations.length > 0 ? migrations[migrations.length - 1]!.version : 0;
}

export function appliedMigrationVersion(db: Database): number {
  const row = db
    .query<{ v: number | null }, []>("SELECT MAX(version) AS v FROM schema_migrations")
    .get();
  return row?.v ?? 0;
}

// CLI entrypoint: `bun apps/server/src/db/migrate.ts`
if (import.meta.main) {
  const path = process.env.SQLITE_PATH ?? "./data/app.sqlite";
  const db = openDatabase(path);
  const result = runMigrations(db);
  db.close();
  process.stdout.write(
    JSON.stringify({ msg: "migrations complete", db: path, ...result }) + "\n",
  );
}
