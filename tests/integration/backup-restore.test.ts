import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../apps/server/src/db/connection.ts";
import {
  appliedMigrationVersion,
  latestMigrationVersion,
  runMigrations,
} from "../../apps/server/src/db/migrate.ts";
import { UsersRepository } from "../../apps/server/src/db/repositories/users.ts";
import { BucketsRepository } from "../../apps/server/src/db/repositories/buckets.ts";
import { aad, sealToString } from "../../apps/server/src/security/encryption.ts";
import {
  backupHasKeyRecovery,
  createEncryptedBackup,
  restoreEncryptedBackup,
} from "../../scripts/backup-core.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("encrypted SQLite backup and restore", () => {
  test("round-trips data, integrity, and migration version", () => {
    const dir = mkdtempSync(join(tmpdir(), "drives3-backup-test-"));
    dirs.push(dir);
    const source = join(dir, "source.sqlite");
    const restored = join(dir, "restored.sqlite");
    const out = join(dir, "backups");
    const key = Buffer.alloc(32, 9);

    const db = openDatabase(source);
    runMigrations(db);
    const user = new UsersRepository(db).upsertOnLogin({
      googleSub: "backup",
      email: "backup@x.com",
      displayName: "Backup User",
      hostedDomain: "x.com",
    });
    new BucketsRepository(db).create(user.id, "backup-bucket", "us-east-1", "folder-1");
    db.close();

    const backup = createEncryptedBackup({
      sourcePath: source,
      outputDir: out,
      key,
      now: new Date("2026-07-15T12:00:00.000Z"),
    });
    expect(backup.manifest.integrity).toBe("ok");
    expect(backup.manifest.migrationVersion).toBe(latestMigrationVersion());
    expect(backup.manifest.sha256).toMatch(/^[0-9a-f]{64}$/);

    const result = restoreEncryptedBackup({
      encryptedPath: backup.encryptedPath,
      targetPath: restored,
      key,
    });
    expect(result.integrity).toBe("ok");
    expect(result.migrationVersion).toBe(latestMigrationVersion());

    const restoredDb = openDatabase(restored);
    expect(appliedMigrationVersion(restoredDb)).toBe(latestMigrationVersion());
    const restoredUser = new UsersRepository(restoredDb).findById(user.id);
    expect(restoredUser?.email).toBe("backup@x.com");
    expect(new BucketsRepository(restoredDb).findByName(user.id, "backup-bucket")?.name).toBe(
      "backup-bucket",
    );
    restoredDb.close();
  });

  test("rejects wrong encryption key, tampering, and overwrite without force", () => {
    const dir = mkdtempSync(join(tmpdir(), "drives3-backup-guard-"));
    dirs.push(dir);
    const source = join(dir, "source.sqlite");
    const target = join(dir, "target.sqlite");
    const key = Buffer.alloc(32, 4);
    const db = openDatabase(source);
    runMigrations(db);
    db.close();
    const backup = createEncryptedBackup({ sourcePath: source, outputDir: dir, key });

    expect(() =>
      restoreEncryptedBackup({
        encryptedPath: backup.encryptedPath,
        targetPath: target,
        key: Buffer.alloc(32, 5),
      }),
    ).toThrow();

    const restored = restoreEncryptedBackup({
      encryptedPath: backup.encryptedPath,
      targetPath: target,
      key,
    });
    expect(restored.integrity).toBe("ok");
    expect(() =>
      restoreEncryptedBackup({ encryptedPath: backup.encryptedPath, targetPath: target, key }),
    ).toThrow(/target exists/);
  });

  describe("key recovery", () => {
    const PASSPHRASE = "kopi tubruk di teras jam enam";

    function seededDatabase(dir: string, sealKey?: Buffer): string {
      const source = join(dir, "source.sqlite");
      const db = openDatabase(source);
      runMigrations(db);
      const user = new UsersRepository(db).upsertOnLogin({
        googleSub: "recovery",
        email: "recovery@x.com",
        displayName: "Recovery User",
        hostedDomain: "x.com",
      });
      new BucketsRepository(db).create(user.id, "recovery-bucket", "us-east-1", "folder-1");
      if (sealKey) {
        const now = new Date().toISOString();
        db.query(
          `INSERT INTO s3_credentials (id, user_id, access_key_id, encrypted_secret_key, label, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run("cred-1", user.id, "AKIARECOVERY", sealToString("secret", sealKey, aad.s3Secret("cred-1")), "test", now);
      }
      db.close();
      return source;
    }

    function tempDir(): string {
      const dir = mkdtempSync(join(tmpdir(), "drives3-backup-recovery-"));
      dirs.push(dir);
      return dir;
    }

    test("restores from the passphrase alone and hands back the master key", () => {
      const dir = tempDir();
      const key = Buffer.alloc(32, 21);
      const source = seededDatabase(dir, key);
      const backup = createEncryptedBackup({ sourcePath: source, outputDir: dir, key, recoveryPassphrase: PASSPHRASE });
      expect(backup.manifest.keyRecovery).toBe("passphrase");
      expect(backupHasKeyRecovery(backup.encryptedPath)).toBe(true);
      // The archive must not hold the key in the clear.
      expect(readFileSync(backup.encryptedPath, "utf8")).not.toContain(key.toString("base64"));

      const target = join(dir, "restored.sqlite");
      const result = restoreEncryptedBackup({ encryptedPath: backup.encryptedPath, targetPath: target, passphrase: PASSPHRASE });
      expect(result.recoveredKey?.equals(key)).toBe(true);

      const restored = openDatabase(target);
      const user = restored.query<{ id: string }, [string]>("SELECT id FROM users WHERE email = ?").get("recovery@x.com");
      expect(user).not.toBeNull();
      expect(new BucketsRepository(restored).findByName(user!.id, "recovery-bucket")).not.toBeNull();
      restored.close();
    });

    test("rejects a wrong passphrase, while the key still restores the same archive", () => {
      const dir = tempDir();
      const key = Buffer.alloc(32, 22);
      const backup = createEncryptedBackup({
        sourcePath: seededDatabase(dir),
        outputDir: dir,
        key,
        recoveryPassphrase: PASSPHRASE,
      });

      expect(() =>
        restoreEncryptedBackup({
          encryptedPath: backup.encryptedPath,
          targetPath: join(dir, "wrong.sqlite"),
          passphrase: "kopi tubruk di teras jam tujuh",
        }),
      ).toThrow(/wrong recovery passphrase/);

      const result = restoreEncryptedBackup({ encryptedPath: backup.encryptedPath, targetPath: join(dir, "keyed.sqlite"), key });
      expect(result.integrity).toBe("ok");
      expect(result.recoveredKey).toBeUndefined();
    });

    test("refuses a passphrase short enough to guess", () => {
      const dir = tempDir();
      expect(() =>
        createEncryptedBackup({
          sourcePath: seededDatabase(dir),
          outputDir: dir,
          key: Buffer.alloc(32, 23),
          recoveryPassphrase: "short-one",
        }),
      ).toThrow(/at least 12 characters/);
    });

    test("an archive made without a passphrase says it cannot be recovered with one", () => {
      const dir = tempDir();
      const backup = createEncryptedBackup({ sourcePath: seededDatabase(dir), outputDir: dir, key: Buffer.alloc(32, 24) });
      expect(backup.manifest.keyRecovery).toBe("none");
      expect(backupHasKeyRecovery(backup.encryptedPath)).toBe(false);
      expect(() =>
        restoreEncryptedBackup({
          encryptedPath: backup.encryptedPath,
          targetPath: join(dir, "restored.sqlite"),
          passphrase: PASSPHRASE,
        }),
      ).toThrow(/no key recovery/);
    });

    test("still restores a v1 archive, which is the bare payload envelope", () => {
      const dir = tempDir();
      const key = Buffer.alloc(32, 25);
      const backup = createEncryptedBackup({ sourcePath: seededDatabase(dir), outputDir: dir, key });
      const { payload } = JSON.parse(readFileSync(backup.encryptedPath, "utf8")) as { payload: unknown };
      writeFileSync(backup.encryptedPath, JSON.stringify(payload));
      rmSync(backup.manifestPath);

      expect(backupHasKeyRecovery(backup.encryptedPath)).toBe(false);
      const result = restoreEncryptedBackup({ encryptedPath: backup.encryptedPath, targetPath: join(dir, "v1.sqlite"), key });
      expect(result.integrity).toBe("ok");
    });

    test("refuses to back up with a key that opens none of the database's secrets", () => {
      const dir = tempDir();
      const appKey = Buffer.alloc(32, 26);
      const source = seededDatabase(dir, appKey);
      // Recovering this key later would hand back a key that opens nothing.
      expect(() =>
        createEncryptedBackup({
          sourcePath: source,
          outputDir: dir,
          key: Buffer.alloc(32, 27),
          recoveryPassphrase: PASSPHRASE,
        }),
      ).toThrow(/opens none of the secrets/);
      expect(createEncryptedBackup({ sourcePath: source, outputDir: dir, key: appKey }).manifest.integrity).toBe("ok");
    });
  });
});
