import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  backupRootFolderName,
  bucketMarker,
} from "../../apps/server/src/services/backup-account-service.ts";

const SOURCE = readFileSync(
  new URL("../../apps/server/src/services/backup-account-service.ts", import.meta.url).pathname,
  "utf8",
);

describe("backup root folder name", () => {
  test("marks the folder as a backup, and says whose and from when", () => {
    const name = backupRootFolderName({
      ownerEmail: "owner@example.com",
      ownerUserId: "usr_1",
      linkedAt: "2026-08-28T09:15:00.000Z",
    });
    expect(name).toBe("[DRIVE-S3-BACKUP] owner@example.com 2026-08-28");
  });

  test("is distinguishable from an ordinary gateway root", () => {
    // The destination account may run this gateway too; a backup root named
    // [DRIVE-S3-GATEWAY] would be indistinguishable from its own.
    const name = backupRootFolderName({
      ownerEmail: "o@e.com",
      ownerUserId: "usr_1",
      linkedAt: "2026-08-28T00:00:00.000Z",
    });
    expect(name).not.toContain("[DRIVE-S3-GATEWAY]");
    expect(name.startsWith("[DRIVE-S3-BACKUP]")).toBe(true);
  });

  test("falls back to the user id when the email is unknown", () => {
    expect(
      backupRootFolderName({ ownerEmail: null, ownerUserId: "usr_9", linkedAt: "2026-01-02T00:00:00Z" }),
    ).toBe("[DRIVE-S3-BACKUP] usr_9 2026-01-02");
  });

  test("is stable across runs, so the rename cannot loop", () => {
    // Derived from the link date, never from now(): a name that drifted would
    // be renamed on every single transfer.
    const input = { ownerEmail: "o@e.com", ownerUserId: "usr_1", linkedAt: "2026-08-28T09:15:00.000Z" };
    expect(backupRootFolderName(input)).toBe(backupRootFolderName(input));
    expect(backupRootFolderName(input)).not.toContain(String(new Date().getFullYear() + 1));
  });
});

describe("bucket folder marker", () => {
  test("scopes a bucket to the destination account", () => {
    // One bucket can be backed up to two accounts; each needs its own folder.
    expect(bucketMarker("bac_1", "bkt_1")).not.toBe(bucketMarker("bac_2", "bkt_1"));
    expect(bucketMarker("bac_1", "bkt_1")).toBe("bac_1:bkt_1");
  });

  test("stays inside Drive's per-property size limit", () => {
    // Google caps a single appProperty at 124 bytes for key plus value.
    const key = "drives3BackupBucketFor";
    const value = bucketMarker(`bac_${"0".repeat(32)}`, `bkt_${"0".repeat(32)}`);
    expect(key.length + value.length).toBeLessThanOrEqual(124);
  });
});

/**
 * The folder lookups run against Google, so no test previously covered them —
 * which is exactly how the mismatch below shipped. Each ensure searched
 * `drives3Type` for a value that was never written to it ("backup-root:<id>"
 * against a stored "backup_root"), so every lookup missed and every transfer
 * created a duplicate folder next to the last one.
 *
 * Asserting on the source keeps the searched key/value and the written
 * key/value tied together without standing up a fake Drive.
 */
describe("folder lookup matches folder creation", () => {
  function block(method: string): string {
    const start = SOURCE.indexOf(`async ${method}(`);
    expect(start).toBeGreaterThan(-1);
    const end = SOURCE.indexOf("\n  }", start);
    return SOURCE.slice(start, end);
  }

  test.each(["ensureRootFolder", "ensureBucketFolder"])(
    "%s searches by a property it also writes",
    (method) => {
      const body = block(method);
      const searchKey = /findByAppProperty\(\s*([A-Z_]+)/.exec(body)?.[1];
      expect(searchKey).toBeDefined();
      // The computed-key form only occurs in an appProperties object, so this
      // proves the key searched is also the key written.
      expect(body).toContain(`[${searchKey}]:`);
    },
  );

  test("neither ensure searches the shared type marker", () => {
    // drives3Type holds a constant shared by every backup folder, so matching
    // on it could never identify one account's folder.
    for (const method of ["ensureRootFolder", "ensureBucketFolder"]) {
      expect(block(method)).not.toMatch(/findByAppProperty\(\s*MARKER_KEY/);
    }
  });

  test("a cached root that vanished is cleared, not reused", () => {
    const body = block("ensureRootFolder");
    expect(body).toContain("getFile");
    expect(body).toContain("setRootFolder(account.id, null)");
  });
});
