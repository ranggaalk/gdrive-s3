import { describe, expect, test } from "bun:test";
import { openMemoryDatabase } from "../../apps/server/src/db/connection.ts";
import {
  findSchemaDrift,
  runMigrations,
  appliedMigrationVersion,
  latestMigrationVersion,
} from "../../apps/server/src/db/migrate.ts";

describe("runMigrations", () => {
  test("applies initial migration and is idempotent", () => {
    const db = openMemoryDatabase();

    const first = runMigrations(db);
    expect(first.applied.length).toBeGreaterThan(0);
    expect(first.currentVersion).toBe(latestMigrationVersion());
    expect(appliedMigrationVersion(db)).toBe(latestMigrationVersion());

    // Second run applies nothing.
    const second = runMigrations(db);
    expect(second.applied.length).toBe(0);

    // Core tables exist.
    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    for (const t of [
      "users",
      "oauth_accounts",
      "sessions",
      "drive_roots",
      "drive_targets",
      "bucket_members",
      "s3_credentials",
      "buckets",
      "objects",
      "multipart_uploads",
      "multipart_parts",
      "pending_cleanup",
      "audit_logs",
      "public_object_links",
      "schema_migrations",
    ]) {
      expect(tables).toContain(t);
    }
    db.close();
  });

  test("public links cascade with object deletion", () => {
    const db = openMemoryDatabase();
    runMigrations(db);
    const now = new Date().toISOString();
    db.query(
      "INSERT INTO users (id, google_sub, email, hosted_domain, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    ).run("usr_link", "sub_link", "link@example.com", "example.com", now, now);
    db.query(
      "INSERT INTO buckets (id, user_id, name, drive_folder_id, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    ).run("bkt_link", "usr_link", "links", "folder_link", now, now);
    db.query(
      `INSERT INTO objects
         (id, bucket_id, object_key, drive_file_id, size_bytes, content_type,
          etag, last_modified_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run("obj_link", "bkt_link", "x", "file_link", 1, "text/plain", "etag", now, now, now);
    db.query(
      `INSERT INTO public_object_links
         (id, object_id, owner_user_id, token_hash, label, created_at)
       VALUES (?,?,?,?,?,?)`,
    ).run("lnk_link", "obj_link", "usr_link", "a".repeat(64), "link", now);
    db.query("DELETE FROM objects WHERE id = ?").run("obj_link");
    expect(db.query<{ c: number }, []>("SELECT COUNT(*) AS c FROM public_object_links").get()?.c).toBe(0);
    db.close();
  });

  test("foreign keys cascade delete", () => {
    const db = openMemoryDatabase();
    runMigrations(db);
    const now = new Date().toISOString();
    db.query(
      "INSERT INTO users (id, google_sub, email, hosted_domain, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    ).run("usr_1", "sub_1", "a@example.com", "example.com", now, now);
    db.query(
      "INSERT INTO buckets (id, user_id, name, drive_folder_id, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    ).run("bkt_1", "usr_1", "docs", "folder_1", now, now);

    db.query("DELETE FROM users WHERE id = ?").run("usr_1");
    const count = db
      .query<{ c: number }, []>("SELECT COUNT(*) AS c FROM buckets")
      .get();
    expect(count?.c).toBe(0);
    db.close();
  });
});

describe("schema drift detection", () => {
  test("reports nothing for a fully migrated database", () => {
    const db = openMemoryDatabase();
    runMigrations(db);
    expect(findSchemaDrift(db)).toEqual([]);
    db.close();
  });

  test("names a column that a migration describes but the database lacks", () => {
    // Reproduces the real failure: a migration edited after it was applied is
    // recorded as done and never re-run, so its later statements never land.
    const db = openMemoryDatabase();
    runMigrations(db);
    db.exec("ALTER TABLE object_staging DROP COLUMN acl");

    const drift = findSchemaDrift(db);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain("object_staging");
    expect(drift[0]).toContain("acl");
    db.close();
  });

  test("names a table that is missing entirely", () => {
    const db = openMemoryDatabase();
    runMigrations(db);
    db.exec("DROP TABLE bucket_policies");
    expect(findSchemaDrift(db)).toEqual(["missing table: bucket_policies"]);
    db.close();
  });
});
