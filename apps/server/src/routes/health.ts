// Health endpoints (AGENTS.md §19). /health/live is a cheap liveness probe.
// /health/ready checks SQLite read/write, migrations, temp dir, master key.
// It must not call Google.

import type { Database } from "bun:sqlite";
import { existsSync, accessSync, constants } from "node:fs";
import type { AppConfig } from "../config.ts";
import { appliedMigrationVersion, latestMigrationVersion } from "../db/migrate.ts";

export function handleLive(): Response {
  return Response.json({ status: "ok" });
}

export function handleReady(db: Database, config: AppConfig): Response {
  const checks: Record<string, boolean> = {
    sqlite: false,
    migrations: false,
    tempDir: false,
    masterKey: false,
  };

  try {
    db.query("SELECT 1").get();
    checks.sqlite = true;
  } catch {
    checks.sqlite = false;
  }

  try {
    checks.migrations = appliedMigrationVersion(db) >= latestMigrationVersion();
  } catch {
    checks.migrations = false;
  }

  try {
    if (existsSync(config.multipartTempDir)) {
      accessSync(config.multipartTempDir, constants.W_OK);
      checks.tempDir = true;
    }
  } catch {
    checks.tempDir = false;
  }

  checks.masterKey = config.masterEncryptionKey.length === 32;

  const ready = Object.values(checks).every(Boolean);
  return Response.json(
    { status: ready ? "ok" : "degraded", checks },
    { status: ready ? 200 : 503 },
  );
}
