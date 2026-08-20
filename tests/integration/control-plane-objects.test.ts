import { afterEach, describe, expect, test } from "bun:test";
import type { AppContext } from "../../apps/server/src/context.ts";
import { handleApi } from "../../apps/server/src/routes/api.ts";
import { handlePublicShare } from "../../apps/server/src/routes/public-share.ts";
import { makeHarness } from "./_helpers.ts";

function unwrap<T>(body: unknown): T {
  return (body as { data: T }).data;
}

let ctxToClose: AppContext | null = null;
afterEach(() => { ctxToClose?.db.close(); ctxToClose = null; });

describe("control-plane objects and links", () => {
  test("uploads, previews, downloads, shares, and deletes an object", async () => {
    const { ctx, seedUser, seedCredential, signAndSend } = makeHarness();
    ctxToClose = ctx;
    const user = seedUser("objects@x.com");
    const s3 = seedCredential(user.id);
    await signAndSend({
      method: "PUT", path: "/dashboard-objects",
      accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey,
    });
    const bucket = ctx.repos.buckets.findByName(user.id, "dashboard-objects")!;
    const session = ctx.sessionService.establish({ userId: user.id, userAgent: "test", ip: null });
    const cookie = `drives3_sid=${session.rawId}`;
    const mutationHeaders = {
      cookie, origin: "http://localhost", "x-csrf-token": session.csrfSecret,
    };

    const uploadedResponse = await handleApi(ctx, new Request(
      `http://localhost/api/buckets/${bucket.id}/objects?key=notes%2Fhello.txt`,
      { method: "POST", headers: { ...mutationHeaders, "content-type": "text/plain" }, body: "hello dashboard" },
    ), "req-object-upload");
    expect(uploadedResponse.status).toBe(201);
    const object = unwrap<{ id: string; key: string }>(await uploadedResponse.json());
    expect(object.key).toBe("notes/hello.txt");

    const preview = await handleApi(ctx, new Request(
      `http://localhost/api/buckets/${bucket.id}/objects/${object.id}/preview`, { headers: { cookie } },
    ), "req-object-preview");
    expect(preview.status).toBe(200);
    expect(preview.headers.get("content-disposition")).toStartWith("inline;");
    expect(await preview.text()).toBe("hello dashboard");

    const download = await handleApi(ctx, new Request(
      `http://localhost/api/buckets/${bucket.id}/objects/${object.id}/download`, { headers: { cookie, range: "bytes=0-4" } },
    ), "req-object-download");
    expect(download.status).toBe(206);
    expect(await download.text()).toBe("hello");

    const temporaryResponse = await handleApi(ctx, new Request(
      `http://localhost/api/buckets/${bucket.id}/objects/${object.id}/presigned-links`,
      { method: "POST", headers: { ...mutationHeaders, "content-type": "application/json" }, body: JSON.stringify({ credentialId: ctx.repos.credentials.listForUser(user.id)[0]!.id, expiresSeconds: 3600 }) },
    ), "req-presign-create");
    expect(temporaryResponse.status).toBe(201);
    const temporary = unwrap<{ url: string }>(await temporaryResponse.json());
    const temporaryUrl = new URL(temporary.url);
    const temporaryGet = await import("../../apps/server/src/s3/router.ts").then(({ handleS3 }) =>
      handleS3(
        ctx,
        new Request(temporaryUrl, { headers: { host: temporaryUrl.host } }),
        "req-presign-get",
      ),
    );
    expect(temporaryGet.status).toBe(200);
    expect(await temporaryGet.text()).toBe("hello dashboard");

    const linkResponse = await handleApi(ctx, new Request(
      `http://localhost/api/buckets/${bucket.id}/objects/${object.id}/public-links`,
      { method: "POST", headers: { ...mutationHeaders, "content-type": "application/json" }, body: JSON.stringify({ label: "public", expiresAt: null }) },
    ), "req-link-create");
    expect(linkResponse.status).toBe(201);
    expect(linkResponse.headers.get("cache-control")).toBe("no-store");
    const link = unwrap<{ id: string; url: string }>(await linkResponse.json());
    const publicResponse = await handlePublicShare(ctx, new Request(link.url), "req-public", null);
    expect(publicResponse.status).toBe(200);
    expect(await publicResponse.text()).toBe("hello dashboard");

    const revoke = await handleApi(ctx, new Request(
      `http://localhost/api/buckets/${bucket.id}/objects/${object.id}/public-links/${link.id}`,
      { method: "DELETE", headers: mutationHeaders },
    ), "req-link-revoke");
    expect(revoke.status).toBe(200);
    expect((await handlePublicShare(ctx, new Request(link.url), "req-public-revoked", null)).status).toBe(404);

    const removed = await handleApi(ctx, new Request(
      `http://localhost/api/buckets/${bucket.id}/objects/${object.id}`,
      { method: "DELETE", headers: mutationHeaders },
    ), "req-object-delete");
    expect(removed.status).toBe(200);
    expect(ctx.repos.objects.findByKey(bucket.id, "notes/hello.txt")).toBeNull();
  });
});
