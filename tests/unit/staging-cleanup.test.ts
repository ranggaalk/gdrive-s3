import { describe, expect, test } from "bun:test";
import { openMemoryDatabase } from "../../apps/server/src/db/connection.ts";
import { runMigrations, latestMigrationVersion } from "../../apps/server/src/db/migrate.ts";
import { UsersRepository } from "../../apps/server/src/db/repositories/users.ts";
import { BucketsRepository } from "../../apps/server/src/db/repositories/buckets.ts";
import { ObjectsRepository } from "../../apps/server/src/db/repositories/objects.ts";
import { ObjectStagingRepository } from "../../apps/server/src/db/repositories/object-staging.ts";
import { PendingCleanupRepository } from "../../apps/server/src/db/repositories/pending-cleanup.ts";

function seedUserBucket(db: ReturnType<typeof openMemoryDatabase>) {
  const users = new UsersRepository(db);
  const buckets = new BucketsRepository(db);
  const user = users.upsertOnLogin({
    googleSub: "sub",
    email: "u@x.com",
    displayName: null,
    hostedDomain: "x.com",
  });
  const bucket = buckets.create(user.id, "docs", "us-east-1", "folder");
  return { user, bucket };
}

describe("migrations", () => {
  test("0002 applies and is idempotent", () => {
    const db = openMemoryDatabase();
    runMigrations(db);
    expect(latestMigrationVersion()).toBeGreaterThanOrEqual(2);
    const second = runMigrations(db);
    expect(second.applied).toEqual([]);
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    expect(tables).toContain("object_staging");
    db.close();
  });
});

describe("ObjectStagingRepository", () => {
  test("start → markUploaded → commitStagedObject flow", () => {
    const db = openMemoryDatabase();
    runMigrations(db);
    const { user, bucket } = seedUserBucket(db);
    const staging = new ObjectStagingRepository(db);
    const objects = new ObjectsRepository(db);

    const row = staging.start({
      requestId: "req_1",
      userId: user.id,
      bucketId: bucket.id,
      objectKey: "hello.txt",
      contentType: "text/plain",
      metadata: {},
      cacheControl: null,
      contentDisposition: null,
      contentEncoding: null,
      contentLanguage: null,
      expiresAt: null,
      oldDriveFileId: null,
    });
    expect(row.status).toBe("uploading");

    staging.markUploaded({
      id: row.id,
      driveFileId: "drive-1",
      sizeBytes: 5,
      etag: "abcd",
      checksumSha256: "sha",
    });

    const committed = objects.commitStagedObject(row.id);
    expect(committed.current.drive_file_id).toBe("drive-1");
    expect(committed.previous).toBeNull();

    const after = staging.byId(row.id);
    expect(after?.status).toBe("committed");
    db.close();
  });

  test("listStale returns uploading rows older than cutoff", () => {
    const db = openMemoryDatabase();
    runMigrations(db);
    const { user, bucket } = seedUserBucket(db);
    const staging = new ObjectStagingRepository(db);
    const row = staging.start({
      requestId: "req_2",
      userId: user.id,
      bucketId: bucket.id,
      objectKey: "old.txt",
      contentType: "text/plain",
      metadata: {},
      cacheControl: null,
      contentDisposition: null,
      contentEncoding: null,
      contentLanguage: null,
      expiresAt: null,
      oldDriveFileId: null,
    });
    // Force updated_at to the past.
    db.query("UPDATE object_staging SET updated_at = '2000-01-01T00:00:00Z' WHERE id = ?").run(row.id);
    const stale = staging.listStale(new Date().toISOString(), 10);
    expect(stale.map((r) => r.id)).toContain(row.id);
    db.close();
  });
});

describe("PendingCleanupRepository", () => {
  test("enqueue is idempotent per user/type/resource", () => {
    const db = openMemoryDatabase();
    runMigrations(db);
    const { user } = seedUserBucket(db);
    const cleanup = new PendingCleanupRepository(db);
    const a = cleanup.enqueue({
      userId: user.id,
      resourceType: "drive_file",
      resourceId: "same-file",
      reason: "delete",
    });
    const b = cleanup.enqueue({
      userId: user.id,
      resourceType: "drive_file",
      resourceId: "same-file",
      reason: "delete",
    });
    expect(a.id).toBe(b.id);
    expect(cleanup.backlog()).toBe(1);
    cleanup.complete(a.id);
    expect(cleanup.backlog()).toBe(0);
    db.close();
  });

  test("due returns only items whose next_attempt_at <= now", () => {
    const db = openMemoryDatabase();
    runMigrations(db);
    const { user } = seedUserBucket(db);
    const cleanup = new PendingCleanupRepository(db);
    cleanup.enqueue({
      userId: user.id,
      resourceType: "drive_file",
      resourceId: "past",
      reason: "delete",
    });
    cleanup.enqueue({
      userId: user.id,
      resourceType: "drive_file",
      resourceId: "future",
      reason: "delete",
      nextAttemptAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const due = cleanup.due(new Date().toISOString(), 10);
    expect(due.map((r) => r.resource_id)).toEqual(["past"]);
    db.close();
  });
});
