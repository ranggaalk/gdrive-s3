import { afterEach, describe, expect, test } from "bun:test";
import type { AppContext } from "../../apps/server/src/context.ts";
import { handleApi } from "../../apps/server/src/routes/api.ts";
import { makeHarness } from "./_helpers.ts";

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
  await harness.signAndSend({ method: "PUT", path: "/docs", ...auth });
  const bucketId = ctx.repos.buckets.listByName("docs")[0]!.id;
  const session = ctx.sessionService.establish({ userId: user.id, userAgent: "test", ip: null });

  const upload = (key: string, body: string) =>
    handleApi(
      ctx,
      new Request(`${ORIGIN}/api/buckets/${bucketId}/objects?key=${encodeURIComponent(key)}`, {
        method: "POST",
        headers: {
          cookie: `drives3_sid=${session.rawId}`,
          origin: ORIGIN,
          "content-type": "text/plain",
          "x-csrf-token": session.csrfSecret,
        },
        body,
      }),
      `req_${crypto.randomUUID()}`,
    );

  return { harness, ctx, user, auth, bucketId, upload };
}

/**
 * The dashboard upload must honour the same bucket settings an S3 PUT does.
 * It previously derived none of them, which on a versioned bucket destroyed
 * the previous version's bytes on every overwrite.
 */
describe("dashboard upload honours bucket settings", () => {
  test("uploads to a plain bucket", async () => {
    const { upload } = await setup();
    const res = await upload("hello.txt", "hello world");
    expect(res.status).toBe(201);
  });

  test("a versioned bucket retains the previous version instead of destroying it", async () => {
    const { harness, ctx, bucketId, upload, auth } = await setup();
    ctx.repos.buckets.setVersioning(bucketId, "Enabled");

    const first = await upload("a.txt", "v1");
    expect(first.status).toBe(201);
    const v1 = ctx.repos.objects.findByKey(bucketId, "a.txt")!;
    expect(v1.version_id).not.toBe("null");

    expect((await upload("a.txt", "v2")).status).toBe(201);

    // The old version is retained, and its bytes still exist in Drive.
    const versions = ctx.repos.objectVersions.listForKey(bucketId, "a.txt");
    expect(versions).toHaveLength(1);
    expect(harness.storage.contentOf(v1.drive_file_id)).toBeTruthy();

    // And it is readable through the S3 API by its version id.
    const old = await harness.signAndSend({
      method: "GET", path: "/docs/a.txt", query: { versionId: v1.version_id }, ...auth,
    });
    expect(await old.text()).toBe("v1");
  });

  test("a bucket default encryption applies to a dashboard upload", async () => {
    const { harness, ctx, user, bucketId, upload } = await setup();
    const cmk = ctx.kms.create({ userId: user.id, alias: "dash" });
    ctx.repos.buckets.setDefaultEncryption(bucketId, "aws:kms", cmk.id);

    expect((await upload("secret.txt", "sensitive")).status).toBe(201);

    const object = ctx.repos.objects.findByKey(bucketId, "secret.txt")!;
    expect(ctx.repos.objectEncryption.find(object.id)?.sse_algorithm).toBe("aws:kms");
    // The bytes really are encrypted at rest, not merely flagged.
    expect(Buffer.from(harness.storage.contentOf(object.drive_file_id)).toString("utf8"))
      .not.toBe("sensitive");
  });

  test("a bucket default retention applies to a dashboard upload", async () => {
    const { harness, ctx, bucketId, upload, auth } = await setup();
    ctx.repos.buckets.enableObjectLock(bucketId);
    ctx.repos.buckets.setObjectLockDefault(
      bucketId,
      JSON.stringify({ mode: "COMPLIANCE", days: 30 }),
    );

    expect((await upload("locked.txt", "protected")).status).toBe(201);
    const object = ctx.repos.objects.findByKey(bucketId, "locked.txt")!;
    expect(object.lock_mode).toBe("COMPLIANCE");

    // The lock is real: deleting that version is refused.
    const res = await harness.signAndSend({
      method: "DELETE",
      path: "/docs/locked.txt",
      query: { versionId: object.version_id },
      ...auth,
    });
    expect(res.status).toBe(403);
  });

  test("an encrypted dashboard upload reads back correctly over S3", async () => {
    const { harness, ctx, user, bucketId, upload, auth } = await setup();
    const cmk = ctx.kms.create({ userId: user.id, alias: "roundtrip" });
    ctx.repos.buckets.setDefaultEncryption(bucketId, "aws:kms", cmk.id);
    await upload("rt.txt", "round trip");

    const res = await harness.signAndSend({ method: "GET", path: "/docs/rt.txt", ...auth });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("round trip");
  });
});
