// Encrypted SQLite backup / restore core (AGENTS.md §27, M7). Backup creates a
// consistent snapshot via SQLite VACUUM INTO, gzip-compresses it, then wraps
// the binary as base64 inside the project's AES-256-GCM envelope. Restore
// writes atomically, integrity-checks, and applies pending migrations.
//
// Key recovery: the archive can also carry MASTER_ENCRYPTION_KEY itself,
// encrypted under a key derived (scrypt) from an operator passphrase. A
// redeploy that has lost the key -- and with it every sealed secret and every
// backup -- can then restore from an archive and the passphrase alone, and get
// the key back to put in the new environment.

import { Database } from "bun:sqlite";
import { gzipSync, gunzipSync } from "node:zlib";
import { createHash, randomBytes, scryptSync } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  aad,
  decrypt,
  encrypt,
  openFromString,
  type Envelope,
} from "../apps/server/src/security/encryption.ts";
import {
  appliedMigrationVersion,
  latestMigrationVersion,
  runMigrations,
} from "../apps/server/src/db/migrate.ts";

const BACKUP_AAD = "drives3-sqlite-backup:v1";
// Binds the wrapped master key to its role, so the recovery blob can never be
// opened as -- or swapped for -- any other envelope.
const KEY_RECOVERY_AAD = "drives3-backup-key-recovery:v2";
const ARCHIVE_FORMAT = "drives3-sqlite-backup";

export const MIN_RECOVERY_PASSPHRASE_LENGTH = 12;

// OWASP's recommended scrypt cost: ~128 MiB and a fraction of a second per
// attempt. That cost is the only thing standing between a stolen archive and
// a guessed passphrase, so it is deliberately not cheap.
const SCRYPT_COST = { N: 2 ** 17, r: 8, p: 1 } as const;

interface ScryptCost {
  N: number;
  r: number;
  p: number;
}

interface KeyRecovery extends ScryptCost {
  kdf: "scrypt";
  salt: string; // base64
  wrappedKey: Envelope;
}

/**
 * v2 archive. A v1 archive is the bare payload envelope; v2 wraps it so the
 * file can also carry `keyRecovery`, which is null when no passphrase was set.
 */
interface ArchiveV2 {
  format: typeof ARCHIVE_FORMAT;
  version: 2;
  keyRecovery: KeyRecovery | null;
  payload: Envelope;
}

