import { afterEach, describe, expect, test } from "bun:test";
import type { AppContext } from "../../apps/server/src/context.ts";
import { FaultInjectingDriveStorage } from "../../apps/server/src/drive/fault-injection.ts";
import { InMemoryDriveStorage } from "../../apps/server/src/drive/in-memory-storage.ts";
import { CleanupWorker } from "../../apps/server/src/jobs/orphan-cleanup.ts";
import { makeHarness } from "./_helpers.ts";

const contexts: AppContext[] = [];
afterEach(() => {
  while (contexts.length) contexts.pop()!.db.close();
});

function auth(h: ReturnType<typeof makeHarness>, email: string) {
  const user = h.seedUser(email);
  const credential = h.seedCredential(user.id);
  return { user, credential };
}

describe("Drive fault injection through the S3 surface", () => {
  test("quota failure maps to ServiceUnavailable and staging stays failed", async () => {
    const inner = new InMemoryDriveStorage();
    const storage = new FaultInjectingDriveStorage(inner, {
      uploadObject: { kind: "quota_403" },
      beginResumableUpload: { kind: "quota_403" },
    });
    const h = makeHarness({}, storage);
    contexts.push(h.ctx);
    const { credential } = auth(h, "quota@x.com");
    await h.signAndSend({ method: "PUT", path: "/quota", ...credential });

    const put = await h.signAndSend({
      method: "PUT",
      path: "/quota/file.txt",
      body: "quota",
      ...credential,
    });
    expect(put.status).toBe(503);
    expect(await put.text()).toContain("ServiceUnavailable");
    const failed = h.ctx.db
      .query<{ status: string }, []>(
        "SELECT status FROM object_staging ORDER BY created_at DESC LIMIT 1",
      )
      .get();
    expect(failed?.status).toBe("failed");
  });

  test("token-revoked failure maps to AccessDenied", async () => {
    const storage = new FaultInjectingDriveStorage(new InMemoryDriveStorage(), {
      uploadObject: { kind: "token_revoked" },
      beginResumableUpload: { kind: "token_revoked" },
    });
    const h = makeHarness({}, storage);
    contexts.push(h.ctx);
    const { credential } = auth(h, "token@x.com");
    await h.signAndSend({ method: "PUT", path: "/token", ...credential });
    const put = await h.signAndSend({
      method: "PUT",
      path: "/token/file.txt",
      body: "secret",
      ...credential,
    });
    expect(put.status).toBe(403);
    expect(await put.text()).toContain("AccessDenied");
  });

  test("delete failure leaves durable cleanup and succeeds after storage heals", async () => {
    const inner = new InMemoryDriveStorage();
    const storage = new FaultInjectingDriveStorage(inner, {
      deleteFile: { kind: "server_500", count: 1 },
    });
    const h = makeHarness({}, storage);
    contexts.push(h.ctx);
    const { credential } = auth(h, "delete@x.com");
    await h.signAndSend({ method: "PUT", path: "/delete-fault", ...credential });
    await h.signAndSend({
      method: "PUT",
      path: "/delete-fault/file.txt",
      body: "delete me",
      ...credential,
    });

    const deleted = await h.signAndSend({
      method: "DELETE",
      path: "/delete-fault/file.txt",
      ...credential,
    });
    expect(deleted.status).toBe(204);
    expect(h.ctx.repos.pendingCleanup.backlog()).toBe(1);

    // Fault count was one, so the cleanup retry sees a healthy inner adapter.
    const result = await new CleanupWorker(h.ctx).runOnce();
    expect(result.completed).toBe(1);
    expect(h.ctx.repos.pendingCleanup.backlog()).toBe(0);
  });

  test("transient head fault marks Drive media missing during reconciliation", async () => {
    const inner = new InMemoryDriveStorage();
    const storage = new FaultInjectingDriveStorage(inner, {
      headObject: { kind: "not_found" },
    });
    const h = makeHarness({}, storage);
    contexts.push(h.ctx);
    const { user, credential } = auth(h, "reconcile@x.com");
    await h.signAndSend({ method: "PUT", path: "/reconcile-fault", ...credential });
    await h.signAndSend({
      method: "PUT",
      path: "/reconcile-fault/file.txt",
      body: "present",
      ...credential,
    });

    const result = await h.ctx.reconcileService.runUserBatch(user.id, "fault-reconcile");
    expect(result.missing).toBe(1);
    const bucket = h.ctx.repos.buckets.findByName(user.id, "reconcile-fault")!;
    const row = h.ctx.db
      .query<{ status: string }, [string, string]>(
        "SELECT status FROM objects WHERE bucket_id = ? AND object_key = ?",
      )
      .get(bucket.id, "file.txt");
    expect(row?.status).toBe("missing");
  });
});
