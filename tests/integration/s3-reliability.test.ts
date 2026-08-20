import { afterEach, describe, expect, test } from "bun:test";
import { makeHarness } from "./_helpers.ts";
import { InMemoryDriveStorage } from "../../apps/server/src/drive/in-memory-storage.ts";
import type { DriveStorage } from "../../apps/server/src/drive/storage.ts";

const activeHarnesses: Array<{ ctx: { db: { close(): void } } }> = [];

afterEach(() => {
  while (activeHarnesses.length) activeHarnesses.pop()!.ctx.db.close();
});

function seed(h: ReturnType<typeof makeHarness>) {
  const user = h.seedUser("rel@x.com");
  const cred = h.seedCredential(user.id);
  return { user, auth: { accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey } };
}

describe("Range + conditional GET", () => {
  test("range returns 206 with exact bytes and Content-Range", async () => {
    const h = makeHarness();
    activeHarnesses.push({ ctx: h.ctx });
    const { auth } = seed(h);
    await h.signAndSend({ method: "PUT", path: "/rel", ...auth });
    await h.signAndSend({
      method: "PUT",
      path: "/rel/a.txt",
      body: "abcdefghij",
      headers: { "content-type": "text/plain" },
      ...auth,
    });
    const res = await h.signAndSend({
      method: "GET",
      path: "/rel/a.txt",
      headers: { Range: "bytes=2-5" },
      ...auth,
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(res.headers.get("content-length")).toBe("4");
    expect(await res.text()).toBe("cdef");
  });

  test("If-None-Match returns 304", async () => {
    const h = makeHarness();
    activeHarnesses.push({ ctx: h.ctx });
    const { auth } = seed(h);
    await h.signAndSend({ method: "PUT", path: "/rel", ...auth });
    const put = await h.signAndSend({
      method: "PUT",
      path: "/rel/cond.txt",
      body: "hello",
      ...auth,
    });
    const etag = put.headers.get("etag")!;
    const res = await h.signAndSend({
      method: "GET",
      path: "/rel/cond.txt",
      headers: { "If-None-Match": etag },
      ...auth,
    });
    expect(res.status).toBe(304);
  });

  test("If-Match miss returns PreconditionFailed", async () => {
    const h = makeHarness();
    activeHarnesses.push({ ctx: h.ctx });
    const { auth } = seed(h);
    await h.signAndSend({ method: "PUT", path: "/rel", ...auth });
    await h.signAndSend({
      method: "PUT",
      path: "/rel/cond2.txt",
      body: "hello",
      ...auth,
    });
    const res = await h.signAndSend({
      method: "GET",
      path: "/rel/cond2.txt",
      headers: { "If-Match": '"nope"' },
      ...auth,
    });
    expect(res.status).toBe(412);
    expect(await res.text()).toContain("PreconditionFailed");
  });

  test("unsatisfiable range returns 416", async () => {
    const h = makeHarness();
    activeHarnesses.push({ ctx: h.ctx });
    const { auth } = seed(h);
    await h.signAndSend({ method: "PUT", path: "/rel", ...auth });
    await h.signAndSend({
      method: "PUT",
      path: "/rel/short.txt",
      body: "abc",
      ...auth,
    });
    const res = await h.signAndSend({
      method: "GET",
      path: "/rel/short.txt",
      headers: { Range: "bytes=10-20" },
      ...auth,
    });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */3");
  });
});

describe("Object overwrite + delete cleanup", () => {
  test("overwrite queues the old Drive file to be cleaned up", async () => {
    const h = makeHarness();
    activeHarnesses.push({ ctx: h.ctx });
    const { auth } = seed(h);
    await h.signAndSend({ method: "PUT", path: "/rel", ...auth });
    await h.signAndSend({ method: "PUT", path: "/rel/versioned", body: "v1", ...auth });
    await h.signAndSend({ method: "PUT", path: "/rel/versioned", body: "v2", ...auth });

    const got = await h.signAndSend({ method: "GET", path: "/rel/versioned", ...auth });
    expect(await got.text()).toBe("v2");
    // Cleanup should have finished inline (in-memory storage always succeeds).
    expect(h.ctx.repos.pendingCleanup.backlog()).toBe(0);
  });

  test("delete leaves no queue backlog when storage succeeds", async () => {
    const h = makeHarness();
    activeHarnesses.push({ ctx: h.ctx });
    const { auth } = seed(h);
    await h.signAndSend({ method: "PUT", path: "/rel", ...auth });
    await h.signAndSend({ method: "PUT", path: "/rel/gone.txt", body: "bye", ...auth });
    const del = await h.signAndSend({ method: "DELETE", path: "/rel/gone.txt", ...auth });
    expect(del.status).toBe(204);
    expect(h.ctx.repos.pendingCleanup.backlog()).toBe(0);
  });

  test("delete storage failure enqueues cleanup for later", async () => {
    class FlakyStorage extends InMemoryDriveStorage implements DriveStorage {
      shouldFail = false;
      override async deleteFile(input: Parameters<InMemoryDriveStorage["deleteFile"]>[0]) {
        if (this.shouldFail) throw new Error("simulated Drive outage");
        return super.deleteFile(input);
      }
    }
    const flaky = new FlakyStorage();
    const h = makeHarness();
    // Swap the storage after construction so the S3 path uses the flaky one.
    (h.ctx as unknown as { driveStorage: DriveStorage }).driveStorage = flaky;
    activeHarnesses.push({ ctx: h.ctx });
    const { auth } = seed(h);
    await h.signAndSend({ method: "PUT", path: "/rel", ...auth });
    await h.signAndSend({ method: "PUT", path: "/rel/keep.txt", body: "leak", ...auth });
    flaky.shouldFail = true;
    const res = await h.signAndSend({ method: "DELETE", path: "/rel/keep.txt", ...auth });
    expect(res.status).toBe(204);
    expect(h.ctx.repos.pendingCleanup.backlog()).toBe(1);
  });
});

describe("Reconciliation", () => {
  test("marks objects missing when the Drive file disappears", async () => {
    const storage = new InMemoryDriveStorage();
    const h = makeHarness({}, storage);
    activeHarnesses.push({ ctx: h.ctx });
    const { user, auth } = seed(h);
    await h.signAndSend({ method: "PUT", path: "/rel", ...auth });
    await h.signAndSend({ method: "PUT", path: "/rel/vanish.txt", body: "poof", ...auth });
    const bucket = h.ctx.repos.buckets.findByName(user.id, "rel")!;
    const obj = h.ctx.repos.objects.findByKey(bucket.id, "vanish.txt")!;
    // Simulate the user permanently deleting the file in Drive UI.
    await storage.deleteFile({ userId: user.id, driveFileId: obj.drive_file_id, mode: "permanent" });
    const result = await h.ctx.reconcileService.runUserBatch(user.id, "req-test");
    expect(result.examined).toBe(1);
    expect(result.missing).toBe(1);
    const after = h.ctx.repos.objects.findByKey(bucket.id, "vanish.txt");
    // findByKey filters to active; missing rows are filtered out.
    expect(after).toBeNull();
  });
});