export interface BackupManifest {
  version: 2;
  createdAt: string;
  source: string;
  encryptedFile: string;
  sha256: string;
  bytes: number;
  migrationVersion: number;
  integrity: "ok";
  /** Whether the archive can give back MASTER_ENCRYPTION_KEY for a passphrase. */
  keyRecovery: "passphrase" | "none";
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
  /** Wraps the master key into the archive so the passphrase alone can restore it. */
  recoveryPassphrase?: string;
  now?: Date;
}): BackupResult {
  if (!existsSync(input.sourcePath)) throw new Error(`SQLite source not found: ${input.sourcePath}`);
  if (input.recoveryPassphrase !== undefined) assertPassphraseStrength(input.recoveryPassphrase);
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
    const snapDb = new Database(snapshot, { readonly: true, create: false });
    let migrationVersion: number;
    try {
      assertKeyOpensSecrets(snapDb, input.key);
      migrationVersion = appliedMigrationVersion(snapDb);
    } finally {
      snapDb.close();
    }
    const raw = readFileSync(snapshot);
    const compressed = gzipSync(raw, { level: 9 });
    const archive: ArchiveV2 = {
      format: ARCHIVE_FORMAT,
      version: 2,
      keyRecovery:
        input.recoveryPassphrase === undefined
          ? null
          : wrapMasterKey(input.key, input.recoveryPassphrase),
      payload: encrypt(compressed.toString("base64"), input.key, BACKUP_AAD),
    };
    const encrypted = JSON.stringify(archive);
    const encryptedPath = join(input.outputDir, `drives3-${stamp}.sqlite.gz.enc`);
    writeFileSync(encryptedPath, encrypted, { mode: 0o600, flag: "wx" });
    const manifest: BackupManifest = {
      version: 2,
      createdAt,
      source: basename(input.sourcePath),
      encryptedFile: basename(encryptedPath),
      sha256: createHash("sha256").update(encrypted).digest("hex"),
      bytes: Buffer.byteLength(encrypted),
      migrationVersion,
      integrity: "ok",
      keyRecovery: archive.keyRecovery ? "passphrase" : "none",
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

export interface RestoreResult {
  targetPath: string;
  migrationVersion: number;
  integrity: "ok";
  /** The master key unwrapped from the archive -- set only for a passphrase restore. */
  recoveredKey?: Buffer;
}

/**
 * Restore with either the master key or, for an archive that carries key
 * recovery, the passphrase in its place. A passphrase wins when both are given.
 */
export function restoreEncryptedBackup(input: {
  encryptedPath: string;
  targetPath: string;
  key?: Buffer;
  passphrase?: string;
  force?: boolean;
}): RestoreResult {
  if (existsSync(input.targetPath) && !input.force) {
    throw new Error(`Restore target exists (pass --force to replace): ${input.targetPath}`);
  }
  const encrypted = readFileSync(input.encryptedPath, "utf8");
  verifyManifestIfPresent(input.encryptedPath, encrypted);
  const archive = parseArchive(encrypted);

  let key: Buffer;
  let recoveredKey: Buffer | undefined;
  if (input.passphrase !== undefined) {
    if (!archive.keyRecovery) {
      throw new Error("this backup carries no key recovery; restore it with MASTER_ENCRYPTION_KEY");
    }
    key = recoveredKey = unwrapMasterKey(archive.keyRecovery, input.passphrase);
  } else if (input.key) {
    key = input.key;
  } else {
    throw new Error("restore needs MASTER_ENCRYPTION_KEY or the recovery passphrase");
  }

  let compressedB64: string;
  try {
    compressedB64 = decrypt(archive.payload, key, BACKUP_AAD);
  } catch {
    throw new Error(
      archive.keyRecovery && !recoveredKey
        ? "MASTER_ENCRYPTION_KEY does not open this backup -- likely a new key on a new host. " +
            "The archive carries key recovery: rerun with --passphrase"
        : "the key does not open this backup (or the archive was altered)",
    );
  }
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
  return { targetPath: input.targetPath, migrationVersion, integrity: "ok", recoveredKey };
}

/** Whether the archive can be restored with a passphrase instead of the key. */
export function backupHasKeyRecovery(encryptedPath: string): boolean {
  return parseArchive(readFileSync(encryptedPath, "utf8")).keyRecovery !== null;
}

function parseArchive(encrypted: string): { payload: Envelope; keyRecovery: KeyRecovery | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(encrypted);
  } catch {
    throw new Error("backup archive is not valid JSON");
  }
  if (typeof parsed === "object" && parsed !== null && "format" in parsed) {
    const archive = parsed as Partial<ArchiveV2>;
    if (archive.format !== ARCHIVE_FORMAT || archive.version !== 2 || !archive.payload) {
      throw new Error(`unsupported backup archive: ${String(archive.format)} v${String(archive.version)}`);
    }
    return { payload: archive.payload, keyRecovery: archive.keyRecovery ?? null };
  }
  // v1: the whole file is the payload envelope, and there is no key recovery.
  return { payload: parsed as Envelope, keyRecovery: null };
}

function assertPassphraseStrength(passphrase: string): void {
  if ([...normalizePassphrase(passphrase)].length < MIN_RECOVERY_PASSPHRASE_LENGTH) {
    throw new Error(
      `the recovery passphrase must be at least ${MIN_RECOVERY_PASSPHRASE_LENGTH} characters -- ` +
        "anyone holding an archive can try to guess it offline",
    );
  }
}

// NFKC so a passphrase typed on another machine -- a different keyboard
// layout or input method composing the same characters differently -- still
// derives the same key.
function normalizePassphrase(passphrase: string): string {
  return passphrase.normalize("NFKC");
}

function deriveRecoveryKey(passphrase: string, salt: Buffer, cost: ScryptCost): Buffer {
  return scryptSync(normalizePassphrase(passphrase), salt, 32, {
    ...cost,
    // scrypt needs 128 * N * r bytes; Node's default 32 MiB cap is below that.
    maxmem: 128 * cost.N * cost.r + 32 * 1024 * 1024,
  });
}

function wrapMasterKey(key: Buffer, passphrase: string): KeyRecovery {
  const salt = randomBytes(16);
  const kek = deriveRecoveryKey(passphrase, salt, SCRYPT_COST);
  try {
    return {
      kdf: "scrypt",
      ...SCRYPT_COST,
      salt: salt.toString("base64"),
      wrappedKey: encrypt(key.toString("base64"), kek, KEY_RECOVERY_AAD),
    };
  } finally {
    kek.fill(0);
  }
}

function unwrapMasterKey(recovery: KeyRecovery, passphrase: string): Buffer {
  // The cost comes from the file, so bound it: an altered archive must not be
  // able to make a restore allocate gigabytes or spin for hours.
  const { kdf, N, r, p } = recovery;
  const powerOfTwo = Number.isInteger(Math.log2(N));
  if (kdf !== "scrypt" || !powerOfTwo || N < 2 ** 14 || N > 2 ** 18 || r < 1 || r > 8 || p < 1 || p > 4) {
    throw new Error("backup key recovery uses unsupported parameters");
  }
  const kek = deriveRecoveryKey(passphrase, Buffer.from(recovery.salt, "base64"), { N, r, p });
  let encoded: string;
  try {
    encoded = decrypt(recovery.wrappedKey, kek, KEY_RECOVERY_AAD);
  } catch {
    throw new Error("wrong recovery passphrase (or the archive was altered)");
  } finally {
    kek.fill(0);
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("backup key recovery holds a malformed key");
  return key;
}

/**
 * Every column sealed under MASTER_ENCRYPTION_KEY, as (table, row id, AAD).
 * A backup taken with the wrong key in the environment would still restore
 * cleanly -- and then leave every secret in it unreadable. With key recovery
 * it would also faithfully hand back the wrong key. So the key must open at
 * least one sample before anything is written.
 */
const SEALED_COLUMNS = [
  { table: "oauth_accounts", id: "user_id", column: "encrypted_refresh_token", aad: aad.oauthRefreshToken },
  { table: "s3_credentials", id: "id", column: "encrypted_secret_key", aad: aad.s3Secret },
  { table: "backup_accounts", id: "id", column: "encrypted_refresh_token", aad: aad.backupRefreshToken },
  { table: "backup_accounts", id: "id", column: "encrypted_secret", aad: aad.backupDestinationSecret },
  { table: "totp_secrets", id: "user_id", column: "encrypted_secret", aad: aad.totpSecret },
  { table: "kms_keys", id: "id", column: "encrypted_material", aad: aad.kmsKey },
] as const;

function assertKeyOpensSecrets(db: Database, key: Buffer): void {
  let sampled = 0;
  for (const sealed of SEALED_COLUMNS) {
    // A database from before a migration may lack the table or the column.
    const columns = db
      .query<{ name: string }, []>(`SELECT name FROM pragma_table_info('${sealed.table}')`)
      .all()
      .map((row) => row.name);
    if (!columns.includes(sealed.column)) continue;
    // Empty and NULL mean "no secret here" (an S3 destination's refresh-token
    // column, any other destination's secret), not an unreadable one.
    const rows = db
      .query<{ id: string; value: string }, []>(
        `SELECT ${sealed.id} AS id, ${sealed.column} AS value FROM ${sealed.table}
          WHERE ${sealed.column} IS NOT NULL AND ${sealed.column} != '' LIMIT 3`,
      )
      .all();
    for (const row of rows) {
      sampled++;
      try {
        openFromString(row.value, key, sealed.aad(row.id));
        return;
      } catch {
        // A single row can be unreadable for its own reasons; try the next.
      }
    }
  }
  if (sampled > 0) {
    throw new Error(
      "MASTER_ENCRYPTION_KEY opens none of the secrets in this database, so it is not the key " +
        "the gateway uses; refusing to write a backup that would restore unreadable",
    );
  }
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
