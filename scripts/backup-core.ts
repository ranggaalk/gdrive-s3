// Encrypted SQLite backup / restore core (AGENTS.md §27, M7). Backup creates a
// consistent snapshot via SQLite VACUUM INTO, gzip-compresses it, then wraps
// the binary as base64 inside the project's AES-256-GCM envelope. Restore
// writes atomically, integrity-checks, and applies pending migrations.

import { Database } from "bun:sqlite";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { openFromString, sealToString } from "../apps/server/src/security/encryption.ts";
import {
  appliedMigrationVersion,
  latestMigrationVersion,
  runMigrations,
} from "../apps/server/src/db/migrate.ts";

const BACKUP_AAD = "drives3-sqlite-backup:v1";

export interface BackupManifest {
  version: 1;
  createdAt: string;
  source: string;
  encryptedFile: string;
  sha256: string;
  bytes: number;
  migrationVersion: number;
  integrity: "ok";
}

export interface BackupResult {
  encryptedPath: string;
  manifestPath: string;
  manifest: BackupManifest;
}

export function encryptionKeyFromBase64(value: string | undefined): Buffer {
  if (!value) throw new Error("MASTER_ENCRYPTION_KEY is required");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error("MASTER_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return key;
}

export function createEncryptedBackup(input: {
  sourcePath: string;
  outputDir: string;
  key: Buffer;
  now?: Date;
}): BackupResult {
  if (!existsSync(input.sourcePath)) throw new Error(`SQLite source not found: ${input.sourcePath}`);
  mkdirSync(input.outputDir, { recursive: true });
  const db = new Database(input.sourcePath, { readwrite: true, create: false });
  const createdAt = (input.now ?? new Date()).toISOString();
  const stamp = createdAt.replace(/[:.]/g, "-");
  const snapshot = join(input.outputDir, `.snapshot-${process.pid}-${crypto.randomUUID()}.sqlite`);
  try {
    assertIntegrity(db);
    // VACUUM INTO is SQLite's consistent copy primitive. It works while
    // readers are active, but operators should schedule low-traffic windows.
    db.exec(`VACUUM INTO '${escapeSql(snapshot)}'`);
  } finally {
    db.close();
  }

  try {
    const raw = readFileSync(snapshot);
    const compressed = gzipSync(raw, { level: 9 });
    const encrypted = sealToString(compressed.toString("base64"), input.key, BACKUP_AAD);
    const encryptedPath = join(input.outputDir, `drives3-${stamp}.sqlite.gz.enc`);
    writeFileSync(encryptedPath, encrypted, { mode: 0o600, flag: "wx" });
    const snapDb = new Database(snapshot, { readonly: true, create: false });
    const migrationVersion = appliedMigrationVersion(snapDb);
    snapDb.close();
    const manifest: BackupManifest = {
      version: 1,
      createdAt,
      source: basename(input.sourcePath),
      encryptedFile: basename(encryptedPath),
      sha256: createHash("sha256").update(encrypted).digest("hex"),
      bytes: Buffer.byteLength(encrypted),
      migrationVersion,
      integrity: "ok",
    };
    const manifestPath = `${encryptedPath}.manifest.json`;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    return { encryptedPath, manifestPath, manifest };
  } finally {
    rmSync(snapshot, { force: true });
  }
}

export function restoreEncryptedBackup(input: {
  encryptedPath: string;
  targetPath: string;
  key: Buffer;
  force?: boolean;
}): { targetPath: string; migrationVersion: number; integrity: "ok" } {
  if (existsSync(input.targetPath) && !input.force) {
    throw new Error(`Restore target exists (pass --force to replace): ${input.targetPath}`);
  }
  const encrypted = readFileSync(input.encryptedPath, "utf8");
  verifyManifestIfPresent(input.encryptedPath, encrypted);
  const compressedB64 = openFromString(encrypted, input.key, BACKUP_AAD);
  const raw = gunzipSync(Buffer.from(compressedB64, "base64"));
  mkdirSync(dirname(input.targetPath), { recursive: true });
  const temp = `${input.targetPath}.${process.pid}.${crypto.randomUUID()}.restore`;
  writeFileSync(temp, raw, { mode: 0o600, flag: "wx" });

  const db = new Database(temp, { readwrite: true, create: false });
  try {
    assertIntegrity(db);
    runMigrations(db);
    assertIntegrity(db);
  } catch (error) {
    db.close();
    rmSync(temp, { force: true });
    throw error;
  }
  const migrationVersion = appliedMigrationVersion(db);
  if (migrationVersion !== latestMigrationVersion()) {
    db.close();
    rmSync(temp, { force: true });
    throw new Error(`restored DB migration mismatch: ${migrationVersion}`);
  }
  db.close();
  if (input.force) rmSync(input.targetPath, { force: true });
  renameSync(temp, input.targetPath);
  return { targetPath: input.targetPath, migrationVersion, integrity: "ok" };
}

function assertIntegrity(db: Database): void {
  const result = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").get();
  if (result?.integrity_check !== "ok") {
    throw new Error(`SQLite integrity_check failed: ${result?.integrity_check ?? "no result"}`);
  }
}

function verifyManifestIfPresent(encryptedPath: string, encrypted: string): void {
  const path = `${encryptedPath}.manifest.json`;
  if (!existsSync(path)) return;
  const manifest = JSON.parse(readFileSync(path, "utf8")) as BackupManifest;
  const sha = createHash("sha256").update(encrypted).digest("hex");
  if (manifest.sha256 !== sha) throw new Error("backup manifest SHA-256 mismatch");
}

function escapeSql(value: string): string {
  return value.replaceAll("'", "''");
}
