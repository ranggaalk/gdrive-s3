import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
import {
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
});
