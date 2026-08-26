import { describe, expect, test } from "bun:test";
import { openMemoryDatabase } from "../../apps/server/src/db/connection.ts";
import { runMigrations } from "../../apps/server/src/db/migrate.ts";
import { UsersRepository } from "../../apps/server/src/db/repositories/users.ts";
import { BucketsRepository } from "../../apps/server/src/db/repositories/buckets.ts";
import { AuditLogsRepository } from "../../apps/server/src/db/repositories/audit-logs.ts";

function setup() {
  const db = openMemoryDatabase();
  runMigrations(db);
  const users = new UsersRepository(db);
  const buckets = new BucketsRepository(db);
  const audit = new AuditLogsRepository(db);
  const alice = users.upsertOnLogin({
    googleSub: "alice",
    email: "alice@x.com",
    displayName: null,
    hostedDomain: "x.com",
  });
  const bob = users.upsertOnLogin({
    googleSub: "bob",
    email: "bob@x.com",
    displayName: null,
    hostedDomain: "x.com",
  });
  // Same bucket name, different owners — only legal because names are
  // unique per-owner (UNIQUE(user_id, name)), not globally.
  const aliceBucket = buckets.create(alice.id, "docs", "us-east-1", "folder-a");
  const bobBucket = buckets.create(bob.id, "docs", "us-east-1", "folder-b");
  return { db, audit, buckets, alice, bob, aliceBucket, bobBucket };
}

function insertRow(
  db: ReturnType<typeof openMemoryDatabase>,
  opts: {
    userId: string;
    bucketId: string;
    bucketName: string;
    createdAt: string;
    statusCode?: number;
    bytesIn?: number;
    bytesOut?: number;
  },
) {
  db.query(
    `INSERT INTO audit_logs
       (id, user_id, credential_id, action, bucket_name, bucket_id, object_key,
        status_code, request_id, bytes_in, bytes_out, ip_hash, user_agent,
        detail_json, created_at)
     VALUES (?, ?, NULL, 's3.PutObject', ?, ?, 'k', ?, ?, ?, ?, NULL, NULL, '{}', ?)`,
  ).run(
    crypto.randomUUID(),
    opts.userId,
    opts.bucketName,
    opts.bucketId,
    opts.statusCode ?? 200,
    crypto.randomUUID(),
    opts.bytesIn ?? 0,
    opts.bytesOut ?? 0,
    opts.createdAt,
  );
}

describe("AuditLogsRepository.trafficSeries", () => {
  test("zero-fills empty minutes and aggregates bytes/requests/errors per bucket", () => {
    const { db, audit, alice, aliceBucket } = setup();
    const now = Date.now();
    const minuteMs = (offset: number) => now + offset * 60_000;
    const minuteIso = (offset: number) => new Date(minuteMs(offset)).toISOString();
    const minuteKey = (offset: number) => `${minuteIso(offset).slice(0, 16)}:00Z`;

    // Two requests 4 minutes ago (one error), one request 2 minutes ago,
    // minute -3 and -1 have no traffic at all.
    insertRow(db, { userId: alice.id, bucketId: aliceBucket.id, bucketName: "docs", createdAt: minuteIso(-4), bytesIn: 100, statusCode: 200 });
    insertRow(db, { userId: alice.id, bucketId: aliceBucket.id, bucketName: "docs", createdAt: minuteIso(-4), bytesOut: 50, statusCode: 500 });
    insertRow(db, { userId: alice.id, bucketId: aliceBucket.id, bucketName: "docs", createdAt: minuteIso(-2), bytesIn: 10, statusCode: 200 });

    const points = audit.trafficSeries(aliceBucket.id, new Date(now - 5 * 60_000), "minute");
    const byKey = new Map(points.map((p) => [p.t, p]));

    expect(byKey.get(minuteKey(-4))).toMatchObject({ requests: 2, errors: 1, bytesIn: 100, bytesOut: 50 });
    expect(byKey.get(minuteKey(-3))).toMatchObject({ requests: 0, errors: 0, bytesIn: 0, bytesOut: 0 });
    expect(byKey.get(minuteKey(-2))).toMatchObject({ requests: 1, errors: 0, bytesIn: 10, bytesOut: 0 });
    expect(byKey.get(minuteKey(-1))).toMatchObject({ requests: 0, errors: 0, bytesIn: 0, bytesOut: 0 });
  });

  test("scopes strictly by bucket_id, never mixing a same-named bucket owned by someone else", () => {
    const { db, audit, alice, bob, aliceBucket, bobBucket } = setup();
    const now = new Date().toISOString();

    insertRow(db, { userId: alice.id, bucketId: aliceBucket.id, bucketName: "docs", createdAt: now, bytesIn: 111 });
    insertRow(db, { userId: bob.id, bucketId: bobBucket.id, bucketName: "docs", createdAt: now, bytesIn: 999 });

    const points = audit.trafficSeries(aliceBucket.id, new Date(Date.now() - 60_000), "minute");
    const total = points.reduce((sum, p) => sum + p.bytesIn, 0);
    expect(total).toBe(111);
  });

  test("excludes rows before the requested window", () => {
    const { db, audit, alice, aliceBucket } = setup();
    const now = Date.now();
    insertRow(db, {
      userId: alice.id,
      bucketId: aliceBucket.id,
      bucketName: "docs",
      createdAt: new Date(now - 10 * 60_000).toISOString(),
      bytesIn: 500,
    });

    const points = audit.trafficSeries(aliceBucket.id, new Date(now - 2 * 60_000), "minute");
    expect(points.every((p) => p.requests === 0)).toBe(true);
  });
});

describe("AuditLogsRepository.trafficSeriesForBuckets", () => {
  test("sums across every listed bucket, ignoring buckets not in the list", () => {
    const { db, audit, buckets, alice, aliceBucket } = setup();
    const secondBucket = buckets.create(alice.id, "backups", "us-east-1", "folder-c");
    const now = new Date().toISOString();
    insertRow(db, { userId: alice.id, bucketId: aliceBucket.id, bucketName: "docs", createdAt: now, bytesIn: 10 });
    insertRow(db, { userId: alice.id, bucketId: secondBucket.id, bucketName: "backups", createdAt: now, bytesIn: 20 });

    const both = audit.trafficSeriesForBuckets([aliceBucket.id, secondBucket.id], new Date(Date.now() - 60_000), "minute");
    expect(both.reduce((sum, p) => sum + p.bytesIn, 0)).toBe(30);

    const onlyFirst = audit.trafficSeriesForBuckets([aliceBucket.id], new Date(Date.now() - 60_000), "minute");
    expect(onlyFirst.reduce((sum, p) => sum + p.bytesIn, 0)).toBe(10);
  });

  test("returns an all-zero series for an empty bucket list, without an SQL error", () => {
    const { audit } = setup();
    const points = audit.trafficSeriesForBuckets([], new Date(Date.now() - 5 * 60_000), "minute");
    expect(points.length).toBeGreaterThan(0);
    expect(points.every((p) => p.requests === 0 && p.bytesIn === 0)).toBe(true);
  });
});
