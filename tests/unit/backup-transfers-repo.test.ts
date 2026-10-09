// Core incremental-backup logic: what counts as "already backed up",
// re-copy on change (etag mismatch), and the create/claim/finish lifecycle.

import { describe, expect, test } from "bun:test";
import { openMemoryDatabase } from "../../apps/server/src/db/connection.ts";
import { runMigrations } from "../../apps/server/src/db/migrate.ts";
import { UsersRepository } from "../../apps/server/src/db/repositories/users.ts";
import { BucketsRepository } from "../../apps/server/src/db/repositories/buckets.ts";
import { BackupAccountsRepository } from "../../apps/server/src/db/repositories/backup-accounts.ts";
import {
  BackupAlreadyActiveError,
  BackupTransfersRepository,
} from "../../apps/server/src/db/repositories/backup-transfers.ts";
import { newBackupAccountId, newObjectId, nowIso } from "../../apps/server/src/util/ids.ts";

function setup() {
  const db = openMemoryDatabase();
  runMigrations(db);
  const users = new UsersRepository(db);
  const buckets = new BucketsRepository(db);
  const backupAccounts = new BackupAccountsRepository(db);
  const backupTransfers = new BackupTransfersRepository(db);
  const user = users.upsertOnLogin({ googleSub: "a", email: "a@x.com", displayName: null, hostedDomain: "x.com" });
  const bucket = buckets.create(user.id, "docs", "us-east-1", "folderA");
  const account = backupAccounts.create({
    id: newBackupAccountId(),
    ownerUserId: user.id,
    email: "backup@personal.com",
    encryptedRefreshToken: "irrelevant-for-this-test",
    grantedScopes: "https://www.googleapis.com/auth/drive",
  });
  return { db, users, buckets, backupAccounts, backupTransfers, user, bucket, account };
}

