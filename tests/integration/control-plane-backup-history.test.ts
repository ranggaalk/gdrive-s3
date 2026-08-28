// GET /api/backups — history across every bucket, per-destination rollups, and
// the per-object ledger behind one run.
//
// The per-bucket endpoint (/api/buckets/:id/backups) only ever answered "what
// happened to this bucket". These assertions cover the parts that answer for
// the whole gateway: cross-bucket ordering, the filters, cursor paging over
// runs that share a timestamp, and the ownership boundary.

import { afterEach, describe, expect, test } from "bun:test";
import type { AppContext } from "../../apps/server/src/context.ts";
import { handleApi } from "../../apps/server/src/routes/api.ts";
import { newBackupAccountId, newObjectId, nowIso } from "../../apps/server/src/util/ids.ts";
import { makeHarness } from "./_helpers.ts";

function unwrap<T>(body: unknown): T {
  return (body as { data: T }).data;
}

let ctxToClose: AppContext | null = null;
afterEach(() => {
  ctxToClose?.db.close();
  ctxToClose = null;
});

const ORIGIN = "http://localhost:5173";

interface HistoryItem {
  id: string;
  bucketId: string;
  bucketName: string;
  backupAccountId: string;
  accountEmail: string;
  status: string;
  total: number;
  skipped: number;
  copied: number;
  failed: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

interface HistoryPage {
  items: HistoryItem[];
  nextBefore: string | null;
}

interface LedgerItem {
  objectId: string;
  objectKey: string;
  status: "copied" | "failed";
  destinationFileId: string | null;
  attempts: number;
  lastError: string | null;
}

interface Summary {
  totals: {
    accounts: number;
    runs: number;
    activeRuns: number;
    copied: number;
    skipped: number;
    failed: number;
    objectsOnRecord: number;
  };
  accounts: Array<{
    backupAccountId: string;
    email: string;
    runs: number;
    activeRuns: number;
    lastRunAt: string | null;
    lastStatus: string | null;
    copiedTotal: number;
    failedTotal: number;
    objectsOnRecord: number;
  }>;
}

function setup() {
  const harness = makeHarness({ appOrigin: ORIGIN });
  const { ctx } = harness;
  ctxToClose = ctx;

  const sessionFor = (userId: string) =>
    ctx.sessionService.establish({ userId, userAgent: "test", ip: null });

  const apiAs = (session: { rawId: string; csrfSecret: string }) => (path: string) =>
    handleApi(
      ctx,
      new Request(`${ORIGIN}${path}`, {
        headers: { cookie: `drives3_sid=${session.rawId}`, origin: ORIGIN },
      }),
      `req_${crypto.randomUUID()}`,
    );

  const user = harness.seedUser("owner@x.com");
  const api = apiAs(sessionFor(user.id));

  const linkAccount = (email: string) =>
    ctx.repos.backupAccounts.create({
      id: newBackupAccountId(),
      ownerUserId: user.id,
      email,
      encryptedRefreshToken: "irrelevant-for-this-test",
      grantedScopes: "https://www.googleapis.com/auth/drive",
    });

  const insertObject = (bucketId: string, key: string, etag: string) => {
    const now = nowIso();
    const objectId = newObjectId();
    ctx.db
      .query(
        `INSERT INTO objects (id, bucket_id, object_key, drive_file_id, size_bytes,
                              content_type, etag, last_modified_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(objectId, bucketId, key, `file_${key}`, 10, "application/octet-stream", etag, now, now, now);
    return objectId;
  };

  /** Pin a run's created_at so ordering assertions don't depend on how fast
   *  the test machine gets through a loop. */
  const backdate = (transferId: string, createdAt: string) => {
    ctx.db.query("UPDATE backup_transfers SET created_at = ? WHERE id = ?").run(createdAt, transferId);
  };

  return { harness, ctx, user, api, apiAs, sessionFor, linkAccount, insertObject, backdate };
}

describe("GET /api/backups", () => {
  test("lists runs from every bucket, newest first, with the names resolved", async () => {
    const { ctx, user, api, linkAccount, insertObject, backdate } = setup();
    const docs = ctx.repos.buckets.create(user.id, "docs", "us-east-1", "folder-docs");
    const media = ctx.repos.buckets.create(user.id, "media", "us-east-1", "folder-media");
    const account = linkAccount("backup@personal.com");
    insertObject(docs.id, "a.txt", "etag-a");
    insertObject(media.id, "b.txt", "etag-b");

    const older = ctx.repos.backupTransfers.create({
      userId: user.id, bucketId: docs.id, backupAccountId: account.id,
    });
    ctx.repos.backupTransfers.refreshAndMaybeFinish(older.id);
    backdate(older.id, "2026-08-01T00:00:00.000Z");
    const newer = ctx.repos.backupTransfers.create({
      userId: user.id, bucketId: media.id, backupAccountId: account.id,
    });
    backdate(newer.id, "2026-08-02T00:00:00.000Z");

    const page = unwrap<HistoryPage>(await (await api("/api/backups")).json());
    expect(page.items.map((i) => i.bucketName)).toEqual(["media", "docs"]);
    expect(page.items.every((i) => i.accountEmail === "backup@personal.com")).toBe(true);
    expect(page.items[0]!.total).toBe(1);
    expect(page.nextBefore).toBeNull();
  });

  test("filters by destination account, by bucket, and by status", async () => {
    const { ctx, user, api, linkAccount, insertObject } = setup();
    const docs = ctx.repos.buckets.create(user.id, "docs", "us-east-1", "folder-docs");
    const media = ctx.repos.buckets.create(user.id, "media", "us-east-1", "folder-media");
    const primary = linkAccount("primary@personal.com");
    const secondary = linkAccount("secondary@personal.com");
    insertObject(docs.id, "a.txt", "etag-a");
    insertObject(media.id, "b.txt", "etag-b");

    const docsRun = ctx.repos.backupTransfers.create({
      userId: user.id, bucketId: docs.id, backupAccountId: primary.id,
    });
    ctx.repos.backupTransfers.failJob(docsRun.id, "drive said no");
    ctx.repos.backupTransfers.create({
      userId: user.id, bucketId: media.id, backupAccountId: secondary.id,
    });

    const byAccount = unwrap<HistoryPage>(
      await (await api(`/api/backups?accountId=${primary.id}`)).json(),
    );
    expect(byAccount.items.map((i) => i.bucketName)).toEqual(["docs"]);

    const byBucket = unwrap<HistoryPage>(
      await (await api(`/api/backups?bucketId=${media.id}`)).json(),
    );
    expect(byBucket.items.map((i) => i.accountEmail)).toEqual(["secondary@personal.com"]);

    const byStatus = unwrap<HistoryPage>(await (await api("/api/backups?status=failed")).json());
    expect(byStatus.items.map((i) => i.id)).toEqual([docsRun.id]);
  });

  test("an unknown status is rejected rather than silently matching nothing", async () => {
    const { api } = setup();
    const res = await api("/api/backups?status=partially-ok");
    expect(res.status).toBe(400);
  });

  test("pages with a cursor that survives runs sharing a timestamp", async () => {
    const { ctx, user, api, linkAccount, insertObject, backdate } = setup();
    const account = linkAccount("backup@personal.com");
    // Four buckets so four runs can be open against the same destination at
    // once; all four are stamped with the same created_at.
    const ids: string[] = [];
    for (const name of ["one", "two", "three", "four"]) {
      const bucket = ctx.repos.buckets.create(user.id, name, "us-east-1", `folder-${name}`);
      insertObject(bucket.id, `${name}.txt`, `etag-${name}`);
      const run = ctx.repos.backupTransfers.create({
        userId: user.id, bucketId: bucket.id, backupAccountId: account.id,
      });
      backdate(run.id, "2026-08-05T12:00:00.000Z");
      ids.push(run.id);
    }

    const first = unwrap<HistoryPage>(await (await api("/api/backups?limit=2")).json());
    expect(first.items).toHaveLength(2);
    expect(first.nextBefore).not.toBeNull();

    const second = unwrap<HistoryPage>(
      await (await api(`/api/backups?limit=2&before=${encodeURIComponent(first.nextBefore!)}`)).json(),
    );
    const seen = [...first.items, ...second.items].map((i) => i.id);
    // No run repeated across the page boundary, and none skipped.
    expect(new Set(seen).size).toBe(4);
    expect(seen.slice().sort()).toEqual(ids.slice().sort());
  });

  test("another user's runs are invisible even with a valid session", async () => {
    const { ctx, harness, user, apiAs, sessionFor, linkAccount, insertObject } = setup();
    const bucket = ctx.repos.buckets.create(user.id, "docs", "us-east-1", "folder-docs");
    const account = linkAccount("backup@personal.com");
    insertObject(bucket.id, "a.txt", "etag-a");
    const run = ctx.repos.backupTransfers.create({
      userId: user.id, bucketId: bucket.id, backupAccountId: account.id,
    });

    const stranger = harness.seedUser("stranger@x.com");
    const strangerApi = apiAs(sessionFor(stranger.id));

    const page = unwrap<HistoryPage>(await (await strangerApi("/api/backups")).json());
    expect(page.items).toEqual([]);
    expect((await strangerApi(`/api/backups/${run.id}`)).status).toBe(404);
    expect((await strangerApi(`/api/backups/${run.id}/objects`)).status).toBe(404);
  });
});

describe("GET /api/backups/:id", () => {
  test("returns one run with the ledger lines it currently owns", async () => {
    const { ctx, user, api, linkAccount, insertObject } = setup();
    const bucket = ctx.repos.buckets.create(user.id, "docs", "us-east-1", "folder-docs");
    const account = linkAccount("backup@personal.com");
    const copiedId = insertObject(bucket.id, "copied.txt", "etag-a");
    const failedId = insertObject(bucket.id, "failed.txt", "etag-b");
    const run = ctx.repos.backupTransfers.create({
      userId: user.id, bucketId: bucket.id, backupAccountId: account.id,
    });
    ctx.repos.backupTransfers.claimNextJob();
    ctx.repos.backupTransfers.markObjectCopied({
      transferId: run.id, backupAccountId: account.id, objectId: copiedId,
      objectKey: "copied.txt", objectEtag: "etag-a", destinationFileId: "drive_dest_1",
    });
    ctx.repos.backupTransfers.markObjectFailed({
      transferId: run.id, backupAccountId: account.id, objectId: failedId,
      objectKey: "failed.txt", objectEtag: "etag-b", error: "quota exceeded",
    });
    ctx.repos.backupTransfers.refreshAndMaybeFinish(run.id);

    const detail = unwrap<HistoryItem & { ledger: { copied: number; failed: number } }>(
      await (await api(`/api/backups/${run.id}`)).json(),
    );
    expect(detail.bucketName).toBe("docs");
    expect(detail.accountEmail).toBe("backup@personal.com");
    expect(detail.status).toBe("completed");
    expect(detail.copied).toBe(1);
    expect(detail.failed).toBe(1);
    expect(detail.ledger).toEqual({ copied: 1, failed: 1 });
    expect(detail.startedAt).not.toBeNull();
  });

  test("a run id that does not exist is a 404, not an empty run", async () => {
    const { api } = setup();
    expect((await api("/api/backups/bkx_missing")).status).toBe(404);
  });
});

describe("GET /api/backups/:id/objects", () => {
  test("lists what the run did to each object, filterable by outcome", async () => {
    const { ctx, user, api, linkAccount, insertObject } = setup();
    const bucket = ctx.repos.buckets.create(user.id, "docs", "us-east-1", "folder-docs");
    const account = linkAccount("backup@personal.com");
    const copiedId = insertObject(bucket.id, "copied.txt", "etag-a");
    const failedId = insertObject(bucket.id, "failed.txt", "etag-b");
    const run = ctx.repos.backupTransfers.create({
      userId: user.id, bucketId: bucket.id, backupAccountId: account.id,
    });
    ctx.repos.backupTransfers.markObjectCopied({
      transferId: run.id, backupAccountId: account.id, objectId: copiedId,
      objectKey: "copied.txt", objectEtag: "etag-a", destinationFileId: "drive_dest_1",
    });
    ctx.repos.backupTransfers.markObjectFailed({
      transferId: run.id, backupAccountId: account.id, objectId: failedId,
      objectKey: "failed.txt", objectEtag: "etag-b", error: "quota exceeded",
    });

    const all = unwrap<{ items: LedgerItem[] }>(
      await (await api(`/api/backups/${run.id}/objects`)).json(),
    );
    expect(all.items.map((i) => i.objectKey).sort()).toEqual(["copied.txt", "failed.txt"]);

    const failures = unwrap<{ items: LedgerItem[] }>(
      await (await api(`/api/backups/${run.id}/objects?status=failed`)).json(),
    );
    expect(failures.items).toHaveLength(1);
    expect(failures.items[0]!.objectKey).toBe("failed.txt");
    expect(failures.items[0]!.lastError).toBe("quota exceeded");
    expect(failures.items[0]!.destinationFileId).toBeNull();

    const copies = unwrap<{ items: LedgerItem[] }>(
      await (await api(`/api/backups/${run.id}/objects?status=copied`)).json(),
    );
    expect(copies.items[0]!.destinationFileId).toBe("drive_dest_1");
  });

  test("a re-copy moves the ledger line to the newer run", async () => {
    // The ledger keeps one row per (destination, object), stamped with the run
    // that last touched it. The older run's own counters stay put; its
    // attributable lines shrink. Both numbers are reported, so the UI can say
    // so rather than appear to have lost rows.
    const { ctx, user, api, linkAccount, insertObject } = setup();
    const bucket = ctx.repos.buckets.create(user.id, "docs", "us-east-1", "folder-docs");
    const account = linkAccount("backup@personal.com");
    const objectId = insertObject(bucket.id, "a.txt", "etag-a");

    const first = ctx.repos.backupTransfers.create({
      userId: user.id, bucketId: bucket.id, backupAccountId: account.id,
    });
    ctx.repos.backupTransfers.markObjectCopied({
      transferId: first.id, backupAccountId: account.id, objectId,
      objectKey: "a.txt", objectEtag: "etag-a", destinationFileId: "drive_dest_1",
    });
    ctx.repos.backupTransfers.refreshAndMaybeFinish(first.id);

    ctx.db.query("UPDATE objects SET etag = ? WHERE id = ?").run("etag-a-v2", objectId);
    const second = ctx.repos.backupTransfers.create({
      userId: user.id, bucketId: bucket.id, backupAccountId: account.id,
    });
    ctx.repos.backupTransfers.markObjectCopied({
      transferId: second.id, backupAccountId: account.id, objectId,
      objectKey: "a.txt", objectEtag: "etag-a-v2", destinationFileId: "drive_dest_2",
    });
    ctx.repos.backupTransfers.refreshAndMaybeFinish(second.id);

    const older = unwrap<HistoryItem & { ledger: { copied: number } }>(
      await (await api(`/api/backups/${first.id}`)).json(),
    );
    expect(older.copied).toBe(1);
    expect(older.ledger.copied).toBe(0);

    const newer = unwrap<{ items: LedgerItem[] }>(
      await (await api(`/api/backups/${second.id}/objects`)).json(),
    );
    expect(newer.items).toHaveLength(1);
    expect(newer.items[0]!.destinationFileId).toBe("drive_dest_2");
    expect(newer.items[0]!.attempts).toBe(2);
  });
});

describe("GET /api/backups/summary", () => {
  test("rolls up runs per destination account and across the gateway", async () => {
    const { ctx, user, api, linkAccount, insertObject } = setup();
    const docs = ctx.repos.buckets.create(user.id, "docs", "us-east-1", "folder-docs");
    const primary = linkAccount("primary@personal.com");
    const idle = linkAccount("idle@personal.com");
    const objectId = insertObject(docs.id, "a.txt", "etag-a");

    const run = ctx.repos.backupTransfers.create({
      userId: user.id, bucketId: docs.id, backupAccountId: primary.id,
    });
    ctx.repos.backupTransfers.markObjectCopied({
      transferId: run.id, backupAccountId: primary.id, objectId,
      objectKey: "a.txt", objectEtag: "etag-a", destinationFileId: "drive_dest_1",
    });
    ctx.repos.backupTransfers.refreshAndMaybeFinish(run.id);

    const summary = unwrap<Summary>(await (await api("/api/backups/summary")).json());
    expect(summary.totals.accounts).toBe(2);
    expect(summary.totals.runs).toBe(1);
    expect(summary.totals.copied).toBe(1);
    expect(summary.totals.objectsOnRecord).toBe(1);

    const forPrimary = summary.accounts.find((a) => a.backupAccountId === primary.id)!;
    expect(forPrimary.email).toBe("primary@personal.com");
    expect(forPrimary.runs).toBe(1);
    expect(forPrimary.lastStatus).toBe("completed");
    expect(forPrimary.objectsOnRecord).toBe(1);

    // A linked account that has never run still appears, with zeroes rather
    // than being dropped by the join.
    const forIdle = summary.accounts.find((a) => a.backupAccountId === idle.id)!;
    expect(forIdle.runs).toBe(0);
    expect(forIdle.lastRunAt).toBeNull();
    expect(forIdle.lastStatus).toBeNull();
    expect(forIdle.copiedTotal).toBe(0);
  });

  test("counts a still-running backup as active", async () => {
    const { ctx, user, api, linkAccount, insertObject } = setup();
    const docs = ctx.repos.buckets.create(user.id, "docs", "us-east-1", "folder-docs");
    const account = linkAccount("backup@personal.com");
    insertObject(docs.id, "a.txt", "etag-a");
    ctx.repos.backupTransfers.create({
      userId: user.id, bucketId: docs.id, backupAccountId: account.id,
    });
    ctx.repos.backupTransfers.claimNextJob();

    const summary = unwrap<Summary>(await (await api("/api/backups/summary")).json());
    expect(summary.totals.activeRuns).toBe(1);
    expect(summary.accounts[0]!.activeRuns).toBe(1);
  });
});
