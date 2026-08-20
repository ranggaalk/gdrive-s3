import { describe, expect, test } from "bun:test";
import { openMemoryDatabase } from "../../apps/server/src/db/connection.ts";
import { runMigrations } from "../../apps/server/src/db/migrate.ts";
import { UsersRepository } from "../../apps/server/src/db/repositories/users.ts";
import { BucketsRepository } from "../../apps/server/src/db/repositories/buckets.ts";
import { ObjectsRepository } from "../../apps/server/src/db/repositories/objects.ts";
import { nowIso, newObjectId } from "../../apps/server/src/util/ids.ts";

function setup() {
  const db = openMemoryDatabase();
  runMigrations(db);
  const users = new UsersRepository(db);
  const buckets = new BucketsRepository(db);
  const objects = new ObjectsRepository(db);
  const a = users.upsertOnLogin({ googleSub: "a", email: "a@x.com", displayName: null, hostedDomain: "x.com" });
  const b = users.upsertOnLogin({ googleSub: "b", email: "b@x.com", displayName: null, hostedDomain: "x.com" });
  return { db, buckets, objects, a, b };
}

function insertObject(db: ReturnType<typeof openMemoryDatabase>, bucketId: string, key: string) {
  const now = nowIso();
  db.query(
    `INSERT INTO objects (id, bucket_id, object_key, drive_file_id, size_bytes, etag, last_modified_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(newObjectId(), bucketId, key, "file_" + key, 10, "etag", now, now, now);
}

describe("BucketsRepository", () => {
  test("uniqueness is per-user, not global", () => {
    const { buckets, a, b } = setup();
    buckets.create(a.id, "shared", "us-east-1", "folderA");
    // same name allowed for another user
    const bBucket = buckets.create(b.id, "shared", "us-east-1", "folderB");
    expect(bBucket.name).toBe("shared");
    expect(buckets.findByName(a.id, "shared")!.drive_folder_id).toBe("folderA");
  });

  test("findByIdOwned enforces ownership", () => {
    const { buckets, a, b } = setup();
    const bucket = buckets.create(a.id, "docs", "us-east-1", "f");
    expect(buckets.findByIdOwned(a.id, bucket.id)).not.toBeNull();
    expect(buckets.findByIdOwned(b.id, bucket.id)).toBeNull();
  });

  test("hasObjects reflects active objects", () => {
    const { db, buckets, a } = setup();
    const bucket = buckets.create(a.id, "docs", "us-east-1", "f");
    expect(buckets.hasObjects(bucket.id)).toBe(false);
    insertObject(db, bucket.id, "a.txt");
    expect(buckets.hasObjects(bucket.id)).toBe(true);
  });

  test("object listing is prefix-filtered and byte-ordered", () => {
    const { db, buckets, objects, a } = setup();
    const bucket = buckets.create(a.id, "docs", "us-east-1", "f");
    for (const k of ["b/2", "a/1", "a/2", "c/1"]) insertObject(db, bucket.id, k);
    const page = objects.listByBucket(bucket.id, { prefix: "a/", limit: 10 });
    expect(page.items.map((o) => o.object_key)).toEqual(["a/1", "a/2"]);
  });

  test("prefix with SQL wildcard is treated literally and case-sensitively", () => {
    const { db, buckets, objects, a } = setup();
    const bucket = buckets.create(a.id, "docs", "us-east-1", "f");
    for (const key of ["100%done", "100Xdone", "a/one", "A/two"]) {
      insertObject(db, bucket.id, key);
    }
    expect(
      objects.listByBucket(bucket.id, { prefix: "100%", limit: 10 }).items
        .map((object) => object.object_key),
    ).toEqual(["100%done"]);
    expect(
      objects.listByBucket(bucket.id, { prefix: "a/", limit: 10 }).items
        .map((object) => object.object_key),
    ).toEqual(["a/one"]);
  });
});