function insertObject(db: ReturnType<typeof openMemoryDatabase>, bucketId: string, key: string, etag: string) {
  const now = nowIso();
  const id = newObjectId();
  db.query(
    `INSERT INTO objects (id, bucket_id, object_key, drive_file_id, size_bytes, content_type, etag, last_modified_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, bucketId, key, "file_" + key, 10, "application/octet-stream", etag, now, now, now);
  return id;
}

describe("BackupTransfersRepository", () => {
  test("create() counts all active objects as pending work on a first run", () => {
    const { db, backupTransfers, bucket, account, user } = setup();
    insertObject(db, bucket.id, "a.txt", "etag-a");
    insertObject(db, bucket.id, "b.txt", "etag-b");

    const transfer = backupTransfers.create({ userId: user.id, bucketId: bucket.id, backupAccountId: account.id });
    expect(transfer.total_count).toBe(2);
    expect(transfer.skipped_count).toBe(0);
    expect(transfer.status).toBe("queued");

    const work = backupTransfers.listObjectsNeedingWork(bucket.id, account.id, 10);
    expect(work.map((o) => o.object_key).sort()).toEqual(["a.txt", "b.txt"]);
  });

  test("only one active transfer per (bucket, backup account) at a time", () => {
    const { db, backupTransfers, bucket, account, user } = setup();
    insertObject(db, bucket.id, "a.txt", "etag-a");
    backupTransfers.create({ userId: user.id, bucketId: bucket.id, backupAccountId: account.id });
    expect(() =>
      backupTransfers.create({ userId: user.id, bucketId: bucket.id, backupAccountId: account.id }),
    ).toThrow(BackupAlreadyActiveError);
  });

  test("claimNextJob transitions queued -> running exactly once", () => {
    const { db, backupTransfers, bucket, account, user } = setup();
    insertObject(db, bucket.id, "a.txt", "etag-a");
    const created = backupTransfers.create({ userId: user.id, bucketId: bucket.id, backupAccountId: account.id });

    const claimed = backupTransfers.claimNextJob();
    expect(claimed?.id).toBe(created.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.started_at).not.toBeNull();

    // No other job queued right now.
    expect(backupTransfers.claimNextJob()?.id).toBe(created.id); // still claimable while running (resumable)
  });

  test("copying an object marks it done and finishes the transfer once nothing remains", () => {
    const { db, backupTransfers, bucket, account, user } = setup();
    const objectId = insertObject(db, bucket.id, "a.txt", "etag-a");
    const transfer = backupTransfers.create({ userId: user.id, bucketId: bucket.id, backupAccountId: account.id });
    backupTransfers.claimNextJob();

    backupTransfers.markObjectCopied({
      transferId: transfer.id,
      backupAccountId: account.id,
      objectId,
      objectKey: "a.txt",
      objectEtag: "etag-a",
      destinationFileId: "drive_dest_1",
    });

    const finished = backupTransfers.refreshAndMaybeFinish(transfer.id);
    expect(finished.status).toBe("completed");
    expect(finished.copied_count).toBe(1);
    expect(finished.completed_at).not.toBeNull();
  });

  test("a second run skips objects already copied at the same etag (incremental backup)", () => {
    const { db, backupTransfers, bucket, account, user } = setup();
    const objectId = insertObject(db, bucket.id, "a.txt", "etag-a");
    const first = backupTransfers.create({ userId: user.id, bucketId: bucket.id, backupAccountId: account.id });
    backupTransfers.claimNextJob();
    backupTransfers.markObjectCopied({
      transferId: first.id,
      backupAccountId: account.id,
      objectId,
      objectKey: "a.txt",
      objectEtag: "etag-a",
      destinationFileId: "drive_dest_1",
    });
    backupTransfers.refreshAndMaybeFinish(first.id);

    // Add a new object; the already-copied one should now be skipped.
    insertObject(db, bucket.id, "b.txt", "etag-b");
    const second = backupTransfers.create({ userId: user.id, bucketId: bucket.id, backupAccountId: account.id });
    expect(second.total_count).toBe(2);
    expect(second.skipped_count).toBe(1);

    const work = backupTransfers.listObjectsNeedingWork(bucket.id, account.id, 10);
    expect(work.map((o) => o.object_key)).toEqual(["b.txt"]);
  });

  test("a changed object (new etag) needs work again even though it was copied before", () => {
    const { db, backupTransfers, bucket, account, user } = setup();
    const objectId = insertObject(db, bucket.id, "a.txt", "etag-a");
    const first = backupTransfers.create({ userId: user.id, bucketId: bucket.id, backupAccountId: account.id });
    backupTransfers.claimNextJob();
    backupTransfers.markObjectCopied({
      transferId: first.id,
      backupAccountId: account.id,
      objectId,
      objectKey: "a.txt",
      objectEtag: "etag-a",
      destinationFileId: "drive_dest_1",
    });
    backupTransfers.refreshAndMaybeFinish(first.id);

    // Simulate the source file changing (same object id, new etag).
    db.query("UPDATE objects SET etag = ? WHERE id = ?").run("etag-a-v2", objectId);

    const second = backupTransfers.create({ userId: user.id, bucketId: bucket.id, backupAccountId: account.id });
    expect(second.skipped_count).toBe(0);
    const work = backupTransfers.listObjectsNeedingWork(bucket.id, account.id, 10);
    expect(work.map((o) => o.object_key)).toEqual(["a.txt"]);
  });

  test("cancel_requested finishes as cancelled instead of completed", () => {
    const { db, backupTransfers, bucket, account, user } = setup();
    insertObject(db, bucket.id, "a.txt", "etag-a");
    const transfer = backupTransfers.create({ userId: user.id, bucketId: bucket.id, backupAccountId: account.id });
    expect(backupTransfers.requestCancel(user.id, bucket.id, transfer.id)).toBe(true);
    const finished = backupTransfers.refreshAndMaybeFinish(transfer.id);
    expect(finished.status).toBe("cancelled");
  });

  test("failJob marks a running transfer failed but never overwrites a terminal one", () => {
    const { db, backupTransfers, bucket, account, user } = setup();
    insertObject(db, bucket.id, "a.txt", "etag-a");
    const transfer = backupTransfers.create({ userId: user.id, bucketId: bucket.id, backupAccountId: account.id });
    backupTransfers.failJob(transfer.id, "boom");
    expect(backupTransfers.findById(transfer.id)?.status).toBe("failed");

    // Once terminal, failJob must not clobber a completed/cancelled outcome.
    const { backupTransfers: fresh, bucket: bucket2, account: account2, user: user2 } = setup();
    const t2 = fresh.create({ userId: user2.id, bucketId: bucket2.id, backupAccountId: account2.id });
    fresh.requestCancel(user2.id, bucket2.id, t2.id);
    fresh.refreshAndMaybeFinish(t2.id);
    fresh.failJob(t2.id, "should be ignored");
    expect(fresh.findById(t2.id)?.status).toBe("cancelled");
  });
});

describe("BackupTransfersRepository, scheduling", () => {
  test("a run started by hand is claimed before one a schedule queued, even a later one", () => {
    const { db, buckets, backupTransfers, bucket, account, user } = setup();
    const other = buckets.create(user.id, "media", "us-east-1", "folderB");
    insertObject(db, bucket.id, "a.txt", "etag-a");
    insertObject(db, other.id, "b.txt", "etag-b");

    const scheduled = backupTransfers.create({
      userId: user.id, bucketId: bucket.id, backupAccountId: account.id, triggeredBy: "schedule",
    });
    const manual = backupTransfers.create({ userId: user.id, bucketId: other.id, backupAccountId: account.id });
    expect(scheduled.triggered_by).toBe("schedule");
    expect(manual.triggered_by).toBe("manual");

    expect(backupTransfers.claimNextJob()?.id).toBe(manual.id);
  });

  test("an object that failed in a run is not handed to the same run again", () => {
    const { db, backupTransfers, bucket, account, user } = setup();
    const objectId = insertObject(db, bucket.id, "a.txt", "etag-a");
    const run = backupTransfers.create({ userId: user.id, bucketId: bucket.id, backupAccountId: account.id });
    backupTransfers.markObjectFailed({
      transferId: run.id, backupAccountId: account.id, objectId, objectKey: "a.txt", objectEtag: "etag-a", error: "boom",
    });

    expect(backupTransfers.listObjectsNeedingWork(bucket.id, account.id, 10, run.id)).toEqual([]);
    // The next run does retry it.
    expect(backupTransfers.listObjectsNeedingWork(bucket.id, account.id, 10).map((o) => o.id)).toEqual([objectId]);
  });

  test("completeIdle finishes a running run whose counted objects are gone", () => {
    const { db, backupTransfers, bucket, account, user } = setup();
    insertObject(db, bucket.id, "a.txt", "etag-a");
    const run = backupTransfers.create({ userId: user.id, bucketId: bucket.id, backupAccountId: account.id });
    backupTransfers.claimNextJob();
    db.query("DELETE FROM objects WHERE bucket_id = ?").run(bucket.id);

    expect(backupTransfers.refreshAndMaybeFinish(run.id).status).toBe("running");
    backupTransfers.completeIdle(run.id);
    expect(backupTransfers.findById(run.id)?.status).toBe("completed");
  });

  test("pruneHistory removes old finished runs but keeps each pair's latest", () => {
    const { db, buckets, backupTransfers, bucket, account, user } = setup();
    const other = buckets.create(user.id, "media", "us-east-1", "folderB");
    const finish = (bucketId: string, at: string) => {
      const run = backupTransfers.create({ userId: user.id, bucketId, backupAccountId: account.id });
      backupTransfers.refreshAndMaybeFinish(run.id);
      db.query("UPDATE backup_transfers SET created_at = ?, completed_at = ? WHERE id = ?").run(at, at, run.id);
      return run.id;
    };
    const oldest = finish(bucket.id, "2026-01-01T00:00:00.000Z");
    const latest = finish(bucket.id, "2026-02-01T00:00:00.000Z");
    const onlyRun = finish(other.id, "2026-01-01T00:00:00.000Z");

    expect(backupTransfers.pruneHistory("2026-06-01T00:00:00.000Z")).toBe(1);
    expect(backupTransfers.findById(oldest)).toBeNull();
    expect(backupTransfers.findById(latest)).not.toBeNull();
    expect(backupTransfers.findById(onlyRun)).not.toBeNull();
  });
});
