import { afterEach, describe, expect, test } from "bun:test";
import type { AppContext } from "../../apps/server/src/context.ts";
import { handleApi } from "../../apps/server/src/routes/api.ts";
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

async function setup() {
  const harness = makeHarness({ appOrigin: ORIGIN });
  const { ctx, seedUser, seedCredential } = harness;
  ctxToClose = ctx;
  const user = seedUser("owner@x.com");
  const cred = seedCredential(user.id);
  const auth = { accessKeyId: cred.accessKeyId, secretAccessKey: cred.secretAccessKey };

  await harness.signAndSend({ method: "PUT", path: "/src", ...auth });
  await harness.signAndSend({ method: "PUT", path: "/dst", ...auth });
  await harness.signAndSend({ method: "PUT", path: "/src/doc.txt", body: "payload", ...auth });

  const session = ctx.sessionService.establish({ userId: user.id, userAgent: "test", ip: null });
  const srcId = ctx.repos.buckets.listByName("src")[0]!.id;
  const dstId = ctx.repos.buckets.listByName("dst")[0]!.id;
  const objectId = ctx.repos.objects.findByKey(srcId, "doc.txt")!.id;

  const api = (path: string, init: RequestInit = {}) =>
    handleApi(ctx, new Request(`${ORIGIN}${path}`, {
      ...init,
      headers: {
        cookie: `drives3_sid=${session.rawId}`,
        origin: ORIGIN,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.method && init.method !== "GET" ? { "x-csrf-token": session.csrfSecret } : {}),
      },
    }), `req_${crypto.randomUUID()}`);

  return { harness, ctx, user, auth, srcId, dstId, objectId, api };
}

describe("control-plane object copy", () => {
  test("copies into another bucket and leaves the source alone", async () => {
    const { harness, api, srcId, dstId, objectId, auth } = await setup();
    const res = await api(`/api/buckets/${srcId}/objects/${objectId}/copy`, {
      method: "POST",
      body: JSON.stringify({ targetBucketId: dstId, targetKey: "copied.txt" }),
    });
    expect(res.status).toBe(201);
    expect(unwrap<{ key: string; size: number }>(await res.json())).toMatchObject({
      key: "copied.txt",
      size: "payload".length,
    });

    expect(await (await harness.signAndSend({ method: "GET", path: "/dst/copied.txt", ...auth })).text())
      .toBe("payload");
    expect(await (await harness.signAndSend({ method: "GET", path: "/src/doc.txt", ...auth })).text())
      .toBe("payload");
  });

  test("the copy is a distinct Drive file, not a shared reference", async () => {
    const { ctx, api, srcId, dstId, objectId } = await setup();
    await api(`/api/buckets/${srcId}/objects/${objectId}/copy`, {
      method: "POST",
      body: JSON.stringify({ targetBucketId: dstId, targetKey: "copied.txt" }),
    });

    const source = ctx.repos.objects.findByKey(srcId, "doc.txt")!;
    const copy = ctx.repos.objects.findByKey(dstId, "copied.txt")!;
    expect(copy.drive_file_id).not.toBe(source.drive_file_id);
  });

  test("the target bucket's encryption applies, not the source's", async () => {
    const { harness, ctx, api, srcId, dstId, objectId, user } = await setup();
    const cmk = ctx.kms.create({ userId: user.id, alias: "target-key" });
    ctx.repos.buckets.setDefaultEncryption(dstId, "aws:kms", cmk.id);

    const res = await api(`/api/buckets/${srcId}/objects/${objectId}/copy`, {
      method: "POST",
      body: JSON.stringify({ targetBucketId: dstId, targetKey: "enc.txt" }),
    });
    expect(res.status).toBe(201);

    const copy = ctx.repos.objects.findByKey(dstId, "enc.txt")!;
    // Stored encrypted despite the plaintext source.
    expect(Buffer.from(harness.storage.contentOf(copy.drive_file_id)).toString("utf8"))
      .not.toBe("payload");
    expect(ctx.repos.objectEncryption.find(copy.id)?.sse_algorithm).toBe("aws:kms");
  });

  test("rejects a missing or malformed target", async () => {
    const { api, srcId, objectId } = await setup();
    for (const body of [
      {},
      { targetBucketId: "b_missing", targetKey: "x.txt" },
      { targetKey: "x.txt" },
      { targetBucketId: "b", targetKey: "   " },
    ]) {
      const res = await api(`/api/buckets/${srcId}/objects/${objectId}/copy`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
  });

  test("a stranger cannot copy out of a bucket they cannot read", async () => {
    const { ctx, srcId, dstId, objectId } = await setup();
    const stranger = ctx.repos.users.upsertOnLogin({
      googleSub: "sub-stranger",
      email: "stranger@x.com",
      displayName: null,
      hostedDomain: "x.com",
    });
    const session = ctx.sessionService.establish({
      userId: stranger.id, userAgent: "test", ip: null,
    });

    const res = await handleApi(
      ctx,
      new Request(`${ORIGIN}/api/buckets/${srcId}/objects/${objectId}/copy`, {
        method: "POST",
        headers: {
          cookie: `drives3_sid=${session.rawId}`,
          origin: ORIGIN,
          "content-type": "application/json",
          "x-csrf-token": session.csrfSecret,
        },
        body: JSON.stringify({ targetBucketId: dstId, targetKey: "stolen.txt" }),
      }),
      "req_stranger",
    );
    expect(res.status).toBe(404);
  });
});
